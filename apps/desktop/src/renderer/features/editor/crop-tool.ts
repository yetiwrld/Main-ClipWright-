/**
 * The Crop tool's frame around the crop gesture (SPEC 10 §8.6).
 *
 * `canvas-drag.ts` already owns the arithmetic of *moving* one crop edge. What this module
 * owns is everything §8.6 asks for around it:
 *
 *   - the **crop rectangle over the uncropped source**, so the user frames the picture rather
 *     than trimming an edge of what is already cropped — a distinction that matters because
 *     the stored values are a *window onto the source*, and an edge-based view of them shows
 *     the window's border but never the picture outside it;
 *   - the **dimmed region outside** that rectangle, which is what makes it read as a crop
 *     frame rather than as four loose grips;
 *   - the **aspect lock** — Free, Original, 1:1, 9:16, 16:9, 4:5, Canvas — which constrains
 *     two edges at once when one is dragged;
 *   - the **apply/cancel** contract: `Enter` commits the session as one undo step, `Esc`
 *     throws it away.
 *
 * All of it is pure, because every rule here has a wrong answer that looks reasonable: an
 * aspect lock that moves the *wrong* edge, a locked aspect that silently refuses a drag, a
 * canvas preset that divides by zero on a portrait composition.
 */

import type { CropEdge, CropEdges } from './canvas-drag.js';

/*
  Re-exported because this module's public surface is the crop *frame*, and every function on
  it takes or returns these edges: a caller that has to reach into `canvas-drag` for the type
  would be importing the gesture arithmetic it deliberately does not need.
*/
export type { CropEdge, CropEdges };

/** The pixel extent a crop can never fall below, per axis (see `MIN_CROP_EXTENT`). */
const MIN_EXTENT = 0.02;

/**
 * The aspect ratios §8.6 offers, in the order the spec lists them.
 *
 * `original` and `canvas` are resolved against the item and the composition respectively,
 * so they are not numbers here — see `resolveAspect`.
 */
export type AspectChoice = 'free' | 'original' | '1:1' | '9:16' | '16:9' | '4:5' | 'canvas';

export const ASPECT_CHOICES: readonly AspectChoice[] = [
  'free',
  'original',
  '1:1',
  '9:16',
  '16:9',
  '4:5',
  'canvas',
];

/** The width/height ratio a fixed choice names, or `null` for one that has to be resolved. */
function fixedAspect(choice: AspectChoice): number | null {
  switch (choice) {
    case '1:1':
      return 1;
    case '9:16':
      return 9 / 16;
    case '16:9':
      return 16 / 9;
    case '4:5':
      return 4 / 5;
    default:
      return null;
  }
}

/**
 * The width/height ratio a choice means for this item, or `null` for "no constraint".
 *
 * `original` is the source's own shape and `canvas` the composition's. Both are ratios in
 * **source pixels**, which is what the crop fractions are relative to — using the item's
 * drawn size instead would make the lock mean something different at every preview zoom.
 *
 * A degenerate size gives `null` rather than `0` or `Infinity`: those would propagate into a
 * locked resize and either collapse the crop to a sliver or make every proposal invalid, and
 * a silently unusable aspect lock is worse than an unlocked one.
 */
export function resolveAspect(
  choice: AspectChoice,
  sizes: { source: { width: number; height: number }; canvas: { width: number; height: number } },
): number | null {
  if (choice === 'free') return null;
  const fixed = fixedAspect(choice);
  if (fixed !== null) return fixed;
  const size = choice === 'original' ? sizes.source : sizes.canvas;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size.width / size.height;
}

/** A rectangle in source fractions: the crop window, `(left, top)` to `(right, bottom)`. */
export interface CropRect {
  left: number;
  top: number;
  /** The right edge's crop fraction — i.e. `crop.right`, not `1 - crop.right`. */
  right: number;
  bottom: number;
}

