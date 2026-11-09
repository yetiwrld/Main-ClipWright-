/**
 * On-canvas drag editing (SPEC 12 Phase 4).
 *
 * The load-bearing idea: a drag is measured in pixels but stored as a fraction of
 * the canvas, so the conversion has to know how big the canvas is on screen. These
 * tests pin that down, then the clamps that keep a drag from destroying the clip.
 */
import { describe, expect, it } from 'vitest';
import { SNAP_PX, snapThresholdPx } from '../features/editor/snapping.js';
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
  cornerAt,
  cornerScaleFactor,
  freeScaleAboutCorner,
  lockedAxis,
  oppositeCorner,
  pointerToPictureFraction,
  rotatedBy,
  signForOppositeEdge,
  edgeScale,
  scaleAboutCentre,
  scaleAboutCorner,
  scaleAboutEdge,
  snapRotation,
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

describe('corner grips', () => {
  it('names the corner across from the one being dragged', () => {
    // The corner that stays put, which is the whole contract of the gesture.
    expect(oppositeCorner('nw')).toBe('se');
    expect(oppositeCorner('ne')).toBe('sw');
    expect(oppositeCorner('se')).toBe('nw');
    expect(oppositeCorner('sw')).toBe('ne');
  });

  it('finds a corner at each corner of an unrotated picture', () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    expect(cornerAt({ x: 100, y: 100 }, rect, 0)).toBe('nw');
    expect(cornerAt({ x: 300, y: 100 }, rect, 0)).toBe('ne');
    expect(cornerAt({ x: 300, y: 200 }, rect, 0)).toBe('se');
    expect(cornerAt({ x: 100, y: 200 }, rect, 0)).toBe('sw');
  });

  it('finds a corner on the rotated box, not the axis-aligned one', () => {
    /*
      A 200×100 picture turned 90° has its corners at the *swapped* extents. Reading
      the unrotated box would put the grips where the picture is not — the same mistake
      the anchor crosshair made before it was aimed through the transform.
    */
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    const centre = { x: 200, y: 150 };
    /*
      Rotated 90° clockwise, the picture is 100 wide and 200 tall about the same
      centre — and the names travel with the picture, not with the screen. The corner
      that *was* north-west now sits where north-east used to be, so the point at the
      top-left of the rotated box is `sw`. Getting this backwards was my first
      expectation here; the arithmetic was right and the label was not.
    */
    expect(cornerAt({ x: centre.x - 50, y: centre.y - 100 }, rect, 90)).toBe('sw');
    expect(cornerAt({ x: centre.x + 50, y: centre.y - 100 }, rect, 90)).toBe('nw');
    // And the unrotated corner is no longer a corner at all.
    expect(cornerAt({ x: 100, y: 100 }, rect, 90)).toBeNull();
  });

  it('ignores a pointer that is nowhere near a corner', () => {
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    expect(cornerAt({ x: 100, y: 50 }, rect, 0)).toBeNull();
  });

  it('scales by the ratio of the distance to the fixed corner', () => {
    // Pulling a corner to twice its original distance from the fixed one doubles the
    // scale; the gesture is radial, so only the distance matters.
    const fixed = { x: 0, y: 0 };
    expect(cornerScaleFactor({ x: 200, y: 0 }, fixed, 100)).toBeCloseTo(2, 10);
    expect(cornerScaleFactor({ x: 0, y: 50 }, fixed, 100)).toBeCloseTo(0.5, 10);
    // A diagonal pull is still measured by distance, not by one axis.
    expect(cornerScaleFactor({ x: 300, y: 400 }, fixed, 250)).toBeCloseTo(2, 10);
  });

  it('refuses to invent a scale from a degenerate start', () => {
    // A zero start distance would divide by zero, and a NaN scale blanks the layer
    // silently rather than throwing. Returning 1 means "no change".
    const fixed = { x: 0, y: 0 };
    expect(cornerScaleFactor({ x: 100, y: 0 }, fixed, 0)).toBe(1);
    expect(cornerScaleFactor({ x: 100, y: 0 }, fixed, Number.NaN)).toBe(1);
  });
});

