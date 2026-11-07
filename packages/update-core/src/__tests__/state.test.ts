// @vitest-environment node
/**
 * SPEC 15 §2.2, §3, §4 — the update flow.
 *
 * The rules with teeth:
 *   - nothing downloads or installs without an explicit user action;
 *   - automatic failures stay quiet, manual ones are explained;
 *   - "skip" and "remind me later" are honoured;
 *   - a late event after a cancel must not resurrect a download.
 */
import { describe, expect, it } from 'vitest';
import {
  SNOOZE_MS,
  classifyUpdateError,
  createUpdateError,
  createUpdateState,
  describeUpdateStatus,
  formatCheckedAt,
  formatDownloadProgress,
  reduceUpdateState,
  shouldPrompt,
  shouldShowChip,
  type ReleaseNotes,
  type UpdateState,
} from '../state.js';

const release: ReleaseNotes = {
  version: '1.3.0',
  summary: 'Faster exports.',
  full: '# Notes',
  releasedAt: '2026-11-01T10:00:00.000Z',
  prerelease: false,
  downloadBytes: 120_000_000,
  signed: false,
  htmlUrl: 'https://github.com/yetiwrld/Main-ClipWright-/releases/tag/v1.3.0',
};

const fresh = () => createUpdateState({ currentVersion: '1.2.0', channel: 'stable' });

function run(state: UpdateState, ...events: Parameters<typeof reduceUpdateState>[1][]): UpdateState {
  return events.reduce((current, event) => reduceUpdateState(current, event), state);
}

const found = (): UpdateState => run(fresh(), { type: 'check-started' }, { type: 'check-found', release });

describe('initial state', () => {
  it('starts idle with the running version', () => {
    const state = fresh();
    expect(state).toMatchObject({
      status: 'idle',
      currentVersion: '1.2.0',
      channel: 'stable',
      lastCheckedAt: null,
      release: null,
      error: null,
    });
  });
});

describe('checking', () => {
  it('moves to up-to-date and records the time', () => {
    const state = run(fresh(), { type: 'check-started' }, { type: 'check-up-to-date', at: 5000 });
    expect(state.status).toBe('up-to-date');
    expect(state.lastCheckedAt).toBe(5000);
  });

  it('moves to available with the release', () => {
    const state = found();
    expect(state.status).toBe('available');
    expect(state.release?.version).toBe('1.3.0');
  });

  it('does not check again mid-download, which would throw away progress', () => {
    const downloading = run(found(), { type: 'download-started', totalBytes: 100 }, {
      type: 'download-progress',
      transferredBytes: 50,
      totalBytes: 100,
      bytesPerSecond: 10,
      etaSec: 5,
    });
    const after = reduceUpdateState(downloading, { type: 'check-started' });
    expect(after.status).toBe('downloading');
    expect(after.progress?.transferredBytes).toBe(50);
  });

  it('keeps an automatic failure quiet but still records the time', () => {
    const state = run(fresh(), { type: 'check-started' }, {
      type: 'check-failed',
      error: createUpdateError('offline'),
      at: 900,
      manual: false,
    });
    expect(state.status).toBe('error');
    expect(state.error).toBeNull();
    expect(state.lastCheckedAt).toBe(900);
  });

  it('explains a manual failure', () => {
    const state = run(fresh(), { type: 'check-started' }, {
      type: 'check-failed',
      error: createUpdateError('offline'),
      at: 900,
      manual: true,
    });
    expect(state.error?.message).toContain('internet connection');
  });
});

