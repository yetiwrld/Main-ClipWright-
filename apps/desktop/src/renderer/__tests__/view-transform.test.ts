/**
 * View zoom and pan (SPEC 10 §3.1, §4, §9).
 *
 * The interesting arithmetic is all in *ratios of ratios*: the preview is already fitted to
 * the panel, so a zoom is a deviation from a layout that has already divided by the canvas
 * size, and "100%" has to come out as one canvas pixel per **device** pixel through two
 * different scalings. Every expected value below is derived from the definition rather than
 * read off a run, because the failure this file exists to catch is a plausible-but-wrong
 * conversion — the kind that looks symmetric and is off by a factor of two.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PIXEL_GRID_ZOOM,
  ZOOM_PRESETS,
  clampPan,
  clampZoom,
  devicePixelsPerCanvasPixel,
  fitAndFill,
  panToKeepPoint,
  pixelGridSpacing,
  previewScale,
  stepZoom,
  zoomLabel,
} from '../features/editor/view-transform.js';

/** A 1080×1920 portrait composition in a 400×600 panel — the app's own default frame. */
const CANVAS = { width: 1080, height: 1920 };
const PANEL = { width: 400, height: 600 };

/** The fitted size that layout would actually produce: min(400/1080, 600/1920) × canvas. */
const fittedOf = (canvas = CANVAS, panel = PANEL) => {
  const { fit } = fitAndFill(canvas, panel);
  return { widthCss: canvas.width * fit, heightCss: canvas.height * fit };
};

describe('fitting a composition into a panel', () => {
  it('fits by the tighter side', () => {
    // 400/1080 = 0.37037…, 600/1920 = 0.3125 — the height is tighter, so it governs.
    const { fit, fill } = fitAndFill(CANVAS, PANEL);
    expect(fit).toBeCloseTo(600 / 1920, 10);
    expect(fill).toBeCloseTo(400 / 1080, 10);
  });

  it('always leaves fit no larger than fill', () => {
    // The pair is defined by min/max, so this is a property rather than a case: any
    // implementation that swapped them would letterbox the wrong axis.
    for (const panel of [{ width: 400, height: 600 }, { width: 900, height: 200 }]) {
      const { fit, fill } = fitAndFill(CANVAS, panel);
      expect(fit).toBeLessThanOrEqual(fill);
    }
  });

  it('refuses a degenerate panel rather than dividing by zero', () => {
    /*
      The panel is zero-sized on its first paint, before layout. Returning `Infinity` there
      would make the preview scale infinite and every gesture's conversion collapse; 0 makes
      the callers decline, which is what "not laid out yet" should mean.
    */
    for (const panel of [{ width: 0, height: 0 }, { width: Number.NaN, height: 600 }]) {
      expect(fitAndFill(CANVAS, panel)).toEqual({ fit: 0, fill: 0 });
    }
    expect(fitAndFill({ width: 0, height: 0 }, PANEL)).toEqual({ fit: 0, fill: 0 });
  });
});