/** The crop rectangle over the uncropped source, from the stored edges. */
export function cropRect(crop: CropEdges): CropRect {
  const clamp = (value: number | undefined) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value as number)) : 0;
  const left = clamp(crop.left);
  const top = clamp(crop.top);
  const right = clamp(crop.right);
  const bottom = clamp(crop.bottom);
  /*
    The surviving window is `[left, 1 − right] × [top, 1 − bottom]`, and the rectangle is
    expressed in those same "inset from each side" terms so it maps straight back. A crop
    whose insets sum past 1 is corrupt rather than merely extreme; clamping the extent to the
    minimum keeps the rectangle drawable, which is the only useful thing to do with it.
  */
  return {
    left,
    top,
    right: Math.min(right, 1 - left - MIN_EXTENT),
    bottom: Math.min(bottom, 1 - top - MIN_EXTENT),
  };
}

/** The crop rectangle's width and height, as fractions of the source. */
export function cropExtent(rect: CropRect): { width: number; height: number } {
  return { width: 1 - rect.left - rect.right, height: 1 - rect.top - rect.bottom };
}

/**
 * The crop after dragging one edge with an aspect locked (SPEC 10 §8.6).
 *
 * The dragged edge follows the pointer and the *opposite* edge expands or contracts to keep
 * the ratio — which is the behaviour every editor with an aspect lock has, and the only one
 * that lets a user reach the ratio they asked for without also having to drag a second edge.
 * Anchoring instead (holding both neighbours) would make the lock a constraint the user can
 * never satisfy by dragging.
 *
 * `null` when the result cannot be built at all: a ratio that produces a degenerate axis, or
 * a drag that would push the window past the source. Refusing is deliberate — a locked crop
 * that clamps to the minimum produces a sliver the user did not ask for and cannot undo
 * without abandoning the whole gesture.
 */
export function lockedCrop(
  start: CropEdges,
  edge: CropEdge,
  deltaFraction: number,
  aspect: number,
  source: { width: number; height: number },
): CropEdges | null {
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  if (!Number.isFinite(deltaFraction)) return null;
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height)) return null;
  if (source.width <= 0 || source.height <= 0) return null;

  const from = cropRect(start);
  const extent = cropExtent(from);
  const horizontal = edge === 'left' || edge === 'right';

  /*
    The extent along the dragged axis after the drag. `left` and `top` grow *inward* as their
    fraction grows, so their deltas subtract; `right` and `bottom` also grow inward, and they
    are the far edge, so their delta adds to the extent.
  */
  const grown = horizontal
    ? extent.width + (edge === 'left' ? -deltaFraction : deltaFraction)
    : extent.height + (edge === 'top' ? -deltaFraction : deltaFraction);
  const dragged = Math.max(MIN_EXTENT, Math.min(1, grown));

  /*
    The other axis is derived from the ratio in *source fraction* terms, which is why the
    source's pixel size enters: a 9:16 lock on a 1920×1080 source is not 9/16 of the fraction
    width, it is the fraction width that makes the *pixels* come out 9:16.
  */
  const draggedPixels = horizontal ? dragged * source.width : dragged * source.height;
  const otherPixels =
    horizontal ? draggedPixels / aspect : draggedPixels * aspect;
  const other = horizontal ? otherPixels / source.height : otherPixels / source.width;
  if (!Number.isFinite(other) || other < MIN_EXTENT || other > 1) return null;

  /*
    The axis the user did *not* drag is grown from its own centre, so the frame stays where
    the user put it rather than jumping to a corner. That is the other half of "the opposite
    edge follows": on the dragged axis the far edge moves, and on the other one both sides
    move equally.

    No `max(0, …)` on either side, deliberately. Clamping one side to the source and letting
    the guard below refuse the other made the same situation behave two ways: a window sitting
    near the top slid down to stay legal, while the mirror image near the bottom was refused
    outright. Sliding breaks the framing the user chose just as much as refusing does, so both
    sides refuse — which is what this function's contract already promised.
  */
  const next: CropEdges = { ...from };
  if (horizontal) {
    if (edge === 'left') next.left = 1 - next.right - dragged;
    else next.right = 1 - next.left - dragged;
    const centre = from.top + extent.height / 2;
    next.top = centre - other / 2;
    next.bottom = 1 - other - next.top;
  } else {
    if (edge === 'top') next.top = 1 - next.bottom - dragged;
    else next.bottom = 1 - next.top - dragged;
    const centre = from.left + extent.width / 2;
    next.left = centre - other / 2;
    next.right = 1 - other - next.left;
  }

  // A window that falls off the source is not a crop the user can see; refuse it.
  if (next.left < -1e-9 || next.top < -1e-9 || next.right < -1e-9 || next.bottom < -1e-9) {
    return null;
  }
  return {
    left: Math.max(0, next.left),
    top: Math.max(0, next.top),
    right: Math.max(0, next.right),
    bottom: Math.max(0, next.bottom),
  };
}

