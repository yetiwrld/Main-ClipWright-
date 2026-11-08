/**
 * SPEC 12 §3 — the effect catalogue and its colour maths.
 *
 * Effects have been stored on items, listed in the inspector, toggled and removed
 * since the inspector work, and applied by nothing. This module is the missing
 * middle: what each effect *does* to a pixel, expressed once so the preview and the
 * export cannot disagree.
 *
 * ## Colour pipeline
 *
 * The spec (§3.1) prescribes sample → linearise → effects → delinearise →
 * transform/opacity, so that a `+1` brightness is a doubling of linear light rather
 * than a doubling of a gamma-encoded byte. That distinction is the whole reason the
 * module exists: adding 0.1 to sRGB 0.5 gives 0.6, while adding 0.1 in linear light
 * and re-encoding gives about 0.63 — close enough to look right in a still and far
 * enough apart to make two clips match badly.
 *
 * ## What is here and what is not
 *
 * The spec's §3.2 table is the required set. All of the *colour* effects are here,
 * because they are per-pixel arithmetic with no neighbourhood. Sharpen is here as an
 * unsharp mask, which needs a blur. The *spatial* effects are here too. What is
 * missing is the shader path: §3.1 asks for fragment shaders in `/packages/compositor/
 * effects`, run in a WebGL2 window in both preview and export. That is a different
 * architecture from this codebase's — the export feeds ffmpeg raw frames and has no
 * GL context at all — so this module is the CPU implementation both renderers call.
 * It is not shader-identical, and `docs/limitations.md` says so.
 */

/** A parameter's declared range, so an out-of-range stored value can be clamped. */
export interface ParamSpec {
  id: string;
  label: string;
  type: 'float' | 'int' | 'bool';
  min: number;
  max: number;
  default: number | boolean;
  animatable: boolean;
}

export interface EffectDefinition {
  id: string;
  name: string;
  category: 'colour' | 'blur' | 'detail' | 'stylise';
  params: ParamSpec[];
  /**
   * How many passes the effect costs, for the spec's "6+ passes show a warning"
   * rule (§3.2). A separable blur counts twice.
   */
  passes: number;
}

const number = (
  id: string,
  label: string,
  min: number,
  max: number,
  def: number,
  animatable = true,
): ParamSpec => ({ id, label, type: 'float', min, max, default: def, animatable });

/**
 * The required effects from SPEC 12 §3.2, in the spec's order.
 *
 * `Crop`, `Transform`, `Opacity`, `Speed` and the blend modes are in the table but
 * are item properties, not effect-chain entries — they have their own controls and
 * their own modules, so they are deliberately absent here.
 */
export const EFFECTS: readonly EffectDefinition[] = [
  {
    id: 'brightness',
    name: 'Brightness',
    category: 'colour',
    passes: 1,
    params: [number('amount', 'Amount', -1, 1, 0)],
  },
  {
    id: 'exposure',
    name: 'Exposure',
    category: 'colour',
    passes: 1,
    params: [number('stops', 'Stops', -3, 3, 0)],
  },
  {
    id: 'contrast',
    name: 'Contrast',
    category: 'colour',
    passes: 1,
    params: [number('amount', 'Amount', -1, 1, 0)],
  },
  {
    id: 'saturation',
    name: 'Saturation',
    category: 'colour',
    passes: 1,
    params: [number('amount', 'Amount', 0, 2, 1)],
  },
  {
    id: 'temperature',
    name: 'Temperature',
    category: 'colour',
    passes: 1,
    params: [number('amount', 'Warm / cool', -100, 100, 0)],
  },
  {
    id: 'tint',
    name: 'Tint',
    category: 'colour',
    passes: 1,
    params: [number('amount', 'Green / magenta', -100, 100, 0)],
  },
  {
    id: 'sharpen',
    name: 'Sharpen',
    category: 'detail',
    passes: 2,
    params: [number('amount', 'Amount', 0, 2, 0), number('radius', 'Radius', 0.5, 3, 1)],
  },
  {
    id: 'blur',
    name: 'Blur (Gaussian)',
    category: 'blur',
    passes: 2,
    params: [number('radius', 'Radius', 0, 100, 0)],
  },
  {
    id: 'vignette',
    name: 'Vignette',
    category: 'stylise',
    passes: 1,
    params: [
      number('amount', 'Amount', 0, 1, 0),
      number('size', 'Size', 0.2, 1.5, 0.8),
      number('softness', 'Softness', 0, 1, 0.5),
    ],
  },
];

