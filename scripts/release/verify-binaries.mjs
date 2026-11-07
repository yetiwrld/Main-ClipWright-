#!/usr/bin/env node
/**
 * SPEC 15 §6.1 — verify `resources/bin` before it is packaged.
 *
 * Two checks that catch different mistakes:
 *
 *   1. every binary named in `binaries.lock.json` is present and its digest
 *      matches the pinned one (catches a swapped or stale file);
 *   2. `checksums.json` agrees with the files on disk (catches a build that
 *      copied binaries but forgot to refresh the manifest, which would make the
 *      app disable its own tools at first run).
 *
 * Usage: node scripts/release/verify-binaries.mjs
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BIN_DIR = join(ROOT, 'resources', 'bin');
const LOCK = join(ROOT, 'scripts', 'binaries.lock.json');
const CHECKSUMS = join(BIN_DIR, 'checksums.json');

const problems = [];

if (!existsSync(BIN_DIR)) {
  fail(`resources/bin is missing entirely.`);
}

const lock = JSON.parse(await readFile(LOCK, 'utf8'));
const expectedFiles = new Set();
for (const [key, entry] of Object.entries(lock)) {
  if (key.startsWith('$')) continue;
  if (!entry.sha256) {
    problems.push(`${key} has no pinned sha256; the release would ship an unverified binary.`);
    continue;
  }
  const names = entry.files ? Object.keys(entry.files) : [entry.target];
  for (const name of names) expectedFiles.add(name);
}

const checksums = existsSync(CHECKSUMS) ? JSON.parse(await readFile(CHECKSUMS, 'utf8')) : null;
if (!checksums) {
  problems.push('resources/bin/checksums.json is missing; the app cannot verify its tools at first run.');
}

for (const name of expectedFiles) {
  const path = join(BIN_DIR, name);
  if (!existsSync(path)) {
    problems.push(`${name} is not in resources/bin.`);
    continue;
  }
  const digest = await sha256File(path);
  if (checksums && checksums[name] !== digest) {
    if (checksums[name] === undefined) {
      problems.push(`${name} is not listed in checksums.json.`);
    } else {
      problems.push(`${name} does not match its recorded checksum.`);
    }
  }
  // A zero-byte or tiny binary is a failed download, not a binary.
  const info = await readFile(path).then((buffer) => buffer.byteLength);
  if (info < 100_000) {
    problems.push(`${name} is only ${info} bytes; that cannot be a real executable.`);
  }
}

// A symlinked binary (a dev checkout) must never be packaged: the link would
// either dangle or, worse, copy a Linux binary into a Windows installer.
const { lstatSync } = await import('node:fs');
for (const name of expectedFiles) {
  const path = join(BIN_DIR, name);
  if (!existsSync(path)) continue;
  if (lstatSync(path).isSymbolicLink()) {
    problems.push(`${name} is a symlink. A release build must contain real Windows binaries.`);
  }
}

if (problems.length > 0) {
  console.error('\nverify-binaries: refusing to package:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nRun scripts/release/fetch-binaries.mjs on a clean checkout to fix this.\n');
  process.exit(1);
}

console.log(`verify-binaries: OK — ${expectedFiles.size} binaries match their pinned digests.`);

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolvePromise)
      .on('error', reject);
  });
  return hash.digest('hex');
}

function fail(message) {
  console.error(`\nverify-binaries: ${message}\n`);
  process.exit(1);
}
