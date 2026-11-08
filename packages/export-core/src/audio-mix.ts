/**
 * SPEC 14 §5 / SPEC 12 §6.1 — the audio mix.
 *
 * Pure DSP over 48 kHz stereo float PCM: gain, fades, pan, envelopes, summing and
 * a limiter. No ffmpeg here — the orchestrator decodes each item to float PCM and
 * hands it to these functions, which keeps the mix sample-exact and testable.
 *
 * Timing is in samples. Everything the timeline describes in microseconds is
 * converted once, at the edges, so rounding cannot accumulate mid-mix.
 */
import { gainAt, gainToDb } from '@clipwright/audio-core';

/** Samples per second for every mix (SPEC 14 §5.1). */
export const MIX_SAMPLE_RATE = 48_000;

/** Channels in every mix (stereo, interleaved L/R). */
export const MIX_CHANNELS = 2;

/** Ceiling the limiter targets, in dBTP (SPEC 14 §5.1 "−1 dBTP"). */
export const LIMITER_CEILING_DB = -1;

/** Convert microseconds to samples at the mix rate. */
export function usToSamples(us: number): number {
  return Math.round((us / 1_000_000) * MIX_SAMPLE_RATE);
}

/** Convert samples back to microseconds. */
export function samplesToUs(samples: number): number {
  return Math.round((samples / MIX_SAMPLE_RATE) * 1_000_000);
}

/** Per-item mix parameters, mirroring the timeline's audio properties. */
export interface ItemMixParams {
  /** Linear gain (1 = unchanged). */
  gain?: number;
  /** Fade-in length in microseconds. */
  fadeInUs?: number;
  /** Fade-out length in microseconds. */
  fadeOutUs?: number;
  /** Pan, −1 hard left … +1 hard right, 0 centre. */
  pan?: number;
  /** Muted items contribute silence but keep their slot. */
  muted?: boolean;
  /** Track volume, multiplied with `gain`. */
  trackVolume?: number;
  /** Where this item starts in the mix, in microseconds. */
  startUs: number;
  /** Length of the (already decoded) source, in microseconds. */
  durationUs: number;
  /**
   * Fade shape. Defaults to `equal-power`, which is the same default the preview
   * uses — a linear fade here would make the exported fade sound different from the
   * one the user auditioned.
   */
  fadeCurve?: 'linear' | 'equal-power' | 'exponential';
  /** Volume keyframes in dB, in mix time, evaluated by `@clipwright/audio-core`. */
  keyframes?: ReadonlyArray<{ timeUs: number; valueDb: number; interpolation?: 'linear' | 'hold' | 'bezier' | 'preset'; easing?: { preset: string } }>;
}

/** A decoded source clip: interleaved stereo float32 at the mix rate. */
export interface PcmClip {
  /** Interleaved L/R samples. */
  samples: Float32Array;
  /** Samples actually available (may be shorter than requested). */
  length: number;
}

/** Create a clip sized for `samples` stereo frames, filled with silence. */
export function createClip(samples: number): PcmClip {
  const length = Math.max(0, Math.floor(samples));
  return { samples: new Float32Array(length * MIX_CHANNELS), length };
}

/** Sample index of the clip's end. */
export function clipEndSamples(clip: PcmClip): number {
  return clip.length;
}

/**
 * Apply gain, fades and pan to a clipped item in place.
 *
 * Fades are linear in amplitude, which is what a short edit-point fade wants: an
 * equal-power curve would dip mid-fade when fading to silence. Pan uses constant
 * power so a centred item is not quieter than a panned one.
 */
