/**
 * SPEC 14 §2-§4 — Export plan types and planner.
 *
 * The ExportPlanner takes a composition snapshot and export settings and
 * produces an ExportPlan describing what frames need to be rendered, which
 * items are active, the audio graph, and the output parameters.
 */

import type { ExportPresetId, OutputFormatId, QualityPresetId, RateControlMode, AudioBitrate, ExportFps } from './presets.js';
import { computeResolution } from './presets.js';

/** A single item in the export plan. */
export interface PlannedItem {
  itemId: string;
  trackId: string;
  type: string;
  mediaId?: string;
  /** Timeline start time in microseconds. */
  startUs: number;
  /** Timeline duration in microseconds. */
  durationUs: number;
  /** Source in-point in microseconds. */
  sourceInUs: number;
  /** Source duration in microseconds. */
  sourceDurationUs: number;
  /** Whether this item is active (visible/audible) at any point. */
  active: boolean;
  /** Whether this item has audio. */
  hasAudio: boolean;
}

/** Export plan describing the full render. */
export interface ExportPlan {
  /** Unique plan ID. */
  id: string;
  /** Composition ID. */
  compositionId: string;
  /** Project ID. */
  projectId: string;
  /** Output resolution. */
  width: number;
  height: number;
  /** Output frame rate. */
  fps: ExportFps;
  /** Output format. */
  format: OutputFormatId;
  /** Video codec. */
  videoCodec: string;
  /** Audio codec. */
  audioCodec: string;
  /** Quality preset. */
  quality: QualityPresetId;
  /** x264 CRF value. */
  crf: number;
  /** x264 preset. */
  preset: string;
  /** VP9 CRF value. */
  vp9Crf: number;
  /** Rate control mode. */
  rateControl: RateControlMode;
  /** Video bitrate in Mbps (for CBR/VBR modes). */
  videoBitrate?: number;
  /** Max bitrate in Mbps. */
  maxBitrate?: number;
  /** Audio bitrate in kbps. */
  audioBitrate: AudioBitrate;
  /** Total number of frames to render. */
  totalFrames: number;
  /** Duration in microseconds. */
  durationUs: number;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Planned items. */
  items: PlannedItem[];
  /** Whether audio is included. */
  includeAudio: boolean;
  /** Whether captions are burned in. */
  burnCaptions: boolean;
  /** Whether to also save subtitle files. */
  saveSubtitles: boolean;
  /** Subtitle formats to save. */
  subtitleFormats: ('srt' | 'vtt')[];
  /** Whether to embed project name in metadata. */
  embedProjectName: boolean;
  /** Whether to normalise loudness. */
  normaliseLoudness: boolean;
  /** Target loudness in LUFS (if normalising). */
  targetLufs: number;
  /** Whether this is a draft export. */
  isDraft: boolean;
}

/** Export settings input to the planner. */
export interface ExportSettings {
  compositionId: string;
  projectId: string;
  preset: ExportPresetId;
  aspect: string;
  fps: ExportFps;
  format: OutputFormatId;
  quality: QualityPresetId;
  rateControl: RateControlMode;
  videoBitrate?: number;
  maxBitrate?: number;
  audioBitrate: AudioBitrate;
  includeAudio: boolean;
  burnCaptions: boolean;
  saveSubtitles: boolean;
  subtitleFormats: ('srt' | 'vtt')[];
  embedProjectName: boolean;
  normaliseLoudness: boolean;
  targetLufs: number;
  isDraft: boolean;
  /** Timeline range to export: [startUs, endUs]. */
  rangeUs: [number, number];
  /** Composition fps for re-sampling checks. */
  compositionFps: number;
  /** Composition duration in microseconds. */
  compositionDurationUs: number;
  /** Composition items. */
  items: Array<{
    id: string;
    trackId: string;
    type: string;
    mediaId?: string;
    startUs: number;
    durationUs: number;
    sourceInUs: number;
    sourceDurationUs?: number;
    disabled: boolean;
    muted: boolean;
    hasAudio: boolean;
  }>;
}

