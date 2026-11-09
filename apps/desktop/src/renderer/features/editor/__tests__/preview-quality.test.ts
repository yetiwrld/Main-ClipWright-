// @vitest-environment jsdom
/**
 * What the preview is playing, and what it says about it (SPEC 10 §5.1).
 *
 * §5.1's rule is *"never silent"*: a preview that is not showing the real image has to admit it.
 * The tests below are mostly about when saying **nothing** is the right answer, which is the half
 * a naive implementation gets wrong — a chip that is always on is a chip nobody reads, and one
 * that appears for a still image is a promise about a file that is never coming.
 */

import { describe, expect, it } from 'vitest';

import {
  previewQualityChip,
  previewSourceChoice,
  type PreviewMediaLike,
  mediaAwaitingProxy,
} from '../preview-quality.js';

const ON = { useProxies: true };
const OFF = { useProxies: false };
/** A live proxy job for a media id, which is what main actually reports (SPEC 04 §6.2). */
const proxyJob = (mediaId: string, status = 'running') =>
  ({ useProxies: true, jobs: [{ type: 'proxy', mediaId, status }] }) as const;

/** A video that has a proxy on disk. */
const WITH_PROXY: PreviewMediaLike = { kind: 'video', proxyPath: '/derived/p.mp4' };
/**
 * A video the pipeline is transcoding right now.
 *
 * The signal is a live `proxy` job rather than a flag on the record — the record has no such
 * flag, and inventing one would have been a chip that could never appear in the running app.
 */
const PENDING: PreviewMediaLike = { id: 'm1', kind: 'video' };
const PENDING_OPTIONS = proxyJob('m1');
/** An ordinary 1080p H.264 clip, which `needsProxy` correctly declined. */
const NOTHING_NEEDED: PreviewMediaLike = { kind: 'video' };
/** An image: nothing to transcode. */
const IMAGE: PreviewMediaLike = { kind: 'image' };

describe('which file the preview plays', () => {
  it('plays the proxy when there is one', () => {
    expect(previewSourceChoice(WITH_PROXY, ON)).toStrictEqual({ kind: 'proxy', reason: 'proxy' });
  });

  it('plays the original while the proxy is being made', () => {
    // §04 §6.3: the editor must work *before* the proxy exists, with a visible chip.
    expect(previewSourceChoice(PENDING, PENDING_OPTIONS)).toStrictEqual({
      kind: 'original',
      reason: 'proxy-pending',
    });
  });

  it('plays the original when the user has switched proxies off', () => {
    // Even with a proxy sitting on disk, the setting wins: it exists to be obeyed.
    expect(previewSourceChoice(WITH_PROXY, OFF)).toStrictEqual({
      kind: 'original',
      reason: 'proxies-off',
    });
  });

  it('never plays a proxy for something that is not video', () => {
    /*
      Only video gets a proxy. This is checked before the setting, because the reason should be
      the honest one: a user who has proxies off and selects an image should not be told their
      image "needs a proxy" — it never will.
    */
    expect(previewSourceChoice(IMAGE, ON)).toStrictEqual({
      kind: 'original',
      reason: 'not-a-video',
    });
    expect(previewSourceChoice(IMAGE, OFF)).toStrictEqual({
      kind: 'original',
      reason: 'not-a-video',
    });
  });

  it('treats a missing record as "not a video" rather than throwing', () => {
    // The preview renders before the media list arrives, and a selected clip can outlive its
    // media. Neither is an error worth a crash.
    expect(previewSourceChoice(undefined, ON)).toStrictEqual({
      kind: 'original',
      reason: 'not-a-video',
    });
  });

  it('collapses a null proxy and an absent one to the same answer', () => {
    /*
      The record keeps the distinction (`absent` = predates proxies, `null` = declined), and the
      media pipeline cares about it. The preview does not: both mean there is no file to play.
    */
    const declined: PreviewMediaLike = { kind: 'video', proxyPath: null };
    expect(previewSourceChoice(declined, ON).kind).toBe('original');
    expect(previewSourceChoice(NOTHING_NEEDED, ON).kind).toBe('original');
  });

  it('prefers a real proxy over a pending one', () => {
    // A record can briefly carry both: the file landed but the pending flag has not cleared.
    const both: PreviewMediaLike = { id: 'm1', kind: 'video', proxyPath: '/p.mp4' };
    expect(previewSourceChoice(both, proxyJob('m1')).kind).toBe('proxy');
  });
});

