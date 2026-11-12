/**
 * Audio analysis primitives on mono Float32 PCM samples.
 * Used for waveform peaks, silence detection and moments energy features.
 */

/** Two resolutions: 256 and 4096 samples per peak (see docs/formats.md). */
export const PEAK_RESOLUTIONS = [256, 4096] as const;

export interface PeaksFile {
  version: 1;
  sampleRate: number;
  totalSamples: number;
  /** interleaved min/max pairs, low then high resolution */
  peaks256: Float32Array;
  peaks4096: Float32Array;
}

const peakPairs = (samples: Float32Array, samplesPerPeak: number): Float32Array => {
  const count = Math.ceil(samples.length / samplesPerPeak);
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(samples.length, start + samplesPerPeak);
    let min = 0; let max = 0; let first = true;
    for (let j = start; j < end; j++) {
      const v = samples[j]!;
      if (first) { min = v; max = v; first = false; } else { if (v < min) min = v; if (v > max) max = v; }
    }
    out[i * 2] = min;
    out[i * 2 + 1] = max;
  }
  return out;
};

export const buildPeaks = (samples: Float32Array, sampleRate: number): PeaksFile => ({
  version: 1,
  sampleRate,
  totalSamples: samples.length,
  peaks256: peakPairs(samples, 256),
  peaks4096: peakPairs(samples, 4096),
});

/** Serialize peaks to the .peaks.bin format (magic + header + float32 LE payloads). */
export const serializePeaks = (p: PeaksFile): Uint8Array => {
  const magic = new TextEncoder().encode('CWPK1\n');
  const header = new TextEncoder().encode(
    JSON.stringify({ v: 1, sampleRate: p.sampleRate, totalSamples: p.totalSamples, p256: p.peaks256.length, p4096: p.peaks4096.length }) + '\n',
  );
  const body = new Uint8Array(p.peaks256.byteLength + p.peaks4096.byteLength);
  body.set(new Uint8Array(p.peaks256.buffer), 0);
  body.set(new Uint8Array(p.peaks4096.buffer), p.peaks256.byteLength);
  const out = new Uint8Array(magic.length + header.length + body.length);
  out.set(magic, 0); out.set(header, magic.length); out.set(body, magic.length + header.length);
  return out;
};

export interface RmsWindow { startUs: number; endUs: number; rms: number; peak: number; }

/** RMS + peak in fixed windows (default 250 ms). */
export const rmsWindows = (samples: Float32Array, sampleRate: number, windowMs = 250): RmsWindow[] => {
  const win = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const out: RmsWindow[] = [];
  for (let start = 0; start < samples.length; start += win) {
    const end = Math.min(samples.length, start + win);
    let sumSq = 0; let peak = 0;
    for (let i = start; i < end; i++) { const v = samples[i]!; sumSq += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    out.push({
      startUs: Math.round((start / sampleRate) * 1_000_000),
      endUs: Math.round((end / sampleRate) * 1_000_000),
      rms: Math.sqrt(sumSq / Math.max(1, end - start)),
      peak,
    });
  }
  return out;
};

export interface SilenceRange { startUs: number; endUs: number; }

/** Ranges where RMS stays below thresholdDbfs (default -45) for at least minUs. */
export const detectSilences = (
  samples: Float32Array, sampleRate: number,
  opts: { thresholdDbfs?: number; minUs?: number; windowMs?: number } = {},
): SilenceRange[] => {
  const threshold = Math.pow(10, (opts.thresholdDbfs ?? -45) / 20);
  const minUs = opts.minUs ?? 400_000;
  const windows = rmsWindows(samples, sampleRate, opts.windowMs ?? 100);
  const ranges: SilenceRange[] = [];
  let runStart: number | null = null;
  for (const w of windows) {
    if (w.rms < threshold) {
      if (runStart === null) runStart = w.startUs;
    } else if (runStart !== null) {
      if (w.startUs - runStart >= minUs) ranges.push({ startUs: runStart, endUs: w.startUs });
      runStart = null;
    }
  }
  if (runStart !== null) {
    const endUs = windows.length ? windows[windows.length - 1]!.endUs : 0;
    if (endUs - runStart >= minUs) ranges.push({ startUs: runStart, endUs });
  }
  return ranges;
};

/**
 * Integrated loudness approximation in LUFS (K-weighting omitted; documented
 * as an approximation). Good enough for relative metering and tests.
 */
export const estimateIntegratedLufs = (samples: Float32Array): number => {
  if (samples.length === 0) return -Infinity;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i]! * samples[i]!;
  const meanSquare = sumSq / samples.length;
  if (meanSquare === 0) return -Infinity;
  return 10 * Math.log10(meanSquare) - 0.691;
};

/** Gain needed to hit a target LUFS, capped so peaks don't exceed -1 dBTP. */
export const gainToTargetLufs = (currentLufs: number, targetLufs = -16): { gainDb: number; limited: boolean } => {
  if (!Number.isFinite(currentLufs)) return { gainDb: 0, limited: false };
  const needed = targetLufs - currentLufs;
  const maxBoost = 20;
  const gainDb = Math.min(maxBoost, needed);
  return { gainDb, limited: needed > maxBoost };
};

/** Cosine-shaped fade curve, gain in [0,1] at position t (0..1). */
export const fadeGain = (t: number, kind: 'in' | 'out'): number => {
  const x = Math.min(1, Math.max(0, t));
  const c = 0.5 - 0.5 * Math.cos(Math.PI * (kind === 'in' ? x : 1 - x));
  return c;
};

/** Simple sidechain ducking envelope: returns music gain per window (0..1). */
export const duckingEnvelope = (
  voiceRms: number[], opts: { threshold?: number; floor?: number; attack?: number; release?: number } = {},
): number[] => {
  const threshold = opts.threshold ?? 0.08;
  const floor = opts.floor ?? 0.25;
  const attack = opts.attack ?? 0.25;
  const release = opts.release ?? 0.12;
  const out: number[] = [];
  let gain = 1;
  for (const v of voiceRms) {
    const target = v > threshold ? floor : 1;
    const rate = target < gain ? attack : release;
    gain = gain + (target - gain) * rate;
    out.push(Math.round(gain * 1000) / 1000);
  }
  return out;
};
