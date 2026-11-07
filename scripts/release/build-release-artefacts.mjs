#!/usr/bin/env node
/**
 * SPEC 15 §8.2 steps 4–6 — build, then collect everything the release publishes.
 *
 * Called by `.github/workflows/release.yml`. Does four things in order and stops
 * at the first failure:
 *
 *   1. build the desktop app (renderer + main + preload);
 *   2. run electron-builder for the NSIS installer and the portable exe;
 *   3. copy the artefacts, `latest.yml` and the blockmap into `dist/release/`;
 *   4. write `RELEASE_NOTES.md` from the CHANGELOG section for this tag, with the
 *      unsigned notice appended when no certificate is configured.
 *
 * `make-manifest.mjs` runs *after* this in the workflow, because it signs the
 * artefacts this script produces. Signing before building would sign nothing.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUT = join(ROOT, 'dist', 'release');
const BUILDER_OUT = join(DESKTOP, 'dist');

const isWindows = process.platform === 'win32';
const version = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8')).version;

if (!isWindows) {
  console.log('Not running on Windows: electron-builder will build for the current platform only.');
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// ---- 1. Build the app (renderer, main, preload).
console.log('\n== Building the desktop app');
run('pnpm', ['--filter', '@clipwright/desktop', 'build'], ROOT);

// ---- 2. Package. `--publish never`: publishing is a separate, deliberate step
// so a failed check cannot leave a half-published release behind.
console.log('\n== Packaging (nsis + portable)');
run(
  'pnpm',
  ['--filter', '@clipwright/desktop', 'exec', 'electron-builder', '--win', 'nsis', 'portable', '--x64', '--publish', 'never'],
  ROOT,
  { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
);

// ---- 3. Collect artefacts.
if (!existsSync(BUILDER_OUT)) fail(`electron-builder produced no output in ${BUILDER_OUT}`);

const produced = await readdir(BUILDER_OUT);
const wanted = produced.filter((name) =>
  /\.(exe|blockmap)$/.test(name) || name === 'latest.yml' || name === 'builder-effective-config.yaml',
);
if (!wanted.some((name) => name.endsWith('.exe'))) {
  fail(`No installer was produced. Files present: ${produced.join(', ')}`);
}

for (const name of wanted) {
  await copyFile(join(BUILDER_OUT, name), join(OUT, name));
}

// Report the real sizes; §6.1 sets a 450 MB budget and wants the number recorded.
let totalBytes = 0;
for (const name of wanted.filter((entry) => entry.endsWith('.exe'))) {
  const info = await stat(join(OUT, name));
  totalBytes += info.size;
  console.log(`   ${name}  ${(info.size / (1024 * 1024)).toFixed(1)} MB`);
}
console.log(`   total ${(totalBytes / (1024 * 1024)).toFixed(1)} MB (budget 450 MB)`);

// ---- 4. Release notes. `extract-notes.mjs` is the canonical parser (it runs
// earlier in the workflow); this step only adds the unsigned notice, because that
// depends on whether a certificate was configured *for this build*.
const notes = await releaseNotes(version);
await writeFile(join(OUT, 'RELEASE_NOTES.md'), notes);
console.log(`\nWrote ${join(OUT, 'RELEASE_NOTES.md')}`);
console.log(`Artefacts in ${OUT}`);

/* ------------------------------------------------------------------ */

async function releaseNotes(appVersion) {
  // Prefer the section the workflow extracted; fall back to reading the CHANGELOG
  // through the same script so there is only one parser in the repository.
  const extracted = await readFile(join(OUT, 'notes.md'), 'utf8').catch(() => '');
  const section = extracted.trim() || (await readChangelogSection(appVersion));

  const unsigned = process.env.CSC_LINK
    ? ''
    : [
        '',
        '---',
        '',
        '**Unsigned.** This build carries no code-signing certificate, so Windows',
        'SmartScreen may warn that the publisher is unknown. Choose *More info* ->',
        '*Run anyway*, and verify the SHA-256 against `SHA256SUMS.txt` on this',
        'release page before running the installer.',
        '',
        'The app verifies every update against a signed release manifest and will',
        'refuse anything it cannot verify.',
      ].join('\n');

  const body = section || `Clipwright Studio ${appVersion}. See CHANGELOG.md for details.`;
  return `# Clipwright Studio ${appVersion}\n\n${body.trim()}\n${unsigned}\n`;
}

/**
 * Delegate to `extract-notes.mjs` rather than reimplementing the parser: two
 * parsers drift, and a release note that silently loses its "Known issues" section
 * is exactly the kind of bug nobody notices until after shipping.
 */
async function readChangelogSection(appVersion) {
  const { execFileSync } = await import('node:child_process');
  try {
    return execFileSync(process.execPath, [
      join(ROOT, 'scripts', 'release', 'extract-notes.mjs'),
      '--version', appVersion,
      '--out', join(OUT, 'notes.md'),
    ], { encoding: 'utf8' }) && (await readFile(join(OUT, 'notes.md'), 'utf8')).trim();
  } catch {
    return '';
  }
}

function run(command, args, cwd, extraEnv = {}) {
  try {
    execFileSync(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      shell: isWindows,
    });
  } catch (error) {
    fail(`${command} ${args.join(' ')} failed: ${error?.message ?? error}`);
  }
}

function fail(message) {
  console.error(`\nbuild-release-artefacts: ${message}\n`);
  process.exit(1);
}
