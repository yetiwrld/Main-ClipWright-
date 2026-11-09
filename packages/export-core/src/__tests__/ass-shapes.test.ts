/**
 * Shapes as ASS drawings (SPEC 11 §12).
 *
 * The gap these close was total: a shape produced no cue, so a rectangle over a clip was
 * in the editor and not in the file. The tests below are therefore about the *mapping*
 * first — that a shape draws at all — and about the three conversions that produce a
 * plausible-looking wrong picture rather than an error.
 *
 * Those three are worth naming, because each is invisible in a passing smoke test:
 * the 100-box must scale onto the frame (not draw 100 px wide), ASS y grows downwards
 * like SVG (a flip would mirror the shape about the middle), and the box's own origin
 * must be added (a shape at x=50% would otherwise draw at the top-left corner).
 */
import { describe, expect, it } from 'vitest';
import { SHAPE_KINDS, shapeGeometry, shapePath } from '@clipwright/compositor';
import { assIconOverride, assShapeDrawing, assShapeOverride } from '../ass-shapes.js';

const BOX = { x: 0, y: 0, width: 1000, height: 1000 };

/** Parses an ASS drawing string into commands with their arguments. */
function commands(drawing: string): Array<{ letter: string; args: number[] }> {
  const found: Array<{ letter: string; args: number[] }> = [];
  const pattern = /([mlb])([-\d ]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(drawing)) !== null) {
    found.push({
      letter: match[1]!,
      args: match[2]!.trim().split(/\s+/).filter(Boolean).map(Number),
    });
  }
  return found;
}

describe('every shape produces a drawing', () => {
  it('draws all nine kinds', () => {
    // The reachability case. Before this, none of them produced any output at all.
    for (const kind of SHAPE_KINDS) {
      const geometry = shapeGeometry(kind);
      expect(geometry, kind).not.toBeNull();
      const drawing = assShapeDrawing(geometry!, BOX);
      expect(drawing.length, kind).toBeGreaterThan(0);
      expect(drawing.startsWith('m'), kind).toBe(true);
    }
  });

  it('draws nothing at all for an unknown kind', () => {
    // A file from a newer version. Drawing a rectangle would be a claim about content
    // the file does not have.
    expect(shapeGeometry('hexagon-hollow')).toBeNull();
    expect(shapeGeometry(undefined)).toBeNull();
  });

  it('starts every subpath with an absolute move', () => {
    // `m` in ASS drawing mode is absolute despite the lowercase letter — the format has
    // no relative form — which is the trap this pins for the next reader.
    for (const kind of SHAPE_KINDS) {
      const drawing = assShapeDrawing(shapeGeometry(kind)!, BOX);
      expect(commands(drawing)[0]!.letter, kind).toBe('m');
    }
  });
});

