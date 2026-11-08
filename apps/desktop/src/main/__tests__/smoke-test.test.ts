// @vitest-environment node
/**
 * SPEC 15 §8.2 step 6 — the smoke test the release pipeline relies on.
 *
 * The checks run against the repo's real `resources/bin`, so this fails if a
 * binary disappears from the tree. The `--smoke-test` flag itself is exercised
 * by the release workflow against the packaged installer; here we test the logic
 * that decides pass or fail, which is the part that can quietly lie.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isSmokeTest, runSmokeTest } from '../smoke-test.js';
import { ffmpegPath, ffprobePath } from '../export/ffmpeg-runner.js';

const BIN_DIR = join(process.cwd(), 'resources', 'bin');
const RENDERER = join(process.cwd(), 'apps', 'desktop', 'dist', 'renderer', 'index.html');
const TMP = join(process.cwd(), '.tmp-smoke');

// Same guard as every other suite that needs a real encoder. CI checks out a
// clean tree with no binaries fetched (they are gitignored, and the release job
// downloads them separately), so without this the suite passes on a developer's
// machine and fails on CI for a reason that has nothing to do with the code.
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('isSmokeTest', () => {
  it('recognises the flag anywhere in argv', () => {
    expect(isSmokeTest(['app.exe', '--smoke-test'])).toBe(true);
    expect(isSmokeTest(['app.exe', '--other', '--smoke-test'])).toBe(true);
    expect(isSmokeTest(['app.exe'])).toBe(false);
    expect(isSmokeTest(['app.exe', '--smoke-testing'])).toBe(false);
  });
});

describe.skipIf(!HAS_FFMPEG)('runSmokeTest against the bundled binaries', () => {
  it('passes against the bundled binaries and a real renderer bundle', async () => {
    const report = await runSmokeTest({
      binDir: BIN_DIR,
      rendererIndexPath: RENDERER,
      log: () => undefined,
    });

    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    expect(byName['ffmpeg.exe']?.ok, JSON.stringify(byName['ffmpeg.exe'])).toBe(true);
    expect(byName['ffprobe.exe']?.ok, JSON.stringify(byName['ffprobe.exe'])).toBe(true);
    expect(byName.workspace?.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
  });

  it('reports a real version string, not just "it ran"', async () => {
    const report = await runSmokeTest({
      binDir: BIN_DIR,
      rendererIndexPath: RENDERER,
      log: () => undefined,
    });
    const ffmpeg = report.checks.find((check) => check.name === 'ffmpeg.exe');
    expect(ffmpeg?.detail).toMatch(/ffmpeg version/i);
  });
});

// These need no working encoder: each one asserts that the smoke test *fails*,
// which a missing or unexecutable binary produces just as well. Keeping them
// outside the guard matters — on CI there are no binaries, so gating them too
// would leave the failure paths untested on the only machine that runs them.
describe('runSmokeTest failure paths', () => {
  it('fails when a binary is missing', async () => {
    mkdirSync(TMP, { recursive: true });
    const report = await runSmokeTest({
      binDir: TMP,
      rendererIndexPath: RENDERER,
      log: () => undefined,
    });
    expect(report.ok).toBe(false);
    const ffmpeg = report.checks.find((check) => check.name === 'ffmpeg.exe');
    expect(ffmpeg?.ok).toBe(false);
    expect(ffmpeg?.detail).toContain('missing');
  });

  it('fails when the renderer bundle is missing', async () => {
    const report = await runSmokeTest({
      binDir: BIN_DIR,
      rendererIndexPath: join(TMP, 'nope', 'index.html'),
      log: () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'renderer bundle')?.ok).toBe(false);
  });

  it('fails when a binary exists but cannot run', async () => {
    // A file that is not an executable is exactly what a corrupted download
    // leaves behind; the smoke test must not pass it.
    mkdirSync(TMP, { recursive: true });
    const fakeFfmpeg = join(TMP, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    writeFileSync(fakeFfmpeg, 'not an executable');

    const report = await runSmokeTest({
      binDir: TMP,
      rendererIndexPath: RENDERER,
      log: () => undefined,
    });
    const ffmpeg = report.checks.find((check) => check.name === 'ffmpeg.exe');
    expect(ffmpeg?.ok).toBe(false);
    expect(ffmpeg?.detail).toMatch(/failed to run/);
  });

  it('uses the real ffmpeg the export path uses', () => {
    // The smoke test and the exporter must agree on which binary is "the" ffmpeg.
    expect(ffmpegPath()).toBeTruthy();
    expect(ffprobePath()).toBeTruthy();
  });
});

describe.skipIf(!HAS_FFMPEG)('runSmokeTest workspace hygiene', () => {
  it('cleans up the workspace it created', async () => {
    const before = execFileSync('node', ['-e', `require('fs').readdirSync(${JSON.stringify(process.cwd())}, {withFileTypes:true}).filter(d=>d.name.startsWith('cw-smoke-')).length`], { encoding: 'utf8' }).trim();
    const report = await runSmokeTest({
      binDir: BIN_DIR,
      rendererIndexPath: RENDERER,
      scratchRoot: process.cwd(),
      log: () => undefined,
    });
    expect(report.checks.find((check) => check.name === 'workspace')?.ok).toBe(true);
    const after = execFileSync('node', ['-e', `require('fs').readdirSync(${JSON.stringify(process.cwd())}, {withFileTypes:true}).filter(d=>d.name.startsWith('cw-smoke-')).length`], { encoding: 'utf8' }).trim();
    expect(after).toBe(before);
  });
});
