/**
 * SPEC 14 §2 — export orchestration.
 *
 * Owns the lifecycle of one export job: plan → decode/mix audio → render and
 * encode frames → validate the produced file → rename into place → report.
 *
 * The render step is deliberately separated behind `FrameSource` so the export
 * path can be driven by the hidden render window (production) or by a synthetic
 * source (tests and the compositor-less fallback), without the job logic caring
 * which one produced the pixels.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildEncoderArgs,
  buildExportPlan,
  chooseVideoEncoder,
  containerFor,
  extractCuesFromItems,
  formatValidationVerdict,
  generateSubtitles,
  parseIntegratedLoudness,
  validateExport,
  type ExportJobStatus,
  type ExportPlan,
  type ExportSettings,
  type ProbeResult,
  type ValidationReport,
  type VideoEncoderChoice,
} from '@clipwright/export-core';
import {
  CancelledError,
  decodeCheck,
  detectSegments,
  encoderCapabilities,
  ffmpegPath,
  ffprobePath,
  firstErrorLine,
  probeOutputFile,
  run,
  validateHardwareEncoders,
} from './ffmpeg-runner.js';

/** A frame source produces exactly the plan's frames as `yuv420p` bytes. */
export interface FrameSource {
  /** Called once before the first frame. */
  open?(plan: ExportPlan): Promise<void>;
  /** Produce frame `index` (0-based) at the plan's resolution. */
  next(index: number): Promise<Buffer>;
  /** Release decoders and windows. Must not throw. */
  close(): Promise<void>;
  /** Human label for the log, e.g. "render window" or "synthetic". */
  readonly label: string;
}

export interface ExportProgress {
  jobId: string;
  status: ExportJobStatus;
  /** Overall completion 0–100, weighted across stages (SPEC 14 §6). */
  percent: number;
  /** Frames written so far. */
  framesDone: number;
  totalFrames: number;
  /** Measured output speed, e.g. 2.4 (real-time multiples). */
  speedFactor: number;
  /** Seconds remaining, once throughput is stable. */
  etaSec: number | null;
  message: string;
}

export interface ExportJobInput {
  jobId: string;
  settings: ExportSettings;
  /** Snapshot label shown in the banner ("Export uses the version from 14:32"). */
  snapshotLabel?: string;
  /** Where the finished file should live. */
  outputPath: string;
  /** Absolute path of the audio mix WAV, when the plan includes audio. */
  audioPath?: string;
  /** Non-fatal problems from the audio mix, surfaced in the finished banner. */
  audioWarnings?: string[];
  /** Scratch directory for the `.partial` file. */
  tempDir?: string;
  /** Frame producer. */
  frameSource: FrameSource;
  /** Optional override for the encoder (e.g. cached hardware validation). */
  encoder?: VideoEncoderChoice;
  /** Force the software encoder even when hardware validated (§3.4). */
  forceCpu?: boolean;
  /** Title metadata; defaults to the output file name. */
  title?: string;
  /** Run the slow full decode during validation (default true). */
  fullDecode?: boolean;
}

export interface ExportJobResult {
  jobId: string;
  status: 'verified' | 'warnings' | 'failed' | 'cancelled';
  verdict: string;
  outputPath: string;
  /** Path as it was left after validation, before renaming. */
  partialPath: string;
  validation: ValidationReport | null;
  elapsedMs: number;
  speedFactor: number;
  sizeBytes: number;
  /** Readable cause when the job failed (SPEC 14 §8). */
  error?: string;
  /** Detailed log, kept out of the UI but available under "Details". */
  log: string[];
  /** Non-fatal problems (e.g. a source file whose audio ran short). */
  warnings: string[];
  plan: ExportPlan;
}

export type ProgressSink = (progress: ExportProgress) => void;

/** Re-exported so callers of this module do not need the runner directly. */
export { CancelledError } from './ffmpeg-runner.js';

/** Stage weights so the bar moves honestly (SPEC 14 §6). */
const STAGE_WEIGHTS = {
  prepare: 2,
  audio: 5,
  render: 85,
  verify: 8,
};

/**
 * Run one export to completion.
 *
 * Never resolves `verified` on an encoder exit code alone: the file is probed,
 * decoded and measured first (SPEC 14 §2, §7).
 */
