import { describe, expect, it } from 'vitest';
import {
  SNAP_PX,
  itemBounds,
  snapAxis,
  snapTargetsFor,
  snapThresholdPx,
  snappingApplies,
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
