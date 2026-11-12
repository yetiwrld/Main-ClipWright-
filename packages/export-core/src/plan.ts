/**
 * Export planner. Pure. The resolution table is the product contract:
 * presets are defined by the SHORT SIDE; the aspect is preserved;
 * both sides are rounded to EVEN numbers.
 */
import type { Fps } from '@clipwright/project-schema';

export type AspectId = '9:16' | '16:9' | '1:1' | '4:5' | '4:3' | '21:9' | 'original' | string;
export type PresetId = '720p' | '1080p' | 'dci-2k' | 'qhd-1440p' | '4k-uhd';

export const PRESET_SHORT_SIDE: Record<PresetId, number> = {
  '720p': 720,
  '1080p': 1080,
  'dci-2k': 1152,
  'qhd-1440p': 1440,
  '4k-uhd': 2160,
};

/** Contract: round to the nearest even integer (ties away from zero). */
export const even = (n: number): number => {
  const r = Math.round(n);
  if (r % 2 === 0) return r;
  return n >= r ? r + 1 : r - 1;
};

/** aspect ratio as w/h from a label like "9:16" or original dims. */
export const aspectValue = (aspect: AspectId, original?: { width: number; height: number }): number => {
  switch (aspect) {
    case '9:16': return 9 / 16;
    case '16:9': return 16 / 9;
    case '1:1': return 1;
    case '4:5': return 4 / 5;
    case '4:3': return 4 / 3;
    case '21:9': return 21 / 9;
    case 'original':
      if (!original || original.height === 0) return 16 / 9;
      return original.width / original.height;
    default: {
      const m = /^(\d{1,2}):(\d{1,2})$/.exec(aspect);
      if (!m) return 16 / 9;
      return Number(m[1]) / Number(m[2]);
    }
  }
};

export interface OutputSize { width: number; height: number; }

/** Compute output dimensions from short side + aspect (contract in Section 19.2). */
export const computeOutputSize = (
  shortSide: number, aspect: AspectId, original?: { width: number; height: number },
): OutputSize => {
  const a = aspectValue(aspect, original); // w/h
  if (a >= 1) {
    // landscape/square: width is long side
    const width = even(shortSide * a);
    return { width, height: even(shortSide) };
  }
  const height = even(shortSide / a);
  return { width: even(shortSide), height };
};

/** The full contract matrix — unit-tested. */
export const presetTable = (): Record<PresetId, Record<string, OutputSize>> => {
  const aspects: AspectId[] = ['16:9', '9:16', '1:1', '4:5', '4:3', '21:9'];
  const out = {} as Record<PresetId, Record<string, OutputSize>>;
  for (const p of Object.keys(PRESET_SHORT_SIDE) as PresetId[]) {
    out[p] = {};
    for (const a of aspects) out[p][a] = computeOutputSize(PRESET_SHORT_SIDE[p], a);
  }
  return out;
};

export type QualityId = 'draft' | 'standard' | 'high' | 'maximum';
export const H264_CRF: Record<QualityId, number> = { draft: 26, standard: 22, high: 19, maximum: 16 };
export const H264_PRESET: Record<QualityId, string> = { draft: 'veryfast', standard: 'fast', high: 'medium', maximum: 'slow' };
export const VP9_CRF: Record<QualityId, number> = { draft: 38, standard: 33, high: 30, maximum: 27 };

/** Bitrate lookup (Mbps) for resolution × fps — used for hardware encoders. */
export const estimateBitrateMbps = (width: number, height: number, fps: Fps, quality: QualityId): number => {
  const pixels = width * height;
  const base1080p30 = 8;
  const scale = pixels / (1920 * 1080);
  const fpsScale = fps === 60 ? 1.5 : 1;
  const qScale = quality === 'draft' ? 0.6 : quality === 'standard' ? 1 : quality === 'high' ? 1.8 : 3.2;
  return Math.round(base1080p30 * scale * fpsScale * qScale * 10) / 10;
};

export const estimateFileSizeBytes = (bitrateMbps: number, audioKbps: number, durationSeconds: number): number =>
  Math.round(((bitrateMbps * 1_000_000 + audioKbps * 1_000) / 8) * durationSeconds);

export type ExportFormat = 'mp4' | 'webm';
export interface ExportPlanSettings {
  preset: PresetId | 'custom';
  customSize?: OutputSize;
  aspect: AspectId;
  fps: Fps | 'match';
  format: ExportFormat;
  quality: QualityId;
  audioBitrateKbps: number;
  loudnessTargetLufs: number | null;
  burnCaptions: boolean;
  subtitleSidecar: boolean;
  draft: boolean;
}

export interface ExportPlan {
  settings: ExportPlanSettings;
  output: OutputSize;
  fps: Fps;
  durationFrames: number;
  durationSeconds: number;
  estimatedBytes: number;
  summary: string;
}

export const buildExportPlan = (
  comp: { fps: number; durationUs: number },
  settings: ExportPlanSettings,
  outputFpsFallback: Fps = 30,
): ExportPlan => {
  const fps: Fps = settings.fps === 'match' ? (comp.fps >= 60 ? 60 : 30) : settings.fps;
  const shortSide = settings.preset === 'custom'
    ? Math.min(settings.customSize?.width ?? 1080, settings.customSize?.height ?? 1080)
    : PRESET_SHORT_SIDE[settings.preset];
  const output = settings.preset === 'custom' && settings.customSize
    ? { width: even(settings.customSize.width), height: even(settings.customSize.height) }
    : computeOutputSize(shortSide, settings.aspect);
  const durationSeconds = Math.max(0.1, comp.durationUs / 1_000_000);
  const durationFrames = Math.round(durationSeconds * fps);
  const videoMbps = estimateBitrateMbps(output.width, output.height, fps, settings.quality);
  const estimatedBytes = estimateFileSizeBytes(videoMbps, settings.audioBitrateKbps, durationSeconds);
  const codec = settings.format === 'mp4' ? 'H.264 · High · yuv420p' : 'VP9';
  const audio = settings.format === 'mp4' ? `AAC ${settings.audioBitrateKbps} kbps` : 'Opus';
  const summary = `${output.width}×${output.height} · ${fps} fps · ${codec} · ${audio} · ≈ ${(estimatedBytes / 1_000_000).toFixed(0)} MB`;
  return { settings, output, fps, durationFrames, durationSeconds, estimatedBytes, summary };
};
