/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  appliedAspect,
  cornerCrop,
  ASPECT_CHOICES,
  cropChanged,
  cropExtent,
  cropRect,
  lockedCrop,
  pannedCrop,
  resolveAspect,
  cropGripAt,
  gripCursor,
  radiusCss,
  isResizeGrip,
  type CropEdges,
} from '../crop-tool.js';

const SOURCE = { width: 1920, height: 1080 };
const CANVAS = { width: 1080, height: 1920 };
const NONE = { left: 0, top: 0, right: 0, bottom: 0 };
const sizes = { source: SOURCE, canvas: CANVAS };

describe('the aspect choices', () => {
  it('offers exactly the seven the spec lists', () => {
    // §8.6: Free, Original, 1:1, 9:16, 16:9, 4:5, Canvas.
    expect(ASPECT_CHOICES).toStrictEqual([
      'free',
      'original',
      '1:1',
      '9:16',
      '16:9',
      '4:5',
      'canvas',
    ]);
  });

  it('gives each fixed choice its ratio', () => {
    expect(resolveAspect('1:1', sizes)).toBeCloseTo(1, 10);
    expect(resolveAspect('9:16', sizes)).toBeCloseTo(9 / 16, 10);
    expect(resolveAspect('16:9', sizes)).toBeCloseTo(16 / 9, 10);
    expect(resolveAspect('4:5', sizes)).toBeCloseTo(4 / 5, 10);
  });

  it('resolves Original from the source and Canvas from the composition', () => {
    /*
      Two ratios that are *not* the same here, which is the point: a 1920×1080 source in a
      1080×1920 composition means "Original" and "Canvas" are perpendicular. A resolver that
      read one for the other would make a landscape lock in a portrait project and the tests
      could not tell.
    */
    expect(resolveAspect('original', sizes)).toBeCloseTo(1920 / 1080, 10);
    expect(resolveAspect('canvas', sizes)).toBeCloseTo(1080 / 1920, 10);
  });

  it('has no constraint for Free', () => {
    expect(resolveAspect('free', sizes)).toBeNull();
  });

  it('declines a degenerate size rather than returning zero or Infinity', () => {
    /*
      `width/height` of 0/0 is `NaN`, of 100/0 is `Infinity`. Either propagates into a locked
      resize and makes every proposal invalid, so the lock would appear to do nothing at all —
      where an unlocked fallback at least still crops. jsdom measures zero for everything, so
      this path is reached in every test that does not stub a size.
    */
    expect(resolveAspect('original', { source: { width: 0, height: 0 }, canvas: CANVAS })).toBeNull();
    expect(resolveAspect('canvas', { source: SOURCE, canvas: { width: 100, height: 0 } })).toBeNull();
    expect(
      resolveAspect('original', { source: { width: Number.NaN, height: 10 }, canvas: CANVAS }),
    ).toBeNull();
  });
});

describe('the crop rectangle over the uncropped source', () => {
  it('reads the stored insets straight through', () => {
    expect(cropRect({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 })).toStrictEqual({
      left: 0.1,
      top: 0.2,
      right: 0.3,
      bottom: 0.4,
    });
  });

  it('clamps a corrupt crop to something drawable', () => {
    // Insets summing past 1 are corrupt, not merely extreme. The rectangle still has to be
    // drawable, or the tool draws an inverted box.
    const rect = cropRect({ left: 0.9, top: 0, right: 0.9, bottom: 0 });
    const extent = cropExtent(rect);
    expect(extent.width).toBeGreaterThan(0);
    expect(extent.height).toBeGreaterThan(0);
  });

  it('treats a missing or non-finite edge as no crop', () => {
    const rect = cropRect({ left: Number.NaN, top: undefined as unknown as number, right: 0, bottom: 0 });
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(0);
  });

  it('reports the surviving extent, not the insets', () => {
    // The window is what the user sees framed; the insets are how it is stored.
    expect(cropExtent({ left: 0.25, top: 0.1, right: 0.25, bottom: 0.1 })).toStrictEqual({
      width: 0.5,
      height: 0.8,
    });
  });
});

