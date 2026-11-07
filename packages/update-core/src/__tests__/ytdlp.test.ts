// @vitest-environment node
/**
 * SPEC 15 §9 — the yt-dlp updater.
 *
 * The failure that matters here is "quietly stopped working on one site":
 * a bad binary installed over a good one leaves the user unable to download
 * anything, with no obvious cause. Every rule below exists to make that
 * impossible or, when it happens anyway, reversible.
 */
import { describe, expect, it } from 'vitest';
import {
  YTDLP_CHECK_INTERVAL_MS,
  chooseYtDlpBinary,
  compareYtDlpVersions,
  describeYtDlpStatus,
  evaluateYtDlpUpdate,
  findChecksum,
  parseYtDlpVersion,
  planYtDlpInstall,
  shouldRestoreBundled,
} from '../ytdlp.js';

const SUMS = [
  'aaaa000000000000000000000000000000000000000000000000000000000001  yt-dlp.exe',
  'bbbb000000000000000000000000000000000000000000000000000000000002 *yt-dlp_linux',
  '',
  '# a comment line',
].join('\n');

const NOW = Date.parse('2026-11-07T12:00:00Z');

describe('parseYtDlpVersion', () => {
  it('parses a plain date release', () => {
    expect(parseYtDlpVersion('2026.11.07')).toEqual([2026, 11, 7, 0]);
  });

  it('parses the timestamped form', () => {
    // yt-dlp occasionally ships two releases in a day.
    expect(parseYtDlpVersion('2026.11.07.123456')).toEqual([2026, 11, 7, 12 * 3600 + 34 * 60 + 56]);
  });

  it('rejects something that is not a version', () => {
    expect(parseYtDlpVersion('nightly')).toBeNull();
    expect(parseYtDlpVersion('')).toBeNull();
  });
});

describe('compareYtDlpVersions', () => {
  it('orders by date', () => {
    expect(compareYtDlpVersions('2026.11.07', '2026.11.06')).toBe(1);
    expect(compareYtDlpVersions('2026.11.06', '2026.11.07')).toBe(-1);
    expect(compareYtDlpVersions('2026.11.07', '2026.11.07')).toBe(0);
  });

  it('handles a year boundary, which string comparison would get wrong', () => {
    // "2025.12.31" > "2026.01.01" as strings, and that would pin users to an
    // old binary forever.
    expect(compareYtDlpVersions('2026.01.01', '2025.12.31')).toBe(1);
  });

  it('orders two releases on the same day by timestamp', () => {
    expect(compareYtDlpVersions('2026.11.07.120000', '2026.11.07.090000')).toBe(1);
  });

  it('returns null when either side is unparseable', () => {
    expect(compareYtDlpVersions('2026.11.07', 'whatever')).toBeNull();
  });
});

describe('findChecksum', () => {
  it('finds the line for the asset', () => {
    expect(findChecksum(SUMS, 'yt-dlp.exe')).toBe(
      'aaaa000000000000000000000000000000000000000000000000000000000001',
    );
  });

  it('accepts the binary-mode asterisk', () => {
    expect(findChecksum(SUMS, 'yt-dlp_linux')).toBe(
      'bbbb000000000000000000000000000000000000000000000000000000000002',
    );
  });

  it('returns null for an asset that is not listed', () => {
    // Must not be conflated with "no checks needed".
    expect(findChecksum(SUMS, 'yt-dlp_evil.exe')).toBeNull();
  });

  it('ignores malformed lines rather than matching on them', () => {
    expect(findChecksum('not-a-hash  yt-dlp.exe', 'yt-dlp.exe')).toBeNull();
  });
});

