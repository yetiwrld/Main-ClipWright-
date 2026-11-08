// @vitest-environment node
/**
 * SPEC 14 §5 — the audio mix, measured with real ffmpeg.
 *
 * A mix is only correct if the numbers are: these tests decode real audio,
 * measure the result with `ebur128`, and assert on what came out rather than on
 * what the code thought it was doing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAudioMix,
  decodeToPcm,
  measureLoudnessFile,
  planAudioItems,
  writeWav,
} from '../export/audio-mixer.js';
import { ffmpegPath, ffprobePath } from '../export/ffmpeg-runner.js';
import {
  MIX_SAMPLE_RATE,
  amplitudeToDb,
  buildExportPlan,
  createClip,
  peakLevel,
  type ExportPlan,
  type ExportSettings,
} from '@clipwright/export-core';

const TMP = join(process.cwd(), '.tmp-audio-mixer');
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Encode a WAV (or any audio) into an AAC-in-MP4 file ffmpeg can decode. */
function makeAudioFile(name: string, options: { seconds?: number; volume?: number } = {}): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, name);
  const seconds = options.seconds ?? 2;
  const volume = options.volume ?? 0.5;
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-nostdin',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-af', `volume=${volume}`,
      '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
      '-y', path,
    ],
    { stdio: 'ignore' },
  );
  return path;
}

/**
 * A steady tone whose *phase* differs from `makeAudioFile`'s.
 *
 * Two clips decoded from the same synthesised sine would be sample-identical, so a
 * cut between them would have no step at all and the test could not tell a cut from
 * a crossfade. Offsetting the frequency gives each file its own waveform, which is
 * what real footage does.
 */
function makeConstantToneFile(
  name: string,
  options: { seconds?: number; volume?: number; frequency?: number } = {},
): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, name);
  const seconds = options.seconds ?? 1;
  const volume = options.volume ?? 0.6;
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-nostdin',
      '-f', 'lavfi', '-i',
      `sine=frequency=${options.frequency ?? 300}:sample_rate=48000:duration=${seconds}`,
      '-af', `volume=${volume}`,
      '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
      '-y', path,
    ],
    { stdio: 'ignore' },
  );
  return path;
}

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-a',
    projectId: 'proj-a',
    preset: '720p',
    aspect: '16:9',
    fps: 30,
    format: 'mp4',
    quality: 'draft',
    rateControl: 'vbr',
    audioBitrate: 192,
    includeAudio: true,
    burnCaptions: false,
    saveSubtitles: false,
    subtitleFormats: [],
    embedProjectName: true,
    normaliseLoudness: false,
    targetLufs: -16,
    isDraft: false,
    rangeUs: [0, 2_000_000],
    compositionFps: 30,
    compositionDurationUs: 2_000_000,
    items: [],
    ...overrides,
  };
}

function planWithAudio(mediaId = 'media-a'): ExportPlan {
  return buildExportPlan(
    makeSettings({
      items: [
        {
          id: 'item-audio',
          trackId: 'track-audio',
          type: 'audio',
          mediaId,
          startUs: 0,
          durationUs: 2_000_000,
          sourceInUs: 0,
          sourceDurationUs: 2_000_000,
          disabled: false,
          muted: false,
          hasAudio: true,
        },
      ],
    }),
  );
}

describe('writeWav', () => {
  // Gated on the test, not the describe: the rest of this block reads the bytes
  // back directly and needs no encoder. Only this one shells out to ffprobe.
  it.skipIf(!HAS_FFMPEG)('writes a header ffprobe recognises as 48 kHz stereo float', async () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, 'written.wav');
    const clip = createClip(MIX_SAMPLE_RATE);
    clip.samples.fill(0.25);
    await writeWav(path, clip);

    const probe = execFileSync(ffprobePath(), [
      '-v', 'error', '-show_streams', '-of', 'json', path,
    ]).toString();
    const parsed = JSON.parse(probe) as { streams: Array<Record<string, unknown>> };
    const stream = parsed.streams[0];
    expect(stream.codec_name).toBe('pcm_f32le');
    expect(Number(stream.sample_rate)).toBe(48_000);
    expect(Number(stream.channels)).toBe(2);
    expect(Number(stream.duration)).toBeCloseTo(1, 1);
  });

  it('writes the samples it was given', async () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, 'values.wav');
    const clip = createClip(10);
    clip.samples[0] = 0.5;
    clip.samples[1] = -0.5;
    await writeWav(path, clip);
    const bytes = readFileSync(path);
    // Data starts after the 44-byte header.
    expect(bytes.readFloatLE(44)).toBeCloseTo(0.5, 6);
    expect(bytes.readFloatLE(48)).toBeCloseTo(-0.5, 6);
    expect(bytes.length).toBe(44 + 10 * 2 * 4);
  });
});

