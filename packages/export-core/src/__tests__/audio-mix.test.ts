import { describe, expect, it } from 'vitest';
import {
  LIMITER_CEILING_DB,
  MIX_CHANNELS,
  MIX_SAMPLE_RATE,
  amplitudeToDb,
  applyGainCurve,
  applyItemProcessing,
  createClip,
  duckingCurve,
  fitLength,
  isSilent,
  limit,
  mixClipInto,
  peakLevel,
  samplesToUs,
  usToSamples,
  type PcmClip,
} from '../audio-mix.js';

/** A clip full of a constant DC value on both channels. */
function constantClip(samples: number, value: number): PcmClip {
  const clip = createClip(samples);
  clip.samples.fill(value);
  return clip;
}

/** Fill a clip with a sine of the given amplitude and frequency. */
function sineClip(samples: number, amplitude = 0.5, frequency = 440): PcmClip {
  const clip = createClip(samples);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / MIX_SAMPLE_RATE) * amplitude;
    clip.samples[index * 2] = value;
    clip.samples[index * 2 + 1] = value;
  }
  return clip;
}

describe('time conversion', () => {
  it('converts microseconds to samples at 48 kHz', () => {
    expect(usToSamples(1_000_000)).toBe(48_000);
    expect(usToSamples(500_000)).toBe(24_000);
    expect(usToSamples(0)).toBe(0);
  });

  it('round-trips within a microsecond', () => {
    for (const us of [0, 1_000, 33_333, 1_000_000, 5_000_000]) {
      expect(Math.abs(samplesToUs(usToSamples(us)) - us)).toBeLessThanOrEqual(11);
    }
  });
});

describe('createClip', () => {
  it('allocates interleaved stereo frames', () => {
    const clip = createClip(100);
    expect(clip.length).toBe(100);
    expect(clip.samples.length).toBe(100 * MIX_CHANNELS);
  });

  it('starts silent', () => {
    expect(peakLevel(createClip(64))).toBe(0);
  });
});

describe('applyItemProcessing', () => {
  it('applies gain', () => {
    const clip = constantClip(10, 0.5);
    applyItemProcessing(clip, { gain: 0.5, startUs: 0, durationUs: 0 });
    // 0.5 * 0.5 gain, with a centred pan at unity.
    expect(clip.samples[0]).toBeCloseTo(0.25, 5);
  });

  it('multiplies item gain by track volume', () => {
    const clip = constantClip(10, 1);
    applyItemProcessing(clip, { gain: 0.5, trackVolume: 0.5, startUs: 0, durationUs: 0 });
    expect(clip.samples[0]).toBeCloseTo(0.25, 5);
  });

  it('silences a muted item completely', () => {
    const clip = constantClip(10, 0.9);
    applyItemProcessing(clip, { muted: true, startUs: 0, durationUs: 0 });
    expect(peakLevel(clip)).toBe(0);
  });

  it('fades in linearly over the requested time', () => {
    const samples = 48_000; // 1 s
    const clip = constantClip(samples, 1);
    applyItemProcessing(clip, { fadeInUs: 500_000, startUs: 0, durationUs: 1_000_000 });
    // At the very start the envelope is 0; halfway through the fade it is 0.5;
    // past the fade it is full.
    expect(clip.samples[0]).toBeCloseTo(0, 5);
    expect(clip.samples[12_000 * 2]).toBeCloseTo(0.5, 2);
    expect(clip.samples[40_000 * 2]).toBeCloseTo(1, 2);
  });

  it('fades out to silence at the end', () => {
    const samples = 48_000;
    const clip = constantClip(samples, 1);
    applyItemProcessing(clip, { fadeOutUs: 500_000, startUs: 0, durationUs: 1_000_000 });
    expect(clip.samples[(samples - 1) * 2]).toBeCloseTo(0, 3);
    expect(clip.samples[10_000 * 2]).toBeCloseTo(1, 2);
  });

  it('pans hard left by silencing the right channel', () => {
    const clip = constantClip(10, 1);
    applyItemProcessing(clip, { pan: -1, startUs: 0, durationUs: 0 });
    expect(Math.abs(clip.samples[0])).toBeGreaterThan(0.9);
    expect(clip.samples[1]).toBeCloseTo(0, 5);
  });

  it('pans hard right by silencing the left channel', () => {
    const clip = constantClip(10, 1);
    applyItemProcessing(clip, { pan: 1, startUs: 0, durationUs: 0 });
    expect(clip.samples[0]).toBeCloseTo(0, 5);
    expect(Math.abs(clip.samples[1])).toBeGreaterThan(0.9);
  });

  it('keeps a centred item at the same loudness on both channels', () => {
    const clip = constantClip(10, 1);
    applyItemProcessing(clip, { pan: 0, startUs: 0, durationUs: 0 });
    expect(clip.samples[0]).toBeCloseTo(clip.samples[1], 5);
  });

  it('clamps an out-of-range pan instead of inverting channels', () => {
    const clip = constantClip(4, 1);
    applyItemProcessing(clip, { pan: -5, startUs: 0, durationUs: 0 });
    expect(clip.samples[1]).toBeCloseTo(0, 5);
  });
});

