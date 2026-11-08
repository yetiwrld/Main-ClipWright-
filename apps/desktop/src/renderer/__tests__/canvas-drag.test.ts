/**
 * On-canvas drag editing (SPEC 12 Phase 4).
 *
 * The load-bearing idea: a drag is measured in pixels but stored as a fraction of
 * the canvas, so the conversion has to know how big the canvas is on screen. These
 * tests pin that down, then the clamps that keep a drag from destroying the clip.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ROTATION,
  MIN_CROP_EXTENT,
  MIN_ROTATION,
  angleAbout,
  angleDelta,
  croppedEdge,
  handleAt,
  movedOffset,
  pixelsToFraction,
  pointerToPictureFraction,
  rotatedBy,
} from '../features/editor/canvas-drag.js';

const canvas = { width: 1080, height: 1920 };

describe('pixels to canvas fractions', () => {
  it('converts a horizontal drag against the canvas width', () => {
    expect(pixelsToFraction(108, 1080)).toBeCloseTo(0.1, 10);
  });

  it('gives the same drag a bigger fraction on a smaller preview', () => {
    /*
      The whole reason this function exists. The preview is scaled to its panel, so
      the same 108-pixel movement covers twice as much of a half-size canvas. Using
      a raw pixel delta would make the drag travel twice as far on a small window as
      on a large one — the classic "it works on my monitor" bug.
    */
    expect(pixelsToFraction(108, 1080)).toBeCloseTo(0.1, 10);
    expect(pixelsToFraction(108, 540)).toBeCloseTo(0.2, 10);
  });

  it('reports no movement for a canvas with no size', () => {
    // The panel is measured on mount and can legitimately be 0×0 for one frame.
    // Dividing by it would give Infinity or NaN, and NaN propagates silently into
    // every downstream multiply.
    expect(pixelsToFraction(50, 0)).toBe(0);
    expect(pixelsToFraction(50, Number.NaN)).toBe(0);
  });
});

describe('moving a clip (transform.x/y)', () => {
  it('adds the drag to where the clip started', () => {
    const moved = movedOffset({ x: 0.1, y: 0.2 }, { xPixels: 108, yPixels: 192 }, canvas);
    expect(moved.x).toBeCloseTo(0.2, 10);
    // Vertical travel is measured against the height, not the width.
    expect(moved.y).toBeCloseTo(0.3, 10);
  });

  it('measures vertical travel against the canvas height', () => {
    // A 192-pixel vertical drag on a 1920-tall canvas is a tenth of it. Dividing by
    // the width instead would make vertical drags feel wrong on every non-square
    // canvas, which is all of them.
    const moved = movedOffset({ x: 0, y: 0 }, { xPixels: 0, yPixels: 192 }, canvas);
    expect(moved.y).toBeCloseTo(0.1, 10);
  });

  it('treats a missing stored offset as zero rather than producing NaN', () => {
    /*
      The schema defaults `transform.x/y`, so a normal project has them; a hand-edited
      or migrated one may not. `undefined + 0.1` is `NaN`, and `NaN` multiplies
      through the transform into a layer that is not drawn at all — so a drag would
      make the clip vanish instead of move it.
    */
    const moved = movedOffset(
      { x: undefined as unknown as number, y: undefined as unknown as number },
      { xPixels: 40, yPixels: 60 },
      canvas,
    );
    expect(Number.isFinite(moved.x)).toBe(true);
    expect(Number.isFinite(moved.y)).toBe(true);
  });

  it('clamps so a clip cannot be parked far off the canvas', () => {
    // Some off-frame travel is a real edit; fifty canvas-widths is a lost clip.
    const moved = movedOffset({ x: 0.9, y: 0 }, { xPixels: 5000, yPixels: 0 }, canvas);
    expect(moved.x).toBe(1);
    expect(movedOffset({ x: -0.9, y: 0 }, { xPixels: -5000, yPixels: 0 }, canvas).x).toBe(-1);
  });

  it('clamps the result rather than the delta, so a drag back resumes from the limit', () => {
    /*
      Clamping the delta instead would accumulate a hidden offset: drag 5000 pixels
      past the edge, then drag 100 pixels back, and the clip would still be pinned —
      because the whole 5000 is "spent". Clamping the result means the 100 comes back
      immediately.
    */
    const atLimit = movedOffset({ x: 0.9, y: 0 }, { xPixels: 5000, yPixels: 0 }, canvas);
    expect(atLimit.x).toBe(1);
    const back = movedOffset(atLimit, { xPixels: -108, yPixels: 0 }, canvas);
    expect(back.x).toBeCloseTo(0.9, 10);
  });
});

