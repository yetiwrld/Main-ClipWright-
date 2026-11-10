/**
 * Shape geometry (SPEC 11 §12).
 *
 * Defined in `compositor` rather than the renderer because it has **two** consumers: the
 * preview serialises it to SVG for the canvas, and the exporter serialises it to ASS
 * drawing commands for the burn-in. A definition living in the renderer could not be
 * reached from `export-core` without inverting the dependency, and the shape would then
 * be drawn by neither — which is exactly what happened before this module existed.
 *
 * Serialisers live with their consumers, not here: the geometry is data (subpaths of
 * lines and cubics in a 100×100 box) and the two output formats are a renderer concern.
 */

/**
 * The shape kinds the renderer can draw, in the order the panel lists them.
 *
 * `shapeKind` on the item is a free string in the schema, so this list is what the
 * editor offers and `shapeGeometry` is what the renderer can actually draw.
 */
export const SHAPE_KINDS = [
  'rect',
  'round-rect',
  'ellipse',
  'triangle',
  'polygon',
  'star',
  'line',
  'arrow',
  'bubble',
] as const;

export type ShapeKind = (typeof SHAPE_KINDS)[number];

/**
 * How a shape kind is written in the UI: `round-rect` → `Round rect`.
 *
 * Derived from the kind rather than kept as a parallel table, so adding a shape to
 * `SHAPE_KINDS` cannot leave a menu showing a raw kebab-case identifier. Only the
 * capitalisation is decided here — the words are the kind's own, which keeps one
 * vocabulary between the schema, the geometry and the control.
 */