describe('chooseYtDlpBinary', () => {
  const bundled = { version: '2026.10.01', path: '/app/bin/yt-dlp.exe' };

  it('prefers a newer, verified user copy', () => {
    const chosen = chooseYtDlpBinary({
      bundled,
      user: { version: '2026.11.07', path: '/user/bin/yt-dlp.exe', verified: true },
    });
    expect(chosen).toMatchObject({ source: 'user', version: '2026.11.07' });
  });

  it('ignores a verified but older user copy', () => {
    const chosen = chooseYtDlpBinary({
      bundled,
      user: { version: '2026.09.01', path: '/user/bin/yt-dlp.exe', verified: true },
    });
    expect(chosen).toMatchObject({ source: 'bundled' });
  });

  it('ignores an unverified user copy even when it is newer', () => {
    // An unverified file shadowing a good binary is how a machine ends up
    // running something nobody checked.
    const chosen = chooseYtDlpBinary({
      bundled,
      user: { version: '2026.12.01', path: '/user/bin/yt-dlp.exe', verified: false },
    });
    expect(chosen).toMatchObject({ source: 'bundled' });
  });

  it('uses a verified user copy when there is no bundled one', () => {
    const chosen = chooseYtDlpBinary({
      bundled: null,
      user: { version: '2026.11.07', path: '/user/bin/yt-dlp.exe', verified: true },
    });
    expect(chosen).toMatchObject({ source: 'user' });
  });

  it('returns null when there is nothing usable', () => {
    expect(chooseYtDlpBinary({ bundled: null, user: null })).toBeNull();
  });
});

