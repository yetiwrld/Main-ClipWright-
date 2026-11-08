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
  /**
   * Crop, scale, rotation and offset, as stored on the item (`10 §8.4–8.6`).
   * Omitted means the picture is drawn whole and centred, which is what every
   * item did before the inspector could edit it.
   */
  geometry?: {
    crop?: { left?: number; top?: number; right?: number; bottom?: number };
    transform?: {
      x?: number;
      y?: number;
      scale?: number;
      scaleX?: number;
      scaleY?: number;
      rotation?: number;
      flipH?: boolean;
      flipV?: boolean;
      /**
       * The anchor's effect, already folded into the position by
       * `itemGeometry` (`@clipwright/compositor`).
       *
       * `x`/`y` above are the stored position — where the user put the clip — while
       * an off-centre anchor needs the picture's *centre* to land somewhere else
       * (SPEC 10 §4). Rather than repeat that rotation-and-scale arithmetic in an
       * ffmpeg filter string, the caller passes the resolved offset and this chain
       * uses it in place of `x`/`y`. Absent means "no anchor", and the stored
       * position applies unchanged.
       */
      resolvedOffsetX?: number;
      resolvedOffsetY?: number;
      anchorX?: number;
      anchorY?: number;
    };
  };
}): string {
  const filters: string[] = [];
  if (options.speed && options.speed !== 1) filters.push(`setpts=${(1 / options.speed).toFixed(6)}*PTS`);
  filters.push(`fps=${options.targetFps}:round=near`);

  // Crop first: everything after it works on the surviving rectangle. The values
  // are fractions of the source, so they are expressed as ffmpeg `iw`/`ih` maths
  // and stay correct at whatever size the source happens to be.
  const crop = options.geometry?.crop;
  if (crop) {
    const left = clampFraction(crop.left ?? 0);
    const top = clampFraction(crop.top ?? 0);
    const right = clampFraction(crop.right ?? 0);
    const bottom = clampFraction(crop.bottom ?? 0);
    const width = 1 - left - right;
    const height = 1 - top - bottom;
    const untouched = left === 0 && top === 0 && right === 0 && bottom === 0;
    if (!untouched && width > 0.01 && height > 0.01) {
      // `floor(w*iw/2)*2` keeps the size even, because yuv420p cannot represent an
      // odd width and an odd crop would otherwise fail at the encoder.
      filters.push(
        `crop=floor(iw*${fmt(width)}/2)*2:floor(ih*${fmt(height)}/2)*2:floor(iw*${fmt(left)}/2)*2:floor(ih*${fmt(top)}/2)*2`,
      );
    }
  }

  const scale = geometryScale(options.geometry?.transform);
  const rotation = options.geometry?.transform?.rotation ?? 0;
  /*
    The resolved offset when the caller supplied one, otherwise the stored position.
    The two differ only when the anchor is off-centre, and passing the resolved value
    is what keeps the file's picture in the same place as the preview's — the anchor
    arithmetic lives in `itemGeometry` and is not re-derived here.
  */
  const offsetX = options.geometry?.transform?.resolvedOffsetX ?? options.geometry?.transform?.x ?? 0;
  const offsetY = options.geometry?.transform?.resolvedOffsetY ?? options.geometry?.transform?.y ?? 0;
  const flipH = options.geometry?.transform?.flipH ?? false;
  const flipV = options.geometry?.transform?.flipV ?? false;

  // `hflip`/`vflip` rather than a negative `scale`: a negative scale reverses the
  // picture *and* can leave the dimensions odd, which yuv420p rejects.
  const flipFilters: string[] = [];
  if (flipH) flipFilters.push('hflip');
  if (flipV) flipFilters.push('vflip');

  if (options.fit === 'fit') {
    // Fit inside the canvas, then pad the remainder with black. The pad
    // expression keeps the frames centred, and both sides stay even.
    const width = roundEvenLocal(options.outputWidth);
    const height = roundEvenLocal(options.outputHeight);
    const capToCanvas = `crop=w='min(iw,${width})':h='min(ih,${height})':x=(iw-ow)/2:y=(ih-oh)/2`;
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`);
    // ffmpeg rounds `decrease` *up* to the nearest integer, which can leave the
    // picture a pixel wider than the canvas (1080×1920 for a 9:16 crop of a 16:9
    // source comes out 1082 wide). `pad` then rejects the overflow and the picture
    // is torn off its right edge — measured, not guessed: two black columns at the
    // right and one at the left. Capping the axes first makes the pad a pure
    // letterbox in every case, which is what its centring expression assumes.
    filters.push(capToCanvas);
    filters.push(...flipFilters);

    const moved = rotation !== 0 || scale.x !== 1 || scale.y !== 1 || offsetX !== 0 || offsetY !== 0;
    if (!moved) {
      filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);
      filters.push('setsar=1');
      filters.push('format=yuv420p');
      return filters.join(',');
    }

    // The fitted picture is placed on the canvas explicitly, because `pad` cannot
    // express a scale, a rotation or an off-centre position — and, crucially, `pad`
    // refuses to *shrink* a picture that a scale or rotation has made larger. So
    // after each of those the picture is fitted to the canvas size again, and the
    // final `pad` only ever adds the black the picture leaves behind.
    const rotationRadians = (rotation * Math.PI) / 180;
    if (scale.x !== 1 || scale.y !== 1) {
      filters.push(
        `scale=w=trunc(iw*${fmt(scale.x)}/2)*2:h=trunc(ih*${fmt(scale.y)}/2)*2:flags=lanczos`,
      );
      // Cap each axis at the canvas, keeping the middle. `min` is what makes one
      // expression serve both directions: a zoom in truncates the axes that
      // overflow, a zoom out leaves them alone. A plain `crop=W:H` cannot do that —
      // it fails when the picture is smaller than the canvas on either axis, which
      // a non-square zoom does routinely.
      filters.push(capToCanvas);
    }
    if (rotation !== 0) {
      /*
        `ow`/`oh` grow the frame to the rotated bounding box, filling the corners the
        turn exposes with black — that part is right. What was wrong is the refit that
        used to follow: `scale=W:H:force_original_aspect_ratio=decrease` fitted the
        *rotated* picture to the canvas, so every rotation threw the user's scale away
        and blew a small clip up to fill the frame. Measured, not guessed: a 0.5-scaled
        square came out 360×360 unrotated and 480×720 once rotated.

        Scaling by `1/rotw`-style factors is not available in this ffmpeg's expression
        set, so instead the rotation is done into a frame large enough to hold the
        rotated picture *at its current size*, and the picture is then placed by the
        final `pad` exactly like an unrotated one. `c=black` already fills the exposed
        corners, and the outermost `capToCanvas` keeps the result inside the frame.
      */
      filters.push(
        `rotate=${fmt(rotationRadians)}:ow=rotw(${fmt(rotationRadians)}):oh=roth(${fmt(rotationRadians)}):c=black`,
      );
      /*
        The rotated frame is larger than the canvas whenever the picture is not square
        at this angle. `capToCanvas` is a `crop`, and a crop *can* shrink where the
        final `pad` cannot — so capping here is what keeps the pad's centring
        expression valid, and it is also the honest result: a clip that turns past the
        edge of the frame is clipped by the frame, not quietly resized to fit inside it.
      */
      filters.push(capToCanvas);
    }
    // The offset rides on the final pad, which is the last stage before the frame
    // leaves for the encoder — so it is expressed in output pixels.
    filters.push(
      `pad=${width}:${height}:(ow-iw)/2+${fmt(offsetX * width)}:(oh-ih)/2+${fmt(offsetY * height)}:black`,
    );
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

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.95, Math.max(0, value));
}

/** Trim trailing zeros so the filter string is stable and readable in the log. */
function fmt(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * The effective scale, matching `itemGeometry` in `@clipwright/compositor`: the
 * per-axis values win once either has moved off 1, otherwise the legacy framing
 * `scale` applies to both axes.
 */
function geometryScale(
  transform:
    | { scale?: number; scaleX?: number; scaleY?: number }
    | undefined,
): { x: number; y: number } {
  const scaleX = transform?.scaleX ?? 1;
  const scaleY = transform?.scaleY ?? 1;
  const legacy = transform?.scale ?? 1;
  return scaleX === 1 && scaleY === 1 && legacy !== 1
    ? { x: legacy, y: legacy }
    : { x: scaleX, y: scaleY };
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

/**
 * Arguments for a decode whose picture changes over time (SPEC 12 §2.2).
 *
 * The keyframed item is split into segments and concatenated, so the chain has to
 * be a `filter_complex` with a named output rather than a linear `-vf`. The input
 * seek stays on the input side for the same reason it does in `buildDecodeArgs`:
 * it is fast, and every branch filters timestamps relative to it.
 */
export function buildSegmentedDecodeArgs(options: {
  sourcePath: string;
  inUs: number;
  durationUs: number;
  filterComplex: string;
}): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-ss', (options.inUs / 1_000_000).toFixed(6),
    '-i', options.sourcePath,
    '-t', (options.durationUs / 1_000_000).toFixed(6),
    '-filter_complex', options.filterComplex,
    '-map', '[out]',
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