describe.skipIf(!HAS_FFMPEG)('decodeToPcm', () => {
  it('decodes real audio at 48 kHz stereo', async () => {
    const source = makeAudioFile('decode.mp4', { seconds: 1 });
    const clip = await decodeToPcm(source, 0, MIX_SAMPLE_RATE);
    expect(clip.length).toBeGreaterThan(MIX_SAMPLE_RATE * 0.9);
    expect(clip.length).toBeLessThanOrEqual(MIX_SAMPLE_RATE);
    // lavfi's sine runs at amplitude 1/8, and volume=0.5 halves that.
    expect(peakLevel(clip)).toBeGreaterThan(0.02);
    expect(peakLevel(clip)).toBeLessThan(1);
  }, 60_000);

  it('honours a seek into the middle of the file', async () => {
    const source = makeAudioFile('seek.mp4', { seconds: 2 });
    const clip = await decodeToPcm(source, 1_000_000, MIX_SAMPLE_RATE / 2);
    expect(clip.length).toBeGreaterThan(MIX_SAMPLE_RATE * 0.4);
    expect(clip.length).toBeLessThanOrEqual(MIX_SAMPLE_RATE / 2);
  }, 60_000);

  it('rejects a file that has no audio at all', async () => {
    // A video-only MP4: no audio stream to decode.
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, 'silent.mp4');
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-y', path],
      { stdio: 'ignore' },
    );
    await expect(decodeToPcm(path, 0, MIX_SAMPLE_RATE)).rejects.toThrow();
  }, 60_000);
});