describe('the scale applied to the fitted frame', () => {
  it('is exactly 1 at Fit, so nothing moves', () => {
    /*
      The most important number in this file. The preview's untransformed layout *is*
      fit-to-panel, so `fit` must be the identity — an implementation that returned the
      fit factor here would divide the frame by five and shrink it out of existence, and
      every existing measurement and test would be off by that factor.
    */
    expect(previewScale('fit', fittedOf(), CANVAS, PANEL, 1)).toBe(1);
    expect(previewScale('fit', fittedOf(), CANVAS, PANEL, 2)).toBe(1);
  });

  it('is the fill-over-fit ratio at Fill', () => {
    // Both are CSS pixels per canvas pixel, so the ratio is dimensionless: 0.37037/0.3125.
    const expected = (400 / 1080) / (600 / 1920);
    expect(previewScale('fill', fittedOf(), CANVAS, PANEL, 1)).toBeCloseTo(expected, 10);
  });

  it('is 1/screenFit at 100%, which is one canvas pixel per device pixel', () => {
    /*
      Derived rather than read: at 100% the frame should be `canvas.width / dpr` CSS pixels
      wide, and the DOM has already laid it out at `canvas.width * fit`. So the scale is
      `(1080/1) / (1080 × 0.3125)` = 1/0.3125 = 3.2.

      This is the conversion that has to be right, because it is the one the §4 pixel-
      exactness requirement names: on a 2× display a 1080-wide frame is 540 CSS pixels and
      1080 device pixels, and an implementation that forgot the dpr would draw it at 1080
      CSS pixels — twice the size — on exactly the displays where someone is checking
      sharpness.
    */
    expect(previewScale(1, fittedOf(), CANVAS, PANEL, 1)).toBeCloseTo(1 / (600 / 1920), 10);
    // On a 2× display the target is half as many CSS pixels, so the scale is half as big.
    expect(previewScale(1, fittedOf(), CANVAS, PANEL, 2)).toBeCloseTo(
      (1080 / 2) / (1080 * (600 / 1920)),
      10,
    );
  });

  it('holds the 2× relationship between dpr 1 and 2 at any zoom', () => {
    // A property rather than another number: whatever the zoom, doubling the device ratio
    // halves the scale, because the target is measured in device pixels.
    for (const zoom of [0.25, 1, 4]) {
      const at1 = previewScale(zoom, fittedOf(), CANVAS, PANEL, 1);
      const at2 = previewScale(zoom, fittedOf(), CANVAS, PANEL, 2);
      expect(at1 / at2).toBeCloseTo(2, 10);
    }
  });

  it('measures against the width layout produced, not the ideal one', () => {
    /*
      The panel has padding and the frame has a hairline, so the real fitted width is a
      little under the ideal. Using the ideal would put "100%" a pixel or two off the
      composition's true size — invisibly wrong until someone measures a pixel edge.
    */
    const ideal = fittedOf();
    const actual = { widthCss: ideal.widthCss - 4, heightCss: ideal.heightCss - 7 };
    const withIdeal = previewScale(1, ideal, CANVAS, PANEL, 1);
    const withActual = previewScale(1, actual, CANVAS, PANEL, 1);
    expect(withActual).toBeGreaterThan(withIdeal);
    expect(withActual / withIdeal).toBeCloseTo(ideal.widthCss / actual.widthCss, 10);
  });

  it('falls back to Fit for a zoom it cannot use', () => {
    /*
      Never `NaN`, and never `0` — a scale of 0 makes the frame vanish, and `NaN` makes it
      vanish differently. Both are worse than ignoring the bad value.
    */
    for (const bad of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      expect(previewScale(bad, fittedOf(), CANVAS, PANEL, 1)).toBe(1);
    }
    expect(previewScale(1, { widthCss: 0, heightCss: 0 }, CANVAS, PANEL, 1)).toBe(1);
  });
});

describe('the zoom value itself', () => {
  it('clamps into the supported range', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it('reaches past the presets, so the pixel grid is reachable', () => {
    /*
      The dropdown lists up to 400%, but §9 puts the pixel grid at 800%. A maximum at the
      last preset would make the grid unreachable except by landing a wheel exactly on it,
      which is not a control.
    */
    expect(Math.max(...ZOOM_PRESETS)).toBeLessThan(PIXEL_GRID_ZOOM);
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(PIXEL_GRID_ZOOM);
  });

  it('refuses a value that is not a number', () => {
    // The same blank-string trap as the grid's divisor: `Number('')` is 0, and 0 is not a
    // zoom — it would clamp to the minimum and shrink the frame to a stamp.
    expect(clampZoom('')).toBeNull();
    expect(clampZoom('  ')).toBeNull();
    expect(clampZoom('abc')).toBeNull();
    expect(clampZoom(null)).toBeNull();
    expect(clampZoom(0)).toBeNull();
    expect(clampZoom(-1)).toBeNull();
  });

  it('steps by a constant ratio, not a constant amount', () => {
    // 5%→6% and 400%→480% have to feel the same; an additive step makes one useless.
    expect(stepZoom(1, 1)).toBeCloseTo(1.2, 10);
    expect(stepZoom(1, -1)).toBeCloseTo(1 / 1.2, 10);
    expect(stepZoom(0.5, 1) / 0.5).toBeCloseTo(stepZoom(4, 1) / 4, 10);
  });

  it('settles at the limits rather than running away', () => {
    expect(stepZoom(MAX_ZOOM, 5)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -5)).toBe(MIN_ZOOM);
  });

  it('ignores a degenerate step', () => {
    expect(stepZoom(2, 0)).toBe(2);
    expect(stepZoom(2, Number.NaN)).toBe(2);
    // A ratio of 1 or less is not a zoom; 1 is none and 0.5 would invert it.
    expect(stepZoom(2, 1, 1)).toBe(2);
    expect(stepZoom(2, 1, 0.5)).toBe(2);
  });

  it('reads out as the toolbar shows it', () => {
    expect(zoomLabel('fit')).toBe('Fit');
    expect(zoomLabel('fill')).toBe('Fill');
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.25)).toBe('25%');
  });
});

