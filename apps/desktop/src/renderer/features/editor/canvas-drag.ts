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

/**
 * The angle of a point about a pivot, in degrees clockwise from straight up.
 *
 * Used by the rotate handle: dragging it is a change in the angle between the pointer
 * and the pivot, so both the start and the current pointer position are measured the
 * same way and subtracted.
 *
 * CSS space has +y *down*, so `atan2(dy, dx)` already increases clockwise on screen.
 * The `+ 90` swings the zero from "right" to "up", which is where a rotation handle
 * sits and therefore what "no change" should read as.
 */
export function angleAbout(pivot: { x: number; y: number }, point: { x: number; y: number }): number {
  const raw = (Math.atan2(point.y - pivot.y, point.x - pivot.x) * 180) / Math.PI + 90;
  /*
    Fold into (−180, 180] to match the range the model stores. `atan2` returns
    (−180, 180], and adding the 90° offset can push that to 270 — the same direction
    as −90, and deltas across it are unaffected, but a value outside the model's own
    range invites a reader to think the two disagree.
  */
  let wrapped = raw;
  while (wrapped <= -180) wrapped += 360;
  while (wrapped > 180) wrapped -= 360;
  return wrapped;
}

/**
 * The shortest way round from one angle to another.
 *
 * Subtracting raw angles breaks at the wrap: a pointer at 170° dragged to −170° has
 * moved 20° clockwise, but `-170 - 170` is −340°, and applying that would throw the
 * clip three quarters of a turn the wrong way. Normalising into (−180, 180] is what
 * makes the handle follow the pointer across the seam.
 */
export function angleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta <= -180) delta += 360;
  while (delta > 180) delta -= 360;
  return delta;
}

/** The rotation range the model accepts, in degrees. */
export const MIN_ROTATION = -180;
export const MAX_ROTATION = 180;

/**
 * The rotation after dragging the handle, wrapped into the model's range.
 *
 * The model stores −180…180 rather than an unbounded angle, so a drag that passes a
 * whole turn has to wrap rather than clamp: clamping would pin the clip at the edge
 * while the pointer kept going, which reads as the handle having jammed.
 */
export function rotatedBy(start: number, delta: number): number {
  // Guard the *result*, not just the delta. A `start` that arrived as `undefined`
  // makes `start + delta` NaN however finite the delta is, and NaN reaches the
  // document as a rotation that blanks the layer. Checking only `delta` was the
  // first version of this and it let exactly that through.
  const from = Number.isFinite(start) ? start : 0;
  if (!Number.isFinite(delta)) return from;
  let next = from + delta;
  while (next > MAX_ROTATION) next -= 360;
  while (next < MIN_ROTATION) next += 360;
  return next;
}

/**
 * Where a pointer lands as a fraction of the picture, accounting for its transform.
 *
 * The anchor crosshair lives *inside* the transformed picture element, so a point
 * the user aims at has to be carried back through the rotation and scale to reach
 * the picture's own coordinates. Measuring against the axis-aligned bounding box
 * instead is only correct while the clip is unrotated and unscaled: a 90° turn swaps
 * the box's axes, and a 2× scale compresses every fraction toward the centre. Both
 * put the crosshair somewhere the user did not point at, silently.
 *
 * The inverse is well-defined because CSS applies `scale` and `rotate` about the
 * element's centre, so the centre is the one point the transform leaves alone:
 *
 *         local = centre + S⁻¹ · R⁻¹ · (pointer − centre)
 *
 * `size` is the element's *untransformed* layout size, not its bounding box.
 */