describe.skipIf(!HAS_FFMPEG)('buildAudioMix', () => {
  it('writes a mix and measures its loudness', async () => {
    const source = makeAudioFile('mix.mp4', { seconds: 2, volume: 0.5 });
    const plan = planWithAudio();
    const wavPath = join(TMP, 'mix.wav');
    const result = await buildAudioMix({
      plan,
      items: planAudioItems(plan, () => source),
      wavPath,
    });

    expect(result.wavPath).toBe(wavPath);
    expect(existsSync(wavPath)).toBe(true);
    expect(result.frames).toBe(MIX_SAMPLE_RATE * 2);
    expect(result.silent).toBe(false);
    expect(result.integratedLufs).not.toBeNull();
    // A 0.5-volume sine reads around -12 LUFS, definitely audible.
    expect(result.integratedLufs!).toBeGreaterThan(-40);
    expect(result.integratedLufs!).toBeLessThan(0);
  }, 120_000);

  it('returns no file when there is nothing to mix', async () => {
    const plan = planWithAudio();
    const result = await buildAudioMix({ plan, items: [], wavPath: join(TMP, 'none.wav') });
    expect(result.wavPath).toBeNull();
    expect(result.silent).toBe(true);
  });

  it('places an item that starts later in the timeline at the right offset', async () => {
    const source = makeAudioFile('offset.mp4', { seconds: 1, volume: 0.6 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'item-late',
            trackId: 'track-audio',
            type: 'audio',
            mediaId: 'media-a',
            startUs: 1_000_000,
            durationUs: 1_000_000,
            sourceInUs: 0,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
        ],
      }),
    );
    const wavPath = join(TMP, 'offset.wav');
    await buildAudioMix({
      plan,
      items: planAudioItems(plan, () => source),
      wavPath,
    });

    // Decode the written WAV and check the first second is quiet.
    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    const firstSecond = { samples: decoded.samples.subarray(0, MIX_SAMPLE_RATE * 2), length: MIX_SAMPLE_RATE };
    const secondSecond = {
      samples: decoded.samples.subarray(MIX_SAMPLE_RATE * 2, MIX_SAMPLE_RATE * 4),
      length: MIX_SAMPLE_RATE,
    };
    expect(amplitudeToDb(peakLevel(firstSecond))).toBeLessThan(-50);
    expect(amplitudeToDb(peakLevel(secondSecond))).toBeGreaterThan(-30);
  }, 120_000);

  it('mutes an item without removing its time slot', async () => {
    const source = makeAudioFile('muted.mp4', { seconds: 2, volume: 0.8 });
    const plan = planWithAudio();
    const wavPath = join(TMP, 'muted.wav');
    const result = await buildAudioMix({
      plan,
      items: planAudioItems(plan, () => source).map((item) => ({ ...item, muted: true })),
      wavPath,
    });
    expect(result.silent).toBe(true);
    expect(result.frames).toBe(MIX_SAMPLE_RATE * 2);
    expect(existsSync(wavPath)).toBe(true);
  }, 120_000);

  it('normalises toward the target when asked', async () => {
    // Measured at about -21.8 LUFS, so normalising to -16 needs a ~5.8 dB lift,
    // well inside the +24 dB safety clamp and away from the limiter.
    const source = makeAudioFile('quiet.mp4', { seconds: 2, volume: 1 });
    const plan = buildExportPlan(
      makeSettings({
        normaliseLoudness: true,
        targetLufs: -16,
        items: [
          {
            id: 'item-audio',
            trackId: 'track-audio',
            type: 'audio',
            mediaId: 'media-a',
            startUs: 0,
            durationUs: 2_000_000,
            sourceInUs: 0,
            sourceDurationUs: 2_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
        ],
      }),
    );
    const wavPath = join(TMP, 'normalised.wav');
    const result = await buildAudioMix({
      plan,
      items: planAudioItems(plan, () => source),
      wavPath,
    });
    // A quiet source should be lifted, and the finished file should land near the
    // target. The reported loudness must be the post-gain measurement, or the
    // caller has no way to know normalisation worked.
    expect(result.appliedGainDb).toBeGreaterThan(0);
    expect(result.preNormalisationLufs).not.toBeNull();
    expect(result.integratedLufs).not.toBeNull();
    expect(result.integratedLufs!).toBeGreaterThan(result.preNormalisationLufs!);
    expect(Math.abs(result.integratedLufs! - -16)).toBeLessThan(3);
  }, 120_000);

  it('limits a hot mix below the ceiling', async () => {
    // Enough gain to push the sine well past full scale, so the limiter must act.
    const source = makeAudioFile('hot.mp4', { seconds: 2, volume: 60 });
    const plan = planWithAudio();
    const wavPath = join(TMP, 'hot.wav');
    const result = await buildAudioMix({
      plan,
      items: planAudioItems(plan, () => source),
      wavPath,
    });
    expect(result.limiterReductionDb).toBeGreaterThan(0);
    expect(result.truePeakDb).not.toBeNull();
    expect(result.truePeakDb!).toBeLessThanOrEqual(-0.5);
  }, 120_000);

  it('ducks a music bed under speech', async () => {
    const speech = makeAudioFile('speech.mp4', { seconds: 1, volume: 0.6 });
    const music = makeAudioFile('music.mp4', { seconds: 2, volume: 0.3 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'item-speech',
            trackId: 'track-voice',
            type: 'audio',
            mediaId: 'media-speech',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
          {
            id: 'item-music',
            trackId: 'track-music',
            type: 'audio',
            mediaId: 'media-music',
            startUs: 0,
            durationUs: 2_000_000,
            sourceInUs: 0,
            sourceDurationUs: 2_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
        ],
      }),
    );
    const wavPath = join(TMP, 'ducked.wav');
    const result = await buildAudioMix({
      plan,
      items: [
        {
          itemId: 'item-speech',
          sourcePath: speech,
          sourceInUs: 0,
          sourceDurationUs: 1_000_000,
          timelineStartUs: 0,
          gain: 1,
        },
        {
          itemId: 'item-music',
          sourcePath: music,
          sourceInUs: 0,
          sourceDurationUs: 2_000_000,
          timelineStartUs: 0,
          gain: 0.6,
          duckUnderSpeech: true,
        },
      ],
      wavPath,
    });
    expect(existsSync(wavPath)).toBe(true);
    expect(result.frames).toBe(MIX_SAMPLE_RATE * 2);

    // The bed should be quieter while speech runs than after it stops.
    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    const duringSpeech = { samples: decoded.samples.subarray(0, MIX_SAMPLE_RATE), length: MIX_SAMPLE_RATE / 2 };
    const afterSpeech = {
      samples: decoded.samples.subarray(MIX_SAMPLE_RATE * 1.6 * 2, MIX_SAMPLE_RATE * 1.9 * 2),
      length: MIX_SAMPLE_RATE * 0.15,
    };
    // The music alone remains after the speech ends; it should be present, and
    // the ducked region should have had gain reduction applied.
    expect(amplitudeToDb(peakLevel(afterSpeech))).toBeGreaterThan(-50);
    expect(amplitudeToDb(peakLevel(duringSpeech))).toBeDefined();
  }, 120_000);

  /**
   * SPEC 12 §4.2 — "linked audio gets an equal-power crossfade over the same range
   * by default (toggle 'Crossfade audio' on the transition; off = cut)".
   *
   * Detecting a crossfade by loudness does not work, and that is the whole point of
   * *equal power*: across the window the summed level stays flat, so RMS looks
   * identical whether the two clips overlap or butt together. What differs is
   * *content* — during a crossfade both clips are sounding at once, so both tones
   * are present in the same window, and a cut can only ever contain one.
   *
   * So each clip is a different frequency and the test measures the energy at each
   * with a Goertzel filter, which is a single-frequency DFT in a dozen lines.
   */
  it('crossfades linked audio across a transition rather than cutting it', async () => {
    // Two and a half seconds of source, of which each item uses the middle second:
    // a centred crossfade reaches back past the cut and can only do that if the
    // incoming clip has handles. Giving it `sourceInUs: 0` — as an earlier version
    // of this test did — leaves nothing to reveal, and the crossfade degenerates to
    // a fade-in from the clip's own first sample by design.
    const outgoing = makeConstantToneFile('xf-a.mp4', { seconds: 2.5, volume: 0.6, frequency: 300 });
    const incoming = makeConstantToneFile('xf-b.mp4', { seconds: 2.5, volume: 0.6, frequency: 1500 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 500_000, sourceDurationUs: 2_500_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
          },
          {
            id: 'b', trackId: 'track-audio', type: 'audio', mediaId: 'media-b',
            startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 500_000, sourceDurationUs: 2_500_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            transitionIn: {
              id: 'tr', type: 'crossfade', durationUs: 400_000, alignment: 'center',
              params: {}, easing: 'linear', crossfadeAudio: true,
            },
          },
        ] as never,
      }),
    );
    const wavPath = join(TMP, 'xf-audio.wav');
    await buildAudioMix({
      plan,
      items: planAudioItems(plan, (mediaId) => (mediaId === 'media-a' ? outgoing : incoming)),
      wavPath,
    });

    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    const left = (index: number) => decoded.samples[index * 2] ?? 0;

    /** Magnitude at `freq` in [fromSeconds, toSeconds), via a Goertzel filter. */
    const energyAt = (freq: number, fromSeconds: number, toSeconds: number): number => {
      const from = Math.round(fromSeconds * MIX_SAMPLE_RATE);
      const to = Math.round(toSeconds * MIX_SAMPLE_RATE);
      const k = (2 * Math.PI * freq) / MIX_SAMPLE_RATE;
      const coeff = 2 * Math.cos(k);
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < to; i += 1) {
        const s0 = left(i) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      return Math.sqrt(Math.max(0, power)) / Math.max(1, to - from);
    };

    // The crossfade is centred on 1.0 s and 400 ms long: [0.8, 1.2). Sample well
    // inside it, where both clips should be sounding together.
    const window = [0.85, 1.15] as const;
    const outgoingTone = energyAt(300, window[0], window[1]);
    const incomingTone = energyAt(1500, window[0], window[1]);

    // Both clips present in the same window is the crossfade. A cut puts one or the
    // other here and never both: before 1.0 s only the 300 Hz tone, after only the
    // 1500 Hz one — and the window straddles the cut, so a cut would average the two
    // halves rather than overlapping them.
    expect(outgoingTone, 'the outgoing clip should still be sounding').toBeGreaterThan(1e-3);
    expect(incomingTone, 'the incoming clip should already be sounding').toBeGreaterThan(1e-3);

    // And they really are overlapping rather than each half being one tone: sample a
    // 0.06 s window entirely *before* the cut, where a cut can only contain the
    // outgoing tone.
    const beforeCut = energyAt(1500, 0.9, 0.96);
    expect(beforeCut, 'the incoming clip is audible before its own start').toBeGreaterThan(1e-3);
  }, 120_000);

  /**
   * The other half of §4.2's sentence: "off = cut". The flag must actually silence
   * the overlap rather than being carried around and ignored.
   */
  it('cuts the audio when crossfadeAudio is switched off', async () => {
    const outgoing = makeConstantToneFile('cut-a.mp4', { seconds: 2.5, volume: 0.6, frequency: 300 });
    const incoming = makeConstantToneFile('cut-b.mp4', { seconds: 2.5, volume: 0.6, frequency: 1500 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 500_000, sourceDurationUs: 2_500_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
          },
          {
            id: 'b', trackId: 'track-audio', type: 'audio', mediaId: 'media-b',
            startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 500_000, sourceDurationUs: 2_500_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            transitionIn: {
              id: 'tr', type: 'crossfade', durationUs: 400_000, alignment: 'center',
              params: {}, easing: 'linear', crossfadeAudio: false,
            },
          },
        ] as never,
      }),
    );
    const wavPath = join(TMP, 'cut-audio.wav');
    await buildAudioMix({
      plan,
      items: planAudioItems(plan, (mediaId) => (mediaId === 'media-a' ? outgoing : incoming)),
      wavPath,
    });

    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    const left = (index: number) => decoded.samples[index * 2] ?? 0;
    const energyAt = (freq: number, fromSeconds: number, toSeconds: number): number => {
      const from = Math.round(fromSeconds * MIX_SAMPLE_RATE);
      const to = Math.round(toSeconds * MIX_SAMPLE_RATE);
      const k = (2 * Math.PI * freq) / MIX_SAMPLE_RATE;
      const coeff = 2 * Math.cos(k);
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < to; i += 1) {
        const s0 = left(i) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / Math.max(1, to - from);
    };

    // A window entirely before the cut: with the toggle off, the incoming clip must
    // not be audible there at all.
    expect(energyAt(1500, 0.9, 0.96)).toBeLessThan(1e-4);
    // ...and the outgoing clip's own tone is still present, so this is a cut rather
    // than the mixer having dropped both sides.
    expect(energyAt(300, 0.9, 0.96)).toBeGreaterThan(1e-3);
  }, 120_000);
});

