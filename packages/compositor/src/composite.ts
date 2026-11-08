/**
 * SPEC 10 §2/§6 — compositing YUV frames in software.
 *
 * The export used to resolve two visible items by painting the topmost one and
 * discarding the rest, so an overlay clip, a fade or a `multiply` layer arrived in
 * the file as an opaque, normal rectangle — or as nothing at all. The preview
 * composites with CSS; this is the same operation for the export pipeline, which
 * has raw `yuv420p` frames rather than a DOM.
 *
 * Everything here works in **non-linear sRGB**, which is what CSS blends in and
 * what ffmpeg's own `blend` filter operates on. Compositing in linear light would
 * look different from the preview for the same numbers, and the preview is the
 * thing the user approved.
 *
 * Two deliberate approximations, both documented in `docs/limitations.md`:
 * chroma is upsampled nearest-neighbour rather than the bilinear the encoder uses,
 * because 4:2:0 chroma is already a subsample and the difference is below one
 * level in most pixels; and the YUV↔RGB matrices are plain BT.709 transforms with
 * no colour-management or gamma handling beyond the transfer already baked into
 * the source.
 */

import type { BlendMode } from './layers.js';

/** One decoded frame, planar YUV 4:2:0, tightly packed. */
export interface YuvFrame {
  width: number;
  height: number;
  /** Luma plane, `width × height`. */
  y: Uint8Array;
  /** Cb plane, `ceil(width/2) × ceil(height/2)`. */
  u: Uint8Array;
  /** Cr plane, `ceil(width/2) × ceil(height/2)`. */
  v: Uint8Array;
}

/** An RGB frame at 8 bits per channel. */
export interface RgbFrame {
  width: number;
  height: number;
  /** `width × height × 3`, interleaved R,G,B. */
  data: Uint8ClampedArray;
}

