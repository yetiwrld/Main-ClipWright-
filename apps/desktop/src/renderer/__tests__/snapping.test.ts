import { describe, expect, it } from 'vitest';
import {
  SNAP_PX,
  itemBounds,
  snapAxis,
  snapTargetsFor,
  snapThresholdPx,
  snappingApplies,
  equalSpacingSnap,
  spacingMayApply,
  targetsForLines,
  targetsForOverlayRect,
  type ItemBounds,
} from '../features/editor/snapping.js';

describe('snap targets (SPEC 10 §8.8)', () => {
  it('offers the canvas centre and both edges', () => {
    /*
      The canvas spans −0.5..0.5 around its centre, which is the same space `transform.x`
      lives in — so the centre line is 0 and the edges are half a canvas out.
    */
    const targets = snapTargetsFor('x', { others: [] });
    expect(targets.map((target) => target.at)).toEqual([0, -0.5, 0.5]);
    expect(targets.every((target) => target.kind === 'canvas-centre' || target.kind === 'canvas-edge')).toBe(true);
  });

  it('offers every other item’s edges and centre', () => {
    const targets = snapTargetsFor('x', {
      others: [{ left: -0.2, centre: 0.1, right: 0.4 }],
    });
    const itemLines = targets.filter((target) => target.kind.startsWith('item-'));
    expect(itemLines.map((target) => target.at)).toEqual([-0.2, 0.1, 0.4]);
  });

  it('puts the canvas first, so a tie resolves to it', () => {
    // Ordering is the tie-break, and the canvas is the more predictable line to land on.
    const targets = snapTargetsFor('x', { others: [{ left: 0, centre: 0, right: 0 }] });
    expect(targets[0]!.kind).toBe('canvas-centre');
  });
});

describe('snapping one axis', () => {
  const centreOnly = [{ at: 0, kind: 'canvas-centre' as const }];

  it('snaps an edge flush to a target', () => {
    /*
      A 0.4-wide item (half-extent 0.2) whose position is 0.03 puts its left edge at
      −0.17 and its right at 0.23 — neither near the canvas centre. Its *centre* is 0.03,
      which is inside the threshold, so the item slides 0.03 and lands centred.
    */
    const result = snapAxis(0.03, 0.2, centreOnly, 0.05);
    expect(result.position).toBeCloseTo(0, 10);
    expect(result.delta).toBeCloseTo(-0.03, 10);
    expect(result.target?.kind).toBe('canvas-centre');
  });

  it('snaps the leading edge rather than the centre when that is what is close', () => {
    /*
      The point of testing all three lines. An item 0.4 wide at position 0.22 has its left
      edge at 0.02 — a hair from the canvas centre — while its own centre is 0.22 away.
      Snapping the centre would yank the clip; snapping the edge nudges it 0.02 and puts
      the edge on the line, which is what the user aimed at.
    */
    const result = snapAxis(0.22, 0.2, centreOnly, 0.05);
    expect(result.position).toBeCloseTo(0.2, 10);
    expect(result.delta).toBeCloseTo(-0.02, 10);
  });

  it('snaps the trailing edge too', () => {
    // Symmetric with the leading edge, and easy to leave out.
    const result = snapAxis(-0.22, 0.2, centreOnly, 0.05);
    expect(result.position).toBeCloseTo(-0.2, 10);
  });

  it('leaves the position alone when nothing is near enough', () => {
    const result = snapAxis(0.4, 0.2, centreOnly, 0.05);
    expect(result.position).toBe(0.4);
    expect(result.target).toBeNull();
    expect(result.delta).toBe(0);
  });

  it('picks the closest target, not the first one in range', () => {
    /*
      Two lines are in range and one of them is nearer. Taking the first would make the
      result depend on target ordering rather than on where the pointer is, which is felt
      as snapping to the wrong thing.
    */
    const targets = [
      { at: 0, kind: 'canvas-centre' as const },
      { at: 0.04, kind: 'item-edge' as const },
    ];
    // Position 0.01: the centre line is 0.01 away, the item edge 0.03 away.
    const result = snapAxis(0.01, 0, targets, 0.05);
    expect(result.target?.at).toBe(0);
    expect(result.position).toBeCloseTo(0, 10);
  });

  it('snaps exactly to the threshold and not past it', () => {
    // 8 px means 8 px: a line 8 px away snaps, one 8.01 does not.
    expect(snapAxis(0.05, 0, centreOnly, 0.05).target).not.toBeNull();
    expect(snapAxis(0.0501, 0, centreOnly, 0.05).target).toBeNull();
  });

  it('declines to snap when the threshold is unusable', () => {
    // A collapsed canvas gives a zero threshold; dividing instead of declining would
    // produce `Infinity` and snap everything to everything.
    expect(snapAxis(0.3, 0.2, centreOnly, 0).target).toBeNull();
    expect(snapAxis(0.3, 0.2, centreOnly, Number.NaN).target).toBeNull();
  });

  it('declines to snap a position that is not a number', () => {
    // `NaN` would flow into `transform.x` and blank the layer without throwing.
    const result = snapAxis(Number.NaN, 0.2, centreOnly, 0.05);
    expect(result.target).toBeNull();
    expect(Number.isFinite(result.position)).toBe(false);
  });

  it('reports the delta it applied so the guide can be drawn at the right place', () => {
    // The guide is drawn on the target, but callers need the movement to explain it.
    const result = snapAxis(0.03, 0.2, centreOnly, 0.05);
    expect(result.delta).toBeCloseTo(result.position - 0.03, 10);
  });
});