describe('mixClipInto', () => {
  it('sums at the requested offset', () => {
    const target = createClip(10);
    const clip = constantClip(4, 0.25);
    mixClipInto(target, clip, 3);
    expect(target.samples[0]).toBe(0);
    expect(target.samples[3 * 2]).toBeCloseTo(0.25, 5);
    expect(target.samples[6 * 2]).toBeCloseTo(0.25, 5);
    expect(target.samples[7 * 2]).toBe(0);
  });

  it('discards the overrun rather than growing the mix', () => {
    const target = createClip(5);
    const clip = constantClip(100, 0.5);
    mixClipInto(target, clip, 2);
    expect(target.length).toBe(5);
    // Only 3 frames fit.
    expect(target.samples[4 * 2]).toBeCloseTo(0.5, 5);
    expect(target.length * MIX_CHANNELS).toBe(target.samples.length);
  });

  it('adds overlapping clips', () => {
    const target = createClip(4);
    mixClipInto(target, constantClip(4, 0.3), 0);
    mixClipInto(target, constantClip(4, 0.4), 0);
    expect(target.samples[0]).toBeCloseTo(0.7, 5);
  });

  it('drops the leading samples of a clip that starts before zero', () => {
    const target = createClip(4);
    const clip = createClip(6);
    // Mark each frame with its index so the offset is observable.
    for (let index = 0; index < 6; index += 1) {
      clip.samples[index * 2] = index + 1;
      clip.samples[index * 2 + 1] = index + 1;
    }
    mixClipInto(target, clip, -2);
    // Frames 0 and 1 fell before the mix start, so frame 0 is source frame 2.
    expect(target.samples[0]).toBeCloseTo(3, 5);
    expect(target.samples[2]).toBeCloseTo(4, 5);
    expect(target.samples[6]).toBeCloseTo(6, 5);
    expect(target.samples[4]).toBeCloseTo(5, 5);
  });
});

describe('duckingCurve', () => {
  it('is unity with no triggers', () => {
    const curve = duckingCurve({ length: 100, triggers: [] });
    expect(Array.from(curve).every((value) => value === 1)).toBe(true);
  });

  it('reduces gain while speech is present', () => {
    const curve = duckingCurve({
      length: 48_000,
      triggers: [[10_000, 20_000]],
      reductionDb: -12,
    });
    expect(curve[15_000]).toBeCloseTo(Math.pow(10, -12 / 20), 3);
    // Release is 320 ms, so the gain is back to unity well after speech ends.
    expect(curve[20_000 + 15_360 + 100]).toBeCloseTo(1, 3);
    // Before the attack window there is no reduction at all.
    expect(curve[0]).toBe(1);
  });

  it('ramps rather than jumping at the trigger edge', () => {
    const curve = duckingCurve({
      length: 48_000,
      triggers: [[10_000, 20_000]],
      reductionDb: -12,
      attackMs: 100,
    });
    // Just before the trigger the gain is on its way down, not already floored.
    expect(curve[9_500]).toBeLessThan(1);
    expect(curve[9_500]).toBeGreaterThan(curve[10_000]);
  });

  it('never boosts', () => {
    const curve = duckingCurve({ length: 48_000, triggers: [[0, 48_000]], reductionDb: -6 });
    expect(Array.from(curve).every((value) => value <= 1)).toBe(true);
  });

  it('takes the lowest gain for overlapping triggers', () => {
    const curve = duckingCurve({
      length: 10_000,
      triggers: [
        [0, 6_000],
        [2_000, 8_000],
      ],
      reductionDb: -12,
    });
    expect(curve[4_000]).toBeLessThanOrEqual(Math.pow(10, -12 / 20) + 1e-6);
  });
});