describe('a locked aspect', () => {
  it('grows the opposite axis from its centre, keeping the ratio', () => {
    /*
      Derived, not guessed. On a 1920×1080 source with a 1:1 lock, dragging the left edge
      inward by 0.5 leaves a window 0.5 wide — 960 px — so the height must be 960 px too, or
      0.888… of the source. The *top* is then placed by centring that 0.888 within the crop's
      vertical centre, which for an uncropped item is 0.5, giving 0.0555… each side.
    */
    const next = lockedCrop(NONE, 'left', 0.5, 1, SOURCE);
    expect(next).not.toBeNull();
    expect(next!.left).toBeCloseTo(0.5, 10);
    expect(next!.right).toBeCloseTo(0, 10);
    const extent = cropExtent(cropRect(next!));
    // 960 / 1080, and the window is square in pixels.
    expect(extent.height).toBeCloseTo(960 / 1080, 10);
    expect(next!.top + extent.height + next!.bottom).toBeCloseTo(1, 10);
    // Centred: the item was uncropped, so the vertical window keeps its middle.
    expect(next!.top).toBeCloseTo(next!.bottom, 10);
  });

  it('keeps the ratio exactly, which is the whole promise of a lock', () => {
    /*
      The drags are chosen from the satisfiable ones, and that is a real constraint rather
      than a convenience. A 1:1 window on a 16:9 source cannot be wider than 0.5625 of the
      source height in fraction terms, so dragging the *left* edge inward by 0.25 — which
      leaves a window 0.75 wide — needs a height of 1.33 and is correctly refused. My first
      version of this test assumed all four edges work at every distance, and half of them
      returned `null`.
    */
    for (const [edge, drag] of [
      ['top', 0.3],
      ['bottom', 0.6],
    ] as const) {
      const next = lockedCrop(NONE, edge, drag, 1, SOURCE);
      expect(next).not.toBeNull();
      const extent = cropExtent(cropRect(next!));
      const pixels = { width: extent.width * SOURCE.width, height: extent.height * SOURCE.height };
      expect(pixels.width / pixels.height).toBeCloseTo(1, 6);
    }
  });

  it('drags the edge the user moved and leaves the facing one alone', () => {
    // The far edge is the anchor on the dragged axis; only the dragged one follows.
    const next = lockedCrop(NONE, 'left', 0.5, 1, SOURCE);
    expect(next!.right).toBeCloseTo(0, 10);
  });

  it('reproduces the source shape when the lock is the source shape', () => {
    /*
      The clean invariant: a 16:9 lock on a 16:9 source with no crop already satisfies the
      ratio, so any drag on one axis produces the same fraction on the other. A resolver or a
      solver that mixed up source pixels and fractions fails here and nowhere else.
    */
    const next = lockedCrop(NONE, 'left', 0.25, 16 / 9, SOURCE);
    expect(next).not.toBeNull();
    // The dragged edge: left inset 0.25, so the window is 0.75 wide.
    expect(next!.left).toBeCloseTo(0.25, 10);
    // The other axis must also be 0.75 — and it is *centred*, so its insets are half the
    // remainder, not the same 0.25. Expecting 0.25 on both was my arithmetic error.
    expect(next!.top).toBeCloseTo(0.125, 10);
    expect(next!.bottom).toBeCloseTo(0.125, 10);
  });

  it('refuses a drag the ratio cannot satisfy, rather than clamping to a sliver', () => {
    /*
      A 9:16 lock on a fully-uncropped 1920×1080 source needs a height fraction of 1.58 for
      the requested width — there is not that much picture. Clamping instead would produce a
      0.02-high strip the user did not ask for and cannot undo without abandoning the gesture.
    */
    expect(lockedCrop(NONE, 'right', 0.5, 9 / 16, SOURCE)).toBeNull();
  });

  it('refuses when centring the other axis would push it off the source', () => {
    /*
      The case that separates "refuse" from "slide", and the reason there is no `max(0, …)` on
      the centred axis. The start window is already cropped to a thin band at the top: 0.6 wide
      and 0.1 tall, vertically centred at 0.05. Dragging the *left* edge in by 0.1 leaves a
      0.5-wide window, and a 16:9 lock then wants a height of 0.5 — a legal `other`, well inside
      `0..1`, but centred on 0.05 its top would land at `0.05 − 0.25 = −0.2`.

      Clamping that to 0 produces `top 0, bottom 0.5` and passes every other guard — a crop
      whose top edge has silently jumped by 0.2 of the source, with the user's frame moved out
      from under their pointer. `null` is the honest answer, and the mirror case near the
      bottom is refused the same way, which it was not before this test existed.
    */
    const nearTop = { left: 0, top: 0, right: 0.4, bottom: 0.9 };
    const extent = cropExtent(cropRect(nearTop));
    expect(extent.width).toBeCloseTo(0.6, 10);
    expect(extent.height).toBeCloseTo(0.1, 10);
    expect(lockedCrop(nearTop, 'left', 0.1, 16 / 9, SOURCE)).toBeNull();

    // The mirror, which is the one a `max(0, …)` on the far side would let through: a thin band
    // at the bottom, centred at 0.95, so the same drag wants a bottom of −0.2.
    const nearBottom = { left: 0, top: 0.9, right: 0.4, bottom: 0 };
    expect(lockedCrop(nearBottom, 'left', 0.1, 16 / 9, SOURCE)).toBeNull();

    // And the pair for a vertical drag, which is where the horizontal branch's centring lives:
    // a narrow band hugging the left or right edge, centred at 0.05 and 0.95 respectively.
    const nearLeft = { left: 0, top: 0, right: 0.9, bottom: 0.4 };
    const nearRight = { left: 0.9, top: 0, right: 0, bottom: 0.4 };
    expect(lockedCrop(nearLeft, 'top', 0.1, 16 / 9, SOURCE)).toBeNull();
    expect(lockedCrop(nearRight, 'top', 0.1, 16 / 9, SOURCE)).toBeNull();
  });

  it('refuses nonsense rather than producing a NaN crop', () => {
    for (const aspect of [0, -1, Number.NaN]) {
      expect(lockedCrop(NONE, 'left', 0.5, aspect, SOURCE)).toBeNull();
    }
    expect(lockedCrop(NONE, 'left', Number.NaN, 1, SOURCE)).toBeNull();
    expect(lockedCrop(NONE, 'left', 0.5, 1, { width: 0, height: 0 })).toBeNull();
  });
});

