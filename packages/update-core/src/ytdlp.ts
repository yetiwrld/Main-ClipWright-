/**
 * SPEC 15 §9 — the yt-dlp updater, which is deliberately separate from app
 * updates.
 *
 * yt-dlp changes constantly because the sites it supports change constantly, so
 * a stale binary quietly stops working on some site while everything else is
 * fine. It therefore has its own cadence (7 days by default), its own storage
 * (a user-writable folder, never the install directory) and its own rollback
 * (the previous binary is kept).
 *
 * The rules that matter:
 *
 *  - the download is verified against yt-dlp's own `SHA2-256SUMS` before it
 *    replaces anything; a mismatch leaves the existing binary untouched
 *  - the running binary is kept as `yt-dlp.previous.exe` so a bad update can be
 *    undone without reinstalling the app
 *  - a user-writable copy is preferred over the bundled one only when it is
 *    *newer and verified* — never merely because it exists
 *  - a failure is reported in plain words that say link downloads will use the
 *    bundled version, which is what the user actually needs to know
 *
 * Pure: no I/O, no network. The caller supplies bytes and dates.
 */

/** §9: check weekly by default. */
export const YTDLP_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** §9: where a downloaded update lives, relative to the user data directory. */
export const YTDLP_USER_DIR = 'bin';

export type YtDlpSource = 'bundled' | 'user';

export interface YtDlpVersion {
  source: YtDlpSource;
  /** `2026.11.07` style, as yt-dlp reports it. */
  version: string;
  path: string;
}

/**
 * yt-dlp dates its releases `YYYY.MM.DD` (and occasionally `.HHMMSS`). Comparing
 * them as strings within a year is correct and cheap; across a year it is not,
 * so they are parsed into numbers.
 */
export function parseYtDlpVersion(text: string): [number, number, number, number] | null {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d{2})(\d{2})(\d{2}))?/.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds] = match;
  const time = hours ? Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) : 0;
  return [Number(year), Number(month), Number(day), time];
}

/** -1, 0 or 1; null when either side is not a version we understand. */
export function compareYtDlpVersions(left: string, right: string): number | null {
  const a = parseYtDlpVersion(left);
  const b = parseYtDlpVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/**
 * §9 — which binary to use. The user-writable copy wins only when it is newer
 * *and* has been verified; an unverified or older copy never shadows the bundled
 * one, because that would silently pin the user to a broken download.
 */
export function chooseYtDlpBinary(input: {
  bundled: { version: string; path: string } | null;
  user: { version: string; path: string; verified: boolean } | null;
}): YtDlpVersion | null {
  const { bundled, user } = input;

  if (user && user.verified) {
    if (!bundled) return { source: 'user', version: user.version, path: user.path };
    const comparison = compareYtDlpVersions(user.version, bundled.version);
    if (comparison !== null && comparison > 0) {
      return { source: 'user', version: user.version, path: user.path };
    }
  }

  if (bundled) return { source: 'bundled', version: bundled.version, path: bundled.path };
  return null;
}

/**
 * Read yt-dlp's `SHA2-256SUMS` file. The official file lists every asset, so the
 * line for the asset we want has to be found by name.
 *
 * Returns null when the asset is not listed: an absent entry must not be treated
 * as "no checks to do".
 */
export function findChecksum(sumsText: string, assetName: string): string | null {
  for (const line of sumsText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: `<64 hex chars>  <name>` or `<64 hex> *<name>` for binary mode.
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    if (match[2].trim() !== assetName) continue;
    return match[1].toLowerCase();
  }
  return null;
}

export type YtDlpUpdateCheck =
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; assetName: string; downloadUrl: string; expectedSha256: string }
  | { kind: 'not-due'; nextCheckAt: number }
  /** `blocked` is §9's optional pin for locked-down machines. */
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; message: string };

export interface YtDlpCheckInput {
  now: number;
  /** Epoch ms of the last completed check, or null. */
  lastCheckedAt: number | null;
  /** §9: the optional pin. */
  updatesBlocked?: boolean;
  /** Whether the user has enabled automatic checks at all. */
  autoCheckEnabled: boolean;
  /** Version of the binary in use, or null when none was found. */
  currentVersion: string | null;
  /** What the release page offers. */
  latest: { version: string; assetName: string; downloadUrl: string; sumsText: string } | null;
}

/**
 * Decide whether to check, and what to do about it.
 *
 * The order matters: the pin is honoured before anything else, a failure to read
 * the release is reported rather than retried silently, and "already current" is
 * distinguished from "checked too recently" so the UI can say which.
 */