describe('the threshold is measured on screen', () => {
  it('is 8 px of the canvas it is given', () => {
    /*
      SPEC 10 §8.8 measures the snap in *screen* pixels, which is what keeps it feeling
      the same at any preview size. The conversion is the caller's job because only it
      knows how large the canvas is drawn.
    */
    expect(snapThresholdPx(800)).toBeCloseTo(SNAP_PX / 800, 10);
    // Doubling the canvas halves the fraction that is 8 px.
    expect(snapThresholdPx(1600)).toBeCloseTo(snapThresholdPx(800) / 2, 10);
  });

  it('is zero for a canvas that has not been laid out', () => {
    // The panel measures 0×0 on the first frame; a zero threshold means "do not snap",
    // which is the right answer until there is a canvas to snap within.
    expect(snapThresholdPx(0)).toBe(0);
    expect(snapThresholdPx(Number.NaN)).toBe(0);
    expect(snapThresholdPx(-100)).toBe(0);
  });
});

describe('Alt bypasses snapping', () => {
  it('applies by default', () => {
    expect(snappingApplies({ altKey: false })).toBe(true);
  });

  it('is off while Alt is held', () => {
    /*
      SPEC 10 §8.2. Named rather than inlined because it is a product rule that every
      editor shares, and because the inverted version of this one line is a modifier that
      silently does nothing — which is exactly what it did before this slice existed.
    */
    expect(snappingApplies({ altKey: true })).toBe(false);
  });
});

