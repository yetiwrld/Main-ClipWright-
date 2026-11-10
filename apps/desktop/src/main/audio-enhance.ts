/**
 * Running a noise-reduction job (SPEC 12 §6.8).
 *
 * The decisions — which denoiser, which filtergraph, when to refuse — are in
 * `packages/media-core`'s `noise-reduction.ts`, where they are tested without a process. This file
 * is the part that cannot be pure: probing what the bundled ffmpeg supports, running the encode,
 * caching the result, and reporting progress and cancellation.
 *
 * ## What is on this machine, and why it matters here
 *
 * The bundled ffmpeg is 4.1. `arnndn` arrived in 4.3, so the RNNoise path the spec prefers does not
 * exist in this build — the probe finds it absent and the plan falls back to `afftdn`, which does.
 * That is recorded in `docs/limitations.md` rather than papered over, and the capability is probed
 * from `-filters` each run so a later ffmpeg needs no code change.
 *
 * ## Never destructive
 *
 * The output is a new file under the media's own derived directory, and the source is opened
 * read-only. The item's `noiseReduction` field decides whether the result is *used*; clearing it
 * goes back to the original, which was never modified.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  getFFmpegPath,
  noiseReductionArgs,
  noiseReductionKey,
  planNoiseReduction,
  type NoiseReductionCapabilities,
  type NoiseReductionPlan,
} from '@clipwright/media-core';
import { run } from './export/ffmpeg-runner.js';

/**
 * How many seconds of audio a denoise takes per second of output, at worst.
 *
 * Used only for the progress bar. `afftdn` is an FFT filter and runs faster than real time on
 * speech, so a bar that assumes 1× is wrong in the safe direction — it reaches 90% and waits rather
 * than sitting at 40% while the job finishes. A wrong progress bar is a cosmetic bug; one that
 * claims 100% for ten seconds reads as a hang.
 */
const ASSUMED_REALTIME_FACTOR = 2;

/** Cached for the life of the process: `-filters` costs ~50 ms and the answer cannot change. */
let cachedCapabilities: NoiseReductionCapabilities | null = null;

/**
 * Ask the ffmpeg binary which denoisers it has.
 *
 * Probed rather than assumed. The three builds this project can meet — the bundled 4.1, a system
 * ffmpeg, and a future upgrade with `arnndn` — differ, and a build that assumed the newest would
 * fail with "No such filter", which a user reads as the feature being broken rather than as a
 * version fact.
 */
export async function noiseReductionCapabilities(): Promise<NoiseReductionCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;
  const result = await run(getFFmpegPath(), ['-hide_banner', '-filters']);
  /*
    A non-zero exit still leaves whatever ffmpeg printed; `-filters` is a listing, so a partial
    answer is still an answer. Both flags start false, which is the safe reading of "we could not
    tell" — a plan that refuses is recoverable, one that runs a filter that is not there is not.
  */
  const listing = `${result.stdout}\n${result.stderr}`;
  cachedCapabilities = {
    /* Anchored on whitespace so `afftdn2` would not match. */
    afftdn: /(^|\s)afftdn(\s|$)/m.test(listing),
    arnndn: /(^|\s)arnndn(\s|$)/m.test(listing),
  };
  return cachedCapabilities;
}

/** Reset the probe. Exported for tests, which need to see both branches. */
export function resetNoiseReductionCapabilities(): void {
  cachedCapabilities = null;
}

export interface NoiseReductionJobInput {
  mediaId: string;
  /** The absolute path of the source media. */
  sourcePath: string;
  /** The media's derived directory, as the ingest pipeline laid it out. */
  derivedDir: string;
  inUs: number;
  durationUs: number;
  strength: string;
  sampleRate?: number;
  /** The RNNoise model, when one is installed. Absent means the `arnndn` path is unavailable. */
  modelPath?: string | null;
  hasAudio?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: { percent: number; phase: string }) => void;
}

export interface NoiseReductionJobResult {
  ok: boolean;
  /** Absolute path of the denoised WAV, when `ok`. */
  outputPath?: string;
  /** True when the file was already there and no encode ran. */
  cached?: boolean;
  /** The plan that was used, so the caller can show which method ran and why. */
  plan: NoiseReductionPlan;
  /** A sentence for the user. Always present, even on success. */
  message: string;
}

/**
 * Render a denoised copy, or reuse one that is already there.
 *
 * Returns a result rather than throwing for the cases a user can act on (no denoiser, no audio,
 * cancelled). A thrown error is reserved for a broken environment — a missing source file — where
 * the message would be about the machine rather than about the setting.
 */
