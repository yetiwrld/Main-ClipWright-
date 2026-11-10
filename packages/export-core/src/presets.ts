/**
 * SPEC 14 §3.2 — Resolution presets (the short-side rule).
 *
 * Presets are defined by the short side of the output, so they apply to
 * every aspect ratio. The selected aspect ratio is always preserved.
 * Both sides are rounded to even numbers as H.264/AAC require.
 */

export const EXPORT_PRESETS = [
  { id: '720p', label: '720p', shortSide: 720 },
  { id: '1080p', label: '1080p', shortSide: 1080 },
  { id: 'dci-2k', label: 'DCI 2K', shortSide: 1152 },
  { id: 'qhd-1440p', label: 'QHD 1440p', shortSide: 1440 },
  { id: '4k-uhd', label: '4K UHD', shortSide: 2160 },
] as const;

export type ExportPresetId = (typeof EXPORT_PRESETS)[number]['id'];

/** Common aspect ratios as "width:height" strings. */
export const ASPECT_RATIOS = [
  '16:9',
  '9:16',
  '1:1',
  '4:5',
  '4:3',
  '21:9',
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Round a number to the nearest even integer (H.264/AAC requirement). */
export function roundEven(value: number): number {
  return Math.round(value / 2) * 2;
}

/** Parse an aspect ratio string "W:H" into a number. */
export function parseAspect(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  if (!w || !h) return 16 / 9;
  return w / h;
}

/**
 * Compute the output resolution from a preset short side and aspect ratio.
 * The short side is fixed; the long side is computed and both are rounded
 * to even numbers.
 */
export function computeResolution(
  presetShortSide: number,
  aspect: string,
): { width: number; height: number } {
  const ratio = parseAspect(aspect);
  const aspectRatio = ratio;
  // If the aspect is wider than tall (ratio > 1), width is the long side.
  // If the aspect is taller than wide (ratio < 1), height is the long side.
  if (aspectRatio >= 1) {
    const width = roundEven(presetShortSide * aspectRatio);
    const height = roundEven(presetShortSide);
    return { width, height };
  }
  const width = roundEven(presetShortSide);
  const height = roundEven(presetShortSide / aspectRatio);
  return { width, height };
}

/** Get the resolution for a preset ID and aspect ratio. */
export function resolutionForPreset(
  presetId: ExportPresetId,
  aspect: string,
): { width: number; height: number } {
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return computeResolution(1080, aspect);
  return computeResolution(preset.shortSide, aspect);
}

/**
 * Which of `ASPECT_RATIOS` a canvas is, or the nearest one.
 *
 * The export dialog starts from defaults, and its aspect decides the *output frame*. A dialog that
 * always starts at 9:16 exports a 16:9 composition letterboxed into a portrait file unless the user
 * notices the control — the composition they built and the file they got disagree, and neither side
 * complains.
 *
 * The canvas is the composition's own truth (SPEC 07 §9.1: canvas from the project's aspect ratio),
 * so the nearest ratio is the right starting point. Matching is by value, not by orientation: 9:16
 * and 16:9 are both "portrait" or "landscape" and telling them apart only by that would put a 4:3
 * composition into 16:9.
 *
 * Ties go to the earlier entry in `ASPECT_RATIOS`, which is stable and documented rather than
 * dependent on floating-point luck.
 */
/** The ratio as a reducible pair, or `null` when it is not one of `ASPECT_RATIOS`. */
export function exactAspectFromCanvas(width: number, height: number): string | null {
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = width / height;
  for (const candidate of ASPECT_RATIOS) {
    const [w, h] = candidate.split(':').map(Number);
    /* Within a thousandth: a canvas is integers, so 1350×1080 is exactly 5:4 but 1080×1350 is
       exactly 4:5 and rounding must not confuse them. */
    if (Math.abs(w / h - ratio) < 0.001) return candidate;
  }
  return null;
}

/**
 * Which of `ASPECT_RATIOS` a canvas is, or the nearest one.
 *
 * **Prefer `exactAspectFromCanvas` when the answer feeds an export.** This function always returns
 * a canonical ratio, so a 5:4 composition becomes 4:3 — a different picture, silently. It is right
 * for a *default* (a control that must show something) and wrong for a *decision* (the frame the
 * encoder is told to produce). A custom aspect has no representation in `ASPECT_RATIOS`, and
 * SPEC 14 §4.1's export path is sized from `preset × aspect` alone, so a custom project currently
 * exports at the nearest preset — recorded in `docs/limitations.md` §6 rather than papered over.
 */
export function aspectFromCanvas(width: number, height: number): AspectRatio {
  if (!(width > 0) || !(height > 0)) return '9:16';
  const target = width / height;
  let best: AspectRatio = ASPECT_RATIOS[0];
  let bestDistance = Infinity;
  for (const candidate of ASPECT_RATIOS) {
    const [w, h] = candidate.split(':').map(Number);
    const distance = Math.abs(w / h - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The nearest resolution preset for a canvas's shortest side.
 *
 * The preset names a short side (720p is 720 on the short edge), which is why the *shortest* side is
 * the input rather than the width: a 1080×1920 portrait canvas and a 1920×1080 one are both 1080p.
 * Nearest rather than exact, because a canvas can be any size — a custom aspect at 900×1600 should
 * offer 720p or 1080p rather than nothing.
 *
 * Ties go to the smaller preset: exporting a canvas one pixel over 1080 at 1440 would upscale it,
 * and quietly upscaling is the least useful thing an export control can do.
 */
export function presetForShortSide(shortSide: number): ExportPresetId {
  if (!(shortSide > 0)) return '1080p';
  let best: ExportPresetId = EXPORT_PRESETS[0].id;
  let bestDistance = Infinity;
  for (const preset of EXPORT_PRESETS) {
    const distance = Math.abs(preset.shortSide - shortSide);
    if (distance < bestDistance) {
      best = preset.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** Quality presets mapping to encoder settings. */
export const QUALITY_PRESETS = [
  { id: 'draft', label: 'Draft', x264Crf: 26, x264Preset: 'veryfast', vp9Crf: 38 },
  { id: 'standard', label: 'Standard', x264Crf: 22, x264Preset: 'fast', vp9Crf: 33 },
  { id: 'high', label: 'High', x264Crf: 19, x264Preset: 'medium', vp9Crf: 30 },
  { id: 'maximum', label: 'Maximum', x264Crf: 16, x264Preset: 'slow', vp9Crf: 27 },
] as const;

export type QualityPresetId = (typeof QUALITY_PRESETS)[number]['id'];

/** Output formats. */
export const OUTPUT_FORMATS = [
  { id: 'mp4', label: 'MP4', videoCodec: 'h264', audioCodec: 'aac' },
  { id: 'webm', label: 'WebM', videoCodec: 'vp9', audioCodec: 'opus' },
] as const;

export type OutputFormatId = (typeof OUTPUT_FORMATS)[number]['id'];

/** Export fps options. */
export const EXPORT_FPS_OPTIONS = [30, 60] as const;

export type ExportFps = (typeof EXPORT_FPS_OPTIONS)[number];

/** Audio bitrate options (kbps). */
export const AUDIO_BITRATES = [96, 128, 160, 192, 256, 320] as const;

export type AudioBitrate = (typeof AUDIO_BITRATES)[number];

/** Default audio bitrate. */
export const DEFAULT_AUDIO_BITRATE: AudioBitrate = 192;

/** Rate control modes. */
export const RATE_CONTROL_MODES = ['vbr', 'cbr'] as const;
export type RateControlMode = (typeof RATE_CONTROL_MODES)[number];

/** Export range options. */
export const EXPORT_RANGE_OPTIONS = [
  'whole',
  'work-area',
  'selected',
  'batch',
] as const;
export type ExportRange = (typeof EXPORT_RANGE_OPTIONS)[number];
