/**
 * SPEC 14 §5 — building the audio mix for an export.
 *
 * Pipeline: decode each audio-bearing item to 48 kHz stereo float PCM (§5.1),
 * apply gain/fades/pan/ducking, sum, normalise if asked, limit at −1 dBTP, then
 * write a temp WAV that the encoder takes as its second input (§5.2 default
 * route, which avoids pipe deadlocks).
 *
 * Every number written into the report comes from these measurements: the mix's
 * integrated loudness is measured with `ebur128` on the produced WAV, not
 * predicted.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MIX_CHANNELS,
  MIX_SAMPLE_RATE,
  applyGainCurve,
  applyItemProcessing,
  createClip,
  duckingCurve,
  fitLength,
  isSilent,
  limit,
  loudnessGainDb,
  mixClipInto,
  parseIntegratedLoudness,
  peakLevel,
  usToSamples,
  amplitudeToDb,
  type ExportPlan,
  type PcmClip,
} from '@clipwright/export-core';
import { ffmpegPath, run, CancelledError } from './ffmpeg-runner.js';

/** What the mixer needs to know about one audible item. */
export interface AudioItemRequest {
  itemId: string;
  /** Absolute path to the source media. */
  sourcePath: string;
  /** Source in-point in microseconds. */
  sourceInUs: number;
  /** How much source to read, in microseconds. */
  sourceDurationUs: number;
  /** Where it lands on the export timeline, in microseconds relative to the range start. */
  timelineStartUs: number;
  gain?: number;
  trackVolume?: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  pan?: number;
  muted?: boolean;
  /** Set for a music bed that should duck under the other items (§12 §6.7). */
  duckUnderSpeech?: boolean;
}

export interface AudioMixResult {
  /** Path of the written WAV, or `null` when the plan has no audio. */
  wavPath: string | null;
  /** Measured integrated loudness of the finished mix file, LUFS. */
  integratedLufs: number | null;
  /** Measured loudness before normalisation, LUFS (null when not measured). */
  preNormalisationLufs: number | null;
  /** Measured true peak after limiting, dBTP. */
  truePeakDb: number | null;
  /** Gain applied by loudness normalisation, dB. */
  appliedGainDb: number;
  /** Maximum limiter reduction, dB. */
  limiterReductionDb: number;
  /** Total mix frames (stereo samples). */
  frames: number;
  /** `true` when the mix came out silent. */
  silent: boolean;
  /** Non-fatal problems worth logging. */
  warnings: string[];
}

export interface MixOptions {
  signal?: AbortSignal;
  onProgress?: (stage: 'decoding' | 'mixing' | 'measuring' | 'writing', detail?: string) => void;
}

/**
 * Build the audio mix for a plan and write it to `wavPath`.
 *
 * Returns measurements either way; throws only for conditions the user must act
 * on (a source that cannot be decoded at all).
 */
