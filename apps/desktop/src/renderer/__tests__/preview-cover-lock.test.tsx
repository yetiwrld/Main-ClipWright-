// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';

/**
 * The fill lock, end to end (SPEC 10 §8.5).
 *
 * `cover-lock.test.ts` covers the arithmetic. What these check is the part that can be
 * wrong on its own: that a real pointer drag reaches the clamp at all, that the main
 * video is the clip it applies to, and that the setting turns it off. A clamp that no
 * gesture consults is the same failure as a rule with no implementation — the settings
 * field had a default and no reader, so this is exactly the trap being re-checked.
 */

/**
 * One full-frame video on the main track.
 *
 * No crop and `transform` empty, which is the "fill" case: the layer spans the canvas,
 * so `offsetX/Y` of anything but zero exposes canvas on one side.
 */
function makeState(
  transform: Record<string, number> = {},
  overrides: { coverLock?: boolean; type?: string; trackRole?: string } = {},
): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const trackId = overrides.trackRole
    ? base.tracks.find((track) => track.role === overrides.trackRole)?.id ?? mainTrack.id
    : mainTrack.id;
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));
  tracks.find((track) => track.id === trackId)!.itemIds.push('a');
  const item = {
    id: 'a',
    trackId,
    type: overrides.type ?? ('video' as const),
    mediaId: 'media-a',
    startUs: 0,
    durationUs: 5_000_000,
    sourceInUs: 0,
    transform,
    crop: {},
    keyframes: {},
  };
  return {
    ...base,
    toggles: { ...base.toggles, coverLock: overrides.coverLock ?? true },
    tracks,
    items: { a: item },
  } as unknown as TimelineState;
}

function fakeTimeline(): TimelineApi {
  return {
    fps: 30,
    selection: ['a'],
    setItemProperties: vi.fn(() => true),
    addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
  } as unknown as TimelineApi;
}

/** The canvas and the picture both measure 400×400 at the origin. */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400,
    toJSON: () => ({}),
  } as DOMRect);
  for (const [prop, value] of [['offsetWidth', 400], ['offsetHeight', 400]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
}

const pointer = (type: string, clientX: number, clientY: number) =>
  new MouseEvent(type, { clientX, clientY, bubbles: true });

/** Drag from one point to another; returns the committed transform, if any. */
function drag(
  state: TimelineState,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  stubLayout();
  const timeline = fakeTimeline();
  render(<PreviewPane state={state} fps={30} timeline={timeline} />);
  const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
  fireEvent(layer, pointer('pointerdown', from.x, from.y));
  fireEvent(layer, pointer('pointermove', to.x, to.y));
  fireEvent(layer, pointer('pointerup', to.x, to.y));
  const calls = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[1] as { transform: Record<string, number> } | undefined;
}

beforeEach(() => {
  playheadStore.set(0);
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  playheadStore.set(0);
  vi.restoreAllMocks();
});

describe('the fill lock stopping a drag (SPEC 10 §8.5)', () => {
  it('refuses to move a covering video past its overhang', () => {
    /*
      The headline case, with a fixture that can *show* a clamp rather than merely agree
      with it. An exactly-covering video pins to the centre, so a clamped drag commits
      nothing at all — there is no patch to inspect, and a test that read one would be
      asserting on the absence of a commit. A 2× video has half a canvas of overhang to
      spend, so a drag past 0.5 must land exactly on 0.5: a number the pointer never
      asked for, which is what makes the clamp observable.
    */
    const commit = drag(makeState({ scaleX: 2, scaleY: 2 }), { x: 100, y: 200 }, { x: 300, y: 200 });
    expect(commit?.transform.x).toBe(0.5);
  });

  it('pins an exactly-covering video to the centre by committing nothing', () => {
    /*
      The complement, and the reason the test above needed a 2× fixture: for a video that
      covers exactly, the clamped position *is* where it already is, and the gesture
      correctly resolves to no edit. Committing the unchanged value would push an undo
      step for a drag that moved the frame zero pixels.
    */
    const commit = drag(makeState(), { x: 200, y: 200 }, { x: 224, y: 200 });
    expect(commit).toBeUndefined();
  });

  it('lets the same drag through when the lock is off', () => {
    /*
      The discriminating half. If this also landed at 0, the clamp would be pinned on by
      something other than the setting — and "turning it off does nothing" is the failure
      a user reports as the toggle being broken.
    */
    const commit = drag(makeState({}, { coverLock: false }), { x: 200, y: 200 }, { x: 224, y: 200 });
    expect(commit?.transform.x).toBeCloseTo(0.06, 5);
  });

  it('shows the fill-lock chip while the drag is held back', () => {
    // The spec asks for "Fill lock on" in the status chip. A clamp with no explanation
    // reads as a broken drag, so the chip is part of the behaviour, not decoration.
    stubLayout();
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 224, 200));
    expect(screen.getByTestId('preview-fill-lock').textContent).toBe('Fill lock on');
  });

  it('does not show the chip when the lock is off', () => {
    stubLayout();
    render(
      <PreviewPane state={makeState({}, { coverLock: false })} fps={30} timeline={fakeTimeline()} />,
    );
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 224, 200));
    expect(screen.queryByTestId('preview-fill-lock')).toBeNull();
  });

  it('does not lock an image overlay sitting on the main track', () => {
    /*
      "The **main video**" is the footage, not anything that happens to fill the frame.
      A full-frame still or graphic needs to be placeable — clamping it to the canvas
      edges would mean a full-width graphic was immovable, which is why the rule tests the
      item's type rather than its size.
    */
    const commit = drag(makeState({}, { type: 'image' }), { x: 200, y: 200 }, { x: 224, y: 200 });
    expect(commit?.transform.x).toBeCloseTo(0.06, 5);
  });

  it('does not lock a video on an overlay track', () => {
    // The track's own `role` says which video is the main one; position in the stack is
    // not the same statement, and an overlay video is meant to sit inside the frame.
    const commit = drag(
      makeState({}, { trackRole: 'overlay' }),
      { x: 200, y: 200 },
      { x: 224, y: 200 },
    );
    expect(commit?.transform.x).toBeCloseTo(0.06, 5);
  });
});