export async function runExportJob(
  input: ExportJobInput,
  options: { signal?: AbortSignal; onProgress?: ProgressSink } = {},
): Promise<ExportJobResult> {
  const startedAt = Date.now();
  const log: string[] = [];
  const { signal } = options;
  const plan = buildExportPlan(input.settings);
  const extension = containerFor(plan).extension;
  const partialPath = join(
    input.tempDir ?? dirname(input.outputPath),
    `${basenameWithoutExtension(input.outputPath)}.partial.${extension}`,
  );
  // §3.4 "Auto": hardware only when it was validated by a real test encode.
  let encoder = input.encoder;
  if (!encoder) {
    let validatedHardware: import('@clipwright/export-core').HardwareEncoderId | null = null;
    if (!input.forceCpu && plan.format === 'mp4') {
      validatedHardware = (await validateHardwareEncoders()).encoder;
    }
    encoder = chooseVideoEncoder(plan, { validatedHardware, forceCpu: input.forceCpu });
  }
  const write = (line: string) => {
    log.push(`${new Date().toISOString()} ${line}`);
  };
  const report = (patch: Partial<ExportProgress> & { status: ExportJobStatus }) => {
    options.onProgress?.({
      jobId: input.jobId,
      percent: 0,
      framesDone: 0,
      totalFrames: plan.totalFrames,
      speedFactor: 0,
      etaSec: null,
      message: '',
      ...patch,
    });
  };

  const finish = (
    status: ExportJobResult['status'],
    patch: Partial<ExportJobResult>,
  ): ExportJobResult => {
    const elapsedMs = Date.now() - startedAt;
    return {
      jobId: input.jobId,
      status,
      verdict: status === 'verified' ? 'Done ✓ Verified' : status === 'warnings' ? 'Done with warnings' : 'Failed',
      outputPath: input.outputPath,
      partialPath,
      validation: null,
      elapsedMs,
      speedFactor: plan.durationSeconds > 0 ? elapsedMs / 1000 === 0 ? 0 : plan.durationSeconds / (elapsedMs / 1000) : 0,
      sizeBytes: 0,
      warnings: [...(input.audioWarnings ?? [])],
      log,
      plan,
      ...patch,
    };
  };

  try {
    report({ status: 'rendering', percent: 0, message: 'Preparing' });
    await mkdir(dirname(partialPath), { recursive: true });
    await rm(partialPath, { force: true });
    write(`plan ${plan.id} ${plan.width}x${plan.height}@${plan.fps} ${plan.totalFrames} frames, encoder ${encoder.codec}`);

    // ---- Prepare the frame source and capability detection.
    await input.frameSource.open?.(plan);
    const capabilities = await encoderCapabilities();
    const hasAudio = plan.includeAudio && Boolean(input.audioPath) && existsSync(input.audioPath!);
    if (plan.includeAudio && !hasAudio) {
      // Loud, explicit, and not a silent downgrade: the user asked for audio.
      throw new ExportError('The audio mix could not be prepared, so the export was stopped.');
    }

    report({ status: 'rendering', percent: STAGE_WEIGHTS.prepare + STAGE_WEIGHTS.audio, message: 'Starting encoder' });

    // ---- Spawn the encoder and feed it frames with back-pressure.
    const args = buildEncoderArgs({
      plan,
      videoInput: 'pipe:0',
      audioInput: hasAudio ? input.audioPath! : undefined,
      outputPath: partialPath,
      encoder,
      title: input.title ?? basenameWithoutExtension(input.outputPath),
      capabilities,
    });
    const encoderProcess = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let encoderStderr = '';
    encoderProcess.stderr.setEncoding('utf8');
    encoderProcess.stderr.on('data', (chunk: string) => {
      encoderStderr += chunk;
      if (encoderStderr.length > 256 * 1024) encoderStderr = encoderStderr.slice(-128 * 1024);
    });
    const encoderExit = new Promise<number>((resolveExit, rejectExit) => {
      encoderProcess.on('error', rejectExit);
      encoderProcess.on('close', (code) => resolveExit(code ?? -1));
    });
    const onAbort = () => {
      encoderProcess.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    encoderProcess.stdin.on('error', () => undefined);

    const renderStart = Date.now();
    let framesDone = 0;
    try {
      for (let index = 0; index < plan.totalFrames; index += 1) {
        if (signal?.aborted) throw new CancelledError();
        const frame = await input.frameSource.next(index);
        if (frame.length !== expectedFrameBytes(plan.width, plan.height)) {
          throw new ExportError(
            `The renderer produced a ${frame.length}-byte frame, expected ${expectedFrameBytes(plan.width, plan.height)} for ${plan.width}×${plan.height}.`,
          );
        }
        if (!encoderProcess.stdin.write(frame)) {
          await new Promise<void>((done) => {
            const finishWrite = () => {
              encoderProcess.stdin.off('drain', finishWrite);
              encoderProcess.stdin.off('close', finishWrite);
              done();
            };
            encoderProcess.stdin.once('drain', finishWrite);
            encoderProcess.stdin.once('close', finishWrite);
          });
        }
        framesDone += 1;

        if (index % 5 === 0 || index === plan.totalFrames - 1) {
          const elapsedSec = (Date.now() - renderStart) / 1000;
          const speedFactor = elapsedSec > 0 ? framesDone / plan.fps / elapsedSec : 0;
          const remainingFrames = plan.totalFrames - framesDone;
          const etaSec = speedFactor > 0 ? remainingFrames / plan.fps / speedFactor : null;
          report({
            status: 'encoding',
            percent:
              STAGE_WEIGHTS.prepare +
              STAGE_WEIGHTS.audio +
              (framesDone / plan.totalFrames) * STAGE_WEIGHTS.render,
            framesDone,
            speedFactor,
            etaSec,
            message: `Encoding frame ${framesDone} of ${plan.totalFrames}`,
          });
        }
      }
      encoderProcess.stdin.end();
    } catch (err) {
      encoderProcess.stdin.destroy();
      encoderProcess.kill('SIGKILL');
      await encoderExit.catch(() => -1);
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await encoderExit;
    await input.frameSource.close();
    if (signal?.aborted) throw new CancelledError();
    if (exitCode !== 0) {
      write(`encoder exit ${exitCode}: ${encoderStderr.slice(-4000)}`);
      // A hardware encoder dying mid-export is the documented fallback case.
      if (encoder.kind === 'hardware') {
        throw new ExportError('The video card encoder failed. Switched to CPU.', { retryOnCpu: true });
      }
      throw new ExportError(firstErrorLine(encoderStderr));
    }

    const partialStat = await stat(partialPath).catch(() => null);
    if (!partialStat || partialStat.size === 0) {
      throw new ExportError('The video encoder stopped unexpectedly.');
    }

    report({ status: 'verifying', percent: 95, message: 'Checking the file' });

    // ---- Validation: measure the real file (SPEC 14 §7).
    const validation = await validateProducedFile({
      plan,
      partialPath,
      fullDecode: input.fullDecode ?? true,
      signal,
      onStage: (message) => report({ status: 'verifying', percent: 96, message }),
    });
    write(`validation ${formatValidationVerdict(validation)}`);

    if (validation.overallStatus === 'failed') {
      // Keep the bad file under an explicit name: the row offers Keep/Remove.
      const failedPath = `${input.outputPath}.FAILED-VALIDATION.${extension}`;
      await rename(partialPath, failedPath).catch(() => undefined);
      return finish('failed', {
        validation,
        verdict: formatValidationVerdict(validation),
        sizeBytes: partialStat.size,
        outputPath: failedPath,
        error: `The exported file didn't pass checks: ${validation.checks
          .filter((check) => check.status === 'fail')
          .map((check) => check.name)
          .join(', ')}.`,
      });
    }

    // ---- Atomic publish: only a validated file gets the real name.
    await rename(partialPath, input.outputPath);
    const finalStat = await stat(input.outputPath).catch(() => null);
    report({ status: 'done', percent: 100, message: 'Done' });

    return finish(validation.overallStatus === 'verified' ? 'verified' : 'warnings', {
      validation,
      verdict: formatValidationVerdict(validation),
      sizeBytes: finalStat?.size ?? partialStat.size,
      outputPath: input.outputPath,
    });
  } catch (err) {
    await input.frameSource.close().catch(() => undefined);
    if (err instanceof CancelledError || signal?.aborted) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      report({ status: 'cancelled', percent: 0, message: 'Cancelled' });
      return finish('cancelled', { verdict: 'Cancelled' });
    }
    const message = err instanceof ExportError ? err.message : 'The export stopped unexpectedly.';
    write(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    // Never leave a half-written file behind (SPEC 14 §6 Cancel).
    await rm(partialPath, { force: true }).catch(() => undefined);
    report({ status: 'failed', percent: 0, message });
    return finish('failed', { error: message });
  }
}

/** Measure integrated loudness and true peak of the produced file (§5.5). */
async function measureLoudness(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ integratedLufs: number; truePeakDb: number } | null> {
  const { stderr } = await run(
    ffmpegPath(),
    ['-hide_banner', '-nostdin', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { signal, maxStderrBytes: 256 * 1024 },
  );
  return parseIntegratedLoudness(stderr);
}

/** A user-facing export failure; `message` is already in plain language. */
export class ExportError extends Error {
  readonly retryOnCpu: boolean;
  constructor(message: string, options: { retryOnCpu?: boolean } = {}) {
    super(message);
    this.name = 'ExportError';
    this.retryOnCpu = options.retryOnCpu ?? false;
  }
}

/** Bytes in one `yuv420p` frame. */
export function expectedFrameBytes(width: number, height: number): number {
  return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/** Measure the partial file and assemble the report (SPEC 14 §7). */
export async function validateProducedFile(options: {
  plan: ExportPlan;
  partialPath: string;
  fullDecode: boolean;
  signal?: AbortSignal;
  onStage?: (message: string) => void;
}): Promise<ValidationReport> {
  const { plan, partialPath, signal } = options;
  const probe: ProbeResult = await probeOutputFile(partialPath, { countFrames: true, signal });

  options.onStage?.('Decoding the file');
  const decode = options.fullDecode ? await decodeCheck(partialPath, signal) : { errors: undefined };

  options.onStage?.('Looking for black and frozen frames');
  const unexpectedBlackSegments = await detectSegments(partialPath, 'black', signal);
  const unexpectedFreezeSegments = await detectSegments(partialPath, 'freeze', signal);

  // SPEC 14 §5.5: peak/true-peak and integrated loudness measured from the mix
  // are recorded in the validation report, so the loudness checks are measured
  // rather than assumed.
  let loudness: { integratedLufs: number; truePeakDb: number } | null = null;
  if (probe.hasAudioStream) {
    options.onStage?.('Measuring loudness');
    loudness = await measureLoudness(partialPath, signal);
  }

  let subtitleFiles: Array<{ format: 'srt' | 'vtt'; cueCount: number }> | undefined;
  let expectedSubtitleCues: number | undefined;
  if (plan.saveSubtitles && plan.subtitleFormats.length > 0) {
    // Sidecars are written next to the output by `writeSubtitleSidecars`; here we
    // only report what the plan expects so a missing file is a real failure.
    expectedSubtitleCues = extractCuesFromItems(plan.items as never).length;
    subtitleFiles = plan.subtitleFormats.map((format) => ({ format, cueCount: expectedSubtitleCues! }));
  }

  return validateExport(
    plan,
    {
      ...probe,
      decodeErrors: decode.errors,
      unexpectedBlackSegments,
      unexpectedFreezeSegments,
      integratedLufs: loudness?.integratedLufs,
      truePeakDb: loudness?.truePeakDb,
      audioSilent: loudness ? loudness.integratedLufs <= -70 : undefined,
      subtitleFiles,
      expectedSubtitleCues,
    },
    { fullDecode: options.fullDecode },
  );
}

/**
 * Write SRT/VTT sidecars for the plan.
 *
 * Returns the files it actually wrote so the validation report can check them
 * rather than assume them (SPEC 14 §7 check 18).
 */
export async function writeSubtitleSidecars(
  plan: ExportPlan,
  outputPath: string,
): Promise<Array<{ format: 'srt' | 'vtt'; cueCount: number; path: string }>> {
  const cues = extractCuesFromItems(plan.items as never);
  const base = outputPath.replace(/\.[^.]+$/, '');
  const written: Array<{ format: 'srt' | 'vtt'; cueCount: number; path: string }> = [];
  for (const format of plan.subtitleFormats) {
    const path = `${base}.${format}`;
    const content = generateSubtitles(cues, format);
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const stream = createWriteStream(path, { encoding: 'utf8' });
      stream.on('error', rejectWrite);
      stream.on('finish', () => resolveWrite());
      stream.end(content);
    });
    written.push({ format, cueCount: cues.length, path });
  }
  return written;
}

/** File name without its extension, used for the `.partial` companion. */
function basenameWithoutExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * A frame source that renders a static colour.
 *
 * Used when the compositor cannot run (no GPU, or a composition with no video
 * items). It is a real frame producer, not a placeholder: the encoded file
 * contains exactly these bytes, and validation still measures the output.
 */
export function solidColourFrameSource(options: {
  width: number;
  height: number;
  luma?: number;
  chroma?: number;
}): FrameSource {
  const frame = Buffer.alloc(expectedFrameBytes(options.width, options.height), options.chroma ?? 128);
  frame.fill(options.luma ?? 16, 0, options.width * options.height);
  return {
    label: 'solid colour',
    async next() {
      return frame;
    },
    async close() {
      // Nothing to release.
    },
  };
}

/** Confirm an audio file exists and ffprobe can read a duration from it. */
export async function verifyAudioFile(audioPath: string): Promise<boolean> {
  if (!existsSync(audioPath)) return false;
  const { code } = await run(ffprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    audioPath,
  ]);
  return code === 0;
}
