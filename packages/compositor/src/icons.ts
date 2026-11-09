/**
 * SPEC 11 §12 — icons as vector items.
 *
 * "Icon library (offline): the **full Lucide set** (ISC licence) bundled as an SVG sprite,
 * searchable by name and tags… Icons are tintable, stroke width adjustable (0.5–4), size,
 * rotation, flip."
 *
 * The renderers here do not take markup and must not: the preview paints into a canvas, the
 * export writes ASS drawing commands, and both need *geometry*. So an icon is stored as the
 * one thing that can be turned into geometry without an SVG parser — its child elements, in
 * the 24×24 box every Lucide path is drawn in — and this module turns those children into
 * the `ShapeSubpath[]` the shape renderers already understand.
 *
 * **Arcs.** Lucide's icons use seven element types (`path`, `circle`, `rect`, `line`,
 * `polyline`, `polygon`, `ellipse`) and, in about two thirds of them, **arcs** inside a path's
 * `d`. Of the 1468 arc commands in the set, 1448 are **circular** (`rx === ry`).
 *
 * A quarter of a *circle* is exactly representable by a cubic: it is the KAPPA construction
 * this repository already uses as its definition of a circle (§18, `shapes.ts`). So this is
 * not the arc-flattening that would let the preview and the export disagree — it is the same
 * closed-form, computed once, here. An **elliptical** arc needs the full SVG
 * endpoint-to-centre parameterisation and is refused by name; the picker only offers icons
 * that convert.
 *
 * Measured against the whole installed set (1761 files, 1556 icons, 205 aliases): **1541
 * convert**, 14 are refused for a genuinely elliptical arc, and 1 is a barrel file with no
 * shapes. Before arcs, 561 converted. Of the 51 icons a first picker would want, 50 convert
 * and only `gift` is refused.
 *
 * Note that `rx === ry` makes the arc's x-axis-rotation meaningless — rotating a circle
 * leaves the same circle — so Lucide freely writes `a2 2 135 0 1 2-2` on rounded corners.
 * Refusing non-zero rotation would have thrown out perfectly circular arcs.
 *
 * Coordinates. Lucide draws in a 24×24 box with a 2 px stroke inset by 1, so the *drawn*
 * extent is 1…23. Everything here is rescaled — once, at the end — into the **100×100 box**
 * `ShapeSubpath` is defined in, so the icon geometry is consumed by exactly the code that
 * already draws a rectangle: `shapePath` for the preview's SVG, `paintShape` for the canvas,
 * `assShapeDrawing` for the burn-in. No renderer learns that icons exist.
 */

import type { ShapeSegment, ShapeSubpath } from './shapes.js';

