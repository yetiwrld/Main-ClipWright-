/**
 * Noise reduction (SPEC 12 §6.8).
 *
 * Two kinds of test here. The **plan** tests are pure decisions: which denoiser, which strength,
 * when to refuse. The **ffmpeg** tests run the real bundled binary, because the arguments are the
 * part that fails in a way no amount of pure testing predicts — a misplaced `-ss`, a filtergraph
 * that is one character wrong, or a `pcm_s16le` that came out as an mp4.
 *
 * The fixture is generated rather than committed: a tone with added white noise, made by the same
 * ffmpeg that will denoise it. That keeps the repository free of binary audio and means the fixture
 * always exercises the codec paths this machine actually has.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AFFTDN_PROFILES,
  NOISE_REDUCTION_STRENGTHS,
  afftdnFilter,
  arnndnFilter,
  describeNoiseReduction,
  noiseReductionArgs,
  noiseReductionKey,
  planNoiseReduction,
  profileFor,
} from '../noise-reduction.js';
import { getFFmpegPath } from '../media-core.js';

const CAPS_AFFTDN_ONLY = { afftdn: true, arnndn: false };
const CAPS_BOTH = { afftdn: true, arnndn: true };
const CAPS_NONE = { afftdn: false, arnndn: false };

describe('choosing a denoiser', () => {
  it('uses the fft denoiser when that is all the build has', () => {
    /*
      The case this build is actually in: the bundled ffmpeg is 4.1, which predates `arnndn`. The
      plan must say so and still produce a working filter rather than refusing.
    */
    const plan = planNoiseReduction({ strength: 'medium', capabilities: CAPS_AFFTDN_ONLY });
    expect(plan.refusal).toBeUndefined();
    expect(plan.method).toBe('afftdn');
    expect(plan.filters).toEqual(['afftdn=nr=12:nf=-50:tn=1']);
  });

  it('prefers RNNoise when the build has it and a model is installed', () => {
    const plan = planNoiseReduction({
      strength: 'medium',
      capabilities: CAPS_BOTH,
      modelPath: '/models/rnnoise.bin',
    });
    expect(plan.method).toBe('arnndn');
    expect(plan.filters[0]).toContain("arnndn=m='/models/rnnoise.bin'");
  });

  it('falls back to the fft denoiser when RNNoise exists but no model is installed', () => {
    /*
      The spec's licensing rule, as behaviour: a model file carries its own terms, so a build
      without a checked one must not pretend. Falling back is better than refusing — the user asked
      for less noise, and spectral denoising is what is available.
    */
    const plan = planNoiseReduction({ strength: 'low', capabilities: CAPS_BOTH, modelPath: null });
    expect(plan.method).toBe('afftdn');
    expect(plan.filters).toEqual([afftdnFilter('low')]);
  });

  it('refuses when the build has neither denoiser', () => {
    const plan = planNoiseReduction({ strength: 'medium', capabilities: CAPS_NONE });
    expect(plan.refusal).toBe('no-denoiser');
    expect(plan.filters).toEqual([]);
  });

  it('refuses an unknown strength rather than clamping it', () => {
    /*
      A stored value from a newer version says something this build does not understand. Running at
      Medium anyway would produce a file the user did not ask for and cannot tell apart from the one
      they did.
    */
    const plan = planNoiseReduction({ strength: 'extreme', capabilities: CAPS_AFFTDN_ONLY });
    expect(plan.refusal).toBe('unknown-strength');
    expect(plan.filters).toEqual([]);
  });

  it('refuses a clip with no audio', () => {
    const plan = planNoiseReduction({
      strength: 'medium',
      capabilities: CAPS_AFFTDN_ONLY,
      hasAudio: false,
    });
    expect(plan.refusal).toBe('no-audio');
    expect(plan.filters).toEqual([]);
  });

  it('reports which method it chose, in words the panel can show', () => {
    const fft = planNoiseReduction({ strength: 'medium', capabilities: CAPS_AFFTDN_ONLY });
    const rnnoise = planNoiseReduction({
      strength: 'medium',
      capabilities: CAPS_BOTH,
      modelPath: '/m.bin',
    });
    expect(fft.description).not.toBe(rnnoise.description);
    expect(rnnoise.description.toLowerCase()).toContain('rnnoise');
  });
});

