/**
 * SPEC 14 §3.4 / §4.1 — ffmpeg encoder argument construction.
 *
 * Pure functions: given an `ExportPlan` and the paths involved, produce the
 * exact ffmpeg argument vector. No I/O here, so every rule in the codec table
 * is unit-testable without an encoder.
 *
 * The encoder reads raw frames from stdin (`-f rawvideo -pix_fmt yuv420p`) and
 * audio from a pre-rendered WAV (SPEC 14 §5.2 default route: a temp WAV avoids
 * pipe deadlocks). Output is written to a `.partial.<ext>` temp file that the
 * orchestrator renames only after validation passes (§2.6, §7).
 */

import type { ExportPlan } from './planner.js';

/** Hardware encoder families we can validate at runtime (SPEC 14 §3.4). */
export type HardwareEncoderId = 'nvenc' | 'qsv' | 'amf' | 'videotoolbox';

/** Which video encoder actually produces the file. */
export interface VideoEncoderChoice {
  /** `software` means the bundled libx264 / libvpx-vp9. */
  kind: 'software' | 'hardware';
  /** ffmpeg `-c:v` value, e.g. `libx264`, `h264_nvenc`. */
  codec: string;
  /** Human label for the export dialog summary (SPEC 14 §3.4). */
  label: string;
  /** Hardware family, when `kind === 'hardware'`. */
  hardware?: HardwareEncoderId;
}

export const SOFTWARE_H264: VideoEncoderChoice = {
  kind: 'software',
  codec: 'libx264',
  label: 'H.264 · libx264',
};

export const SOFTWARE_VP9: VideoEncoderChoice = {
  kind: 'software',
  codec: 'libvpx-vp9',
  label: 'VP9 · libvpx-vp9',
};

/** Map a detected hardware family to its ffmpeg encoder name + label. */
export const HARDWARE_ENCODERS: Record<HardwareEncoderId, VideoEncoderChoice> = {
  nvenc: { kind: 'hardware', codec: 'h264_nvenc', label: 'H.264 · NVIDIA NVENC', hardware: 'nvenc' },
  qsv: { kind: 'hardware', codec: 'h264_qsv', label: 'H.264 · Intel Quick Sync', hardware: 'qsv' },
  amf: { kind: 'hardware', codec: 'h264_amf', label: 'H.264 · AMD AMF', hardware: 'amf' },
  videotoolbox: { kind: 'hardware', codec: 'h264_videotoolbox', label: 'H.264 · Apple VideoToolbox', hardware: 'videotoolbox' },
};

/**
 * Choose the video encoder for a plan (SPEC 14 §3.4 "Auto").
 *
 * WebM only has the software VP9 path in the bundled build. For MP4 we take the
 * first validated hardware encoder unless the user forced CPU.
 */
export function chooseVideoEncoder(
  plan: ExportPlan,
  options: { validatedHardware?: HardwareEncoderId | null; forceCpu?: boolean } = {},
): VideoEncoderChoice {
  if (plan.format === 'webm') return SOFTWARE_VP9;
  if (options.forceCpu) return SOFTWARE_H264;
  const hardware = options.validatedHardware;
  if (hardware && HARDWARE_ENCODERS[hardware]) return HARDWARE_ENCODERS[hardware];
  return SOFTWARE_H264;
}

/**
 * Capabilities of the installed ffmpeg build.
 *
 * Option names move between releases: `-fps_mode` replaced `-vsync` in ffmpeg
 * 5.0, and the bundled build may be older than the one on PATH. Rather than
 * assume, the orchestrator probes the binary once and passes what it found.
 */
export interface EncoderCapabilities {
  /** `true` → `-fps_mode cfr`; `false` → the legacy `-vsync cfr`. */
  fpsMode: boolean;
}

/** Conservative default for an unknown build: the spelling that exists everywhere. */
export const DEFAULT_CAPABILITIES: EncoderCapabilities = { fpsMode: false };

/** Detect capabilities from `ffmpeg -h full` output. */
export function detectCapabilities(helpText: string): EncoderCapabilities {
  return { fpsMode: /\bfps_mode\b/.test(helpText) };
}

/**
 * The constant-frame-rate flag, spelled for this build.
 *
 * Both spellings do the same job (SPEC 14 §3.3 wants a constant grid, not
 * motion interpolation); we only pick the name the binary understands.
 */