describe('zooming about the cursor', () => {
  /*
    With the transform `translate(pan) scale(k)` about the frame's centre, a point `u`
    (fitted pixels from that centre) lands at `pan + k·u`. Holding it still while `k`
    changes gives `pan' = pan + (k' − k)·u / k`.
  */
  it('keeps a point at the centre still with no pan', () => {
    // u = 0, so nothing moves whatever the scale does.
    expect(panToKeepPoint({ x: 0, y: 0 }, 1, 4, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('slides the picture left to zoom in on something right of centre', () => {
    /*
      The sign surprises, so it is stated as a case: zooming *in* on a point to the right of
      the middle means that point must end up nearer the middle, so the frame slides left —
      a negative pan.

      p = 100 (fitted px right of centre), k: 1 → 2, so pan' = 0 + (1 − 2)·100 = −100.
      Checked against the invariant rather than only against the number.
    */
    const p = 100;
    const next = panToKeepPoint({ x: 0, y: 0 }, 1, 2, { x: p, y: 0 });
    expect(next.x).toBeCloseTo(-100, 10);
    // The point lands in the same screen place either way: pan + k·p is unchanged.
    expect(0 + 1 * p).toBeCloseTo(next.x + 2 * p, 10);
  });

  it('does not scale the correction by the current zoom', () => {
    /*
      The bug this replaced: dividing `p` by the current scale makes the correction shrink
      as you zoom in, so the point under the cursor drifts further the deeper you go. The
      same `p` must produce the same *screen* correction `(k₀ − k₁)·p` whatever `k₀` is —
      here the pan moves by exactly −p for a doubling, from 1→2 and from 2→4 alike.
    */
    const p = 60;
    const fromOne = panToKeepPoint({ x: 0, y: 0 }, 1, 2, { x: p, y: 0 });
    const fromTwo = panToKeepPoint({ x: 0, y: 0 }, 2, 4, { x: p, y: 0 });
    // 1→2 corrects by −60; 2→4 corrects by −120, because the picture is already twice as
    // big — what must not change is that the *screen* position holds.
    expect(fromOne.x).toBeCloseTo(-p, 10);
    expect(fromTwo.x).toBeCloseTo(-2 * p, 10);
    expect(0 + 2 * p).toBeCloseTo(fromTwo.x + 4 * p, 10);
  });

  it('holds the invariant for a point offset on both axes', () => {
    // Checked as the equation rather than as the number, because that is what the function
    // promises: the point under the cursor does not move.
    const p = { x: 37, y: -84 };
    const from = { x: 12, y: -30 };
    const to = panToKeepPoint(from, 2, 5, p);
    expect(from.x + 2 * p.x).toBeCloseTo(to.x + 5 * p.x, 10);
    expect(from.y + 2 * p.y).toBeCloseTo(to.y + 5 * p.y, 10);
  });

  it('leaves the pan alone for a degenerate scale', () => {
    // A zoom of 0 would divide by zero; returning the pan unchanged keeps the frame where
    // the user left it instead of throwing it across the panel.
    const pan = { x: 5, y: 7 };
    expect(panToKeepPoint(pan, 0, 2, { x: 10, y: 10 })).toEqual(pan);
    expect(panToKeepPoint(pan, Number.NaN, 2, { x: 10, y: 10 })).toEqual(pan);
  });
});

describe('bounding the pan', () => {
  const PANEL = { width: 400, height: 400 };

  it('lets the frame slide until its edge meets the panel\'s', () => {
    /*
      The limit is the *overhang*, not the size. At 800×600 in a 400×400 panel the frame
      sticks out by 200 each side, so that is how far it may move — which brings every part of
      it into view and leaves none of it lost.
    */
    expect(clampPan({ x: 9999, y: -9999 }, { width: 800, height: 600 }, PANEL)).toEqual({
      x: 200,
      y: -100,
    });
    expect(clampPan({ x: 100, y: -50 }, { width: 800, height: 600 }, PANEL)).toEqual({ x: 100, y: -50 });
  });

  it('pins the pan to nothing at Fit, where the frame is exactly the panel', () => {
    /*
      The bug the hand tool would have exposed. Bounding by half the frame's size let a drag
      push the frame half off the panel at *any* zoom, so at Fit — where the frame already
      fills the panel and there is nothing to pan to — a hand-drag would slide it out of
      view. Nobody saw it while panning was only a side-effect of zooming about the cursor,
      because that correction is small; the hand tool asks for the pointer's whole travel.
    */
    const fitted = { width: 400, height: 400 };
    expect(clampPan({ x: 9999, y: 9999 }, fitted, PANEL)).toEqual({ x: 0, y: 0 });
  });

  it('holds a frame smaller than the panel at rest, rather than forcing it off-centre', () => {
    /*
      A negative limit is worse than no clamp. Zoomed out to 200×200 inside a 400×400 panel
      the overhang computes to −100, and `min(−100, max(100, value))` returns **−100** for
      any value — so the frame would not merely be free to move, it would be *forced* to sit
      a hundred pixels off-centre with nothing the user did to cause it. The `max(0, …)` is
      what makes "no overhang" mean "no pan".
    */
    expect(clampPan({ x: 0, y: 0 }, { width: 200, height: 200 }, PANEL)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: -50, y: 50 }, { width: 200, height: 200 }, PANEL)).toEqual({ x: 0, y: 0 });
  });

  it('pins a degenerate size to zero rather than to Infinity', () => {
    // 0/2 is still 0, but a `NaN` width would make the limit `NaN` and every comparison
    // false, so the pan would escape the clamp entirely.
    expect(clampPan({ x: 50, y: 50 }, { width: Number.NaN, height: 0 }, PANEL)).toEqual({ x: 0, y: 0 });
  });

  it('pins to zero when the panel is unknown, rather than freeing the pan', () => {
    /*
      jsdom has no layout, so the panel measures zero. A missing viewport must bound to
      nothing: treating it as "no limit" would let a test pass while the app threw its frame
      off-screen, and `NaN` would not clamp at all because every comparison against it is
      false.
    */
    expect(clampPan({ x: 500, y: 500 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 500, y: 500 }, { width: 800, height: 600 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('zeroes a non-finite pan, and keeps the other axis', () => {
    /*
      500×500 in a 400 panel overhangs by 50 on each axis, so `y: 10` is a value inside the
      limit and must survive — which is what makes this a test of the `NaN` handling rather
      than of the clamp. A 100 px-tall fixture would have had *no* vertical overhang, so `y`
      would clamp to 0 for a reason that has nothing to do with `NaN`.
    */
    expect(clampPan({ x: Number.NaN, y: 10 }, { width: 500, height: 500 }, PANEL)).toEqual({
      x: 0,
      y: 10,
    });
  });
});

describe('the pixel grid', () => {
  it('appears at 800% and not before', () => {
    // SPEC 10 §9's threshold, and the reason MAX_ZOOM is above the preset list.
    expect(pixelGridSpacing(7.99)).toBeNull();
    expect(pixelGridSpacing(PIXEL_GRID_ZOOM)).toBe(8);
    expect(pixelGridSpacing(16)).toBe(16);
  });

  it('refuses a spacing that is not a number', () => {
    // Same `NaN` guard as everywhere else: every comparison against it is false, so a
    // naive `< 8` would let it through and the grid would draw at `NaN` spacing.
    expect(pixelGridSpacing(Number.NaN)).toBeNull();
    // Infinite passes a `< 8` test, and the drawing loop then runs once and leaves a stray
    // line at the frame's origin — so it is refused like the rest.
    expect(pixelGridSpacing(Number.POSITIVE_INFINITY)).toBeNull();
    expect(pixelGridSpacing(0)).toBeNull();
  });

  it('reports spacing in screen pixels, because a canvas-pixel line would be a bar', () => {
    /*
      At 800% a line one *canvas* pixel wide is eight screen pixels — a bar chart, not a
      grid. The spacing returned is therefore the number of screen pixels between lines,
      and the drawing code uses one *screen* pixel for the line itself.
    */
    expect(pixelGridSpacing(8)).toBe(8);
  });
});

describe('device pixels per canvas pixel', () => {
  it('is the zoom times the device ratio', () => {
    // The §4 pixel-exactness requirement, stated as a number: at 100% on a 2× display one
    // canvas pixel is two device pixels, so the frame is drawn at its true resolution.
    expect(devicePixelsPerCanvasPixel(1, 1)).toBe(1);
    expect(devicePixelsPerCanvasPixel(1, 2)).toBe(2);
    expect(devicePixelsPerCanvasPixel(4, 1.5)).toBe(6);
  });

  it('treats a nonsense device ratio as 1', () => {
    // jsdom reports 0; a `0` ratio would make 100% draw nothing at all.
    expect(devicePixelsPerCanvasPixel(1, 0)).toBe(1);
    expect(devicePixelsPerCanvasPixel(1, Number.NaN)).toBe(1);
  });
});