export function evaluateYtDlpUpdate(input: YtDlpCheckInput): YtDlpUpdateCheck {
  if (input.updatesBlocked) {
    return { kind: 'blocked', reason: 'yt-dlp updates are switched off in Settings.' };
  }

  if (input.autoCheckEnabled && input.lastCheckedAt !== null) {
    const nextCheckAt = input.lastCheckedAt + YTDLP_CHECK_INTERVAL_MS;
    if (input.now < nextCheckAt) return { kind: 'not-due', nextCheckAt };
  }

  if (!input.latest) {
    return {
      kind: 'error',
      message: 'The yt-dlp release could not be read. Link downloads use the version that came with Clipwright.',
    };
  }

  if (!input.currentVersion) {
    // Nothing usable on disk at all: any listed release is an improvement, but
    // the checksum still has to exist before it is offered.
    const expectedSha256 = findChecksum(input.latest.sumsText, input.latest.assetName);
    if (!expectedSha256) {
      return { kind: 'error', message: missingChecksumMessage(input.latest.assetName) };
    }
    return {
      kind: 'available',
      version: input.latest.version,
      assetName: input.latest.assetName,
      downloadUrl: input.latest.downloadUrl,
      expectedSha256,
    };
  }

  const comparison = compareYtDlpVersions(input.latest.version, input.currentVersion);
  if (comparison === null) {
    return { kind: 'error', message: 'The yt-dlp version could not be compared, so nothing was changed.' };
  }
  if (comparison <= 0) return { kind: 'current', version: input.currentVersion };

  const expectedSha256 = findChecksum(input.latest.sumsText, input.latest.assetName);
  if (!expectedSha256) {
    return { kind: 'error', message: missingChecksumMessage(input.latest.assetName) };
  }

  return {
    kind: 'available',
    version: input.latest.version,
    assetName: input.latest.assetName,
    downloadUrl: input.latest.downloadUrl,
    expectedSha256,
  };
}

function missingChecksumMessage(assetName: string): string {
  // Refusing to install is the safe choice, and the reason has to be visible:
  // "no checksum" reads like a bug unless it is explained.
  return `${assetName} is not listed in yt-dlp's checksum file, so it was not installed. Link downloads use the version that came with Clipwright.`;
}

export interface YtDlpInstallPlan {
  /** Complete when the caller may write the new binary into place. */
  ok: boolean;
  reason?: string;
  /** True when the binary being replaced must be kept for rollback. */
  keepBackup: boolean;
}

/**
 * §9: is a downloaded file safe to install?
 *
 * Deliberately does *not* build paths. An earlier version took the platform as a
 * string and joined with `\` or `/`, which silently wrote a file named
 * `bin\yt-dlp.exe` the moment it was used on a different platform from the one
 * it was told about. Path construction belongs to the caller, which has the real
 * filesystem and `node:path`.
 *
 * `keepBackup` is only true once the digest matches, so a refused download can
 * never cause the existing binary to be moved aside.
 */
export function planYtDlpInstall(input: {
  actualSha256: string;
  expectedSha256: string;
  hasExisting: boolean;
}): YtDlpInstallPlan {
  if (input.actualSha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
    return {
      ok: false,
      keepBackup: false,
      reason:
        'The downloaded yt-dlp did not match its checksum and was discarded. ' +
        'Link downloads use the version that came with Clipwright.',
    };
  }

  return { ok: true, keepBackup: input.hasExisting };
}

/** §9: "Restore bundled version" removes the user copy, falling back to the bundled one. */
export function shouldRestoreBundled(input: { userExists: boolean; bundledExists: boolean }): {
  ok: boolean;
  reason?: string;
} {
  if (!input.userExists) return { ok: false, reason: 'The updated yt-dlp was already removed.' };
  if (!input.bundledExists) {
    return {
      ok: false,
      reason: 'The bundled yt-dlp is missing, so the update cannot be undone. Reinstall Clipwright Studio.',
    };
  }
  return { ok: true };
}

/** §9: the one line Settings → Updates shows for yt-dlp. */
export function describeYtDlpStatus(input: {
  version: string | null;
  source: YtDlpSource | null;
  lastCheckedAt: number | null;
  now: number;
}): string {
  if (!input.version) return 'yt-dlp was not found. Reinstall Clipwright Studio to restore it.';
  const where = input.source === 'user' ? 'downloaded separately' : 'bundled with Clipwright';
  if (input.lastCheckedAt === null) return `${input.version}, ${where}. Never checked.`;
  const days = Math.floor((input.now - input.lastCheckedAt) / (24 * 60 * 60 * 1000));
  if (days <= 0) return `${input.version}, ${where}. Checked today.`;
  if (days === 1) return `${input.version}, ${where}. Checked yesterday.`;
  return `${input.version}, ${where}. Checked ${days} days ago.`;
}