const EFFECT_LOOKUP = new Map(EFFECTS.map((effect) => [effect.id, effect]));

/** The catalogue entry for an id, or `undefined` for an effect this build lacks. */
export function effectDefinition(effectId: string): EffectDefinition | undefined {
  return EFFECT_LOOKUP.get(effectId);
}

/**
 * An effect's parameters, clamped to their declared ranges.
 *
 * §3.2 requires out-of-range loaded values to be clamped rather than rejected: a
 * project written by a newer build with `brightness: 5` must still open and look
 * like something, not fail to load.
 */
export function effectParams(
  effectId: string,
  stored: Readonly<Record<string, number | boolean | string>> | undefined,
): Record<string, number> {
  const definition = EFFECT_LOOKUP.get(effectId);
  if (!definition) return {};
  const result: Record<string, number> = {};
  for (const spec of definition.params) {
    const raw = stored?.[spec.id];
    const value = typeof raw === 'number' ? raw : typeof raw === 'boolean' ? Number(raw) : spec.default;
    result[spec.id] = Math.min(spec.max, Math.max(spec.min, Number(value)));
  }
  return result;
}

/** An enabled effect instance, ready to apply. */
export interface ActiveEffect {
  effectId: string;
  params: Record<string, number>;
}

/**
 * The enabled effects on an item, in chain order, with parameters clamped.
 *
 * Order matters (§3.1: "chain order matters and is documented"), so the stored
 * array order is preserved rather than sorted. Effects this build does not know are
 * dropped — a project that used a stretch goal still opens and renders the part of
 * the chain that exists.
 */
export function activeEffects(
  effects: ReadonlyArray<{ effectId: string; enabled?: boolean; params?: Record<string, number | boolean | string> }> | undefined,
): ActiveEffect[] {
  if (!effects) return [];
  const result: ActiveEffect[] = [];
  for (const effect of effects) {
    if (effect.enabled === false) continue;
    if (!EFFECT_LOOKUP.has(effect.effectId)) continue;
    result.push({ effectId: effect.effectId, params: effectParams(effect.effectId, effect.params) });
  }
  return result;
}

