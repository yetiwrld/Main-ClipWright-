// @vitest-environment jsdom
/**
 * SPEC 10 §8.4–8.6 — the preview has to show what the inspector edited.
 *
 * The crop, scale and rotation fields were writing values into the timeline that
 * nothing drew, so a user could crop a clip to nothing and see no change. These
 * tests pin the other half of that contract: the values reach the DOM the video
 * lives in.
 *
 * jsdom does no layout, so the assertions are about the styles that carry the
 * geometry (transform, the border box's aspect) rather than rendered pixels — the
 * arithmetic itself is covered in `packages/compositor/__tests__/item-geometry`.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';

function makeState(overrides: Record<string, unknown> = {}): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const trackId = base.tracks.find((track) => track.kind === 'video')!.id;
  const item = {
    id: 'vid-1',
    trackId,
    type: 'video' as const,
    mediaId: 'media-1',
    startUs: 0,
    durationUs: 5_000_000,
    sourceInUs: 0,
    transform: {},
    crop: {},
    ...overrides,
  };
  return {
    ...base,
    tracks: base.tracks.map((track) =>
      track.id === trackId ? { ...track, itemIds: [item.id] } : track,
    ),
    items: { [item.id]: item },
  } as unknown as TimelineState;
}

const transformOf = (testId: string) =>
  (screen.getByTestId(testId) as HTMLElement).style.transform;

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('PreviewPane geometry', () => {
  it('draws the item', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    expect(screen.getByTestId('preview-item')).toBeTruthy();
  });

  it('applies the crop to the video box instead of showing the whole frame', () => {
    render(<PreviewPane state={makeState({ crop: { left: 0.25, right: 0.25 } })} fps={30} />);
    const fit = screen.getByTestId('preview-item-fit') as HTMLElement;
    // The box takes the *cropped* shape: 0.5 × sourceAspect wide by 1 × sourceAspect
    // tall. Before metadata arrives the source aspect is the canvas's (1080×1920),
    // so the box is 0.28125 / 1 — the crop halved the width, nothing else.
    const ratio = fit.style.aspectRatio.replace(/\s/g, '');
    const [w, h] = ratio.split('/').map(Number);
    expect(w! / h!).toBeCloseTo(0.5 * (1080 / 1920), 4);
  });

  it('moves a scaled item', () => {
    render(<PreviewPane state={makeState({ transform: { scaleX: 1.5, scaleY: 1.5 } })} fps={30} />);
    expect(transformOf('preview-item-fit')).toContain('scale(1.5, 1.5)');
  });

  it('rotates a rotated item', () => {
    render(<PreviewPane state={makeState({ transform: { rotation: 30 } })} fps={30} />);
    expect(transformOf('preview-item-fit')).toContain('rotate(30deg)');
  });

  it('mirrors a flipped item', () => {
    // A flip is a negative scale on its axis; drawing it as a separate CSS
    // `scaleX(-1)` would be a second transform that the next style write drops.
    render(<PreviewPane state={makeState({ transform: { flipH: true } })} fps={30} />);
    expect(transformOf('preview-item-fit')).toContain('scale(-1, 1)');
  });

  it('offsets the item by a fraction of the frame', () => {
    render(<PreviewPane state={makeState({ transform: { x: 0.1, y: -0.05 } })} fps={30} />);
    expect(transformOf('preview-item')).toContain('translate(10%, -5%)');
  });

  it('honours a legacy framing scale', () => {
    // `07 §6.2` stores framing as `transform.scale`; a clip created from a moment
    // must open at the size it was framed at.
    render(<PreviewPane state={makeState({ transform: { scale: 1.4 } })} fps={30} />);
    expect(transformOf('preview-item-fit')).toContain('scale(1.4, 1.4)');
  });

  it('still draws the item when it hangs off the frame', () => {
    // Offsets are clamped nowhere: a reframed clip can legitimately sit partly
    // outside the canvas, and clipping it is the canvas's job (overflow: hidden).
    render(<PreviewPane state={makeState({ transform: { x: -0.4 } })} fps={30} />);
    expect(transformOf('preview-item')).toContain('translate(-40%');
  });
});
