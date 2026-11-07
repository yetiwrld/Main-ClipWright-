/**
 * SPEC 15 §2.5, §5 — version ordering and channel rules.
 *
 * Semver with an optional `-beta.N` prerelease, because that is exactly what
 * SPEC 15 §8.1 allows the project to publish. Anything else is rejected rather
 * than guessed at: a version we cannot compare is a version we must not
 * silently install over the user's app.
 *
 * Pure: no I/O, no clock.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifier, e.g. `beta.3`; absent for a stable release. */
  prerelease?: string;
  /** Numeric prerelease counter when the tag is `beta.N`. */
  prereleaseNumber?: number;
  /** The original string, so error messages quote what the user sees. */
  raw: string;
}

export type UpdateChannel = 'stable' | 'beta';

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parse `1.2.3`, `1.2.3-beta.1` or `v1.2.3`. Returns null when the string is
 * not a version this app is willing to compare — never a best-effort guess.
 */
export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  const parsed: ParsedVersion = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    raw: input.trim(),
  };
  if (prerelease) {
    parsed.prerelease = prerelease;
    const counter = /^beta\.(\d+)$/.exec(prerelease);
    if (counter) parsed.prereleaseNumber = Number(counter[1]);
  }
  return parsed;
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

/**
 * Compare two versions: -1 when `a` is older, 1 when `a` is newer, 0 when equal.
 *
 * A prerelease sorts *below* its release (1.3.0-beta.2 < 1.3.0), which is what
 * makes "you are on beta, a stable of the same version appeared" behave right.
 * Throws on unparseable input, because a silent 0 would mean "no update" for a
 * version we could not actually judge (§5 downgrade protection).
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) throw new Error(`Not a version: ${a}`);
  if (!right) throw new Error(`Not a version: ${b}`);

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }

  // Same numeric core: a release outranks a prerelease.
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  // Both prereleases: compare the numeric counter when both have one, else the
  // identifiers lexically, which is enough for `beta.N`.
  if (left.prereleaseNumber !== undefined && right.prereleaseNumber !== undefined) {
    if (left.prereleaseNumber !== right.prereleaseNumber) {
      return left.prereleaseNumber < right.prereleaseNumber ? -1 : 1;
    }
    return 0;
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Is this release visible on the given channel?
 *
 * Stable users never see prereleases (§2.5). Beta users see both — and because
 * prereleases sort below their release, a beta user on `1.3.0-beta.4` is
 * correctly offered the `1.3.0` stable when it lands.
 */
export function isReleaseVisible(
  version: string,
  channel: UpdateChannel,
  options: { prerelease: boolean },
): boolean {
  if (channel === 'beta') return true;
  return options.prerelease === false;
}

export type UpdateDecision =
  | { action: 'update'; reason: 'newer-release' | 'prerelease-to-release' }
  | { action: 'none'; reason: 'same-version' | 'older-version' | 'channel-mismatch' };

/**
 * Decide what to do about a published release. This is the single place where
 * §5's downgrade protection and §2.5's channel rules are applied, so the UI and
 * the auto-check schedule cannot disagree.
 */
export function decideUpdate(options: {
  currentVersion: string;
  releaseVersion: string;
  channel: UpdateChannel;
  prerelease: boolean;
  minimumSupportedVersion?: string;
}): UpdateDecision {
  const { currentVersion, releaseVersion, channel, prerelease, minimumSupportedVersion } = options;

  if (!isReleaseVisible(releaseVersion, channel, { prerelease })) {
    return { action: 'none', reason: 'channel-mismatch' };
  }

  const comparison = compareVersions(releaseVersion, currentVersion);
  if (comparison < 0) return { action: 'none', reason: 'older-version' };
  if (comparison === 0) {
    // A beta user is on `1.3.0-beta.4` and `1.3.0` ships: the comparison is not
    // equal in that case, but a beta user on `1.3.0` looking at a `1.3.0`
    // prerelease marker *is* equal and gets nothing.
    return { action: 'none', reason: 'same-version' };
  }

  // §5: a release that declares a minimum supported version newer than the
  // *release being offered* is nonsense and must not be installed.
  if (minimumSupportedVersion) {
    const minimum = parseVersion(minimumSupportedVersion);
    if (minimum && compareVersions(releaseVersion, minimumSupportedVersion) < 0) {
      return { action: 'none', reason: 'older-version' };
    }
  }

  return {
    action: 'update',
    reason: currentVersion.includes('-beta') || currentVersion.includes('-alpha') ? 'prerelease-to-release' : 'newer-release',
  };
}

/**
 * The interval between automatic checks, in milliseconds (§3).
 *
 * `startup` means "once at launch, at most once per 6 hours", so it maps to the
 * 6-hour minimum interval; the startup check itself is scheduled separately.
 */
export function autoCheckIntervalMs(setting: 'startup' | '6h' | '1d' | '1w' | 'never'): number | null {
  const HOUR = 60 * 60 * 1000;
  switch (setting) {
    case 'startup':
      return 6 * HOUR;
    case '6h':
      return 6 * HOUR;
    case '1d':
      return 24 * HOUR;
    case '1w':
      return 7 * 24 * HOUR;
    case 'never':
      return null;
  }
}

/** §3: a startup check must run at least 20 s after launch. */
export const STARTUP_CHECK_DELAY_MS = 20_000;

/**
 * Should an automatic check run now?
 *
 * @param now            current time
 * @param lastCheckedAt  epoch ms of the last successful check, or null
 * @param setting        the user's interval choice
 */
export function shouldAutoCheck(options: {
  now: number;
  lastCheckedAt: number | null;
  setting: 'startup' | '6h' | '1d' | '1w' | 'never';
}): boolean {
  const interval = autoCheckIntervalMs(options.setting);
  if (interval === null) return false;
  if (options.lastCheckedAt === null) return true;
  return options.now - options.lastCheckedAt >= interval;
}

/** Human form for the Settings row: `1.2.0 (stable)`, `1.3.0-beta.2 (beta)`. */
export function formatVersionLabel(version: string, channel: UpdateChannel): string {
  return `${version} (${channel})`;
}

/**
 * File-name-safe portion of a version, used for the installer names in §6.1.
 * Prerelease dots survive because the release assets use them verbatim.
 */
export function installerFileName(version: string, kind: 'setup' | 'portable'): string {
  return kind === 'setup'
    ? `Clipwright-Studio-Setup-${version}-x64.exe`
    : `Clipwright-Studio-${version}-x64-portable.exe`;
}
