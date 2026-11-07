/**
 * SPEC 14 §3.5 — built-in quick presets.
 *
 * Data lives in `/assets/export-presets.json` so it can be edited without a code
 * change; this module validates it against the enums the planner accepts, so a
 * typo in the JSON fails loudly instead of silently producing a wrong export.
 */

import { ASPECT_RATIOS, AUDIO_BITRATES, EXPORT_FPS_OPTIONS, OUTPUT_FORMATS, QUALITY_PRESETS } from './presets.js';
import { EXPORT_PRESETS } from './presets.js';
import type { AspectRatio, AudioBitrate, ExportFps, ExportPresetId, OutputFormatId, QualityPresetId } from './presets.js';

/** The subset of export settings a quick preset fills in. */
export interface QuickPresetSettings {
  preset: ExportPresetId;
  aspect: AspectRatio;
  fps: ExportFps;
  format: OutputFormatId;
  quality: QualityPresetId;
  audioBitrate: AudioBitrate;
  includeAudio: boolean;
  burnCaptions: boolean;
  saveSubtitles: boolean;
  normaliseLoudness: boolean;
  targetLufs: number;
}

export interface QuickPreset {
  id: string;
  label: string;
  description: string;
  settings: QuickPresetSettings;
}

export interface QuickPresetFile {
  version: number;
  description?: string;
  presets: QuickPreset[];
}

/** Why a preset file was rejected, with the offending field named. */
export interface PresetValidationIssue {
  presetId: string;
  field: string;
  message: string;
}

/**
 * Validate a parsed preset file.
 *
 * Returns the accepted presets and every issue found. Unknown enum values are
 * rejected rather than coerced: a preset that silently became 720p would be
 * worse than one that refuses to load.
 */
export function validateQuickPresets(raw: unknown): {
  presets: QuickPreset[];
  issues: PresetValidationIssue[];
} {
  const issues: PresetValidationIssue[] = [];
  const presets: QuickPreset[] = [];
  const file = raw as Partial<QuickPresetFile> | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.presets)) {
    return { presets, issues: [{ presetId: '', field: 'presets', message: 'Preset file has no presets array.' }] };
  }

  const presetIds = new Set(EXPORT_PRESETS.map((preset) => preset.id));
  const qualities = new Set(QUALITY_PRESETS.map((quality) => quality.id));
  const formats = new Set(OUTPUT_FORMATS.map((format) => format.id));

  for (const [index, candidate] of file.presets.entries()) {
    const entry = candidate as Partial<QuickPreset> & { settings?: Record<string, unknown> };
    const id = typeof entry.id === 'string' && entry.id ? entry.id : '';
    const where = id || `presets[${index}]`;
    if (!id) issues.push({ presetId: where, field: 'id', message: 'Preset needs an id.' });
    if (typeof entry.label !== 'string' || !entry.label) {
      issues.push({ presetId: where, field: 'label', message: 'Preset needs a label.' });
    }
    const settings = entry.settings;
    if (!settings || typeof settings !== 'object') {
      issues.push({ presetId: where, field: 'settings', message: 'Preset needs settings.' });
      continue;
    }

    const resolved: Partial<QuickPresetSettings> = {};
    if (presetIds.has(settings.preset as ExportPresetId)) {
      resolved.preset = settings.preset as ExportPresetId;
    } else {
      issues.push({ presetId: where, field: 'settings.preset', message: `Unknown resolution preset "${String(settings.preset)}".` });
    }
    if (ASPECT_RATIOS.includes(settings.aspect as AspectRatio)) {
      resolved.aspect = settings.aspect as AspectRatio;
    } else {
      issues.push({ presetId: where, field: 'settings.aspect', message: `Unknown aspect ratio "${String(settings.aspect)}".` });
    }
    if (EXPORT_FPS_OPTIONS.includes(settings.fps as ExportFps)) {
      resolved.fps = settings.fps as ExportFps;
    } else {
      issues.push({ presetId: where, field: 'settings.fps', message: `Unsupported frame rate "${String(settings.fps)}".` });
    }
    if (formats.has(settings.format as OutputFormatId)) {
      resolved.format = settings.format as OutputFormatId;
    } else {
      issues.push({ presetId: where, field: 'settings.format', message: `Unknown format "${String(settings.format)}".` });
    }
    if (qualities.has(settings.quality as QualityPresetId)) {
      resolved.quality = settings.quality as QualityPresetId;
    } else {
      issues.push({ presetId: where, field: 'settings.quality', message: `Unknown quality preset "${String(settings.quality)}".` });
    }
    if (AUDIO_BITRATES.includes(settings.audioBitrate as AudioBitrate)) {
      resolved.audioBitrate = settings.audioBitrate as AudioBitrate;
    } else {
      issues.push({ presetId: where, field: 'settings.audioBitrate', message: `Unsupported audio bitrate "${String(settings.audioBitrate)}".` });
    }
    for (const flag of ['includeAudio', 'burnCaptions', 'saveSubtitles', 'normaliseLoudness'] as const) {
      if (typeof settings[flag] === 'boolean') {
        resolved[flag] = settings[flag] as boolean;
      } else {
        issues.push({ presetId: where, field: `settings.${flag}`, message: `${flag} must be true or false.` });
      }
    }
    if (typeof settings.targetLufs === 'number' && Number.isFinite(settings.targetLufs)) {
      resolved.targetLufs = settings.targetLufs;
    } else {
      issues.push({ presetId: where, field: 'settings.targetLufs', message: 'targetLufs must be a number.' });
    }

    if (issues.every((issue) => issue.presetId !== where)) {
      presets.push({
        id,
        label: entry.label as string,
        description: typeof entry.description === 'string' ? entry.description : '',
        settings: resolved as QuickPresetSettings,
      });
    }
  }

  return { presets, issues };
}

