/**
 * SPEC 12 §6.1, SPEC 10 §7.1 — the gain envelope, evaluated once for both paths.
 *
 * The spec is specific about this: the replay of a clip's volume in the *preview*
 * (Web Audio `setValueCurveAtTime`) and in the *export* (per-sample multiplication)
 * must come from **the same envelope function**. A preview that sounds right and an
 * export that clips is the failure mode this module exists to prevent, and two
 * separate implementations of "gain at time t" will always drift.
 *
 * Everything is a pure function of keyframes, fades and a clip range. Nothing here
 * touches Web Audio or PCM: the caller decides whether to schedule it as automation
 * or multiply samples by it.
 */
import type { Keyframe } from '@clipwright/project-schema';

/** Fade curve vocabulary, shared with `export-core`'s mixer (SPEC 12 §6.2). */
export type FadeCurve = 'linear' | 'equal-power' | 'exponential';

export interface EnvelopeKeyframe {
  /** Timeline time in microseconds. */
  timeUs: number;
  /** Gain in decibels. 0 dB is unity; −60 and below is silence. */
  valueDb: number;
  interpolation?: 'linear' | 'hold' | 'bezier' | 'preset';
  easing?: Keyframe['easing'];
}

export interface GainEnvelopeInput {
  /** Clip start on the timeline, in microseconds. */
  startUs: number;
  durationUs: number;
  /** Static clip gain (the "Gain" control, pre-fade). */
  gainDb?: number;
  /** Static clip volume (the "Volume" control, post-fade). */
  volumeDb?: number;
  /** Track volume, applied after the clip's own envelope. */
  trackVolumeDb?: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  fadeCurve?: FadeCurve;
  /** Volume keyframes, in timeline time. Sorted or not — this sorts a copy. */
  keyframes?: ReadonlyArray<EnvelopeKeyframe>;
  muted?: boolean;
  /** Track mute/solo state, resolved by the caller. */
  trackMuted?: boolean;
  /** Any other track is soloed and this one is not, so it is silenced. */
  silencedBySolo?: boolean;
}

export const SILENCE_DB = -60;
/** Below this, a gain is treated as silence rather than a very small number. */
const FLOOR_DB = -120;

/** dB → linear gain, with −60 dB and below clamped to exact silence. */
export function dbToGain(db: number): number {
  if (db <= SILENCE_DB) return 0;
  return 10 ** (db / 20);
}

/** Linear gain → dB, floored so `Math.log10(0)` never reaches a caller. */
export function gainToDb(gain: number): number {
  if (gain <= 0) return FLOOR_DB;
  return 20 * Math.log10(gain);
}

/**
 * A fade curve's multiplier at progress `t` (0 → 1).
 *
 * `equal-power` is the default because a linear fade *sounds* like it drops fast
 * and then hangs — the ear is logarithmic, and crossing two linear fades at −6 dB
 * dips audibly. The sine/cosine pair keeps summed power constant instead.
 */
export function fadeCurveValue(curve: FadeCurve, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (curve) {
    case 'equal-power':
      return Math.sin((x * Math.PI) / 2);
    case 'exponential':
      // Squared: a fade that starts gently and drops away at the end, which is what
      // "exponential" sounds like on a music bed.
      return x * x;
    case 'linear':
    default:
      return x;
  }
}

/**
 * Easing curves for keyframe segments.
 *
 * The same vocabulary the timeline engine exposes (`SPEC 12 §2`), implemented here
 * because the envelope has to be evaluable without loading the engine — the preview
 * worker needs it and the export runs in a separate process.
 */