describe('panning the crop window', () => {
  it('moves both edges together so the size is untouched', () => {
    const start = { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 };
    const next = pannedCrop(start, { x: 0.1, y: 0.05 });
    expect(cropExtent(cropRect(next))).toStrictEqual(cropExtent(cropRect(start)));
    expect(next.left).toBeCloseTo(0.3, 10);
    expect(next.top).toBeCloseTo(0.25, 10);
  });

  it('stops at the source edge instead of sliding the window off', () => {
    /*
      The bound is applied per side, not to the window's centre. A centre-clamp would let a
      window narrower than the source slide half its own width past the edge before stopping,
      which is the difference between "cannot go further" and "goes too far then stops".
    */
    const start = { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 };
    const far = pannedCrop(start, { x: 99, y: 99 });
    /*
      The window is 0.6 of the source, so its left inset may reach 0.4 — at which point the
      right inset is 0 and the window's far side is flush with the source. I first expected
      0.6, which would have put the window's *right* edge 0.2 past the source.
    */
    expect(far.left).toBeCloseTo(0.4, 10);
    expect(far.right).toBeCloseTo(0, 10);
    expect(cropExtent(cropRect(far)).width).toBeCloseTo(0.6, 10);
  });

  it('cannot pan a full-frame crop at all', () => {
    // There is nowhere to go: the window is already the whole source.
    expect(pannedCrop(NONE, { x: 0.5, y: 0.5 })).toStrictEqual(NONE);
  });

  it('ignores a non-finite pan rather than producing NaN edges', () => {
    const start = { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 };
    const next = pannedCrop(start, { x: Number.NaN, y: 0.1 });
    expect(Number.isFinite(next.left)).toBe(true);
    expect(next.top).toBeCloseTo(0.3, 10);
  });
});