describe('an item’s bounds on one axis', () => {
  it('is the drawn size centred on the position', () => {
    /*
      The preview draws a picture centred on its offsets — `translate(offset · 100%)` on a
      full-inset element — so the offsets are already the centre in canvas fractions and
      the edges are half a drawn size away.
    */
    const bounds = itemBounds(0.1, 0.4, 0, 0.2, 1);
    expect(bounds.centre).toBe(0.1);
    expect(bounds.left).toBeCloseTo(-0.1, 10);
    expect(bounds.right).toBeCloseTo(0.3, 10);
  });

  it('uses the axis-aligned box of a rotated item', () => {
    /*
      A turned item occupies a larger box than its unrotated size, and the box is both
      what the user sees and what they aim at. A quarter turn swaps the two axes: a 0.4
      wide, 0.2 tall item becomes 0.2 wide.
    */
    expect(itemBounds(0, 0.4, 90, 0.2, 1).right).toBeCloseTo(0.1, 10);
    // And at 45° the box is wider than either side, by cos + sin.
    const diagonal = itemBounds(0, 0.4, 45, 0.4, 1);
    expect(diagonal.right).toBeCloseTo((0.4 * Math.cos(Math.PI / 4) + 0.4 * Math.sin(Math.PI / 4)) / 2, 10);
  });

  it('converts the other axis out of its own fractions', () => {
    /*
      The two extents are fractions of different sides. On a 1000×800 canvas an item 0.2
      of the height is 0.16 of the width, and a quarter turn makes exactly that the
      width — getting this wrong would snap to a box the picture does not occupy.
    */
    const square = itemBounds(0, 0.4, 90, 0.2, 1).right;
    const wide = itemBounds(0, 0.4, 90, 0.2, 1.25).right;
    expect(wide).toBeCloseTo(0.08, 10);
    expect(wide).toBeLessThan(square);
  });

  it('is symmetric about the centre', () => {
    // A bounds function that is not symmetric would snap one edge and not the other.
    const bounds = itemBounds(-0.2, 0.3, 30, 0.1, 1.5);
    expect(bounds.centre - bounds.left).toBeCloseTo(bounds.right - bounds.centre, 10);
  });

  it('survives a rotation that is not a number', () => {
    // A NaN rotation would make every bound NaN, and a NaN comparison never snaps — the
    // clip would silently stop responding to its neighbours.
    const bounds = itemBounds(0, 0.4, Number.NaN, 0.2, 1);
    expect(Number.isFinite(bounds.left)).toBe(true);
    expect(Number.isFinite(bounds.right)).toBe(true);
  });
});

describe('snapping to an overlay\'s edges (SPEC 10 §8.8, §9)', () => {
  // Title safe at 90%: a centred square inset by 5% on every side.
  const titleSafe = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };

  it('moves the overlay\'s own left edge to centre-relative space', () => {
    /*
      Overlay rectangles are measured from the top-left, snap targets from the centre.
      Getting the shift wrong puts every safe-area snap half a canvas off — the same trap
      `guidePercent` guards from the other side, and the kind of error that looks
      plausible until someone drags a clip onto the line.
    */
    const targets = targetsForOverlayRect(titleSafe, 'x');
    // `toBeCloseTo`: 0.05 + 0.9 − 0.5 is 0.45000000000000007 in binary floating point.
    expect(targets).toHaveLength(2);
    expect(targets[0]!.at).toBeCloseTo(-0.45, 10);
    expect(targets[1]!.at).toBeCloseTo(0.45, 10);
  });

  it('offers the top and bottom on the vertical axis', () => {
    const targets = targetsForOverlayRect(titleSafe, 'y');
    expect(targets[0]!.at).toBeCloseTo(-0.45, 10);
    expect(targets[1]!.at).toBeCloseTo(0.45, 10);
  });

  it('reads the height for a vertical axis and the width for a horizontal one', () => {
    // A non-square inset — a platform band, say — must not use one extent for both.
    const band = { x: 0, y: 0, width: 1, height: 0.14 };
    expect(targetsForOverlayRect(band, 'x').map((target) => target.at)).toEqual([-0.5, 0.5]);
    expect(targetsForOverlayRect(band, 'y')[0]!.at).toBeCloseTo(-0.5, 10);
    expect(targetsForOverlayRect(band, 'y')[1]!.at).toBeCloseTo(-0.36, 10);
  });

  it('labels them as safe-area edges rather than as item edges', () => {
    // The kind decides what the guide means and lets a test tell the two apart.
    expect(targetsForOverlayRect(titleSafe, 'x').every((target) => target.kind === 'safe-area-edge')).toBe(true);
  });

  it('offers nothing for a rect that has no usable numbers', () => {
    // A malformed data file must not put a snap line at `NaN`, where every comparison is
    // false and the target silently accepts nothing or everything depending on the guard.
    expect(targetsForOverlayRect({ x: Number.NaN, y: 0, width: 0.9, height: 0.9 }, 'x')).toEqual([]);
    expect(targetsForOverlayRect({ x: 0, y: 0, width: Number.NaN, height: 0.9 }, 'y')).toEqual([]);
  });

  it('follows the data file, so a retuned safe area moves its snap line', () => {
    // The numbers live in `assets/safe-areas.json`; a snap that hard-coded 0.45 would
    // drift away from the line the overlay draws the moment that file was tuned.
    const tighter = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    expect(targetsForOverlayRect(tighter, 'x')[0]!.at).toBeCloseTo(-0.4, 10);
    expect(targetsForOverlayRect(tighter, 'x')[1]!.at).toBeCloseTo(0.4, 10);
  });
});

