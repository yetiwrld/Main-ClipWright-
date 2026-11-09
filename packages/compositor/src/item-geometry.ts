/**
 * SPEC 10 §8.4–8.6 — where an item's picture goes inside the canvas.
 *
 * Crop, scale, rotation and the canvas framing are stored on the item but, until
 * now, nothing drew them: the preview showed the raw video at `object-fit: contain`
 * and the inspector's crop, scale and rotation fields wrote values that were never
 * read. A control that changes nothing is worse than a missing one — it tells the
 * user their edit was accepted.
 *
 * This module turns those stored values into the one thing a view can apply: a
 * transform to run before drawing the picture, and the rectangle of the source
 * (as fractions) that survives the crop. Both halves of the app that draw a frame
 * — the preview today, the compositor when it lands — should come through here so
 * a crop means the same thing in both.
 *
 * Coordinates. `transform.x/y` are fractions of the canvas side, so a value means
 * the same thing at proxy size and at export size. `scale` is the legacy field
 * older projects carry (`07 §6.2` writes it); when `scaleX` is still at its
 * default of 1 we honour it, so those projects keep the framing they were made
 * with instead of jumping to full size on open.
 */

import { evaluateProperty } from './keyframes.js';

export interface ItemGeometryInput {
  /** Stored crop edges, 0–1, as fractions of the source. */
  crop?: { left?: number; top?: number; right?: number; bottom?: number } | undefined;
  /**
   * Stored transform. `scale` is the pre-keyframe framing field; `scaleX/scaleY`
   * are the per-axis values the inspector writes.
   */
  transform?:
    | {
        x?: number;
        y?: number;
        scale?: number;
        scaleX?: number;
        scaleY?: number;
        rotation?: number;
        /** Pivot as a fraction of the picture (0–1), centre is 0.5 (SPEC 10 §4). */
        anchorX?: number;
        anchorY?: number;
        /**
         * Accepted and ignored on input: the anchor effect is computed here, not
         * supplied. Declared so a resolved geometry can be passed straight back in
         * without a cast, which is what the export does when it re-reads geometry for
         * a later instant.
         */
        resolvedOffsetX?: number;
        resolvedOffsetY?: number;
        flipH?: boolean;
        flipV?: boolean;
      }
    | undefined;
  /**
   * Keyframed properties, keyed the way the item stores them. When present and
   * `timeUs` is given, an animated property overrides its static value — which is
   * what makes a keyframed move actually move (SPEC 12 §2.1).
   */
  keyframes?: Record<string, readonly { timeUs: number; value: unknown; interpolation?: string }[]> | undefined;
  /** The instant to evaluate at. Absent means "use the static values". */
  timeUs?: number | undefined;
  /**
   * The canvas size in pixels, so the anchor's arm can be rotated in one consistent
   * unit. Absent means a square canvas, which is the only shape where the two arms'
   * natural units coincide.
   */
  canvas?: { width: number; height: number } | undefined;
}

