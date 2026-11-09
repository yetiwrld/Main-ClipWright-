// @vitest-environment jsdom
/**
 * Reframing — dragging the picture under a fixed canvas rectangle (SPEC 10 §8.6).
 *
 * The gesture's arithmetic is pure and is what is tested here; the pointer plumbing lives in
 * `CropFrame`'s sibling component and is covered by the preview suite. The interesting claims
 * are all about *coverage* — a reframe that exposes empty canvas is the failure §13's acceptance
 * criteria name explicitly ("no empty canvas exposed") — so most of these tests are about where
 * the picture is allowed to be, not about how far the pointer moved.
 */

import { describe, expect, it } from 'vitest';

import {
  REFRAME_MAX_SCALE,
  REFRAME_MIN_SCALE,
  framingChanged,
  framingPaths,
  framingValues,
  reframeCoverage,
  reframedOffset,
  reframedScale,
  roundFraming,
} from '../reframe.js';
import { pictureBox } from '../ReframeFrame.js';

/** A 16:9 picture in a 9:16 canvas: the case reframing exists for. */
const SOURCE_ASPECT = 16 / 9;
const CANVAS_ASPECT = 9 / 16;

describe('what the picture covers', () => {
  it('is as wide as the canvas at scale 1, and as tall as its own aspect makes it', () => {
    /*
      The preview draws the picture in a box whose `aspectRatio` is the source's, at
      `width: 100%` of the canvas. So an unscaled 16:9 picture in a 9:16 canvas is a band
      0.3164 of the canvas tall — a *fit*, not a *fill*, and the numbers have to match what the
      user sees rather than an idealised cover.
    */
    const coverage = reframeCoverage(1, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(coverage.width).toBe(1);
    /*
      height = canvasAspect / sourceAspect = 0.5625 / 1.7778 = 0.3164. (My first version of this
      assertion was an expression that simplified to something near 1 and passed only for the
      wrong reason — the plain form below is the one that states the claim.)
    */
    expect(coverage.height).toBeCloseTo(CANVAS_ASPECT / SOURCE_ASPECT, 10);
    expect(coverage.height).toBeCloseTo(0.31640625, 8);
  });

  it('grows with the scale on both axes', () => {
    const doubled = reframeCoverage(2, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(doubled.width).toBe(2);
    expect(doubled.height).toBeCloseTo((2 * CANVAS_ASPECT) / SOURCE_ASPECT, 10);
  });

  it('covers the canvas on an axis once the scale is big enough', () => {
    /*
      The scale at which a 16:9 picture finally covers a 9:16 canvas vertically is
      sourceAspect/canvasAspect = 3.16. Below that no vertical position exists that avoids empty
      canvas, which is exactly why the reframe gesture has a zoom at all.
    */
    const needed = SOURCE_ASPECT / CANVAS_ASPECT;
    expect(reframeCoverage(needed - 0.01, SOURCE_ASPECT, CANVAS_ASPECT).height).toBeLessThan(1);
    expect(reframeCoverage(needed, SOURCE_ASPECT, CANVAS_ASPECT).height).toBeCloseTo(1, 10);
  });

  it('is empty rather than NaN for a degenerate size', () => {
    // A NaN coverage would propagate into the offset clamp and blank the layer.
    for (const bad of [
      reframeCoverage(Number.NaN, SOURCE_ASPECT, CANVAS_ASPECT),
      reframeCoverage(1, 0, CANVAS_ASPECT),
      reframeCoverage(1, SOURCE_ASPECT, 0),
      reframeCoverage(-1, SOURCE_ASPECT, CANVAS_ASPECT),
    ]) {
      expect(bad).toStrictEqual({ width: 0, height: 0 });
    }
  });
});

describe('dragging the picture', () => {
  it('moves the picture with the drag, not against it', () => {
    /*
      The sign that makes the gesture read as "grab the shot and slide it". A crop-window drag
      has the opposite sign, and copying that one here would make the picture move backwards
      under the pointer — visible immediately, but only if anyone drags it.
    */
    const moved = reframedOffset({ x: 0, y: 0 }, { x: 0.1, y: 0 }, { width: 2, height: 2 });
    expect(moved.x).toBeCloseTo(0.1, 10);
  });

  it('stops where the picture would stop covering the canvas', () => {
    /*
      A 2-wide picture covers from -0.5 to 1.5 when centred, so its centre may travel to ±0.5
      before an edge comes inside the frame. Half of the *overhang* (2 − 1) is 0.5 — anything
      past that exposes canvas, which §13's acceptance criteria forbid.
    */
    const far = reframedOffset({ x: 0, y: 0 }, { x: 9, y: 0 }, { width: 2, height: 2 });
    expect(far.x).toBeCloseTo(0.5, 10);
    const back = reframedOffset({ x: 0, y: 0 }, { x: -9, y: 0 }, { width: 2, height: 2 });
    expect(back.x).toBeCloseTo(-0.5, 10);
  });

  it('holds a picture that cannot cover the axis at the centre', () => {
    /*
      The case that a naive clamp gets wrong. A 16:9 picture at scale 1 is 0.3164 of a 9:16
      canvas tall, so there is *no* vertical position that covers — and a clamp written as
      `min(limit, max(-limit, …))` with a negative limit would put the picture at a nonsense
      offset. Centred is the only honest answer, and it is what `max(0, …)` on the limit gives.
    */
    const tall = reframedOffset(
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      reframeCoverage(1, SOURCE_ASPECT, CANVAS_ASPECT),
    );
    expect(tall.y).toBe(0);
    // The horizontal axis *can* move at scale 1, since the picture is exactly as wide.
    expect(reframedOffset({ x: 0, y: 0 }, { x: 5, y: 0 }, reframeCoverage(1, SOURCE_ASPECT, CANVAS_ASPECT)).x).toBe(0);
  });

  it('takes an offset in one jump and clamps it once', () => {
    // A drag reported as one large delta must land where a thousand small ones would: clamping
    // is on the result, not on the step, so there is no drift to accumulate.
    const stepped = [0.05, 0.1, 0.15].reduce(
      (position, delta) => reframedOffset(position, { x: delta, y: 0 }, { width: 1.5, height: 1.5 }),
      { x: 0, y: 0 },
    );
    const jumped = reframedOffset({ x: 0, y: 0 }, { x: 0.3, y: 0 }, { width: 1.5, height: 1.5 });
    expect(stepped.x).toBeCloseTo(jumped.x, 10);
  });

  it('refuses nonsense rather than producing a NaN framing', () => {
    expect(reframedOffset({ x: Number.NaN, y: 0 }, { x: 0, y: 0 }, { width: 2, height: 2 }).x).toBe(0);
    expect(reframedOffset({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { width: 2, height: 2 }).x).toBe(0);
  });
});

describe('scaling the picture', () => {
  it('clamps to the schema the framing field shares', () => {
    // `InitialFramingSchema` allows 0.1–10; leaving that range would make a stored framing fail
    // its own schema, which is the sort of failure that only shows up on reload.
    const huge = reframedScale({ x: 0, y: 0, scale: 1 }, 1000, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(huge.scale).toBe(REFRAME_MAX_SCALE);
    const tiny = reframedScale({ x: 0, y: 0, scale: 1 }, 0.0001, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(tiny.scale).toBe(REFRAME_MIN_SCALE);
  });

  it('re-clamps the offset at the new size', () => {
    /*
      The bug this prevents: zoom out while the picture is at the far edge of its coverage, and
      the offset that was legal at the larger size now exposes canvas. Shrinking must pull the
      picture back to the middle, not leave it hanging off the window.
    */
    const framed = reframedScale({ x: 0.5, y: 0, scale: 2 }, 0.25, SOURCE_ASPECT, CANVAS_ASPECT);
    const limit = Math.max(0, (framed.scale - 1) / 2);
    expect(Math.abs(framed.x)).toBeLessThanOrEqual(limit + 1e-12);
  });

  it('keeps a framing that is still legal exactly where it is', () => {
    // Zooming *in* from a centred framing must not move it: there is more room, not less.
    const framed = reframedScale({ x: 0, y: 0, scale: 2 }, 2, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(framed).toStrictEqual({ x: 0, y: 0, scale: 4 });
  });
});

describe('what gets written', () => {
  it('names the four paths a framing is', () => {
    expect(framingPaths()).toStrictEqual([
      'transform.x',
      'transform.y',
      'transform.scaleX',
      'transform.scaleY',
    ]);
  });

  it('pairs each value with its own path', () => {
    /*
      Asserted as a pairing rather than as two separate lists, because the bug this guards is a
      *permutation*: writing x to `scaleX` would pass any test that checked the four numbers were
      present.
    */
    const values = framingValues({ x: 0.25, y: -0.5, scale: 3 });
    expect(values).toStrictEqual([0.25, -0.5, 3, 3]);
    const paired = Object.fromEntries(framingPaths().map((path, index) => [path, values[index]]));
    expect(paired).toStrictEqual({
      'transform.x': 0.25,
      'transform.y': -0.5,
      'transform.scaleX': 3,
      'transform.scaleY': 3,
    });
  });

  it('rounds to a fraction of a pixel, so two equal framings compare equal', () => {
    /*
      `-0.0000001` rounds to `-0`, and `toStrictEqual` treats `-0` and `+0` as different — the
      same trap the pan clamp hit. `roundFraming` folds it with `+ 0`, which this asserts by
      round-tripping through `Object.is` on the sign.
    */
    const messy = roundFraming({ x: 0.07333333333333333, y: -0.0000001, scale: 1.0000000001 });
    expect(messy).toStrictEqual({ x: 0.073333, y: 0, scale: 1 });
    expect(Object.is(messy.y, -0)).toBe(false);
  });
});

describe('a gesture that changed nothing', () => {
  it('is not an edit', () => {
    // `Enter` on an untouched frame must push no undo step, or the next `Ctrl+Z` looks broken.
    expect(framingChanged({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0, scale: 1 })).toBe(false);
  });

  it('tolerates floating-point noise in either direction', () => {
    // The gesture's own arithmetic leaves ulps behind; exact equality would record a change
    // for a drag that returned exactly to its start.
    expect(framingChanged({ x: 0.2, y: 0 }, { x: 0.2 + 1e-12, y: 0 })).toBe(false);
    expect(framingChanged({ x: 0.2, y: 0 }, { x: 0.2 - 1e-12, y: 0 })).toBe(false);
  });

  it('notices a change on any single axis', () => {
    // All three, because the early-return structure invites one of them being forgotten.
    expect(framingChanged({ x: 0, y: 0, scale: 1 }, { x: 0.01, y: 0, scale: 1 })).toBe(true);
    expect(framingChanged({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0.01, scale: 1 })).toBe(true);
    expect(framingChanged({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0, scale: 1.01 })).toBe(true);
  });

  it('treats a missing field as its default, not as a change', () => {
    // A stored framing may simply not have a key yet; `undefined` and `0` are the same framing.
    expect(framingChanged({}, { x: 0, y: 0, scale: 0 })).toBe(false);
  });
});

describe('the picture outline (what the user actually sees move)', () => {
  /*
    `pictureBox` lives in the component file because it is presentation, but it is pure and it is
    the only feedback the gesture has — so it is tested here rather than left to a DOM assertion
    that would mostly be checking CSS.
  */
  it('centres a 16:9 picture as a band in a 9:16 window', () => {
    const box = pictureBox({ x: 0, y: 0, scale: 1 }, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(box.width).toBe('100%');
    expect(box.height).toBe('31.641%');
    // Centred: the leftover 68.359% splits evenly, so the top is 34.18%.
    expect(box.left).toBe('0%');
    expect(box.top).toBe('34.18%');
  });

  it('moves the band with the framing, in the framing\'s own direction', () => {
    /*
      A positive `y` moves the picture *down* the window, so its top edge moves down the page and
      `top` grows. I wrote this assertion the other way round first — the intuition "the window
      moves up over the picture" belongs to the crop gesture, and this is the opposite one.
    */
    const down = pictureBox({ x: 0, y: 0.1, scale: 1 }, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(down.top).toBe('44.18%');
    expect(down.height).toBe('31.641%');
  });

  it('grows the box with the scale rather than cropping it', () => {
    const zoomed = pictureBox({ x: 0, y: 0, scale: 2 }, SOURCE_ASPECT, CANVAS_ASPECT);
    expect(zoomed.width).toBe('200%');
    expect(zoomed.height).toBe('63.281%');
  });
});