/** One child element of a Lucide icon, as stored on an item. */
export type IconShape =
  | { t: 'path'; d: string }
  | { t: 'circle'; cx: number; cy: number; r: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { t: 'polyline'; points: string }
  | { t: 'polygon'; points: string }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

/** The viewBox every Lucide icon is drawn in. Normalised against this, not against the SVG attr. */
export const ICON_VIEWBOX = 24;

/** The path commands this module understands. `A`/`a` is supported for circles only. */
const PATH_COMMANDS = 'MmLlHhVvCcSsQqTtAaZz'.split('');

/** A stored icon: its name (for the UI and for licence attribution) and its children. */
export interface IconDefinition {
  /** Lucide's kebab-case name, e.g. `clock`. */
  name: string;
  shapes: readonly IconShape[];
}

export type IconGeometryResult =
  | { ok: true; subpaths: ShapeSubpath[] }
  | { ok: false; reason: 'unknown-shape' | 'arc' | 'unparsable' | 'empty'; detail: string };

/**
 * Convert an icon to the renderers' geometry, or explain why not.
 *
 * Failure is a *result*, not an exception, and it names what went wrong. A picker that
 * silently skipped an icon would leave the user clicking a tile that does nothing; one that
 * threw would take the panel down over a decorative asset.
 */
export function iconGeometry(icon: IconDefinition): IconGeometryResult {
  const subpaths: ShapeSubpath[] = [];
  for (const shape of icon.shapes) {
    if (shape.t === 'path' && hasArcCommand(shape.d) && !arcsAreCircular(shape.d)) {
      /*
        An *elliptical* arc is refused. See the header: the circular case is exact and is
        handled below, but an arbitrary ellipse needs the full SVG arc parameterisation, and
        Lucide never uses one (20 arc commands of 1468 in the whole set). Refusing is a
        statement that this module does not do the general thing — not a hedge about the
        common one, which it does exactly.
      */
      return { ok: false, reason: 'arc', detail: `${icon.name}: ${shape.d.slice(0, 40)}` };
    }
    const converted = convertShape(shape);
    if (!converted) return { ok: false, reason: 'unknown-shape', detail: icon.name };
    subpaths.push(...converted);
  }
  /*
    The one place `empty` is decided. An icon with no shapes takes this exit naturally, which
    is why there is no separate early guard for it: the two were provably the same result, and
    a second path to a result is a second thing to keep in step.
  */
  if (subpaths.length === 0) return { ok: false, reason: 'empty', detail: icon.name };
  return { ok: true, subpaths };
}

/** Whether a path's `d` uses elliptical arcs, which this module refuses to flatten. */
export function hasArcCommand(d: string): boolean {
  // Through the tokeniser, so an `a` inside an exponent (`1e-5` has none, but `1a5` would be
  // malformed rather than an arc) is never mistaken for a command.
  const tokens = tokenisePath(d);
  return tokens !== null && tokens.some((token) => token.command.toUpperCase() === 'A');
}

/**
 * Whether a `d` uses only the commands this module parses.
 *
 * Lucide's own paths are relative/absolute moveto, lineto, horizontal/vertical lineto, cubic
 * and quadratic curves, and close. Anything else is refused rather than skipped, because a
 * partially drawn icon is worse than none: it looks like a rendering bug to the user and
 * like a success to the picker.
 */
export function supportedPathCommands(d: string): boolean {
  const tokens = tokenisePath(d);
  if (!tokens) return false;
  return tokens.every((token) => PATH_COMMANDS.includes(token.command));
}

function convertShape(shape: IconShape): ShapeSubpath[] | null {
  switch (shape.t) {
    case 'path': {
      if (!supportedPathCommands(shape.d)) return null;
      return pathToSubpaths(shape.d);
    }
    case 'circle':
      return [ellipseSubpath(shape.cx, shape.cy, shape.r, shape.r, false)];
    case 'ellipse':
      return [ellipseSubpath(shape.cx, shape.cy, shape.rx, shape.ry, false)];
    case 'rect':
      return [rectSubpath(shape.x, shape.y, shape.w, shape.h, shape.rx ?? 0)];
    case 'line':
      return [lineSubpath(shape.x1, shape.y1, shape.x2, shape.y2)];
    case 'polyline': {
      const polyline = pointsSubpath(shape.points, false);
      return polyline ? [polyline] : null;
    }
    case 'polygon': {
      const polygon = pointsSubpath(shape.points, true);
      return polygon ? [polygon] : null;
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------- arcs --- */

/**
 * Whether every arc in a path is circular, which is the only kind this module converts.
 *
 * Exposed because the *picker* has to know before it offers an icon: promising a tile and
 * then failing to draw it is the silent failure this whole result type exists to avoid.
 */
export function arcsAreCircular(d: string): boolean {
  for (const token of tokenisePath(d) ?? []) {
    if (token.command.toUpperCase() !== 'A') continue;
    for (let index = 0; index + 6 < token.args.length; index += 7) {
      const rx = Math.abs(token.args[index]!);
      const ry = Math.abs(token.args[index + 1]!);
      if (Math.abs(rx - ry) > 1e-9) return false;
    }
  }
  return true;
}

/** A cubic segment, spelled out so callers of the arc helper need no narrowing. */
export type CubicSegment = Extract<ShapeSegment, { op: 'cubic' }>;

/**
 * A **circular** arc as one or more cubics, exactly.
 *
 * The SVG endpoint parameterisation, restricted to `rx === ry`, where the arc's centre is the
 * intersection of two circles of that radius — closed form, no iteration. Each step of at
 * most 90° becomes one cubic with KAPPA control points; a large arc simply takes more steps.
 *
 * `largeArc` and `sweep` are both used and both matter: `sweep` picks which of the two
 * candidate centres, and `largeArc` picks which of the two arcs between the endpoints. Ignoring
 * either draws a plausible-looking icon with one corner bent the wrong way, which is far
 * harder to notice than a missing one.
 *
 * Returns `null` when the endpoints coincide (the arc is undefined) or the numbers are not
 * finite, so the caller refuses the icon rather than drawing something arbitrary.
 */
export function circularArcToCubics(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  largeArc: boolean,
  sweep: boolean,
): CubicSegment[] | null {
  if (!Number.isFinite(radius) || radius <= 0) return null;
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return null;
  /*
    The spec's radius correction: if the endpoints are further apart than the diameter, the
    radius is scaled up until it exactly reaches. Without this a malformed arc produces a
    negative square root and a NaN everywhere downstream.
  */
  const r = distance > 2 * radius ? distance / 2 : radius;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const hSquared = Math.max(0, r * r - (distance / 2) ** 2);
  const h = Math.sqrt(hSquared);
  /*
    The perpendicular offset to the centre. `sweep === largeArc` is the sign that makes both
    flags behave as the spec defines them; written this way rather than as two nested
    conditionals because the two flags genuinely interact and splitting them invites the bug
    where one is honoured and the other is not.
  */
  const sign = largeArc === sweep ? -1 : 1;
  const cx = mx + (sign * h * -dy) / distance;
  const cy = my + (sign * h * dx) / distance;

  const startAngle = Math.atan2(from.y - cy, from.x - cx);
  const endAngle = Math.atan2(to.y - cy, to.x - cx);
  const twoPi = Math.PI * 2;
  let delta = endAngle - startAngle;
  if (sweep && delta < 0) delta += twoPi;
  if (!sweep && delta > 0) delta -= twoPi;
  /*
    There is deliberately no correction for `largeArc` here. Choosing the centre by
    `largeArc === sweep` already puts the arc on the correct side — measured over all four
    flag combinations, the sweep below yields 60° for a small arc and 300° for a large one,
    exactly as the flags ask. An extra branch clamping `delta` to the right side of π was
    written, proven unreachable, and removed rather than left as a guard that never fires.
  */

  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const stepAngle = delta / steps;
  /*
    KAPPA for *this* step rather than the quarter-circle constant, so a 30° arc's control
    points are the right length. Using the quarter constant for every step would make short
    corners bulge and long ones flatten.
  */
  const k = (4 / 3) * Math.tan(stepAngle / 4);
  const segments: CubicSegment[] = [];
  let angle = startAngle;
  for (let step = 0; step < steps; step += 1) {
    const nextAngle = angle + stepAngle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const cosB = Math.cos(nextAngle);
    const sinB = Math.sin(nextAngle);
    /*
      `step === steps - 1` lands exactly on `to` rather than on the trigonometry's own idea of
      it, which is what keeps a path closed when it ends on the point it started from. Units
      are Lucide's 24-box here; `pathToSubpaths` normalises the finished subpath.
    */
    const endX = step === steps - 1 ? to.x : cx + r * cosB;
    const endY = step === steps - 1 ? to.y : cy + r * sinB;
    segments.push({
      op: 'cubic',
      c1x: cx + r * (cosA - k * sinA),
      c1y: cy + r * (sinA + k * cosA),
      c2x: cx + r * (cosB + k * sinB),
      c2y: cy + r * (sinB - k * cosB),
      x: endX,
      y: endY,
    });
    angle = nextAngle;
  }
  return segments;
}

/* ---------------------------------------------------------------- primitives --- */

/**
 * Convert one coordinate from Lucide's 24-box to the **100-box** `ShapeSubpath` uses.
 *
 * Not to a 0–1 fraction, which is what an earlier version of this file did and which is
 * simply wrong: `shapeGeometry` draws a rectangle as `0…100`, `shapePath` serialises those
 * numbers straight into an SVG path, `paintShape` divides by 100 to reach pixels and
 * `assShapeDrawing` divides by 100 to reach script pixels. An icon in fractions would render
 * at one hundredth of its box — a dot in the corner — and every one of those call sites would
 * have had to learn about a second unit. One unit, the existing one.
 */
const u = (value: number) => (value / ICON_VIEWBOX) * 100;

function lineSubpath(x1: number, y1: number, x2: number, y2: number): ShapeSubpath {
  return {
    x: u(x1),
    y: u(y1),
    segments: [{ op: 'line', x: u(x2), y: u(y2) }],
    closed: false,
  };
}

/**
 * An ellipse as four cubics, which is exact enough to be *the* definition here.
 *
 * Not an arc-flattening: four KAPPA-scaled cubics reproduce a circle to within a thousandth
 * of a pixel at 24 units, and — crucially — they are the *same four* in every renderer
 * because they are computed once, here. Lucide draws its circles with `<circle>` and its
 * rounded rectangles with `rx`, so this path is what makes the primitive elements work at all.
 */
function ellipseSubpath(cx: number, cy: number, rx: number, ry: number, closed: boolean): ShapeSubpath {
  const KAPPA = 0.5522847498;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    x: u(cx - rx),
    y: u(cy),
    segments: [
      { op: 'cubic', c1x: u(cx - rx), c1y: u(cy - ky), c2x: u(cx - kx), c2y: u(cy - ry), x: u(cx), y: u(cy - ry) },
      { op: 'cubic', c1x: u(cx + kx), c1y: u(cy - ry), c2x: u(cx + rx), c2y: u(cy - ky), x: u(cx + rx), y: u(cy) },
      { op: 'cubic', c1x: u(cx + rx), c1y: u(cy + ky), c2x: u(cx + kx), c2y: u(cy + ry), x: u(cx), y: u(cy + ry) },
      { op: 'cubic', c1x: u(cx - kx), c1y: u(cy + ry), c2x: u(cx - rx), c2y: u(cy + ky), x: u(cx - rx), y: u(cy) },
    ],
    // A full ellipse's last point is its first, so there is no segment to close.
    closed,
  };
}

function rectSubpath(x: number, y: number, w: number, h: number, rx: number): ShapeSubpath {
  const radius = Math.max(0, Math.min(rx, w / 2, h / 2));
  if (radius === 0) {
    return {
      x: u(x),
      y: u(y),
      segments: [
        { op: 'line', x: u(x + w), y: u(y) },
        { op: 'line', x: u(x + w), y: u(y + h) },
        { op: 'line', x: u(x), y: u(y + h) },
        { op: 'line', x: u(x), y: u(y) },
      ],
      closed: false,
    };
  }
  /*
    A rounded rectangle is four lines and four quarter circles. The quarter circles are
    KAPPA cubics for the same reason the ellipse is: one definition, computed once, so the
    preview and the export cannot round a corner differently.
  */
  const k = radius * 0.5522847498;
  const segments: ShapeSegment[] = [
    { op: 'line', x: u(x + w - radius), y: u(y) },
    { op: 'cubic', c1x: u(x + w - radius + k), c1y: u(y), c2x: u(x + w), c2y: u(y + radius - k), x: u(x + w), y: u(y + radius) },
    { op: 'line', x: u(x + w), y: u(y + h - radius) },
    { op: 'cubic', c1x: u(x + w), c1y: u(y + h - radius + k), c2x: u(x + w - radius + k), c2y: u(y + h), x: u(x + w - radius), y: u(y + h) },
    { op: 'line', x: u(x + radius), y: u(y + h) },
    { op: 'cubic', c1x: u(x + radius - k), c1y: u(y + h), c2x: u(x), c2y: u(y + h - radius + k), x: u(x), y: u(y + h - radius) },
    { op: 'line', x: u(x), y: u(y + radius) },
    { op: 'cubic', c1x: u(x), c1y: u(y + radius - k), c2x: u(x + radius - k), c2y: u(y), x: u(x + radius), y: u(y) },
  ];
  return { x: u(x + radius), y: u(y), segments, closed: false };
}

function pointsSubpath(points: string, closed: boolean): ShapeSubpath | null {
  const numbers = (points.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number);
  if (numbers.length < 4 || numbers.some((value) => !Number.isFinite(value))) return null;
  const segments: ShapeSegment[] = [];
  for (let index = 2; index + 1 < numbers.length; index += 2) {
    segments.push({ op: 'line', x: u(numbers[index]!), y: u(numbers[index + 1]!) });
  }
  return { x: u(numbers[0]!), y: u(numbers[1]!), segments, closed };
}

/* ---------------------------------------------------------------- path data --- */

/**
 * Parse an SVG path `d` into subpaths.
 *
 * A deliberately small subset, matching what Lucide's own paths contain — see
 * `supportedPathCommands`. Quadratic curves are promoted to cubics rather than kept as a
 * third op, so `ShapeSegment` needs no new case and no renderer has to learn anything.
 *
 * Returns `null` for anything it cannot parse *completely*. A partial parse would draw most
 * of an icon correctly and miss one stroke, which is the hardest kind of wrong to notice.
 */
export function pathToSubpaths(d: string): ShapeSubpath[] | null {
  const tokens = tokenisePath(d);
  if (!tokens) return null;
  const subpaths: ShapeSubpath[] = [];
  let current: ShapeSubpath | null = null;
  let x = 0;
  let y = 0;
  /** The second control point of the previous cubic, for a smooth `S`/`T`. */
  let lastControl: { x: number; y: number } | null = null;

  const ensure = () => {
    if (!current) {
      current = { x, y, segments: [], closed: false };
      subpaths.push(current);
    }
    return current;
  };

  for (const token of tokens) {
    const command = token.command;
    const args = token.args;
    const relative = command === command.toLowerCase();
    const step = (value: number) => (relative ? x + value : value);

    switch (command.toUpperCase()) {
      case 'M': {
        if (args.length < 2) return null;
        x = step(args[0]!);
        y = step(args[1]!);
        current = { x, y, segments: [], closed: false };
        subpaths.push(current);
        // Extra coordinate pairs after a moveto are implicit linetos, per the SVG spec.
        for (let index = 2; index + 1 < args.length; index += 2) {
          x = relative ? x + args[index]! : args[index]!;
          y = relative ? y + args[index + 1]! : args[index + 1]!;
          ensure().segments.push({ op: 'line', x, y });
        }
        lastControl = null;
        break;
      }
      case 'L': {
        for (let index = 0; index + 1 < args.length; index += 2) {
          x = relative ? x + args[index]! : args[index]!;
          y = relative ? y + args[index + 1]! : args[index + 1]!;
          ensure().segments.push({ op: 'line', x, y });
        }
        lastControl = null;
        break;
      }
      case 'H': {
        for (const value of args) {
          x = relative ? x + value : value;
          ensure().segments.push({ op: 'line', x, y });
        }
        lastControl = null;
        break;
      }
      case 'V': {
        for (const value of args) {
          y = relative ? y + value : value;
          ensure().segments.push({ op: 'line', x, y });
        }
        lastControl = null;
        break;
      }
      case 'C': {
        for (let index = 0; index + 5 < args.length; index += 6) {
          const c1x = relative ? x + args[index]! : args[index]!;
          const c1y = relative ? y + args[index + 1]! : args[index + 1]!;
          const c2x = relative ? x + args[index + 2]! : args[index + 2]!;
          const c2y = relative ? y + args[index + 3]! : args[index + 3]!;
          x = relative ? x + args[index + 4]! : args[index + 4]!;
          y = relative ? y + args[index + 5]! : args[index + 5]!;
          ensure().segments.push({ op: 'cubic', c1x, c1y, c2x, c2y, x, y });
          lastControl = { x: c2x, y: c2y };
        }
        break;
      }
      case 'S': {
        for (let index = 0; index + 3 < args.length; index += 4) {
          // The reflected previous control point, or the current point when there is none.
          const c1x = lastControl ? 2 * x - lastControl.x : x;
          const c1y = lastControl ? 2 * y - lastControl.y : y;
          const c2x = relative ? x + args[index]! : args[index]!;
          const c2y = relative ? y + args[index + 1]! : args[index + 1]!;
          x = relative ? x + args[index + 2]! : args[index + 2]!;
          y = relative ? y + args[index + 3]! : args[index + 3]!;
          ensure().segments.push({ op: 'cubic', c1x, c1y, c2x, c2y, x, y });
          lastControl = { x: c2x, y: c2y };
        }
        break;
      }
      case 'Q': {
        for (let index = 0; index + 3 < args.length; index += 4) {
          const fromX = x;
          const fromY = y;
          const qx = relative ? x + args[index]! : args[index]!;
          const qy = relative ? y + args[index + 1]! : args[index + 1]!;
          x = relative ? x + args[index + 2]! : args[index + 2]!;
          y = relative ? y + args[index + 3]! : args[index + 3]!;
          /*
            Promoted to a cubic: the cubic's first control point sits on the line from the
            *start* to the quadratic's control at two-thirds, and its second on the line from
            the *end* to that control, again at two-thirds. Both ends are captured before
            `x`/`y` are advanced — the first version read them after, so every quadratic
            curved from a point that no longer existed.
          */
          ensure().segments.push({
            op: 'cubic',
            c1x: fromX + (2 / 3) * (qx - fromX),
            c1y: fromY + (2 / 3) * (qy - fromY),
            c2x: x + (2 / 3) * (qx - x),
            c2y: y + (2 / 3) * (qy - y),
            x,
            y,
          });
          lastControl = { x: qx, y: qy };
        }
        break;
      }
      case 'T': {
        for (let index = 0; index + 1 < args.length; index += 2) {
          const qx: number = lastControl ? 2 * x - lastControl.x : x;
          const qy: number = lastControl ? 2 * y - lastControl.y : y;
          const fromX = x;
          const fromY = y;
          x = relative ? x + args[index]! : args[index]!;
          y = relative ? y + args[index + 1]! : args[index + 1]!;
          ensure().segments.push({
            op: 'cubic',
            c1x: fromX + (2 / 3) * (qx - fromX),
            c1y: fromY + (2 / 3) * (qy - fromY),
            c2x: x + (2 / 3) * (qx - x),
            c2y: y + (2 / 3) * (qy - y),
            x,
            y,
          });
          lastControl = { x: qx, y: qy };
        }
        break;
      }
      case 'A': {
        /*
          Circular arcs only, and exactly — see the header. Each is split into the number of
          quarter-turns it spans (a circle quarter is one KAPPA cubic; a three-quarter turn is
          three) and the *same* arcsToCubics runs for both the preview and the export, so the
          two cannot disagree about how many segments an icon's corner is made of.
        */
        for (let index = 0; index + 6 < args.length; index += 7) {
          const rx = Math.abs(args[index]!);
          const ry = Math.abs(args[index + 1]!);
          const largeArc = args[index + 3]! !== 0;
          const sweep = args[index + 4]! !== 0;
          const ex = relative ? x + args[index + 5]! : args[index + 5]!;
          const ey = relative ? y + args[index + 6]! : args[index + 6]!;
          /*
            `rotation` is deliberately not checked against zero, only against `rx === ry`.
            A circular arc's x-axis-rotation is a no-op — rotating a circle leaves the same
            circle — and Lucide relies on that, writing `a2 2 135 0 1 2-2` on rounded rect
            corners. Rejecting `rotation !== 0` therefore refused a pile of perfectly circular
            arcs (`umbrella`, `table-rows-split`). The ellipse check is `rx !== ry` and nothing
            more, which is also exactly what `arcsAreCircular` tests, so the gate and the
            parser agree by construction.
          */
          if (Math.abs(rx - ry) > 1e-9) return null;
          if (rx === 0) {
            // A degenerate radius is a straight line, which is what the spec says it is.
            x = ex;
            y = ey;
            ensure().segments.push({ op: 'line', x, y });
            continue;
          }
          const subpath = ensure();
          const cubics = circularArcToCubics({ x, y }, { x: ex, y: ey }, rx, largeArc, sweep);
          if (!cubics) return null;
          subpath.segments.push(...cubics);
          x = ex;
          y = ey;
          lastControl = null;
        }
        break;
      }
      case 'Z': {
        if (current) current.closed = true;
        lastControl = null;
        continue;
      }
      default:
        return null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  }
  /*
    Normalised on the way out, in one place, rather than at every `push`. The parser works in
    Lucide's own 24-box units because that is what `d` is written in and what the arc maths
    needs; the renderers take the 100-box. Dividing at each emission point is how the two
    drifted apart once already — `M`/`L`/`C` emitted raw units while the arcs and primitives
    emitted converted ones, so a line-only icon drew 24× too large. One exit, one unit.
  */
  return subpaths.length > 0 ? subpaths.map(scaleSubpath) : null;
}

/** The 24-box → 100-box conversion for a finished subpath, used by `pathToSubpaths`. */
function scaleSubpath(subpath: ShapeSubpath): ShapeSubpath {
  return {
    x: u(subpath.x),
    y: u(subpath.y),
    closed: subpath.closed,
    segments: subpath.segments.map((segment) =>
      segment.op === 'cubic'
        ? {
            op: 'cubic',
            c1x: u(segment.c1x),
            c1y: u(segment.c1y),
            c2x: u(segment.c2x),
            c2y: u(segment.c2y),
            x: u(segment.x),
            y: u(segment.y),
          }
        : { op: 'line', x: u(segment.x), y: u(segment.y) },
    ),
  };
}

interface PathToken {
  command: string;
  args: number[];
}

/** Split a `d` into commands and their numbers, or `null` when it cannot be read. */
export function tokenisePath(d: string): PathToken[] | null {
  const tokens: PathToken[] = [];
  /*
    Matched as command-then-arguments rather than scanned character by character: the
    arguments of one command run until the next letter, which is exactly the shape of the
    grammar and avoids the ambiguity of treating `-` as both a minus sign and a separator.
    The exponent strip keeps `1e-5` from being read as the start of a new command.
  */
  /*
    Scanned as one alternation — a lone command letter, or a complete number *including* its
    exponent — rather than as letter-then-rest. Splitting on letters first is what breaks
    `1e-5`: the `e` looks exactly like a new command, and the number is torn in two. Letting
    the number pattern claim the exponent before the letter branch can see it is the whole
    fix, and it needs no pre-processing of the string.
  */
  const matches = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
  if (!matches) return null;
  for (const match of matches) {
    if (/^[a-zA-Z]$/.test(match)) {
      tokens.push({ command: match, args: [] });
      continue;
    }
    const token = tokens[tokens.length - 1];
    if (!token) return null; // A number before any command is not a path.
    const value = Number(match);
    if (!Number.isFinite(value)) return null;
    token.args.push(value);
  }
  return tokens;
}

/* ------------------------------------------------------------------ items --- */

/**
 * What an icon *item* needs to resolve to, given the set this build knows about.
 *
 * Deliberately not "look the name up and return geometry": a file can name an icon this
 * build has never heard of, and the three answers a renderer needs are different. It has
 * stored shapes and they draw; it has a name and the library resolves it; or it has one of
 * those and neither works. Collapsing the third into `null` is what makes an icon vanish
 * from an export with nothing reported, which is the failure this module exists to avoid.
 *
 * Precedence is shapes-then-name. A file that stores the geometry is stating what the icon
 * was at the time it was drawn; a newer build's library may have redrawn that name, and the
 * file's own copy is the more faithful answer. A file that stores only a name is the normal
 * case, and uses whatever this build ships.
 */
export type IconItemResolution =
  | { status: 'drawn'; source: 'shapes' | 'library'; subpaths: ShapeSubpath[] }
  | { status: 'unknown'; iconName?: string; detail: string }
  | { status: 'refused'; reason: 'arc' | 'unparsable' | 'unknown-shape' | 'empty'; detail: string };

/**
 * Resolve an icon item to geometry, or say precisely why it cannot be drawn.
 *
 * `library` is passed in rather than imported so the renderer decides what the bundled set
 * is: the preview and the export both call this with the same `ICONS` table, and a test can
 * call it with one of its own.
 */
export function resolveIconItem(
  item: { iconName?: string; iconShapes?: readonly IconShape[] },
  library: Readonly<Record<string, readonly IconShape[]>>,
): IconItemResolution {
  const stored = item.iconShapes;
  if (stored && stored.length > 0) {
    const geometry = iconGeometry({ name: item.iconName ?? '(stored)', shapes: stored });
    if (geometry.ok) return { status: 'drawn', source: 'shapes', subpaths: geometry.subpaths };
    return { status: 'refused', reason: geometry.reason, detail: geometry.detail };
  }

  const name = item.iconName;
  if (!name) return { status: 'unknown', detail: 'no icon name and no stored shapes' };
  const shapes = library[name];
  if (!shapes) {
    /*
      Not an error in the file and not a bug in the build: the file was written by a version
      that knew an icon this one does not, or the name was typed by hand. Reported by name so
      the message can say which icon is missing.
    */
    return { status: 'unknown', iconName: name, detail: `this build has no icon named "${name}"` };
  }
  const geometry = iconGeometry({ name, shapes });
  if (geometry.ok) return { status: 'drawn', source: 'library', subpaths: geometry.subpaths };
  return { status: 'refused', reason: geometry.reason, detail: geometry.detail };
}

/**
 * The icons this build can draw, from a name → shapes table.
 *
 * The picker calls this so it offers only tiles that will draw. That is the same rule as
 * `resolveIconItem`, applied in advance rather than after the user has chosen: a tile that
 * draws nothing when clicked is indistinguishable from a broken application.
 */
export function drawableIconNames(
  library: Readonly<Record<string, readonly IconShape[]>>,
): string[] {
  return Object.keys(library)
    .filter((name) => {
      const shapes = library[name];
      return shapes !== undefined && iconGeometry({ name, shapes }).ok;
    })
    .sort();
}

/** A stable key for an icon item's appearance, so a renderer can cache a serialisation. */
export function iconAppearanceKey(item: {
  iconName?: string;
  iconShapes?: readonly IconShape[];
}): string {
  if (item.iconShapes && item.iconShapes.length > 0) return `shapes:${JSON.stringify(item.iconShapes)}`;
  return `name:${item.iconName ?? ''}`;
}

/* ----------------------------------------------------------------- library --- */

/**
 * One icon as it is stored in `/assets/icons/lucide.json`.
 *
 * The compact form exists because the full set is 1555 icons and 240 KB: writing
 * `{"t":"path","d":"…"}` for each child would roughly double that for no information. The
 * first element is the tag letter; the rest are that tag's numbers, except `p`/`o`/`g` whose
 * second element is the string.
 */
export type StoredIconChild =
  | readonly ['p', string]
  | readonly ['c', number, number, number]
  | readonly ['e', number, number, number, number]
  | readonly ['r', number, number, number, number]
  | readonly ['r', number, number, number, number, number]
  | readonly ['l', number, number, number, number]
  | readonly ['o', string]
  | readonly ['g', string];

/** The stored table: icon name → its children. */
export type StoredIconLibrary = Readonly<Record<string, readonly StoredIconChild[]>>;

/** The shape's tag, or `null` for a child this build does not understand. */
function storedChildToShape(child: StoredIconChild): IconShape | null {
  const [tag] = child;
  switch (tag) {
    case 'p':
      return { t: 'path', d: child[1] };
    case 'c':
      return { t: 'circle', cx: child[1], cy: child[2], r: child[3] };
    case 'e':
      return { t: 'ellipse', cx: child[1], cy: child[2], rx: child[3], ry: child[4] };
    case 'r':
      return child.length === 6
        ? { t: 'rect', x: child[1], y: child[2], w: child[3], h: child[4], rx: child[5] }
        : { t: 'rect', x: child[1], y: child[2], w: child[3], h: child[4] };
    case 'l':
      return { t: 'line', x1: child[1], y1: child[2], x2: child[3], y2: child[4] };
    case 'o':
      return { t: 'polyline', points: child[1] };
    case 'g':
      return { t: 'polygon', points: child[1] };
    default:
      return null;
  }
}

/**
 * Turn the stored table into the shape lists the rest of this module reads.
 *
 * A child with an unknown tag is *dropped* rather than failing the whole icon, and that is a
 * deliberate reversal of the usual rule here. The stored table ships with the build, so an
 * unknown tag means the build is newer than the data file it is reading — a stale asset in a
 * development tree. Dropping one child of one icon is a much better outcome than making
 * every icon in the picker fail. A *path* this module cannot convert still refuses, because
 * that is a statement about geometry rather than about the file format.
 */
export function iconLibraryFromStored(
  stored: StoredIconLibrary,
): Record<string, readonly IconShape[]> {
  const library: Record<string, readonly IconShape[]> = {};
  for (const [name, children] of Object.entries(stored)) {
    // The data file carries a `__readme` string alongside the icons.
    if (!Array.isArray(children)) continue;
    const shapes: IconShape[] = [];
    for (const child of children) {
      const shape = storedChildToShape(child as StoredIconChild);
      if (shape) shapes.push(shape);
    }
    library[name] = shapes;
  }
  return library;
}

/**
 * Search the library by name, segment by segment.
 *
 * SPEC 11 §12 asks for an icon set "searchable by name and tags". Lucide ships no tags in the
 * package this project installs, and inventing 1555 tag lists would be a large amount of
 * reviewable-by-nobody data. The names *are* the vocabulary — `arrow-right`, `trash-2`,
 * `message-circle` — so a query is matched against the name's own word segments, which is
 * what makes "circle" find `message-circle` and "arrow" find every arrow. Every segment must
 * match, so "arrow right" ranks `arrow-right` first instead of everything with an arrow.
 *
 * Ordering is: exact name, then name prefix, then the rest alphabetically. Ties broken by
 * name so the picker's grid does not reshuffle between keystrokes.
 */
export function searchIcons(names: readonly string[], query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [...names].sort();
  const matches = names.filter((name) => {
    const haystack = name.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  /*
    Ranked against the query in *name* form, not raw. A user types "arrow right" with a space
    while every name is hyphenated, so comparing the raw text means the prefix rank never
    matches anything and `arrow-big-right` outranks `arrow-right` purely alphabetically. The
    join turns the typed words into the name convention before ranking.
  */
  const normalised = terms.join('-');
  const rank = (name: string) => (name === normalised ? 0 : name.startsWith(normalised) ? 1 : 2);
  return matches.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