export async function buildAudioMix(options: {
  plan: ExportPlan;
  items: AudioItemRequest[];
  wavPath: string;
  signal?: AbortSignal;
  onProgress?: MixOptions['onProgress'];
}): Promise<AudioMixResult> {
  const { plan, items, wavPath, signal, onProgress } = options;
  const warnings: string[] = [];
  const totalFrames = Math.max(1, Math.round(plan.durationSeconds * MIX_SAMPLE_RATE));
  const mix = createClip(totalFrames);

  if (items.length === 0) {
    return {
      wavPath: null,
      integratedLufs: null,
      preNormalisationLufs: null,
      truePeakDb: null,
      appliedGainDb: 0,
      limiterReductionDb: 0,
      frames: totalFrames,
      silent: true,
      warnings: ['No audio items were planned.'],
    };
  }

  // ---- Decode every item and lay it into the mix.
  const cues: Array<[number, number]> = [];
  const beds: Array<{ clip: PcmClip; start: number }> = [];

  for (const [index, item] of items.entries()) {
    if (signal?.aborted) throw new CancelledError();
    onProgress?.('decoding', `${index + 1} of ${items.length}`);
    const framesWanted = Math.round((item.sourceDurationUs / 1_000_000) * MIX_SAMPLE_RATE);
    if (framesWanted <= 0) continue;
    let clip: PcmClip;
    try {
      clip = await decodeToPcm(item.sourcePath, item.sourceInUs, framesWanted, signal);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      warnings.push(`Part of ${basename(item.sourcePath)} can't be read.`);
      continue;
    }
    // A short source is padded with silence, never treated as an error: the
    // video may simply be shorter than the item the user placed.
    clip = fitLength(clip, framesWanted);
    applyItemProcessing(clip, {
      gain: item.gain,
      trackVolume: item.trackVolume,
      fadeInUs: item.fadeInUs,
      fadeOutUs: item.fadeOutUs,
      pan: item.pan,
      muted: item.muted,
      startUs: item.timelineStartUs,
      durationUs: item.sourceDurationUs,
    });
    const at = usToSamples(item.timelineStartUs);
    if (item.duckUnderSpeech) {
      beds.push({ clip, start: at });
    } else {
      mixClipInto(mix, clip, at);
      if (!item.muted) cues.push([at, at + clip.length]);
    }
  }

  // ---- Ducking for beds, computed from the summed speech regions.
  if (beds.length > 0 && cues.length > 0) {
    onProgress?.('mixing', 'Ducking music under speech');
    const curve = duckingCurve({ length: mix.length, triggers: cues, reductionDb: -12 });
    for (const bed of beds) {
      applyGainCurve(bed.clip, curve.subarray(0, bed.clip.length));
      mixClipInto(mix, bed.clip, bed.start);
    }
  } else {
    for (const bed of beds) mixClipInto(mix, bed.clip, bed.start);
  }

  // ---- Optional loudness normalisation, measured on the real mix.
  let appliedGainDb = 0;
  let preNormalisationLufs: number | null = null;
  if (plan.normaliseLoudness && !isSilent(mix)) {
    onProgress?.('measuring', 'Measuring loudness');
    const prePath = `${wavPath}.prenorm.wav`;
    await writeWav(prePath, mix);
    const measured = await measureLoudnessFile(prePath, signal);
    if (measured) {
      preNormalisationLufs = measured.integratedLufs;
      appliedGainDb = loudnessGainDb(measured.integratedLufs, plan.targetLufs);
      if (appliedGainDb !== 0) {
        const gain = Math.pow(10, appliedGainDb / 20);
        for (let index = 0; index < mix.samples.length; index += 1) mix.samples[index] *= gain;
      }
    } else {
      warnings.push('Loudness could not be measured, so normalisation was skipped.');
    }
    const { rm } = await import('node:fs/promises');
    await rm(prePath, { force: true }).catch(() => undefined);
  }

  // ---- Limiter, then write the file the encoder reads.
  const limited = limit(mix);
  onProgress?.('writing');
  await writeWav(wavPath, mix);

  // Measure the finished file so the report quotes the loudness the listener
  // will actually hear — after gain and limiting, not before (SPEC 14 §5.5).
  const finalMeasurement = await measureLoudnessFile(wavPath, signal);
  const silent = isSilent(mix);

  return {
    wavPath,
    integratedLufs: finalMeasurement?.integratedLufs ?? null,
    preNormalisationLufs: preNormalisationLufs ?? finalMeasurement?.integratedLufs ?? null,
    truePeakDb: finalMeasurement?.truePeakDb ?? amplitudeToDb(peakLevel(mix)),
    appliedGainDb,
    limiterReductionDb: limited.maxReductionDb,
    frames: mix.length,
    silent,
    warnings,
  };
}

/**
 * Decode a source range to interleaved stereo float PCM at 48 kHz.
 *
 * `-ss` before `-i` keeps the seek fast; `-t` bounds the read so a long file does
 * not decode past its item.
 */
