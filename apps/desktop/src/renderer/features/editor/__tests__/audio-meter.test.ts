import { describe, expect, it } from 'vitest';
import {
  CLIP_DB,
  METER_FLOOR_DB,
  PEAK_HOLD_MS,
  SILENT_METER,
  amplitudeToDb,
  channelPeakDb,
  clampDb,
  meterFraction,
  updateMeter,
} from '../audio-meter';

/**
 * The meter's arithmetic (SPEC 12 §6.3).
 *
 * These are the decisions a peak meter gets wrong quietly: a hold that decays like a
 * level, a clip light that clears itself, and a scale whose labels do not match the bar
 * heights. None of them are visible in a screenshot, and all of them are one function.
 */
describe('clampDb', () => {
  it('floors anything below the scale, including exact silence', () => {
    expect(clampDb(-90)).toBe(METER_FLOOR_DB);
    /*
      `-Infinity` is a real reading: a buffer of exact zeros converts to it, and letting
      it through would reach a CSS height as `-Infinity%`, which drops the element
      entirely. The meter would then look broken rather than silent.
    */
    expect(clampDb(-Infinity)).toBe(METER_FLOOR_DB);
  });

  it('treats a non-finite reading as silence rather than as a value', () => {
    // A disconnected analyser produces NaN; a meter that vanishes is indistinguishable
    // from one that is broken, so it reads zero instead.
    expect(clampDb(Number.NaN)).toBe(METER_FLOOR_DB);
  });

  it('caps at full scale rather than passing an over reading through', () => {
    expect(clampDb(6)).toBe(CLIP_DB);
  });
});

describe('meterFraction', () => {
  it('puts the floor at the bottom and full scale at the top', () => {
    expect(meterFraction(METER_FLOOR_DB)).toBe(0);
    expect(meterFraction(CLIP_DB)).toBe(1);
  });

  it('places a level proportionally between them', () => {
    // Halfway up the −60…0 scale is −30 dB, not −20: a linear-in-dB scale, which is what
    // the labels draw. Getting this wrong makes the bar and its labels disagree.
    expect(meterFraction(-30)).toBeCloseTo(0.5, 6);
    expect(meterFraction(-45)).toBeCloseTo(0.25, 6);
  });

  it('never leaves 0…1 for an out-of-range reading', () => {
    expect(meterFraction(-1000)).toBe(0);
    expect(meterFraction(100)).toBe(1);
  });
});

describe('amplitudeToDb', () => {
  it('converts an amplitude the way the mixer does', () => {
    // Full scale is 0 dB, half amplitude is −6.02, a tenth is −20.
    expect(amplitudeToDb(1)).toBeCloseTo(0, 6);
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(amplitudeToDb(0.1)).toBeCloseTo(-20, 6);
  });

  it('reports silence at the scale floor, not at the conversion floor', () => {
    /*
      `gainToDb(0)` is −120, the envelope's own floor. The meter's scale stops at −60, so
      returning the conversion's floor would put the reading off the bottom of the bar.
      The two floors belong to different things and this is where they meet.
    */
    expect(amplitudeToDb(0)).toBe(METER_FLOOR_DB);
    expect(amplitudeToDb(0.000001)).toBe(METER_FLOOR_DB);
  });
});

describe('channelPeakDb', () => {
  const interleaved = new Float32Array([
    0.5, 0.1, // frame 0: loud left, quiet right
    -0.8, 0.2, // frame 1: louder left
    0.3, -0.6, // frame 2: quieter left, louder right
  ]);

  it('reads each channel from interleaved samples', () => {
    expect(channelPeakDb(interleaved, 0, 2)).toBeCloseTo(amplitudeToDb(0.8), 6);
    expect(channelPeakDb(interleaved, 1, 2)).toBeCloseTo(amplitudeToDb(0.6), 6);
  });

  it('uses the peak, not the last sample or an average', () => {
    /*
      The distinguishing case: the loudest sample is in the middle, so a reader that
      sampled the first frame or averaged would report 0.5 or ~0.53 instead of 0.8. A
      peak meter that shows an average never reaches the clip line, however hard the mix
      clips — which is the opposite of what the clip light is for.
    */
    expect(channelPeakDb(interleaved, 0, 2)).toBeGreaterThan(amplitudeToDb(0.5));
  });

  it('reports silence for an empty window', () => {
    expect(channelPeakDb(new Float32Array(0), 0, 2)).toBe(METER_FLOOR_DB);
  });
});

describe('updateMeter', () => {
  const reading = (leftDb: number, rightDb: number) => ({ leftDb, rightDb });

  it('follows the level upward and holds the peak', () => {
    const first = updateMeter(SILENT_METER, reading(-20, -20), 1000);
    expect(first.leftDb).toBe(-20);
    expect(first.peakLeftDb).toBe(-20);

    // The sound drops; the hold has to stay where it was.
    const second = updateMeter(first, reading(-40, -40), 1200);
    expect(second.leftDb).toBe(-40);
    expect(second.peakLeftDb, 'the peak is still the loud moment').toBe(-20);
  });

  it('drops the hold to the current level once the hold expires', () => {
    let state = updateMeter(SILENT_METER, reading(-20, -20), 1000);
    state = updateMeter(state, reading(-40, -40), 1200);
    expect(state.peakLeftDb).toBe(-20);

    state = updateMeter(state, reading(-40, -40), 1000 + PEAK_HOLD_MS);
    /*
      Dropped to the *level*, not to the floor. Sending the marker to the bottom of the
      scale after 1.5 s would make it disappear while the sound was still playing, and a
      user reading the meter would think the audio had stopped.
    */
    expect(state.peakLeftDb).toBe(-40);
  });

  it('does not expire a hold that the level keeps re-reaching', () => {
    let state = updateMeter(SILENT_METER, reading(-20, -20), 1000);
    // A steady tone sits at its own level; every reading is a new high, so the timer
    // restarts and the hold never decays.
    for (let elapsed = 500; elapsed <= 5000; elapsed += 500) {
      state = updateMeter(state, reading(-20, -20), 1000 + elapsed);
      expect(state.peakLeftDb).toBe(-20);
    }
  });

  it('keeps the two channels independent', () => {
    // A hold on one channel expiring must not move the other's.
    let state = updateMeter(SILENT_METER, reading(-10, -30), 1000);
    state = updateMeter(state, reading(-50, -30), 1000 + PEAK_HOLD_MS);
    expect(state.peakLeftDb, 'the left hold expired').toBe(-50);
    expect(state.peakRightDb, 'the right hold was re-reached').toBe(-30);
  });

  it('latches the clip light until it is cleared', () => {
    let state = updateMeter(SILENT_METER, reading(0, 0), 1000);
    expect(state.clipped).toBe(true);

    // Quiet again, long after: still clipped, because the light is latched by design and
    // only a click clears it. A self-clearing light teaches the user to ignore it.
    state = updateMeter(state, reading(-40, -40), 1000 + PEAK_HOLD_MS * 10);
    expect(state.clipped).toBe(true);
  });

  it('does not clip on a loud but legal reading', () => {
    const state = updateMeter(SILENT_METER, reading(-0.5, -3), 1000);
    expect(state.clipped).toBe(false);
  });

  it('treats an over reading as a clip and clamps the bar', () => {
    const state = updateMeter(SILENT_METER, reading(3, -20), 1000);
    expect(state.clipped).toBe(true);
    // The bar cannot draw past full scale, however far over the reading was.
    expect(state.leftDb).toBe(CLIP_DB);
  });
});
