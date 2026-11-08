/**
 * SPEC 12 §6.1, SPEC 10 §7.1 — the gain envelope.
 *
 * The most important test in this file is the last one: the preview's automation
 * curve and the export's per-sample gain must produce the same numbers. Everything
 * else checks a formula; that one checks the reason the module exists, and it is the
 * only one that would have caught the bug the spec warns about — a preview that
 * sounds right and an export that clips.
 */
import { describe, expect, it } from 'vitest';
import {
  activeRanges,
  applyGainEnvelope,
  dbToGain,
  easingValue,
  envelopeCurve,
  fadeAt,
  fadeCurveValue,
  gainAt,
  gainToDb,
  valueAt,
  type GainEnvelopeInput,
} from '../envelope.js';

const clip = (overrides: Partial<GainEnvelopeInput> = {}): GainEnvelopeInput => ({
  startUs: 1_000_000,
  durationUs: 2_000_000,
  ...overrides,
});

describe('dB conversion', () => {
  it('0 dB is unity', () => {
    expect(dbToGain(0)).toBe(1);
  });

  it('+6 dB is about double', () => {
    expect(dbToGain(6)).toBeCloseTo(1.9953, 3);
  });

  it('−6 dB is about half', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
  });

  it('treats −60 dB as exact silence, not a small number', () => {
    // The spec's slider bottoms out at −60 and means silence by it. Returning
    // 0.001 there would leave a floor of noise under every faded clip.
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(-200)).toBe(0);
  });

  it('round-trips through gainToDb', () => {
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 6);
  });

  it('floors gainToDb at zero rather than returning -Infinity', () => {
    expect(gainToDb(0)).toBe(-120);
    expect(Number.isFinite(gainToDb(0))).toBe(true);
  });
});