describe('scaling about the opposite corner', () => {
  const base = {
    corner: 'nw' as const,
    anchorX: 0.5,
    anchorY: 0.5,
    width: 200,
    height: 100,
    rotation: 0,
  };
  const canvas = { width: 1000, height: 800 };

  it('moves the position so the fixed corner does not move', () => {
    /*
      Dragging the north-west corner outward doubles the scale, and the south-east
      corner has to stay exactly where it is. Growing about a fixed south-east corner
      pushes the centre *toward* the north-west one — up and left — by half the
      picture's new size. In fractions of a 1000×800 canvas that is −100/1000 and
      −50/800.

      The sign is the whole test: I first wrote it positive, imaging the picture
      growing away from the corner being dragged. It grows away from the corner that is
      *held*, which is the opposite one.
    */
    const position = scaleAboutCorner(
      { ...base, fromScale: { x: 1, y: 1 }, toScale: { x: 2, y: 2 } },
      { x: 0, y: 0 },
      canvas,
    );
    expect(position.x).toBeCloseTo(-100 / 1000, 10);
    expect(position.y).toBeCloseTo(-50 / 800, 10);
  });

  it('keeps the fixed corner still when the two axes scale differently', () => {
    /*
      The bug that survived every existing test. The compensation used to average the two
      axes into one delta and apply it to both components, which is right *only* while the
      scale stays uniform — so the tests above, which all use a uniform factor, could not
      see it. Halving the axes apart exposes it: widening only, with the height untouched,
      must move the picture purely horizontally. The averaged version moved it vertically
      too (by 0.03125 here), sliding the "fixed" corner down the screen.

      Expected values derived, not guessed: the fixed point is `se` at (+100, +50) from the
      centre, so a width-only change gives `(1 − 2) · 100 = −100` px in x and exactly `0` in
      y, i.e. −0.1 and 0 in fractions of a 1000×800 canvas.
    */
    const widen = scaleAboutCorner(
      { ...base, fromScale: { x: 1, y: 1 }, toScale: { x: 2, y: 1 } },
      { x: 0, y: 0 },
      canvas,
    );
    expect(widen.x).toBeCloseTo(-100 / 1000, 10);
    // Exactly zero: a height that never changed must not displace the picture at all.
    expect(widen.y).toBeCloseTo(0, 10);

    const heighten = scaleAboutCorner(
      { ...base, fromScale: { x: 1, y: 1 }, toScale: { x: 1, y: 2 } },
      { x: 0, y: 0 },
      canvas,
    );
    expect(heighten.x).toBeCloseTo(0, 10);
    expect(heighten.y).toBeCloseTo(-50 / 800, 10);
  });

  it('compensates from the anchor, not from the picture centre', () => {
    /*
      Scaling happens about the anchor, so the arm from the anchor to the content grows
      with the scale — and the compensating move must be measured from the anchor too.
      An off-centre anchor therefore changes the answer, and a "move the centre"
      shortcut would drift the picture a little on every scale.
    */
    const centred = scaleAboutCorner(
      { ...base, fromScale: { x: 1, y: 1 }, toScale: { x: 2, y: 2 } },
      { x: 0, y: 0 },
      canvas,
    );
    const offsetAnchor = scaleAboutCorner(
      {
        ...base,
        anchorX: 0.25,
        anchorY: 0.25,
        fromScale: { x: 1, y: 1 },
        toScale: { x: 2, y: 2 },
      },
      { x: 0, y: 0 },
      canvas,
    );
    expect(offsetAnchor.x).not.toBeCloseTo(centred.x, 6);
  });

  it('holds the opposite corner still through a rotation as well', () => {
    /*
      The rotating case is the one a shortcut gets wrong: the arm is rotated into
      screen axes, so the compensation is not a diagonal move but the arm turned by the
      clip's angle. Verified by placing the fixed corner before and after.
    */
    const rotation = 37;
    const radians = (rotation * Math.PI) / 180;
    const placedCorner = (position: { x: number; y: number }, scale: number) => {
      // The model's own formula: offset = position + R·(0.5 − anchor)·size·scale.
      const armX = (0.5 - 0.5) * 200 * scale;
      const armY = (0.5 - 0.5) * 100 * scale;
      const offsetX = position.x + (Math.cos(radians) * armX - Math.sin(radians) * armY);
      const offsetY = position.y + (Math.sin(radians) * armX + Math.cos(radians) * armY);
      // The south-east corner is (+w/2, +h/2) from the picture's centre, scaled.
      const cornerX = (200 / 2) * scale;
      const cornerY = (100 / 2) * scale;
      return {
        x: (offsetX + (Math.cos(radians) * cornerX - Math.sin(radians) * cornerY) / 1000) * 1000,
        y: (offsetY + (Math.sin(radians) * cornerX + Math.cos(radians) * cornerY) / 800) * 800,
      };
    };
    const start = { x: 0.1, y: -0.05 };
    const before = placedCorner(start, 1);
    const moved = scaleAboutCorner(
      { ...base, rotation, fromScale: { x: 1, y: 1 }, toScale: { x: 1.8, y: 1.8 } },
      start,
      canvas,
    );
    const after = placedCorner(moved, 1.8);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('does nothing when the scale did not change', () => {
    const position = scaleAboutCorner(
      { ...base, fromScale: { x: 1, y: 1 }, toScale: { x: 1, y: 1 } },
      { x: 0.2, y: 0.3 },
      canvas,
    );
    expect(position).toEqual({ x: 0.2, y: 0.3 });
  });
});

describe('the Shift and Alt modifiers (SPEC 10 §8.2)', () => {
  it('locks a move to whichever axis the pointer has travelled furthest along', () => {
    /*
      A locked move has to commit to a direction rather than track the pointer's
      instantaneous dominant axis, or it flickers between the two while the pointer
      wanders near the diagonal. Comparing total travel gives one stable answer.
    */
    expect(lockedAxis({ xPixels: 10, yPixels: 3 })).toBe('x');
    expect(lockedAxis({ xPixels: 3, yPixels: 10 })).toBe('y');
    // Sign is not direction of travel: a long drag to the left still locks x.
    expect(lockedAxis({ xPixels: -10, yPixels: 3 })).toBe('x');
    // A tie is broken one way consistently, so the two axes cannot both claim it.
    expect(lockedAxis({ xPixels: 10, yPixels: 10 })).toBe('x');
    expect(lockedAxis({ xPixels: 0, yPixels: 0 })).toBe('x');
  });

  it('snaps a rotation to 15° steps', () => {
    expect(snapRotation(0)).toBe(0);
    expect(snapRotation(7)).toBe(0);
    expect(snapRotation(8)).toBe(15);
    expect(snapRotation(22)).toBe(15);
    expect(snapRotation(23)).toBe(30);
    expect(snapRotation(44.9)).toBe(45);
  });

  it('gets the cardinals for free from the 15° rule', () => {
    /*
      SPEC 10 §8.2 lists "15° steps; snapping also at 0/90/180/270" as though the
      cardinals were a second rule. They are multiples of 15, so one rule covers both —
      and having one means there is no tie for two rules to disagree over.
    */
    for (const cardinal of [0, 90, 180, 270]) {
      // `% 15` yields `-0` for an exact negative multiple, and `toBe(0)` fails on it —
      // so compare the distance to the nearest step rather than the remainder.
      const snapped = snapRotation(cardinal);
      expect(Math.abs(snapped / 15 - Math.round(snapped / 15))).toBeLessThan(1e-9);
    }
    // 90 is already a snap point, so a drag just short of it lands exactly on it.
    expect(snapRotation(88)).toBe(90);
    expect(snapRotation(92)).toBe(90);
  });

  it('wraps a snapped rotation into the model range', () => {
    /*
      -179 snaps to the antipode, and the model's range is closed at both ends — -180
      and 180 are the same angle with two representatives. So the assertion is that the
      *angle* is in range, not that it picked one of the two spellings. Asserting a
      particular spelling was my first version and it failed on correct code.
    */
    const wrapped = snapRotation(-179);
    expect(Math.abs(wrapped)).toBeLessThanOrEqual(180);
    expect(Math.abs(wrapped)).toBe(180);
    // And it is a proper 15° step, not the raw -179.
    expect(Math.abs(wrapped / 15 - Math.round(wrapped / 15))).toBeLessThan(1e-9);
  });

  it('solves a free scale per axis in the picture’s frame', () => {
    /*
      `Shift` toggles uniform into free scale. The pointer is carried back through the
      clip's rotation before the two axes are solved, so the axes follow the picture
      rather than the screen.
    */
    const fixed = { x: 0, y: 0 };
    const free = freeScaleAboutCorner(
      { x: 400, y: 50 },
      { fixed, start: { x: 200, y: 100 }, startScale: { x: 1, y: 1 }, rotation: 0 },
    );
    expect(free.x).toBeCloseTo(2, 10);
    expect(free.y).toBeCloseTo(0.5, 10);
  });

  it('turns the free scale’s axes with the clip', () => {
    /*
      The same screen displacement on a 90° clip is the opposite ratio on each axis:
      what the pointer moved along horizontally is the picture's vertical, and vice
      versa. Using screen axes instead would widen a clip pulled downwards.
    */
    const fixed = { x: 0, y: 0 };
    const turned = freeScaleAboutCorner(
      { x: 400, y: 50 },
      { fixed, start: { x: 200, y: 100 }, startScale: { x: 1, y: 1 }, rotation: 90 },
    );
    expect(turned.x).toBeCloseTo(0.5, 10);
    expect(turned.y).toBeCloseTo(2, 10);
  });

  it('clamps a free scale instead of mirroring the picture', () => {
    /*
      Dragging the pointer past the fixed corner makes a ratio negative, which would
      flip the clip — but a flip is `flipH`/`flipV` with its own semantics, and a scale
      gesture should not smuggle one in. The clamp matches the inspector's own floor.
    */
    const fixed = { x: 0, y: 0 };
    const past = freeScaleAboutCorner(
      { x: -400, y: -400 },
      { fixed, start: { x: 200, y: 100 }, startScale: { x: 1, y: 1 }, rotation: 0 },
    );
    expect(past.x).toBeGreaterThan(0);
    expect(past.y).toBeGreaterThan(0);
  });

  it('leaves an axis alone when the pointer starts on the fixed corner', () => {
    // A degenerate grab: dividing by zero would clamp to the maximum and fling the
    // clip to full size, so the axis keeps its scale instead.
    const free = freeScaleAboutCorner(
      { x: 100, y: 200 },
      { fixed: { x: 0, y: 0 }, start: { x: 0, y: 0 }, startScale: { x: 1.5, y: 1.5 }, rotation: 0 },
    );
    expect(free.x).toBe(1.5);
    expect(free.y).toBe(1.5);
  });

  it('holds the picture’s centre still when Alt is held', () => {
    /*
      `Alt` scales about the centre rather than the opposite corner, which is the same
      arithmetic with the fixed point moved: the corner offset drops to zero and only
      the anchor's arm is compensated. With a centred anchor there is nothing to
      compensate at all, so the position must not move.
    */
    const centred = scaleAboutCorner(
      {
        corner: 'se',
        aboutCentre: true,
        fromScale: { x: 1, y: 1 },
        toScale: { x: 2, y: 2 },
        anchorX: 0.5,
        anchorY: 0.5,
        width: 200,
        height: 100,
        rotation: 0,
      },
      { x: 0.2, y: 0.3 },
      { width: 1000, height: 800 },
    );
    expect(centred.x).toBeCloseTo(0.2, 10);
    expect(centred.y).toBeCloseTo(0.3, 10);
  });

  it('still compensates the anchor arm when Alt scales about the centre', () => {
    // An off-centre anchor grows an arm as the scale grows, so even a centred scale
    // has to move the position to keep the picture's *centre* still.
    const offCentre = scaleAboutCorner(
      {
        corner: 'se',
        aboutCentre: true,
        fromScale: { x: 1, y: 1 },
        toScale: { x: 2, y: 2 },
        anchorX: 0.25,
        anchorY: 0.75,
        width: 200,
        height: 100,
        rotation: 0,
      },
      { x: 0, y: 0 },
      { width: 1000, height: 800 },
    );
    expect(offCentre.x).not.toBeCloseTo(0, 6);
  });

  it('measures an Alt scale from the centre, not from the opposite corner', () => {
    // The factor is a distance ratio, and Alt changes which point it is measured from.
    expect(scaleAboutCentre({ x: 200, y: 0 }, { x: 0, y: 0 }, 100)).toBeCloseTo(2, 10);
    expect(scaleAboutCentre({ x: 0, y: 25 }, { x: 0, y: 0 }, 100)).toBeCloseTo(0.25, 10);
  });
});

describe('at any preview zoom (SPEC 10 §4)', () => {
  /*
    Zoom is applied as a CSS transform, and a transformed element reports its *transformed*
    rectangle from `getBoundingClientRect()`. Every drag divides its client-pixel delta by
    that rectangle, so a zoomed preview needs no change in any of this arithmetic — but that
    is a property worth pinning, because the tempting "fix" when a zoom bug is reported is to
    add a division by the zoom somewhere, which would double-count it.
  */
  it('moves the clip half as far per screen pixel at 200%', () => {
    // The same 100 px drag against a canvas drawn at twice the width.
    const at100 = pixelsToFraction(100, 400);
    const at200 = pixelsToFraction(100, 800);
    expect(at100).toBeCloseTo(0.25, 10);
    expect(at200).toBeCloseTo(0.125, 10);
    expect(at200).toBeCloseTo(at100 / 2, 10);
  });

  it('keeps the snap distance at eight screen pixels however far in you are', () => {
    /*
      The threshold is a *screen* distance converted to a fraction by the drawn size, and
      the drawn size grows with the zoom — so the two conversions cancel and the snap stays
      8 px on screen. That is the reason `SNAP_PX` is documented as a screen measurement.
    */
    for (const zoom of [1, 2, 4, 8]) {
      const drawn = 400 * zoom;
      const threshold = snapThresholdPx(drawn);
      expect(threshold * drawn).toBeCloseTo(SNAP_PX, 10);
    }
  });
});

describe('scaling one axis from an edge handle', () => {
  /*
    SPEC 10 §8.2 gives the four edges "scale along one axis (non-uniform)", and the four
    corners the uniform gesture. The surface only had the corner behaviour, with crop on the
    whole edge — so per-axis scale had no pointer affordance at all.
  */
  const options = {
    fixed: { x: 100, y: 0 },
    start: { x: -100, y: 0 },
    startScale: { x: 1, y: 1 },
    rotation: 0,
  };

  it('widens when the left edge is pulled outward, and leaves the height alone', () => {
    /*
      Derived: the fixed right edge is at +100, the pointer starts on the left edge at −100
      (so −200 from the fixed point) and ends 100 px further out (−300). The ratio is 1.5 —
      pulling the left edge away from the right one must *enlarge* the picture, not shrink
      it, which is the sign that a naive `start / now` gets backwards.
    */
    const scale = edgeScale({ x: -200, y: 0 }, { ...options, edge: 'left' });
    expect(scale.x).toBeCloseTo(1.5, 10);
    expect(scale.y).toBe(1);
  });

  it('changes only the axis the edge governs, never the other one', () => {
    /*
      The whole point. A free-scale solve here would let a bottom-edge drag change the width,
      which is the shape of bug that looks like "the clip jumped" rather than like a
      one-axis gesture.

      The fixture has to make the x ratio something other than 1, or the two behaviours are
      identical and the test proves nothing. That is a trap I fell into twice: starting the
      pointer at x = 0 puts it exactly *on* the fixed edge's vertical, so the degenerate-grab
      guard answers 1 and a free solve looks exactly like a one-axis solve. Starting 100 px
      out and moving to 120 gives a ratio of 1.2, so a two-axis solve would visibly change
      the width from 1.3 to 1.56 and the mutation fails as it should.
    */
    const vertical = edgeScale({ x: 120, y: 120 }, {
      ...options,
      edge: 'bottom',
      fixed: { x: 0, y: -50 },
      start: { x: 100, y: 50 },
      startScale: { x: 1.3, y: 1 },
    });
    // x is passed through untouched, including a free scale already set on it…
    expect(vertical.x).toBe(1.3);
    // …and y did move: the vertical edge governs the height.
    expect(vertical.y).not.toBe(1);
  });

  it('pins the other axis at the scale it started from, rather than at 1', () => {
    // Returning 1 for the untouched axis would silently undo a free scale the user set.
    const scale = edgeScale({ x: -200, y: 0 }, { ...options, edge: 'right', startScale: { x: 2, y: 0.5 } });
    expect(scale.y).toBe(0.5);
  });

  it('scales both axes from the governed one under Shift', () => {
    // `Shift` on an edge asks for the corner behaviour: the picture grows evenly.
    const scale = edgeScale({ x: -200, y: 0 }, { ...options, edge: 'left', uniform: true });
    expect(scale.x).toBeCloseTo(1.5, 10);
    expect(scale.y).toBeCloseTo(1.5, 10);
  });

  it('takes the uniform factor from the axis a horizontal edge governs, and the other for a vertical one', () => {
    /*
      The pair that pins which ratio a `Shift` edge drag reads. A vertical edge must take its
      factor from y; reading x for both made a top-edge Shift-drag grow the picture by
      whatever the pointer did *sideways*, which is the classic wrong-axis bug and is
      invisible with a fixture whose x does not move.
    */
    /*
      Derived from the *fixed* edge, not from the clip: the fixed bottom edge sits at y = +100,
      so a start at y = −100 is 200 away from it and a move to y = −200 is 300 away — ratio
      1.5. My first arithmetic measured the distance from the pointer's own start and got 2,
      which is the mistake this comment exists to stop someone repeating.
    */
    const vertical = edgeScale({ x: 500, y: -200 }, {
      ...options,
      edge: 'top',
      fixed: { x: 0, y: 100 },
      start: { x: 0, y: -100 },
      uniform: true,
    });
    expect(vertical.x).toBeCloseTo(1.5, 10);
    expect(vertical.y).toBeCloseTo(1.5, 10);
  });

  it('clamps to the same limits as a corner', () => {
    const huge = edgeScale({ x: 1e9, y: 0 }, { ...options, edge: 'left' });
    expect(huge.x).toBeLessThanOrEqual(10);
    const tiny = edgeScale({ x: -1, y: 0 }, { ...options, edge: 'left' });
    expect(tiny.x).toBeGreaterThan(0);
  });

  it('refuses to invent a scale from a degenerate grab', () => {
    // Starting exactly on the fixed edge divides by zero; the answer must be "no change".
    const scale = edgeScale({ x: 100, y: 0 }, { ...options, edge: 'left', start: { x: 100, y: 0 } });
    expect(scale.x).toBe(1);
  });

  it('carries the pointer back through the rotation of the clip', () => {
    /*
      At 90° the picture's own x axis runs down the screen, so it is a *vertical* screen move
      that widens a left-edge drag. Reading the screen axes instead would widen it on a
      sideways move — the clip growing across the direction the user is pulling.

      Derived rather than guessed, and the first version of this test was wrong twice: it put
      the start point *on* the fixed edge (a degenerate grab, where the honest answer is "no
      change"), and then expected the ratio to come from the horizontal screen delta when at
      90° that component is the one that is pinned. The numbers below are a start 200 px
      below the fixed edge and 300 px further below it, so the ratio is 300/200.
    */
    const grab = (endY: number) =>
      edgeScale(
        { x: 100, y: endY },
        { ...options, edge: 'left', rotation: 90, fixed: { x: 100, y: 0 }, start: { x: 100, y: 200 } },
      ).x;
    /*
      At pointer-down the pointer is 200 px below the fixed edge, so the picture's local x
      there is 200. Moving *further* down to 300 grows it to 300 — ratio 1.5, a widening —
      and moving back up to 100 shrinks it to 0.5. Both directions are asserted because the
      pair is what pins the axis mapping: a single value passes under either sign convention,
      and this test had the two swapped on its first attempt.
    */
    expect(grab(300)).toBeCloseTo(1.5, 10);
    expect(grab(100)).toBeCloseTo(0.5, 10);
  });
});

describe('the fixed side of an edge scale', () => {
  it('holds the opposite side, and nothing on the axis the edge does not govern', () => {
    // A left-edge drag holds the right side: +x. Its height is symmetric, so 0.
    expect(signForOppositeEdge('left')).toStrictEqual({ x: 1, y: 0 });
    expect(signForOppositeEdge('right')).toStrictEqual({ x: -1, y: 0 });
    expect(signForOppositeEdge('top')).toStrictEqual({ x: 0, y: 1 });
    expect(signForOppositeEdge('bottom')).toStrictEqual({ x: 0, y: -1 });
  });
});

describe('compensating an edge scale', () => {
  const base = {
    anchorX: 0.5,
    anchorY: 0.5,
    width: 200,
    height: 100,
    rotation: 0,
  };
  const canvas = { width: 1000, height: 800 };

  it('shifts along the stretched axis only, so the held side stays put', () => {
    /*
      Derived: the fixed side is the right edge at +100 from the centre, and the width goes
      from 1 to 1.5 — so `(1 − 1.5) · 100 = −50` px, i.e. −0.05 of a 1000 px canvas. The
      untouched axis must contribute *exactly* zero, or the held edge drifts vertically on
      every horizontal stretch.
    */
    const position = scaleAboutEdge(
      { ...base, sign: { x: 1, y: 0 }, fromScale: { x: 1, y: 1 }, toScale: { x: 1.5, y: 1 } },
      { x: 0, y: 0 },
      canvas,
    );
    expect(position.x).toBeCloseTo(-50 / 1000, 10);
    expect(position.y).toBeCloseTo(0, 10);
  });

  it('compensates a vertical stretch on the other axis', () => {
    const position = scaleAboutEdge(
      { ...base, sign: { x: 0, y: 1 }, fromScale: { x: 1, y: 1 }, toScale: { x: 1, y: 1.5 } },
      { x: 0, y: 0 },
      canvas,
    );
    expect(position.x).toBeCloseTo(0, 10);
    expect(position.y).toBeCloseTo(-25 / 800, 10);
  });

  it('agrees with the corner compensation when given the same fixed point', () => {
    /*
      The two functions must not disagree about the same geometry, or an edge and a corner
      would place the picture differently for the same scale.

      The fixed point is the thing to get right, and my first attempt got it wrong: dragging
      the `nw` corner holds the **southeast** one, so `scaleAboutCorner` works from `se`'s
      sign (+1, +1) — passing `nw`'s (−1, −1) to the edge version asks it to hold a different
      corner and the answers disagree by the picture's full extent. Compared here against
      `se`, which is what that function actually holds.
    */
    const corner = scaleAboutCorner(
      { ...base, corner: 'nw', fromScale: { x: 1, y: 1 }, toScale: { x: 2, y: 2 } },
      { x: 0, y: 0 },
      canvas,
    );
    const edge = scaleAboutEdge(
      { ...base, sign: { x: 1, y: 1 }, fromScale: { x: 1, y: 1 }, toScale: { x: 2, y: 2 } },
      { x: 0, y: 0 },
      canvas,
    );
    expect(edge.x).toBeCloseTo(corner.x, 10);
    expect(edge.y).toBeCloseTo(corner.y, 10);
  });

  it('scales about the anchor, so an off-centre pivot moves the answer', () => {
    const centred = scaleAboutEdge(
      { ...base, sign: { x: 1, y: 0 }, fromScale: { x: 1, y: 1 }, toScale: { x: 1.5, y: 1 } },
      { x: 0, y: 0 },
      canvas,
    );
    const offsetAnchor = scaleAboutEdge(
      {
        ...base,
        anchorX: 0.25,
        sign: { x: 1, y: 0 },
        fromScale: { x: 1, y: 1 },
        toScale: { x: 1.5, y: 1 },
      },
      { x: 0, y: 0 },
      canvas,
    );
    expect(offsetAnchor.x).not.toBeCloseTo(centred.x, 6);
  });
});