/**
 * Build an ExportPlan from the settings and composition snapshot.
 * The planner is deterministic: the same inputs always produce the same plan.
 */
export function buildExportPlan(settings: ExportSettings): ExportPlan {
  const { width, height } = computeResolution(
    EXPORT_PRESETS_LOOKUP[settings.preset],
    settings.aspect,
  );

  const [rangeStartUs, rangeEndUs] = settings.rangeUs;
  const rangeDurationUs = rangeEndUs - rangeStartUs;
  const fps = settings.fps;
  const durationSeconds = rangeDurationUs / 1_000_000;
  const totalFrames = Math.round(durationSeconds * fps);

  // Determine which items are active within the export range.
  const items: PlannedItem[] = settings.items
    .filter((item) => !item.disabled)
    .map((item) => {
      const itemEndUs = item.startUs + item.durationUs;
      const overlaps = itemEndUs > rangeStartUs && item.startUs < rangeEndUs;
      const hasAudio = item.hasAudio && !item.muted;
      return {
        itemId: item.id,
        trackId: item.trackId,
        type: item.type,
        mediaId: item.mediaId,
        startUs: Math.max(item.startUs, rangeStartUs),
        durationUs: Math.min(itemEndUs, rangeEndUs) - Math.max(item.startUs, rangeStartUs),
        sourceInUs: item.sourceInUs,
        sourceDurationUs: item.sourceDurationUs ?? item.durationUs,
        active: overlaps,
        hasAudio,
      };
    })
    .filter((item) => item.active);

  // Quality settings lookup.
  const quality = QUALITY_PRESETS_LOOKUP[settings.quality];

  return {
    id: `plan-${settings.compositionId}-${Date.now()}`,
    compositionId: settings.compositionId,
    projectId: settings.projectId,
    width,
    height,
    fps,
    format: settings.format,
    videoCodec: FORMAT_LOOKUP[settings.format].videoCodec,
    audioCodec: FORMAT_LOOKUP[settings.format].audioCodec,
    quality: settings.quality,
    crf: quality.x264Crf,
    preset: quality.x264Preset,
    vp9Crf: quality.vp9Crf,
    rateControl: settings.rateControl,
    videoBitrate: settings.videoBitrate,
    maxBitrate: settings.maxBitrate,
    audioBitrate: settings.audioBitrate,
    totalFrames,
    durationUs: rangeDurationUs,
    durationSeconds,
    items,
    includeAudio: settings.includeAudio,
    burnCaptions: settings.burnCaptions,
    saveSubtitles: settings.saveSubtitles,
    subtitleFormats: settings.subtitleFormats,
    embedProjectName: settings.embedProjectName,
    normaliseLoudness: settings.normaliseLoudness,
    targetLufs: settings.targetLufs,
    isDraft: settings.isDraft,
  };
}

// Lookup tables (kept local to avoid circular imports with presets.ts).
const EXPORT_PRESETS_LOOKUP: Record<ExportPresetId, number> = {
  '720p': 720,
  '1080p': 1080,
  'dci-2k': 1152,
  'qhd-1440p': 1440,
  '4k-uhd': 2160,
};

const QUALITY_PRESETS_LOOKUP: Record<QualityPresetId, { x264Crf: number; x264Preset: string; vp9Crf: number }> = {
  draft: { x264Crf: 26, x264Preset: 'veryfast', vp9Crf: 38 },
  standard: { x264Crf: 22, x264Preset: 'fast', vp9Crf: 33 },
  high: { x264Crf: 19, x264Preset: 'medium', vp9Crf: 30 },
  maximum: { x264Crf: 16, x264Preset: 'slow', vp9Crf: 27 },
};

const FORMAT_LOOKUP: Record<OutputFormatId, { videoCodec: string; audioCodec: string }> = {
  mp4: { videoCodec: 'h264', audioCodec: 'aac' },
  webm: { videoCodec: 'vp9', audioCodec: 'opus' },
};