describe('snapping to composition lines (SPEC 10 §8.8, §9)', () => {
  // The rule of thirds, the same constant the overlay draws from.
  const thirds = [1 / 3, 2 / 3];

  it('shifts each line from the top-left to the centre', () => {
    // 1/3 across the frame is −1/6 from the centre; 2/3 is +1/6. Same trap as the safe
    // areas, and the reason the conversion is a function rather than a subtraction at
    // each call site.
    const targets = targetsForLines(thirds);
    expect(targets[0]!.at).toBeCloseTo(-1 / 6, 10);
    expect(targets[1]!.at).toBeCloseTo(1 / 6, 10);
  });

  it('gives the same two lines on both axes', () => {
    // The thirds are symmetric: the caller passes the same list for x and y.
    expect(targetsForLines(thirds).map((target) => target.at)).toEqual(
      targetsForLines(thirds).map((target) => target.at),
    );
  });

  it('labels them as grid lines so a guide does not point at an item', () => {
    // A clip sticking to the thirds must not send the user looking for a neighbour.
    expect(targetsForLines(thirds).every((target) => target.kind === 'grid-line')).toBe(true);
  });

  it('drops a non-finite line instead of placing one at NaN', () => {
    // A line at `NaN` accepts nothing and looks like a snap that never fires.
    expect(targetsForLines([1 / 3, Number.NaN, 2 / 3])).toHaveLength(2);
  });

  it('offers nothing when the lines are off', () => {
    // The caller passes an empty list rather than a flag, so this is the shape the
    // overlay-off path takes.
    expect(targetsForLines([])).toEqual([]);
  });
});