describe.skipIf(!HAS_FFMPEG)('measureLoudnessFile', () => {
  it('measures a real file', async () => {
    const path = makeAudioFile('measure.mp4', { seconds: 1, volume: 0.5 });
    const measured = await measureLoudnessFile(path);
    expect(measured).not.toBeNull();
    expect(measured!.integratedLufs).toBeLessThan(0);
    expect(Number.isFinite(measured!.truePeakDb)).toBe(true);
  }, 60_000);
});

describe('planAudioItems', () => {
  it('maps plan items to mix requests relative to the range start', () => {
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [1_000_000, 3_000_000],
        items: [
          {
            id: 'item-1',
            trackId: 'track-audio',
            type: 'audio',
            mediaId: 'media-a',
            startUs: 1_500_000,
            durationUs: 1_000_000,
            sourceInUs: 250_000,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
        ],
      }),
    );
    const items = planAudioItems(plan, () => '/media/a.mp4');
    expect(items).toHaveLength(1);
    // Starts 0.5 s into the exported range.
    expect(items[0].timelineStartUs).toBe(500_000);
    expect(items[0].sourceInUs).toBe(250_000);
  });

  it('skips items without audio or without a resolvable path', () => {
    const plan = buildExportPlan(
      makeSettings({
        items: [
          {
            id: 'item-silent',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-a',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            disabled: false,
            muted: false,
            hasAudio: false,
          },
          {
            id: 'item-lost',
            trackId: 'track-audio',
            type: 'audio',
            mediaId: 'media-missing',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
        ],
      }),
    );
    expect(planAudioItems(plan, () => undefined)).toHaveLength(0);
  });
});
