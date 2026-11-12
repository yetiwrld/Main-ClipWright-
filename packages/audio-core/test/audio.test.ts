import { describe, expect, it } from 'vitest';
import { buildPeaks, detectSilences, duckingEnvelope, estimateIntegratedLufs, fadeGain, gainToTargetLufs, rmsWindows, serializePeaks } from '../src/index.js';

const sine = (freq: number, seconds: number, rate = 16000, amp = 0.5): Float32Array => {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};

describe('peaks', () => {
  it('builds both resolutions with min/max pairs', () => {
    const s = sine(440, 1);
    const p = buildPeaks(s, 16000);
    expect(p.peaks256.length).toBe(Math.ceil(s.length / 256) * 2);
    expect(p.peaks4096.length).toBe(Math.ceil(s.length / 4096) * 2);
    for (let i = 0; i < p.peaks256.length; i += 2) expect(p.peaks256[i]!).toBeLessThanOrEqual(p.peaks256[i + 1]!);
  });

  it('serialises with the CWPK1 magic', () => {
    const bytes = serializePeaks(buildPeaks(sine(440, 0.2), 16000));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('CWPK1');
  });
});

describe('rms windows & silence', () => {
  it('finds windows covering the signal', () => {
    const s = sine(440, 1);
    const w = rmsWindows(s, 16000, 250);
    expect(w.length).toBe(4);
    expect(w[0]!.rms).toBeGreaterThan(0.3);
  });

  it('detects a silent gap in an otherwise loud file', () => {
    const rate = 16000;
    const loud1 = sine(440, 1, rate);
    const silence = new Float32Array(rate); // 1s of zeros
    const loud2 = sine(440, 1, rate);
    const s = new Float32Array(loud1.length + silence.length + loud2.length);
    s.set(loud1, 0); s.set(silence, loud1.length); s.set(loud2, loud1.length + silence.length);
    const ranges = detectSilences(s, rate, { thresholdDbfs: -45, minUs: 500_000 });
    expect(ranges.length).toBe(1);
    expect(ranges[0]!.startUs).toBeGreaterThanOrEqual(900_000);
    expect(ranges[0]!.endUs).toBeGreaterThanOrEqual(1_900_000);
  });
});

describe('loudness', () => {
  it('full-scale sine is around -3 to -4 LUFS (with -0.691 offset)', () => {
    const s = sine(1000, 0.5, 16000, 1.0);
    const l = estimateIntegratedLufs(s);
    expect(l).toBeGreaterThan(-5);
    expect(l).toBeLessThan(-2);
  });

  it('gainToTargetLufs boosts quiet audio and caps boost', () => {
    expect(gainToTargetLufs(-30, -16).gainDb).toBe(14);
    expect(gainToTargetLufs(-50, -16).gainDb).toBe(20);
    expect(gainToTargetLufs(-50, -16).limited).toBe(true);
  });
});

describe('fades & ducking', () => {
  it('fadeGain is 0 at start (in) and 0 at end (out)', () => {
    expect(fadeGain(0, 'in')).toBe(0);
    expect(fadeGain(1, 'in')).toBeCloseTo(1, 5);
    expect(fadeGain(0, 'out')).toBeCloseTo(1, 5);
    expect(fadeGain(1, 'out')).toBe(0);
  });

  it('duckingEnvelope lowers gain when voice is loud', () => {
    const env = duckingEnvelope([0.01, 0.01, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(env[env.length - 1]!).toBeLessThan(env[0]!);
    expect(Math.min(...env)).toBeGreaterThanOrEqual(0.2 - 1e-6);
  });
});