/** Bytes in a tightly packed `yuv420p` frame of this size. */
export function yuvFrameBytes(width: number, height: number): number {
  return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/**
 * Split a raw `yuv420p` buffer into its three planes.
 *
 * The planes are views on the same buffer, not copies: an export reads thousands
 * of frames and a copy per plane would double the per-frame allocation.
 */
export function splitYuv(buffer: Uint8Array, width: number, height: number): YuvFrame {
  const ySize = width * height;
  const chromaSize = Math.ceil(width / 2) * Math.ceil(height / 2);
  return {
    width,
    height,
    y: buffer.subarray(0, ySize),
    u: buffer.subarray(ySize, ySize + chromaSize),
    v: buffer.subarray(ySize + chromaSize, ySize + chromaSize * 2),
  };
}

/** Lay the planes back out as one buffer, in the order ffmpeg expects. */
export function joinYuv(frame: YuvFrame): Buffer {
  const ySize = frame.width * frame.height;
  const chromaSize = Math.ceil(frame.width / 2) * Math.ceil(frame.height / 2);
  const out = Buffer.allocUnsafe(ySize + chromaSize * 2);
  out.set(frame.y, 0);
  out.set(frame.u, ySize);
  out.set(frame.v, ySize + chromaSize);
  return out;
}

/**
 * Luma weights, per matrix. 709 is what the export tags and what swscale uses when
 * it is told to; 601 is swscale's *default* when it is not, so a frame can arrive
 * in either and decoding it with the wrong one shifts every colour.
 */
const LUMA_WEIGHTS = {
  bt709: { kr: 0.2126, kg: 0.7152, kb: 0.0722 },
  bt601: { kr: 0.299, kg: 0.587, kb: 0.114 },
} as const;

/** Colour matrix of the frames being composited. */
export type ColorMatrix = keyof typeof LUMA_WEIGHTS;

const KR = LUMA_WEIGHTS.bt709.kr;
const KG = LUMA_WEIGHTS.bt709.kg;
const KB = LUMA_WEIGHTS.bt709.kb;

/**
 * Convert one frame to RGB.
 *
 * `into` lets a caller reuse a buffer across frames; the export composites frame
 * after frame at a fixed size, and allocating 6 MB per layer per frame is how a
 * compositor turns a 30-second export into a coffee break.
 */
export function yuvToRgb(
  frame: YuvFrame,
  into?: RgbFrame,
  matrix: ColorMatrix = 'bt709',
): RgbFrame {
  const { width, height, y, u, v } = frame;
  // The chroma scale factors follow from the luma weights: the same constants
  // swscale uses, derived rather than copied, so a 601 frame cannot be decoded
  // with 709's Cr coefficient (about a 6 % saturation error, and reds go orange).
  const { kr, kb } = LUMA_WEIGHTS[matrix];
  const kg = 1 - kr - kb;
  // Inverse of the forward transform, whose chroma channels are scaled so that a
  // full-range difference signal spans ±0.5:
  //   R' = Y' + 2(1−Kr)·Cr
  //   G' = Y' − 2Kb(1−Kb)/Kg·Cb − 2Kr(1−Kr)/Kg·Cr
  //   B' = Y' + 2(1−Kb)·Cb
  const rCr = 2 * (1 - kr);
  const gCb = (2 * kb * (1 - kb)) / kg;
  const gCr = (2 * kr * (1 - kr)) / kg;
  const bCb = 2 * (1 - kb);
  const out =
    into && into.width === width && into.height === height
      ? into
      : { width, height, data: new Uint8ClampedArray(width * height * 3) };
  const data = out.data;

  for (let row = 0; row < height; row += 1) {
    const yRow = row * width;
    // 4:2:0: one chroma sample covers a 2×2 block, so a whole row shares it.
    const cRow = (row >> 1) * Math.ceil(width / 2);
    let o = yRow * 3;
    for (let col = 0; col < width; col += 1) {
      const c = cRow + (col >> 1);
      const yn = (y[yRow + col]! - 16) / 219;
      const cb = (u[c]! - 128) / 224;
      const cr = (v[c]! - 128) / 224;
      // R' = Y' + 2(1−Kr)Cr', G' = Y' − 2Kb(1−Kb)/Kg·Cb' − 2Kr(1−Kr)/Kg·Cr',
      // B' = Y' + 2(1−Kb)Cb' — the inverse of the matrix's forward transform.
      data[o] = (yn + rCr * cr) * 255;
      data[o + 1] = (yn - gCb * cb - gCr * cr) * 255;
      data[o + 2] = (yn + bCb * cb) * 255;
      o += 3;
    }
  }
  return out;
}

/** Convert RGB back to `yuv420p`, averaging each 2×2 block's chroma. */
export function rgbToYuv(frame: RgbFrame): YuvFrame {
  const { width, height, data } = frame;
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const y = new Uint8Array(width * height);
  const u = new Uint8Array(cw * ch);
  const v = new Uint8Array(cw * ch);

  for (let row = 0; row < height; row += 1) {
    const yRow = row * width;
    for (let col = 0; col < width; col += 1) {
      const o = (yRow + col) * 3;
      const r = data[o]! / 255;
      const g = data[o + 1]! / 255;
      const b = data[o + 2]! / 255;
      y[yRow + col] = 16 + 219 * (KR * r + KG * g + KB * b);
    }
  }

  for (let row = 0; row < height; row += 2) {
    for (let col = 0; col < width; col += 2) {
      // Subsample by averaging the (up to) four pixels the chroma sample covers.
      // A single pixel's chroma would shift edge colours; the average is what a
      // box filter does and is within one level of ffmpeg's own downscale.
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let dy = 0; dy < 2 && row + dy < height; dy += 1) {
        for (let dx = 0; dx < 2 && col + dx < width; dx += 1) {
          const o = ((row + dy) * width + col + dx) * 3;
          sumR += data[o]!;
          sumG += data[o + 1]!;
          sumB += data[o + 2]!;
          count += 1;
        }
      }
      const r = sumR / count / 255;
      const g = sumG / count / 255;
      const b = sumB / count / 255;
      const luma = KR * r + KG * g + KB * b;
      const c = (row >> 1) * cw + (col >> 1);
      u[c] = 128 + 224 * ((b - luma) / 1.8556);
      v[c] = 128 + 224 * ((r - luma) / 1.5748);
    }
  }

  return { width, height, y, u, v };
}

