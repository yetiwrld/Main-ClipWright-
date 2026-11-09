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
/**
 * A drawing mapped onto the box, or onto the **square inside it**.
 *
 * `square` exists for icons. A shape's box is a percentage of each axis, so a 50%×50% box in
 * a 16:9 frame is 960×540 px and a rectangle fills it — that is correct for a rectangle. A
 * Lucide icon is square, and mapping one onto 960×540 drew it at aspect 1.668, measured on the
 * rendered star. Shorter side, centred, so the icon keeps its shape and stays where the user
 * put it.
 */
/**
 * The largest square that fits inside a box, centred.
 *
 * The shorter side, not the longer: an icon should never overflow the area the user sized,
 * and centring keeps a dragged icon where it was dragged.
 */
function squareInside(box: AssShapeBox): AssShapeBox {
  const side = Math.min(box.width, box.height);
  return {
    x: box.x + (box.width - side) / 2,
    y: box.y + (box.height - side) / 2,
    width: side,
    height: side,
  };
}

export function assShapeDrawing(
  subpaths: readonly ShapeSubpath[],
  box: AssShapeBox,
  options: { square?: boolean } = {},
): string {
  const target = options.square ? squareInside(box) : box;
  const parts: string[] = [];
  for (const subpath of subpaths) {
    const start = mapPoint(subpath.x, subpath.y, target);
    parts.push(`m${start.x} ${start.y}`);
    let cursor = start;
    for (const segment of subpath.segments) {
      const end = mapPoint(segment.x, segment.y, target);
      if (segment.op === 'line') {
        parts.push(`l${end.x} ${end.y}`);
      } else {
        const c1 = mapPoint(segment.c1x, segment.c1y, target);
        const c2 = mapPoint(segment.c2x, segment.c2y, target);
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
  /*
    `\pos(0,0)`, never `\pos(box.x, box.y)` — and this is measured, not reasoned.

    A drawing's coordinates are absolute in the script's pixel space, and libass *adds* `\pos`
    to them rather than placing the drawing at it. Passing the box origin therefore counted
    the origin twice: a rectangle declared as the centred middle half of a 1920×1080 frame
    (x 480…1440, y 270…810) burned in at x 960…1919, y 540…1079 — offset by exactly the box
    origin and pushed off the bottom-right corner of the frame. Measured by rendering the
    script through ffmpeg and locating the drawn pixels: `\pos(480,270)` put a square drawn
    at (480,270) at (960,540), while `\pos(0,0)` put it at (480,270).

    The parameters stay for the call sites that already pass them, and because `box` still
    documents where the drawing lives — it is simply not something `\pos` may repeat.
  */
  void box;
  return `{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${colour}}`;
}

/**
 * The override block for an **icon**, which is outlined rather than filled.
 *
 * Measured before choosing it: libass strokes a path with `\bord`, using `\3c` (outline
 * colour) for the stroke and `\1c` (primary colour) for the fill. Setting the fill to
 * transparent and the outline to the item's colour is therefore a real stroke of arbitrary
 * width — the same picture the canvas draws with `ctx.stroke()`. Filling instead gives a
 * silhouette, which for Lucide is a different icon: a filled star outline is a solid
 * pentagram and a filled gear is a disc.
 *
 * `\bord` is in script pixels, so the width arrives already scaled — see `iconStrokeInBox`
 * in the compositor, which is the one place the 24-box value becomes a box value.
 *
 * The border also needs `\shad0` for the same reason a shape does: the borrowed caption
 * style has a shadow, and a drop shadow under a stroked icon is a smudge the preview does not
 * show.
 */
export function assIconOverride(strokePx: number, colour: string): string {
  const width = Math.max(1, Math.round(strokePx));
  /*
    The fill is made transparent with `\1a&HFF&`, the *alpha* override — not by writing a
    colour with an FF alpha byte into `\1c`. That distinction is measured, not guessed: with
    `\1c&HFF000000&` a closed path rendered as one solid run 680 px wide, i.e. the fill was
    still opaque and the "outline" was a silhouette. With `\1a&HFF&` the same path renders as
    two crossings of 40 px each, which is a hollow ring — the stroke alone.
  */
  return `{\\an7\\pos(0,0)\\p1\\bord${width}\\shad0\\1a&HFF&\\3c${colour}}`;
}