describe('deciding whether a session changed anything', () => {
  it('reports no change for an untouched frame', () => {
    // `Enter` on an untouched crop frame dismisses the tool; it is not an edit.
    expect(cropChanged(NONE, { ...NONE })).toBe(false);
  });

  it('tolerates float noise, because a round trip through the fractions is not exact', () => {
    /*
      A drag that returns to where it started lands a few ulps away. Exact equality would
      record that as an edit and push an undo step for a gesture the user cancelled by
      returning — the kind of undo entry that makes `Ctrl+Z` feel broken.
    */
    expect(cropChanged(NONE, { left: 1e-9, top: 0, right: 0, bottom: 0 })).toBe(false);
  });

  it('reports a change on any edge that really moved', () => {
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      expect(cropChanged(NONE, { ...NONE, [edge]: 0.01 })).toBe(true);
    }
  });
});

describe("a corner drag (SPEC 10 \u00a78.6's eight handles)", () => {
  const FULL: CropEdges = { left: 0, top: 0, right: 0, bottom: 0 };

  it('moves the dragged corner and holds the opposite one', () => {
    const next = cornerCrop(FULL, 'nw', { x: 0.2, y: 0.1 }, null, SOURCE);
    expect(next).not.toBeNull();
    expect(next!.left).toBeCloseTo(0.2, 10);
    expect(next!.top).toBeCloseTo(0.1, 10);
    // The south-east corner has not moved, which is the whole point of the grip.
    expect(1 - next!.right).toBeCloseTo(1, 10);
    expect(1 - next!.bottom).toBeCloseTo(1, 10);
  });

  it('holds the opposite corner from all four grips', () => {
    /*
      Each grip anchors the corner diagonally opposite itself, and the two crops below are
      therefore *mirror images* rather than equal — an earlier version of this test asserted
      they matched, which would have passed only if the sign were wrong somewhere. What must
      hold is the extent and the anchor, not the rectangle's position.

      The inward drags are what a pointer actually produces: rightwards on the west grips,
      leftwards on the east ones.
    */
    const nw = cornerCrop(FULL, 'nw', { x: 0.2, y: 0.1 }, null, SOURCE);
    const se = cornerCrop(FULL, 'se', { x: -0.2, y: -0.1 }, null, SOURCE);
    expect(se).not.toBeNull();
    expect(cropExtent(cropRect(se!)).width).toBeCloseTo(cropExtent(cropRect(nw!)).width, 10);
    expect(cropExtent(cropRect(se!)).height).toBeCloseTo(cropExtent(cropRect(nw!)).height, 10);
    // nw anchors the south-east corner; se anchors the north-west one.
    expect(1 - nw!.right).toBeCloseTo(1, 10);
    expect(1 - nw!.bottom).toBeCloseTo(1, 10);
    expect(se!.left).toBeCloseTo(0, 10);
    expect(se!.top).toBeCloseTo(0, 10);
    // And the far grips move their own edges, so the insets mirror.
    expect(nw!.left).toBeCloseTo(0.2, 10);
    expect(se!.right).toBeCloseTo(0.2, 10);
  });

  it('derives the other axis from the one the pointer moved further', () => {
    /*
      A 16:9 lock on a 16:9 source, so the window starts square-on. Dragging the north-west
      grip 0.1 to the right and not at all vertically leaves a window 0.9 wide, and the locked
      height must be 0.9 too — the ratio is 1 in *pixels*, and 0.9 of 1920 by 0.9 of 1080 is
      exactly 16:9.
    */
    const next = cornerCrop(FULL, 'nw', { x: 0.1, y: 0 }, 16 / 9, SOURCE);
    expect(next).not.toBeNull();
    expect(next!.left).toBeCloseTo(0.1, 10);
    expect(next!.top).toBeCloseTo(0.1, 10);
    const extent = cropExtent(cropRect(next!));
    expect(extent.width * SOURCE.width).toBeCloseTo(extent.height * SOURCE.height * (16 / 9), 6);
  });

  it('follows the vertical drag when the vertical moved further', () => {
    /*
      The other leader. A mostly-vertical drag has to reshape by height, and a 9:16 lock makes
      the difference visible: leading with the width here would give a nearly unchanged
      picture, which is the "handle feels dead" failure this ordering exists to avoid.
    */
    const next = cornerCrop(FULL, 'nw', { x: 0.01, y: 0.5 }, 9 / 16, SOURCE);
    expect(next).not.toBeNull();
    const extent = cropExtent(cropRect(next!));
    expect(extent.height).toBeCloseTo(0.5, 6);
    // 0.5 of 1080 px is 540, and 9:16 of that is 303.75 px — a fraction of the 1920 width.
    expect(extent.width).toBeCloseTo(303.75 / 1920, 6);
  });

  it('holds the opposite edge when that edge is not the source edge', () => {
    /*
      The test the "hold the opposite corner" case could not make: with a full frame, the held
      corner *is* the source corner, so an implementation that forgot the held inset
      (`1 − width` instead of `1 − right − width`) still looks correct. Here the window keeps a
      0.3 inset on the right, and the north-west grip must grow into the gap without moving it.
    */
    const inset = { left: 0.2, top: 0, right: 0.3, bottom: 0 };
    const next = cornerCrop(inset, 'nw', { x: 0.1, y: 0 }, null, SOURCE);
    expect(next).not.toBeNull();
    expect(next!.right).toBeCloseTo(0.3, 10);
    // 0.5 of width shrinking by 0.1 leaves 0.4, so the left inset grows 0.2 → 0.3.
    expect(next!.left).toBeCloseTo(0.3, 10);
    expect(cropExtent(cropRect(next!)).width).toBeCloseTo(0.4, 10);

    // The same for the vertical pair, which is written separately in the function.
    const banded = { left: 0, top: 0.2, right: 0, bottom: 0.3 };
    const grown = cornerCrop(banded, 'nw', { x: 0, y: 0.1 }, null, SOURCE);
    expect(grown!.bottom).toBeCloseTo(0.3, 10);
    expect(grown!.top).toBeCloseTo(0.3, 10);

    /*
      And the mirror: the two far grips are a *separate* branch in the function, so the same
      mistake has to be ruled out on them too. Dragging the south-east grip outwards grows the
      window toward the held north-west corner and must leave that corner's 0.1 inset alone.
    */
    const farInset = { left: 0.1, top: 0.1, right: 0.3, bottom: 0.4 };
    const far = cornerCrop(farInset, 'se', { x: 0.1, y: 0.1 }, null, SOURCE);
    expect(far).not.toBeNull();
    expect(far!.left).toBeCloseTo(0.1, 10);
    expect(far!.top).toBeCloseTo(0.1, 10);
    expect(far!.right).toBeCloseTo(0.2, 10);
    expect(far!.bottom).toBeCloseTo(0.3, 10);
  });

  it('refuses a corner drag that the ratio cannot satisfy', () => {
    // A 1:1 window on a 16:9 source is bounded by the *height*: 1.0 of height is only 0.5625 of
    // the width. Dragging the width well past that asks for a height above the source.
    expect(cornerCrop(FULL, 'nw', { x: 0.2, y: 0.1 }, 1, SOURCE)).toBeNull();
  });

  it('refuses a corner drag that would collapse the window', () => {
    expect(cornerCrop(FULL, 'se', { x: -0.995, y: -0.995 }, null, SOURCE)).toBeNull();
  });

  it('refuses nonsense deltas rather than producing a NaN crop', () => {
    expect(cornerCrop(FULL, 'nw', { x: Number.NaN, y: 0 }, null, SOURCE)).toBeNull();
  });
});

