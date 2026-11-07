/**
 * SPEC 14 §7 — Export validation.
 *
 * The validation report is the only way to reach "Done ✓ Verified" (SPEC 14
 * §7), so **no check may pass without a measurement**. Every check reads a
 * field that the orchestrator filled in from a real ffprobe/ffmpeg run:
 *
 *   - a measurement that passes  → `pass`
 *   - a measurement that fails   → `fail`
 *   - no measurement at all      → `warning` ("not measured")
 *
 * The last case exists so an unmeasured check can never masquerade as success:
 * an export whose decode pass was skipped reports *warnings*, never *verified*.
 * Required checks (1–9, 13–14) failing means the export failed outright; the
 * optional checks (10–12, 15–18) only downgrade to "Done with warnings".
 */

import type { ExportPlan } from './planner.js';

export type ValidationStatus = 'pass' | 'fail' | 'warning';

export interface ValidationCheck {
  id: number;
  name: string;
  status: ValidationStatus;
  /** Measured value (string representation). */
  measured: string;
  /** Expected value (string representation). */
  expected: string;
  /** Whether this check is required (failure = export fails). */
  required: boolean;
  /** Human-readable detail. */
  detail: string;
}

export interface ValidationReport {
  planId: string;
  overallStatus: 'verified' | 'warnings' | 'failed';
  checks: ValidationCheck[];
  /** Timestamp of validation. */
  validatedAt: string;
}

/**
 * Measurements taken from the produced file.
 *
 * `null`/`undefined` means "not measured" and is reported as a warning, never
 * as a pass. Only the fields relevant to a check need to be present.
 */
export interface ProbeResult {
  // ---- Check 1-3, 14: from `ffprobe -show_format -show_streams`.
  exists: boolean;
  sizeBytes: number;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: string;
  avgFrameRate?: string;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  videoCodec: string;
  audioCodec: string;
  pixelFormat: string;
  profile: string;
  audioSampleRate: number;
  audioChannels: number;
  /** Frames counted with `-count_frames`; `undefined` when not counted. */
  frameCount?: number;
  moovAtStart: boolean;

  // ---- Check 5/7: timestamp integrity.
  /** First and last video PTS in seconds, when the packet list was read. */
  firstPtsSeconds?: number;
  lastPtsSeconds?: number;
  /** `true` when PTS strictly increased with a constant delta. */
  constantFrameDelta?: boolean;

  // ---- Check 9: truncation.
  /** Container-level duration from `format.duration`. */
  containerDurationSeconds?: number;

  // ---- Check 10: A/V sync.
  videoStartSeconds?: number;
  audioStartSeconds?: number;

  // ---- Check 8: full decode.
  /** Decode errors seen on a full `-f null -` pass; 0 means clean. */
  decodeErrors?: number;
  /** First decode error message, for the report. */
  decodeErrorDetail?: string;

  // ---- Checks 11/12: black and frozen segments outside planned ranges.
  unexpectedBlackSegments?: number;
  unexpectedFreezeSegments?: number;

  // ---- Check 13: audio sanity.
  integratedLufs?: number;
  truePeakDb?: number;
  /** `true` when the plan has audible content but the mix measured as silence. */
  audioSilent?: boolean;

  // ---- Check 15: bitrate.
  /** Video stream bitrate in bits/s, when the container reports it. */
  videoBitrateBps?: number;

  // ---- Check 16: colour tags.
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorRange?: string;

  // ---- Check 17: caption burn-in SSIM against `renderFrame`.
  captionSsim?: number;

  // ---- Check 18: subtitle sidecars that were written.
  subtitleFiles?: Array<{ format: 'srt' | 'vtt'; cueCount: number }>;
  /** Cue count the plan expected, when it is known. */
  expectedSubtitleCues?: number;
}

export interface ValidationOptions {
  /** Run the (slow) full decode. `false` → check 8 reports "not measured". */
  fullDecode?: boolean;
  /** Decode check is sample-based; reported in the detail text. */
  quickVerify?: boolean;
}

/** Build a check, inferring the status from a measurement when given. */
function measuredCheck(
  id: number,
  name: string,
  options: {
    required: boolean;
    measured?: unknown;
    expected: string;
    /** Pass predicate; only called when a measurement exists. */
    passes?: (value: never) => boolean;
    /** Text shown when the value is missing. */
    notMeasured?: string;
    detail?: string;
  },
): ValidationCheck {
  const hasValue = options.measured !== undefined && options.measured !== null;
  if (!hasValue) {
    return {
      id,
      name,
      status: 'warning',
      measured: options.notMeasured ?? 'not measured',
      expected: options.expected,
      required: options.required,
      detail: 'This check was not run, so the export is not marked as verified.',
    };
  }
  const passed = options.passes ? options.passes(options.measured as never) : true;
  return {
    id,
    name,
    status: passed ? 'pass' : 'fail',
    measured: String(options.measured),
    expected: options.expected,
    required: options.required,
    detail: passed ? (options.detail ?? '') : (options.detail ?? ''),
  };
}