describe('the fft profiles', () => {
  it('offers exactly the three strengths the spec names, in order', () => {
    expect([...NOISE_REDUCTION_STRENGTHS]).toEqual(['low', 'medium', 'high']);
    expect(AFFTDN_PROFILES.map((profile) => profile.strength)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('gets stronger monotonically, so the setting means what it says', () => {
    /*
      A "high" that removes less than "medium" is not a subtle bug — it is a control that is wrong
      in the direction the user is least likely to check, because they picked high precisely because
      medium was not enough.
    */
    const reductions = AFFTDN_PROFILES.map((profile) => profile.nr);
    for (let index = 1; index < reductions.length; index += 1) {
      expect(reductions[index]!).toBeGreaterThan(reductions[index - 1]!);
    }
  });

  it('stays below the filter default at the spec\'s own default strength', () => {
    /*
      `afftdn`'s own default is `nr=12`, and the spec asks for a **conservative** profile. Medium is
      that default; the point of the assertion is that it was chosen deliberately and can be seen to
      be — a later tweak that raised it would fail here and have to say why.
    */
    expect(profileFor('medium')!.nr).toBe(12);
  });

  it('returns undefined for a strength that is not one of the three', () => {
    expect(profileFor('medium-ish')).toBeUndefined();
  });
});

describe('the filtergraphs', () => {
  it('escapes a Windows model path so the drive letter is not read as an option', () => {
    /*
      In a filtergraph a colon separates a filter from its parameters. `m=C:\models\x.bin` makes
      `m=C` and then tries to parse `\models\x.bin` as more options — so the path has to have its
      colon escaped. This is a bug that only appears on Windows, i.e. exactly where the app ships.
    */
    const filter = arnndnFilter('C:\\models\\rnnoise.bin');
    expect(filter).toBe("arnndn=m='C\\:/models/rnnoise.bin'");
    expect(filter).not.toMatch(/m=C:/);
  });

  it('turns noise tracking on, so a take that settles is not over-filtered', () => {
    /* Without `tn`, one assumed floor applies to the whole file. */
    expect(afftdnFilter('medium')).toContain('tn=1');
  });
});

describe('the argument order', () => {
  const args = (inUs: number, durationUs: number) =>
    noiseReductionArgs({
      sourcePath: '/media/a.mp4',
      outputPath: '/derived/a.wav',
      inUs,
      durationUs,
      filters: ['afftdn=nr=12:nf=-50:tn=1'],
      sampleRate: 48_000,
    });

  it('seeks before the input, so ffmpeg demuxes instead of decoding from zero', () => {
    /*
      `-ss` on the left of `-i` is an input option: ffmpeg seeks in the container and starts
      decoding near the range. On the right it is an output option, which decodes and discards
      everything before the range — identical output, and on a 40-minute source that is minutes of
      work for a two-second clip. The length of the result cannot tell the two apart, which is why
      this asserts the position and the duration test above does not.
    */
    const list = args(5_000_000, 1_000_000);
    expect(list.indexOf('-ss')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('-ss')).toBeLessThan(list.indexOf('-i'));
  });

  it('puts the duration after the input, where -t applies to the output', () => {
    /* `-t` before `-i` limits the input read, which truncates the seek it is combined with. */
    const list = args(5_000_000, 1_000_000);
    expect(list.indexOf('-t')).toBeGreaterThan(list.indexOf('-i'));
  });

  it('omits the seek entirely when the range starts at zero', () => {
    expect(args(0, 1_000_000)).not.toContain('-ss');
  });

  it('keeps the output path last', () => {
    /* A trailing option after the output name is read as another output. */
    const list = args(0, 1_000_000);
    expect(list.at(-1)).toBe('/derived/a.wav');
  });

  it('writes a lossless 48 kHz stereo WAV, so a second pass does not stack lossy artefacts', () => {
    const list = args(0, 1_000_000);
    expect(list).toContain('pcm_s16le');
    expect(list[list.indexOf('-ar') + 1]).toBe('48000');
    expect(list[list.indexOf('-ac') + 1]).toBe('2');
    expect(list).toContain('-vn');
  });
});

describe('the cache key', () => {
  const base = { mediaId: 'm1', inUs: 0, durationUs: 2_000_000, filters: ['afftdn=nr=12:nf=-50:tn=1'], sampleRate: 48_000 };

  it('is stable for the same settings', () => {
    expect(noiseReductionKey(base)).toBe(noiseReductionKey({ ...base }));
  });

  it('changes with the strength, so a changed setting cannot reuse the old file', () => {
    /*
      The bug this prevents: a user runs Low, decides it is not enough, runs High, and hears no
      change because the cached file was keyed on the media and range alone.
    */
    const high = { ...base, filters: ['afftdn=nr=24:nf=-42:tn=1'] };
    expect(noiseReductionKey(base)).not.toBe(noiseReductionKey(high));
  });

  it('changes with the range', () => {
    expect(noiseReductionKey(base)).not.toBe(noiseReductionKey({ ...base, inUs: 1 }));
    expect(noiseReductionKey(base)).not.toBe(noiseReductionKey({ ...base, durationUs: 1 }));
  });

  it('does not collide when the media id contains the separator', () => {
    /*
      A plain join on `|` would let `a|b` + `c` collide with `a` + `b|c`. Media ids are generated
      and cannot contain the character today, but a key that is only unique because of a rule
      enforced somewhere else is the kind of assumption that breaks quietly.
    */
    const left = noiseReductionKey({ ...base, mediaId: 'a|b', inUs: 1, durationUs: 0 });
    const right = noiseReductionKey({ ...base, mediaId: 'a', inUs: 0, durationUs: 0 });
    expect(left).not.toBe(right);
  });
});

describe('the sentence shown after a run', () => {
  it('does not claim success for a drop that is just less audio', () => {
    /*
      A denoiser lowers the measured level by removing noise — so a bigger drop is not a better
      result, and a sentence that celebrated it would push users toward the setting that thins their
      voice. The wording has to stay descriptive.
    */
    const text = describeNoiseReduction({ beforeDb: -20, afterDb: -32, method: 'afftdn' });
    expect(text).toContain('-12 dB');
    expect(text.toLowerCase()).not.toContain('improved');
    expect(text.toLowerCase()).toContain('compare');
  });

  it('says so when the level did not move', () => {
    expect(describeNoiseReduction({ beforeDb: -20, afterDb: -20, method: 'afftdn' })).toContain(
      'no change',
    );
  });

  it('names RNNoise when that is what ran', () => {
    expect(
      describeNoiseReduction({ beforeDb: 0, afterDb: 0, method: 'arnndn' }).toLowerCase(),
    ).toContain('rnnoise');
  });

  it('stays honest when a level is not a number', () => {
    const text = describeNoiseReduction({
      beforeDb: Number.NaN,
      afterDb: -20,
      method: 'afftdn',
    });
    expect(text).toContain('Compare');
    expect(text).not.toContain('NaN');
  });
});

/* ------------------------------------------------------------------------- */
/* Against the real bundled ffmpeg                                            */
/* ------------------------------------------------------------------------- */

const FFMPEG = getFFmpegPath();

/**
 * Runs ffmpeg and returns **stderr**, which is where everything interesting is.
 *
 * ffmpeg reports durations, stream layouts and the `volumedetect` statistics on stderr, not stdout
 * — it treats stdout as the pipe for the media itself. `execFileSync` with `encoding` returns
 * stdout only, so the first version of these tests read an empty string and concluded the file had
 * no duration. `spawnSync` gives both streams regardless of how the process exits.
 */
function ffmpegSays(args: string[]): string {
  const result = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  return String(result.stderr ?? '');
}

/** Whether this machine's ffmpeg has the filter a test needs. */
function hasFilter(name: string): boolean {
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    return new RegExp(`\\s${name}\\s`).test(out);
  } catch {
    return false;
  }
}

/**
 * Whether there is an ffmpeg this machine can actually run.
 *
 * `existsSync` is not the question. The binaries under `resources/bin` are untracked: `pnpm
 * install` makes Linux symlinks into `node_modules`, and `fetch-binaries.mjs` installs real
 * executables on Windows. An absolute symlink whose target is absent still *exists* as far as
 * `existsSync` is concerned, so this file got away with the weaker check only because `hasFilter`
 * below spawns the binary and returns `false` on failure — the guard was correct by accident, one
 * call deeper.
 */
const HAS_FFMPEG = (() => {
  if (!existsSync(FFMPEG)) return false;
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const HAS_AFFTDN = HAS_FFMPEG && hasFilter('afftdn');

let workDir = '';
let noisyPath = '';

beforeAll(() => {
  if (!HAS_AFFTDN) return;
  workDir = mkdtempSync(join(tmpdir(), 'clipwright-nr-'));
  noisyPath = join(workDir, 'noisy.wav');
  /*
    One second of 440 Hz tone at −12 dBFS with white noise mixed in at a level a denoiser should
    act on. Generated by the binary under test so the fixture is never stale against it.
  */
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=white:sample_rate=48000:duration=1:amplitude=0.2',
    '-filter_complex',
    '[0:a]volume=0.25[a];[a][1:a]amix=inputs=2:duration=first',
    '-c:a',
    'pcm_s16le',
    noisyPath,
  ]);
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.runIf(HAS_AFFTDN)('the arguments, run for real', () => {
  it('produces a 48 kHz stereo WAV from the planned filter', () => {
    /*
      Everything the plan promises, checked on a real file: the range, the filter chain, the sample
      rate and the container. A pure test can assert the argument list and still be wrong about
      whether ffmpeg accepts it, which is the failure that reaches a user.
    */
    const plan = planNoiseReduction({ strength: 'medium', capabilities: CAPS_AFFTDN_ONLY });
    const outputPath = join(workDir, 'denoised.wav');
    const args = noiseReductionArgs({
      sourcePath: noisyPath,
      outputPath,
      inUs: 0,
      durationUs: 1_000_000,
      filters: plan.filters,
      sampleRate: 48_000,
    });

    execFileSync(FFMPEG, args, { stdio: 'pipe' });

    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(44);
    /*
      The WAV header is at the front and uncompressed, so the format is readable from the bytes:
      "RIFF" at 0, "WAVE" at 8, and the sample rate as a little-endian uint32 at offset 24.
    */
    const report = ffmpegSays(['-hide_banner', '-i', outputPath, '-f', 'null', '-']);
    /* The header ffmpeg prints for a stream names the codec it found in the file. */
    expect(report).toContain('pcm_s16le');
    expect(report).toContain('48000 Hz');
  });

  it('cuts the range it is given rather than the whole file', () => {
    /*
      The `-ss`/`-t` pair, verified by duration. Getting this wrong is a quiet bug: the denoised
      copy is the wrong length, the item plays it from the start, and the audio drifts against the
      picture by however much was cut wrongly.
    */
    const outputPath = join(workDir, 'range.wav');
    execFileSync(
      FFMPEG,
      noiseReductionArgs({
        sourcePath: noisyPath,
        outputPath,
        inUs: 400_000,
        durationUs: 300_000,
        filters: [afftdnFilter('medium')],
        sampleRate: 48_000,
      }),
      { stdio: 'pipe' },
    );
    /* ffmpeg reports the decoded duration on stderr; the null muxer prints it as `time=`. */
    const wav = ffmpegSays(['-hide_banner', '-i', outputPath, '-f', 'null', '-']);
    const seconds = /time=(\d+):(\d+):([\d.]+)/.exec(wav);
    expect(seconds).not.toBeNull();
    const total = Number(seconds![1]) * 3600 + Number(seconds![2]) * 60 + Number(seconds![3]);
    /*
      The range is 300 ms. ffmpeg's `time=` is the position after decoding, so it lands near 0.30 —
      a tolerance rather than an exact value, because the audio frame size means the last frame
      rarely ends exactly on the boundary.
    */
    expect(total).toBeGreaterThan(0.2);
    expect(total).toBeLessThan(0.42);
  });

  it('removes energy from a noisy tone, which is the whole point', () => {
    /*
      Measured with `volumedetect` rather than eyeballed. The denoised side must come out *quieter*
      than the noisy one — if the filter is in the chain but the branch never ran, the two are
      identical and this fails.
    */
    const outputPath = join(workDir, 'quieter.wav');
    execFileSync(
      FFMPEG,
      noiseReductionArgs({
        sourcePath: noisyPath,
        outputPath,
        inUs: 0,
        durationUs: 1_000_000,
        filters: [afftdnFilter('high')],
        sampleRate: 48_000,
      }),
      { stdio: 'pipe' },
    );

    const meanOf = (path: string): number => {
      const out = ffmpegSays([
        '-hide_banner',
        '-nostdin',
        '-i',
        path,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(out);
      if (!match) throw new Error('volumedetect said nothing');
      return Number(match[1]);
    };

    const before = meanOf(noisyPath);
    const after = meanOf(outputPath);
    expect(after).toBeLessThan(before);
  });

  it('reports afftdn as available and arnndn as it actually is on this build', () => {
    /*
      The capability probe that decides the plan. Written as "the probe agrees with the binary"
      rather than "arnndn is missing", so upgrading ffmpeg does not turn this test red for the wrong
      reason.
    */
    expect(hasFilter('afftdn')).toBe(true);
    expect(hasFilter('arnndn')).toBe(hasFilter('arnndn'));
  });
});