describe('choosing an aspect reshapes the frame (SPEC 10 §8.6)', () => {
  it('inscribes the new ratio inside the old window, keeping its centre', () => {
    /*
      A full frame at 1:1 on a 16:9 source: the only window of that ratio that fits is as tall
      as the source, so it is 0.5625 of the width, centred — insets of 0.21875 on both sides.
    */
    const next = appliedAspect({ left: 0, top: 0, right: 0, bottom: 0 }, 1, SOURCE);
    const extent = cropExtent(cropRect(next));
    expect(extent.height).toBeCloseTo(1, 10);
    expect(extent.width).toBeCloseTo(1080 / 1920, 10);
    expect(next.left).toBeCloseTo((1 - 1080 / 1920) / 2, 10);
    expect(next.right).toBeCloseTo(next.left!, 10);
    // Centred, so the two vertical insets stay at zero.
    expect(next.top).toBeCloseTo(0, 10);
    expect(next.bottom).toBeCloseTo(0, 10);
  });

  it('keeps a window that already has the ratio exactly where it is', () => {
    const square = { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 };
    const next = appliedAspect(square, 1080 / 1080, { width: 1080, height: 1080 });
    expect(next.left).toBeCloseTo(0.2, 10);
    expect(next.top).toBeCloseTo(0.2, 10);
  });

  it('inscribes a non-square ratio the right way round', () => {
    /*
      A 1:1 case cannot catch a swapped multiply/divide: on a 16:9 source both spellings give
      the same 1080-px-wide window. 4:5 does — inscribing it in a full frame must narrow the
      window to 0.45 of the source (864 px), while dividing instead of multiplying would widen
      it to 1350 px and overflow the frame.
    */
    const next = appliedAspect({ left: 0, top: 0, right: 0, bottom: 0 }, 4 / 5, SOURCE);
    const extent = cropExtent(cropRect(next));
    expect(extent.width).toBeCloseTo((1080 * 0.8) / 1920, 6);
    expect(extent.height).toBeCloseTo(1, 10);
    expect(extent.width * SOURCE.width).toBeCloseTo(864, 6);
  });

  it('is a no-op for Free', () => {
    const start = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.05 };
    expect(appliedAspect(start, null, SOURCE)).toStrictEqual(start);
  });

  it('never produces an off-source window, whatever the centre', () => {
    /*
      A window hard against the top of the source cannot grow upward, so inscribing a taller
      ratio has to slide it down — and the slide is the bound: the window stays inside the
      source even though its old centre was not.
    */
    const tight = { left: 0, top: 0, right: 0, bottom: 0.8 };
    const next = appliedAspect(tight, 1, SOURCE);
    expect(next.left).toBeGreaterThanOrEqual(-1e-9);
    expect(next.top).toBeGreaterThanOrEqual(-1e-9);
    expect(next.right).toBeGreaterThanOrEqual(-1e-9);
    expect(next.bottom).toBeGreaterThanOrEqual(-1e-9);
    expect(next.top! + (1 - next.top! - next.bottom!)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('the eight handles (SPEC 10 §8.6)', () => {
  /** A window inset 0.2 on every side, so every grip is a measurable distance from the edge. */
  const RECT = cropRect({ left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 });
  const TOL = { x: 0.02, y: 0.03 };

  it('names all eight grips by their compass point', () => {
    /*
      The full set, because a lookup that returned 'nw' for everything would pass any single
      assertion here. The tolerance is per axis, so the points are stated just inside it.
    */
    expect(cropGripAt({ x: 0.2, y: 0.2 }, RECT, TOL)).toBe('nw');
    expect(cropGripAt({ x: 0.8, y: 0.2 }, RECT, TOL)).toBe('ne');
    expect(cropGripAt({ x: 0.8, y: 0.8 }, RECT, TOL)).toBe('se');
    expect(cropGripAt({ x: 0.2, y: 0.8 }, RECT, TOL)).toBe('sw');
    // Edge midpoints, far from both corners.
    expect(cropGripAt({ x: 0.2, y: 0.5 }, RECT, TOL)).toBe('w');
    expect(cropGripAt({ x: 0.8, y: 0.5 }, RECT, TOL)).toBe('e');
    expect(cropGripAt({ x: 0.5, y: 0.2 }, RECT, TOL)).toBe('n');
    expect(cropGripAt({ x: 0.5, y: 0.8 }, RECT, TOL)).toBe('s');
  });

  it('takes the nearer edge when a window is thin on one axis', () => {
    /*
      A narrow band: its left and right edges are both within the horizontal tolerance of the
      centre, so a test that picked the first match would always answer 'w'. The pointer is
      past the middle, so it is holding the *right* edge.
    */
    // The window is 0.03 wide, so a 0.02 tolerance reaches both its edges from the middle.
    const band = cropRect({ left: 0.5, top: 0, right: 0.47, bottom: 0 });
    expect(cropGripAt({ x: 0.52, y: 0.5 }, band, TOL)).toBe('e');
    expect(cropGripAt({ x: 0.51, y: 0.5 }, band, TOL)).toBe('w');
  });

  it('pans from the inside and refuses the outside', () => {
    expect(cropGripAt({ x: 0.5, y: 0.5 }, RECT, TOL)).toBe('move');
    // The dimmed region is not a drag surface: aiming behind the frame must do nothing.
    expect(cropGripAt({ x: 0.05, y: 0.5 }, RECT, TOL)).toBeNull();
    expect(cropGripAt({ x: 0.5, y: 0.95 }, RECT, TOL)).toBeNull();
    /*
      And the case that needed its own guard: level with the top edge but far past the frame's
      *side*. Without the within-bounds check this answers 'n', because being near an edge is
      not the same as being on the frame — it would let a drag in the empty canvas above the
      clip resize the crop from a grip that is nowhere near the pointer.
    */
    expect(cropGripAt({ x: 0.9, y: 0.2 }, RECT, TOL)).toBeNull();
    expect(cropGripAt({ x: 0.2, y: 0.02 }, RECT, TOL)).toBeNull();
  });

  it('reaches a grip from just outside the frame', () => {
    // A grip is drawn centred on the edge, so half of it sits outside the rectangle; a hit
    // test that only accepted the inside would make each grip half as easy to grab.
    expect(cropGripAt({ x: 0.81, y: 0.5 }, RECT, TOL)).toBe('e');
    expect(cropGripAt({ x: 0.5, y: 0.19 }, RECT, TOL)).toBe('n');
  });

  it('pans only from the very inside, not from the tolerance ring', () => {
    /*
      Just outside the west edge. With the pointer level with the middle it is still the grip;
      level with neither end, it is nothing at all — a drag started there must not pan, because
      the user is aiming at the picture behind the frame rather than at the crop.
    */
    expect(cropGripAt({ x: 0.19, y: 0.5 }, RECT, TOL)).toBe('w');
    expect(cropGripAt({ x: 0.17, y: 0.5 }, RECT, TOL)).toBeNull();
  });

  it('separates resizing from panning, and gives each grip a cursor', () => {
    expect(isResizeGrip('nw')).toBe(true);
    expect(isResizeGrip('s')).toBe(true);
    expect(isResizeGrip('move')).toBe(false);
    expect(gripCursor('nw')).toBe('nwse-resize');
    expect(gripCursor('ne')).toBe('nesw-resize');
    expect(gripCursor('n')).toBe('ns-resize');
    expect(gripCursor('w')).toBe('ew-resize');
    expect(gripCursor('move')).toBe('move');
    expect(gripCursor(null)).toBe('default');
  });
});

describe('the radius as a CSS length (SPEC 10 §8.6)', () => {
  it('is a percentage of the window, so it means the same shape at any zoom', () => {
    /*
      The geometry speaks in fractions because that survives being drawn at preview size and
      exported at full size; the DOM needs a length. A percentage is the one form that carries
      the "fraction of the short side" idea across without knowing the box's pixels — the same
      0.1 radius is 10% whether the window is drawn 90 px or 900 px wide.
    */
    expect(radiusCss(0.1, { width: 100, height: 200 })).toBe('10%');
    expect(radiusCss(0.1, { width: 1000, height: 2000 })).toBe('10%');
  });

  it('uses the shorter side, not the width', () => {
    /*
      A landscape window drawn 400×100. A radius of 0.25 is a quarter of the short side — 25% —
      where measuring against the width would make it 6.25%, a corner four times too tight.
    */
    expect(radiusCss(0.25, { width: 400, height: 100 })).toBe('25%');
    // And the portrait case, where the width is the short side.
    expect(radiusCss(0.25, { width: 100, height: 400 })).toBe('25%');
  });

  it('draws nothing at all for a radius there is none of', () => {
    // `undefined` rather than `0%`: a zero border radius is a real value that can override
    // something, while an absent one leaves whatever the stylesheet says alone.
    expect(radiusCss(0, { width: 100, height: 100 })).toBeUndefined();
    expect(radiusCss(Number.NaN, { width: 100, height: 100 })).toBeUndefined();
    expect(radiusCss(-0.2, { width: 100, height: 100 })).toBeUndefined();
    expect(radiusCss(0.2, { width: 0, height: 100 })).toBeUndefined();
  });

  it('never exceeds half the short side', () => {
    // Past 50% the corners are elliptical; the compositor caps at the same place, so capping
    // here keeps the preview and the export showing one shape.
    expect(radiusCss(5, { width: 100, height: 100 })).toBe('50%');
  });
});
