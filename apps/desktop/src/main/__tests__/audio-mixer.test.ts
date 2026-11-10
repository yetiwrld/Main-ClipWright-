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
      /*
        `volume=` is a *multiplier*, not a target level: passing 0.6 produced a file
        peaking at 0.08 rather than 0.6, because the sine the filter generates is
        already well below full scale. The ratio below is measured — a raw sine
        peaks around 0.125 — so this lands near 0.6 whatever the frequency.
      */
      '-af', `volume=${(volume * 4.8).toFixed(3)}`,
      /*
        Lossless PCM on purpose. An AAC source answers a one-second read with 47104
        frames (46 whole 1024-sample packets) and `fitLength` pads the missing 896
        with silence, which turns every intended hard cut into a 19 ms gap — no step
        left to measure. WAV returns exactly the frames asked for.
      */
      '-ac', '2', '-c:a', 'pcm_s16le',
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

  /**
   * SPEC 12 §6.2 — Gain, Pan and the fades, which the inspector has offered since the
   * audio section was built.
   *
   * The same shape of bug the keyframe test above describes, five more times: the
   * schema declared `gainDb`, `pan`, `fadeInUs`, `fadeOutUs` and `fadeCurve`, the
   * inspector wrote them, the mixer's `applyItemProcessing` applied them — and
   * `planAudioItems` carried none of them onto the request. The mixer then used its own
   * `?? ` fallbacks (0 dB, centre, no fade, equal-power), so **every one of those
   * controls was inert in the export** while looking connected. Measured through the
   * real mixer rather than by inspecting the request, because the request is the half
   * that was already right.
   */
  it('applies clip gain from the item, not just from a keyframe line', async () => {
    const source = makeConstantToneFile('gain.wav', { seconds: 1, volume: 0.6, frequency: 300 });

    /** Peak amplitude of the rendered mix for one item at one clip gain. */
    const renderPeak = async (gainDb: number): Promise<number> => {
      const plan = buildExportPlan(
        makeSettings({
          rangeUs: [0, 1_000_000],
          items: [
            {
              id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
              startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
              gainDb,
              disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            },
          ] as never,
        }),
      );
      const wavPath = join(TMP, `gain-${gainDb}.wav`);
      await buildAudioMix({ plan, items: planAudioItems(plan, () => source), wavPath });
      const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE);
      return peakLevel({ samples: decoded.samples, length: decoded.length });
    };

    const unity = await renderPeak(0);
    const cut = await renderPeak(-6);
    expect(unity, 'the fixture has signal to attenuate').toBeGreaterThan(0.05);
    /*
      −6 dB is a factor of 0.501 in amplitude. Asserted as a *ratio* with a tolerance
      rather than against an absolute level, so the fixture's own loudness cannot make
      a broken implementation look right: the value that has to change is the one the
      control controls.
    */
    expect(cut / unity).toBeCloseTo(Math.pow(10, -6 / 20), 2);
  }, 120_000);

  it('pans hard left and hard right, from the stored percentage', async () => {
    const source = makeConstantToneFile('pan.wav', { seconds: 1, volume: 0.6, frequency: 300 });

    /** Peak per channel for one item at one stored pan. */
    const renderChannels = async (pan: number): Promise<{ left: number; right: number }> => {
      const plan = buildExportPlan(
        makeSettings({
          rangeUs: [0, 1_000_000],
          items: [
            {
              id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
              startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
              pan,
              disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            },
          ] as never,
        }),
      );
      const wavPath = join(TMP, `pan-${pan}.wav`);
      await buildAudioMix({ plan, items: planAudioItems(plan, () => source), wavPath });
      const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE);
      let left = 0;
      let right = 0;
      for (let index = 0; index < decoded.length; index += 1) {
        left = Math.max(left, Math.abs(decoded.samples[index * 2] ?? 0));
        right = Math.max(right, Math.abs(decoded.samples[index * 2 + 1] ?? 0));
      }
      return { left, right };
    };

    /*
      The unit matters as much as the wiring: the project stores −100…+100 and the mixer
      wants −1…+1. A missing division would clamp every pan to hard-left or hard-right,
      and a test asserting only "the channels differ" would pass on that.
    */
    const left = await renderChannels(-100);
    expect(left.left, 'hard left keeps the left channel').toBeGreaterThan(left.right * 50);

    const right = await renderChannels(100);
    expect(right.right, 'hard right keeps the right channel').toBeGreaterThan(right.left * 50);

    const centre = await renderChannels(0);
    // Constant power with the mixer's √2 normalisation: centre is unity in both channels.
    expect(centre.left / centre.right).toBeCloseTo(1, 2);

    /*
      A *partial* pan is the case that pins the unit, and it is here because the first
      version of this test did not have it and a mutation survived. Treating −100…+100
      as if it were already −1…+1 clamps every non-zero value to a hard edge, and
      hard-left and hard-right look identical under that bug — only a pan that is meant
      to be half-way reveals it. `+50` must be 0.5, whose constant-power coefficients
      are cos(3π/8) ≈ 0.383 left and sin(3π/8) ≈ 0.924 right, so the right channel is
      about 2.4× the left; clamped to hard right it would be ~50×.
    */
    const halfRight = await renderChannels(50);
    const ratio = halfRight.right / halfRight.left;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio, 'a half-right pan is not a hard-right one').toBeLessThan(5);
  }, 120_000);

  it('fades an item in and out over the lengths the item stores', async () => {
    const source = makeConstantToneFile('fade.wav', { seconds: 2, volume: 0.6, frequency: 300 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 2_000_000, sourceInUs: 0, sourceDurationUs: 2_000_000,
            fadeInUs: 1_000_000, fadeOutUs: 1_000_000, fadeCurve: 'linear',
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
          },
        ] as never,
      }),
    );
    const wavPath = join(TMP, 'fade.wav');
    await buildAudioMix({ plan, items: planAudioItems(plan, () => source), wavPath });
    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);

    const peakBetween = (fromSeconds: number, toSeconds: number): number => {
      let peak = 0;
      for (let index = Math.round(fromSeconds * MIX_SAMPLE_RATE); index < Math.round(toSeconds * MIX_SAMPLE_RATE); index += 1) {
        peak = Math.max(peak, Math.abs(decoded.samples[index * 2] ?? 0));
      }
      return peak;
    };

    const start = peakBetween(0, 0.05);
    const middle = peakBetween(0.95, 1.05);
    const end = peakBetween(1.95, 2);
    /*
      A linear fade over a second, so the opening 50 ms is at most 5% of full level and
      the middle is at full. The ratio is the assertion: an implementation that ignored
      the fades renders all three windows at the same level.
    */
    expect(start).toBeLessThan(middle * 0.2);
    expect(end).toBeLessThan(middle * 0.2);
    expect(middle, 'the middle is untouched by either fade').toBeGreaterThan(0.05);
  }, 120_000);

  it('uses the item\'s fade curve, not the default one', async () => {
    /*
      The fifth property lost on the same path. The inspector offers Linear, Equal-power
      and Exponential; `applyItemProcessing` defaults to equal-power; `planAudioItems`
      and the mixer's own call never passed the stored curve. A *linear* fade therefore
      exported as an equal-power one — different enough to hear, and different enough to
      measure: at the midpoint of the fade the two are 0.5 and 0.7071.

      Measured at the top of the rendered output rather than by reading the request,
      because "a request carries `linear`" and "the file fades linearly" are two claims
      and only the second one is the feature.
    */
    const source = makeConstantToneFile('curve.wav', { seconds: 2, volume: 0.6, frequency: 300 });

    const renderAtMidFade = async (fadeCurve: 'linear' | 'equal-power'): Promise<number> => {
      const plan = buildExportPlan(
        makeSettings({
          rangeUs: [0, 2_000_000],
          items: [
            {
              id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
              startUs: 0, durationUs: 2_000_000, sourceInUs: 0, sourceDurationUs: 2_000_000,
              // A one-second fade in, sampled at its midpoint — where 0.5 and 0.7071 are
              // far enough apart that no rounding can confuse them.
              fadeInUs: 1_000_000, fadeCurve,
              disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            },
          ] as never,
        }),
      );
      const wavPath = join(TMP, `curve-${fadeCurve}.wav`);
      await buildAudioMix({ plan, items: planAudioItems(plan, () => source), wavPath });
      const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
      // Peak across a window around the midpoint, so a single zero-crossing cannot decide it.
      let peak = 0;
      for (let index = Math.round(0.48 * MIX_SAMPLE_RATE); index < Math.round(0.52 * MIX_SAMPLE_RATE); index += 1) {
        peak = Math.max(peak, Math.abs(decoded.samples[index * 2] ?? 0));
      }
      return peak;
    };

    const linear = await renderAtMidFade('linear');
    const equalPower = await renderAtMidFade('equal-power');
    expect(linear, 'the fixture has signal').toBeGreaterThan(0.01);
    /*
      linear / equal-power = 0.5 / 0.7071 = 0.7071 at the midpoint. Asserting the ratio
      rather than the levels keeps the fixture's own loudness out of the result.
    */
    expect(linear / equalPower).toBeCloseTo(0.7071, 1);
    // And a file that ignored the curve would give exactly 1 for this ratio.
    expect(Math.abs(linear / equalPower - 1)).toBeGreaterThan(0.2);
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

  /**
   * SPEC 12 §6 — "volume line keyframes".
   *
   * The envelope in `@clipwright/audio-core` has always accepted volume keyframes
   * and `applyItemProcessing` has always forwarded them, but `planAudioItems` never
   * read them off the plan and `AudioItemRequest` had no field to carry them. So a
   * keyframed volume line was drawn in the UI, stored in the project, and then
   * ignored by the export — the clip played at its static level throughout.
   *
   * Measured as loudness either side of the midpoint: a constant source with a ramp
   * from full to silence must be loud early and quiet late. Sampling one instant
   * would not do, because the *static* value is what a broken implementation
   * replays, and that is flat.
   */
  it('follows a volume keyframe line rather than the static level', async () => {
    const source = makeConstantToneFile('keyed.wav', { seconds: 2, volume: 0.6, frequency: 300 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 2_000_000, sourceInUs: 0, sourceDurationUs: 2_000_000,
            // The static level is full, so a renderer that ignored the keys would be
            // equally loud at both sample points.
            volumeDb: 0,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            keyframes: {
              // Item-local times: the item starts at 0, so these are also timeline
              // times here. 0 dB → silence across the clip.
              volumeDb: [
                { timeUs: 0, value: 0, interpolation: 'linear' },
                { timeUs: 2_000_000, value: -60, interpolation: 'linear' },
              ],
            },
          },
        ] as never,
      }),
    );
    const wavPath = join(TMP, 'keyed.wav');
    await buildAudioMix({
      plan,
      items: planAudioItems(plan, () => source),
      wavPath,
    });

    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    /** Peak amplitude in a window, which is what "how loud is it" means here. */
    const peakBetween = (fromSeconds: number, toSeconds: number): number => {
      const from = Math.round(fromSeconds * MIX_SAMPLE_RATE);
      const to = Math.round(toSeconds * MIX_SAMPLE_RATE);
      let peak = 0;
      for (let index = from; index < to; index += 1) {
        peak = Math.max(peak, Math.abs(decoded.samples[index * 2] ?? 0));
      }
      return peak;
    };

    const early = peakBetween(0.05, 0.25);
    const late = peakBetween(1.7, 1.9);
    expect(early, 'the clip is at its keyed level at the start').toBeGreaterThan(0.1);
    /*
      −60 dB is the envelope's silence floor, so the tail must be essentially gone.
      The bound is generous against the AAC-free WAV fixture and the de-click taper,
      but it is nowhere near the static level: a renderer that replayed `volumeDb`
      would give the same peak at both ends.
    */
    expect(late, `the keyed line should have faded out, got ${late.toFixed(4)}`).toBeLessThan(early * 0.2);
  }, 120_000);

  it('shifts volume keyframes into timeline time when the clip does not start at zero', () => {
    /*
      Keyframe times are stored *local* to the item; the envelope is evaluated against
      absolute mix time. Getting the shift wrong is silent: the whole volume line
      rides along with the clip's position, so it looks right on the clip and wrong in
      the file — and a fixture starting at zero cannot detect it, because the shift is
      the identity there.
    */
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 4_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            // Starts 1.5 s in, with a key at local 0 that must land at 1.5 s.
            startUs: 1_500_000, durationUs: 1_000_000,
            sourceInUs: 0, sourceDurationUs: 1_000_000,
            volumeDb: 0, disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            keyframes: {
              volumeDb: [
                { timeUs: 0, value: -12, interpolation: 'linear' },
                { timeUs: 1_000_000, value: 0, interpolation: 'linear' },
              ],
            },
          },
        ] as never,
      }),
    );
    const requests = planAudioItems(plan, () => 'media.wav');
    const keys = requests[0]!.keyframes ?? [];
    expect(keys.map((key) => key.timeUs)).toEqual([1_500_000, 2_500_000]);
    // The values ride along unchanged; only the times move.
    expect(keys.map((key) => key.valueDb)).toEqual([-12, 0]);
  });

  it('leaves a clip with no volume keys without a keyframe list', () => {
    // An empty array and "no list" must not be the same thing downstream: the
    // envelope treats a present-but-empty list as "no keyframes", but passing one
    // around costs an allocation per item on every export.
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 1_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
          },
        ] as never,
      }),
    );
    const requests = planAudioItems(plan, () => 'media.wav');
    expect(requests[0]!.keyframes).toBeUndefined();
  });

  it('ignores a non-numeric volume keyframe rather than writing NaN into the gain', () => {
    /*
      The schema lets a keyframe's value be an RGBA tuple, and a project edited by
      another tool could put one on `volumeDb`. Converting it to a number would give
      NaN, and NaN multiplies through the gain into every sample — the whole export
      comes out silent with no error anywhere.
    */
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 1_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            keyframes: {
              volumeDb: [
                { timeUs: 0, value: [1, 0, 0, 1], interpolation: 'linear' },
                { timeUs: 500_000, value: -6, interpolation: 'linear' },
              ],
            },
          },
        ] as never,
      }),
    );
    const requests = planAudioItems(plan, () => 'media.wav');
    const keys = requests[0]!.keyframes ?? [];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.valueDb).toBe(-6);
    expect(keys.every((key) => Number.isFinite(key.valueDb))).toBe(true);
  });

  /*
    The ducking test used to live here, and it was vacuous twice over —
    `expect(amplitudeToDb(...)).toBeDefined()` is true of every number. Its replacement is the
    `describe` block further down, *"a music bed that ducks under speech"*, which measures the
    bed's own frequency with a Goertzel filter and includes a flat control. Rewriting it in place
    would have kept the same window choices, which are what let the padded-trigger bug hide: there
    was never a window comparing the bed under speech with the bed after it.
  */


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
    const outgoing = makeConstantToneFile('xf-a.wav', { seconds: 2.5, volume: 0.6, frequency: 300 });
    const incoming = makeConstantToneFile('xf-b.wav', { seconds: 2.5, volume: 0.6, frequency: 1500 });
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

    /*
      Overlap alone does not prove an *equal-power* crossfade: multiplying both clips
      by 1 leaves them overlapping too, only twice as loud in the middle. The
      envelope's defining property is that the summed power stays constant, so the
      RMS through the window has to match the RMS of either clip alone rather than
      climb to sqrt(2) times it. Measured on the outgoing clip before the window
      opens, where nothing overlaps.
    */
    const rmsIn = (fromSeconds: number, toSeconds: number): number => {
      const from = Math.round(fromSeconds * MIX_SAMPLE_RATE);
      const to = Math.round(toSeconds * MIX_SAMPLE_RATE);
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += left(i) * left(i);
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const soloRms = rmsIn(0.5, 0.75);
    const overlapRms = rmsIn(window[0], window[1]);
    const ratio = overlapRms / soloRms;
    expect(ratio, `overlap/solo RMS ${ratio.toFixed(3)} should stay near 1`).toBeGreaterThan(0.85);
    expect(ratio, `overlap/solo RMS ${ratio.toFixed(3)} should stay near 1`).toBeLessThan(1.15);
  }, 120_000);

  /**
   * SPEC 12 §12 item 8 — "click-free edits". A hard cut between two clips whose
   * audio is unrelated is a step in the mix, and a step is a click. This measures
   * the largest sample-to-sample jump around the splice.
   *
   * Two *unrelated* tones are essential: identical material joins seamlessly and the
   * test could not fail, which is the trap the earlier crossfade test fell into.
   */
  it('tapers a hard cut so it does not click', async () => {
    /*
      The two tones both start at phase 0 and the clip is exactly one second, so each
      ends a whole number of cycles in — meaning the *natural* step at the splice is
      small whatever the frequencies are. The real click comes from the source not
      starting at a zero crossing, which `sourceInUs` can produce: offsetting the
      second clip mid-cycle puts a large discontinuity there for the taper to remove.
    */
    // Two seconds of source for a one-second item: the second clip is offset by a
    // quarter cycle, so it needs to read past where a one-second file would end.
    const first = makeConstantToneFile('dc-a.wav', { seconds: 2, volume: 0.6, frequency: 300 });
    const second = makeConstantToneFile('dc-b.wav', { seconds: 2, volume: 0.6, frequency: 100 });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'a', trackId: 'track-audio', type: 'audio', mediaId: 'media-a',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 2_000_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
          },
          {
            id: 'b', trackId: 'track-audio', type: 'audio', mediaId: 'media-b',
            startUs: 1_000_000, durationUs: 1_000_000,
            // 1/400 s into a 100 Hz tone is a quarter cycle — the waveform is at its
            // peak, so the splice lands on the largest step the material can give.
            sourceInUs: 2_500, sourceDurationUs: 2_000_000,
            disabled: false, muted: false, hasAudio: true, trackOrder: 0,
            // No transition at all: this is the hard cut the taper is for.
          },
        ] as never,
      }),
    );
    const wavPath = join(TMP, 'declick.wav');
    await buildAudioMix({
      plan,
      items: planAudioItems(plan, (mediaId) => (mediaId === 'media-a' ? first : second)),
      wavPath,
    });

    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    const at = (i: number) => decoded.samples[i * 2] ?? 0;

    /** Largest sample-to-sample step in a window, relative to the largest in the programme. */
    const stepAround = (centreSeconds: number, halfWidthSeconds: number): number => {
      const centre = Math.round(centreSeconds * MIX_SAMPLE_RATE);
      const half = Math.round(halfWidthSeconds * MIX_SAMPLE_RATE);
      let worst = 0;
      for (let i = centre - half; i < centre + half; i += 1) {
        worst = Math.max(worst, Math.abs(at(i) - at(i - 1)));
      }
      return worst;
    };


    /*
      The bound is measured from the taper itself rather than derived: compute the
      largest finite difference a raised-cosine ramp of this length can produce, at
      the mix rate, for a 0.6-amplitude signal. Deriving it on paper went wrong
      twice (the closed form is `π/2N` per sample of the *envelope*, which is a
      different quantity from the second difference), so the test asks the same
      arithmetic the implementation uses instead of restating it.
    */
    const rampSamples = Math.round(0.002 * MIX_SAMPLE_RATE);
    let envelopeStep = 0;
    for (let k = 0; k + 1 < rampSamples; k += 1) {
      const a = 0.5 - 0.5 * Math.cos((Math.PI * (k + 0.5)) / rampSamples);
      const b = 0.5 - 0.5 * Math.cos((Math.PI * (k + 1.5)) / rampSamples);
      envelopeStep = Math.max(envelopeStep, Math.abs(b - a));
    }
    // The signal is a tone times that envelope, so its own per-sample motion adds
    // to the ramp's. `ownSlope` measures that directly.
    const ownSlope = stepAround(0.5, 0.01);
    const bound = envelopeStep * 0.6 + ownSlope;
    const atCut = stepAround(1.0, 0.005);
    expect(atCut, `step at the cut ${atCut.toFixed(4)} vs bound ${bound.toFixed(4)}`).toBeLessThan(
      bound,
    );
  }, 120_000);

  /**
   * The other half of §4.2's sentence: "off = cut". The flag must actually silence
   * the overlap rather than being carried around and ignored.
   */
  it('cuts the audio when crossfadeAudio is switched off', async () => {
    const outgoing = makeConstantToneFile('cut-a.wav', { seconds: 2.5, volume: 0.6, frequency: 300 });
    const incoming = makeConstantToneFile('cut-b.wav', { seconds: 2.5, volume: 0.6, frequency: 1500 });
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

describe('a music bed that ducks under speech (SPEC 12 §6.7)', () => {
  /*
    The ducking *arithmetic* has been tested since the audio slice. What had never been tested — and
    could not have passed — is that a real project ever reaches it, and this block is the third
    attempt at a test for it.

    The first two were vacuous, and each hid the next bug:

    * `expect(amplitudeToDb(...)).toBeDefined()` is true of every number, including the wrong one.
    * The trigger was built from the *padded* clip's length, so a one-second voice on a two-second
      item kept the bed ducked through a silent second. Comparing "during" with "after" at
      whole-second boundaries could not see it, because both windows were inside the reduction.

    So this measures the bed's own frequency with a Goertzel filter, in windows chosen against the
    release time rather than against round numbers, and the flat control is what proves the
    difference is the ducking and not the fixture.
  */

  /** Magnitude at `freq` between two instants, on the mix's left channel. */
  const bedEnergy = (samples: Float32Array, fromUs: number, toUs: number, frequency: number): number => {
    const from = Math.round((fromUs / 1_000_000) * MIX_SAMPLE_RATE);
    const to = Math.min(samples.length / 2, Math.round((toUs / 1_000_000) * MIX_SAMPLE_RATE));
    if (to <= from) return 0;
    const k = (2 * Math.PI * frequency) / MIX_SAMPLE_RATE;
    const coeff = 2 * Math.cos(k);
    let s1 = 0;
    let s2 = 0;
    for (let index = from; index < to; index += 1) {
      /* Interleaved stereo: the left channel is every other sample. */
      const sample = samples[index * 2] ?? 0;
      const s0 = sample + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return Math.sqrt(Math.max(0, power)) / Math.max(1, to - from);
  };

  const BED_HZ = 200;
  const VOICE_HZ = 900;

  const build = async (options: { duckUnderSpeech: boolean; name: string }) => {
    const bedSource = makeConstantToneFile('bed.wav', { seconds: 2, volume: 0.5, frequency: BED_HZ });
    const voiceSource = makeConstantToneFile('voice.wav', { seconds: 1, volume: 0.5, frequency: VOICE_HZ });
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'item-bed',
            trackId: 'track-music',
            type: 'audio',
            mediaId: 'media-bed',
            startUs: 0,
            durationUs: 2_000_000,
            sourceInUs: 0,
            sourceDurationUs: 2_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
            volumeDb: 0,
            duckUnderSpeech: options.duckUnderSpeech,
          },
          /*
            The voice occupies only the first second. The ducking release is 320 ms, so the bed is
            back to full level by about 1.4 s — and the comparison window is 1.5 s onward, clear of
            the release rather than straddling it.
          */
          {
            id: 'item-voice',
            trackId: 'track-audio',
            type: 'audio',
            mediaId: 'media-voice',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
            volumeDb: 0,
          },
        ],
      }),
    );
    const sources: Record<string, string> = { 'media-bed': bedSource, 'media-voice': voiceSource };
    const wavPath = join(TMP, `ducking-${options.name}.wav`);
    await buildAudioMix({
      plan,
      items: planAudioItems(plan, (mediaId) => sources[mediaId] ?? bedSource),
      wavPath,
    });
    const decoded = await decodeToPcm(wavPath, 0, MIX_SAMPLE_RATE * 2);
    return {
      /** The bed's own tone while the voice is running. */
      during: bedEnergy(decoded.samples, 200_000, 800_000, BED_HZ),
      /** The bed's own tone once the release has finished. */
      after: bedEnergy(decoded.samples, 1_500_000, 1_950_000, BED_HZ),
    };
  };

  it('lowers the bed while speech is present', async () => {
    /*
      Measured at the bed's frequency, so the voice contributes nothing: a 900 Hz tone has no
      energy at 200 Hz, and the whole question is what happened to the bed.
    */
    const levels = await build({ duckUnderSpeech: true, name: 'duck' });
    /* 12 dB of reduction, less the attack ramp that is still settling in this window. */
    expect(levels.during).toBeLessThan(levels.after * 0.5);
  }, 120_000);

  it('leaves the bed flat when the flag is off', async () => {
    /*
      The control. Without it a mixer that ducked everything unconditionally would pass the test
      above, and "the bed is quieter under speech" would be true of every export.
    */
    const levels = await build({ duckUnderSpeech: false, name: 'flat' });
    const ratio = levels.during / levels.after;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  }, 120_000);

  it('only ducks for as long as the item sounds, not for its padded length', async () => {
    /*
      The bug this block was written for, asserted directly.

      A voice item one second long, whose *source* has to be padded because the item claims two
      seconds, used to produce a trigger two seconds long: the bed stayed down through a silent
      second. Measured here at a point that is inside the padded span and past the release — the
      bed must be back at full level there.
    */
    const levels = await build({ duckUnderSpeech: true, name: 'span' });
    /*
      The voice is silent from 1.0 s and the release is 320 ms, so by 1.5 s the bed is at full
      level. If the trigger ran to the padded end the bed would still be down here, and `after`
      would be close to `during` instead of roughly twice it.
    */
    expect(levels.after).toBeGreaterThan(levels.during * 1.5);
  }, 120_000);

  it('forwards the flag from the item to the mixer', () => {
    /*
      The one-line gap, asserted where it lived. A plan with the field set and a request without it
      is exactly the state the project shipped in: everything downstream was correct and the value
      was dropped in between.
    */
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        items: [
          {
            id: 'item-bed',
            trackId: 'track-music',
            type: 'audio',
            mediaId: 'media-bed',
            startUs: 0,
            durationUs: 2_000_000,
            sourceInUs: 0,
            sourceDurationUs: 2_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
            duckUnderSpeech: true,
          },
        ],
      }),
    );
    const items = planAudioItems(plan, () => '/tmp/bed.mp4');
    expect(items[0]?.duckUnderSpeech).toBe(true);
  });

  it('does not mark an ordinary clip as a bed', () => {
    /* Only `true` is forwarded, so every existing request keeps its shape. */
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
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
    const items = planAudioItems(plan, () => '/tmp/a.mp4');
    expect(items[0]?.duckUnderSpeech).toBeUndefined();
  });
});