export function cfrArgs(fps: number | string, capabilities: EncoderCapabilities): string[] {
  return capabilities.fpsMode
    ? ['-r', String(fps), '-fps_mode', 'cfr']
    : ['-r', String(fps), '-vsync', 'cfr'];
}

/** Container extension and muxer flags per output format. */
export function containerFor(plan: ExportPlan): { extension: string; movFlags?: string } {
  return plan.format === 'webm' ? { extension: 'webm' } : { extension: 'mp4', movFlags: '+faststart' };
}

/**
 * Video quality arguments.
 *
 * SPEC 14 §3.4: CRF for libx264/libvpx-vp9; hardware encoders get constant
 * quality (`-cq`/`-global_quality`) where supported, otherwise a bitrate target
 * derived from the plan. Custom bitrate mode overrides the quality preset.
 */
export function videoQualityArgs(plan: ExportPlan, encoder: VideoEncoderChoice): string[] {
  // Custom bitrate mode wins over the quality preset (SPEC 14 §3.4).
  if (plan.videoBitrate && plan.videoBitrate > 0) {
    const bitrate = `${Math.round(plan.videoBitrate * 1000)}k`;
    if (encoder.codec === 'libvpx-vp9') {
      // VP9 needs an explicit zero CRF to honour a target bitrate.
      const args = ['-b:v', bitrate, '-crf', '0'];
      if (plan.rateControl === 'cbr') args.push('-minrate', bitrate, '-maxrate', bitrate);
      if (plan.maxBitrate) args.push('-maxrate', `${Math.round(plan.maxBitrate * 1000)}k`);
      return args;
    }
    if (encoder.kind === 'hardware') {
      return plan.rateControl === 'cbr'
        ? ['-b:v', bitrate, '-minrate', bitrate, '-maxrate', bitrate]
        : ['-b:v', bitrate];
    }
    const args = ['-b:v', bitrate, '-maxrate', `${Math.round(plan.videoBitrate * 1.5 * 1000)}k`];
    if (plan.rateControl === 'cbr') args.push('-minrate', bitrate, '-bufsize', `${Math.round(plan.videoBitrate * 1000)}k`);
    else args.push('-bufsize', `${Math.round(plan.videoBitrate * 2 * 1000)}k`);
    if (plan.maxBitrate) args.push('-maxrate', `${Math.round(plan.maxBitrate * 1000)}k`);
    return args;
  }

  // Quality-preset path.
  if (encoder.codec === 'libvpx-vp9') {
    return ['-crf', String(plan.vp9Crf), '-b:v', '0', '-row-mt', '1'];
  }
  if (encoder.codec === 'libx264') {
    return ['-crf', String(plan.crf), '-preset', plan.preset];
  }
  // Hardware constant quality; the query parameter differs per vendor.
  const cq = hardwareQualityValue(plan.crf, encoder.hardware);
  switch (encoder.hardware) {
    case 'nvenc':
      return ['-rc', 'constqp', '-qp', String(cq), '-preset', 'p5'];
    case 'qsv':
      return ['-global_quality', String(cq), '-preset', 'fast'];
    case 'amf':
      return ['-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq)];
    case 'videotoolbox':
      return ['-q:v', String(cq)];
    default:
      return ['-crf', String(plan.crf)];
  }
}

/**
 * Map an x264 CRF onto a hardware constant-quality value.
 *
 * Hardware scales are coarser and vendor-specific; these are documented
 * approximations (SPEC 14 §3.4 requires documented equivalents) chosen so the
 * visual result tracks the CRF ladder rather than pretending to be identical.
 */
export function hardwareQualityValue(crf: number, hardware?: HardwareEncoderId): number {
  switch (hardware) {
    case 'nvenc':
    case 'qsv':
    case 'amf':
      // NVENC/QSV/AMF quality scales run 0–51 like x264 QP.
      return Math.round(crf);
    case 'videotoolbox':
      // VideoToolbox q:v runs 1–100, higher is better: invert the CRF ladder.
      return Math.round(100 - (crf / 51) * 100);
    default:
      return Math.round(crf);
  }
}

/** Colour tagging: SDR BT.709 limited range, required by SPEC 14 §3.4. */
export const COLOUR_ARGS = [
  '-colorspace', 'bt709',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-color_range', 'tv',
];

/** Audio codec arguments per container. */
export function audioArgs(plan: ExportPlan): string[] {
  const bitrate = `${plan.audioBitrate}k`;
  if (!plan.includeAudio) return ['-an'];
  if (plan.format === 'webm') {
    return ['-c:a', 'libopus', '-b:a', bitrate, '-ar', '48000', '-ac', '2'];
  }
  return ['-c:a', 'aac', '-b:a', bitrate, '-ar', '48000', '-ac', '2', '-profile:a', 'aac_low'];
}

/** Metadata arguments (SPEC 14 §3.4: title, embed project name, strip source metadata). */
export function metadataArgs(plan: ExportPlan, title: string): string[] {
  const args = ['-map_metadata', '-1', '-metadata', `title=${title}`];
  if (plan.embedProjectName) args.push('-metadata', `comment=Clipwright Studio · ${plan.projectId}`);
  return args;
}

/** Everything needed to build a full encoder command line. */
export interface EncoderInputs {
  /** The plan being encoded. */
  plan: ExportPlan;
  /** Input video: `pipe:0` for raw frames, or a path for an image-sequence source. */
  videoInput: string;
  /** Optional audio input path (a rendered WAV). Omit to encode video only. */
  audioInput?: string;
  /** Destination temp file (`.partial.<ext>`). */
  outputPath: string;
  /** Chosen encoder. */
  encoder: VideoEncoderChoice;
  /** Title metadata. */
  title: string;
  /** What this ffmpeg build understands. Defaults to the legacy spelling. */
  capabilities?: EncoderCapabilities;
  /**
   * Path to a generated ASS script to burn in (SPEC 14 §4.3). Omit when captions
   * are not being burned, or when the composition has none.
   *
   * Pass a **relative** path: ffmpeg parses the filtergraph twice, so an absolute
   * Windows path (`C:\\Users\\…`) needs its colon and backslashes escaped to
   * survive both passes, and the escaping interacts differently with quoting and
   * with the `ass` filter's own option parser. Every spelling that looked right
   * either lost the drive letter or failed with "Unable to parse option value".
   * A bare filename in the encoder's working directory has neither character and
   * therefore nothing to escape.
   */
  subtitlePath?: string;
}

/**
 * Build the full ffmpeg argument vector for the encode step.
 *
 * Video frames arrive as raw `yuv420p` on stdin at exactly the plan's resolution
 * and frame rate, so the encoder does no scaling or resampling of its own — the
 * render window is the single source of truth for pixels (SPEC 14 §2.1).
 */
export function buildEncoderArgs(inputs: EncoderInputs): string[] {
  const { plan, encoder } = inputs;
  const fps = String(plan.fps);
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    // Raw frames on stdin.
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-s', `${plan.width}x${plan.height}`,
    '-framerate', fps,
    '-i', inputs.videoInput,
  ];

  if (plan.includeAudio && inputs.audioInput) {
    args.push('-i', inputs.audioInput);
  }

  args.push('-map', '0:v:0');
  if (plan.includeAudio && inputs.audioInput) args.push('-map', '1:a:0');

  // Burned-in captions run before the encoder sees a frame, so the encoder's rate
  // control is measured on the final picture rather than on footage that gains
  // text afterwards (SPEC 14 §4.3).
  if (inputs.subtitlePath) args.push('-vf', subtitleFilter(inputs.subtitlePath));

  args.push('-c:v', encoder.codec, ...videoQualityArgs(plan, encoder));

  // Constant-frame-rate output on a fixed grid: no motion interpolation.
  args.push(...cfrArgs(fps, inputs.capabilities ?? DEFAULT_CAPABILITIES));

  args.push(...COLOUR_ARGS);
  args.push(...audioArgs(plan));

  if (plan.format !== 'webm') args.push('-movflags', '+faststart');

  args.push(...metadataArgs(plan, inputs.title));

  // Bound the mux to the planned duration so a straggling final audio frame
  // cannot extend the file past the frame grid (SPEC 14 §5.3).
  args.push('-t', plan.durationSeconds.toFixed(6));
  args.push('-y', inputs.outputPath);
  return args;
}