export function easingValue(
  preset: NonNullable<EnvelopeKeyframe['easing']>['preset'] | undefined,
  t: number
): number {
  const x = Math.min(1, Math.max(0, t));
  switch (preset) {
    case 'easeIn':
    case 'easeInCubic':
      return x * x * x;
    case 'easeOut':
    case 'easeOutCubic':
      return 1 - (1 - x) ** 3;
    case 'easeInBack': {
      const c = 1.70158;
      return (c + 1) * x ** 3 - c * x ** 2;
    }
    case 'easeOutBack': {
      const c = 1.70158;
      return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
    }
    case 'easeOutBounce': {
      // The classic four-segment bounce; each segment is a parabola that loses
      // height, which is what makes it read as a bounce rather than a wobble.
      const n1 = 7.5625;
      const d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) {
        const y = x - 1.5 / d1;
        return n1 * y * y + 0.75;
      }
      if (x < 2.5 / d1) {
        const y = x - 2.25 / d1;
        return n1 * y * y + 0.9375;
      }
      const y = x - 2.625 / d1;
      return n1 * y * y + 0.984375;
    }
    case 'easeOutElastic': {
      if (x === 0 || x === 1) return x;
      const c4 = (2 * Math.PI) / 3;
      return 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
    }
    case 'easeInOut':
    case 'easeInOutCubic':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'linear':
    default:
      return x;
  }
}

/**
 * Value of a keyframed property at a time, in dB.
 *
 * Before the first key the first value holds, and after the last the last value
 * holds. That is deliberate: a clip whose first key is at 2 s should not be silent
 * for its first 2 s, which is what a zero-fill would give and what makes a mix seem
 * broken on the first export.
 */
export function valueAt(
  keyframes: ReadonlyArray<EnvelopeKeyframe>,
  timeUs: number
): number | null {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) return keyframes[0]!.valueDb;

  const sorted = keyframes;
  if (timeUs <= sorted[0]!.timeUs) return sorted[0]!.valueDb;
  const last = sorted[sorted.length - 1]!;
  if (timeUs >= last.timeUs) return last.valueDb;

  // Binary search for the segment containing `timeUs`. A linear scan would be fine
  // for a handful of keys and is not fine for a gain curve sampled per sample.
  let low = 0;
  let high = sorted.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (sorted[mid]!.timeUs <= timeUs) low = mid;
    else high = mid;
  }

  const from = sorted[low]!;
  const to = sorted[high]!;
  const span = to.timeUs - from.timeUs;
  if (span <= 0) return to.valueDb;

  const t = (timeUs - from.timeUs) / span;
  switch (from.interpolation ?? 'linear') {
    case 'hold':
      // Hold keeps the *from* value until the next key exactly — a step, which is
      // what a mute/unmute or a radio edit needs.
      return from.valueDb;
    case 'bezier':
      // A cubic Bézier in the time axis only; the schema's control points describe
      // the shape, and a full solve is not worth it for a gain ramp. The easing
      // preset is the fallback when no curve is stored.
      return from.valueDb + (to.valueDb - from.valueDb) * easingValue(from.easing?.preset, t);
    case 'preset':
      return from.valueDb + (to.valueDb - from.valueDb) * easingValue(from.easing?.preset, t);
    case 'linear':
    default:
      return from.valueDb + (to.valueDb - from.valueDb) * t;
  }
}

/**
 * The full gain at one instant of the timeline.
 *
 * Multiplied rather than added because gain is linear but dB is not: two +6 dB
 * stages give ×4, not +12 in the sense of "12 dB louder than the source", and the
 * distinction matters once fades are involved.
 */
export function gainAt(input: GainEnvelopeInput, timeUs: number): number {
  if (input.muted || input.trackMuted || input.silencedBySolo) return 0;
  if (timeUs < input.startUs || timeUs > input.startUs + input.durationUs) return 0;

  const keyed = input.keyframes && input.keyframes.length > 0
    ? valueAt([...input.keyframes].sort((a, b) => a.timeUs - b.timeUs), timeUs)
    : null;
  const volumeDb = keyed ?? input.volumeDb ?? 0;

  const base = dbToGain(volumeDb) * dbToGain(input.gainDb ?? 0) * dbToGain(input.trackVolumeDb ?? 0);
  if (base === 0) return 0;

  const fade = fadeAt(input, timeUs);
  return base * fade;
}

/**
 * The fade multiplier at an instant, ignoring volume.
 *
 * Fades multiply the keyframed volume rather than replacing it — the spec puts Gain
 * before fades and Volume after, and evaluating a fade on top is what makes the two
 * controls behave independently, which is the point of having both.
 *
 * When the fades overlap — a clip shorter than the two of them — the *quieter* of
 * the two wins. Returning whichever was tested first makes the result depend on the
 * order of two `if`s, so the same short clip fades differently depending on which
 * edge the code happened to check, and a clip that is all fade gets a bump in the
 * middle. Taking the minimum is the only answer that is symmetric.
 */
