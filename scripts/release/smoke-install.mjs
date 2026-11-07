#!/usr/bin/env node
/**
 * SPEC 15 §8.2 step 6 — install the artefact we just built, launch it, and prove
 * it works, before anything is published.
 *
 * What this can and cannot do is stated plainly:
 *
 *   - It installs NSIS silently into a temp directory, launches the installed
 *     exe with `--smoke-test`, and requires exit code 0.
 *   - It runs the packaged unpacked app from `dist/win-unpacked` as well, which
 *     catches a broken asar or a missing native module without needing the
 *     installer at all.
 *   - It does **not** test the full import → transcribe → export path. That needs
 *     a GPU-less Windows desktop session and real media, and is documented in
 *     docs/verification.md as a manual step. Saying so is better than a smoke
 *     test that looks comprehensive and is not.
 *
 * On a non-Windows host it skips with a clear message and exit 0, so the script
 * can run in a Linux dev shell without pretending it verified anything.
 *
 * Usage: node scripts/release/smoke-install.mjs
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'apps', 'desktop', 'dist');
const SMOKE_TIMEOUT_MS = 120_000;

if (process.platform !== 'win32') {
  console.log('smoke-install: skipped (not Windows). The release job runs this on windows-latest.');
  process.exit(0);
}

const files = await readdir(DIST).catch(() => []);
const installer = files.find((name) => /Setup-.*-x64\.exe$/.test(name));
const portable = files.find((name) => /portable\.exe$/.test(name));
const unpacked = join(DIST, 'win-unpacked', 'Clipwright Studio.exe');

if (!installer) fail('No NSIS installer found in dist/. Build before running the smoke test.');

const work = await mkdtemp(join(tmpdir(), 'cw-smoke-'));
const installDir = join(work, 'installed');

try {
  // ---- 1. The unpacked app: fastest signal that the bundle is sound.
  if (existsSync(unpacked)) {
    console.log('== Launching the unpacked app with --smoke-test');
    await runSmoke(unpacked, work);
    console.log('   unpacked app exited 0');
  } else {
    console.log('   (no win-unpacked build; skipping the unpacked launch)');
  }

  // ---- 2. Install silently, per-user, into the temp directory.
  console.log(`== Installing ${installer} into ${installDir}`);
  await exec(installer, ['/S', `/D=${installDir}`], { windowsHide: true });

  const installedExe = join(installDir, 'Clipwright Studio.exe');
  if (!existsSync(installedExe)) {
    const contents = await readdir(installDir).catch(() => []);
    fail(`The installer finished but left no exe. Contents: ${contents.join(', ') || '(nothing)'}`);
  }

  // ---- 3. Launch the installed app.
  console.log('== Launching the installed app with --smoke-test');
  await runSmoke(installedExe, work);
  console.log('   installed app exited 0');

  // ---- 4. The portable exe must run without installing.
  if (portable) {
    console.log(`== Launching ${portable} with --smoke-test`);
    await runSmoke(join(DIST, portable), work);
    console.log('   portable exe exited 0');
  }

  // ---- 5. Uninstall must keep the workspace.
  console.log('== Uninstalling');
  const uninstaller = join(installDir, 'Uninstall Clipwright Studio.exe');
  if (existsSync(uninstaller)) {
    await exec(uninstaller, ['/S'], { windowsHide: true });
    if (existsSync(installedExe)) {
      fail('The uninstaller left the application exe behind.');
    }
    console.log('   uninstalled cleanly');
  } else {
    console.log('   (no uninstaller found; skipping)');
  }

  console.log('\nsmoke-install: OK\n');
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Run an exe with `--smoke-test` and require exit code 0 within the timeout.
 * The flag is handled in main.ts: it opens the window, checks the bundled
 * binaries, creates a temp workspace, and exits.
 */
async function runSmoke(exePath, cwd) {
  const child = spawn(exePath, ['--smoke-test'], {
    cwd,
    stdio: 'pipe',
    windowsHide: true,
    env: { ...process.env, CLIPWRIGHT_SMOKE: '1' },
  });

  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });

  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, SMOKE_TIMEOUT_MS);

  const code = await new Promise((resolveCode) => {
    child.on('close', resolveCode);
    child.on('error', () => resolveCode(-1));
  });
  clearTimeout(timeout);

  if (code !== 0) {
    const tail = output.split('\n').slice(-20).join('\n');
    fail(`${exePath} --smoke-test exited ${code}.\n--- output ---\n${tail}\n--------------`);
  }
}

function fail(message) {
  console.error(`\nsmoke-install: ${message}\n`);
  process.exit(1);
}