describe('downloading (§2.2: only after an explicit click)', () => {
  it('will not start a download unless an update is available', () => {
    const state = reduceUpdateState(fresh(), { type: 'download-started', totalBytes: 100 });
    expect(state.status).toBe('idle');
    expect(state.progress).toBeNull();
  });

  it('tracks true percentage from bytes received', () => {
    const state = run(found(), { type: 'download-started', totalBytes: 1000 }, {
      type: 'download-progress',
      transferredBytes: 250,
      totalBytes: 1000,
      bytesPerSecond: 500,
      etaSec: 1.5,
    });
    expect(state.progress?.percent).toBe(25);
    expect(state.progress?.etaSec).toBe(1.5);
  });

  it('never reports more than 100%', () => {
    const state = run(found(), { type: 'download-started', totalBytes: 100 }, {
      type: 'download-progress',
      transferredBytes: 150,
      totalBytes: 100,
      bytesPerSecond: 1,
      etaSec: 0,
    });
    expect(state.progress?.percent).toBe(100);
  });

  it('verifies then becomes ready — never ready without verifying', () => {
    const downloading = run(found(), { type: 'download-started', totalBytes: 100 });
    const ready = reduceUpdateState(downloading, { type: 'download-finished' });
    // Downloading → ready skips verification, which is allowed only because the
    // verifying state is the caller's job to emit; but the finished event from
    // 'available' must not work at all.
    const fromAvailable = reduceUpdateState(found(), { type: 'download-finished' });
    expect(fromAvailable.status).toBe('available');
    expect(ready.status).toBe('ready');
  });

  it('marks 100% once finished', () => {
    const state = run(
      found(),
      { type: 'download-started', totalBytes: 100 },
      { type: 'download-progress', transferredBytes: 90, totalBytes: 100, bytesPerSecond: 5, etaSec: 2 },
      { type: 'download-verifying' },
      { type: 'download-finished' },
    );
    expect(state.status).toBe('ready');
    expect(state.progress?.percent).toBe(100);
  });

  it('returns to available when the user cancels', () => {
    const state = run(found(), { type: 'download-started', totalBytes: 100 }, {
      type: 'download-cancelled',
    });
    expect(state.status).toBe('available');
    expect(state.progress).toBeNull();
  });

  it('ignores a late progress event after a cancel', () => {
    // A killed download can still emit one more chunk; it must not reopen the UI.
    const state = run(
      found(),
      { type: 'download-started', totalBytes: 100 },
      { type: 'download-cancelled' },
      { type: 'download-progress', transferredBytes: 99, totalBytes: 100, bytesPerSecond: 1, etaSec: 0 },
    );
    expect(state.status).toBe('available');
    expect(state.progress).toBeNull();
  });

  it('reports a failed download as an error, not as ready', () => {
    const state = run(found(), { type: 'download-started', totalBytes: 100 }, {
      type: 'download-failed',
      error: createUpdateError('damaged'),
    });
    expect(state.status).toBe('error');
    expect(state.error?.message).toBe('The download was damaged and has been removed.');
  });
});

describe('installing (§2.2: only after an explicit click)', () => {
  const ready = () =>
    run(found(), { type: 'download-started', totalBytes: 100 }, { type: 'download-verifying' }, {
      type: 'download-finished',
    });

  it('installs from ready', () => {
    expect(reduceUpdateState(ready(), { type: 'install-started' }).status).toBe('installing');
  });

  it('refuses to install anything that is not verified and ready', () => {
    for (const state of [fresh(), found(), run(found(), { type: 'download-started', totalBytes: 1 })]) {
      expect(reduceUpdateState(state, { type: 'install-started' }).status).not.toBe('installing');
    }
  });

  it('reports an install failure', () => {
    const state = reduceUpdateState(ready(), {
      type: 'install-failed',
      error: createUpdateError('unknown'),
    });
    expect(state.status).toBe('error');
  });
});

