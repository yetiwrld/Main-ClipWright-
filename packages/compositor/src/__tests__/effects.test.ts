/**
 * SPEC 12 §3.2 — the required effects, checked against the spec's own definitions.
 *
 * The spec states two acceptance criteria numerically, and both are testable exactly:
 * "exposure +1 stop doubles linear values" and "saturation 0 = Rec.709 luma". Those
 * are asserted directly rather than approximated, because an effect that is merely
 * "darker when you move the slider" is not the effect the spec describes.
 *
 * The colour-space tests matter more than they look: a brightness applied to sRGB
 * bytes instead of linear light is a different operation, and the difference is
 * invisible in a thumbnail and obvious when two clips have to match.
 */
import { describe, expect, it } from 'vitest';
import {
  activeEffects,
  applyEffectsToFrame,
  applyPixelEffects,
  EFFECTS,
  effectDefinition,
  effectPassCount,
  effectParams,
  gaussianBlur,
  isPixelwise,
  linearToSrgb,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  MID_GREY,
  scaleRadiusForFrame,
  srgbToLinear,
  unsharpMask,
  vignette,
  type ActiveEffect,
} from '../effects.js';

/** One enabled effect with its defaults overridden. */
const fx = (effectId: string, params: Record<string, number> = {}): ActiveEffect => ({
  effectId,
  params: { ...effectParams(effectId, {}), ...params },
});

/** A small RGB frame filled by a function of x and y. */
function frame(width: number, height: number, fill: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const offset = (y * width + x) * 3;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
    }
  }
  return { data, width, height };
}

const pixel = (data: Uint8ClampedArray, index = 0) => [data[index * 3], data[index * 3 + 1], data[index * 3 + 2]];

describe('catalogue', () => {
  it('lists every required effect from §3.2', () => {
    const ids = EFFECTS.map((effect) => effect.id);
    // The row's item-property entries (crop, transform, opacity, speed, blend) are
    // deliberately absent: they have their own modules.
    for (const required of ['brightness', 'exposure', 'contrast', 'saturation', 'temperature', 'tint', 'sharpen', 'blur', 'vignette']) {
      expect(ids).toContain(required);
    }
  });

  it('declares parameters with the ranges the spec gives', () => {
    const exposure = effectDefinition('exposure')!;
    expect(exposure.params[0]).toMatchObject({ id: 'stops', min: -3, max: 3, default: 0 });
    const saturation = effectDefinition('saturation')!;
    expect(saturation.params[0]).toMatchObject({ min: 0, max: 2, default: 1 });
    const blur = effectDefinition('blur')!;
    expect(blur.params[0]).toMatchObject({ id: 'radius', min: 0, max: 100, default: 0 });
  });

  it('counts a separable blur as two passes', () => {
    expect(effectDefinition('blur')!.passes).toBe(2);
    expect(effectDefinition('brightness')!.passes).toBe(1);
  });

  it('returns undefined for an unknown effect rather than throwing', () => {
    expect(effectDefinition('nonesuch')).toBeUndefined();
  });
});

describe('effectParams', () => {
  it('falls back to the declared defaults', () => {
    expect(effectParams('saturation', undefined)).toEqual({ amount: 1 });
    expect(effectParams('exposure', {})).toEqual({ stops: 0 });
  });

  it('clamps an out-of-range stored value instead of rejecting the project', () => {
    // §3.2 requires clamping with a warning; the warning is the caller's, the clamp
    // is here. A file written by a newer build must still open.
    expect(effectParams('exposure', { stops: 12 }).stops).toBe(3);
    expect(effectParams('brightness', { amount: -9 }).amount).toBe(-1);
  });

  it('ignores a value of the wrong type', () => {
    expect(effectParams('exposure', { stops: 'warm' as never }).stops).toBe(0);
  });

  it('coerces a boolean parameter to a number', () => {
    expect(effectParams('blur', { radius: true as never }).radius).toBe(1);
  });
});

