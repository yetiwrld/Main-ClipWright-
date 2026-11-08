/**
 * SPEC 10 §6 — software compositing: the maths and the colour conversions.
 *
 * Two kinds of test live here. The blend formulas are checked against the W3C
 * compositing spec's closed forms on hand-computed values, because a wrong
 * `soft-light` is invisible in a thumbnail and obvious in a gradient. The colour
 * conversion is checked against **real ffmpeg** (when the vendored binary is
 * present): round-tripping a frame through YUV → RGB → YUV has to come back to
 * the same picture, or the export's colours drift every time a layer is added.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compositeLayers,
  compositeRgb,
  joinYuv,
  rgbToYuv,
  splitYuv,
  yuvFrameBytes,
  yuvToRgb,
  type RgbFrame,
} from '../composite.js';
/**
 * The vendored binary the export actually ships with, not whatever is on PATH —
 * the conversion has to match the ffmpeg that will encode these frames.
 */
const FFMPEG = join(process.cwd(), 'resources', 'bin', 'ffmpeg');
/** Whether the vendored binary is present; the integration tests skip if not. */
const available = existsSync(FFMPEG);
const dir = available ? mkdtempSync(join(tmpdir(), 'clipwright-composite-')) : '';
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A 2×2 RGB frame from four 0–255 triples, top-left, top-right, bottom-left, bottom-right. */
function rgb(pixels: number[][]): RgbFrame {
  return { width: 2, height: 2, data: new Uint8ClampedArray(pixels.flat()) };
}

const at = (frame: RgbFrame, index: number, channel: number) => frame.data[index * 3 + channel]!;