describe('crop edge drags', () => {
  const start = { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 };

  it('moves only the dragged edge', () => {
    // The opposite edge is the pivot; moving it too would slide the picture rather
    // than frame it.
    const next = croppedEdge(start, 'left', 0.05);
    expect(next.left).toBeCloseTo(0.15, 10);
    expect(next.right).toBe(0.1);
    expect(next.top).toBe(0.1);
    expect(next.bottom).toBe(0.1);
  });

  it('treats a positive drag on the right edge as pulling it in', () => {
    /*
      Dragging right-ward on the right handle must crop more, not less: the handle is
      the edge, and moving it toward the picture's middle removes more of the picture.
      Getting this sign wrong is invisible in a symmetric fixture — which is why the
      assertion is directional rather than just "changed".
    */
    const next = croppedEdge(start, 'right', 0.05);
    expect(next.right).toBeCloseTo(0.05, 10);
    expect(next.left).toBe(0.1);
  });

  it('pulls the bottom edge in on a downward drag', () => {
    const next = croppedEdge(start, 'bottom', 0.05);
    expect(next.bottom).toBeCloseTo(0.05, 10);
  });

  it('never lets an edge pass zero', () => {
    // A negative crop has no meaning in the model and would enlarge the picture
    // past its own borders everywhere downstream.
    expect(croppedEdge(start, 'left', -0.5).left).toBe(0);
    expect(croppedEdge(start, 'right', 0.5).right).toBe(0);
    expect(croppedEdge(start, 'top', -0.5).top).toBe(0);
    expect(croppedEdge(start, 'bottom', 0.5).bottom).toBe(0);
  });

  it('stops an edge short of its opposite rather than inverting the picture', () => {
    /*
      `left` and `right` are both fractions of the *source*, so they must sum to less
      than one or the remaining picture has negative width. The bound is therefore
      `1 - opposite - MIN_CROP_EXTENT`, and with a right crop of 0.1 the left edge can
      reach 0.88 — not 0.95, which the schema's per-edge ceiling would suggest.
    */
    const next = croppedEdge(start, 'left', 1);
    expect(next.left).toBeCloseTo(1 - 0.1 - MIN_CROP_EXTENT, 10);
    expect(next.left + next.right).toBeLessThan(1);
  });

  it('leaves a sliver rather than nothing', () => {
    // A zero-width crop divides by zero: the CSS uses it as a percentage
    // denominator and the export's filter chain scales by it.
    const next = croppedEdge({ left: 0, top: 0, right: 0, bottom: 0 }, 'left', 5);
    expect(next.left).toBeCloseTo(1 - MIN_CROP_EXTENT, 10);
    expect(next.left).toBeLessThan(1);
  });

  it('treats a missing stored crop as zero', () => {
    // Same reasoning as a missing offset: a stale project must not be able to turn a
    // crop drag into `NaN`, which would blank the picture.
    const next = croppedEdge(
      { left: undefined as unknown as number, top: undefined as unknown as number, right: 0.1, bottom: 0 },
      'left',
      0.05,
    );
    expect(next.left).toBeCloseTo(0.05, 10);
    expect(next.top).toBe(0);
  });

  it('ignores a drag that is not a number', () => {
    const next = croppedEdge(start, 'left', Number.NaN);
    expect(next).toEqual(start);
  });
});

describe('finding the handle under the pointer', () => {
  const rect = { x: 100, y: 100, width: 400, height: 600 };

  it('reports the middle of the clip as the move grip', () => {
    expect(handleAt({ x: 300, y: 400 }, rect)).toBeNull();
  });

  it('finds an edge near the pointer', () => {
    expect(handleAt({ x: 104, y: 400 }, rect)).toBe('left');
    expect(handleAt({ x: 496, y: 400 }, rect)).toBe('right');
    expect(handleAt({ x: 300, y: 106 }, rect)).toBe('top');
    expect(handleAt({ x: 300, y: 694 }, rect)).toBe('bottom');
  });

  it('picks one edge at a corner rather than two', () => {
    // A corner that resolved to both edges would drag them together, which no
    // single-pointer drag can express.
    const corner = handleAt({ x: 103, y: 104 }, rect);
    expect(['left', 'top']).toContain(corner);
  });

  it('finds no handle well outside the clip', () => {
    expect(handleAt({ x: 900, y: 900 }, rect)).toBeNull();
  });
});