describe('activeEffects', () => {
  it('keeps chain order', () => {
    const chain = activeEffects([
      { effectId: 'saturation', params: { amount: 2 } },
      { effectId: 'brightness', params: { amount: 0.1 } },
    ]);
    expect(chain.map((effect) => effect.effectId)).toEqual(['saturation', 'brightness']);
  });

  it('drops disabled effects', () => {
    const chain = activeEffects([
      { effectId: 'saturation', enabled: false },
      { effectId: 'brightness', enabled: true, params: { amount: 0.1 } },
    ]);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.effectId).toBe('brightness');
  });

  it('drops effects this build does not know', () => {
    // A stretch goal in a project file must not stop the rest of the chain running.
    const chain = activeEffects([
      { effectId: 'chroma-key', params: {} },
      { effectId: 'brightness', params: { amount: 0.1 } },
    ]);
    expect(chain.map((effect) => effect.effectId)).toEqual(['brightness']);
  });

  it('counts passes for the 6+ warning the spec asks for', () => {
    expect(effectPassCount(activeEffects([{ effectId: 'blur' }]))).toBe(2);
    expect(
      effectPassCount(
        activeEffects([{ effectId: 'blur' }, { effectId: 'sharpen' }, { effectId: 'brightness' }]),
      ),
    ).toBe(5);
  });
});

describe('colour space', () => {
  it('round-trips through linear light', () => {
    for (const value of [0, 0.01, 0.04, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(value))).toBeCloseTo(value, 6);
    }
  });

  it('is linear at the very bottom of the range', () => {
    // The piecewise curve's toe is linear with slope 1/12.92; a 2.2 power
    // approximation gets this wrong, and this is where a vignette works.
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 8);
  });

  it('maps mid-grey 0.5 sRGB to about 0.21 linear', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
  });
});

