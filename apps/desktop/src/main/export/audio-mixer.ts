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
  applyCrossfade,
  applyDeclick,
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
import { dbToGain } from '@clipwright/audio-core';
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
  /**
   * How long the item is on the timeline, in microseconds.
   *
   * Distinct from `sourceDurationUs`, which is how much *source* to read and may be longer: a
   * crossfade pulls the read earlier by up to `availableLeadUs` so the incoming clip has handles.
   * Ducking needs this number, because a trigger describes when the item is *heard*, and reading
   * the source length would keep a bed down for the handles of a transition nobody is speaking
   * through.
   */
  timelineDurationUs: number;
  gain?: number;
  trackVolume?: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  /** Fade shape (SPEC 12 §6.2); defaults to `equal-power`, the same as the schema. */
  fadeCurve?: 'linear' | 'equal-power' | 'exponential';
  /** Pan, −1 hard left … +1 hard right. The project stores −100…+100 and `planAudioItems` divides. */
  pan?: number;
  muted?: boolean;
  /**
   * Volume keyframes in dB, already shifted into *timeline* time (SPEC 12 §6).
   *
   * The project stores keyframe times local to the item, while the envelope is
   * evaluated against absolute mix time, so the shift has to happen exactly once —
   * here, in `planAudioItems`, which is the one place that knows both.
   */
  keyframes?: ReadonlyArray<{ timeUs: number; valueDb: number; interpolation?: 'linear' | 'hold' | 'bezier' | 'preset' }>;
  /** Set for a music bed that should duck under the other items (§12 §6.7). */
  duckUnderSpeech?: boolean;
  /**
   * The audio crossfade this item needs at a cut (SPEC 12 §4.2), if any.
   *
   * Both halves are described from the item's own point of view so the mixer does
   * not have to look at neighbouring items: it decodes and places exactly this item
   * and then shapes its envelope.
   */
  crossfades?: AudioCrossfade[];
}

/**
 * One side of an equal-power audio crossfade.
 *
 * Offsets are in microseconds relative to the item's own timeline start, and may be
 * negative — the incoming half of a centred crossfade begins *before* the clip does,
 * which is why the mixer has to decode earlier material than it plays at full level.
 */