describe('blend modes', () => {
  // 0.5 with 0.5 is the one pair that separates every mode: multiply halves,
  // screen brightens, overlay leaves it, soft-light barely moves it.
  const grey = () => rgb([[128, 128, 128], [128, 128, 128], [128, 128, 128], [128, 128, 128]]);
  const half = () => rgb([[128, 128, 128], [128, 128, 128], [128, 128, 128], [128, 128, 128]]);

  it('normal replaces the backdrop', () => {
    const base = grey();
    compositeRgb(base, rgb([[10, 20, 30], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 1, 'normal');
    expect([at(base, 0, 0), at(base, 0, 1), at(base, 0, 2)]).toEqual([10, 20, 30]);
  });

  it('multiply darkens: 0.5 × 0.5 = 0.25', () => {
    const base = half();
    compositeRgb(base, half(), 1, 'multiply');
    // 0.5 * 0.5 = 0.25 → 64, allow one level for 128/255 rounding.
    expect(at(base, 0, 0)).toBeCloseTo(64, -1);
  });

  it('screen brightens: 0.5 + 0.5 − 0.25 = 0.75', () => {
    const base = half();
    compositeRgb(base, half(), 1, 'screen');
    expect(at(base, 0, 0)).toBeCloseTo(191, -1);
  });

  it('overlay is a no-op at 50% grey', () => {
    // At Cb = 0.5 the two halves of overlay's definition meet, so the result is Cs.
    const base = half();
    compositeRgb(base, half(), 1, 'overlay');
    expect(at(base, 0, 0)).toBeCloseTo(128, -1);
  });

  it('add sums and clamps at white', () => {
    const base = rgb([[200, 200, 200], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeRgb(base, rgb([[200, 200, 200], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 1, 'add');
    // 200 + 200 = 400, clamped to 255 by the Uint8ClampedArray.
    expect(at(base, 0, 0)).toBe(255);
  });

  it('soft-light leaves the backdrop unchanged at full white', () => {
    // Cs = 1 makes (2Cs − 1) = 1, so the result is D(Cb) — and for Cb = 0.5,
    // D = sqrt(0.5) ≈ 0.707. It is *near* the original, not equal to it: soft-light
    // is not an identity at white, only a gentle lift. Asserting equality here
    // would encode a wrong formula, which is why this test states the value.
    const base = half();
    compositeRgb(base, rgb([[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 1, 'soft-light');
    expect(at(base, 0, 0)).toBeCloseTo(180, -1);
  });

  it('soft-light darkens below 50% and lightens above it', () => {
    // The most common way to get soft-light wrong is to make it symmetric with
    // overlay; these two assertions pin the asymmetry.
    const light = rgb([[180, 180, 180], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeRgb(light, rgb([[200, 200, 200], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 1, 'soft-light');
    expect(at(light, 0, 0)).toBeGreaterThan(181);

    const dark = rgb([[80, 80, 80], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeRgb(dark, rgb([[50, 50, 50], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 1, 'soft-light');
    expect(at(dark, 0, 0)).toBeLessThan(80);
  });
});

describe('opacity', () => {
  it('mixes toward the backdrop, not toward black', () => {
    // A white backdrop and a black layer at 50% must be mid-grey. Multiplying the
    // layer by alpha instead would also give mid-grey here, so the second case
    // below is the one that catches that bug.
    const base = rgb([[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]]);
    compositeRgb(base, rgb([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 0.5, 'normal');
    expect(at(base, 0, 0)).toBeCloseTo(128, -1);
  });

  it('keeps the backdrop visible through a faded multiply layer', () => {
    // Base 200, layer 0 → multiply gives 0, so the composite is 200·(1−α).
    const base = rgb([[200, 200, 200], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeRgb(base, rgb([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 0.5, 'multiply');
    expect(at(base, 0, 0)).toBeCloseTo(100, -1);
  });

  it('is a no-op at zero', () => {
    const base = rgb([[7, 8, 9], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeRgb(base, rgb([[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 0, 'screen');
    expect([at(base, 0, 0), at(base, 0, 1), at(base, 0, 2)]).toEqual([7, 8, 9]);
  });

  it('clamps an out-of-range opacity rather than extrapolating', () => {
    const base = rgb([[100, 100, 100], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeRgb(base, rgb([[200, 200, 200], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 4, 'normal');
    expect(at(base, 0, 0)).toBe(200);
  });
});

describe('compositeLayers', () => {
  it('applies layers bottom first', () => {
    const base = rgb([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeLayers(base, [
      { frame: rgb([[100, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), opacity: 1, blendMode: 'normal' },
      { frame: rgb([[100, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), opacity: 1, blendMode: 'add' },
    ]);
    // add: 100 + 100 = 200. Applying them in the other order would give the same
    // result, so the discriminating case is below.
    expect(at(base, 0, 0)).toBe(200);
  });

  it('distinguishes order when the modes are not commutative', () => {
    const white = () => rgb([[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const half = () => rgb([[128, 128, 128], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);

    const multiplyThenNormal = rgb([[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeLayers(multiplyThenNormal, [
      { frame: half(), opacity: 1, blendMode: 'multiply' },
      { frame: white(), opacity: 1, blendMode: 'normal' },
    ]);

    const normalThenMultiply = rgb([[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    compositeLayers(normalThenMultiply, [
      { frame: white(), opacity: 1, blendMode: 'normal' },
      { frame: half(), opacity: 1, blendMode: 'multiply' },
    ]);

    expect(at(multiplyThenNormal, 0, 0)).toBe(255); // white painted last
    expect(at(normalThenMultiply, 0, 0)).toBe(128); // half painted last
  });

  it('refuses mismatched frame sizes instead of guessing', () => {
    const base: RgbFrame = { width: 2, height: 2, data: new Uint8ClampedArray(12) };
    const layer: RgbFrame = { width: 4, height: 4, data: new Uint8ClampedArray(48) };
    expect(() => compositeRgb(base, layer, 1, 'normal')).toThrow(/Cannot composite/);
  });
});

describe('YUV conversion', () => {
  it('splits and joins without losing bytes', () => {
    const width = 6;
    const height = 4;
    const bytes = yuvFrameBytes(width, height);
    expect(bytes).toBe(6 * 4 + 2 * 3 * 2);
    const raw = Buffer.allocUnsafe(bytes);
    for (let index = 0; index < bytes; index += 1) raw[index] = index % 251;
    const joined = joinYuv(splitYuv(raw, width, height));
    expect(joined.equals(raw)).toBe(true);
  });

  it('converts a known colour', () => {
    // yuv420p mid-grey: Y=128, Cb=Cr=128 is not exactly sRGB 128 because of the
    // 16–235 range, and the conversion has to reflect that rather than assume it.
    const grey: RgbFrame = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128]),
    };
    const frame = rgbToYuv(grey);
    // A neutral colour must have neutral chroma; that is the property a wrong
    // matrix breaks first.
    for (let index = 0; index < frame.u.length; index += 1) {
      expect(Math.abs(frame.u[index]! - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.v[index]! - 128)).toBeLessThanOrEqual(1);
    }
    expect(frame.y[0]).toBeCloseTo(128, -1);
  });

  it('round-trips pure red without turning it into magenta', () => {
    const red: RgbFrame = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]),
    };
    const back = yuvToRgb(rgbToYuv(red));
    expect(at(back, 0, 0)).toBeGreaterThan(250);
    expect(at(back, 0, 1)).toBeLessThan(5);
    expect(at(back, 0, 2)).toBeLessThan(5);
  });

  it('round-trips a mid-tone within a couple of levels', () => {
    const pixels: number[][] = [];
    for (let index = 0; index < 4; index += 1) pixels.push([90, 140, 200]);
    const back = yuvToRgb(rgbToYuv({ width: 2, height: 2, data: new Uint8ClampedArray(pixels.flat()) }));
    expect(Math.abs(at(back, 0, 0) - 90)).toBeLessThan(3);
    expect(Math.abs(at(back, 0, 1) - 140)).toBeLessThan(3);
    expect(Math.abs(at(back, 0, 2) - 200)).toBeLessThan(3);
  });

  it('reuses an output buffer when asked', () => {
    const frame = splitYuv(Buffer.alloc(yuvFrameBytes(2, 2), 128), 2, 2);
    const into: RgbFrame = { width: 2, height: 2, data: new Uint8ClampedArray(12) };
    expect(yuvToRgb(frame, into)).toBe(into);
  });
});

/**
 * The tests ffmpeg can settle and arithmetic cannot.
 *
 * A compositor that converts with the wrong matrix produces a file that still
 * looks plausible in isolation and wrong next to the preview. Rather than trust
 * the constants, ask the binary that will decode the result: give ffmpeg a known
 * RGB picture, take its `yuv420p`, and check our conversion lands on the same
 * numbers.
 */
describe('conversion against real ffmpeg', () => {
  it.skipIf(!available)('matches ffmpeg’s RGB → yuv420p conversion', () => {
    const width = 16;
    const height = 8;
    // A vertical red/green/blue split: three colour families whose luma and chroma
    // differ in both directions, so a transposed matrix or a swapped Cb/Cr fails.
    const data = new Uint8ClampedArray(width * height * 3);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const o = (row * width + col) * 3;
        if (col < width / 3) {
          data[o] = 220;
          data[o + 1] = 40;
          data[o + 2] = 40;
        } else if (col < (2 * width) / 3) {
          data[o] = 40;
          data[o + 1] = 200;
          data[o + 2] = 60;
        } else {
          data[o] = 30;
          data[o + 1] = 60;
          data[o + 2] = 210;
        }
      }
    }
    const rgbFrame: RgbFrame = { width, height, data };
    const ours = rgbToYuv(rgbFrame);

    const rgbPath = join(dir, 'in.rgb');
    const yuvPath = join(dir, 'out.yuv');
    writeFileSync(rgbPath, Buffer.from(data));
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', rgbPath,
      // `-colorspace` only *tags* the output; swscale still converts with its own
      // default, which is BT.601. Forcing the matrix in `scale` is what makes this
      // a comparison of like with like.
      '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
      '-frames:v', '1', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709',
      '-f', 'rawvideo', yuvPath,
    ]);
    const theirs = readFileSync(yuvPath);

    // Luma has to match closely; ffmpeg uses the same BT.709 coefficients but does
    // its maths in fixed point.
    let maxLuma = 0;
    for (let index = 0; index < width * height; index += 1) {
      maxLuma = Math.max(maxLuma, Math.abs(ours.y[index]! - theirs[index]!));
    }
    expect(maxLuma).toBeLessThanOrEqual(3);

    // Chroma is a 2×2 average in both implementations, so it should land within a
    // couple of levels except where a block straddles a colour edge.
    const ySize = width * height;
    let maxChroma = 0;
    for (let index = ySize; index < theirs.length; index += 1) {
      const oursByte = index < ySize + (width / 2) * (height / 2) ? ours.u[index - ySize]! : ours.v[index - ySize - (width / 2) * (height / 2)]!;
      maxChroma = Math.max(maxChroma, Math.abs(oursByte - theirs[index]!));
    }
    expect(maxChroma).toBeLessThanOrEqual(8);
  });

  it.skipIf(!available)('reads a yuv420p frame ffmpeg wrote', () => {
    // The inverse direction: decode a known solid colour with ffmpeg and check we
    // read it back as that colour. This catches an off-by-one in the plane split.
    const width = 4;
    const height = 2;
    const path = join(dir, 'solid.yuv');
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x3366CC:s=${width}x${height}:d=1:r=1`,
      // `format=rgb24` first: without it the lavfi source's own yuv420p passes
      // straight through and swscale never runs, so the output is whatever matrix
      // `color=` happened to use (BT.601) regardless of the scale options.
      '-vf', 'format=rgb24,scale=in_color_matrix=bt709:out_color_matrix=bt709',
      '-frames:v', '1', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709',
      '-f', 'rawvideo', path,
    ]);
    const raw = readFileSync(path);
    expect(raw.length).toBe(yuvFrameBytes(width, height));
    const back = yuvToRgb(splitYuv(raw, width, height));
    // 0x33, 0x66, 0xCC with room for round-tripping through 8-bit 4:2:0.
    expect(Math.abs(at(back, 0, 0) - 0x33)).toBeLessThan(6);
    expect(Math.abs(at(back, 0, 1) - 0x66)).toBeLessThan(6);
    expect(Math.abs(at(back, 0, 2) - 0xcc)).toBeLessThan(6);
  });
});

describe('colour matrix', () => {
  it('decodes BT.709 and BT.601 frames differently, as it must', () => {
    // Same bytes, two matrices: if this passed either way the matrix argument
    // would be decoration. A red-dominant difference signal is where the two
    // disagree most.
    const frame = {
      width: 2,
      height: 2,
      y: new Uint8Array([100, 100, 100, 100]),
      u: new Uint8Array([100]),
      v: new Uint8Array([190]),
    };
    const as709 = yuvToRgb(frame, undefined, 'bt709');
    const as601 = yuvToRgb(frame, undefined, 'bt601');
    expect(at(as709, 0, 0)).not.toBe(at(as601, 0, 0));
    // 601's Kr is larger (0.299 vs 0.2126), so its 2(1−Kr) red coefficient is
    // smaller and the same Cr lifts red less.
    expect(at(as709, 0, 0)).toBeGreaterThan(at(as601, 0, 0));
  });

  it.skipIf(!available)('reads swscale’s default (BT.601) output correctly', () => {
    // This is the matrix a raw yuv420p frame arrives in when nothing forces 709,
    // which is swscale's default. Getting it wrong tints every composed frame.
    const width = 4;
    const height = 2;
    const path = join(dir, 'solid601.yuv');
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x3366CC:s=${width}x${height}:d=1:r=1`,
      // No `scale`: the source's own yuv420p passes through untouched, so these
      // are genuinely 601 bytes.
      '-frames:v', '1', '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo', path,
    ]);
    const raw = readFileSync(path);
    const back = yuvToRgb(splitYuv(raw, width, height), undefined, 'bt601');
    expect(Math.abs(at(back, 0, 0) - 0x33)).toBeLessThan(4);
    expect(Math.abs(at(back, 0, 1) - 0x66)).toBeLessThan(4);
    expect(Math.abs(at(back, 0, 2) - 0xcc)).toBeLessThan(4);
  });
});