export async function decodeToPcm(
  sourcePath: string,
  inUs: number,
  framesWanted: number,
  signal?: AbortSignal,
): Promise<PcmClip> {
  const durationUs = (framesWanted / MIX_SAMPLE_RATE) * 1_000_000;
  const clip = createClip(framesWanted);
  const bytesPerFrame = 4 * MIX_CHANNELS;
  let written = 0;

  await new Promise<void>((resolveDecode, rejectDecode) => {
    const child = spawn(
      ffmpegPath(),
      [
        '-hide_banner', '-nostdin',
        '-ss', (inUs / 1_000_000).toFixed(6),
        '-i', sourcePath,
        '-t', (durationUs / 1_000_000).toFixed(6),
        '-vn', '-ac', String(MIX_CHANNELS), '-ar', String(MIX_SAMPLE_RATE),
        '-f', 'f32le', '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-2000);
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    let pending: Buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      const usable = pending.length - (pending.length % bytesPerFrame);
      if (usable <= 0) return;
      const frames = Math.min(usable / bytesPerFrame, framesWanted - written);
      if (frames <= 0) return;
      for (let frame = 0; frame < frames; frame += 1) {
        const offset = frame * bytesPerFrame;
        clip.samples[(written + frame) * 2] = pending.readFloatLE(offset);
        clip.samples[(written + frame) * 2 + 1] = pending.readFloatLE(offset + 4);
      }
      written += frames;
      pending = pending.subarray(usable);
    });
    child.stdout.on('error', () => undefined);
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      rejectDecode(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        rejectDecode(new CancelledError());
        return;
      }
      // A partial read is fine (the source may be shorter than the item), but a
      // total failure with no samples at all means the file could not be read.
      if (code !== 0 && written === 0) {
        rejectDecode(new Error(tail.trim() || `Could not decode audio from ${basename(sourcePath)}.`));
        return;
      }
      resolveDecode();
    });
  });

  return { samples: clip.samples, length: written };
}

/** Write interleaved float32 stereo as a 32-bit float WAV ffmpeg reads. */
export async function writeWav(path: string, clip: PcmClip): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const channels = MIX_CHANNELS;
  const bitsPerSample = 32;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = MIX_SAMPLE_RATE * blockAlign;
  const dataBytes = clip.length * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // 3 = IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(MIX_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const data = Buffer.alloc(dataBytes);
  for (let index = 0; index < clip.length * channels; index += 1) {
    data.writeFloatLE(clip.samples[index], index * 4);
  }

  await new Promise<void>((resolveWrite, rejectWrite) => {
    const stream = createWriteStream(path);
    stream.on('error', rejectWrite);
    stream.on('finish', () => resolveWrite());
    stream.write(header);
    stream.end(data);
  });
}

/** Measure integrated loudness and true peak of a file with `ebur128`. */
export async function measureLoudnessFile(
  path: string,
  signal?: AbortSignal,
): Promise<{ integratedLufs: number; truePeakDb: number } | null> {
  const { stderr } = await run(
    ffmpegPath(),
    ['-hide_banner', '-nostdin', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { signal, maxStderrBytes: 512 * 1024 },
  );
  return parseIntegratedLoudness(stderr);
}

/** Audio items derived from a plan, ready to mix. */
export function planAudioItems(
  plan: ExportPlan,
  resolveMediaPath: (mediaId: string) => string | undefined,
): AudioItemRequest[] {
  const items: AudioItemRequest[] = [];
  for (const item of plan.items) {
    if (!item.hasAudio || !item.mediaId) continue;
    const path = resolveMediaPath(item.mediaId);
    if (!path) continue;
    items.push({
      itemId: item.itemId,
      sourcePath: path,
      sourceInUs: item.sourceInUs,
      sourceDurationUs: item.durationUs,
      timelineStartUs: item.startUs - plan.rangeStartUs,
    });
  }
  return items;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