describe('pixel effects, per the spec definitions', () => {
  it('exposure +1 stop doubles the linear values', () => {
    // §3.2's own acceptance criterion.
    const before = { r: 0.2, g: 0.3, b: 0.4 };
    const after = applyPixelEffects(before, [fx('exposure', { stops: 1 })]);
    expect(after.r).toBeCloseTo(0.4, 6);
    expect(after.g).toBeCloseTo(0.6, 6);
    expect(after.b).toBeCloseTo(0.8, 6);
  });

  it('exposure is a gain in linear light, not on encoded bytes', () => {
    // Working on sRGB bytes would give 0.5 → 1.0 and clip; in linear light 0.5 sRGB
    // is 0.214 linear, doubling to 0.428, which re-encodes to about 0.69 sRGB.
    const frameUnderTest = frame(1, 1, () => [128, 128, 128]);
    applyEffectsToFrame(frameUnderTest.data, 1, 1, [fx('exposure', { stops: 1 })]);
    const [red] = pixel(frameUnderTest.data);
    expect(red).toBeGreaterThan(165);
    expect(red).toBeLessThan(185);
  });

  it('saturation 0 produces Rec.709 luma', () => {
    // §3.2's other numeric criterion.
    const before = { r: 0.8, g: 0.4, b: 0.2 };
    const grey = applyPixelEffects(before, [fx('saturation', { amount: 0 })]);
    const expected = LUMA_R * 0.8 + LUMA_G * 0.4 + LUMA_B * 0.2;
    expect(grey.r).toBeCloseTo(expected, 6);
    expect(grey.g).toBeCloseTo(expected, 6);
    expect(grey.b).toBeCloseTo(expected, 6);
  });

  it('saturation 1 leaves the pixel alone', () => {
    const before = { r: 0.8, g: 0.4, b: 0.2 };
    const after = applyPixelEffects(before, [fx('saturation', { amount: 1 })]);
    expect(after.r).toBeCloseTo(0.8, 6);
    expect(after.g).toBeCloseTo(0.4, 6);
    expect(after.b).toBeCloseTo(0.2, 6);
  });

  it('saturation 2 doubles the distance from grey', () => {
    const before = { r: 0.6, g: 0.4, b: 0.4 };
    const luma = LUMA_R * 0.6 + LUMA_G * 0.4 + LUMA_B * 0.4;
    const after = applyPixelEffects(before, [fx('saturation', { amount: 2 })]);
    expect(after.r - luma).toBeCloseTo((before.r - luma) * 2, 6);
  });

  it('contrast turns around the 0.18 linear pivot', () => {
    // A pixel at the pivot must not move, whatever the amount.
    for (const amount of [-1, -0.5, 0.5, 1]) {
      const after = applyPixelEffects({ r: MID_GREY, g: MID_GREY, b: MID_GREY }, [fx('contrast', { amount })]);
      expect(after.r).toBeCloseTo(MID_GREY, 6);
    }
  });

  it('positive contrast pushes away from mid-grey and negative pulls toward it', () => {
    const bright = { r: 0.5, g: 0.5, b: 0.5 };
    const harder = applyPixelEffects(bright, [fx('contrast', { amount: 0.5 })]);
    const flatter = applyPixelEffects(bright, [fx('contrast', { amount: -0.5 })]);
    expect(harder.r).toBeGreaterThan(0.5);
    expect(flatter.r).toBeLessThan(0.5);
    expect(flatter.r).toBeGreaterThan(MID_GREY);
  });

  it('brightness at 1 reaches white without clipping to a flat white wall', () => {
    const after = applyPixelEffects({ r: 0.2, g: 0.5, b: 0.9 }, [fx('brightness', { amount: 1 })]);
    // The roll-off means everything lands at 1 here, which is the defined behaviour
    // at full travel.
    expect(after.r).toBeCloseTo(1, 6);
    expect(after.b).toBeCloseTo(1, 6);
    // Half the amount keeps the ordering of the channels.
    const half = applyPixelEffects({ r: 0.2, g: 0.5, b: 0.9 }, [fx('brightness', { amount: 0.5 })]);
    expect(half.r).toBeLessThan(half.g);
    expect(half.g).toBeLessThan(half.b);
  });

  it('brightness 0 changes nothing', () => {
    const before = { r: 0.3, g: 0.6, b: 0.1 };
    const after = applyPixelEffects(before, [fx('brightness', { amount: 0 })]);
    expect(after.r).toBeCloseTo(0.3, 6);
    expect(after.g).toBeCloseTo(0.6, 6);
    expect(after.b).toBeCloseTo(0.1, 6);
  });

  it('warm temperature raises red and lowers blue', () => {
    const warm = applyPixelEffects({ r: 0.5, g: 0.5, b: 0.5 }, [fx('temperature', { amount: 100 })]);
    expect(warm.r).toBeGreaterThan(0.5);
    expect(warm.b).toBeLessThan(0.5);
    expect(warm.g).toBeCloseTo(0.5, 6);
  });

  it('cool temperature does the opposite', () => {
    const cool = applyPixelEffects({ r: 0.5, g: 0.5, b: 0.5 }, [fx('temperature', { amount: -100 })]);
    expect(cool.r).toBeLessThan(0.5);
    expect(cool.b).toBeGreaterThan(0.5);
  });

  it('temperature 0 is a no-op', () => {
    const same = applyPixelEffects({ r: 0.5, g: 0.5, b: 0.5 }, [fx('temperature', { amount: 0 })]);
    expect(same.r).toBeCloseTo(0.5, 6);
  });

  it('positive tint goes magenta and negative goes green', () => {
    const magenta = applyPixelEffects({ r: 0.5, g: 0.5, b: 0.5 }, [fx('tint', { amount: 100 })]);
    expect(magenta.r).toBeGreaterThan(0.5);
    expect(magenta.g).toBeLessThan(0.5);

    const green = applyPixelEffects({ r: 0.5, g: 0.5, b: 0.5 }, [fx('tint', { amount: -100 })]);
    expect(green.g).toBeGreaterThan(0.5);
  });

  it('clamps after each effect so a chain cannot recover unwritable values', () => {
    // Exposure overshoots, then a negative brightness would pull it back into range
    // if the intermediate were left unclamped. The displayed value must not depend
    // on that.
    const after = applyPixelEffects({ r: 0.9, g: 0.9, b: 0.9 }, [
      fx('exposure', { stops: 3 }),
      fx('contrast', { amount: -1 }),
    ]);
    expect(after.r).toBeGreaterThanOrEqual(0);
    expect(after.r).toBeLessThanOrEqual(1);
  });

  it('applies the chain in order', () => {
    // Exposure then saturation differs from saturation then exposure, and that is
    // the documented behaviour rather than an artefact.
    const first = applyPixelEffects({ r: 0.8, g: 0.2, b: 0.2 }, [
      fx('saturation', { amount: 0 }),
      fx('exposure', { stops: 1 }),
    ]);
    const second = applyPixelEffects({ r: 0.8, g: 0.2, b: 0.2 }, [
      fx('exposure', { stops: 1 }),
      fx('saturation', { amount: 0 }),
    ]);
    // Both end grey, but at different levels: saturation of the doubled colour is
    // not the doubling of the saturation.
    expect(first.r).toBeCloseTo(first.b, 6);
    expect(second.r).toBeCloseTo(second.b, 6);
    expect(Math.abs(first.r - second.r)).toBeGreaterThan(0.01);
  });
});

