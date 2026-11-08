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
        flipH?: boolean;
        flipV?: boolean;
      }
    | undefined;
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

export function itemGeometry(input: ItemGeometryInput): ItemGeometry {
  const source = croppedSource(input.crop);
  const scale = effectiveScale(input.transform);
  const offsetX = input.transform?.x ?? 0;
  const offsetY = input.transform?.y ?? 0;
  const rotation = input.transform?.rotation ?? 0;
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

  return { source, offsetX, offsetY, scaleX: scale.x, scaleY: scale.y, rotation, flipH, flipV, identity };
}