describe('the rotate handle (SPEC 10 §8.2)', () => {
  const pivot = { x: 100, y: 100 };

  it('reads straight up as zero', () => {
    // The handle sits above the picture, so "no turn yet" is the pointer being
    // directly above the pivot. Any other zero would make the first degree of every
    // drag jump the clip.
    expect(angleAbout(pivot, { x: 100, y: 0 })).toBeCloseTo(0, 6);
  });

  it('increases clockwise, which is the direction the model stores', () => {
    // `transform.rotation` is degrees clockwise, and CSS space has +y down, so this
    // needs no sign flip. A flip here would make the handle turn the opposite way to
    // the picture, which is the single most confusing thing a rotate handle can do.
    expect(angleAbout(pivot, { x: 200, y: 100 })).toBeCloseTo(90, 6);
    expect(angleAbout(pivot, { x: 100, y: 200 })).toBeCloseTo(180, 6);
    expect(angleAbout(pivot, { x: 0, y: 100 })).toBeCloseTo(-90, 6);
  });

  it('measures a quarter turn as a quarter turn', () => {
    const from = angleAbout(pivot, { x: 100, y: 0 });
    const to = angleAbout(pivot, { x: 200, y: 100 });
    expect(angleDelta(from, to)).toBeCloseTo(90, 6);
  });

  it('takes the short way across the wrap', () => {
    /*
      The bug this exists to prevent: a pointer at 170° dragged to −170° has moved 20°
      clockwise, but the raw subtraction is −340°, which would spin the clip three
      quarters of a turn the wrong way. Every rotate handle has this bug until someone
      drags past the seam.
    */
    expect(angleDelta(170, -170)).toBeCloseTo(20, 6);
    expect(angleDelta(-170, 170)).toBeCloseTo(-20, 6);
  });

  it('never reports more than half a turn for one sample', () => {
    // A delta beyond ±180 cannot be distinguished from its complement, so reporting a
    // smaller number is both correct and what keeps a fast drag from overshooting.
    expect(Math.abs(angleDelta(0, 179))).toBeLessThanOrEqual(180);
    expect(Math.abs(angleDelta(0, -179))).toBeLessThanOrEqual(180);
  });

  it('wraps past a whole turn instead of jamming at the limit', () => {
    /*
      The model stores −180…180. A drag from 170° that adds 90° would reach 260, and
      clamping there would pin the clip while the handle kept moving under the
      pointer. Wrapping keeps the picture following the handle.
    */
    expect(rotatedBy(170, 90)).toBeCloseTo(-100, 6);
    expect(rotatedBy(-170, -90)).toBeCloseTo(100, 6);
  });

  it('keeps an in-range result untouched', () => {
    expect(rotatedBy(10, 20)).toBeCloseTo(30, 6);
    expect(rotatedBy(0, 0)).toBe(0);
  });

  it('ignores a drag that is not a number', () => {
    // A pointer sample can arrive as NaN if a client rect is 0×0; NaN would propagate
    // into the transform and make the layer vanish.
    expect(rotatedBy(15, Number.NaN)).toBe(15);
  });

  it('does not manufacture NaN from a missing starting rotation', () => {
    /*
      The first version of this guarded only `delta`, so a `start` that had arrived as
      `undefined` — a hand-written fixture, or a project whose transform predates the
      field — sailed through as `undefined + delta` and reached the document as `NaN`.
      A NaN rotation blanks the layer silently: nothing throws, the picture is simply
      not drawn. The guard belongs on the result.
    */
    const next = rotatedBy(undefined as unknown as number, 30);
    expect(Number.isFinite(next)).toBe(true);
    expect(next).toBeCloseTo(30, 6);
  });

  it('reports a result inside the model range for any drag', () => {
    for (const start of [-180, -90, 0, 90, 180]) {
      for (const delta of [-720, -181, -1, 0, 1, 179, 721]) {
        const next = rotatedBy(start, delta);
        expect(next).toBeGreaterThanOrEqual(MIN_ROTATION);
        expect(next).toBeLessThanOrEqual(MAX_ROTATION);
      }
    }
  });
});

