/**
 * On-canvas drag editing (SPEC 12 Phase 4): moving and crop-framing a clip by
 * dragging its picture in the preview.
 *
 * The arithmetic is here, as pure functions, for the same reason `keyframe-controls`
 * is: the interesting part is not the pointer plumbing but the relationship between
 * a mouse movement in pixels and a value stored as a *fraction of the canvas*, and
 * that relationship has to hold at any preview size. The preview is scaled to fit
 * its panel, so one pixel of pointer travel means a different fraction on a large
 * window than on a small one, and a drag that ignored that would move a clip twice
 * as far on a maximised window as on a small one.
 *
 * Two separate notions of "drag" live here:
 *
 * - **Move** changes `transform.x/y`, the clip's position on the canvas.
 * - **Crop** changes `crop.left/top/right/bottom`, pulling the picture's edges in.
 *
 * They are deliberately not the same gesture with a modifier: dragging a clip moves
 * it, dragging an edge handle crops it, which is the convention every editor shares.
 */

/** The canvas rectangle the preview is drawing into, in CSS pixels. */
export interface CanvasRect {
  width: number;
  height: number;
}

/**
 * How much of a stored fraction one pixel of pointer travel is worth.
 *
 * `transform.x/y` are fractions of the canvas *width* and *height* respectively, so
 * a horizontal drag is measured against the width and a vertical one against the
 * height — dividing both by one dimension would make a drag feel faster vertically
 * on a wide canvas, which is the sort of thing that reads as "the drag is broken on
 * landscape projects" rather than as a missing division.
 */
export function pixelsToFraction(deltaPixels: number, extentPixels: number): number {
  if (!Number.isFinite(extentPixels) || extentPixels <= 0) return 0;
  return deltaPixels / extentPixels;
}

/**
 * The new `transform.x`/`transform.y` after a drag, clamped so the clip can still be
 * reached.
 *
 * The bound is ±1: one full canvas side. A clip may legitimately be pushed mostly
 * off — an overlay sliding out of frame is a real edit — but a clip parked at ±50
 * canvas-widths is a lost clip, and any pointer slip past that is not an intention
 * worth honouring. The clamp is applied to the *result*, not the delta, so a drag
 * that runs past the limit and comes back resumes from the limit rather than
 * accumulating a hidden offset.
 */
export function movedOffset(
  start: { x: number; y: number },
  delta: { xPixels: number; yPixels: number },
  canvas: CanvasRect,
): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(-1, value));
  /*
    `?? 0` rather than trusting the caller: the schema defaults these fields, so a
    normal project always has them, but a hand-edited or migrated one may not. An
    `undefined` start turns the sum into `NaN`, and `NaN` multiplies through the
    transform into a layer that is not drawn at all — a drag that makes the clip
    vanish instead of move.
  */
  return {
    x: clamp((start.x ?? 0) + pixelsToFraction(delta.xPixels, canvas.width)),
    y: clamp((start.y ?? 0) + pixelsToFraction(delta.yPixels, canvas.height)),
  };
}

/** The four crop edges, as stored fractions of the source. */
export interface CropEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type CropEdge = keyof CropEdges;

/** The smallest picture a crop may leave, as a fraction of the source. */
export const MIN_CROP_EXTENT = 0.02;

/**
 * The new crop after dragging one edge.
 *
 * The opposite edge is the fixed reference: dragging `left` inward reveals less of
 * the left side and leaves `right` alone, which is what makes an edge handle feel
 * attached to the edge rather than to the picture as a whole.
 *
 * Two boundaries matter and they are different:
 *
 * - an edge cannot cross its opposite (that would invert the picture), and
 * - the surviving extent cannot fall below `MIN_CROP_EXTENT`, because a zero-width
 *   crop divides by zero everywhere downstream — the CSS uses it as a percentage
 *   denominator and the export's filter chain scales by it.
 *
 * They are enforced separately rather than assumed to be equivalent: crops are
 * fractions of the *source*, so `left + right` is the bound in that space, and the
 * arithmetic is easier to get right when it says exactly what it means.
 */
export function croppedEdge(
  start: CropEdges,
  edge: CropEdge,
  deltaFraction: number,
): CropEdges {
  // Same reasoning as `movedOffset`: a missing edge would poison the arithmetic.
  const next: CropEdges = {
    left: start.left ?? 0,
    top: start.top ?? 0,
    right: start.right ?? 0,
    bottom: start.bottom ?? 0,
  };
  if (!Number.isFinite(deltaFraction) || deltaFraction === 0) return next;

  if (edge === 'left' || edge === 'right') {
    // The opposite edge is the fixed pivot. `left` grows toward `right`, `right`
    // grows toward `left`, so the sign of a positive drag differs between them.
    const opposite = edge === 'left' ? next.right : next.left;
    const maximum = 1 - opposite - MIN_CROP_EXTENT;
    const proposed = edge === 'left' ? next.left + deltaFraction : next.right - deltaFraction;
    next[edge] = Math.min(maximum, Math.max(0, proposed));
    return next;
  }

  const opposite = edge === 'top' ? next.bottom : next.top;
  const maximum = 1 - opposite - MIN_CROP_EXTENT;
  const proposed = edge === 'top' ? next.top + deltaFraction : next.bottom - deltaFraction;
  next[edge] = Math.min(maximum, Math.max(0, proposed));
  return next;
}

/**
 * Which edge handle, if any, a pointer is over.
 *
 * Handles are drawn as a border on the clip, so the hit test is against the clip's
 * own drawn rectangle: within `HANDLE_SIZE` of an edge, on the inside. Testing the
 * inside only matters because the picture continues past the element in every
 * direction once it is scaled, and a handle that could be grabbed from outside the
 * frame would sit on top of whatever is behind the clip.
 *
 * The centre returns `null` — that is the move grip.
 */
export const HANDLE_SIZE = 10;

export function handleAt(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
  handleSize = HANDLE_SIZE,
): CropEdge | null {
  const inside =
    point.x >= rect.x - handleSize &&
    point.x <= rect.x + rect.width + handleSize &&
    point.y >= rect.y - handleSize &&
    point.y <= rect.y + rect.height + handleSize;
  if (!inside) return null;
  // Each edge is decided by whichever border is nearest, so a corner picks one
  // rather than reporting two — the pointer drags one edge at a time, and a corner
  // handle that did both would need a diagonal drag to feel right.
  const distances: Array<[CropEdge, number]> = [
    ['left', Math.abs(point.x - rect.x)],
    ['right', Math.abs(point.x - (rect.x + rect.width))],
    ['top', Math.abs(point.y - rect.y)],
    ['bottom', Math.abs(point.y - (rect.y + rect.height))],
  ];
  const nearest = distances.reduce((best, candidate) =>
    candidate[1] < best[1] ? candidate : best,
  );
  return nearest[1] <= handleSize ? nearest[0] : null;
}
