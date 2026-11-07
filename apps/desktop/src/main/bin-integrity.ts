/**
 * SPEC 15 §6.1 — verify the bundled binaries before trusting them.
 *
 * `resources/bin/checksums.json` records the SHA-256 of every executable we ship.
 * At startup (and after an update) the app compares each file against its
 * recorded digest. A mismatch **disables that tool** with a clear message and a
 * "reinstall" hint, rather than running it.
 *
 * That choice matters: a replaced `ffmpeg` is executed with paths inside the
 * user's workspace, so running a binary whose hash does not match is a code
 * execution risk, not a robustness nicety. Disabling a tool is recoverable;
 * running the wrong one is not.
 *
 * A missing `checksums.json` is treated as "cannot verify" for the same reason —
 * it is reported as unverified rather than as fine.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ToolName = 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'whisper-cli';

export type ToolStatus =
  | { state: 'ok'; path: string }
  | { state: 'missing'; path: string; message: string }
  | { state: 'unverified'; path: string; message: string }
  | { state: 'mismatch'; path: string; message: string; expected: string; actual: string };

export interface BinIntegrityReport {
  /** Per-tool outcome, keyed by the name the app uses. */
  tools: Record<string, ToolStatus>;
  /** True when `checksums.json` was present and readable. */
  manifestPresent: boolean;
  /** Tools that are usable. */
  enabled: string[];
  /** Plain sentences for the user, one per problem. Always empty when all is well. */
  problems: string[];
}

/** Checksums are recorded against the file name as shipped, with or without `.exe`. */
function checksumKey(tool: string): string[] {
  return [`${tool}.exe`, tool];
}

export interface VerifyOptions {
  /** Directory holding the binaries and `checksums.json`. */
  binDir: string;
  /** Names to check; defaults to the four tools the app spawns. */
  tools?: string[];
  /** Injected for tests. */
  readChecksums?: (path: string) => Promise<Record<string, string> | null>;
  hashFile?: (path: string) => Promise<string>;
}

/**
 * Verify every tool. Never throws: a problem becomes a `ToolStatus` and a
 * sentence for the user, because a startup check that crashes the app is worse
 * than the problem it was looking for.
 */
export async function verifyBundledTools(options: VerifyOptions): Promise<BinIntegrityReport> {
  const { binDir } = options;
  const toolNames = options.tools ?? ['ffmpeg', 'ffprobe', 'yt-dlp', 'whisper-cli'];
  const hashFile = options.hashFile ?? sha256OfFile;

  const readChecksums =
    options.readChecksums ??
    (async (path: string) => {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
      } catch {
        return null;
      }
    });

  const checksums = await readChecksums(join(binDir, 'checksums.json'));
  const manifestPresent = checksums !== null;

  const tools: Record<string, ToolStatus> = {};
  const problems: string[] = [];

  for (const tool of toolNames) {
    const located = locate(binDir, tool);

    if (!located) {
      tools[tool] = {
        state: 'missing',
        path: join(binDir, tool),
        message: `${tool} is missing. Reinstall Clipwright Studio to restore it.`,
      };
      problems.push(tools[tool].message);
      continue;
    }

    if (!manifestPresent) {
      tools[tool] = {
        state: 'unverified',
        path: located,
        message: `${tool} could not be verified because its checksum list is missing. Reinstall Clipwright Studio.`,
      };
      problems.push(tools[tool].message);
      continue;
    }

    const expected = checksumKey(tool)
      .map((key) => checksums![key])
      .find((value): value is string => typeof value === 'string' && value.length === 64);

    if (!expected) {
      // Not recorded at all: we cannot claim it is fine, so say so.
      tools[tool] = {
        state: 'unverified',
        path: located,
        message: `${tool} has no recorded checksum, so it was not verified.`,
      };
      continue;
    }

    let actual: string;
    try {
      actual = await hashFile(located);
    } catch {
      tools[tool] = {
        state: 'unverified',
        path: located,
        message: `${tool} could not be read to verify it. Reinstall Clipwright Studio.`,
      };
      problems.push(tools[tool].message);
      continue;
    }

    if (actual !== expected) {
      tools[tool] = {
        state: 'mismatch',
        path: located,
        expected,
        actual,
        message:
          `${tool} does not match the checksum it shipped with, so it was disabled. ` +
          `Reinstall Clipwright Studio. (If your antivirus changed it, add an exclusion.)`,
      };
      problems.push(tools[tool].message);
      continue;
    }

    tools[tool] = { state: 'ok', path: located };
  }

  const enabled = Object.entries(tools)
    .filter(([, status]) => status.state === 'ok')
    .map(([name]) => name);

  return { tools, manifestPresent, enabled, problems };
}

/** Find the tool on disk, accepting the Windows `.exe` suffix. */
function locate(binDir: string, tool: string): string | null {
  for (const name of checksumKey(tool)) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * The one-line summary for the UI. Null when there is nothing to say, so the app
 * does not nag about a healthy install.
 */
export function summariseIntegrity(report: BinIntegrityReport): string | null {
  if (report.problems.length === 0) return null;
  if (report.problems.length === 1) return report.problems[0];
  return `${report.problems.length} bundled tools could not be verified. Reinstall Clipwright Studio.`;
}

/**
 * Whether a specific tool may be spawned. Callers use this instead of assuming
 * a binary exists: using a disabled tool would defeat the whole check.
 */
export function isToolEnabled(report: BinIntegrityReport, tool: ToolName | string): boolean {
  return report.tools[tool]?.state === 'ok';
}