describe('applyGainCurve', () => {
  it('multiplies the curve into the clip', () => {
    const clip = constantClip(4, 1);
    applyGainCurve(clip, new Float32Array([0, 0.5, 1, 0.25]));
    expect(clip.samples[0]).toBe(0);
    expect(clip.samples[1 * 2]).toBeCloseTo(0.5, 5);
    expect(clip.samples[2 * 2]).toBeCloseTo(1, 5);
    expect(clip.samples[3 * 2]).toBeCloseTo(0.25, 5);
  });
});

describe('peakLevel / amplitudeToDb / isSilent', () => {
  it('finds the loudest sample', () => {
    const clip = createClip(3);
    clip.samples[0] = 0.1;
    clip.samples[3] = -0.7;
    expect(peakLevel(clip)).toBeCloseTo(0.7, 5);
  });

  it('converts amplitude to dBFS', () => {
    expect(amplitudeToDb(1)).toBeCloseTo(0, 5);
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.02, 1);
  });

  it('floors silence instead of returning −Infinity', () => {
    expect(amplitudeToDb(0)).toBe(-140);
    expect(Number.isFinite(amplitudeToDb(0))).toBe(true);
  });

  it('calls a silent clip silent', () => {
    expect(isSilent(createClip(100))).toBe(true);
    // 0.0001 is -80 dBFS, comfortably below the -60 dB threshold.
    expect(isSilent(constantClip(100, 0.0001))).toBe(true);
  });

  it('calls an audible clip audible', () => {
    expect(isSilent(constantClip(100, 0.5))).toBe(false);
  });
});

describe('limit', () => {
  it('leaves a quiet clip untouched', () => {
    const clip = sineClip(48_000, 0.5);
    const before = Float32Array.from(clip.samples);
    const result = limit(clip);
    expect(result.maxReductionDb).toBe(0);
    expect(Array.from(clip.samples)).toEqual(Array.from(before));
  });

  it('brings a hot clip down to the ceiling', () => {
    const clip = sineClip(48_000, 2.0);
    limit(clip);
    const peakDb = amplitudeToDb(peakLevel(clip));
    expect(peakDb).toBeLessThanOrEqual(LIMITER_CEILING_DB + 0.5);
  });

  it('reports how hard it worked', () => {
    const clip = sineClip(48_000, 2.0);
    const result = limit(clip);
    expect(result.maxReductionDb).toBeGreaterThan(0);
  });

  it('respects a custom ceiling', () => {
    const clip = sineClip(48_000, 1.0);
    limit(clip, { ceilingDb: -6 });
    expect(amplitudeToDb(peakLevel(clip))).toBeLessThanOrEqual(-5.5);
  });

  it('is O(n): a long clip finishes quickly', () => {
    // 10 minutes of stereo audio. A window-scan implementation would need
    // billions of comparisons and time out.
    const clip = sineClip(MIX_SAMPLE_RATE * 60 * 10, 0.8);
    const started = Date.now();
    limit(clip);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});

describe('fitLength', () => {
  it('pads with silence to the target length', () => {
    const clip = constantClip(100, 0.5);
    const fitted = fitLength(clip, 200);
    expect(fitted.length).toBe(200);
    // The original content survives...
    expect(fitted.samples[50 * 2]).toBeCloseTo(0.5, 5);
    // ...and everything past it is silence, not a repeat of the last sample.
    expect(fitted.samples[100 * 2]).toBe(0);
    expect(fitted.samples[199 * 2]).toBe(0);
  });

  it('trims to the target length', () => {
    const clip = constantClip(200, 0.5);
    const fitted = fitLength(clip, 50);
    expect(fitted.length).toBe(50);
  });

  it('returns the same clip when the length already matches', () => {
    const clip = constantClip(10, 0.5);
    expect(fitLength(clip, 10)).toBe(clip);
  });

  it('truncates a fractional target to whole frames', () => {
    expect(fitLength(createClip(10), 10.7).length).toBe(11);
  });
});
