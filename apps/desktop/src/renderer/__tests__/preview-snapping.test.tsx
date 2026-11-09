// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';

/**
 * Snapping, end to end (SPEC 10 §8.8).
 *
 * The arithmetic is covered by `snapping.test.ts`; what these check is that a real drag
 * reaches it, that the threshold really is measured on screen, and that `Alt` reaches the
 * gesture — which is the part that was a no-op modifier before this slice.
 */

function makeState(transform: Record<string, number> = {}): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));
  tracks.find((track) => track.id === mainTrack.id)!.itemIds.push('a');
  const item = {
    id: 'a',
    trackId: mainTrack.id,
    type: 'video' as const,
    mediaId: 'media-a',
    startUs: 0,
    durationUs: 5_000_000,
    sourceInUs: 0,
    transform,
    crop: {},
    keyframes: {},
  };
  return { ...base, tracks, items: { a: item } } as unknown as TimelineState;
}

function fakeTimeline(): TimelineApi {
  return {
    fps: 30,
    selection: ['a'],
    setItemProperties: vi.fn(() => true),
    addKeyframe: vi.fn(() => true),
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

const pointer = (
  type: string,
  clientX: number,
  clientY: number,
  modifiers: { altKey?: boolean; shiftKey?: boolean } = {},
) => new MouseEvent(type, { clientX, clientY, bubbles: true, ...modifiers });

/** Drag the layer from one point to another and return the committed patch. */
function drag(extra: { altKey?: boolean } = {}) {
  stubLayout();
  const timeline = fakeTimeline();
  render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
  const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
  fireEvent(layer, pointer('pointerdown', 200, 200, extra));
  fireEvent(layer, pointer('pointermove', 204, 200, extra));
  fireEvent(layer, pointer('pointerup', 204, 200, extra));
  const calls = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[1] as { transform: Record<string, number> } | undefined;
}

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('snapping a dragged clip (SPEC 10 §8.8)', () => {
  it('pulls a clip onto the canvas centre from close by', () => {
    /*
      A 4 px drag on a 400 px canvas is a hundredth — well inside the 8 px threshold — so
      the clip must be pulled back onto the centre line.

      The clip is already centred, so "pulled back onto the centre" means "did not move",
      and the observable consequence is that *nothing is committed*: a snapped drag that
      ends where it began is not an edit. That is why this test asserts the absence of a
      write rather than a value — the first version of it expected `x === 0` in a patch
      that correct behaviour never sends.
    */
    expect(drag()).toBeUndefined();
  });

  it('snaps onto the centre rather than merely rounding toward it', () => {
    /*
      The distinguishing case, and the one that has to start from a *stored* offset: the
      fixture's timeline is a mock, so a commit never changes the document and a second
      drag begins where the first did. Starting at 0.1 and dragging 0.095 back would land
      at 0.005 — inside the 8 px threshold — and the commit must carry exactly 0.

      Without this, "drag 4 px from the centre and nothing is committed" is satisfied just
      as well by a snap that never fires at all.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane state={makeState({ x: 0.1 })} fps={30} timeline={timeline} />,
    );
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    // 38 px left on a 400 px canvas is 0.095, taking 0.1 to 0.005 — inside 8 px of the
    // centre line, so the commit must carry 0 rather than 0.005.
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 162, 200));
    fireEvent(layer, pointer('pointerup', 162, 200));

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.x).toBeCloseTo(0, 6);
  });

  it('leaves a clip alone when it is dragged further than the threshold', () => {
    // 40 px on a 400 px canvas is a tenth — well past 8 px — so it must keep the move.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 240, 200));
    fireEvent(layer, pointer('pointerup', 240, 200));

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.x).toBeCloseTo(0.1, 6);
  });

  it('does not snap while Alt is held', () => {
    /*
      SPEC 10 §8.2's "Alt disables snapping". This is the assertion that would have failed
      before this slice: the modifier was documented, the docs called it inert, and the
      same 4 px drag produced 0.01 either way.
    */
    const patch = drag({ altKey: true });
    expect(patch?.transform.x).toBeCloseTo(0.01, 6);
  });

  it('writes nothing when a snapped drag ends where it started', () => {
    /*
      The interaction between snapping and "a click is not an edit". A 4 px drag that
      snaps back to the origin has, in document terms, not moved — so committing it would
      push an empty undo step onto the stack for a gesture that produced no change.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 202, 200));
    fireEvent(layer, pointer('pointerup', 202, 200));
    // The clip was already centred and snapped back to centred, so nothing moved.
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('snaps the vertical axis independently', () => {
    // Snapping is per axis: a drag that is close vertically and far horizontally must
    // land on the centre line in one axis and keep its travel in the other.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 240, 204));
    fireEvent(layer, pointer('pointerup', 240, 204));

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.x).toBeCloseTo(0.1, 6);
    expect(patch.transform.y).toBeCloseTo(0, 6);
  });
});

describe('snapping to a visible overlay (SPEC 10 §8.8, §9)', () => {
  /*
    Title safe at 90% is inset 5% on each side, so its left edge sits at −0.45 in the
    centre-relative fractions `transform.x` uses. With the item half a canvas wide, its
    own left edge lands on that line when its centre is at +0.05 — 20 px across on a
    400 px canvas.

    Every case drags the same 18 px from x=0, which leaves the item's left edge 2 px
    short of the line: inside the 8 px threshold, so whether it snaps is decided purely
    by whether the overlay is on.
  */
  const commitX = (overlayOn: boolean): number | undefined => {
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    if (overlayOn) {
      // `Ctrl+;` walks none → title safe, which is the state that must enable the snap.
      fireEvent.keyDown(document, { key: ';', ctrlKey: true });
      expect(screen.getByTestId('overlay-safe-area')).toBeTruthy();
    }
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 218, 200));
    fireEvent(layer, pointer('pointerup', 218, 200));
    const calls = (timeline.setItemProperties as ReturnType<typeof vi.fn>).mock.calls;
    return calls.at(-1)?.[1]?.transform?.x as number | undefined;
  };

  it('ignores the safe-area edges while the overlay is off', () => {
    // 18 px of drag is 0.045 of the canvas, and nothing pulls it anywhere else.
    expect(commitX(false)).toBeCloseTo(0.045, 6);
  });

  it('pulls onto the safe-area edge when the overlay is showing', () => {
    /*
      The line is at 0.05, and the pointer asked for 0.045. Snapping the item's left edge
      onto the visible edge is what makes the guide worth showing; without it a user lines
      a clip up against the title-safe box and is 2 px out with no way to tell.
    */
    expect(commitX(true)).toBeCloseTo(0.05, 6);
  });

  it('draws a guide for the overlay line it caught', () => {
    /*
      A snap with no line is back to the invisible jump. The kind is checked too, because
      a guide that says "item-edge" when the clip stuck to the title-safe box would send
      the user looking for a neighbour that is not there.
    */
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    fireEvent.keyDown(document, { key: ';', ctrlKey: true });
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 218, 200));
    expect(screen.getByTestId('snap-guide-x').getAttribute('data-kind')).toBe('safe-area-edge');
  });
});