describe('equal-spacing hints (SPEC 10 §8.8)', () => {
  const bounds = (left: number, right: number): ItemBounds => ({
    left,
    centre: (left + right) / 2,
    right,
  });

  it('splits the difference between two neighbours', () => {
    /*
      The dragged item sits between two others with gaps of 0.20 and 0.30. Equalising to
      their mean moves it by half the *difference* — not by the whole one — so the item
      ends up centred in the space rather than flush against the larger gap.

      Expected values derived rather than guessed: gaps 0.20/0.30, mean 0.25, delta
      0.05, and after the move both gaps are 0.25.
    */
    const snap = equalSpacingSnap(bounds(-0.1, 0.1), [bounds(-0.4, -0.3), bounds(0.4, 0.5)], 0.1);
    expect(snap).not.toBeNull();
    expect(snap!.delta).toBeCloseTo(0.05, 10);
    expect(snap!.gap).toBeCloseTo(0.25, 10);
  });

  it('draws both gaps, and they are equal after the move', () => {
    // The hint's whole job is to show two equal spans; a span measured from the item's
    // *unmoved* edge would draw two different lengths and defeat it.
    const snap = equalSpacingSnap(bounds(-0.1, 0.1), [bounds(-0.4, -0.3), bounds(0.4, 0.5)], 0.1)!;
    const [first, second] = snap.spans;
    expect(first.to - first.from).toBeCloseTo(0.25, 10);
    expect(second.to - second.from).toBeCloseTo(0.25, 10);
    expect(first.length).toBeCloseTo(snap.gap, 10);
  });

  it('matches an existing gap outside the item', () => {
    /*
      Two neighbours already sit 0.50 apart and the item is dragged to about that
      distance to their left. The item's right edge should land exactly 0.50 clear of
      their left edge — a row that reads as deliberately spaced rather than nearly so.
    */
    const snap = equalSpacingSnap(bounds(-0.88, -0.68), [bounds(-0.2, 0), bounds(0.5, 0.7)], 0.1);
    expect(snap).not.toBeNull();
    expect(snap!.delta).toBeCloseTo(-0.02, 10);
    expect(snap!.gap).toBeCloseTo(0.5, 10);
  });

  it('mirrors that on the right-hand side', () => {
    // The same case reflected: an item to the right of the pair.
    const snap = equalSpacingSnap(bounds(1.18, 1.38), [bounds(-0.2, 0), bounds(0.5, 0.7)], 0.1);
    expect(snap).not.toBeNull();
    expect(snap!.delta).toBeCloseTo(0.02, 10);
  });

  it('does nothing when the difference is already too large to be a nudge', () => {
    // Gaps of 0.40 and 0.80 differ by 0.40, so half of it is a 0.20 move: far outside a
    // pointer's 8 px. Snapping here would yank the clip across the canvas.
    const snap = equalSpacingSnap(bounds(-0.2, 0), [bounds(-1.0, -0.6), bounds(0.8, 1.0)], 0.02);
    expect(snap).toBeNull();
  });

  it('declines a degenerate threshold rather than accepting every candidate', () => {
    /*
      The `NaN` trap again: every comparison against it is false, so a naive
      `Math.abs(delta) > threshold` guard accepts *everything* and the clip snaps to a
      spacing that has nothing to do with where it was dragged.
    */
    const others = [bounds(-0.4, -0.3), bounds(0.4, 0.5)];
    expect(equalSpacingSnap(bounds(-0.1, 0.1), others, Number.NaN)).toBeNull();
    expect(equalSpacingSnap(bounds(-0.1, 0.1), others, 0)).toBeNull();
    expect(equalSpacingSnap(bounds(-0.1, 0.1), others, -1)).toBeNull();
  });

  it('returns nothing with no neighbours at all', () => {
    // A lone clip on the canvas has no spacing to equalise.
    expect(equalSpacingSnap(bounds(-0.1, 0.1), [], 0.1)).toBeNull();
  });

  it('ignores a neighbour with no width', () => {
    // A degenerate bounding box would divide the canvas into meaningless gaps.
    expect(equalSpacingSnap(bounds(-0.1, 0.1), [bounds(0.4, 0.4), bounds(-0.4, -0.3)], 0.1)).toBeNull();
  });

  it('prefers the smaller move when two equal-spacings are available', () => {
    /*
      A crowded canvas offers several. The nearest one wins, because it is the one the
      user's pointer was closest to meaning — the same rule the line snaps use.
    */
    const others = [bounds(-0.4, -0.3), bounds(0.4, 0.5), bounds(-0.35, -0.34)];
    const snap = equalSpacingSnap(bounds(-0.1, 0.1), others, 0.1);
    expect(snap).not.toBeNull();
    expect(Math.abs(snap!.delta)).toBeLessThanOrEqual(0.05);
  });
});

describe('when equal-spacing may apply (SPEC 10 §8.8 precedence)', () => {
  const target = { at: 0, kind: 'canvas-centre' as const };

  it('declines on an axis where a line caught', () => {
    /*
      The precedence rule, tested where it can actually be reached. A line is the older,
      more legible answer and users already have it in their hands; a spacing hint that
      outbid it would quietly take a drag away from an edge that had caught.
    */
    expect(spacingMayApply({ position: 0, target, delta: 0.01 })).toBe(false);
  });

  it('allows it on an axis where nothing caught', () => {
    // `snapAxis` returns the unchanged position with a null target when nothing is near,
    // and that is the state spacing exists for.
    expect(spacingMayApply({ position: 0.4, target: null, delta: 0 })).toBe(true);
  });

  it('declines when snapping was suppressed entirely', () => {
    // `null` is what `Alt` produces. A user who asked to place the clip exactly must not
    // be nudged by the spacing rule either.
    expect(spacingMayApply(null)).toBe(false);
  });

  it('is not fooled by a result that has a position but no target', () => {
    /*
      The bug this function was extracted to fix: the guard read
      `snapped.x.position != null`, and `snapAxis` *always* returns a position, so the
      rule never declined and the spacing correction was computed and then thrown away by
      the commit. Testing the predicate directly is what makes that inversible mistake
      visible at the point where it is made.
    */
    expect(spacingMayApply({ position: 0.1, target: null, delta: 0 })).toBe(true);
    expect(spacingMayApply({ position: 0.1, target, delta: 0 })).toBe(false);
  });
});