/** One channel's blend result, both inputs and the output in 0–1. */
function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs;
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay':
      // Overlay is HardLight with the operands swapped.
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'add':
      // CSS `plus-lighter`: a sum, clamped at white.
      return Math.min(1, cb + cs);
    case 'soft-light': {
      // The W3C compositing spec's soft-light, including its `D(cb)` helper.
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
  }
}

/**
 * Composite `layer` over `base`, in place on `base`.
 *
 * Both frames must be the same size. `opacity` is the layer's own alpha; the
 * layer pixels themselves carry no alpha channel, so a layer is always a full
 * opaque picture being mixed at a fraction. That is the case the timeline
 * produces: a clip fills its crop rectangle, and `opacity` fades it to the picture
 * underneath.
 *
 * The formula is the CSS one with `αb = 1`:
 *
 *     Cr = αs·B(Cb, Cs) + (1 − αs)·Cb
 *
 * The tempting shortcut — the blend result times `αs` — fades the layer to *black*
 * instead of to the backdrop, which is the mistake the preview's CSS gets right
 * for free and hand-written compositors usually get wrong.
 */
export function compositeRgb(
  base: RgbFrame,
  layer: RgbFrame,
  opacity: number,
  mode: BlendMode,
): void {
  const alpha = Math.min(1, Math.max(0, opacity));
  if (alpha <= 0) return;
  if (base.width !== layer.width || base.height !== layer.height) {
    throw new Error(
      `Cannot composite a ${layer.width}×${layer.height} layer onto a ${base.width}×${base.height} frame.`,
    );
  }
  const out = base.data;
  const src = layer.data;
  const count = out.length;

  if (mode === 'normal' && alpha >= 1) {
    out.set(src);
    return;
  }

  for (let i = 0; i < count; i += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const cb = out[i + channel]! / 255;
      const cs = src[i + channel]! / 255;
      const blended = blendChannel(mode, cb, cs);
      out[i + channel] = (alpha * blended + (1 - alpha) * cb) * 255;
    }
  }
}

/**
 * Composite a layer shifted horizontally by a fraction of the frame (SPEC 12 §4.2,
 * `slide`).
 *
 * A slide moves the picture, not its opacity: the incoming clip enters from one
 * side while the outgoing one exits the other, and mid-transition both are on
 * screen. The shift is expressible only as a translated composite — an offset in
 * the item's geometry would be baked into the decoder and could not animate without
 * one decoder per frame.
 *
 * Pixels the layer no longer covers keep whatever is underneath, which is what makes
 * the two clips meet at a seam rather than overlapping. `offsetX` is in frame widths
 * and positive moves the layer right.
 */