export async function runNoiseReduction(
  input: NoiseReductionJobInput,
): Promise<NoiseReductionJobResult> {
  const sampleRate = input.sampleRate ?? 48_000;
  const capabilities = await noiseReductionCapabilities();
  const plan = planNoiseReduction({
    strength: input.strength,
    capabilities,
    modelPath: input.modelPath ?? null,
    hasAudio: input.hasAudio,
  });

  if (plan.refusal) {
    return { ok: false, plan, message: plan.description };
  }

  if (!existsSync(input.sourcePath)) {
    /*
      Not a refusal — the plan was fine and the file is not. Thrown rather than returned because
      this is the one case where continuing would be wrong in a way the user cannot fix from the
      panel: a relink is needed, and that is a different surface.
    */
    throw new Error(`The source file for this clip is missing: ${input.sourcePath}`);
  }

  const key = noiseReductionKey({
    mediaId: input.mediaId,
    inUs: input.inUs,
    durationUs: input.durationUs,
    filters: plan.filters,
    sampleRate,
  });
  /*
    Content-addressed and short. A 16-hex-character digest is 64 bits, which for a per-project cache
    of tens of files is far past the point where a collision is a real risk, and the filename stays
    readable in a log.
  */
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const outputDir = join(input.derivedDir, 'enhanced');
  const outputPath = join(outputDir, `${digest}.wav`);

  if (existsSync(outputPath)) {
    /*
      Same media, same range, same filter chain: the file is the answer. Re-running would take the
      same time and produce the same bytes, and the user pressed the button again because they
      forgot they had — the honest response is the file, immediately.
    */
    return {
      ok: true,
      outputPath,
      cached: true,
      plan,
      message: `${plan.description} Reused the copy already made for this slice.`,
    };
  }

  await mkdir(outputDir, { recursive: true });

  const args = noiseReductionArgs({
    sourcePath: input.sourcePath,
    outputPath,
    inUs: input.inUs,
    durationUs: input.durationUs,
    filters: plan.filters,
    sampleRate,
  });

  input.onProgress?.({ percent: 5, phase: 'Cleaning up audio' });
  const expectedSeconds = Math.max(0.5, input.durationUs / 1_000_000 / ASSUMED_REALTIME_FACTOR);
  let lastReported = 5;

  const result = await run(getFFmpegPath(), ['-nostdin', ...args], {
    ...(input.signal ? { signal: input.signal } : {}),
    /*
      Progress from ffmpeg's own `time=` line rather than a timer. A timer would report a plausible
      number that has nothing to do with the work, which is a progress bar that is merely
      decoration; this one moves when the encode moves.
    */
    onStderr: (chunk) => {
      const match = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
      if (!match) return;
      const seconds =
        Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      /* Clamped below 95: the last few percent are the file being closed and checked. */
      const percent = Math.min(95, 5 + Math.round((seconds / expectedSeconds) * 90));
      if (percent <= lastReported) return;
      lastReported = percent;
      input.onProgress?.({ percent, phase: 'Cleaning up audio' });
    },
  });

  if (result.code !== 0) {
    const detail = /(^|\n)(.*error.*)$/im.exec(result.stderr)?.[2]?.trim();
    return {
      ok: false,
      plan,
      message: detail
        ? `Noise reduction failed: ${detail}`
        : 'Noise reduction failed. The original audio is untouched.',
    };
  }

  const written = await stat(outputPath).catch(() => null);
  if (!written || written.size <= 44) {
    /*
      A 44-byte WAV is a header and no samples. ffmpeg can exit 0 and still produce one when the
      source has no audio in the requested range — which is a *successful* run of a *meaningless*
      request, and the file would play as silence if it were trusted.
    */
    return {
      ok: false,
      plan,
      message: 'Noise reduction produced no audio for this range, so the original is unchanged.',
    };
  }

  input.onProgress?.({ percent: 100, phase: 'Done' });
  return {
    ok: true,
    outputPath,
    plan,
    message: `${plan.description} The original audio is untouched; compare the two before you rely on it.`,
  };
}

/**
 * Where this media's derived directory is, from what the record already knows.
 *
 * The order is by reliability, not preference: the proxy is the one artefact whose location the
 * layout fixes — `derived/proxy/<mediaId>/proxy.mp4` — so three levels up from it is `derived/`,
 * and the peaks files sit directly inside (`derived/peaks256.bin`). The source's own directory is the last resort, and it is only
 * right for a **managed** import, where the library copy does live under the project. For a
 * reference import it is the user's own footage, and writing a denoised copy beside it would put
 * the app's files on their camera card — the kind of mistake that is invisible until someone looks
 * at the disk.
 *
 * Separate and exported because that failure is worth a test and a window is not.
 */
export function derivedDirectoryFor(media: {
  path: string;
  proxyPath?: string | null;
  peaks256Path?: string;
}): string {
  /*
    Three levels, matching the layout `media-pipeline.ts` writes: `derived/proxy/<mediaId>/proxy.mp4`
    — file, media directory, `proxy`, then `derived`. Two levels lands on `derived/proxy`, which is
    a real directory and therefore *accepts* the write, so the mistake produces a file that exists
    in the wrong place rather than an error.
  */
  if (media.proxyPath) return dirname(dirname(dirname(media.proxyPath)));
  if (media.peaks256Path) return dirname(media.peaks256Path);
  return dirname(media.path);
}