/**
 * Drag a corner to scale, from one client point to another.
 *
 * The corner grip is the only handle that scales uniformly (§8.2); the body moves and the
 * edges crop, so a scale test has to grab a corner by its own `data-testid`.
 */
function scaleBy(
  state: TimelineState,
  corner: 'se' | 'nw',
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  stubLayout();
  const timeline = fakeTimeline();
  render(<PreviewPane state={state} fps={30} timeline={timeline} />);
  const handle = document.querySelector(`[data-testid="preview-corner-${corner}"]`) as HTMLElement;
  fireEvent(handle, pointer('pointerdown', from.x, from.y));
  fireEvent(handle, pointer('pointermove', to.x, to.y));
  fireEvent(handle, pointer('pointerup', to.x, to.y));
  const calls = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[1] as { transform: Record<string, number> } | undefined;
}

describe('the fill lock under a corner scale (SPEC 10 §8.5)', () => {
  it('stops a covering video shrinking out of the frame', () => {
    /*
      "Scale below cover is blocked while on." The picture spans the canvas, so the se
      corner sits at 400,400 and its opposite — the fixed point — is the top-left at 0,0.
      Pulling the pointer halfway in is a factor of 0.5, which would leave the frame
      half empty; the floored scale is 1, and because the scale did not actually change
      the gesture resolves to no edit at all.
    */
    const commit = scaleBy(makeState(), 'se', { x: 400, y: 400 }, { x: 200, y: 200 });
    expect(commit?.transform.scaleX ?? 1).toBe(1);
  });

  it('lets a 2× picture shrink, but only to the cover threshold', () => {
    /*
      The discriminating half, and the one that catches a floor implemented as "never
      shrink": a 2× picture drawn 800 px wide has the only scale it may reach at 0.5, so
      dragging to a quarter of that must land on 0.5 rather than on the pointer's 0.25 or
      on the unchanged 1.
    */
    /*
      A 2× picture may shrink to **scale 1** — its drawn size is `source · scale`, so 1 is
      where it stops covering — and no further. Its drawn box is clipped by the 400 px
      frame, so the corner grip still sits at 400,400 with the fixed point at 0,0; pulling
      it to 100,100 asks for a factor of 0.25, which is 0.5 in scale, *below* the floor of
      1. The two wrong answers are therefore distinguishable from the right one: a floor
      that never shrinks leaves 2, an absent floor gives 0.5, and only the correct rule
      gives 1.
    */
    const commit = scaleBy(makeState({ scaleX: 2, scaleY: 2 }), 'se', { x: 400, y: 400 }, { x: 100, y: 100 });
    expect(commit?.transform.scaleX).toBeCloseTo(1, 5);
    expect(commit?.transform.scaleY).toBeCloseTo(1, 5);
  });

  it('leaves the scale alone when the lock is off', () => {
    // The setting has to be the thing that decides, in both directions.
    const commit = scaleBy(
      makeState({}, { coverLock: false }),
      'se',
      { x: 400, y: 400 },
      { x: 200, y: 200 },
    );
    expect(commit?.transform.scaleX).toBeCloseTo(0.5, 5);
  });
});
