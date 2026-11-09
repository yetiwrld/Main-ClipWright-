// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';

/**
 * The cached-frame stand-in (SPEC 10 §5).
 *
 * These drive the pane through the `<video>` element's own `seeking`/`seeked` events,
 * because that is what the layer listens to — asserting the policy in isolation would
 * prove the rule and not that the element is wired to it.
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

/** jsdom has no media element; the pane only needs these two methods. */
function stubMedia(): void {
  const video = document.querySelector('video');
  if (!video) throw new Error('the pane rendered no video element');
  Object.defineProperty(video, 'paused', { configurable: true, get: () => true });
  Object.defineProperty(video, 'play', {
    configurable: true,
    value: () => Promise.resolve(),
  });
  Object.defineProperty(video, 'pause', { configurable: true, value: () => undefined });
}

function still(): HTMLElement | null {
  return screen.queryByTestId('preview-scrub-still');
}

beforeEach(() => {
  playheadStore.set(1_000_000);
});

afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('the scrub still while a seek is in flight', () => {
  it('mounts on the element\'s seeking event, and not before', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    expect(still()).toBeNull();

    fireEvent(document.querySelector('video')!, new Event('seeking'));
    expect(still()).not.toBeNull();
  });

  it('asks for the frame under the playhead, on the cache grid', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    fireEvent(document.querySelector('video')!, new Event('seeking'));

    // 1 s into a clip whose in-point is 0, so the cell boundary is 1.0 s.
    expect(still()?.getAttribute('src')).toBe('clipwright-media://scrub/media-a/1000000');
  });

  it('stays hidden until its own picture has decoded', () => {
    /*
      Mount and visibility are deliberately separate. The element has to be in the tree to
      load at all, so gating the mount on the load would mean it never loads — the stand-in
      would never appear anywhere. It is painted only once `load` names the URL it holds.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    fireEvent(document.querySelector('video')!, new Event('seeking'));

    const img = still();
    expect(img).not.toBeNull();
    expect(img!.getAttribute('data-ready')).toBe('false');
    expect(img!.style.opacity).toBe('0');

    fireEvent.load(img!);
    expect(still()!.getAttribute('data-ready')).toBe('true');
    expect(still()!.style.opacity).toBe('1');
  });

  it('disappears when the seek settles, because the element is sharper', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    const video = document.querySelector('video')!;
    fireEvent(video, new Event('seeking'));
    expect(still()).not.toBeNull();

    fireEvent(video, new Event('seeked'));
    expect(still()).toBeNull();
  });


  it('does not credit a late load of the old picture to the new one', () => {
    /*
      The failure this guards is subtle and would be invisible in a screenshot: a decode
      started for cell A finishes *after* the playhead moved into cell B. The load handler
      closes over the render's URL, so without care it would mark B as ready while the
      element is still showing A — and the user would see the frame they scrubbed past,
      presented as the frame they are on.

      Asserted against the element's own `src`, which is what the handler records: a stale
      load names A, and A is no longer the wanted URL, so nothing becomes visible.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    fireEvent(document.querySelector('video')!, new Event('seeking'));

    const first = still()!;
    expect(first.getAttribute('src')).toBe('clipwright-media://scrub/media-a/1000000');

    // Move into the next cell before the first picture ever decodes.
    act(() => playheadStore.set(1_250_000));
    const second = still()!;
    expect(second.getAttribute('src')).toBe('clipwright-media://scrub/media-a/1200000');

    // Now the *old* picture's decode completes. The handler reads the element it is
    // attached to, and that element carries A — which must not satisfy B.
    fireEvent.load(first);
    expect(still()!.getAttribute('data-ready')).toBe('false');
    expect(still()!.style.opacity).toBe('0');

    // The new picture's own load is the one that shows.
    fireEvent.load(second);
    expect(still()!.getAttribute('data-ready')).toBe('true');
  });

  it('never covers a playing picture', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    // Play, then seek: a running element is the only thing that can show motion.
    fireEvent.click(screen.getByLabelText(/play/i));
    fireEvent(document.querySelector('video')!, new Event('seeking'));
    expect(still()).toBeNull();
  });

  it('asks for a different frame when the playhead crosses into the next cell', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    stubMedia();
    fireEvent(document.querySelector('video')!, new Event('seeking'));
    expect(still()?.getAttribute('src')).toBe('clipwright-media://scrub/media-a/1000000');

    // Load the first picture, so the layer is holding a *ready* still.
    fireEvent.load(still()!);
    expect(still()!.getAttribute('data-ready')).toBe('true');

    // Playhead to 1.25 s: the cell boundary is now 1.2 s, so a new file is asked for.
    act(() => playheadStore.set(1_250_000));
    expect(still()?.getAttribute('src')).toBe('clipwright-media://scrub/media-a/1200000');
    /*
      The picture that was ready belongs to the old instant, so it must be disowned the
      moment the URL changes. An `<img>` keeps painting its previous frame after `src`
      changes, so without the reset the old cell's frame would sit over the video until the
      new one decoded — showing the user a picture they had already scrubbed past.
    */
    expect(still()!.getAttribute('data-ready')).toBe('false');
  });
});
