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
import { assShapeDrawing, assShapeOverride } from '../ass-shapes.js';

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
  it('anchors at the top-left and enters drawing mode', () => {
    /*
      `\an7` from the drawing space's own origin. A centred anchor (`\an5`) would shift
      every shape by half the frame, because the coordinates are already absolute.
    */
    const override = assShapeOverride({ x: 100, y: 50, width: 400, height: 300 }, '&H00FF0000&');
    expect(override).toContain('\\an7');
    expect(override).toContain('\\pos(100,50)');
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