/**
 * The crop after dragging *inside* the rectangle, which pans the window (SPEC 10 §8.6).
 *
 * Pans by moving both edges of each axis together, so the window's size is untouched — the
 * only gesture where a locked aspect needs no recomputation, because nothing about the shape
 * changes. The window stops at the source's edge rather than being clamped *or* allowed out:
 * `clampPan`-style clamping of the *centre* would let a window narrower than the source slide
 * past the edge, so the bound is applied per side.
 */
export function pannedCrop(
  start: CropEdges,
  by: { x: number; y: number },
): CropEdges {
  const from = cropRect(start);
  const extent = cropExtent(from);
  const shift = (value: number, size: number) => {
    if (!Number.isFinite(value)) return 0;
    // The window's leading inset may sit anywhere from 0 to the largest that still leaves
    // `size` of source visible.
    return Math.min(Math.max(0, value), Math.max(0, 1 - size));
  };
  const left = shift(from.left + (Number.isFinite(by.x) ? by.x : 0), extent.width);
  const top = shift(from.top + (Number.isFinite(by.y) ? by.y : 0), extent.height);
  /*
    The trailing inset comes from the leading one, never from the starting value: writing
    `1 − size − from.right` here left the window growing and shrinking as it was panned, which
    is a bug that hides on a full frame (where the trailing inset is zero) and shows up the
    moment there is one.
  */
  return {
    left,
    top,
    right: 1 - extent.width - left,
    bottom: 1 - extent.height - top,
  };
}

/**
 * Whether two crops are the same, to within a hair, for deciding whether a session is an edit.
 *
 * A crop session that changed nothing must not push an undo step — `Enter` on an untouched
 * frame is a way to dismiss the tool, not an edit. Exact equality would be wrong in the other
 * direction: the fractions come out of float arithmetic, so a drag that returned to its start
 * lands a few ulps away and would be recorded as a change.
 */
export function cropChanged(before: CropEdges, after: CropEdges): boolean {
  const near = (a: number | undefined, b: number | undefined) =>
    Math.abs((a ?? 0) - (b ?? 0)) < 1e-6;
  return (
    !near(before.left, after.left) ||
    !near(before.top, after.top) ||
    !near(before.right, after.right) ||
    !near(before.bottom, after.bottom)
  );
}

