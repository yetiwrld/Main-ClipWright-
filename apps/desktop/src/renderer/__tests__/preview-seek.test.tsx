// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';

/**
 * Seeks are the preview's bottleneck (SPEC 09 §23). These tests watch the one thing
 * that changed: how many times `currentTime` is assigned while the playhead moves.
 */

function makeState(): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));
  const item = {
    id: 'a',
    trackId: mainTrack.id,
    type: 'video' as const,
    mediaId: 'media-a',
    startUs: 0,
    durationUs: 10_000_000,
    sourceInUs: 0,
    transform: {},
    crop: {},
    keyframes: {},
  };
  tracks.find((track) => track.id === mainTrack.id)!.itemIds.push('a');
  return { ...base, tracks, items: { a: item } } as unknown as TimelineState;
}

/**
 * Counts assignments to `currentTime` on the pane's `<video>`.
 *
 * jsdom does not implement `HTMLMediaElement` at all, so the property is installed on
 * the element itself once it is in the document — which is also more honest than a
 * prototype patch, since it can only affect the video this test is watching.
 */
function trackSeeks(): { seen: number[]; restore: () => void } {
  const seen: number[] = [];
  const video = document.querySelector('video');
  if (!video) throw new Error('the pane rendered no video element');
  const own = Object.getOwnPropertyDescriptor(video, 'currentTime');
  let stored = 0;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => stored,
    set: (value: number) => {
      seen.push(value);
      stored = value;
    },
  });
  return {
    seen,
    restore: () => {
      if (own) Object.defineProperty(video, 'currentTime', own);
      else delete (video as unknown as Record<string, unknown>).currentTime;
    },
  };
}

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('the preview follows the playhead without thrashing the element', () => {
  it('issues one seek for a burst of playhead movement, not one per event', () => {
    /*
      The bug, measured. A scrub sets the playhead on every pointer move; the old code
      assigned `currentTime` for each one that drifted past its threshold, and each
      assignment aborts the seek before it. The coalescer holds only the newest target,
      so a 40-event burst costs one seek until the element reports it has settled.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    const { seen, restore } = trackSeeks();
    try {

      for (let step = 1; step <= 40; step += 1) {
        playheadStore.set(step * 100_000);
      }

      expect(seen).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('lands on the newest position once the element settles', () => {
    /*
      Converging matters as much as coalescing. Dropping the events entirely (a
      debounce) would leave the picture wherever the element happened to be; the
      coalescer must finish on the last target the playhead asked for.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    const { seen, restore } = trackSeeks();
    try {
      for (let step = 1; step <= 10; step += 1) playheadStore.set(step * 200_000);

      const video = document.querySelector('video')!;
      // The element reports the seek is over, which releases the held target.
      video.dispatchEvent(new Event('seeked'));

      // 10 × 200 ms is 2 seconds into the source, which starts at zero.
      expect(seen.at(-1)).toBeCloseTo(2, 6);
    } finally {
      restore();
    }
  });

  it('does not seek for a drift smaller than half a frame while paused', () => {
    /*
      Half a frame is where a still becomes visibly the wrong still. Below it a seek
      would decode a frame the user cannot distinguish from the one on screen.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    const { seen, restore } = trackSeeks();
    try {
      // 10 ms is under half of a 33 ms frame.
      playheadStore.set(10_000);
      expect(seen).toHaveLength(0);
      // 50 ms is over it.
      playheadStore.set(60_000);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('tolerates drift while the element is actually playing', () => {
    /*
      jsdom never plays a video, so the paused path is what the tests above exercise by
      default. The playing path is the one where a seek is a *visible hitch*, so it is
      worth forcing: with `paused` false, a drift inside the threshold must not seek.

      `paused` is read-only in the DOM, so it is installed on the element the same way
      `currentTime` is — the point is the threshold's input, not the real playback
      state.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    const { seen, restore } = trackSeeks();
    try {
      // 100 ms: past the paused threshold (17 ms) and inside the playing one (200 ms).
      playheadStore.set(100_000);
      expect(seen).toHaveLength(0);
      // Past the playing threshold by a wide margin: corrected.
      playheadStore.set(500_000);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});