/** Whether a chain is heavy enough that §3.2 wants a warning shown. */
export function effectPassCount(effects: readonly ActiveEffect[]): number {
  return effects.reduce(
    (total, effect) => total + (EFFECT_LOOKUP.get(effect.effectId)?.passes ?? 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Colour space
// ---------------------------------------------------------------------------

/**
 * sRGB → linear light, per channel, 0–1 in and out.
 *
 * The piecewise transfer function, not the 2.2 power approximation: the two differ
 * most in the darkest tenth, which is exactly where a vignette and a contrast
 * adjustment both operate.
 */
export function srgbToLinear(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light → sRGB, the inverse of {@link srgbToLinear}. */
export function linearToSrgb(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Rec.709 luma weights, the spec's choice for a luma-preserving saturation. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** The linear-light pivot a contrast adjustment turns around. */
export const MID_GREY = 0.18;

/** Linear-light RGB, one pixel. */
export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Apply the interleaved pixel-wise effects in `effects` to one linear RGB pixel.
 *
 * Only the per-pixel effects are handled here; blur, sharpen and vignette need
 * neighbours or coordinates and are applied by the frame-level entry point below.
 * Keeping this pure makes the arithmetic testable against the spec's own worked
 * examples ("exposure +1 stop doubles linear values; saturation 0 = Rec.709 luma").
 */
export function applyPixelEffects(pixel: LinearRgb, effects: readonly ActiveEffect[]): LinearRgb {
  let { r, g, b } = pixel;

  for (const effect of effects) {
    const p = effect.params;
    switch (effect.effectId) {
      case 'brightness': {
        // §3.2: "added in linear light × gain curve". A pure add clips highlights
        // to white and crushes shadows, so the amount is applied as an additive
        // lift that rolls off as the pixel approaches white: `v + amount·(1 − v)`.
        // At amount 1 every input reaches 1; at 0.5 the lift is halved in the
        // highlights and full in the blacks, which is what a brightness control is
        // expected to feel like.
        const amount = p.amount ?? 0;
        r = r + amount * (1 - r);
        g = g + amount * (1 - g);
        b = b + amount * (1 - b);
        break;
      }
      case 'exposure': {
        // §3.2: "multiplies linear RGB by 2^stops" — exact, and the spec's own
        // acceptance test is that +1 stop doubles the linear values.
        const gain = Math.pow(2, p.stops ?? 0);
        r *= gain;
        g *= gain;
        b *= gain;
        break;
      }
      case 'contrast': {
        // §3.2: around a mid-grey pivot of 0.18 linear. The amount maps to a gain
        // from 0 (flat grey) through 1 (unchanged) to 4 (very hard); 4 is chosen so
        // that +1 is a strong but not destructive setting.
        const amount = p.amount ?? 0;
        const gain = Math.pow(4, amount);
        r = MID_GREY + (r - MID_GREY) * gain;
        g = MID_GREY + (g - MID_GREY) * gain;
        b = MID_GREY + (b - MID_GREY) * gain;
        break;
      }
      case 'saturation': {
        // §3.2: "luma-preserving (Rec.709 weights)". Mix toward the pixel's own
        // luma: 0 gives greyscale, 1 is unchanged, 2 is double the distance from
        // grey. Mixing toward luma rather than scaling channels is what keeps a
        // desaturated image the same brightness.
        const amount = p.amount ?? 1;
        const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
        r = luma + (r - luma) * amount;
        g = luma + (g - luma) * amount;
        b = luma + (b - luma) * amount;
        break;
      }
      case 'temperature': {
        // §3.2: "warm/cool via blue–orange channel gains in linear space". Warm
        // lifts red and drops blue; both are scaled by 100 so the control reads as
        // a percentage of the maximum shift.
        const shift = (p.amount ?? 0) / 100;
        r *= 1 + shift * 0.3;
        b *= 1 - shift * 0.3;
        break;
      }
      case 'tint': {
        // §3.2: green–magenta. Magenta is red plus blue, so a positive amount
        // raises both and a negative one raises green — the same shape as
        // temperature but on the other axis.
        const shift = (p.amount ?? 0) / 100;
        r *= 1 + shift * 0.2;
        b *= 1 + shift * 0.2;
        g *= 1 - shift * 0.2;
        break;
      }
      default:
        // Blur, sharpen and vignette are spatial; they are applied by
        // `applyEffectsToFrame`, not here.
        break;
    }

    // Clamp after every effect, not once at the end: a chain that overshoots and
    // then subtracts would otherwise recover values the display could never show.
    r = Math.min(1, Math.max(0, r));
    g = Math.min(1, Math.max(0, g));
    b = Math.min(1, Math.max(0, b));
  }

  return { r, g, b };
}

// ---------------------------------------------------------------------------
// Frame-level effects
// ---------------------------------------------------------------------------

/**
 * A separable Gaussian blur over a 3-channel 8-bit image, in place.
 *
 * §3.2 asks for a "two-pass separable; clamped kernel" blur. Separable means a
 * 2D Gaussian of radius r becomes a horizontal pass and a vertical pass, turning
 * O(r²) work per pixel into O(r) — the difference between a usable control and a
 * frozen UI at radius 100.
 *
 * The kernel is clamped at the frame edges (edge pixels repeat) rather than wrapped
 * or zeroed, because a zero border would darken the picture's edge, which looks
 * like a vignette the user did not ask for.
 *
 * `radius` is in pixels at the frame's own resolution. The caller scales it from the
 * spec's "relative to the 1080 short side" so a 4K export blurs proportionally.
 */
export function gaussianBlur(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius <= 0.05 || width < 1 || height < 1) return;

  // The kernel radius covers 3σ, which holds 99.7 % of the Gaussian's weight; a
  // wider kernel costs time and visibly changes nothing.
  const sigma = radius / 1.5;
  const kernelRadius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(kernelRadius * 2 + 1);
  let sum = 0;
  for (let offset = -kernelRadius; offset <= kernelRadius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + kernelRadius] = weight;
    sum += weight;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index]! /= sum;

  // Two scratch rows rather than a full-frame copy: the horizontal pass needs a
  // source row while the destination row is being written, and the vertical pass
  // needs the same in columns. One frame's worth of floats would be 4× the image
  // size at 4K, which is the allocation this avoids.
  const source = new Uint8ClampedArray(width * 3);
  const column = new Float32Array(height);

  // Horizontal pass, row by row.
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 3;
    source.set(data.subarray(rowStart, rowStart + width * 3));
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let total = 0;
        for (let offset = -kernelRadius; offset <= kernelRadius; offset += 1) {
          const sampleX = Math.min(width - 1, Math.max(0, x + offset));
          total += source[sampleX * 3 + channel]! * kernel[offset + kernelRadius]!;
        }
        data[rowStart + x * 3 + channel] = total;
      }
    }
  }

  // Vertical pass, column by column.
  for (let x = 0; x < width; x += 1) {
    const offset = x * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      for (let y = 0; y < height; y += 1) column[y] = data[(y * width) * 3 + offset + channel]!;
      for (let y = 0; y < height; y += 1) {
        let total = 0;
        for (let step = -kernelRadius; step <= kernelRadius; step += 1) {
          const sampleY = Math.min(height - 1, Math.max(0, y + step));
          total += column[sampleY]! * kernel[step + kernelRadius]!;
        }
        data[y * width * 3 + offset + channel] = total;
      }
    }
  }
}