/** The source rectangle that survives the crop, as fractions of the source. */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ItemGeometry {
  /** The part of the source to sample. */
  source: SourceRect;
  /** Horizontal offset, as a fraction of the canvas width. */
  offsetX: number;
  /** Vertical offset, as a fraction of the canvas height. */
  offsetY: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise. */
  rotation: number;
  /**
   * The pivot, as a fraction of the picture (0–1). The centre is `0.5, 0.5`.
   *
   * Returned as well as resolved because the preview draws a crosshair on it: the
   * offset below already *contains* the anchor's effect, so a caller that wanted to
   * draw the pivot from the offset would have to invert the maths to find it.
   */
  anchorX: number;
  anchorY: number;
  flipH: boolean;
  flipV: boolean;
  /** True when nothing is set, so a caller can skip the wrapper entirely. */
  identity: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The effective per-axis scale.
 *
 * `scaleX/scaleY` win once either has been moved off 1, because the inspector
 * writes both together; until then the legacy `scale` applies to both axes.
 */
export function effectiveScale(transform: ItemGeometryInput['transform']): { x: number; y: number } {
  const scaleX = transform?.scaleX ?? 1;
  const scaleY = transform?.scaleY ?? 1;
  const legacy = transform?.scale ?? 1;
  const untouched = scaleX === 1 && scaleY === 1;
  return untouched && legacy !== 1 ? { x: legacy, y: legacy } : { x: scaleX, y: scaleY };
}

/**
 * The source rectangle after cropping.
 *
 * Edges are clamped so an over-cropped item (which the command refuses to create,
 * but an old or hand-edited file can contain) still yields a positive-width
 * rectangle rather than a division by zero downstream.
 */
export function croppedSource(crop: ItemGeometryInput['crop']): SourceRect {
  const left = clamp(crop?.left ?? 0, 0, 0.95);
  const top = clamp(crop?.top ?? 0, 0, 0.95);
  const right = clamp(crop?.right ?? 0, 0, 0.95);
  const bottom = clamp(crop?.bottom ?? 0, 0, 0.95);
  // Rounded to a fraction of a source pixel: `1 - 0.1 - 0.3` is 0.6000000000000001
  // in binary floating point, and geometry that differs in the last bit is
  // geometry nobody can compare — not the preview to the export, and not a test
  // to its expectation.
  const extent = (value: number) => Math.max(0.01, Math.round(value * 1e6) / 1e6);
  return { x: left, y: top, width: extent(1 - left - right), height: extent(1 - top - bottom) };
}

/**
 * A property's value at an instant: the keyframed value when the property is
 * animated, otherwise the static one.
 *
 * Animating only *some* properties is the normal case — a clip scaled by the
 * inspector and moved by keyframes has one of each — so this has to fall back per
 * property rather than per item.
 */
function at(keyframes: ItemGeometryInput['keyframes'], timeUs: number | undefined, path: Parameters<typeof evaluateProperty>[1], fallback: number): number {
  if (!keyframes || timeUs === undefined) return fallback;
  return evaluateProperty(keyframes as Parameters<typeof evaluateProperty>[0], path, timeUs, fallback);
}

export function itemGeometry(input: ItemGeometryInput): ItemGeometry {
  const timeUs = input.timeUs;
  // Crop is keyframeable too (`10 §8.6`): a keyframed crop is how a pan-and-zoom
  // is written, and reading only the static crop would freeze it at the first frame.
  const source = croppedSource({
    left: at(input.keyframes, timeUs, 'crop.left', input.crop?.left ?? 0),
    top: at(input.keyframes, timeUs, 'crop.top', input.crop?.top ?? 0),
    right: at(input.keyframes, timeUs, 'crop.right', input.crop?.right ?? 0),
    bottom: at(input.keyframes, timeUs, 'crop.bottom', input.crop?.bottom ?? 0),
  });
  const staticScale = effectiveScale(input.transform);
  const scale = {
    x: at(input.keyframes, timeUs, 'transform.scaleX', staticScale.x),
    y: at(input.keyframes, timeUs, 'transform.scaleY', staticScale.y),
  };
  const rotation = at(input.keyframes, timeUs, 'transform.rotation', input.transform?.rotation ?? 0);
  const anchorX = at(input.keyframes, timeUs, 'transform.anchorX', input.transform?.anchorX ?? 0.5);
  const anchorY = at(input.keyframes, timeUs, 'transform.anchorY', input.transform?.anchorY ?? 0.5);
  /*
    The anchor, folded into the offset (SPEC 10 §4, §8.2).

    The spec's order is `translate(position) · rotate · scale · translate(−anchor)`.
    Both renderers draw the picture centred and then apply `translate(position)` on
    the rotated, scaled element — so what they need is not the stored position but
    where the picture's *centre* must land for the anchor to behave as the pivot:

      offset = position + R · S · (centre − anchor)

    Expressing it this way means neither renderer's transform structure changes: the
    preview keeps its CSS `rotate(...) scale(...)` and the export keeps its ffmpeg
    `rotate`/`scale` chain, and the only shared thing is these two numbers. With the
    anchor at the centre the vector is zero and the offset is exactly `position`, so
    every project saved before anchors existed renders byte-identically.

    Scale applies *before* rotation, per the spec order — that is why the arm is
    scaled and then rotated rather than the other way round, and a test pins the
    difference at an angle where the two orders disagree.
  */
  const positionX = at(input.keyframes, timeUs, 'transform.x', input.transform?.x ?? 0);
  const positionY = at(input.keyframes, timeUs, 'transform.y', input.transform?.y ?? 0);
  /*
    The arm is in canvas fractions. The picture occupies `source.width` ×
    `source.height` of the canvas before scaling, and `source` is already the cropped
    rectangle — so a cropped clip pivots about the part that is actually visible,
    which is the only reading that makes the crosshair land on the picture the user
    is looking at.
  */
  /*
    Both arms are converted into **width** fractions before they are rotated.

    `source.width` is a fraction of the canvas *width* and `source.height` a fraction
    of its *height*, so `armY` is not the same unit as `armX`. Rotating mixes the two
    axes, and a rotation can only be drawn by a `rotate()` — which works in pixels —
    if the vector being turned is in one consistent unit. Adding a height-fraction to
    a width-fraction is the same arithmetic only on a square canvas.

    The error was not small. On the default 1080×1920 canvas, an anchor a quarter down
    the frame and a 90° rotation put the picture 270 px left of where the pivot said it
    should be, instead of 480 px — and the preview drew the crosshair from the pivot,
    so the two disagreed by three quarters of a thousand pixels. A centred anchor
    cancels the arm entirely, which is why nothing caught it until an off-centre one
    was rotated.
  */
  /*
    Width per height. A HEIGHT-fraction becomes a WIDTH-fraction by multiplying by
    height/width — that is, *dividing* by this — because the same pixel distance is a
    larger share of the shorter side.
  */
  const canvasAspect = input.canvas ? input.canvas.width / input.canvas.height : 1;
  const aspectIsUsable = Number.isFinite(canvasAspect) && canvasAspect > 0;
  const armX = (0.5 - anchorX) * source.width * scale.x;
  /*
    `armY` is a fraction of the canvas height. Multiplying by width/height turns it
    into a fraction of the canvas width, which is `armX`'s unit. Guarded so a
    degenerate canvas (height 0) degrades to the old behaviour instead of yielding
    NaN, since a NaN offset blanks the layer without throwing.
  */
  const armY =
    (0.5 - anchorY) * source.height * scale.y * (aspectIsUsable ? 1 / canvasAspect : 1);
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const offsetX = positionX + (cos * armX - sin * armY);
  // Back into height fractions, because `offsetY` is a fraction of the canvas height.
  const offsetY = positionY + (sin * armX + cos * armY) * (aspectIsUsable ? canvasAspect : 1);
  const flipH = input.transform?.flipH ?? false;
  const flipV = input.transform?.flipV ?? false;

  const identity =
    source.x === 0 &&
    source.y === 0 &&
    source.width === 1 &&
    source.height === 1 &&
    offsetX === 0 &&
    offsetY === 0 &&
    scale.x === 1 &&
    scale.y === 1 &&
    rotation === 0 &&
    !flipH &&
    !flipV;

  /*
    An off-centre anchor is *not* an identity even with everything else at rest: it
    moves the picture by half a frame, so a caller that skipped the wrapper would draw
    it in the wrong place. `offsetX/Y` already reflect that, so testing them here is
    both sufficient and the honest expression of what `identity` means.
  */
  return {
    source,
    offsetX,
    offsetY,
    scaleX: scale.x,
    scaleY: scale.y,
    rotation,
    anchorX,
    anchorY,
    flipH,
    flipV,
    identity,
  };
}