describe('what the preview says about it', () => {
  it('says nothing while a proxy is actually playing', () => {
    // §5.1's chip exists to report a degraded or pending preview. On the good path there is
    // nothing to report, and a permanent "using proxy" badge is noise.
    expect(previewQualityChip(WITH_PROXY, ON)).toBeNull();
  });

  it('uses the spec\'s wording while the proxy is being prepared', () => {
    const chip = previewQualityChip(PENDING, PENDING_OPTIONS);
    expect(chip).not.toBeNull();
    // §5.1 and §04 §6.3 both name this string; a test pins it so a reword is deliberate.
    expect(chip!.label).toBe('Preparing smoother preview…');
    expect(chip!.tone).toBe('info');
  });

  it('admits when the user has switched proxies off', () => {
    /*
      This is the case a silent implementation gets wrong. Nothing is broken — the user asked
      for the original — but the preview is playing a heavy file, and without a chip the slow
      scrub looks like a bug rather than a setting.
    */
    const chip = previewQualityChip(WITH_PROXY, OFF);
    expect(chip).not.toBeNull();
    expect(chip!.tone).toBe('quality');
    expect(chip!.detail).toContain('switched off');
  });

  it('says nothing for a clip that needs no proxy at all', () => {
    /*
      The common case: an ordinary 1080p H.264 file, which `needsProxy` declines. A chip here
      would be on screen permanently, for every ordinary project, reporting a non-event.
    */
    expect(previewQualityChip(NOTHING_NEEDED, ON)).toBeNull();
  });

  it('says nothing over a still image', () => {
    // An image has no proxy coming, so "preparing" would be a lie and "original" meaningless.
    expect(previewQualityChip(IMAGE, ON)).toBeNull();
    expect(previewQualityChip(IMAGE, OFF)).toBeNull();
  });

  it('carries a longer explanation for the chip\'s tooltip', () => {
    // The label has to fit in a toolbar; the detail is where the "why" lives, and every chip
    // that has a label has to have one — a chip with no explanation is a riddle.
    for (const media of [PENDING, WITH_PROXY]) {
      for (const options of [PENDING_OPTIONS, OFF]) {
        const chip = previewQualityChip(media, options);
        if (chip) expect(chip.detail.length).toBeGreaterThan(chip.label.length);
      }
    }
  });

  it('never reports a chip whose file is the one playing', () => {
    /*
      The invariant that ties the two functions together: a chip is only ever shown for a reason
      that is *not* 'proxy'. Otherwise the preview would report degradation while showing the
      good file, which is worse than saying nothing.
    */
    for (const media of [WITH_PROXY, PENDING, NOTHING_NEEDED, IMAGE, undefined]) {
      for (const options of [PENDING_OPTIONS, ON, OFF]) {
        const chip = previewQualityChip(media, options);
        if (chip) expect(previewSourceChoice(media, options).reason).not.toBe('proxy');
      }
    }
  });
});

describe('a proxy job is the only evidence a proxy is coming', () => {
  it('ignores a job for a different media id', () => {
    // Two clips importing at once; only the one being transcoded is "preparing".
    const other = previewSourceChoice(PENDING, proxyJob('m2'));
    expect(other.reason).toBe('no-proxy');
  });

  it('ignores a job that is queued for something else entirely', () => {
    // A probe or an export says nothing about proxies.
    expect(
      previewSourceChoice(PENDING, {
        useProxies: true,
        jobs: [{ type: 'export', mediaId: 'm1', status: 'running' }],
      }).reason,
    ).toBe('no-proxy');
  });

  it('stops promising once the job has failed or been cancelled', () => {
    /*
      The case an "is there a proxy job?" test gets wrong. A failed proxy job leaves `proxyPath`
      null forever, so "Preparing smoother preview…" would be a promise about a file that is
      never coming — and one the user would watch indefinitely.
    */
    for (const status of ['failed', 'cancelled'] as const) {
      expect(previewSourceChoice(PENDING, proxyJob('m1', status)).reason).toBe('no-proxy');
      expect(previewQualityChip(PENDING, proxyJob('m1', status))).toBeNull();
    }
  });

  it('treats a finished job as no longer in flight', () => {
    // `done` without a `proxyPath` means the pipeline made one and something removed it; either
    // way there is nothing to wait for.
    expect(previewSourceChoice(PENDING, proxyJob('m1', 'done')).reason).toBe('no-proxy');
  });

  it('still reports the original while a queued job waits its turn', () => {
    // Queued is the long state on a cold import, and the slow scrub is already happening.
    expect(previewSourceChoice(PENDING, proxyJob('m1', 'queued')).reason).toBe('proxy-pending');
  });
});

describe('the poll only runs while a proxy is actually outstanding', () => {
  it('watches when a file needs a proxy and has none', () => {
    expect(mediaAwaitingProxy([{ id: 'm1', kind: 'video', needsProxy: true }])).toBe(true);
  });

  it('stops watching the moment the proxy arrives', () => {
    // The termination condition: without this the editor would poll forever on every project.
    expect(
      mediaAwaitingProxy([{ id: 'm1', kind: 'video', needsProxy: true, proxyPath: '/p.mp4' }]),
    ).toBe(false);
  });

  it('does not watch a file the pipeline declined to transcode', () => {
    // An ordinary 1080p H.264 import: `needsProxy` false means no job will ever be created.
    expect(mediaAwaitingProxy([{ id: 'm1', kind: 'video', needsProxy: false }])).toBe(false);
  });

  it('does not watch an empty or absent library', () => {
    expect(mediaAwaitingProxy([])).toBe(false);
    expect(mediaAwaitingProxy(undefined)).toBe(false);
  });

  it('keeps watching while any one file is still waiting', () => {
    expect(
      mediaAwaitingProxy([
        { id: 'm1', kind: 'video', needsProxy: true, proxyPath: '/a.mp4' },
        { id: 'm2', kind: 'video', needsProxy: true },
      ]),
    ).toBe(true);
  });
});