/**
 * The presets from §3.5, inline.
 *
 * This mirrors `assets/export-presets.json`; the file is the editable copy used
 * by the app, and this constant keeps the package usable without shipping the
 * asset. A test asserts the two agree.
 */
export const BUILT_IN_QUICK_PRESETS: QuickPreset[] = [
  {
    id: 'short-form-vertical',
    label: 'Short-form vertical',
    description: '1080×1920 at 30 fps, H.264 Standard quality.',
    settings: {
      preset: '1080p',
      aspect: '9:16',
      fps: 30,
      format: 'mp4',
      quality: 'standard',
      audioBitrate: 192,
      includeAudio: true,
      burnCaptions: true,
      saveSubtitles: false,
      normaliseLoudness: false,
      targetLufs: -16,
    },
  },
  {
    id: 'landscape-1080p',
    label: 'Landscape 1080p',
    description: '1920×1080 at 30 fps, H.264 Standard quality.',
    settings: {
      preset: '1080p',
      aspect: '16:9',
      fps: 30,
      format: 'mp4',
      quality: 'standard',
      audioBitrate: 192,
      includeAudio: true,
      burnCaptions: true,
      saveSubtitles: false,
      normaliseLoudness: false,
      targetLufs: -16,
    },
  },
  {
    id: 'high-quality-4k',
    label: 'High quality 4K',
    description: '4K UHD (3840×2160) at 30 fps, H.264 Maximum quality. Slow on most computers.',
    settings: {
      preset: '4k-uhd',
      aspect: '16:9',
      fps: 30,
      format: 'mp4',
      quality: 'maximum',
      audioBitrate: 256,
      includeAudio: true,
      burnCaptions: true,
      saveSubtitles: false,
      normaliseLoudness: false,
      targetLufs: -16,
    },
  },
  {
    id: 'small-file',
    label: 'Small file for sharing',
    description: '720p at 30 fps, Draft quality. Quick to make, quick to send.',
    settings: {
      preset: '720p',
      aspect: '16:9',
      fps: 30,
      format: 'mp4',
      quality: 'draft',
      audioBitrate: 128,
      includeAudio: true,
      burnCaptions: true,
      saveSubtitles: false,
      normaliseLoudness: false,
      targetLufs: -16,
    },
  },
  {
    id: 'square-1080',
    label: 'Square 1080',
    description: '1080×1080 at 30 fps, H.264 Standard quality.',
    settings: {
      preset: '1080p',
      aspect: '1:1',
      fps: 30,
      format: 'mp4',
      quality: 'standard',
      audioBitrate: 192,
      includeAudio: true,
      burnCaptions: true,
      saveSubtitles: false,
      normaliseLoudness: false,
      targetLufs: -16,
    },
  },
];

/** Look a preset up by id. */
export function findQuickPreset(id: string): QuickPreset | undefined {
  return BUILT_IN_QUICK_PRESETS.find((preset) => preset.id === id);
}

/**
 * Apply a preset on top of current settings, keeping fields the preset does not
 * own (range, draft flag, subtitles toggled by the user).
 */
export function applyQuickPreset<T extends Partial<QuickPresetSettings>>(
  current: T,
  preset: QuickPreset,
): T & QuickPresetSettings {
  return { ...current, ...preset.settings };
}
