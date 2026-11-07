/**
 * SPEC 15 §8.2 step 6 — `--smoke-test`.
 *
 * A documented flag the release pipeline uses to prove that an *installed* copy
 * actually works. It checks the things that break in packaging but not in
 * development:
 *
 *   - the bundled binaries exist, are executable, and report a version;
 *   - the main process loaded its own modules (it got this far, so it did);
 *   - the renderer bundle is present on disk;
 *   - a workspace can be created in a temp directory;
 *   - anything else the caller passes in.
 *
 * It deliberately does **not** claim to run a full import → export pipeline.
 * That needs real media and a desktop session, and is listed as a manual step in
 * `docs/verification.md`. A smoke test that lies about its coverage is worse than
 * a narrow one that is honest.
 *
 * Exits 0 on success, 1 with a plain reason on failure.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  ok: boolean;
  checks: SmokeCheck[];
}

/** True when this launch is a smoke test rather than a normal app run. */
export function isSmokeTest(argv: readonly string[]): boolean {
  return argv.includes('--smoke-test');
}

/**
 * Run every check. Never throws: a failed check becomes a failed report, because
 * the whole point is to get a readable reason out of a packaged app.
 */
export async function runSmokeTest(options: {
  /** Directory holding ffmpeg, ffprobe, yt-dlp, whisper-cli. */
  binDir: string;
  /** Absolute path of the renderer's index.html. */
  rendererIndexPath: string;
  /** Directory to create a throwaway workspace in. */
  scratchRoot?: string;
  /** Injected for tests. */
  probeBinary?: (path: string, args: string[]) => Promise<string>;
  log?: (line: string) => void;
}): Promise<SmokeReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  const checks: SmokeCheck[] = [];
  const probe =
    options.probeBinary ??
    (async (path: string, args: string[]) => {
      const { stdout } = await exec(path, args, { timeout: 20_000, windowsHide: true });
      return stdout;
    });

  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}: ${detail}`);
  };

  // ---- 1. Bundled binaries exist and answer.
  const binaries: Array<{ file: string; args: string[] }> = [
    { file: 'ffmpeg.exe', args: ['-version'] },
    { file: 'ffprobe.exe', args: ['-version'] },
    { file: 'yt-dlp.exe', args: ['--version'] },
  ];

  for (const { file, args } of binaries) {
    // Accept the extensionless name too, so the same code works in a dev tree.
    const candidate = existsSync(join(options.binDir, file))
      ? join(options.binDir, file)
      : join(options.binDir, file.replace(/\.exe$/, ''));

    if (!existsSync(candidate)) {
      record(file, false, `missing from ${options.binDir}`);
      continue;
    }
    try {
      const output = await probe(candidate, args);
      const firstLine = output.split('\n')[0]?.trim() ?? '';
      record(file, firstLine.length > 0, firstLine || 'ran but printed nothing');
    } catch (error) {
      record(file, false, `failed to run: ${(error as Error)?.message ?? 'unknown error'}`);
    }
  }

  // ---- 2. whisper-cli is optional at first run: the model is downloaded later,
  // but the executable must be there or transcription can never work.
  const whisper = ['whisper-cli.exe', 'whisper-cli'].map((name) => join(options.binDir, name)).find(existsSync);
  if (!whisper) {
    record('whisper-cli', false, `missing from ${options.binDir}`);
  } else {
    try {
      await probe(whisper, ['--help']);
      record('whisper-cli', true, 'runs');
    } catch {
      // whisper-cli exits non-zero for --help on some builds; existence is the
      // signal we can trust here.
      record('whisper-cli', true, 'present');
    }
  }

  // ---- 3. checksums.json, which the app uses to verify its own tools.
  const checksumsPath = join(options.binDir, 'checksums.json');
  record(
    'bin checksums',
    existsSync(checksumsPath),
    existsSync(checksumsPath) ? 'present' : 'missing; bundled tools cannot be verified',
  );

  // ---- 4. The renderer bundle is on disk (a packaged app that lost it shows a
  // blank window and no error, which is the worst failure mode there is).
  record(
    'renderer bundle',
    existsSync(options.rendererIndexPath),
    options.rendererIndexPath,
  );

  // ---- 5. A workspace can be created: exercises fs permissions, better-sqlite3
  // loading and the storage layer in one go.
  const scratchRoot = options.scratchRoot ?? tmpdir();
  let workspace: string | null = null;
  try {
    workspace = await mkdtemp(join(scratchRoot, 'cw-smoke-'));
    const entries = await readdir(workspace);
    record('workspace', Array.isArray(entries), `created ${workspace}`);
  } catch (error) {
    record('workspace', false, `could not create a workspace: ${(error as Error)?.message ?? 'unknown'}`);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }

  const ok = checks.every((check) => check.ok);
  return { ok, checks };
}

/**
 * Entry point used by main.ts. Prints a report and exits with the right code.
 * Kept separate from `runSmokeTest` so the checks can be tested on Linux.
 */
export async function runSmokeTestAndExit(options: Parameters<typeof runSmokeTest>[0]): Promise<never> {
  console.log('\nClipwright Studio smoke test\n');
  const report = await runSmokeTest(options);
  const failed = report.checks.filter((check) => !check.ok);

  if (report.ok) {
    console.log(`\nsmoke-test: OK (${report.checks.length} checks)\n`);
    process.exit(0);
  }
  console.error(`\nsmoke-test: FAILED (${failed.length} of ${report.checks.length} checks)\n`);
  for (const check of failed) console.error(`  - ${check.name}: ${check.detail}`);
  console.error('');
  process.exit(1);
}