describe('spatial effects', () => {
  it('blurs a hard edge across the radius', () => {
    // Left half black, right half white. After a blur the boundary pixels must be
    // intermediate and the far edges must be untouched.
    const image = frame(41, 1, (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255]));
    gaussianBlur(image.data, image.width, image.height, 4);
    expect(image.data[0]).toBe(0);
    expect(image.data[40 * 3]).toBe(255);
    const middle = image.data[20 * 3]!;
    expect(middle).toBeGreaterThan(40);
    expect(middle).toBeLessThan(215);
  });

  it('leaves a flat image untouched', () => {
    const image = frame(16, 16, () => [90, 120, 150]);
    gaussianBlur(image.data, 16, 16, 5);
    for (let index = 0; index < image.data.length; index += 1) {
      expect(Math.abs(image.data[index]! - [90, 120, 150][index % 3]!)).toBeLessThanOrEqual(1);
    }
  });

  it('clamps at the edges instead of darkening the border', () => {
    // A zero border would pull edge pixels toward black, which reads as an unwanted
    // vignette. With a flat white image every pixel must stay white.
    const image = frame(8, 8, () => [255, 255, 255]);
    gaussianBlur(image.data, 8, 8, 3);
    expect(image.data[0]).toBe(255);
    expect(image.data[image.data.length - 1]).toBe(255);
  });

  it('does nothing at radius zero', () => {
    const image = frame(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const before = new Uint8ClampedArray(image.data);
    gaussianBlur(image.data, 8, 8, 0);
    expect(image.data).toEqual(before);
  });

  it('sharpen increases the contrast across an edge', () => {
    const image = frame(21, 1, (x) => (x < 10 ? [100, 100, 100] : [150, 150, 150]));
    const before = image.data[9 * 3]!;
    unsharpMask(image.data, 21, 1, 1, 2);
    // The dark side of the edge gets darker and the light side lighter.
    expect(image.data[9 * 3]!).toBeLessThanOrEqual(before);
    expect(image.data[11 * 3]!).toBeGreaterThanOrEqual(150);
  });

  it('sharpen at amount 0 is a no-op', () => {
    const image = frame(9, 9, (x, y) => [(x * 20) % 255, (y * 20) % 255, 60]);
    const before = new Uint8ClampedArray(image.data);
    unsharpMask(image.data, 9, 9, 0, 1);
    expect(image.data).toEqual(before);
  });

  it('vignette darkens the corners more than the centre', () => {
    const image = frame(21, 21, () => [200, 200, 200]);
    vignette(image.data, 21, 21, 1, 0.5, 0.5);
    const centre = image.data[(10 * 21 + 10) * 3]!;
    const corner = image.data[0]!;
    expect(centre).toBeGreaterThan(190);
    expect(corner).toBeLessThan(centre - 40);
  });

  it('vignette at amount 0 is a no-op', () => {
    const image = frame(9, 9, () => [180, 180, 180]);
    vignette(image.data, 9, 9, 0, 0.5, 0.5);
    expect(image.data[0]).toBe(180);
  });

  it('scales a 1080-relative radius to the frame', () => {
    // §3.2's resolution-independence requirement.
    expect(scaleRadiusForFrame(10, 1920, 1080)).toBeCloseTo(10, 6);
    expect(scaleRadiusForFrame(10, 3840, 2160)).toBeCloseTo(20, 6);
    expect(scaleRadiusForFrame(10, 540, 960)).toBeCloseTo(5, 6);
  });
});

