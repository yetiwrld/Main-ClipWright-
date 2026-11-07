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
import { readFile, readdir, stat } from 'node:fs/promises';
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

if (problems.length > 0) {
  console.error('\nassert-package: the package would not work:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log('\nassert-package: OK — the package has a launchable app, both artefacts and the binaries.\n');
