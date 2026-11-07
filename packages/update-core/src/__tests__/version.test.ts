// @vitest-environment node
/**
 * SPEC 15 §2.5, §3, §5 — version rules, channels and the auto-check schedule.
 */
import { describe, expect, it } from 'vitest';
import {
  STARTUP_CHECK_DELAY_MS,
  autoCheckIntervalMs,
  compareVersions,
  decideUpdate,
  formatVersionLabel,
  installerFileName,
  isNewerVersion,
  isReleaseVisible,
  isValidVersion,
  parseVersion,
  shouldAutoCheck,
} from '../version.js';

describe('parseVersion', () => {
  it('parses a plain release', () => {
    expect(parseVersion('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('1.2.3')?.prerelease).toBeUndefined();
  });

  it('parses a beta tag with its counter', () => {
    const parsed = parseVersion('1.3.0-beta.2');
    expect(parsed?.prerelease).toBe('beta.2');
    expect(parsed?.prereleaseNumber).toBe(2);
  });

  it('tolerates a leading v, as tags carry one', () => {
    expect(parseVersion('v2.0.0')?.major).toBe(2);
  });

  it('rejects anything that is not semver rather than guessing', () => {
    for (const bad of ['', 'latest', '1.2', '1.2.3.4', '1.2.x', 'v', 'nightly-2024']) {
      expect(parseVersion(bad), bad).toBeNull();
      expect(isValidVersion(bad), bad).toBe(false);
    }
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('sorts a prerelease below its release', () => {
    expect(compareVersions('1.3.0-beta.2', '1.3.0')).toBe(-1);
    expect(compareVersions('1.3.0', '1.3.0-beta.9')).toBe(1);
  });

  it('orders betas by their counter, not lexically', () => {
    // Lexical order would put beta.10 before beta.9.
    expect(compareVersions('1.3.0-beta.9', '1.3.0-beta.10')).toBe(-1);
    expect(compareVersions('1.3.0-beta.10', '1.3.0-beta.2')).toBe(1);
  });

  it('throws on input it cannot judge instead of silently saying equal', () => {
    // A silent 0 here would read as "no update" for an unparseable version.
    expect(() => compareVersions('1.2.3', 'garbage')).toThrow(/Not a version/);
  });

  it('isNewerVersion agrees with compare', () => {
    expect(isNewerVersion('1.3.0', '1.2.9')).toBe(true);
    expect(isNewerVersion('1.2.9', '1.3.0')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });
});

describe('isReleaseVisible', () => {
  it('hides prereleases from stable users', () => {
    expect(isReleaseVisible('1.3.0-beta.1', 'stable', { prerelease: true })).toBe(false);
    expect(isReleaseVisible('1.3.0', 'stable', { prerelease: false })).toBe(true);
  });

  it('shows everything to beta users', () => {
    expect(isReleaseVisible('1.3.0-beta.1', 'beta', { prerelease: true })).toBe(true);
    expect(isReleaseVisible('1.3.0', 'beta', { prerelease: false })).toBe(true);
  });
});

describe('decideUpdate', () => {
  const base = { channel: 'stable' as const, prerelease: false };

  it('offers a newer release', () => {
    expect(decideUpdate({ ...base, currentVersion: '1.2.0', releaseVersion: '1.3.0' })).toEqual({
      action: 'update',
      reason: 'newer-release',
    });
  });

  it('offers nothing for the same version', () => {
    expect(decideUpdate({ ...base, currentVersion: '1.3.0', releaseVersion: '1.3.0' })).toEqual({
      action: 'none',
      reason: 'same-version',
    });
  });

  it('refuses a downgrade (§5 downgrade protection)', () => {
    expect(decideUpdate({ ...base, currentVersion: '1.3.0', releaseVersion: '1.2.0' })).toEqual({
      action: 'none',
      reason: 'older-version',
    });
  });

  it('ignores a prerelease on the stable channel', () => {
    expect(
      decideUpdate({ ...base, currentVersion: '1.2.0', releaseVersion: '1.3.0-beta.1', prerelease: true }),
    ).toEqual({ action: 'none', reason: 'channel-mismatch' });
  });

  it('offers the stable release to a beta user on a beta build', () => {
    // Beta users must not be stranded on a prerelease once the release ships.
    expect(
      decideUpdate({
        channel: 'beta',
        prerelease: false,
        currentVersion: '1.3.0-beta.4',
        releaseVersion: '1.3.0',
      }),
    ).toEqual({ action: 'update', reason: 'prerelease-to-release' });
  });

  it('refuses a release older than its own declared minimum', () => {
    expect(
      decideUpdate({
        ...base,
        currentVersion: '1.2.0',
        releaseVersion: '1.3.0',
        minimumSupportedVersion: '1.4.0',
      }),
    ).toEqual({ action: 'none', reason: 'older-version' });
  });

  it('allows a release that satisfies its own minimum', () => {
    expect(
      decideUpdate({
        ...base,
        currentVersion: '1.2.0',
        releaseVersion: '1.5.0',
        minimumSupportedVersion: '1.4.0',
      }).action,
    ).toBe('update');
  });
});

describe('autoCheckIntervalMs', () => {
  it('caps startup checks at the 6-hour minimum', () => {
    expect(autoCheckIntervalMs('startup')).toBe(6 * 60 * 60 * 1000);
  });

  it('maps each interval', () => {
    expect(autoCheckIntervalMs('6h')).toBe(6 * 60 * 60 * 1000);
    expect(autoCheckIntervalMs('1d')).toBe(24 * 60 * 60 * 1000);
    expect(autoCheckIntervalMs('1w')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('never checks when the user switched it off', () => {
    expect(autoCheckIntervalMs('never')).toBeNull();
  });
});

describe('shouldAutoCheck', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  it('checks the first time ever', () => {
    expect(shouldAutoCheck({ now, lastCheckedAt: null, setting: '1d' })).toBe(true);
  });

  it('waits out the interval', () => {
    expect(shouldAutoCheck({ now, lastCheckedAt: now - 23 * HOUR, setting: '1d' })).toBe(false);
    expect(shouldAutoCheck({ now, lastCheckedAt: now - 25 * HOUR, setting: '1d' })).toBe(true);
  });

  it('honours "never" even when long overdue', () => {
    expect(shouldAutoCheck({ now, lastCheckedAt: now - 90 * 24 * HOUR, setting: 'never' })).toBe(false);
  });

  it('does not check twice in a day when set to startup', () => {
    // "startup" means at launch, but never more than once per 6 h (§3).
    expect(shouldAutoCheck({ now, lastCheckedAt: now - 2 * HOUR, setting: 'startup' })).toBe(false);
    expect(shouldAutoCheck({ now, lastCheckedAt: now - 7 * HOUR, setting: 'startup' })).toBe(true);
  });

  it('treats a clock moved backwards as "not due" rather than spam-checking', () => {
    expect(shouldAutoCheck({ now, lastCheckedAt: now + 5 * HOUR, setting: '1d' })).toBe(false);
  });
});

describe('label helpers', () => {
  it('delays the startup check by at least 20 s', () => {
    expect(STARTUP_CHECK_DELAY_MS).toBeGreaterThanOrEqual(20_000);
  });

  it('formats the version with its channel', () => {
    expect(formatVersionLabel('1.2.0', 'stable')).toBe('1.2.0 (stable)');
    expect(formatVersionLabel('1.3.0-beta.2', 'beta')).toBe('1.3.0-beta.2 (beta)');
  });

  it('names the installer artefacts as the spec requires', () => {
    expect(installerFileName('1.3.0', 'setup')).toBe('Clipwright-Studio-Setup-1.3.0-x64.exe');
    expect(installerFileName('1.3.0', 'portable')).toBe('Clipwright-Studio-1.3.0-x64-portable.exe');
  });
});