export function fadeAt(input: GainEnvelopeInput, timeUs: number): number {
  const curve = input.fadeCurve ?? 'equal-power';
  const offset = timeUs - input.startUs;
  const remaining = input.startUs + input.durationUs - timeUs;

  const inValue =
    input.fadeInUs && input.fadeInUs > 0 && offset < input.fadeInUs
      ? fadeCurveValue(curve, offset / input.fadeInUs)
      : 1;
  const outValue =
    input.fadeOutUs && input.fadeOutUs > 0 && remaining < input.fadeOutUs
      ? fadeCurveValue(curve, remaining / input.fadeOutUs)
      : 1;

  return Math.min(inValue, outValue);
}

/**
 * Samples the envelope into a curve, for Web Audio automation.
 *
 * `setValueCurveAtTime` takes one array for a whole duration, so the preview needs
 * a sampled curve rather than a function. Sampling the *same* `gainAt` the export
 * multiplies by is what makes them agree: there is one definition of the gain and
 * two ways of applying it.
 *
 * `setValueCurveAtTime` maps the *whole* array onto the *whole* duration: point `i`
 * lands at `duration * i / points`, not at `duration * i / (points - 1)`. Dividing
 * by `points - 1` — the obvious reading, and what a graph would want — spreads the
 * same array across one fewer interval, so every point sits a fraction of a sample
 * late and the error accumulates to a full sample by the end of the clip. The export
 * and the preview would then differ by up to one sample's worth of gain ramp, which
 * is exactly the sort of thing this module exists to rule out.
 */
export function envelopeCurve(input: GainEnvelopeInput, options: {
  durationUs: number;
  /** Points to produce. Web Audio interpolates between them linearly. */
  points: number;
}): Float32Array {
  const { durationUs, points } = options;
  const count = Math.max(2, Math.floor(points));
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const timeUs = input.startUs + (durationUs * index) / count;
    curve[index] = gainAt(input, timeUs);
  }
  return curve;
}

/**
 * Where the gain leaves unity, as time ranges.
 *
 * Used to skip work: a clip with no fades, no keys and no gain is a straight pass
 * through, and both the mixer and the preview scheduler can leave it untouched.
 * Returning an empty array is the fast path, and having one function answer the
 * question keeps the two paths from disagreeing about when it applies.
 */
export function activeRanges(input: GainEnvelopeInput): Array<{ startUs: number; endUs: number }> {
  const keyed = input.keyframes && input.keyframes.length > 0;
  const faded = (input.fadeInUs ?? 0) > 0 || (input.fadeOutUs ?? 0) > 0;
  const level = (input.gainDb ?? 0) !== 0 || (input.volumeDb ?? 0) !== 0 || (input.trackVolumeDb ?? 0) !== 0;
  if (input.muted || input.trackMuted || input.silencedBySolo) {
    return [{ startUs: input.startUs, endUs: input.startUs + input.durationUs }];
  }
  if (!keyed && !faded && !level) return [];
  return [{ startUs: input.startUs, endUs: input.startUs + input.durationUs }];
}

/**
 * Applies an envelope in place to interleaved stereo float samples.
 *
 * The export's mixer can use this instead of its own per-sample loop; it exists so
 * that "the exported file and the preview agree" can be tested by comparing this
 * output against `envelopeCurve` sampled at the same instants.
 */
export function applyGainEnvelope(
  samples: Float32Array,
  input: GainEnvelopeInput,
  sampleRate: number
): void {
  const channels = 2;
  const frames = samples.length / channels;
  for (let frame = 0; frame < frames; frame += 1) {
    const timeUs = input.startUs + (frame / sampleRate) * 1_000_000;
    const gain = gainAt(input, timeUs);
    samples[frame * channels] = samples[frame * channels]! * gain;
    samples[frame * channels + 1] = samples[frame * channels + 1]! * gain;
  }
}