describe('the 100-box maps onto the frame', () => {
  it('scales a full-frame rectangle to the whole frame', () => {
    // A rectangle drawn "100" pixels wide in a 1920-wide frame is a dot in the corner.
    const drawing = assShapeDrawing(shapeGeometry('rect')!, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    const [move] = commands(drawing);
    expect(move!.args).toEqual([0, 0]);
    // The far corner of the rect.
    expect(drawing).toContain('l1920 0');
    expect(drawing).toContain('l1920 1080');
    expect(drawing).toContain('l0 1080');
  });

  it('adds the box origin, so a shape at 50% is not drawn at the corner', () => {
    /*
      The half-frame default is `{x: 25, y: 25, width: 50, height: 50}` in percent, so
      the origin is half-way across and down. Dropping it draws every shape in the
      top-left — which looks like the shape ignored its own position.
    */
    const drawing = assShapeDrawing(shapeGeometry('rect')!, {
      x: 480,
      y: 270,
      width: 960,
      height: 540,
    });
    expect(commands(drawing)[0]!.args).toEqual([480, 270]);
  });

  it('keeps y growing downwards, as both formats do', () => {
    /*
      The triangle's apex is at the top of the box and its base at the bottom. A flip
      would put the apex on the floor — a picture that still looks like a triangle, which
      is why this needs asserting rather than eyeballing.
    */
    const drawing = assShapeDrawing(shapeGeometry('triangle')!, BOX);
    const ys = commands(drawing).flatMap((command) =>
      // Every second number of an `m`/`l` pair is a y.
      command.letter === 'b' ? [] : command.args.filter((_, index) => index % 2 === 1)
    );
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(1000);
  });

  it('rounds to whole pixels, since ASS drawing takes integers', () => {
    // A fractional coordinate is not an error in some parsers and is dropped in others,
    // which would render as a missing shape on one platform only.
    const drawing = assShapeDrawing(shapeGeometry('ellipse')!, {
      x: 0,
      y: 0,
      width: 333,
      height: 333,
    });
    for (const command of commands(drawing)) {
      for (const value of command.args) expect(Number.isInteger(value), `${value}`).toBe(true);
    }
  });
});

describe('curves and closure', () => {
  it('writes a rounded corner as a cubic, not an arc', () => {
    // ASS has no arc command. `b` with six numbers is the only way to draw one, and a
    // corner written as a straight line is the bug that makes "rounded" look sharp.
    const drawing = assShapeDrawing(shapeGeometry('round-rect')!, BOX);
    const curves = commands(drawing).filter((command) => command.letter === 'b');
    expect(curves).toHaveLength(4);
    for (const curve of curves) expect(curve.args).toHaveLength(6);
  });

  it('puts the curve control points on the circle, not somewhere else', () => {
    /*
      A mutation to the kappa constant survived: every test counted curve *commands* and
      none looked at their coordinates, so an ellipse drawn with laughably flat shoulders
      passed. Kappa is what makes a cubic match a quarter circle, and the check is a
      closed form rather than a stored number: for the quarter from (0,50) to (50,0) in a
      100-box, the first control point is `kappa` of the way from (0,50) to the corner
      (0,0) — so at 1000 px it sits at y = 500 − 0.5523·500 ≈ 224, not at 450.

      The midpoint of a true quarter circle is at radius·(1−1/√2) from the corner; a
      cubic's midpoint is (P0 + 3P1 + 3P2 + P3)/8, which the second assertion pins.
    */
    const drawing = assShapeDrawing(shapeGeometry('ellipse')!, BOX);
    const firstCurve = commands(drawing).find((command) => command.letter === 'b')!;
    const [c1x, c1y, c2x, c2y] = firstCurve.args;
    // Start is the left edge (0,500); the corner the arc turns about is (0,0).
    expect(c1x).toBe(0);
    expect(c1y).toBeLessThan(400);
    expect(c1y).toBeGreaterThan(200);
    // Symmetry: the two control points are equidistant from their own corners.
    expect(c2x).toBeGreaterThan(200);
    expect(c2y).toBe(0);

    // The curve's own midpoint, at ~0.29 of the radius in from the arc — a flat bow
    // would put it near 250 instead.
    const midX = (0 + 3 * c1x + 3 * c2x + firstCurve.args[4]!) / 8;
    const midY = (500 + 3 * c1y + 3 * c2y + firstCurve.args[5]!) / 8;
    const distanceFromCentre = Math.hypot(midX - 500, midY - 500);
    expect(distanceFromCentre).toBeGreaterThan(450);
    expect(distanceFromCentre).toBeLessThan(520);
  });

  it('draws the ellipse with four curves and no straight edges', () => {
    // An ellipse built from lines is a diamond. Four quarter arcs is the definition.
    const drawing = assShapeDrawing(shapeGeometry('ellipse')!, BOX);
    const found = commands(drawing);
    expect(found.filter((command) => command.letter === 'b')).toHaveLength(4);
    expect(found.filter((command) => command.letter === 'l')).toHaveLength(0);
  });

  it('closes a closed subpath back to its start', () => {
    /*
      ASS closes every path implicitly, so this is not strictly required — but a closing
      line makes the shape identical whether or not the renderer honours that, and it is
      cheap. The triangle ends at (0,100) and must return to its apex.
    */
    const drawing = assShapeDrawing(shapeGeometry('triangle')!, BOX);
    const found = commands(drawing);
    expect(found[found.length - 1]!.args).toEqual(found[0]!.args);
  });

  it('leaves a line open, because a closed line has no area', () => {
    // The one shape that must not be closed: closing it produces a zero-area sliver that
    // fills to nothing, so the shape a user added would be invisible.
    const drawing = assShapeDrawing(shapeGeometry('line')!, BOX);
    const found = commands(drawing);
    expect(found).toHaveLength(2);
    expect(found[1]!.args[1]).toBe(found[0]!.args[1]);
  });
});

describe('the override block', () => {
  it('anchors at the top-left, at the origin, and enters drawing mode', () => {
    /*
      `\pos(0,0)`, and this test used to demand `\pos(100,50)` — which was the bug written
      down as an expectation. A drawing's coordinates are absolute in the script's pixel space
      and libass *adds* `\pos` to them, so passing the box origin counted it twice.

      Measured, by rendering the script through ffmpeg and locating the drawn pixels: a
      rectangle declared as the centred middle half of a 1920×1080 frame (x 480…1440,
      y 270…810) burned in at x 960…1919, y 540…1079 — offset by exactly the box origin and
      shoved off the bottom-right corner. With `\pos(0,0)` it lands at 480…1439 × 270…809.

      A unit test cannot see pixels, so this pins the string that the measurement settled on,
      and the measurement itself lives in `docs/verification.md`.
    */
    const override = assShapeOverride({ x: 100, y: 50, width: 400, height: 300 }, '&H00FF0000&');
    expect(override).toContain('\\an7');
    expect(override).toContain('\\pos(0,0)');
    expect(override).not.toContain('\\pos(100,50)');
    expect(override).toContain('\\p1');
  });

  it('carries the fill colour', () => {
    expect(assShapeOverride(BOX, '&H0000FFFF&')).toContain('&H0000FFFF&');
  });

  it('suppresses the outline and shadow a caption style would add', () => {
    // A shape borrows a caption style's colour. That style's outline would draw a border
    // around the rectangle that the preview does not show and the user did not ask for.
    const override = assShapeOverride(BOX, '&H00FFFFFF&');
    expect(override).toContain('\\bord0');
    expect(override).toContain('\\shad0');
  });
});

describe('an icon maps onto the square inside its box', () => {
  /*
    Measured on the rendered star: mapped onto a 960×540 box it came out at aspect 1.668
    instead of ~1.0, i.e. stretched 16:9. `square` takes the shorter side and centres.
  */
  const SUBPATH = [{ x: 0, y: 0, closed: true, segments: [{ op: 'line' as const, x: 100, y: 100 }] }];

  it('fills the whole box for a shape', () => {
    // A rectangle should reach the box's edges — that is what "half the frame each way" means.
    const drawing = assShapeDrawing(SUBPATH, { x: 480, y: 270, width: 960, height: 540 });
    expect(drawing).toContain('l1440 810');
  });

  it('draws inside the centred square for an icon', () => {
    // 960x540 -> a 540 square, centred, so x runs 690..1230 rather than 480..1440.
    const drawing = assShapeDrawing(SUBPATH, { x: 480, y: 270, width: 960, height: 540 }, { square: true });
    expect(drawing).toContain('l1230 810');
    expect(drawing).toContain('m690 270');
  });

  it('is a no-op on an already-square box', () => {
    const box = { x: 0, y: 0, width: 540, height: 540 };
    expect(assShapeDrawing(SUBPATH, box, { square: true })).toBe(assShapeDrawing(SUBPATH, box));
  });
});

describe('an icon is stroked, not filled (SPEC 11 §12)', () => {
  /*
    Lucide's paths are *outlines*: the icon is the stroke around a path, not the area inside
    it. Filling one draws a different picture — a filled star outline is a solid pentagram and
    a filled gear is a disc. These assertions exist because every one of them was measured
    through ffmpeg against the real renderer before it was written down; see
    `docs/verification.md` for the numbers.
  */

  it('makes the fill transparent with the alpha override, not a colour', () => {
    /*
      The trap: writing `\1c&HFF000000&` looks like "transparent black" and is not — ASS treats
      `\1c` as a colour with no alpha, so the fill stayed opaque and a closed path rendered as
      one solid run 680 px wide. `\1a&HFF&` is the alpha override and rendered the same path as
      two crossings of 40 px, a hollow ring.
    */
    const override = assIconOverride(40, '&H00FF0000&');
    expect(override).toContain('\\1a&HFF&');
    expect(override).not.toContain('\\1c&HFF000000&');
  });

  it('carries the stroke colour on the outline channel and the width on \\bord', () => {
    const override = assIconOverride(40, '&H0000FF00&');
    expect(override).toContain('\\3c&H0000FF00&');
    expect(override).toContain('\\bord40');
  });

  it('anchors at the origin like a shape, because a drawing is absolute', () => {
    // The same bug class as `assShapeOverride`: `\pos(box)` would double the origin.
    expect(assIconOverride(10, '&H00FFFFFF&')).toContain('\\pos(0,0)');
  });

  it('never emits a zero border, which libass reads as no stroke at all', () => {
    // A sub-pixel width rounding to 0 would draw a filled icon again, silently.
    expect(assIconOverride(0.2, '&H00FFFFFF&')).toContain('\\bord1');
    expect(assIconOverride(0, '&H00FFFFFF&')).toContain('\\bord1');
  });
});
