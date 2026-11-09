/**
 * Shapes as ASS drawings (SPEC 11 §12, SPEC 14 §4).
 *
 * The problem this solves is silent. A shape was previewed as an SVG path and the
 * burn-in is an ASS script — and until this module existed the script carried no shape
 * at all, so a project with a rectangle over a clip exported a file without it and
 * nothing reported a problem. Same class of bug as a text item that never became a cue.
 *
 * The geometry is *not* redefined here. `shapeGeometry` in the renderer is the single
 * definition, and this module is the second serialiser over it: SVG for the canvas, ASS
 * drawing mode (`\p1`) for the file. Two serialisers over one geometry cannot disagree
 * about where a vertex is, which is the failure mode that matters — a rectangle half a
 * frame out of place looks like a design choice, not a bug.
 *
 * ASS drawing mode differs from SVG in ways that produce a plausible wrong picture
 * rather than an error, so each is handled explicitly:
 *
 * - Coordinates are integers in the script's pixel space, not floats in a 100-box.
 * - A path is closed implicitly, so an *open* path has to stay open by drawing only what
 *   it means to draw — and a closed one needs no `Z`.
 * - Curves are cubics (`b`), which is exactly what `shapeGeometry` emits, so no arc
 *   flattening and no approximation is involved.
 */

import type { ShapeSubpath } from '@clipwright/compositor';

/** Where the 100-box lands in ASS script pixels. */
export interface AssShapeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Maps a point in the 100-box onto the ASS drawing space, rounded to whole pixels. */
function mapPoint(x: number, y: number, box: AssShapeBox): { x: number; y: number } {
  // ASS y grows downwards like SVG, so there is no axis flip here — unlike
  // `assAlignment`, which inverts because ASS *alignment* rows count from the bottom.
  return {
    x: Math.round(box.x + (x / 100) * box.width),
    y: Math.round(box.y + (y / 100) * box.height),
  };
}

/**
 * The `\p1` body for one shape, in ASS drawing commands.
 *
 * Commands are letters followed by numbers with no separators beyond spaces; negative
 * numbers are written plainly (`m-1-2` parses, and spaces are harmless). Every command
 * is absolute, which is what lets a single coordinate mapping serve the whole path.
 */
export function assShapeDrawing(subpaths: readonly ShapeSubpath[], box: AssShapeBox): string {
  const parts: string[] = [];
  for (const subpath of subpaths) {
    const start = mapPoint(subpath.x, subpath.y, box);
    parts.push(`m${start.x} ${start.y}`);
    let cursor = start;
    for (const segment of subpath.segments) {
      const end = mapPoint(segment.x, segment.y, box);
      if (segment.op === 'line') {
        parts.push(`l${end.x} ${end.y}`);
      } else {
        const c1 = mapPoint(segment.c1x, segment.c1y, box);
        const c2 = mapPoint(segment.c2x, segment.c2y, box);
        // `b` takes three points: two controls and the end. ASS has no relative form
        // worth using here, and mixing absolute and relative in one string is the kind
        // of thing that renders correctly in libass and wrongly in something else.
        parts.push(`b${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`);
      }
      cursor = end;
    }
    if (subpath.closed && (cursor.x !== start.x || cursor.y !== start.y)) {
      parts.push(`l${start.x} ${start.y}`);
    }
  }
  return parts.join('');
}

/**
 * The ASS override block that draws a shape.
 *
 * `\bord0` and `\shad0` because a shape is a filled area, not outlined text: the style a
 * shape borrows its colour from is a caption style, and a caption style's outline would
 * otherwise draw a border around a rectangle that the user never asked for and the
 * preview does not show.
 *
 * `\pos` with `\an7` (top-left) matches the drawing space: the coordinates above are
 * absolute within the frame, so an anchor at the centre would shift the whole shape.
 */
export function assShapeOverride(box: AssShapeBox, colour: string): string {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  return `{\\an7\\pos(${x},${y})\\p1\\bord0\\shad0\\1c${colour}}`;
}