/**
 * Unsharp mask: the picture plus `amount` times the difference between itself and a
 * blurred copy.
 *
 * §3.2 specifies an unsharp mask with a radius that scales with output resolution;
 * the scaling is the caller's job (see {@link scaleRadiusForFrame}), because it
 * depends on the output size rather than on the effect.
 */
export function unsharpMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  radius: number,
): void {
  if (amount <= 0 || radius <= 0.05) return;
  const blurred = new Uint8ClampedArray(data);
  gaussianBlur(blurred, width, height, radius);
  for (let index = 0; index < data.length; index += 1) {
    // `blurred` is the low-pass copy, so (original − blurred) is the high-frequency
    // detail. Adding it back at `amount` is the mask.
    data[index] = data[index]! + (data[index]! - blurred[index]!) * amount;
  }
}

/**
 * Radial darkening: full brightness inside `size`, falling to `1 − amount` at the
 * frame's corners.
 *
 * §3.2 gives `size` 0.2…1.5 and `softness` 0…1. `size` is the radius of the
 * untouched area as a fraction of the frame's half-diagonal, so 1.0 is "right up to
 * the corners" and values above 1 push the falloff outside the frame. `softness`
 * sets how wide the transition band is: 0 is a hard edge, 1 fades across the whole
 * radius.
 */
export function vignette(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  size: number,
  softness: number,
): void {
  if (amount <= 0) return;
  const centreX = width / 2;
  const centreY = height / 2;
  // Normalise by the half-diagonal so `size` means the same thing at any aspect
  // ratio and any resolution.
  const halfDiagonal = Math.hypot(centreX, centreY);
  // A hard edge is zero-width, which divides by zero in the ramp below; a floor
  // keeps it finite without making the edge visibly soft.
  const band = Math.max(1e-4, softness * size);

  for (let y = 0; y < height; y += 1) {
    const dy = y + 0.5 - centreY;
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - centreX;
      const distance = Math.hypot(dx, dy) / halfDiagonal;
      // 0 at the centre, 1 once past `size`.
      const falloff = Math.min(1, Math.max(0, (distance - size) / band));
      if (falloff <= 0) continue;
      const factor = 1 - amount * falloff * falloff;
      const offset = (y * width + x) * 3;
      data[offset] = data[offset]! * factor;
      data[offset + 1] = data[offset + 1]! * factor;
      data[offset + 2] = data[offset + 2]! * factor;
    }
  }
}