export function shapeKindLabel(kind: ShapeKind): string {
  const words = kind.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Shape geometry, defined **once**, in a 100×100 box.
 *
 * Earlier this module produced an SVG path string and the exporter had its own idea of
 * what a shape was — and in practice the exporter had no idea at all, so a shape was
 * drawn by neither renderer. Two serialisers over one geometry is the fix: SVG for the
 * preview, ASS drawing for the burn-in, neither of which can disagree about where a
 * vertex is because both read these numbers.
 *
 * Curves are cubics because both formats can express them exactly. Every arc this
 * project draws is a quarter or half circle, and kappa (0.5522847498) makes a cubic
 * match a quarter circle to within a rounding error — so there is no approximation here
 * to document, which there would be if the arcs were kept as arcs and flattened for ASS.
 */
export type ShapeSegment =
  | { op: 'line'; x: number; y: number }
  | { op: 'cubic'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

export interface ShapeSubpath {
  x: number;
  y: number;
  segments: ShapeSegment[];
  closed: boolean;
}

/** 4/3·(√2−1): the control-point distance that makes a cubic match a quarter circle. */
const KAPPA = 0.5522847498;

const line = (x: number, y: number): ShapeSegment => ({ op: 'line', x, y });

/** A quarter circle from (x0,y0) to (x1,y1) around a corner, bulging outward. */
function corner(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  centreX: number,
  centreY: number
): ShapeSegment {
  // The control points run along the tangents at each end, toward the corner's centre.
  return {
    op: 'cubic',
    c1x: x0 + (centreX - x0) * KAPPA,
    c1y: y0 + (centreY - y0) * KAPPA,
    c2x: x1 + (centreX - x1) * KAPPA,
    c2y: y1 + (centreY - y1) * KAPPA,
    x: x1,
    y: y1,
  };
}

/**
 * The geometry for a shape kind, or `null` for a kind this build cannot draw.
 *
 * `null` rather than a rectangle fallback: an unrecognised kind is a file from a newer
 * version, and drawing a rectangle would be a claim about what the file contains.
 */
export function shapeGeometry(kind: string | undefined): ShapeSubpath[] | null {
  switch (kind) {
    case 'rect':
      return [{ x: 0, y: 0, closed: true, segments: [line(100, 0), line(100, 100), line(0, 100)] }];

    case 'round-rect': {
      const r = 18;
      return [
        {
          x: r,
          y: 0,
          closed: true,
          segments: [
            line(100 - r, 0),
            corner(100 - r, 0, 100, r, 100, 0),
            line(100, 100 - r),
            corner(100, 100 - r, 100 - r, 100, 100, 100),
            line(r, 100),
            corner(r, 100, 0, 100 - r, 0, 100),
            line(0, r),
            corner(0, r, r, 0, 0, 0),
          ],
        },
      ];
    }

    case 'ellipse': {
      const c = 50;
      return [
        {
          x: 0,
          y: 50,
          closed: true,
          segments: [
            // Four quarter turns, each bulging away from the centre.
            corner(0, 50, 50, 0, 0, 0),
            corner(50, 0, 100, 50, 100, 0),
            corner(100, 50, 50, 100, 100, 100),
            corner(50, 100, 0, 50, 0, 100),
          ],
        },
      ];
    }

    case 'triangle':
      return [{ x: 50, y: 0, closed: true, segments: [line(100, 100), line(0, 100)] }];

    case 'polygon': {
      const points = vertices(5, 50, 50, 50, -Math.PI / 2);
      return [{ x: points[0]![0], y: points[0]![1], closed: true, segments: rest(points) }];
    }

    case 'star': {
      const outer = vertices(5, 50, 50, 50, -Math.PI / 2);
      const inner = vertices(5, 50, 50, 50 * 0.4, -Math.PI / 2 + Math.PI / 5);
      const mixed: Array<[number, number]> = [];
      for (let index = 0; index < 5; index += 1) {
        mixed.push(outer[index]!, inner[index]!);
      }
      return [{ x: mixed[0]![0], y: mixed[0]![1], closed: true, segments: rest(mixed) }];
    }

    case 'line':
      // An open path: the caller strokes it. Its thickness is the stroke width, not a
      // second edge, which is why it has no `closed` and no area.
      return [{ x: 0, y: 50, closed: false, segments: [line(100, 50)] }];

    case 'arrow':
      return [
        {
          x: 0,
          y: 42,
          closed: true,
          segments: [
            line(62, 42),
            line(62, 26),
            line(100, 50),
            line(62, 74),
            line(62, 58),
            line(0, 58),
          ],
        },
      ];

    case 'bubble': {
      const r = 12;
      return [
        {
          x: 16,
          y: 4,
          closed: true,
          segments: [
            line(84, 4),
            corner(84, 4, 96, 16, 96, 4),
            line(96, 64),
            corner(96, 64, 84, 76, 96, 76),
            line(40, 76),
            line(20, 96),
            line(20, 76),
            line(16, 76),
            corner(16, 76, 4, 64, 4, 76),
            line(4, 16),
            corner(4, 16, 16, 4, 4, 4),
          ],
        },
      ];
    }

    default:
      return null;
  }
}

/** The remaining points of a polygon as line segments. */
function rest(points: Array<[number, number]>): ShapeSegment[] {
  return points.slice(1).map(([x, y]) => line(x, y));
}

/**
 * The SVG path for a shape kind — the preview's serialiser.
 *
 * Derived from `shapeGeometry`, so it cannot describe a different shape from the one the
 * exporter burns in. Returns `null` for an unrecognised kind, like the geometry.
 */
export function shapePath(kind: string | undefined): string | null {
  const subpaths = shapeGeometry(kind);
  if (!subpaths) return null;
  return subpaths
    .map((subpath) => {
      const parts = [`M${n(subpath.x)} ${n(subpath.y)}`];
      for (const segment of subpath.segments) {
        parts.push(
          segment.op === 'line'
            ? `L${n(segment.x)} ${n(segment.y)}`
            : `C${n(segment.c1x)} ${n(segment.c1y)} ${n(segment.c2x)} ${n(segment.c2y)} ${n(segment.x)} ${n(segment.y)}`
        );
      }
      if (subpath.closed) parts.push('Z');
      return parts.join(' ');
    })
    .join(' ');
}

/** Two decimals — below a device pixel at any sane scale, and keeps the string short. */
function n(value: number): number {
  return Math.round(value * 100) / 100;
}

function vertices(
  count: number,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const angle = startAngle + (index * 2 * Math.PI) / count;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

/**
 * Where a shape sits in the frame, in percent of canvas width and height.
 *
 * Here rather than in the renderer for the same reason the geometry is: the preview
 * positions an SVG element from these numbers and the exporter converts them to ASS
 * script pixels, and two copies of "the default shape is half the frame, centred" is two
 * places for a shape to be drawn somewhere the user did not put it.
 *
 * Percent rather than pixels because the preview is scaled by CSS while the export is
 * rendered at full resolution; a shape positioned in pixels would be the wrong size in
 * one of them.
 */
export interface ShapeBoxPercent {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function shapeBoxAt(transform?: {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
}): ShapeBoxPercent {
  // A zero or negative scale is clamped rather than passed through: a `NaN` or a
  // negative width silently drops an SVG element without throwing, which reads as a
  // missing shape rather than a broken one.
  const scaleX = Math.max(0.01, transform?.scaleX ?? 1);
  const scaleY = Math.max(0.01, transform?.scaleY ?? 1);
  const width = 50 * scaleX;
  const height = 50 * scaleY;
  // `transform.x`/`.y` are fractions of the canvas, so 0.1 is ten percent across.
  const centreX = 50 + (transform?.x ?? 0) * 100;
  const centreY = 50 + (transform?.y ?? 0) * 100;
  return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}