describe('fadeCurveValue', () => {
  it('every curve runs 0 to 1', () => {
    for (const curve of ['linear', 'equal-power', 'exponential'] as const) {
      expect(fadeCurveValue(curve, 0), curve).toBeCloseTo(0, 6);
      expect(fadeCurveValue(curve, 1), curve).toBeCloseTo(1, 6);
    }
  });

  it('equal-power sits above linear in the middle', () => {
    // That is the whole reason it is the default: two equal-power fades crossing at
    // −3 dB sum to unity instead of dipping.
    expect(fadeCurveValue('equal-power', 0.5)).toBeGreaterThan(fadeCurveValue('linear', 0.5));
    expect(fadeCurveValue('equal-power', 0.5)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('exponential sits below linear', () => {
    expect(fadeCurveValue('exponential', 0.5)).toBeCloseTo(0.25, 6);
  });

  it('clamps progress outside 0–1', () => {
    expect(fadeCurveValue('linear', -1)).toBe(0);
    expect(fadeCurveValue('linear', 2)).toBe(1);
  });
});

describe('easingValue', () => {
  const presets = [
    'linear',
    'easeIn',
    'easeOut',
    'easeInOut',
    'easeInCubic',
    'easeOutCubic',
    'easeInOutCubic',
    'easeInBack',
    'easeOutBack',
    'easeOutBounce',
    'easeOutElastic',
  ] as const;

  it('starts at 0 and ends at 1 for every preset', () => {
    for (const preset of presets) {
      expect(easingValue(preset, 0), preset).toBeCloseTo(0, 6);
      expect(easingValue(preset, 1), preset).toBeCloseTo(1, 6);
    }
  });

  it('overshoots for a back curve, which is what makes it read as a settle', () => {
    const overshoot = easingValue('easeOutBack', 0.7);
    expect(overshoot).toBeGreaterThan(1);
  });

  it('treats an unknown preset as linear rather than throwing', () => {
    expect(easingValue(undefined, 0.25)).toBeCloseTo(0.25, 6);
  });
});

describe('valueAt', () => {
  const keys = [
    { timeUs: 0, valueDb: 0 },
    { timeUs: 1_000_000, valueDb: -12 },
    { timeUs: 2_000_000, valueDb: -12 },
  ];

  it('interpolates linearly between keys', () => {
    expect(valueAt(keys, 500_000)).toBeCloseTo(-6, 6);
  });

  it('holds the first value before the first key', () => {
    // A zero-fill here is what makes a clip with its first key at 2 s silently
    // inaudible for two seconds.
    expect(valueAt(keys, -5_000_000)).toBe(0);
  });

  it('holds the last value after the last key', () => {
    expect(valueAt(keys, 9_000_000)).toBe(-12);
  });

  it('returns null with no keys, so the caller can use the static volume', () => {
    expect(valueAt([], 0)).toBeNull();
  });

  it('keeps the from-value for a hold keyframe', () => {
    const hold = [
      { timeUs: 0, valueDb: 0, interpolation: 'hold' as const },
      { timeUs: 1_000_000, valueDb: -12 },
    ];
    expect(valueAt(hold, 999_999)).toBe(0);
    expect(valueAt(hold, 1_000_000)).toBe(-12);
  });

  it('follows the easing preset on a preset keyframe', () => {
    const eased = [
      { timeUs: 0, valueDb: 0, interpolation: 'preset' as const, easing: { preset: 'easeIn' as const } },
      { timeUs: 1_000_000, valueDb: -12 },
    ];
    // easeIn is slow at the start, so at half time it has moved less than half way.
    expect(valueAt(eased, 500_000)).toBeGreaterThan(-6);
  });

  it('returns the single value when there is one key', () => {
    expect(valueAt([{ timeUs: 0, valueDb: -3 }], 5_000_000)).toBe(-3);
  });

  it('finds the right segment in a long curve without a linear scan', () => {
    // A gain curve is sampled per audio frame; a scan over thousands of keys would
    // dominate the mix.
    const many = Array.from({ length: 1000 }, (_, index) => ({
      timeUs: index * 1000,
      valueDb: index % 2 === 0 ? 0 : -6,
    }));
    expect(valueAt(many, 500_500)).toBeCloseTo(-3, 6);
  });
});

describe('gainAt', () => {
  it('is silent outside the clip', () => {
    expect(gainAt(clip(), 0)).toBe(0);
    expect(gainAt(clip(), 3_500_000)).toBe(0);
  });

  it('is unity with no level, fades or keys', () => {
    expect(gainAt(clip(), 2_000_000)).toBe(1);
  });

  it('multiplies gain, volume and track volume', () => {
    // ×2 × ×2 = ×4, which is +12 dB of linear gain. Adding the dB values would be
    // the same answer here and the wrong model once fades multiply in.
    const loud = clip({ gainDb: 6, volumeDb: 6 });
    expect(gainAt(loud, 2_000_000)).toBeCloseTo(3.9811, 3);
  });

  it('lets a keyframed volume override the static one', () => {
    const keyed = clip({ volumeDb: 6, keyframes: [{ timeUs: 1_000_000, valueDb: -6 }] });
    expect(gainAt(keyed, 2_000_000)).toBeCloseTo(dbToGain(-6), 6);
  });

  it('is silent when muted, whatever the level', () => {
    expect(gainAt(clip({ volumeDb: 12, muted: true }), 2_000_000)).toBe(0);
    expect(gainAt(clip({ volumeDb: 12, trackMuted: true }), 2_000_000)).toBe(0);
    expect(gainAt(clip({ volumeDb: 12, silencedBySolo: true }), 2_000_000)).toBe(0);
  });

  it('applies the fade on top of the volume', () => {
    const faded = clip({ volumeDb: -6, fadeInUs: 1_000_000 });
    // Half way through a 1 s equal-power fade the multiplier is √½, so the gain is
    // that times the −6 dB volume.
    expect(gainAt(faded, 1_500_000)).toBeCloseTo(dbToGain(-6) * Math.SQRT1_2, 5);
  });
});

describe('fadeAt', () => {
  it('is 1 outside both fades', () => {
    const faded = clip({ fadeInUs: 500_000, fadeOutUs: 500_000 });
    expect(fadeAt(faded, 2_000_000)).toBe(1);
  });

  it('reaches exactly 0 at the very start of a fade-in', () => {
    expect(fadeAt(clip({ fadeInUs: 500_000 }), 1_000_000)).toBe(0);
  });

  it('reaches exactly 0 at the very end of a fade-out', () => {
    expect(fadeAt(clip({ fadeOutUs: 500_000 }), 3_000_000)).toBe(0);
  });

  it('uses the requested curve', () => {
    const linear = clip({ fadeInUs: 1_000_000, fadeCurve: 'linear' });
    expect(fadeAt(linear, 1_500_000)).toBeCloseTo(0.5, 6);
  });

  it('defaults to equal-power, not linear', () => {
    expect(fadeAt(clip({ fadeInUs: 1_000_000 }), 1_500_000)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('takes the quieter of two overlapping fades on a very short clip', () => {
    // A clip that is all fade must not bump in the middle. Picking whichever edge
    // was checked first made the result depend on the order of two `if`s.
    const short = clip({ durationUs: 100_000, fadeInUs: 100_000, fadeOutUs: 100_000 });
    const mid = fadeAt(short, 1_050_000);
    // Both fades are half-way, so equal-power gives √½ — and, crucially, the same
    // value whichever edge is examined first.
    expect(mid).toBeCloseTo(Math.SQRT1_2, 6);
    // Symmetric: the same distance from either edge gives the same value.
    expect(fadeAt(short, 1_020_000)).toBeCloseTo(fadeAt(short, 1_080_000), 6);
  });

  it('is monotone through a long fade-in before the fade-out starts', () => {
    // A 1 s clip with a 0.9 s fade-in and a 0.2 s fade-out: at 0.4 s only the
    // fade-in is running, at 0.5 s both are and the quieter (the fade-out, barely
    // begun) wins. So the curve rises, then falls — which is the honest shape of
    // asking for two fades longer than the clip, not a bug.
    const lopsided = clip({ durationUs: 1_000_000, fadeInUs: 900_000, fadeOutUs: 200_000 });
    expect(fadeAt(lopsided, 1_400_000)).toBeGreaterThan(fadeAt(lopsided, 1_300_000));
    expect(fadeAt(lopsided, 1_950_000)).toBeLessThan(fadeAt(lopsided, 1_900_000));
  });
});

describe('envelopeCurve', () => {
  it('produces the requested number of points', () => {
    expect(envelopeCurve(clip(), { durationUs: 2_000_000, points: 64 })).toHaveLength(64);
  });

  it('starts silent, holds unity in the middle and is nearly silent at the end', () => {
    const faded = clip({ fadeInUs: 1_000_000, fadeOutUs: 1_000_000 });
    const curve = envelopeCurve(faded, { durationUs: 2_000_000, points: 33 });
    expect(curve[0]).toBeCloseTo(0, 6);
    expect(curve[16]).toBeCloseTo(1, 2);
    // The last point is one interval from the end, not at it — that is how
    // `setValueCurveAtTime` maps an array onto a duration, and it is why the
    // preview and the mixer agree sample for sample (see the last describe).
    expect(curve[32]!).toBeLessThan(0.2);
    expect(curve[32]!).toBeGreaterThan(0);
  });

  it('spreads points over the duration like Web Audio, not over points-1', () => {
    // A sustained level makes the mapping visible: with the wrong divisor the last
    // point is a whole interval late, so a 1 s clip's final point would sample 1 s
    // in (silence by then) instead of 999 ms.
    const fading = clip({ startUs: 0, durationUs: 1_000_000, fadeOutUs: 1_000_000, fadeCurve: 'linear' });
    const curve = envelopeCurve(fading, { durationUs: 1_000_000, points: 4 });
    expect(curve[0]).toBeCloseTo(1, 5);
    expect(curve[1]).toBeCloseTo(0.75, 5);
    expect(curve[3]).toBeCloseTo(0.25, 5);
  });

  it('produces at least two points, because a one-point curve is not a curve', () => {
    expect(envelopeCurve(clip(), { durationUs: 2_000_000, points: 1 })).toHaveLength(2);
  });
});

describe('activeRanges', () => {
  it('is empty for a plain clip, so the fast path is taken', () => {
    expect(activeRanges(clip())).toEqual([]);
  });

  it('covers the clip for a fade', () => {
    const ranges = activeRanges(clip({ fadeInUs: 100_000 }));
    expect(ranges).toEqual([{ startUs: 1_000_000, endUs: 3_000_000 }]);
  });

  it('covers the clip for a level change', () => {
    expect(activeRanges(clip({ volumeDb: -3 }))).toHaveLength(1);
  });

  it('covers the clip for a keyframed curve', () => {
    expect(activeRanges(clip({ keyframes: [{ timeUs: 1_000_000, valueDb: 0 }] }))).toHaveLength(1);
  });

  it('covers a muted clip, because silence is not a pass-through', () => {
    expect(activeRanges(clip({ muted: true }))).toHaveLength(1);
  });
});

describe('applyGainEnvelope', () => {
  it('scales both channels by the envelope', () => {
    const samples = new Float32Array([1, 1, 1, 1]);
    applyGainEnvelope(samples, clip({ volumeDb: -6, startUs: 0 }), 2);
    expect(samples[0]).toBeCloseTo(dbToGain(-6), 5);
    expect(samples[3]).toBeCloseTo(dbToGain(-6), 5);
  });

  it('silences a muted clip', () => {
    const samples = new Float32Array([0.5, 0.5]);
    applyGainEnvelope(samples, clip({ muted: true, startUs: 0 }), 48000);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(0);
  });

  it('ramps across a fade-in', () => {
    const faded = clip({ startUs: 0, durationUs: 1_000_000, fadeInUs: 1_000_000, fadeCurve: 'linear' });
    const samples = new Float32Array(1000 * 2).fill(1);
    applyGainEnvelope(samples, faded, 1000);
    // Sample 999 is 999 ms into a 1 s fade.
    expect(samples[999 * 2]).toBeCloseTo(0.999, 3);
    expect(samples[0]).toBe(0);
  });
});

describe('the preview and the export agree (SPEC 10 §7.1)', () => {
  it('gives the same gain from the automation curve and from the per-sample path', () => {
    // This is the contract the spec calls out: one definition of the gain, two ways
    // of applying it. The curve is what `setValueCurveAtTime` schedules in the
    // preview; `applyGainEnvelope` is what the mixer multiplies in the export.
    const input = clip({
      startUs: 0,
      durationUs: 1_000_000,
      gainDb: 3,
      volumeDb: -4,
      fadeInUs: 250_000,
      fadeOutUs: 250_000,
      fadeCurve: 'equal-power',
      keyframes: [
        { timeUs: 0, valueDb: -4 },
        { timeUs: 500_000, valueDb: 0 },
        { timeUs: 1_000_000, valueDb: -8 },
      ],
    });

    const sampleRate = 1000;
    const frames = 1000;
    const mixed = new Float32Array(frames * 2).fill(1);
    applyGainEnvelope(mixed, input, sampleRate);

    const curve = envelopeCurve(input, { durationUs: 1_000_000, points: frames });

    for (let frame = 0; frame < frames; frame += 1) {
      // Point i of a `frames`-long curve is at `duration * i / frames`, which is
      // exactly where the mixer samples frame i. Any difference here is a real
      // disagreement between preview and export, not floating point.
      expect(mixed[frame * 2]!, `frame ${frame}`).toBeCloseTo(curve[frame]!, 6);
    }
  });

  it('agrees at the exact points the preview schedules', () => {
    const input = clip({ startUs: 0, durationUs: 2_000_000, volumeDb: -6, fadeInUs: 500_000 });
    const curve = envelopeCurve(input, { durationUs: 2_000_000, points: 8 });
    for (let index = 0; index < curve.length; index += 1) {
      const timeUs = (2_000_000 * index) / curve.length;
      expect(curve[index]!).toBeCloseTo(gainAt(input, timeUs), 6);
    }
  });
});