/** A corner of the crop rectangle, named by the compass point it sits on. */
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * The crop after dragging one *corner* (SPEC 10 §8.6's eight handles).
 *
 * Free, the two axes are independent and the opposite corner is the fixed point — the same
 * promise a corner scale makes, in crop terms. Locked, one axis leads and the other is
 * derived: the axis the pointer moved further is the one followed, because that is the one
 * the user is actually aiming with. Deriving it from the horizontal delta alone would make a
 * mostly-vertical drag on a wide ratio do almost nothing, which reads as a broken handle.
 *
 * `null` for the same reason `lockedCrop` returns it: a corner drag that cannot be built —
 * because the ratio needs more source than exists, or because the window would degenerate —
 * is refused rather than clamped to a sliver.
 */
export function cornerCrop(
  start: CropEdges,
  corner: CropCorner,
  delta: { x: number; y: number },
  aspect: number | null,
  source: { width: number; height: number },
): CropEdges | null {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return null;
  const from = cropRect(start);
  const extent = cropExtent(from);
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';

  /*
    `delta` is the pointer's movement in source fractions — right-positive, down-positive,
    which is what a drag naturally gives. So the *west* corner shrinks the window when the
    pointer moves right, and the east corner grows it; the sign flip belongs here rather than
    at the call site, where it would have to be repeated once per corner.
  */
  const width = extent.width + (west ? -delta.x : delta.x);
  const height = extent.height + (north ? -delta.y : delta.y);
  if (width < MIN_EXTENT || height < MIN_EXTENT) return null;

  let finalWidth = width;
  let finalHeight = height;
  if (aspect !== null && Number.isFinite(aspect) && aspect > 0) {
    if (!Number.isFinite(source.width) || !Number.isFinite(source.height)) return null;
    if (source.width <= 0 || source.height <= 0) return null;
    /*
      Compare the two axes in source pixels, which is the unit the ratio is stated in. In
      fractions a 0.1 change means different numbers of pixels on a wide source than on a
      tall one, so comparing fractions would pick the wrong leader on exactly the projects
      where the distinction matters.
    */
    const widthPixels = width * source.width;
    const heightPixels = height * source.height;
    const horizontalLeads =
      Math.abs(widthPixels - extent.width * source.width) >=
      Math.abs(heightPixels - extent.height * source.height);
    if (horizontalLeads) {
      finalHeight = widthPixels / aspect / source.height;
    } else {
      finalWidth = heightPixels * aspect / source.width;
    }
  }
  if (finalWidth < MIN_EXTENT || finalHeight < MIN_EXTENT) return null;

  const next: CropEdges = { ...from };
  // The dragged corner moves; the opposite one holds, which is what keeps the picture still
  // under the hand that is not dragging.
  if (west) next.left = 1 - next.right - finalWidth;
  else next.right = 1 - next.left - finalWidth;
  if (north) next.top = 1 - next.bottom - finalHeight;
  else next.bottom = 1 - next.top - finalHeight;

  if (next.left < -1e-9 || next.top < -1e-9 || next.right < -1e-9 || next.bottom < -1e-9) {
    return null;
  }
  return {
    left: Math.max(0, next.left),
    top: Math.max(0, next.top),
    right: Math.max(0, next.right),
    bottom: Math.max(0, next.bottom),
  };
}

/**
 * The crop reshaped to a newly chosen aspect, keeping the window's centre (SPEC 10 §8.6).
 *
 * A lock is a statement about the frame the user is looking at, so choosing one has to change
 * that frame — otherwise the select appears to do nothing until the next drag, which reads as
 * a broken control. The window is inscribed in the old one and centred on it, so the clip's
 * subject stays put, and the largest window of that ratio that fits the *source* is used when
 * the old window cannot contain it.
 */
export function appliedAspect(
  crop: CropEdges,
  aspect: number | null,
  source: { width: number; height: number },
): CropEdges {
  const from = cropRect(crop);
  const extent = cropExtent(from);
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return { ...from };
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height)) return { ...from };
  if (source.width <= 0 || source.height <= 0) return { ...from };

  const ratioPixels = aspect;
  // The current window, in source pixels.
  const widthPixels = extent.width * source.width;
  const heightPixels = extent.height * source.height;
  const wanted =
    widthPixels / heightPixels > ratioPixels
      ? { widthPixels: heightPixels * ratioPixels, heightPixels }
      : { widthPixels, heightPixels: widthPixels / ratioPixels };
  const width = wanted.widthPixels / source.width;
  const height = wanted.heightPixels / source.height;
  const centreX = from.left + extent.width / 2;
  const centreY = from.top + extent.height / 2;
  const left = Math.min(Math.max(0, centreX - width / 2), Math.max(0, 1 - width));
  const top = Math.min(Math.max(0, centreY - height / 2), Math.max(0, 1 - height));
  return { left, top, right: 1 - width - left, bottom: 1 - height - top };
}

/** What a pointer over the crop frame is holding (SPEC 10 §8.6's eight handles plus a pan). */
export type CropGrip = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

