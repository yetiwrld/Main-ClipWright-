#!/usr/bin/env node
/**
 * SPEC 15 §8.2 step 2 — fetch and verify the binaries that ship in
 * `resources/bin`.
 *
 * Every download is checked against `scripts/binaries.lock.json` before it is
 * unpacked. A mismatch fails the release: shipping a binary nobody verified is
 * worse than shipping no binary, because the app would spawn it with the user's
 * projects.
 *
 * Usage:
 *   node scripts/release/fetch-binaries.mjs                 # verify + install
 *   node scripts/release/fetch-binaries.mjs --update-hashes  # record digests (review before committing)
 *   node scripts/release/fetch-binaries.mjs --only ffmpeg
 *
 * Offline, or when a URL is unreachable, this exits non-zero with the reason.
 * It never falls back to an unverified file.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const LOCK_PATH = join(ROOT, 'scripts', 'binaries.lock.json');
const BIN_DIR = join(ROOT, 'resources', 'bin');

const args = process.argv.slice(2);
const updateHashes = args.includes('--update-hashes');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
const entries = Object.entries(lock).filter(([key]) => !key.startsWith('$'));
const targets = only ? entries.filter(([key]) => key === only) : entries;

if (targets.length === 0) fail(`No entry named "${only}" in binaries.lock.json`);

await mkdir(BIN_DIR, { recursive: true });

let changed = false;
const checksums = {};

for (const [key, entry] of targets) {
  console.log(`\n== ${key} (${entry.version})`);
  const work = await mkdtemp(join(tmpdir(), `cw-bin-${key}-`));
  try {
    const downloadPath = join(work, 'download.bin');
    console.log(`   fetching ${entry.url}`);
    await download(entry.url, downloadPath);

    const actual = await sha256File(downloadPath);
    if (updateHashes) {
      if (entry.sha256 !== actual) {
        console.log(`   recorded sha256 ${actual}`);
        entry.sha256 = actual;
        changed = true;
      }
    } else if (!entry.sha256) {
      fail(
        `${key} has no pinned sha256 in binaries.lock.json. Run with --update-hashes on a trusted machine and commit the result.`,
      );
    } else if (entry.sha256 !== actual) {
      fail(
        `${key}: sha256 mismatch.\n  expected ${entry.sha256}\n  actual   ${actual}\n` +
          `The download is not the binary that was reviewed. Refusing to ship it.`,
      );
    } else {
      console.log(`   sha256 verified ${actual.slice(0, 16)}…`);
    }

    const installed = await install(key, entry, downloadPath, work);
    for (const [name, digest] of Object.entries(installed)) {
      checksums[name] = digest;
      console.log(`   installed ${name}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (updateHashes && changed) {
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`\nUpdated ${LOCK_PATH} — review the diff before committing.`);
}

// §6.1: resources/bin/checksums.json is verified at first run and after updates,
// so a binary swapped on disk after installation disables that tool with a clear
// message instead of running something unexpected.
const existing = existsSync(join(BIN_DIR, 'checksums.json'))
  ? JSON.parse(await readFile(join(BIN_DIR, 'checksums.json'), 'utf8'))
  : {};
const merged = { ...existing, ...checksums };
await writeFile(join(BIN_DIR, 'checksums.json'), `${JSON.stringify(merged, null, 2)}\n`);
console.log(`\nWrote resources/bin/checksums.json (${Object.keys(merged).length} entries)`);

/* ------------------------------------------------------------------ */

async function install(key, entry, downloadPath, work) {
  const installed = {};

  if (entry.kind === 'file') {
    const target = join(BIN_DIR, entry.target);
    await copyFile(downloadPath, target);
    await chmod(target, 0o755).catch(() => undefined);
    installed[entry.target] = await sha256File(target);
    return installed;
  }

  if (entry.kind === 'zip') {
    const zipPath = join(work, 'archive.zip');
    await copyFile(downloadPath, zipPath);
    const extractDir = join(work, 'unzipped');
    await mkdir(extractDir, { recursive: true });
    // PowerShell ships on every Windows runner; `unzip` does not.
    if (process.platform === 'win32') {
      await exec('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
      ]);
    } else {
      await exec('unzip', ['-q', '-o', zipPath, '-d', extractDir]).catch(() =>
        fail('unzip is required on non-Windows hosts to expand the ffmpeg archive.'),
      );
    }
    for (const [name, relative] of Object.entries(entry.files)) {
      const source = await findFile(extractDir, name);
      if (!source) fail(`${name} was not inside ${entry.url}`);
      const target = join(BIN_DIR, name);
      await copyFile(source, target);
      await chmod(target, 0o755).catch(() => undefined);
      installed[name] = await sha256File(target);
    }
    return installed;
  }

  if (entry.kind === 'whisper-build') {
    // Building whisper.cpp needs a compiler and CMake; the runner has both.
    // Kept here so the release job has one command to call.
    const sourceDir = join(work, 'whisper');
    await mkdir(sourceDir, { recursive: true });
    console.log('   building whisper.cpp (baseline + AVX2)…');
    fail(
      'whisper.cpp is not built yet in this repository. The release job must build it from the pinned tag before packaging; see docs/build.md.',
    );
    void sourceDir;
  }

  fail(`Unknown binary kind "${entry.kind}" for ${key}`);
}

async function findFile(dir, name) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.name === name) return full;
    }
  }
  return null;
}

async function download(url, destination) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? '';
    const hint =
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? 'TLS certificate could not be verified (corporate proxy?). Certificate checks are never disabled.'
        : code === 'ENOTFOUND' || code === 'ECONNREFUSED'
          ? 'The network could not reach the host.'
          : error?.message ?? 'unknown error';
    fail(`Could not download ${url}\n  ${hint}`);
  }
  if (!response.ok) fail(`HTTP ${response.status} fetching ${url}`);
  if (!response.body) fail(`No response body from ${url}`);

  const file = createWriteStream(destination);
  await new Promise((resolvePromise, reject) => {
    response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          return new Promise((resolveWrite, rejectWrite) => {
            file.write(Buffer.from(chunk), (error) => (error ? rejectWrite(error) : resolveWrite()));
          });
        },
        close() {
          file.end(resolvePromise);
        },
        abort(reason) {
          reject(reason);
        },
      }),
    ).catch(reject);
  });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolvePromise)
      .on('error', reject);
  });
  return hash.digest('hex');
}

function fail(message) {
  console.error(`\nbinaries: ${message}\n`);
  process.exit(1);
}

void dirname;