/**
 * Run all validation checks against the probe result and export plan.
 * Returns a ValidationReport with per-check results.
 */
export function validateExport(
  plan: ExportPlan,
  probe: ProbeResult,
  options: ValidationOptions = {},
): ValidationReport {
  const checks: ValidationCheck[] = [];
  const fullDecode = options.fullDecode ?? true;

  // 1: File exists, non-zero, readable. A missing file is a definite failure,
  // not an unmeasured check, so it always carries a measurement.
  checks.push({
    id: 1,
    name: 'File exists and is readable',
    status: probe.exists && probe.sizeBytes > 0 ? 'pass' : 'fail',
    measured: probe.exists ? `${probe.sizeBytes} bytes` : 'file missing',
    expected: 'size > 0',
    required: true,
    detail: probe.exists ? '' : 'The exported file could not be read.',
  });

  // 2: Container/stream structure. Audio present iff the plan asked for it.
  checks.push(
    measuredCheck(2, 'Container/stream structure', {
      required: true,
      measured: `video: ${probe.hasVideoStream}, audio: ${probe.hasAudioStream}`,
      expected: `video: true, audio: ${plan.includeAudio}`,
      passes: () => probe.hasVideoStream && probe.hasAudioStream === plan.includeAudio,
    }),
  );

  // 3: Actual width/height.
  checks.push(
    measuredCheck(3, 'Resolution', {
      required: true,
      measured: probe.width && probe.height ? `${probe.width}×${probe.height}` : undefined,
      expected: `${plan.width}×${plan.height}`,
      passes: () => probe.width === plan.width && probe.height === plan.height,
    }),
  );

  // 4: Aspect ratio within 0.1%.
  checks.push(
    measuredCheck(4, 'Aspect ratio', {
      required: true,
      measured: probe.width && probe.height ? (probe.width / probe.height).toFixed(4) : undefined,
      expected: (plan.width / plan.height).toFixed(4),
      passes: () => {
        const measured = probe.width / probe.height;
        const expected = plan.width / plan.height;
        return Math.abs(measured - expected) / expected < 0.001;
      },
    }),
  );

  // 5: Frame rate constant and equal to the plan.
  checks.push(
    measuredCheck(5, 'Frame rate', {
      required: true,
      measured: probe.frameRate || undefined,
      expected: `${plan.fps}/1`,
      passes: () => {
        const r = parseFrameRate(probe.frameRate);
        const avg = probe.avgFrameRate ? parseFrameRate(probe.avgFrameRate) : r;
        return Math.abs(r - plan.fps) < 0.001 && Math.abs(avg - r) < 0.001;
      },
    }),
  );

  // 6: Duration within one frame.
  checks.push(
    measuredCheck(6, 'Duration', {
      required: true,
      measured: probe.durationSeconds > 0 ? probe.durationSeconds.toFixed(3) : undefined,
      expected: plan.durationSeconds.toFixed(3),
      passes: () => Math.abs(probe.durationSeconds - plan.durationSeconds) < 1 / plan.fps,
    }),
  );

  // 7: Frame count equals N.
  checks.push(
    measuredCheck(7, 'Frame count', {
      required: true,
      measured: probe.frameCount,
      expected: String(plan.totalFrames),
      passes: () => probe.frameCount === plan.totalFrames,
      notMeasured: 'frames not counted',
    }),
  );

  // 8: Full decode. A skipped decode is a warning, never a pass.
  if (fullDecode) {
    checks.push(
      measuredCheck(8, 'Full decode', {
        required: true,
        measured: probe.decodeErrors,
        expected: '0 errors',
        passes: () => probe.decodeErrors === 0,
        notMeasured: 'decode not run',
        detail:
          probe.decodeErrors === 0
            ? options.quickVerify
              ? 'Sample-based decode check passed.'
              : 'Full decode passed with no errors.'
            : (probe.decodeErrorDetail ?? ''),
      }),
    );
  } else {
    checks.push({
      id: 8,
      name: 'Full decode',
      status: 'warning',
      measured: 'skipped',
      expected: '0 errors',
      required: true,
      detail: 'The full decode check was skipped, so the export is not marked as verified.',
    });
  }

  // 9: Truncation / faststart. moov-at-start is what faststart guarantees.
  checks.push(
    measuredCheck(9, 'File integrity', {
      required: true,
      measured: probe.moovAtStart ? 'moov at start' : 'moov not at start',
      expected: plan.format === 'webm' ? 'complete file' : 'moov at start (faststart)',
      passes: () => probe.moovAtStart,
      detail:
        probe.containerDurationSeconds !== undefined
          ? `container reports ${probe.containerDurationSeconds.toFixed(3)} s`
          : '',
    }),
  );

  // 10: A/V sync — stream start times within one frame (optional → warning).
  checks.push(
    measuredCheck(10, 'A/V sync', {
      required: false,
      measured:
        probe.videoStartSeconds !== undefined && probe.audioStartSeconds !== undefined
          ? `video ${probe.videoStartSeconds.toFixed(3)} s, audio ${probe.audioStartSeconds.toFixed(3)} s`
          : undefined,
      expected: '< 1 frame apart',
      passes: () =>
        Math.abs((probe.videoStartSeconds ?? 0) - (probe.audioStartSeconds ?? 0)) < 1 / plan.fps,
      notMeasured: 'start times not probed',
    }),
  );

  // 11: Black frames outside planned ranges (optional → warning).
  checks.push(
    measuredCheck(11, 'Black frames', {
      required: false,
      measured: probe.unexpectedBlackSegments,
      expected: '0 unexpected segments',
      passes: () => probe.unexpectedBlackSegments === 0,
      notMeasured: 'blackdetect not run',
    }),
  );

  // 12: Frozen frames outside planned ranges (optional → warning).
  checks.push(
    measuredCheck(12, 'Frozen frames', {
      required: false,
      measured: probe.unexpectedFreezeSegments,
      expected: '0 unexpected segments',
      passes: () => probe.unexpectedFreezeSegments === 0,
      notMeasured: 'freezedetect not run',
    }),
  );

  // 13: Audio sanity. Required when the plan has audio.
  if (plan.includeAudio) {
    checks.push(
      measuredCheck(13, 'Audio sanity', {
        required: true,
        measured:
          probe.audioSampleRate && probe.audioChannels
            ? `${probe.audioSampleRate} Hz, ${probe.audioChannels} ch`
            : undefined,
        expected: '48000 Hz, 2 ch',
        passes: () => probe.audioSampleRate === 48_000 && probe.audioChannels === 2,
      }),
    );
    checks.push(
      measuredCheck(13.1, 'Loudness and peak', {
        required: false,
        measured:
          probe.integratedLufs !== undefined
            ? `${probe.integratedLufs.toFixed(1)} LUFS, peak ${(probe.truePeakDb ?? 0).toFixed(1)} dBTP`
            : undefined,
        expected: plan.normaliseLoudness
          ? `${plan.targetLufs} LUFS ±1, peak ≤ -0.5 dBTP`
          : 'peak ≤ -0.5 dBTP',
        passes: () => {
          if ((probe.truePeakDb ?? 0) > -0.5) return false;
          if (!plan.normaliseLoudness) return true;
          return probe.integratedLufs !== undefined && Math.abs(probe.integratedLufs - plan.targetLufs) <= 1;
        },
        notMeasured: 'loudness not measured',
      }),
    );
    checks.push(
      measuredCheck(13.2, 'Audible content', {
        required: false,
        measured: probe.audioSilent === undefined ? undefined : probe.audioSilent ? 'silent' : 'audible',
        expected: 'audible',
        passes: () => probe.audioSilent === false,
        notMeasured: 'not analysed',
      }),
    );
  } else {
    checks.push({
      id: 13,
      name: 'Audio sanity',
      status: probe.hasAudioStream ? 'fail' : 'pass',
      measured: probe.hasAudioStream ? 'audio stream present' : 'no audio stream',
      expected: 'no audio stream',
      required: true,
      detail: 'Export configured without audio.',
    });
  }

  // 14: Codec/profile/pixel format.
  checks.push(
    measuredCheck(14, 'Codec and format', {
      required: true,
      measured: probe.videoCodec ? `${probe.videoCodec}, ${probe.pixelFormat}` : undefined,
      expected: `${plan.videoCodec}, yuv420p`,
      passes: () => probe.videoCodec === plan.videoCodec && probe.pixelFormat === 'yuv420p',
      detail: probe.profile ? `profile ${probe.profile}` : '',
    }),
  );

  // 15: Bitrate plausibility (optional → warning).
  checks.push(
    measuredCheck(15, 'Bitrate plausibility', {
      required: false,
      measured:
        probe.videoBitrateBps !== undefined
          ? `${(probe.videoBitrateBps / 1_000_000).toFixed(2)} Mbps`
          : undefined,
      expected: plan.videoBitrate ? `≈ ${plan.videoBitrate} Mbps` : 'within sanity bounds',
      passes: () => {
        const mbps = (probe.videoBitrateBps ?? 0) / 1_000_000;
        if (plan.videoBitrate) return Math.abs(mbps - plan.videoBitrate) / plan.videoBitrate <= 0.35;
        // CRF mode: only reject values that could not be a real video stream.
        return mbps > 0.05 && mbps < 500;
      },
      notMeasured: 'bitrate not reported',
    }),
  );

  // 16: Colour tags (optional → warning).
  checks.push(
    measuredCheck(16, 'Colour tags', {
      required: false,
      measured: probe.colorPrimaries ? `${probe.colorPrimaries}/${probe.colorTransfer ?? '?'}` : undefined,
      expected: 'bt709/bt709',
      passes: () => probe.colorPrimaries === 'bt709' && probe.colorTransfer === 'bt709',
      notMeasured: 'colour tags not probed',
    }),
  );

  // 17: Caption burn-in SSIM ≥ 0.97, only when captions were burned in.
  if (plan.burnCaptions) {
    checks.push(
      measuredCheck(17, 'Caption burn-in', {
        required: false,
        measured: probe.captionSsim !== undefined ? probe.captionSsim.toFixed(4) : undefined,
        expected: 'SSIM ≥ 0.97',
        passes: () => (probe.captionSsim ?? 0) >= 0.97,
        notMeasured: 'caption frames not sampled',
      }),
    );
  }

  // 18: Subtitle sidecars exist, parse, and match the plan's cue count.
  if (plan.saveSubtitles) {
    const files = probe.subtitleFiles;
    checks.push(
      measuredCheck(18, 'Subtitle files', {
        required: false,
        measured: files ? `${files.length} file(s)` : undefined,
        expected: `${plan.subtitleFormats.length} file(s)`,
        passes: () => {
          if (!files) return false;
          const formats = new Set(files.map((f) => f.format));
          if (!plan.subtitleFormats.every((f) => formats.has(f))) return false;
          if (probe.expectedSubtitleCues === undefined) return true;
          return files.every((f) => f.cueCount === probe.expectedSubtitleCues);
        },
        notMeasured: 'subtitle files not checked',
      }),
    );
  }

  // Overall status: any required fail → failed. Anything unconfirmed → "Done with
  // warnings": an unmeasured check (status 'warning') or an optional check that
  // did not pass (SPEC 14 §7 "warnings (10–12, 15–17) show 'Done with warnings'").
  // Only a fully measured, fully passing report earns "verified".
  const requiredFailures = checks.filter((c) => c.required && c.status === 'fail');
  const optionalFailures = checks.filter((c) => !c.required && c.status === 'fail');
  const unmeasured = checks.filter((c) => c.status === 'warning');
  const overallStatus =
    requiredFailures.length > 0
      ? 'failed'
      : optionalFailures.length > 0 || unmeasured.length > 0
        ? 'warnings'
        : 'verified';

  return {
    planId: plan.id,
    overallStatus,
    checks,
    validatedAt: new Date().toISOString(),
  };
}

