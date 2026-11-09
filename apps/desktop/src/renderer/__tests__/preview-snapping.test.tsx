// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  /*
    The fill lock is off for these fixtures (SPEC 10 §8.5). They are about snapping arithmetic reaching a real gesture, and
    a full-frame video at scale 1 is exactly the clip the lock pins to the centre — so
    leaving it on would make every drag here a no-op for a reason this file is not
    testing. The locked path has its own suite in `preview-cover-lock.test.tsx`.
  */
  return {
    ...base,
    toggles: { ...base.toggles, coverLock: false },
    tracks,
    items: { a: item },
  } as unknown as TimelineState;
}

/**
 * Three narrow clips in a row, for the spacing tests.
 *
 * Each is a tenth of the canvas wide, so two neighbours leave a real gap between them —
 * with the full-canvas items the other fixtures use, nothing can ever fit between two of
 * them and a spacing hint is not constructible at all.
 *
 * The width comes from **crop**, not from `scaleX`. Snapping measures the cropped
 * fraction of the canvas, which stays 1.0 with no crop no matter what the scale is, so a
 * scaled-down item still bids for the whole canvas and no gap exists.
 *
 * The row sits entirely **right of centre**, and that is deliberate rather than tidy:
 * with the equal spacing at the canvas centre, item `a`'s own centre would be within 8 px
 * of the canvas centre line, a line snap would catch first by design, and the spacing
 * test would be asserting on a code path it never reached. That mistake cost a debugging
 * round here — the guard was working exactly as intended and the fixture was wrong.
 *
 * Geometry: `l` spans [0.05,0.15] and `r` [0.45,0.55] in canvas fractions, so the two
 * gaps are equal when `a`'s centre is at 0.3. At 0.315 they are 0.115 and 0.085 — a 6 px
 * difference on a 400 px canvas, inside the 8 px threshold.
 */
function makeSpacedState(x: number): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));
  tracks.find((track) => track.id === mainTrack.id)!.itemIds.push('l', 'a', 'r');
  const item = (id: string, x: number) => ({
    id,
    trackId: mainTrack.id,
    type: 'video' as const,
    mediaId: `media-${id}`,
    startUs: 0,
    durationUs: 5_000_000,
    sourceInUs: 0,
    transform: { x },
    crop: { left: 0.45, right: 0.45 },
    keyframes: {},
  });
  return {
    ...base,
    // The fill lock is off here for the same reason as in `makeState`: these clips are
    // cropped to a tenth of the frame, which the lock correctly reads as *not* covering,
    // and the question this file asks is about spacing rather than about the lock.
    toggles: { ...base.toggles, coverLock: false },
    tracks,
    items: { l: item('l', 0.1), a: item('a', x), r: item('r', 0.5) },
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

describe('snapping to the thirds (SPEC 10 §8.8, §9)', () => {
  /*
    The first third is at 1/3 across the frame, which is −1/6 in centre-relative
    fractions. With the item half a canvas wide, its left edge reaches that line when its
    centre sits at 1/3 — 133 px across on a 400 px canvas.

    The drag is 130 px, leaving the edge 3 px short: inside the threshold, so whether it
    snaps is decided by whether `Ctrl+'` has drawn the lines.
  */
  const commitX = (thirdsOn: boolean): number | undefined => {
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    if (thirdsOn) {
      fireEvent.keyDown(document, { key: "'", ctrlKey: true });
      expect(screen.getByTestId('overlay-grid-v-0')).toBeTruthy();
    }
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 330, 200));
    fireEvent(layer, pointer('pointerup', 330, 200));
    const calls = (timeline.setItemProperties as ReturnType<typeof vi.fn>).mock.calls;
    return calls.at(-1)?.[1]?.transform?.x as number | undefined;
  };

  it('ignores the composition lines while they are off', () => {
    expect(commitX(false)).toBeCloseTo(0.325, 6);
  });

  it('pulls onto the first third when the lines are showing', () => {
    // 1/3, not 0.325: the clip's left edge lands on the visible line.
    expect(commitX(true)).toBeCloseTo(1 / 3, 6);
  });
});

describe('snapping to a custom grid (SPEC 10 §8.8, §9)', () => {
  /*
    A custom grid is the same overlay with other divisors, so it has to be the same *snap
    target* too — otherwise the lines would be drawn and pull nothing, which reads as
    snapping having stopped working rather than as the grid being decorative.

    Four columns put lines at 1/4, 1/2 and 3/4. The drag below is 130 px on a 400 px
    canvas, which with a half-canvas-wide item leaves its left edge 3 px short of 1/3 and
    17 px short of 1/4 — so it is inside the threshold of the thirds and nowhere near the
    quarter. A grid of four must therefore commit 0.325, and the delta is what proves the
    custom divisors reached the snap and not just the drawing.
  */
  const commitWithGrid = (columns: string): number | undefined => {
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    fireEvent.keyDown(document, { key: "'", ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: /Guides and grid/ }));
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: /Composition grid/ }),
    );
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: columns } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 330, 200));
    fireEvent(layer, pointer('pointerup', 330, 200));
    const calls = (timeline.setItemProperties as ReturnType<typeof vi.fn>).mock.calls;
    return calls.at(-1)?.[1]?.transform?.x as number | undefined;
  };

  it('snaps to the lines of a 4-column grid where there is no third', () => {
    // 0.325 is the raw drag: the nearest quarter is 17 px away, outside the threshold.
    expect(commitWithGrid('4')).toBeCloseTo(0.325, 6);
  });

  it('still snaps to a third when the grid is 3 columns', () => {
    // The same fixture with the default grid: the line is back, so the pull is back.
    expect(commitWithGrid('3')).toBeCloseTo(1 / 3, 6);
  });

  it('draws the same number of lines it snaps to', () => {
    /*
      The drawing and the snapping read the same divisors, so this cannot drift — but the
      pair is what a user actually checks, and a grid that draws four lines and snaps to
      two is exactly the bug a single-source-of-truth is meant to prevent.
    */
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    fireEvent.keyDown(document, { key: "'", ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: /Guides and grid/ }));
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: /Composition grid/ }),
    );
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getAllByTestId(/^overlay-grid-v-/)).toHaveLength(5);
  });
});