/**
 * The `ass` filter for a subtitle filename.
 *
 * Deliberately not an escaper. A relative path with no colon and no backslash needs
 * no quoting at all, and every escaping scheme for an absolute Windows path ran into
 * a different failure against a real ffmpeg: one lost the drive letter, two left the
 * `ass` filter reading `ird/c.ass` as an image size. Refusing what cannot be
 * expressed is better than emitting a filtergraph that silently produces an export
 * with no captions, so this throws.
 */
export function subtitleFilter(subtitlePath: string): string {
  if (/[:\\]/.test(subtitlePath) || subtitlePath.startsWith('/')) {
    throw new Error(`The subtitle path must be relative and contain no colon: ${subtitlePath}`);
  }
  return `ass='${subtitlePath}'`;
}

/**
 * The decode-side filter chain for one source item (SPEC 14 §4.2).
 *
 * `fps=<fps>:round=near` is what turns variable-frame-rate sources into a
 * constant grid, and `scale` never decodes larger than the output needs.
 */
export function sourceFilterChain(options: {
  targetFps: number;
  /** Source dimensions, when known, so we can pick the scale target. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Output dimensions — the ceiling for decoding. */
  outputWidth: number;
  outputHeight: number;
  /** Playback speed; 1 = normal. */
  speed?: number;
  /**
   * `fill` decodes at the item's needed size (up to the output size).
   * `fit` letterboxes the whole frame into the output canvas, preserving the
   * source aspect — what an export needs when the item fills the canvas but its
   * own aspect differs (SPEC 14 §3.2: never stretch).
   */
  fit?: 'fill' | 'fit';
}): string {
  const filters: string[] = [];
  if (options.speed && options.speed !== 1) filters.push(`setpts=${(1 / options.speed).toFixed(6)}*PTS`);
  filters.push(`fps=${options.targetFps}:round=near`);

  if (options.fit === 'fit') {
    // Fit inside the canvas, then pad the remainder with black. The pad
    // expression keeps the frames centred, and both sides stay even.
    const width = roundEvenLocal(options.outputWidth);
    const height = roundEvenLocal(options.outputHeight);
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`);
    filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);
    filters.push('setsar=1');
    filters.push('format=yuv420p');
    return filters.join(',');
  }

  const width = Math.min(options.sourceWidth ?? options.outputWidth, options.outputWidth);
  const height = Math.min(options.sourceHeight ?? options.outputHeight, options.outputHeight);
  // Even dimensions only: yuv420p cannot represent odd sizes.
  filters.push(`scale=${roundEvenLocal(width)}:${roundEvenLocal(height)}:flags=lanczos`);
  filters.push('format=yuv420p');
  return filters.join(',');
}

function roundEvenLocal(value: number): number {
  return Math.round(value / 2) * 2 || 2;
}

/** Arguments for probing an item's source range into raw frames (§4.2). */
export function buildDecodeArgs(options: {
  sourcePath: string;
  inUs: number;
  durationUs: number;
  filterChain: string;
}): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    // Input-side seek is fast; the filter chain's fps filter fixes the grid.
    '-ss', (options.inUs / 1_000_000).toFixed(6),
    '-i', options.sourcePath,
    '-t', (options.durationUs / 1_000_000).toFixed(6),
    '-vf', options.filterChain,
    '-an',
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-',
  ];
}

/** Arguments for the loudness analysis pass (`ebur128`, SPEC 14 §5.1). */
export function buildLoudnessArgs(inputPath: string): string[] {
  return ['-hide_banner', '-nostdin', '-i', inputPath, '-af', 'ebur128=peak=true', '-f', 'null', '-'];
}

/**
 * Parse integrated loudness out of `ebur128` output.
 * Returns `null` when the summary block has not been emitted.
 */
export function parseIntegratedLoudness(stderr: string): { integratedLufs: number; truePeakDb: number } | null {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  if (!summary) return null;
  const integrated = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary);
  if (!integrated) return null;
  return {
    integratedLufs: Number.parseFloat(integrated[1]),
    truePeakDb: peak ? Number.parseFloat(peak[1]) : 0,
  };
}

/** Gain in dB needed to reach `targetLufs` from `measuredLufs`. */
export function loudnessGainDb(measuredLufs: number, targetLufs: number): number {
  if (!Number.isFinite(measuredLufs) || measuredLufs <= -70) return 0;
  return Math.max(-24, Math.min(24, targetLufs - measuredLufs));
}