/** Parse an ffprobe frame rate string like "30/1" or "30000/1001" into a number. */
export function parseFrameRate(rate: string): number {
  if (rate.includes('/')) {
    const [num, den] = rate.split('/').map(Number);
    return den ? num / den : 0;
  }
  return parseFloat(rate) || 0;
}

/** Human-readable one-line summary of a validation report. */
export function formatValidationSummary(report: ValidationReport): string {
  const passed = report.checks.filter((c) => c.status === 'pass').length;
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  const warned = report.checks.filter((c) => c.status === 'warning').length;
  return `${passed} passed, ${failed} failed, ${warned} warnings — ${report.overallStatus}`;
}

/**
 * The single-line verdict shown on a completed export row (SPEC 14 §6).
 * "Done ✓ Verified" is only possible when every check was measured and passed.
 */
export function formatValidationVerdict(report: ValidationReport): string {
  switch (report.overallStatus) {
    case 'verified':
      return 'Done ✓ Verified';
    case 'warnings': {
      const notConfirmed = report.checks.filter((c) => c.status !== 'pass');
      return `Done with warnings (${notConfirmed.length} not confirmed)`;
    }
    default: {
      const failed = report.checks.filter((c) => c.status === 'fail');
      return `Failed: ${failed.map((c) => c.name).join(', ')}`;
    }
  }
}

/** Checks that blocked verification, for the failure dialog (SPEC 14 §8). */
export function failedCheckNames(report: ValidationReport): string[] {
  return report.checks.filter((c) => c.status === 'fail').map((c) => c.name);
}