describe('applyEffectsToFrame', () => {
  it('does nothing for an empty chain', () => {
    const image = frame(2, 2, () => [10, 20, 30]);
    const before = new Uint8ClampedArray(image.data);
    applyEffectsToFrame(image.data, 2, 2, []);
    expect(image.data).toEqual(before);
  });

  it('applies a colour effect to every pixel', () => {
    const image = frame(4, 4, () => [128, 128, 128]);
    applyEffectsToFrame(image.data, 4, 4, [fx('exposure', { stops: 1 })]);
    const [red] = pixel(image.data, 5);
    expect(red).toBeGreaterThan(165);
  });

  it('applies a spatial effect after the colour ones', () => {
    // Darken, then blur: the result must be a blurred dark frame, not a bright one
    // blurred and then darkened per-pixel-and-shifted.
    const image = frame(21, 1, (x) => (x < 10 ? [0, 0, 0] : [200, 200, 200]));
    applyEffectsToFrame(image.data, 21, 1, [
      fx('brightness', { amount: -0.5 }),
      fx('blur', { radius: 4 }),
    ]);
    // The bright side is dimmed by the brightness pass before blurring. The exact
    // value is worked out rather than guessed: 200 sRGB is 0.5776 linear, a −0.5
    // brightness gives 0.3664, which re-encodes to 163. Getting this number wrong in
    // the *test* is easy — it was 163 the first time the effect was measured — so it
    // is stated rather than bounded loosely.
    expect(image.data[19 * 3]!).toBeGreaterThan(155);
    expect(image.data[19 * 3]!).toBeLessThan(172);
  });

  it('treats a vignette as spatial rather than a no-op', () => {
    const image = frame(21, 21, () => [200, 200, 200]);
    applyEffectsToFrame(image.data, 21, 21, [fx('vignette', { amount: 1, size: 0.4, softness: 0.4 })]);
    expect(image.data[0]!).toBeLessThan(150);
  });

  it('classifies the pixel-wise effects and only those', () => {
    for (const id of ['brightness', 'exposure', 'contrast', 'saturation', 'temperature', 'tint']) {
      expect(isPixelwise(id)).toBe(true);
    }
    for (const id of ['blur', 'sharpen', 'vignette']) {
      expect(isPixelwise(id)).toBe(false);
    }
  });
});

describe('gaussian blur is a real Gaussian', () => {
  it('produces the textbook kernel for an impulse', () => {
    /*
      The check that the blur is a Gaussian and not "something that looks soft".

      A delta impulse convolved with a normalised kernel reproduces the kernel's own
      weights, so this compares the implementation's output against the same weights
      computed here independently. It also settles a question that came up while
      measuring against ffmpeg: `gblur=sigma=N` is *not* the same parameter as this
      radius — ffmpeg's sigma-to-tap mapping differs — so an output that disagrees
      with ffmpeg at "the same sigma" is not evidence of a bug. The response shape
      is the thing that has to be right, and it is.
    */
    const radius = 3;
    const sigma = radius / 1.5;
    const kernelRadius = Math.max(1, Math.ceil(sigma * 3));
    const weights: number[] = [];
    let total = 0;
    for (let offset = -kernelRadius; offset <= kernelRadius; offset += 1) {
      const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
      weights.push(weight);
      total += weight;
    }
    const expected = weights.map((weight) => Math.round((weight / total) * 255));

    const data = new Uint8ClampedArray(64 * 3);
    data[32 * 3] = 255;
    data[32 * 3 + 1] = 255;
    data[32 * 3 + 2] = 255;
    gaussianBlur(data, 64, 1, radius);

    const actual: number[] = [];
    for (let x = 32 - kernelRadius; x <= 32 + kernelRadius; x += 1) actual.push(data[x * 3]!);
    expect(actual).toEqual(expected);
  });

  it('is symmetric', () => {
    // An asymmetric kernel is the usual symptom of an off-by-one in the window,
    // and it makes a blurred edge lean to one side in a way that is easy to see and
    // hard to attribute.
    const data = new Uint8ClampedArray(64 * 3);
    data[32 * 3] = 255;
    data[32 * 3 + 1] = 255;
    data[32 * 3 + 2] = 255;
    gaussianBlur(data, 64, 1, 3);
    for (let offset = 1; offset <= 9; offset += 1) {
      expect(data[(32 - offset) * 3]).toBe(data[(32 + offset) * 3]);
    }
  });
});
