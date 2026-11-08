#!/usr/bin/env node
/**
 * Assert that the packaged app can actually start.
 *
 * This exists because of a bug found while writing the packaging config: `vite
 * build` emitted only the renderer, so `dist/main/index.cjs` — the file
 * package.json names as `main` — never existed. electron-builder would have
 * happily produced an installer for an app that cannot launch, and nobody would
 * find out until a user double-clicked it.
 *
 * Runs after packaging and inspects the real artefact tree, not the source.
 *
 * Usage: node scripts/release/assert-package.mjs
 */
import { existsSync } from 'node:fs';
import { open, readdir, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const DIST = join(DESKTOP, 'dist');

const problems = [];

// ---- 1. The build output exists and names a real entry point.
const pkg = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
const mainRelative = pkg.main ?? 'dist/main/index.cjs';
const mainPath = join(DESKTOP, mainRelative);

if (!existsSync(mainPath)) {
  problems.push(`package.json "main" points at ${mainRelative}, which was not built.`);
}

// ---- 2. The preload script the window loads must be there too.
const preload = join(DIST, 'main', 'preload.cjs');
if (!existsSync(preload)) {
  problems.push('dist/main/preload.cjs is missing; the window would have no bridge.');
}

// ---- 3. The renderer, with its index.html and bundled scripts.
const rendererIndex = join(DIST, 'renderer', 'index.html');
if (!existsSync(rendererIndex)) {
  problems.push('dist/renderer/index.html is missing; the window would load nothing.');
} else {
  const html = await readFile(rendererIndex, 'utf8');
  if (!/<script[^>]+src=/.test(html)) {
    problems.push('dist/renderer/index.html references no script bundle.');
  }
  // A leftover absolute /assets path would 404 under file:// in the packaged app.
  if (/(?:src|href)=["']\/(?!\/)/.test(html)) {
    problems.push(
      'dist/renderer/index.html uses root-absolute URLs, which break under file://. Check vite base.',
    );
  }
}

// ---- 4. The main bundle must actually contain our code, not just re-exports of
// missing files. A quick, honest check: it should be tens of KB at least.
if (existsSync(mainPath)) {
  const info = await stat(mainPath);
  const chunks = await readdir(join(DIST, 'main')).catch(() => []);
  let totalBytes = info.size;
  for (const chunk of chunks.filter((name) => name.endsWith('.cjs'))) {
    totalBytes += (await stat(join(DIST, 'main', chunk))).size;
  }
  if (totalBytes < 100 * 1024) {
    problems.push(
      `The main-process bundle is only ${(totalBytes / 1024).toFixed(0)} KB; that is too small to contain the app.`,
    );
  }
  console.log(`   main process: ${(totalBytes / 1024).toFixed(0)} KB across ${chunks.length} files`);
}

// ---- 5. electron-builder actually produced an installer.
const builderOutput = await readdir(DIST).catch(() => []);
const installers = builderOutput.filter((name) => /Setup-.*-x64\.exe$/.test(name));
const portables = builderOutput.filter((name) => /portable\.exe$/.test(name));
if (installers.length === 0) problems.push('No NSIS installer was produced.');
if (portables.length === 0) problems.push('No portable exe was produced.');
for (const name of [...installers, ...portables]) {
  const info = await stat(join(DIST, name));
  if (info.size < 20 * 1024 * 1024) {
    problems.push(`${name} is only ${(info.size / 1024 / 1024).toFixed(1)} MB; an app this size cannot be complete.`);
  }
}

// ---- 6. Bundled binaries made it into extraResources.
const packagedResources = join(DIST, 'win-unpacked', 'resources', 'bin');
if (existsSync(packagedResources)) {
  const bins = await readdir(packagedResources);
  for (const required of ['ffmpeg.exe', 'ffprobe.exe']) {
    if (!bins.includes(required)) problems.push(`${required} is not in the packaged resources/bin.`);
  }
  if (!bins.includes('checksums.json')) {
    problems.push('resources/bin/checksums.json is missing; binaries cannot be verified at first run.');
  }
} else {
  problems.push('dist/win-unpacked/resources/bin is missing; no binaries were packaged.');
}

// ---- 7. The native modules the app cannot start without are inside the asar.
//
// `better-sqlite3` is a compiled addon: if it is missing, `require` throws the
// moment the first database is opened, which happens before the window shows
// anything useful. Packaged under pnpm it is a symlink into the workspace store,
// and a symlink that resolves to nothing is exactly as broken as a missing file
// while looking like it is present.
//
// `files` does not control node_modules (electron-builder copies production
// dependencies through a separate matcher), so this cannot be inferred from the
// config — it has to be read out of the archive that was actually built.
const appAsar = join(DIST, 'win-unpacked', 'resources', 'app.asar');
if (!existsSync(appAsar)) {
  problems.push('dist/win-unpacked/resources/app.asar is missing; nothing was packaged.');
} else {
  const entries = await listAsarEntries(appAsar);
  if (entries === null) {
    problems.push('app.asar could not be read; the package cannot be inspected.');
  } else {
    const hasSqlite = entries.some((entry) => entry.startsWith('node_modules/better-sqlite3/'));
    if (!hasSqlite) {
      problems.push(
        'better-sqlite3 is not inside app.asar; the app would throw the first time it opens a database.',
      );
    }

    // A .node addon cannot be loaded from inside an asar archive, so every one
    // must also appear under app.asar.unpacked. electron-builder derives that
    // from `asarUnpack`, and a pattern that stops matching silently produces an
    // app that loads until it touches SQLite, then dies.
    const unpackedRoot = join(DIST, 'win-unpacked', 'resources', 'app.asar.unpacked');
    const unpackedAddons = await findFiles(unpackedRoot, (name) => name.endsWith('.node'));
    const packagedAddons = entries.filter((entry) => entry.endsWith('.node'));
    if (packagedAddons.length === 0) {
      problems.push('No .node addon is inside app.asar, so no native module was packaged.');
    }
    if (unpackedAddons.length === 0) {
      problems.push(
        'No .node addon was unpacked into app.asar.unpacked; a native module cannot be loaded from an asar.',
      );
    }
    console.log(`   app.asar: ${entries.length} entries, ${unpackedAddons.length} native addon(s) unpacked`);
  }
}

if (problems.length > 0) {
  console.error('\nassert-package: the package would not work:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log('\nassert-package: OK — the package has a launchable app, both artefacts and the binaries.\n');

/**
 * Reads the file list out of an asar archive by parsing its header.
 *
 * asar is `[8-byte size fields][4-byte JSON length][JSON][files...]`, and the
 * JSON is a flat directory tree where files carry a `size` and directories carry
 * `files`. `@electron/asar` would do this, but it is only a transitive
 * dependency here — reaching for it would make this gate fail on a clean
 * install, which is worse than a thirty-line parser.
 *
 * Returns null when the archive is not readable, so the caller can fail loudly
 * rather than assume the package is fine.
 */
async function listAsarEntries(archivePath) {
  let header;
  try {
    const handle = await open(archivePath, 'r');
    try {
      const prefix = Buffer.alloc(16);
      await handle.read(prefix, 0, 16, 0);
      const jsonLength = prefix.readUInt32LE(12);
      header = Buffer.alloc(jsonLength);
      await handle.read(header, 0, jsonLength, 16);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  let tree;
  try {
    tree = JSON.parse(header.toString('utf8'));
  } catch {
    return null;
  }

  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = `${prefix}${name}`;
      // `unpacked: true` entries live outside the archive; they are still listed
      // in the header, which is how app.asar.unpacked is discoverable.
      entries.push(child.files ? `${path}/` : path);
      if (child.files) walk(child, `${path}/`);
    }
  };
  walk(tree, '');
  return entries;
}

/** Every file under `dir` whose name satisfies `predicate`. */
async function findFiles(dir, predicate) {
  const found = [];
  const visit = async (current) => {
    for (const name of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = join(current, name.name);
      if (name.isDirectory()) await visit(full);
      else if (predicate(name.name)) found.push(full);
    }
  };
  await visit(dir);
  return found;
}