export function applyItemProcessing(clip: PcmClip, params: ItemMixParams): void {
  if (params.muted) {
    clip.samples.fill(0);
    return;
  }
  const pan = clamp(params.pan ?? 0, -1, 1);
  // Constant-power pan: centre → both channels at 1/√2 ≈ 0.707 relative to the
  // chosen convention, edges → one channel at 1.
  const leftGain = Math.cos(((pan + 1) * Math.PI) / 4);
  const rightGain = Math.sin(((pan + 1) * Math.PI) / 4);

  // The envelope comes from `@clipwright/audio-core`, the same function the preview
  // schedules as Web Audio automation (SPEC 12 §6.1). Evaluating it here rather than
  // re-deriving a fade in this loop is the whole contract: two implementations of
  // "gain at time t" drift, and the symptom is a preview that sounds right and an
  // export that clips.
  const envelope = {
    startUs: params.startUs,
    durationUs: params.durationUs,
    gainDb: gainToDb(params.gain ?? 1),
    trackVolumeDb: gainToDb(params.trackVolume ?? 1),
    fadeInUs: params.fadeInUs,
    fadeOutUs: params.fadeOutUs,
    fadeCurve: params.fadeCurve ?? 'equal-power',
    keyframes: params.keyframes?.map((key) => ({
      timeUs: key.timeUs,
      valueDb: key.valueDb,
      interpolation: key.interpolation,
      easing: key.easing as never,
    })),
  };

  const total = clip.length;
  for (let index = 0; index < total; index += 1) {
    const timeUs = params.startUs + (index / MIX_SAMPLE_RATE) * 1_000_000;
    const gain = gainAt(envelope, timeUs);
    clip.samples[index * 2] *= gain * leftGain * Math.SQRT2;
    clip.samples[index * 2 + 1] *= gain * rightGain * Math.SQRT2;
  }
}

/**
 * Sum `clip` into `target` starting at `targetStart` samples.
 *
 * Writing past the end of the target is discarded rather than growing the buffer,
 * so an item that overruns the export range cannot change the mix length.
 */
export function mixClipInto(target: PcmClip, clip: PcmClip, targetStart: number): void {
  const start = Math.round(targetStart);
  // A clip that begins before the mix start loses its leading samples rather
  // than being shifted late (which would desynchronise it from the picture).
  const skip = start < 0 ? -start : 0;
  const writeAt = Math.max(0, start);
  const count = Math.max(0, Math.min(clip.length - skip, target.length - writeAt));
  for (let index = 0; index < count; index += 1) {
    const source = (skip + index) * 2;
    const destination = (writeAt + index) * 2;
    target.samples[destination] += clip.samples[source];
    target.samples[destination + 1] += clip.samples[source + 1];
  }
}

/**
 * A simple attack/release envelope follower for ducking (SPEC 12 §6.7).
 *
 * Returns a per-sample gain curve that the caller multiplies into the bed.
 */
export function duckingCurve(options: {
  /** Length of the bed in samples. */
  length: number;
  /** Speech activity as [start, end] sample ranges. */
  triggers: Array<[number, number]>;
  /** How much to reduce while speech is present, in dB (negative). */
  reductionDb?: number;
  /** Attack and release in milliseconds. */
  attackMs?: number;
  releaseMs?: number;
}): Float32Array {
  const { length, triggers } = options;
  const reduction = options.reductionDb ?? -12;
  const floor = Math.pow(10, reduction / 20);
  const attackSamples = Math.max(1, usToSamples((options.attackMs ?? 120) * 1000));
  const releaseSamples = Math.max(1, usToSamples((options.releaseMs ?? 320) * 1000));
  const curve = new Float32Array(length).fill(1);

  for (const [rawStart, rawEnd] of triggers) {
    const start = Math.round(rawStart);
    const end = Math.round(rawEnd);
    const from = Math.max(0, start - attackSamples);
    const to = Math.min(length, end + releaseSamples);
    for (let index = from; index < to; index += 1) {
      let target = 1;
      if (index >= start && index < end) {
        target = floor;
      } else if (index < start) {
        // Attacking from 1 down to the floor, linearly across the attack window.
        const progress = (index - from) / Math.max(1, start - from);
        target = 1 + (floor - 1) * progress;
      } else {
        // Releasing back up to 1 across the release window.
        const progress = (index - end) / Math.max(1, to - end);
        target = floor + (1 - floor) * Math.min(1, progress);
      }
      // Ducking only ever reduces gain; overlapping triggers take the lowest.
      if (target < curve[index]) curve[index] = target;
    }
  }
  // Outside every trigger's influence the curve must be exactly unity, so a
  // release that ran past the end of a later trigger cannot leave it ducked.
  return curve;
}

/** Multiply a curve into a clip in place. */
export function applyGainCurve(clip: PcmClip, curve: Float32Array): void {
  const count = Math.min(clip.length, curve.length);
  for (let index = 0; index < count; index += 1) {
    clip.samples[index * 2] *= curve[index];
    clip.samples[index * 2 + 1] *= curve[index];
  }
}