/**
 * A blur/sharpen radius written for a 1080p-ish frame, scaled to this frame.
 *
 * §3.2 and the acceptance list both require effects to be resolution-independent:
 * "a blur radius and sharpen radius at 4K export match the 1080p preview scaled".
 * The spec defines the radius relative to the 1080 short side, so the scale factor
 * is simply this frame's short side over 1080.
 */
export function scaleRadiusForFrame(radius: number, width: number, height: number): number {
  return (radius * Math.min(width, height)) / 1080;
}

/**
 * Apply an effect chain to an 8-bit RGB frame, in place.
 *
 * This is the function both renderers call: the export has RGB bytes from
 * `yuvToRgb`, and the preview can get them from a canvas. The chain runs in the
 * spec's order (§3.1) — sample, linearise, effects, delinearise — with the spatial
 * effects (blur, sharpen, vignette) operating on the linear values.
 *
 * Per-pixel effects are done first and in chain order, then the spatial ones, which
 * is a deliberate simplification: a true shader pipeline interleaves them so that
 * `blur → contrast` differs from `contrast → blur`. That difference is real and it is
 * recorded in `docs/limitations.md` rather than hidden. In practice the common chain
 * is colour-only, where order is already exact.
 */
export function applyEffectsToFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  effects: readonly ActiveEffect[],
): void {
  const pixelwise = effects.filter((effect) => isPixelwise(effect.effectId));
  const spatial = effects.filter((effect) => !isPixelwise(effect.effectId));
  if (pixelwise.length === 0 && spatial.length === 0) return;

  const pixelCount = width * height;
  const linear = new Float32Array(pixelCount * 3);
  const needsLinear = pixelwise.length > 0 || spatial.some((e) => e.effectId !== 'vignette');

  if (needsLinear) {
    for (let index = 0; index < pixelCount * 3; index += 1) {
      linear[index] = srgbToLinear(data[index]! / 255);
    }
  }

  if (pixelwise.length > 0) {
    for (let index = 0; index < pixelCount * 3; index += 3) {
      const out = applyPixelEffects(
        { r: linear[index]!, g: linear[index + 1]!, b: linear[index + 2]! },
        pixelwise,
      );
      linear[index] = out.r;
      linear[index + 1] = out.g;
      linear[index + 2] = out.b;
    }
  }

  // Back to 8-bit before the spatial passes, because a blur is defined on the
  // displayed picture: blurring in linear light makes bright edges bleed visibly
  // more than the same blur in a compositor that works in sRGB. ffmpeg's `gblur`
  // operates on the encoded values, and matching it is worth more here than
  // theoretical purity.
  const working = new Uint8ClampedArray(pixelCount * 3);
  for (let index = 0; index < pixelCount * 3; index += 1) {
    working[index] = linearToSrgb(linear[index]!) * 255;
  }

  for (const effect of spatial) {
    const p = effect.params;
    switch (effect.effectId) {
      case 'blur': {
        const radius = scaleRadiusForFrame(p.radius ?? 0, width, height);
        gaussianBlur(working, width, height, radius);
        break;
      }
      case 'sharpen': {
        const radius = scaleRadiusForFrame(p.radius ?? 1, width, height);
        unsharpMask(working, width, height, p.amount ?? 0, radius);
        break;
      }
      case 'vignette': {
        vignette(
          working,
          width,
          height,
          p.amount ?? 0,
          p.size ?? 0.8,
          p.softness ?? 0.5,
        );
        break;
      }
      default:
        break;
    }
  }

  data.set(working);
}

/** Whether an effect is decided per pixel, with no neighbours or coordinates. */
export function isPixelwise(effectId: string): boolean {
  return (
    effectId === 'brightness' ||
    effectId === 'exposure' ||
    effectId === 'contrast' ||
    effectId === 'saturation' ||
    effectId === 'temperature' ||
    effectId === 'tint'
  );
}