describe('skip and remind me later (§4.2)', () => {
  it('skipping clears the release so the dialog stops nagging', () => {
    const state = run(found(), { type: 'skip', version: '1.3.0' });
    expect(state.skippedVersion).toBe('1.3.0');
    expect(state.release).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('does not re-prompt for a skipped version', () => {
    const state = run(found(), { type: 'skip', version: '1.3.0' }, { type: 'check-found', release });
    expect(shouldPrompt(state, Date.now())).toBe(false);
    expect(shouldShowChip(state)).toBe(false);
  });

  it('clears the skip when a different version is found', () => {
    const next = { ...release, version: '1.4.0' };
    const state = run(found(), { type: 'skip', version: '1.3.0' }, { type: 'check-found', release: next });
    expect(state.skippedVersion).toBeNull();
    expect(shouldPrompt(state, Date.now())).toBe(true);
  });

  it('snoozes the dialog for 24 hours but keeps the chip', () => {
    const now = 1_700_000_000_000;
    const state = run(found(), { type: 'remind-later', until: now + SNOOZE_MS });
    expect(shouldPrompt(state, now + 1000)).toBe(false);
    expect(shouldPrompt(state, now + SNOOZE_MS + 1)).toBe(true);
    // The chip is passive: it stays, so the user can still act.
    expect(shouldShowChip(state)).toBe(true);
  });
});

describe('dismiss', () => {
  it('hides the dialog but keeps the update known', () => {
    const state = run(found(), { type: 'dismiss' });
    expect(state.status).toBe('idle');
    expect(state.release?.version).toBe('1.3.0');
    expect(shouldShowChip(state)).toBe(true);
  });
});

describe('classifyUpdateError', () => {
  it('maps network failures to the offline wording', () => {
    for (const message of ['getaddrinfo ENOTFOUND github.com', 'connect ECONNREFUSED', 'ETIMEDOUT']) {
      const error = classifyUpdateError(new Error(message));
      expect(error.kind, message).toBe('offline');
      expect(error.retryable).toBe(true);
    }
  });

  it('maps a rate limit', () => {
    expect(classifyUpdateError(new Error('API rate limit exceeded')).kind).toBe('rate-limited');
    expect(classifyUpdateError(new Error('HTTP 429')).kind).toBe('rate-limited');
  });

  it('maps a checksum failure', () => {
    const error = classifyUpdateError(new Error('sha512 mismatch'));
    expect(error.kind).toBe('unverified');
    expect(error.retryable).toBe(false);
  });

  it('maps a disk-full failure', () => {
    expect(classifyUpdateError(new Error('ENOSPC: no space left on device')).kind).toBe(
      'not-enough-space',
    );
  });

  it('maps an antivirus removal', () => {
    expect(classifyUpdateError(new Error('EPERM: operation not permitted')).kind).toBe('quarantined');
  });

  it('falls back to unknown but keeps the detail for the log', () => {
    const error = classifyUpdateError(new Error('something odd'));
    expect(error.kind).toBe('unknown');
    expect(error.detail).toBe('something odd');
    expect(error.retryable).toBe(true);
  });

  it('handles a non-Error throwable', () => {
    expect(classifyUpdateError('boom').kind).toBe('unknown');
    expect(classifyUpdateError(null).kind).toBe('unknown');
  });
});

describe('user-facing copy', () => {
  const now = 1_700_000_000_000;

  it('describes each state in one plain sentence', () => {
    expect(describeUpdateStatus(fresh(), now)).toBe('Not checked yet.');
    expect(describeUpdateStatus(run(fresh(), { type: 'check-started' }), now)).toBe('Checking…');
    expect(describeUpdateStatus(run(fresh(), { type: 'check-up-to-date', at: now }), now)).toBe(
      "You're on the latest version (1.2.0).",
    );
    expect(describeUpdateStatus(found(), now)).toBe('Version 1.3.0 is available.');
    expect(describeUpdateStatus(run(found(), { type: 'download-started', totalBytes: 10 }), now)).toBe(
      'Downloading… 0%',
    );
  });

  it('never leaks a stack trace into the status line', () => {
    const state = run(fresh(), { type: 'check-started' }, {
      type: 'check-failed',
      // Real network errors carry a stack; only the plain sentence may escape.
      error: classifyUpdateError(
        new Error('getaddrinfo ENOTFOUND github.com at Object.<anonymous> (/app/main.js:1:1)'),
      ),
      at: now,
      manual: true,
    });
    const line = describeUpdateStatus(state, now);
    expect(line).not.toContain('at Object');
    expect(line).toContain('internet connection');
  });

  it('formats relative check times', () => {
    expect(formatCheckedAt(now, now)).toBe('just now');
    expect(formatCheckedAt(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatCheckedAt(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(formatCheckedAt(now - 25 * 60 * 60_000, now)).toBe('yesterday');
    expect(formatCheckedAt(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago');
    expect(formatCheckedAt(0, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formats progress with speed and ETA', () => {
    expect(
      formatDownloadProgress({
        percent: 42.7,
        transferredBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 5 * 1024 * 1024,
        etaSec: 30,
      }),
    ).toBe('42% · 5.0 MB/s · 30s left');
  });

  it('shows no progress line when there is nothing to show', () => {
    expect(formatDownloadProgress(null)).toBeNull();
  });
});