describe('aiming the anchor crosshair at a transformed picture', () => {
  const size = { width: 400, height: 600 };
  /** Unrotated, unscaled: the bounding box is the element. */
  const plain = { box: { left: 0, top: 0, width: 400, height: 600 }, size, rotation: 0, scaleX: 1, scaleY: 1 };

  it('is the identity when the picture is untouched', () => {
    // The case that makes every other one trustworthy: no transform, so aiming at a
    // point gives that point.
    expect(pointerToPictureFraction({ x: 200, y: 300 }, plain)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerToPictureFraction({ x: 0, y: 0 }, plain)).toEqual({ x: 0, y: 0 });
    expect(pointerToPictureFraction({ x: 400, y: 600 }, plain)).toEqual({ x: 1, y: 1 });
  });

  it('undoes a rotation rather than measuring the bounding box', () => {
    /*
      Measuring the axis-aligned box is the bug this replaces: a 90° turn swaps the
      box's axes, so a fraction taken from it is measured against the wrong side and
      a crosshair lands where the user did not point.

      A 400×600 element turned 90° has a 600×400 box on the same centre. With forward
      `rotate(+90deg)` being clockwise, a local point at (+right, 0) appears *below*
      the centre on screen — so pointing above the centre must invert to the picture's
      LEFT edge.
    */
    const rotated = {
      box: { left: -100, top: 100, width: 600, height: 400 },
      size,
      rotation: 90,
      scaleX: 1,
      scaleY: 1,
    };
    const above = pointerToPictureFraction({ x: 200, y: 100 }, rotated);
    expect(above.x).toBeCloseTo(0, 6);
    expect(above.y).toBeCloseTo(0.5, 6);

    // And the picture's top edge, which now faces right, is to the right on screen.
    const rightOfCentre = pointerToPictureFraction({ x: 500, y: 300 }, rotated);
    expect(rightOfCentre.x).toBeCloseTo(0.5, 6);
    expect(rightOfCentre.y).toBeCloseTo(0, 6);
  });

  it('undoes a scale so the fraction lands where the picture is drawn', () => {
    /*
      A regression guard rather than a discriminator, and worth saying so: measuring
      the bounding box happens to survive pure scaling, because scaling about the
      centre and then measuring the scaled box is the same linear map as measuring and
      then scaling. Only *rotation* breaks box arithmetic, since the box stops being
      axis-aligned with the picture — the test below is the one that catches that.

      What this holds is the arithmetic's shape: a sign error or an off-by-the-centre
      mistake in the unscale step fails here and would not fail anywhere else.
    */
    const scaled = {
      box: { left: -200, top: -300, width: 800, height: 1200 },
      size,
      rotation: 0,
      scaleX: 2,
      scaleY: 2,
    };
    expect(pointerToPictureFraction({ x: -200, y: 300 }, scaled)).toEqual({ x: 0, y: 0.5 });
    expect(pointerToPictureFraction({ x: 600, y: 300 }, scaled)).toEqual({ x: 1, y: 0.5 });
  });

  it('clamps a pointer that wandered off the picture', () => {
    // Position is stored as 0–1 of the item; a value outside that is not a place on
    // the picture, and a crosshair parked off its own edge cannot be grabbed back.
    const off = pointerToPictureFraction({ x: 5000, y: -5000 }, plain);
    expect(off).toEqual({ x: 1, y: 0 });
  });

  it('survives a zero-sized element', () => {
    // The panel can measure 0×0 for a frame on mount; dividing by it gives NaN, and a
    // NaN anchor silently blanks the layer.
    const collapsed = {
      box: { left: 0, top: 0, width: 0, height: 0 },
      size: { width: 0, height: 0 },
      rotation: 0,
      scaleX: 0,
      scaleY: 0,
    };
    const result = pointerToPictureFraction({ x: 10, y: 10 }, collapsed);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
  });
});