/**
 * Which grip a point is over, in fractions of the **uncropped** source.
 *
 * The tolerance is given per axis rather than as one number, because the frame is rarely
 * square: a 12-px grip on a 400×225 box is 3% of the width and 5.3% of the height, and a
 * single fraction would make the vertical grips nearly twice as easy to hit as the horizontal
 * ones. Callers convert pixels into fractions with the box they drew.
 *
 * Corners win over edges, and edges win over the pan, because they overlap: the point 2 px
 * inside the top-left corner is within tolerance of all three, and resizing is the more
 * specific gesture. `null` outside the frame means "not mine" — the dimmed region must not
 * quietly pan the crop when the user aimed at the picture behind it.
 */
export function cropGripAt(
  point: { x: number; y: number },
  rect: CropRect,
  tolerance: { x: number; y: number },
): CropGrip | null {
  const left = rect.left;
  const right = 1 - Math.min(rect.right, 1 - rect.left - MIN_EXTENT);
  const top = rect.top;
  const bottom = 1 - Math.min(rect.bottom, 1 - rect.top - MIN_EXTENT);
  const tolX = Math.max(0, tolerance.x);
  const tolY = Math.max(0, tolerance.y);

  const nearWest = Math.abs(point.x - left) <= tolX;
  const nearEast = Math.abs(point.x - right) <= tolX;
  const nearNorth = Math.abs(point.y - top) <= tolY;
  const nearSouth = Math.abs(point.y - bottom) <= tolY;
  // An axis counts as "on an edge" when either of its two edges is close; the near side is
  // whichever is closer, so a thin window picks the one the pointer is actually against.
  const onX = nearWest || nearEast;
  const onY = nearNorth || nearSouth;
  const sideX = Math.abs(point.x - left) <= Math.abs(point.x - right) ? 'w' : 'e';
  const sideY = Math.abs(point.y - top) <= Math.abs(point.y - bottom) ? 'n' : 's';

  const withinX = point.x >= left - tolX && point.x <= right + tolX;
  const withinY = point.y >= top - tolY && point.y <= bottom + tolY;
  if (!withinX || !withinY) return null;

  if (onX && onY) return `${sideY}${sideX}` as CropGrip;
  if (onX) return sideX as CropGrip;
  if (onY) return sideY as CropGrip;

  const insideX = point.x >= left && point.x <= right;
  const insideY = point.y >= top && point.y <= bottom;
  return insideX && insideY ? 'move' : null;
}

/** Whether a grip resizes the frame, as opposed to panning it. */
export function isResizeGrip(grip: CropGrip): boolean {
  return grip !== 'move';
}

/** The compass cursor for a grip, in the CSS names a browser understands. */
export function gripCursor(grip: CropGrip | null): string {
  switch (grip) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'move':
      return 'move';
    default:
      return 'default';
  }
}

/**
 * A `geometry.radius` (a fraction of the cropped source's short side) as a CSS length.
 *
 * The geometry speaks in fractions because that is what survives being drawn at preview size
 * and exported at full size; the DOM needs pixels. `box` is the **cropped** window's size in
 * the same CSS pixels the layer is drawn at, which is why the radius is a percentage of its
 * short side rather than of the source: a rounded corner belongs to the visible picture.
 *
 * Capped at 50% — see `ItemGeometry.radius` for why a larger value is not a rounder corner.
 */
export function radiusCss(radius: number, box: { width: number; height: number }): string | undefined {
  if (!Number.isFinite(radius) || radius <= 0) return undefined;
  const shortSide = Math.min(box.width, box.height);
  if (!Number.isFinite(shortSide) || shortSide <= 0) return undefined;
  /*
    `radius` is already a fraction of the short side (the geometry's own unit), so it *is* the
    percentage — multiplying by 100 again made every corner a hundred times too tight, which
    reads on screen as "the slider does nothing". The box is only consulted for its
    existence, which is what keeps a zero-sized element from producing `Infinity%`.
  */
  return `${Math.min(50, radius * 100)}%`;
}