export function pointerToPictureFraction(
  pointer: { x: number; y: number },
  frame: {
    /** The element's transformed bounding box, in client coordinates. */
    box: { left: number; top: number; width: number; height: number };
    /** The element's untransformed layout size, in CSS pixels. */
    size: { width: number; height: number };
    rotation: number;
    scaleX: number;
    scaleY: number;
  },
): { x: number; y: number } {
  // Scale and rotate are both about the centre, so the centre of the bounding box is
  // the centre of the element — before and after the transform alike.
  const centreX = frame.box.left + frame.box.width / 2;
  const centreY = frame.box.top + frame.box.height / 2;
  const dx = pointer.x - centreX;
  const dy = pointer.y - centreY;

  const radians = (-frame.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // R⁻¹ first, then S⁻¹: the forward order is scale then rotate, so undoing it is
  // unrotate then unscale.
  const unrotatedX = cos * dx - sin * dy;
  const unrotatedY = sin * dx + cos * dy;
  const localX = unrotatedX / (frame.scaleX || 1);
  const localY = unrotatedY / (frame.scaleY || 1);

  // Back into the element's own box, whose top-left is half its size from the centre.
  const fractionX = (localX + frame.size.width / 2) / (frame.size.width || 1);
  const fractionY = (localY + frame.size.height / 2) / (frame.size.height || 1);
  return {
    x: Math.min(1, Math.max(0, fractionX)),
    y: Math.min(1, Math.max(0, fractionY)),
  };
}

/** The four corners, named for the direction they sit in from the picture's centre. */
export type Corner = 'nw' | 'ne' | 'se' | 'sw';

export const CORNERS: readonly Corner[] = ['nw', 'ne', 'se', 'sw'];

/** The corner diagonally across from one, which is the fixed point of a scale. */
export function oppositeCorner(corner: Corner): Corner {
  return ({ nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' } as const)[corner];
}

/** A corner's offset from the picture's centre, as a sign pair in half-extents. */
function cornerSign(corner: Corner): { x: number; y: number } {
  return {
    x: corner === 'nw' || corner === 'sw' ? -1 : 1,
    y: corner === 'nw' || corner === 'ne' ? -1 : 1,
  };
}

/**
 * The scale a corner drag has reached, given how far the pointer has moved.
 *
 * A uniform scale about the opposite corner is determined by the *distance* from that
 * corner: on pointer-down the grabbed corner sits at some distance from the fixed one,
 * and the ratio of the current distance to that original distance is the scale factor.
 * Using distance rather than a per-axis displacement is what makes the gesture feel
 * the same however the picture is rotated — the user is pulling a corner away from the
 * one that stays put, and that is a radial gesture.
 *
 * Returns the factor to multiply the starting scale by, so the caller applies it to
 * whatever the axes already were; a non-uniform clip therefore scales evenly rather
 * than snapping to uniform.
 */
export function cornerScaleFactor(
  pointer: { x: number; y: number },
  fixed: { x: number; y: number },
  startDistance: number,
): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0) return 1;
  const distance = Math.hypot(pointer.x - fixed.x, pointer.y - fixed.y);
  if (!Number.isFinite(distance)) return 1;
  return distance / startDistance;
}

/** Where a picture point ends up on screen, given the transform it is drawn with. */
interface Placement {
  /** Offset of the picture's *unscaled* centre from the canvas centre, in pixels. */
  x: number;
  y: number;
  rotation: number;
  /** Picture units per pixel at scale 1 — the fit's own scaling. */
  unitPerPixel: number;
}

/**
 * The position change that keeps the corner opposite the dragged one still.
 *
 * Scaling happens about the **anchor**, so the arm from the anchor to the picture's
 * content grows with the scale (SPEC 10 §4). Holding a screen point fixed therefore
 * needs both a scale and a compensating move, and the move is not "toward the centre"
 * — it is measured **from the anchor**, because that is the point everything is
 * scaled about:
 *
 *     position' = position + R · (s − s') · (u − anchorOffset)
 *
 * where `u` is the opposite corner's offset from the picture's centre in picture units
 * and `anchorOffset` is the anchor's. With a centred anchor the anchor term vanishes
 * and this reduces to the familiar `R · (s − s') · u`; with an off-centre anchor a
 * shortcut that ignored it would drift the picture a little on every scale, which is
 * the kind of error that only shows up after several drags.
 */
export function scaleAboutCorner(
  options: {
    /** The corner being dragged, and therefore the one opposite it that stays put. */
    corner: Corner;
    /**
     * Scale about the picture's own centre instead of the opposite corner
     * (SPEC 10 §8.2, `Alt`).
     *
     * Holding the centre still is the same arithmetic with the fixed point moved: the
     * corner offset drops to zero and only the anchor's arm remains to be compensated.
     */
    aboutCentre?: boolean;
    /** Scale before and after, as the per-axis pair the model stores. */
    fromScale: { x: number; y: number };
    toScale: { x: number; y: number };
    /** The pivot, 0–1 of the picture. */
    anchorX: number;
    anchorY: number;
    /** The picture's size in picture units, before any scale. */
    width: number;
    height: number;
    rotation: number;
  },
  /** The position the picture started at, in fractions of the canvas. */
  position: { x: number; y: number },
  /** The canvas size in pixels, so the position fractions can be converted. */
  canvas: { width: number; height: number },
): { x: number; y: number } {
  const sign = cornerSign(oppositeCorner(options.corner));
  const halfWidth = options.width / 2;
  const halfHeight = options.height / 2;
  /*
    The fixed point's offset from the picture's centre: the opposite corner normally,
    or the centre itself when `Alt` holds the centre still.
  */
  const cornerX = options.aboutCentre ? 0 : sign.x * halfWidth;
  const cornerY = options.aboutCentre ? 0 : sign.y * halfHeight;
  // The anchor's offset from the centre, which is what the scale grows about.
  const anchorX = (options.anchorX - 0.5) * options.width;
  const anchorY = (options.anchorY - 0.5) * options.height;

  // `fromScale`/`toScale` are uniform here (this handle only scales evenly), so either
  // axis describes the change; averaging keeps a non-uniform clip's factor honest
  // instead of silently reading one axis and ignoring the other.
  const deltaScale =
    (options.fromScale.x + options.fromScale.y) / 2 - (options.toScale.x + options.toScale.y) / 2;

  const radians = (options.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = deltaScale * (cornerX - anchorX);
  const localY = deltaScale * (cornerY - anchorY);

  // Rotate into screen axes, then express the shift as a canvas fraction.
  const screenX = cos * localX - sin * localY;
  const screenY = sin * localX + cos * localY;
  return {
    x: position.x + (canvas.width > 0 ? screenX / canvas.width : 0),
    y: position.y + (canvas.height > 0 ? screenY / canvas.height : 0),
  };
}

/**
 * The corner a pointer is over, or `null`.
 *
 * Corners take priority over edges in the overlay's hit test: a corner sits *at* the
 * end of two edges, and scaling is the more specific gesture, so it wins. The window
 * is square and slightly larger than the drawn square, because a rotated picture's
 * corners are the hardest target on the canvas.
 */
export function cornerAt(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
  rotation: number,
  reach = HANDLE_SIZE,
): Corner | null {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;
  let best: { corner: Corner; distance: number } | null = null;
  for (const corner of CORNERS) {
    const sign = cornerSign(corner);
    const localX = (sign.x * rect.width) / 2;
    const localY = (sign.y * rect.height) / 2;
    const cornerX = centreX + cos * localX - sin * localY;
    const cornerY = centreY + sin * localX + cos * localY;
    const distance = Math.hypot(point.x - cornerX, point.y - cornerY);
    if (distance <= reach && (!best || distance < best.distance)) best = { corner, distance };
  }
  return best ? best.corner : null;
}

/** The smallest scale a handle will produce, matching the inspector's own floor. */
export const MIN_SCALE = 0.1;
/** The largest, likewise. */
export const MAX_SCALE = 4;

/**
 * Which way a move is locked when `Shift` is held.
 *
 * A locked move follows whichever axis the pointer has travelled furthest along, so
 * the drag commits to the direction the user is clearly going rather than flickering
 * between the two while the pointer wanders.
 */
export function lockedAxis(delta: { xPixels: number; yPixels: number }): 'x' | 'y' {
  return Math.abs(delta.xPixels) >= Math.abs(delta.yPixels) ? 'x' : 'y';
}

/**
 * A rotation snapped to 15° steps (SPEC 10 §8.2, `Shift`).
 *
 * The cardinals fall out of this for free — 90° and 180° are multiples of 15 — so
 * there is one rule here rather than a step rule plus a separate cardinal rule that
 * could disagree with it near a tie.
 */
export const ROTATION_STEP = 15;

export function snapRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const snapped = Math.round(degrees / ROTATION_STEP) * ROTATION_STEP;
  /*
    Rounded before returning so 15·k does not arrive as 44.99999999999999 and a user
    reading the inspector sees the number they aimed at.

    The `+ 0` folds a negative zero into zero. JavaScript produces `-0` for an exact
    negative multiple (`-90 % 15`), and `-0` is a trap: it fails `Object.is(x, 0)`,
    it prints as `-0` in a readout, and it only survives serialisation by luck. A
    rotation of zero is zero.
  */
  return Math.round(rotatedBy(0, snapped)) + 0;
}

/**
 * The non-uniform scale a `Shift` corner drag has reached (`Shift` *toggles* uniform
 * into free scale, per SPEC 10 §8.2).
 *
 * The pointer is carried back into the picture's own frame using the transform the
 * drag **started** with, and each axis is then the ratio of the pointer's offset from
 * the fixed corner to what that offset was at pointer-down. Carrying the pointer back
 * is what makes this feel right on a rotated clip: without it the axes follow the
 * screen, so pulling "down" on a clip turned 90° would widen it instead of heightening
 * it.
 *
 * Ratios are clamped, not allowed to go negative: a pointer dragged past the fixed
 * corner would otherwise mirror the picture, and mirroring is a separate property
 * (`flipH`/`flipV`) with its own semantics — a scale gesture should not smuggle it in.
 */
export function freeScaleAboutCorner(
  pointer: { x: number; y: number },
  options: {
    /** Where the fixed corner is on screen, in client coordinates. */
    fixed: { x: number; y: number };
    /** The pointer's position at pointer-down, in client coordinates. */
    start: { x: number; y: number };
    /** The scale the drag started from. */
    startScale: { x: number; y: number };
    /** The clip's rotation in degrees, so the pointer can be carried back. */
    rotation: number;
  },
): { x: number; y: number } {
  const radians = (-options.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  /** The pointer's offset from the fixed corner, in the picture's own axes. */
  const local = (point: { x: number; y: number }) => {
    const dx = point.x - options.fixed.x;
    const dy = point.y - options.fixed.y;
    return { x: cos * dx - sin * dy, y: sin * dx + cos * dy };
  };
  const from = local(options.start);
  const now = local(pointer);
  const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  /*
    A zero denominator is the pointer starting exactly on the fixed corner, which is a
    degenerate grab rather than a scale: dividing gives `Infinity`, which clamps to the
    maximum and would fling the clip to full size. Leaving that axis alone is the only
    honest answer.
  */
  const ratio = (before: number, after: number) =>
    Math.abs(before) < 1e-6 ? 1 : after / before;
  return {
    x: clamp(options.startScale.x * ratio(from.x, now.x)),
    y: clamp(options.startScale.y * ratio(from.y, now.y)),
  };
}

/**
 * The scale a drag has reached when `Alt` holds the **centre** still instead of the
 * opposite corner (SPEC 10 §8.2).
 *
 * Scaling about the centre is the same radial gesture with a different fixed point,
 * so it reuses `cornerScaleFactor` — the corner the user grabbed is simply measured
 * against the picture's centre rather than against the corner across from it.
 */
export function scaleAboutCentre(
  pointer: { x: number; y: number },
  centre: { x: number; y: number },
  startDistance: number,
): number {
  return cornerScaleFactor(pointer, centre, startDistance);
}