export function compositeRgbShifted(
  base: RgbFrame,
  layer: RgbFrame,
  opacity: number,
  mode: BlendMode,
  offsetX: number,
  offsetY = 0,
): void {
  const alpha = Math.min(1, Math.max(0, opacity));
  if (alpha <= 0) return;
  if (base.width !== layer.width || base.height !== layer.height) {
    throw new Error(
      `Cannot composite a ${layer.width}×${layer.height} layer onto a ${base.width}×${base.height} frame.`,
    );
  }
  const shiftX = Math.round(offsetX * base.width);
  const shiftY = Math.round(offsetY * base.height);
  // A whole-frame shift that lands entirely off canvas contributes nothing; doing
  // the loop anyway would walk every pixel to discover that.
  if (Math.abs(shiftX) >= base.width || Math.abs(shiftY) >= base.height) return;

  const out = base.data;
  const src = layer.data;
  const width = base.width;
  const height = base.height;
  const xFrom = Math.max(0, shiftX);
  const xTo = Math.min(width, width + shiftX);
  const yFrom = Math.max(0, shiftY);
  const yTo = Math.min(height, height + shiftY);
  for (let y = yFrom; y < yTo; y += 1) {
    const sourceY = y - shiftY;
    for (let x = xFrom; x < xTo; x += 1) {
      const sourceX = x - shiftX;
      const i = (y * width + x) * 3;
      const j = (sourceY * width + sourceX) * 3;
      if (mode === 'normal' && alpha >= 1) {
        out[i] = src[j]!;
        out[i + 1] = src[j + 1]!;
        out[i + 2] = src[j + 2]!;
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const cb = out[i + channel]! / 255;
        const cs = src[j + channel]! / 255;
        const blended = blendChannel(mode, cb, cs);
        out[i + channel] = (alpha * blended + (1 - alpha) * cb) * 255;
      }
    }
  }
}

/**
 * Composite a layer through a per-pixel alpha mask (SPEC 12 §4.2, `wipe`).
 *
 * A wipe cannot be expressed as an opacity — which pixels belong to which side
 * depends on where they are — so the renderer builds the mask with
 * `wipeAlphaAt` and composites through it here. The mask is multiplied into the
 * layer's opacity, so a half-transparent layer under a wipe still fades correctly.
 *
 * `mask` holds one value per pixel, row-major, matching the layer's dimensions.
 */
export function compositeRgbMasked(
  base: RgbFrame,
  layer: RgbFrame,
  opacity: number,
  mode: BlendMode,
  mask: Float32Array | Uint8Array,
): void {
  const alpha = Math.min(1, Math.max(0, opacity));
  if (alpha <= 0) return;
  if (base.width !== layer.width || base.height !== layer.height) {
    throw new Error(
      `Cannot composite a ${layer.width}×${layer.height} layer onto a ${base.width}×${base.height} frame.`,
    );
  }
  const pixels = base.width * base.height;
  if (mask.length < pixels) {
    throw new Error(`A mask of ${mask.length} values cannot cover ${pixels} pixels.`);
  }
  const out = base.data;
  const src = layer.data;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const m = mask[pixel]!;
    // Fully transparent and fully opaque are the two common cases and skipping
    // them is what keeps a 1080p wipe export from spending its time on arithmetic
    // that changes nothing.
    if (m <= 0) continue;
    const i = pixel * 3;
    if (m >= 1) {
      if (mode === 'normal' && alpha >= 1) {
        out[i] = src[i]!;
        out[i + 1] = src[i + 1]!;
        out[i + 2] = src[i + 2]!;
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const cb = out[i + channel]! / 255;
        const cs = src[i + channel]! / 255;
        const blended = blendChannel(mode, cb, cs);
        out[i + channel] = (alpha * blended + (1 - alpha) * cb) * 255;
      }
      continue;
    }
    const a = alpha * m;
    for (let channel = 0; channel < 3; channel += 1) {
      const cb = out[i + channel]! / 255;
      const cs = src[i + channel]! / 255;
      const blended = blendChannel(mode, cb, cs);
      out[i + channel] = (a * blended + (1 - a) * cb) * 255;
    }
  }
}

/**
 * Composite every layer of a frame onto its base, in order.
 *
 * Layers are bottom-first, as `visibleLayers` returns them; each one replaces the
 * accumulated picture. This is the whole of "the export honours layering" —
 * `decode-frame-source` calls it with the frames it decoded.
 */
export function compositeLayers(
  base: RgbFrame,
  layers: ReadonlyArray<{ frame: RgbFrame; opacity: number; blendMode: BlendMode }>,
): void {
  for (const layer of layers) {
    compositeRgb(base, layer.frame, layer.opacity, layer.blendMode);
  }
}