describe('evaluateYtDlpUpdate', () => {
  const latest = {
    version: '2026.11.07',
    assetName: 'yt-dlp.exe',
    downloadUrl: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.07/yt-dlp.exe',
    sumsText: SUMS,
  };

  const base = {
    now: NOW,
    lastCheckedAt: null,
    autoCheckEnabled: true,
    currentVersion: '2026.10.01',
    latest,
  };

  it('offers an update when a newer release exists', () => {
    const result = evaluateYtDlpUpdate(base);
    expect(result).toMatchObject({
      kind: 'available',
      version: '2026.11.07',
      expectedSha256: 'aaaa000000000000000000000000000000000000000000000000000000000001',
    });
  });

  it('says so when already current', () => {
    expect(evaluateYtDlpUpdate({ ...base, currentVersion: '2026.11.07' })).toEqual({
      kind: 'current',
      version: '2026.11.07',
    });
  });

  it('does not go backwards', () => {
    // A user who rolled back to a newer user copy must not be "upgraded" to an
    // older listed release.
    expect(evaluateYtDlpUpdate({ ...base, currentVersion: '2026.12.01' })).toMatchObject({
      kind: 'current',
    });
  });

  it('waits a week between automatic checks (7 days)', () => {
    expect(YTDLP_CHECK_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const result = evaluateYtDlpUpdate({
      ...base,
      lastCheckedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    });
    expect(result.kind).toBe('not-due');
  });

  it('checks again once the week is up', () => {
    const result = evaluateYtDlpUpdate({
      ...base,
      lastCheckedAt: NOW - YTDLP_CHECK_INTERVAL_MS - 1000,
    });
    expect(result.kind).toBe('available');
  });

  it('checks immediately when automatic checks are off', () => {
    // Automatic off means "do not do this in the background", not "never".
    const result = evaluateYtDlpUpdate({
      ...base,
      autoCheckEnabled: false,
      lastCheckedAt: NOW - 1000,
    });
    expect(result.kind).toBe('available');
  });

  it('honours the pin for locked-down machines', () => {
    const result = evaluateYtDlpUpdate({ ...base, updatesBlocked: true });
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('checks the pin before the schedule', () => {
    const result = evaluateYtDlpUpdate({ ...base, updatesBlocked: true, lastCheckedAt: NOW - 1000 });
    expect(result.kind).toBe('blocked');
  });

  it('refuses to offer an asset with no checksum', () => {
    const result = evaluateYtDlpUpdate({
      ...base,
      latest: { ...latest, assetName: 'yt-dlp_unlisted.exe' },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('not listed');
      expect(result.message).toContain('came with Clipwright');
    }
  });

  it('reports a release it could not read, and says what still works', () => {
    const result = evaluateYtDlpUpdate({ ...base, latest: null });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('Link downloads use the version that came with Clipwright');
    }
  });

  it('offers an install when no binary exists at all', () => {
    const result = evaluateYtDlpUpdate({ ...base, currentVersion: null });
    expect(result.kind).toBe('available');
  });

  it('refuses when the versions cannot be compared', () => {
    const result = evaluateYtDlpUpdate({ ...base, currentVersion: 'built-from-source' });
    expect(result.kind).toBe('error');
  });
});

describe('planYtDlpInstall', () => {
  const expected = 'aaaa000000000000000000000000000000000000000000000000000000000001';

  it('approves a download whose digest matches', () => {
    const plan = planYtDlpInstall({
      actualSha256: expected,
      expectedSha256: expected,
      hasExisting: true,
    });
    expect(plan.ok).toBe(true);
    expect(plan.keepBackup).toBe(true);
  });

  it('does not keep a backup when nothing is being replaced', () => {
    const plan = planYtDlpInstall({
      actualSha256: expected,
      expectedSha256: expected,
      hasExisting: false,
    });
    expect(plan.keepBackup).toBe(false);
  });

  it('refuses a mismatch, in words that say what still works', () => {
    const plan = planYtDlpInstall({
      actualSha256: 'ffff000000000000000000000000000000000000000000000000000000000000',
      expectedSha256: expected,
      hasExisting: true,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('did not match its checksum');
    expect(plan.reason).toContain('came with Clipwright');
  });

  it('never keeps a backup for a refused download', () => {
    // This is the assertion that protects the working binary: if keepBackup were
    // true here, the caller could move the good file aside and then fail.
    const plan = planYtDlpInstall({
      actualSha256: 'ffff000000000000000000000000000000000000000000000000000000000000',
      expectedSha256: expected,
      hasExisting: true,
    });
    expect(plan.keepBackup).toBe(false);
  });

  it('compares digests case-insensitively', () => {
    const plan = planYtDlpInstall({
      actualSha256: expected.toUpperCase(),
      expectedSha256: expected,
      hasExisting: false,
    });
    expect(plan.ok).toBe(true);
  });
});

describe('shouldRestoreBundled', () => {
  it('agrees when both exist', () => {
    expect(shouldRestoreBundled({ userExists: true, bundledExists: true })).toEqual({ ok: true });
  });

  it('says so when there is nothing to remove', () => {
    expect(shouldRestoreBundled({ userExists: false, bundledExists: true }).ok).toBe(false);
  });

  it('refuses to remove the only working binary', () => {
    const result = shouldRestoreBundled({ userExists: true, bundledExists: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Reinstall');
  });
});

describe('describeYtDlpStatus', () => {
  it('reports a missing binary', () => {
    expect(describeYtDlpStatus({ version: null, source: null, lastCheckedAt: null, now: NOW })).toContain(
      'not found',
    );
  });

  it('distinguishes bundled from downloaded', () => {
    expect(describeYtDlpStatus({ version: '2026.11.07', source: 'bundled', lastCheckedAt: null, now: NOW })).toContain(
      'bundled with Clipwright',
    );
    expect(describeYtDlpStatus({ version: '2026.11.07', source: 'user', lastCheckedAt: null, now: NOW })).toContain(
      'downloaded separately',
    );
  });

  it('counts days since the last check in plain words', () => {
    const threeDays = NOW - 3 * 24 * 60 * 60 * 1000;
    expect(describeYtDlpStatus({ version: '1', source: 'user', lastCheckedAt: threeDays, now: NOW })).toContain(
      '3 days ago',
    );
  });

  it('uses singular for yesterday', () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    expect(describeYtDlpStatus({ version: '1', source: 'user', lastCheckedAt: yesterday, now: NOW })).toContain(
      'yesterday',
    );
  });
});