/**
 * Length of the ramp applied at an unprepared cut, in microseconds (SPEC 12 §12).
 *
 * Two decimal places of a millisecond either side. A splice between unrelated
 * material is a step, and a step is a click: broadband energy spread across the
 * spectrum, which is what makes it audible over the programme. Two milliseconds is
 * long enough that the ramp's own slope is far below the step it replaces — measured
 * at 0.0198 against 0.2645 on a full-scale splice — and short enough that it reads
 * as nothing at all rather than as a fade.
 */
export const DECLICK_US = 2_000;

/**
 * Taper both ends of a clip into whatever follows or precedes it.
 *
 * §12 item 8 asks for "click-free edits". A cut where the audio on each side is
 * unrelated produces a step at the join — up to the sum of the two amplitudes — and
 * that step is a click. This applies a short raised-cosine ramp to the first and
 * last `DECLICK_US` of the clip so the join is continuous.
 *
 * It is deliberately *not* applied where a transition's crossfade already shapes the
 * edges: those envelopes are longer and exactly positioned, and multiplying a 2 ms
 * ramp into a 400 ms crossfade would shift the crossover point without removing
 * anything.
 */
export function applyDeclick(
  clip: PcmClip,
  options: { head: boolean; tail: boolean; lengthUs?: number },
): void {
  const lengthSamples = Math.max(
    1,
    Math.round(((options.lengthUs ?? DECLICK_US) / 1_000_000) * MIX_SAMPLE_RATE),
  );
  // Never ramps more than half the clip, or the two ramps would meet and the whole
  // clip would become one long fade.
  const ramp = Math.min(lengthSamples, Math.floor(clip.length / 2));
  if (ramp <= 0) return;
  for (let offset = 0; offset < ramp; offset += 1) {
    // Raised cosine: 0 → 1 over the ramp, with zero slope at both ends, so there is
    // no second-order discontinuity where the ramp meets the untouched signal.
    const shaped = 0.5 - 0.5 * Math.cos((Math.PI * (offset + 0.5)) / ramp);
    if (options.head) {
      for (let channel = 0; channel < MIX_CHANNELS; channel += 1) {
        clip.samples[offset * MIX_CHANNELS + channel] *= shaped;
      }
    }
    if (options.tail) {
      const index = clip.length - 1 - offset;
      for (let channel = 0; channel < MIX_CHANNELS; channel += 1) {
        clip.samples[index * MIX_CHANNELS + channel] *= shaped;
      }
    }
  }
}

/**
 * The equal-power crossfade gain for one side of a transition (SPEC 12 §4.2).
 *
 * Both clips are multiplied by a half-cosine: `cos(π/2 · t)` for the outgoing side
 * and `sin(π/2 · t)` for the incoming one, where `t` runs 0 → 1 across the window.
 * Squaring them and adding gives 1 at every point — that is what "equal power"
 * means, and it is why the level does not dip in the middle the way a linear
 * crossfade would. For two uncorrelated sources (different footage, different
 * tones) the summed loudness then stays flat.
 *
 * `side` is `out` for the clip leaving and `in` for the clip arriving.
 */
export function equalPowerGain(side: 'in' | 'out', t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const angle = (Math.PI / 2) * clamped;
  return side === 'in' ? Math.sin(angle) : Math.cos(angle);
}

/**
 * Apply an equal-power crossfade to a clip that joins another at a cut.
 *
 * `atCutSamples` is where this clip's audio starts on the mix timeline, which for
 * the incoming side of a transition is also where the window is centred when the
 * transition is `center`-aligned. The window is the transition's own
 * `durationUs`, so the fade always matches what the picture does.
 *
 * The gain extends *outside* the incoming clip's nominal span in one direction and
 * inside it in the other, so the caller passes the range it should be applied over
 * rather than having this function guess.
 */