describe('equal-spacing hints reaching the canvas (SPEC 10 §8.8)', () => {
  /*
    See `makeSpacedState` for the geometry: equal spacing is at x = 0.3, and the drag
    starts at 0.315 so the gaps differ by 6 px — inside the threshold, so the hint should
    appear and the commit should land exactly on 0.3.
  */
  const dragOnce = (startX: number, moveToX: number) => {
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeSpacedState(startX)} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', moveToX, 200));
    return { timeline, layer };
  };

  it('shows the hint while the gaps are nearly equal', () => {
    dragOnce(0.315, 200);
    expect(screen.getByTestId('spacing-hints')).toBeTruthy();
    expect(screen.getByTestId('spacing-hint-0')).toBeTruthy();
    expect(screen.getByTestId('spacing-hint-1')).toBeTruthy();
  });

  it('commits the equalised position rather than the raw drag', () => {
    /*
      The wiring check: the maths returning a delta is worth nothing if the committed
      position ignores it.

      The drag has to move, because a pointer that ends where it began is a click and
      commits nothing at all (`§8.10`). Six pixels left takes 0.315 to 0.3 — the equal
      spacing — so the raw and equalised values coincide here; the *next* test is what
      distinguishes them.
    */
    const { timeline, layer } = dragOnce(0.315, 194);
    fireEvent(layer, pointer('pointerup', 194, 200));
    const calls = (timeline.setItemProperties as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[1]?.transform?.x).toBeCloseTo(0.3, 6);
  });

  it('overrides the raw drag, landing on the equal spacing rather than near it', () => {
    /*
      The discriminating case. Starting at 0.32 and dragging 2 px left leaves the raw
      position at 0.315 — visibly unequal — and the equalising delta of −0.015 carries it
      to 0.3. A commit that ignored the spacing would write 0.315, which is a two-pixel
      lie about gaps the hint just drew as equal.
    */
    const { timeline, layer } = dragOnce(0.32, 198);
    fireEvent(layer, pointer('pointerup', 198, 200));
    const calls = (timeline.setItemProperties as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[1]?.transform?.x).toBeCloseTo(0.3, 6);
  });

  it('still shows the hint once the gaps are exactly equal', () => {
    /*
      A zero-delta spacing is the *confirmation*, not a no-op: the moment the snap lands
      is the moment the user wants to see the two equal bars. Suppressing it would make
      the feedback vanish exactly at the instant it succeeded — which is the opposite of
      the rule the guide *label* follows, because a label reading "0 px" is a number
      saying nothing while two equal bars are the whole message.
    */
    dragOnce(0.3, 196);
    expect(screen.getByTestId('spacing-hints')).toBeTruthy();
  });

  it('drops the hint when the drag is released', () => {
    /*
      A hint left behind after release would claim the spacing is *still* being
      corrected, when the clip is simply where it ended up — the same rule the guide
      lines follow, and the reason both are cleared in `end()`.
    */
    // 0.33 dragged 12 px left lands on the equal spacing at 0.3, so the hint is up
    // when the pointer comes off.
    const { timeline, layer } = dragOnce(0.33, 188);
    expect(screen.getByTestId('spacing-hints')).toBeTruthy();
    fireEvent(layer, pointer('pointerup', 188, 200));
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });

  it('drops the hint when the drag is cancelled', () => {
    // `Esc` abandons the gesture, and the hint belongs to the gesture.
    const { layer } = dragOnce(0.33, 188);
    expect(screen.getByTestId('spacing-hints')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });

  it('draws no hint before the drag has moved', () => {
    /*
      A hint on pointer-down, before the user has done anything, would read as the editor
      reacting to a gesture that has not started. The spacing is only interesting once the
      pointer is actually going somewhere.
    */
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeSpacedState(0.315)} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });

  it('draws no hint when the gaps are far too unequal to nudge', () => {
    /*
      0.5 puts `a` outside both neighbours, where no equal-spacing is within 8 px. Snapping
      there would yank the clip across the canvas rather than nudge it.
    */
    dragOnce(0.5, 200);
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });

  it('leaves the hint alone while Alt is held', () => {
    // `Alt` means "place it exactly here"; a spacing nudge would contradict it.
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeSpacedState(0.315)} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, new MouseEvent('pointerdown', { clientX: 200, clientY: 200, altKey: true, bubbles: true }));
    fireEvent(layer, new MouseEvent('pointermove', { clientX: 200, clientY: 200, altKey: true, bubbles: true }));
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });

  it('keeps a line snap winning over a spacing hint', () => {
    /*
      Precedence matters because the line is the older, more legible answer and users
      already have it in their hands: a spacing hint must never quietly take a drag away
      from an edge that caught. Dragging `a` onto the canvas centre line puts its centre
      well inside the threshold of 0.
    */
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeSpacedState(0.1)} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 200, 200));
    // 110 px left of centre: 0.1 - 110/400 = -0.175... not near 0. Use 36 px -> 0.01.
    fireEvent(layer, pointer('pointermove', 164, 200));
    expect(screen.getByTestId('snap-guide-x')).toBeTruthy();
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });
});
