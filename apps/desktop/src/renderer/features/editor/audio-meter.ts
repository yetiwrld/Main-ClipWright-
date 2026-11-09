/**
 * Peak metering for the preview (SPEC 12 §6.3, `10 §3.2`).
 *
 * The spec asks for a master **stereo peak meter** with a −60…0 dB scale, a 1.5 s peak
 * hold and a clip indicator that latches until clicked. Almost all of that is arithmetic
 * on a level that arrives 30 times a second, and arithmetic is the part worth testing:
 * a hold that decays on the wrong schedule, a floor in linear units that is not the one
 * the scale draws, or a clip light that clears itself are all invisible in a screenshot
 * and obvious in a test.
 *
 * So the Web Audio wiring lives in `use-audio-meter.ts` and everything that decides what
 * the meter *shows* lives here, as pure functions over a number.
 */

import { gainToDb } from '@clipwright/audio-core';

/** The meter's floor, in dBFS. Below this the level is drawn as silence. */
export const METER_FLOOR_DB = -60;

/** How long a peak stays lit after the level falls below it (SPEC 12 §6.3: 1.5 s). */
export const PEAK_HOLD_MS = 1500;

/** What a clip is: at or above full scale. Digital clips at 0 dBFS, so that is the line. */
export const CLIP_DB = 0;

export interface MeterLevels {
  /** Current level per channel, dBFS, clamped to `METER_FLOOR_DB`…`CLIP_DB`. */
  leftDb: number;
  rightDb: number;
  /**
   * The held peak per channel, dBFS.
   *
   * Held separately from the instantaneous level because the two answer different
   * questions: the level is "how loud is it now", the hold is "how loud has it been
   * recently", and only the second one survives a transient long enough to read.
   */
  peakLeftDb: number;
  peakRightDb: number;
}

export interface MeterState extends MeterLevels {
  /** Latched until cleared by the user, never by time (SPEC 12 §6.3). */
  clipped: boolean;
  /** When each channel last saw its held peak, for the hold's own timer. */
  peakLeftAtMs: number;
  peakRightAtMs: number;
}

export const SILENT_METER: MeterState = {
  leftDb: METER_FLOOR_DB,
  rightDb: METER_FLOOR_DB,
  peakLeftDb: METER_FLOOR_DB,
  peakRightDb: METER_FLOOR_DB,
  clipped: false,
  peakLeftAtMs: 0,
  peakRightAtMs: 0,
};

/**
 * Clamp a dB value into the scale the meter draws.
 *
 * `-Infinity` is a real reading — exact silence in float samples — and has to land on the
 * floor rather than becoming `NaN` in a `translateY`, which is the same trap the snapping
 * code hit with a degenerate threshold. `NaN` reaching here (a disconnected analyser) is
 * treated as silence for the same reason: a meter that disappears is worse than one that
 * reads zero, because the user cannot tell it apart from a broken one.
 */
export function clampDb(db: number): number {
  if (!Number.isFinite(db)) return METER_FLOOR_DB;
  if (db < METER_FLOOR_DB) return METER_FLOOR_DB;
  if (db > CLIP_DB) return CLIP_DB;
  return db;
}

/**
 * Where a dB level sits on the meter, 0 at the floor and 1 at full scale.
 *
 * Used for the bar's height. The `(level - floor) / (0 - floor)` form is written out
 * rather than using a mapped percentage so that changing the floor moves the bar with
 * it: a hard-coded `1 - Math.abs(db) / 60` would silently desynchronise from the scale
 * the labels are drawn from.
 */
export function meterFraction(db: number): number {
  return (clampDb(db) - METER_FLOOR_DB) / (CLIP_DB - METER_FLOOR_DB);
}

/**
 * A linear amplitude as a dB level, which is what an `AnalyserNode` produces.
 *
 * Delegates to `audio-core`'s `gainToDb` rather than re-deriving `20 log10`: the export
 * mixer uses that same function, and a meter that computed the conversion a second way
 * could disagree with the file about what −6 dB means. Only the floor is decided here,
 * because the floor is a property of the meter's scale and not of the conversion.
 */
export function amplitudeToDb(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return METER_FLOOR_DB;
  /*
    Clamped on the way out, not only on the way in. An amplitude of 1e-6 is a real
    reading that converts to −120 dB — below the scale — and a bar drawn from it would go
    off the bottom instead of sitting at the floor. The clamp belongs to the meter's
    scale, so the conversion has to end at it.
  */
  return clampDb(gainToDb(amplitude));
}

/**
 * The peak amplitude of an interleaved buffer's channel, which is what a peak meter
 * actually shows.
 *
 * `getFloatTimeDomainData` returns the most recent window, and its peak is the honest
 * level for that window — an RMS reading would be more useful for loudness and is what
 * the LUFS readout uses, but a *peak* meter showing RMS is a meter that never reaches the
 * clip line however hard the mix clips.
 */
export function channelPeakDb(samples: Float32Array, channel: 0 | 1, channels: number): number {
  let peak = 0;
  for (let index = channel; index < samples.length; index += channels) {
    const value = Math.abs(samples[index] ?? 0);
    if (value > peak) peak = value;
  }
  return amplitudeToDb(peak);
}

/**
 * Fold one analyser reading into the meter's state.
 *
 * Two rules live here, and both are the sort of thing a display gets wrong on its own:
 *
 * - **The hold follows the level up instantly and down on a timer.** A peak meter that
 *   follows the level down at the same speed is just the level again; the hold exists so
 *   a transient stays readable. After `PEAK_HOLD_MS` without a new high, the held value
 *   drops to whatever the level is now — not to the floor, which would make the marker
 *   vanish while the sound continued.
 * - **The clip light only ever sets.** It has no timer and no decay, because the spec
 *   says it latches until clicked: a clip light that clears itself teaches the user that
 *   clipping is not worth looking at, and the clip is the one reading in a metre that
 *   needs acting on.
 */
export function updateMeter(
  previous: MeterState,
  reading: { leftDb: number; rightDb: number },
  nowMs: number,
): MeterState {
  const leftDb = clampDb(reading.leftDb);
  const rightDb = clampDb(reading.rightDb);

  const leftIsNewPeak = leftDb >= previous.peakLeftDb;
  const rightIsNewPeak = rightDb >= previous.peakRightDb;
  const leftExpired = nowMs - previous.peakLeftAtMs >= PEAK_HOLD_MS && !leftIsNewPeak;
  const rightExpired = nowMs - previous.peakRightAtMs >= PEAK_HOLD_MS && !rightIsNewPeak;

  let peakLeftDb: number;
  let peakLeftAtMs: number;
  if (leftIsNewPeak) {
    peakLeftDb = leftDb;
    peakLeftAtMs = nowMs;
  } else if (leftExpired) {
    peakLeftDb = leftDb;
    peakLeftAtMs = nowMs;
  } else {
    peakLeftDb = previous.peakLeftDb;
    peakLeftAtMs = previous.peakLeftAtMs;
  }

  let peakRightDb: number;
  let peakRightAtMs: number;
  if (rightIsNewPeak) {
    peakRightDb = rightDb;
    peakRightAtMs = nowMs;
  } else if (rightExpired) {
    peakRightDb = rightDb;
    peakRightAtMs = nowMs;
  } else {
    peakRightDb = previous.peakRightDb;
    peakRightAtMs = previous.peakRightAtMs;
  }

  return {
    leftDb,
    rightDb,
    peakLeftDb,
    peakRightDb,
    clipped: previous.clipped || leftDb >= CLIP_DB || rightDb >= CLIP_DB,
    peakLeftAtMs,
    peakRightAtMs,
  };
}