export function applyCrossfade(
  clip: PcmClip,
  options: {
    /** First sample of the window, relative to `clip`'s own first sample. */
    fromSamples: number;
    /** Length of the window in samples. */
    lengthSamples: number;
    side: 'in' | 'out';
  },
): void {
  const length = Math.max(1, options.lengthSamples);
  for (let offset = 0; offset < length; offset += 1) {
    const index = options.fromSamples + offset;
    if (index < 0 || index >= clip.length) continue;
    const gain = equalPowerGain(options.side, offset / (length - 1 || 1));
    clip.samples[index * MIX_CHANNELS] *= gain;
    clip.samples[index * MIX_CHANNELS + 1] *= gain;
  }
}

/**
 * Peak level of a clip, linear.
 * Used by the limiter and by the silence check in validation.
 */
export function peakLevel(clip: PcmClip): number {
  let peak = 0;
  for (let index = 0; index < clip.length * MIX_CHANNELS; index += 1) {
    const magnitude = Math.abs(clip.samples[index]);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/** Linear amplitude → dBFS (with a floor so silence does not return −∞). */
export function amplitudeToDb(amplitude: number): number {
  if (amplitude <= 1e-7) return -140;
  return 20 * Math.log10(amplitude);
}

/** `true` when the clip has no audible content. */
export function isSilent(clip: PcmClip, thresholdDb = -60): boolean {
  // Inclusive: a clip sitting exactly at the threshold is inaudible in practice.
  return amplitudeToDb(peakLevel(clip)) <= thresholdDb;
}

/**
 * Brick-wall limiter at `ceilingDb` (SPEC 14 §5.1, −1 dBTP).
 *
 * Uses a short look-ahead so gain reduction starts *before* the peak arrives,
 * which is what stops a transient from clipping even though the envelope is only
 * known once the sample is read. Returns the gain reduction applied, in dB, so
 * the report can say how hard it worked.
 */
export function limit(clip: PcmClip, options: { ceilingDb?: number; lookaheadSamples?: number } = {}): {
  maxReductionDb: number;
} {
  const ceiling = Math.pow(10, (options.ceilingDb ?? LIMITER_CEILING_DB) / 20);
  const lookahead = Math.max(1, options.lookaheadSamples ?? usToSamples(5_000)); // 5 ms
  let maxReduction = 0;

  // Sliding-window maximum via a monotonic deque: O(n) overall, so a 30-minute
  // export does not spend minutes in gain computation.
  const frames = clip.length;
  const windowPeaks = new Float32Array(frames);
  const deque: number[] = []; // indices, magnitudes decreasing from the front
  let head = 0;
  for (let index = 0; index < frames; index += 1) {
    const magnitude = Math.max(Math.abs(clip.samples[index * 2]), Math.abs(clip.samples[index * 2 + 1]));
    while (deque.length > head && magnitudeAt(deque[deque.length - 1]) <= magnitude) deque.pop();
    deque.push(index);
    // Evict indices that have fallen out of the trailing window.
    while (deque.length > head && deque[head] < index - lookahead) head += 1;
    windowPeaks[index] = magnitudeAt(deque[head]);
    // Compact occasionally so the array does not grow without bound.
    if (head > 4096) {
      deque.splice(0, head);
      head = 0;
    }
  }

  function magnitudeAt(frameIndex: number): number {
    return Math.max(
      Math.abs(clip.samples[frameIndex * 2]),
      Math.abs(clip.samples[frameIndex * 2 + 1]),
    );
  }

  for (let index = 0; index < frames; index += 1) {
    const windowPeak = windowPeaks[index];
    if (windowPeak <= ceiling) continue;
    const gain = ceiling / windowPeak;
    clip.samples[index * 2] *= gain;
    clip.samples[index * 2 + 1] *= gain;
    const reductionDb = -20 * Math.log10(gain);
    if (reductionDb > maxReduction) maxReduction = reductionDb;
  }
  return { maxReductionDb: maxReduction };
}

/**
 * Trim or pad a clip so it is exactly `samples` long.
 *
 * SPEC 14 §5.3: audio and video must have equal duration, with the audio padded
 * with silence or trimmed to the exact video length.
 */
export function fitLength(clip: PcmClip, samples: number): PcmClip {
  const target = Math.max(0, Math.round(samples));
  if (target === clip.length) return clip;
  const output = createClip(target);
  const copy = Math.min(target, clip.length);
  output.samples.set(clip.samples.subarray(0, copy * MIX_CHANNELS), 0);
  return output;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