export interface AudioCrossfade {
  side: 'in' | 'out';
  startOffsetUs: number;
  durationUs: number;
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
      /*
        The curve, which was the sixth property to go missing on this path. Without it
        `applyItemProcessing` defaults to `equal-power` while the inspector stores and
        shows whichever curve the user picked, so a *linear* fade exported as an
        equal-power one — audible at the edges and invisible to a test that only
        measured "it fades".
      */
      fadeCurve: item.fadeCurve,
      pan: item.pan,
      muted: item.muted,
      startUs: item.timelineStartUs,
      durationUs: item.sourceDurationUs,
      keyframes: item.keyframes,
    });
    /*
      Click-free edits (SPEC 12 §12 item 8). A cut where the two sides are unrelated
      is a step, and a step is a click. The taper goes only where a crossfade is not
      already shaping the edge: those envelopes are longer and precisely placed, and
      multiplying a 2 ms ramp into them would move the crossover point.
    */
    const hasIncomingFade = item.crossfades?.some((crossfade) => crossfade.side === 'in') ?? false;
    const hasOutgoingFade = item.crossfades?.some((crossfade) => crossfade.side === 'out') ?? false;
    if (!hasIncomingFade || !hasOutgoingFade) {
      applyDeclick(clip, { head: !hasIncomingFade, tail: !hasOutgoingFade });
    }

    for (const crossfade of item.crossfades ?? []) {
      if (crossfade.durationUs <= 0) continue;
      // Applied after the item's own fades so the two compose: a clip that fades out
      // into a transition gets both envelopes multiplied, which is what a real
      // editor does rather than one silently winning.
      applyCrossfade(clip, {
        fromSamples: usToSamples(crossfade.startOffsetUs),
        lengthSamples: usToSamples(crossfade.durationUs),
        side: crossfade.side,
      });
    }
    const at = usToSamples(item.timelineStartUs);
    if (item.duckUnderSpeech) {
      beds.push({ clip, start: at });
    } else {
      mixClipInto(mix, clip, at);
      /*
        The trigger ends where the *item* ends, not where the padded clip does.

        `fitLength` above pads a short source to the length the item claims, so `clip.length` is
        how long the clip is in the mix — not how long it has sound in it. A one-second voice on a
        two-second item is padded with a second of silence, and a cue built from `clip.length`
        covered that silent second too: the music ducked through it, under nothing. That is the
        bug this line fixes, and it was invisible from the sound alone because a bed ducked for
        longer sounds like a bed mixed lower.

        The item's own span is the honest trigger, clamped to the mix so a clip running past the
        export range cannot make a cue that extends beyond the buffer.
      */
      const triggerEnd = Math.min(
        mix.length,
        at + Math.round((item.timelineDurationUs / 1_000_000) * MIX_SAMPLE_RATE),
      );
      if (!item.muted) cues.push([at, triggerEnd]);
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

    /*
      An equal-power crossfade needs material on both sides of the cut (SPEC 12
      §4.2), and the incoming clip's half starts *before* the clip does. So the
      incoming item is decoded from earlier in its source and placed earlier on the
      timeline, then its envelope is shaped so the extra material is what the
      crossfade reveals rather than something that plays at full level.

      A `center` transition reaches back `durationUs / 2`; `start` and `end` reach
      back not at all and forward respectively, so only `center` (and `start`, whose
      window begins at the cut) needs the incoming clip pulled earlier.
    */
    const crossfades: AudioCrossfade[] = [];

    /*
      An equal-power crossfade needs material on both sides of the cut (SPEC 12
      §4.2), and the incoming clip's half of a `center` window begins *before* the
      clip does. So the incoming item is decoded from earlier in its source and
      placed earlier on the timeline; its envelope then reveals that extra material
      rather than playing it at full level.
    */
    let leadUs = 0;
    const transitionIn = item.transitionIn;
    if (transitionIn && transitionIn.crossfadeAudio !== false && transitionIn.durationUs > 0) {
      // Only a centred window reaches back past the cut. `start` and `end` place the
      // window entirely on the incoming clip's side, where no extra material is
      // needed.
      if (transitionIn.alignment === 'center') leadUs = Math.round(transitionIn.durationUs / 2);
      crossfades.push({ side: 'in', startOffsetUs: 0, durationUs: transitionIn.durationUs });
    }

    /*
      The lead the source can actually give: never more than the handles before the
      in-point, and never so much that the clip would begin before the export range.
      Missing material is not padded with silence — that would put a silent gap in
      the middle of the mix — the window simply starts at the clip's first sample.
    */
    const availableLeadUs = Math.max(
      0,
      Math.min(leadUs, item.sourceInUs, item.startUs - plan.rangeStartUs),
    );
    const sourceInUs = item.sourceInUs - availableLeadUs;
    const timelineStartUs = item.startUs - plan.rangeStartUs - availableLeadUs;

    // Offsets are relative to the clip's own decoded start, which has moved earlier
    // by `availableLeadUs`. With the full lead available the window opens on the
    // clip's first sample; with none, the ramp's first half is clipped away and the
    // clip fades in from its opening sample.
    if (crossfades.length > 0) {
      crossfades[0]!.startOffsetUs = availableLeadUs - (leadUs > 0 ? leadUs : 0);
      if (crossfades[0]!.startOffsetUs < 0) {
        // A shortfall shortens the ramp instead of starting it part-way in, so the
        // incoming clip still reaches full level exactly at the cut.
        crossfades[0]!.durationUs = Math.max(
          1,
          crossfades[0]!.durationUs + crossfades[0]!.startOffsetUs,
        );
        crossfades[0]!.startOffsetUs = 0;
      }
    }

    const transitionOut = item.transitionOut;
    if (transitionOut && transitionOut.crossfadeAudio !== false && transitionOut.durationUs > 0) {
      // The window is measured back from the cut at the item's end.
      const back =
        transitionOut.alignment === 'center'
          ? Math.round(transitionOut.durationUs / 2)
          : transitionOut.alignment === 'end'
            ? transitionOut.durationUs
            : 0;
      crossfades.push({
        side: 'out',
        startOffsetUs: availableLeadUs + item.durationUs - back,
        durationUs: transitionOut.durationUs,
      });
    }

    /*
      Volume keyframes (SPEC 12 §6) are stored local to the item but the envelope is
      evaluated against absolute mix time, so they are shifted here — once, by the
      one function that knows both the item's local origin and where it lands. The
      shift uses the item's *unadjusted* start: a crossfade may pull the clip earlier
      by `availableLeadUs`, and the keyframe times were measured against where the
      user put the clip, not against the handles it gained.

      Only `volumeDb` is carried. `gain` is a static pre-fade control with no
      keyframe path in the catalogue, and reading it would invent a feature.
    */
    const volumeKeys = (item.keyframes?.['volumeDb'] ?? [])
      .filter(
        (key): key is { timeUs: number; value: number; interpolation?: 'linear' | 'hold' | 'bezier' | 'preset' } =>
          typeof key.value === 'number',
      )
      .map((key) => ({
        timeUs: key.timeUs + (item.startUs - plan.rangeStartUs),
        valueDb: key.value,
        ...(key.interpolation ? { interpolation: key.interpolation } : {}),
      }));

    /*
      Gain, pan and the fades (SPEC 12 §6.2). `planAudioItems` left every one of these
      off the request while `AudioItemRequest` declared them, so the mixer's fallbacks
      supplied 0 dB, centre and no fade for every clip: the inspector's controls were
      connected to the project file and to nothing else. Carried here with defaults that
      mean the same thing the schema's defaults mean, so an item from a project written
      before a field existed is not treated as a request for silence.

      Mute is deliberately absent. `ExportPlan` sets `hasAudio` to false for a muted
      item, and this function skips those entirely, so a muted clip contributes no
      samples at all — forwarding `muted` here would be a branch no project can reach.

      Pan is stored as a percentage (−100…+100) and the mixer wants −1…+1, so it is
      divided once, here, rather than being read in two units by two modules.
    */
    const pan = item.pan === undefined ? 0 : clamp(item.pan / 100, -1, 1);
    items.push({
      itemId: item.itemId,
      sourcePath: path,
      sourceInUs,
      sourceDurationUs: item.durationUs + availableLeadUs,
      timelineStartUs,
      crossfades,
      timelineDurationUs: item.durationUs,
      ...(volumeKeys.length > 0 ? { keyframes: volumeKeys } : {}),
      gain: dbToGain(item.gainDb ?? 0),
      pan,
      ...(item.fadeInUs && item.fadeInUs > 0 ? { fadeInUs: item.fadeInUs } : {}),
      ...(item.fadeOutUs && item.fadeOutUs > 0 ? { fadeOutUs: item.fadeOutUs } : {}),
      ...(item.fadeCurve ? { fadeCurve: item.fadeCurve } : {}),
      /*
        Ducking (SPEC 12 §6.7). The mixer has read `duckUnderSpeech` on every item since the audio
        slice; this function never forwarded it, and the project had no field to hold it, so the
        flag was `undefined` for every clip ever exported and the ducking branch was dead code that
        looked live. Only forwarded when true, so an ordinary clip's request stays the shape it
        always was.
      */
      ...(item.duckUnderSpeech ? { duckUnderSpeech: true } : {}),
    });
  }
  return items;
}

/** Keep a value inside a range. Used for pan, which arrives as a percentage. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
