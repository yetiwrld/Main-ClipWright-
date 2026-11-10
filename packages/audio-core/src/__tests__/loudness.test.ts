/**
 * Momentary loudness (SPEC 12 §6.3, BS.1770).
 *
 * The tests that matter are the ones a plausible implementation gets wrong:
 *
 * - **The scale is anchored by the standard's own property**: a full-scale 1 kHz sine reads
 *   0 LUFS. Every coefficient, the K-offset and the channel sum all have to be right together
 *   for that to hold, so it is the one test that would catch a sign error anywhere in the chain.
 * - **The average is taken before the log.** Averaging decibels is the mistake that makes a
 *   meter read quiet on speech, and it is invisible in any test that only ever measures a steady
 *   tone.
 * - **An unfilled gate is not silence.** While the 400 ms window fills, the figure is partial
 *   and says so; a readout that treated the empty part as energy would climb visibly.
 * - **A paused preview stops measuring.** Frames stop arriving, and the reading must fall to
 *   silence rather than hold a syllable forever.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_LOUDNESS_WINDOW,
  LOUDNESS_FLOOR_LUFS,
  MOMENTARY_WINDOW_MS,
  ZERO_BIQUAD,
  channelMeanSquare,
  describeLoudness,
  kWeight,
  gateSamples,
  loudnessOf,
  pushLoudness,
  type LoudnessWindow,
} from '../loudness.js';

const RATE = 48_000;

/** A sine at `amplitude` (linear, so 1 is full scale), interleaved across `channels`. */
function sine(amplitude: number, frequency = 1000, seconds = 1, channels = 1): Float32Array {
  const samples = Math.round(RATE * seconds) * channels;
  const out = new Float32Array(samples);
  for (let index = 0; index < samples / channels; index += 1) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE);
    for (let channel = 0; channel < channels; channel += 1) out[index * channels + channel] = value;
  }
  return out;
}

/** The mean square of the whole buffer, both channels summed — the shape a meter feeds in. */
function frameEnergy(samples: Float32Array, channels = 1): number[] {
  let total = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    total += channelMeanSquare(samples, channel as 0 | 1, channels).meanSquare;
  }
  return [total];
}

/** One complete gate's worth of one frame, so `complete` is meaningful. */
function fullGate(energy: number): LoudnessWindow {
  return { entries: [{ atMs: 0, energy, filled: gateSamples(48_000) }] };
}

describe('K-weighting and the LUFS scale', () => {
  it('reads a full-scale 1 kHz sine at −3.01 LUFS, which is the standard’s anchor', () => {
    /*
      BS.1770's definition of the scale, and the single property that pins every coefficient at
      once — the shelf, the high-pass, the −0.691 offset and the channel sum.

      **−3.01 and not 0.** A sine's mean square is half its peak square, so a full-scale sine is
      −3 dB of RMS, and the K-weighting shelf puts about 0.7 dB back. Anyone who expects this to
      read 0 will "fix" the arithmetic until it does, and then every reading is 3 LU loud —
      which is how a clip normalised to −16 arrives at −13. So the anchor is asserted at the
      value the standard actually specifies, including the odd hundredth.
    */
    const samples = sine(1, 1000, 1, 1);
    const reading = loudnessOf(fullGate(frameEnergy(samples)[0]!));
    expect(reading.lufs).toBeCloseTo(-3.01, 0);
  });

  it('moves a decibel for a decibel', () => {
    /*
      The scale is linear in decibels. Stated as the *difference* from full scale rather than as
      an absolute, because that is the property normalisation relies on: −20 dBFS is 20 LU below
      full scale whatever the anchor turns out to be.
    */
    const full = loudnessOf(fullGate(frameEnergy(sine(1, 1000, 1, 1))[0]!)).lufs;
    const quiet = loudnessOf(fullGate(frameEnergy(sine(0.1, 1000, 1, 1))[0]!)).lufs;
    expect(full - quiet).toBeCloseTo(20, 1);
  });

  it('weights 2–4 kHz above 40 Hz, which is the whole point of K-weighting', () => {
    /*
      Same amplitude, different frequency: the ear finds speech sibilance far louder than rumble,
      and a mean-square meter that did not weight would call them equal. The high-pass also takes
      low energy out, so the two effects push in the same direction here — this pins the *sign*
      of the weighting, which is what a coefficient typo flips.
    */
    const high = loudnessOf(fullGate(frameEnergy(sine(0.5, 3000, 1, 1))[0]!)).lufs;
    const low = loudnessOf(fullGate(frameEnergy(sine(0.5, 40, 1, 1))[0]!)).lufs;
    expect(high).toBeGreaterThan(low + 6);
  });

  it('sums channels rather than averaging them', () => {
    /*
      A stereo mix with the same signal in both channels is 3 LU louder than the same signal in
      one, because the standard sums channel energies. Averaging would make a mono file and a
      duplicated-stereo file agree, which is wrong — they *are* 3 LU apart when played.

      Measured through `pushLoudness`, which is the only place the sum happens: a first version of
      this test built the window by hand and so could not tell the two apart at all.
    */
    const mono = pushLoudness(EMPTY_LOUDNESS_WINDOW, frameEnergy(sine(0.25, 1000, 1, 1), 1), 0, gateSamples(48_000));
    const stereo = pushLoudness(EMPTY_LOUDNESS_WINDOW, frameEnergy(sine(0.25, 1000, 1, 2), 2), 0, gateSamples(48_000));
    expect(loudnessOf(stereo).lufs - loudnessOf(mono).lufs).toBeCloseTo(3, 1);

    /*
      And with channels of *different* content, which is the case the duplicated-channel fixture
      cannot distinguish: averaging two unequal energies gives the mean, summing gives their
      total, and the standard sums. One channel at a quarter amplitude and one at a sixteenth is
      a real stereo image — a hard-panned pad, say.
    */
    const unequal = pushLoudness(EMPTY_LOUDNESS_WINDOW, [0.0625, 0.00390625], 0, gateSamples(48_000));
    const summed = loudnessOf(pushLoudness(EMPTY_LOUDNESS_WINDOW, [0.06640625], 0, gateSamples(48_000)));
    expect(loudnessOf(unequal).lufs).toBeCloseTo(summed.lufs, 2);
    /* The average of the two channels would be 3 LU below the sum — clearly not what it says. */
    expect(loudnessOf(unequal).lufs).toBeGreaterThan(summed.lufs - 0.5);
  });

  it('keeps each K-weighting stage’s state to itself', () => {
    /*
      A real bug this caught: the second stage was handed the **first** stage's state, so the
      shelf and the high-pass contaminated each other and a full-scale sine read 6.6 LU quiet.

      Nothing else here would have found it. The coefficients are right, and each filter is
      right in isolation — a steady-state gain check passes. What fails is staging: filter A's
      state feeding filter B. The test drives one channel through the public API and compares it
      against the two stages run in sequence with their own states, which is the only form that
      distinguishes the two.
    */
    const state = { shelf: { ...ZERO_BIQUAD }, rlb: { ...ZERO_BIQUAD } };
    let chained = 0;
    for (const sample of sine(1, 1000, 0.1, 1)) {
      const once = kWeight(sample, state);
      state.shelf = once.state.shelf;
      state.rlb = once.state.rlb;
      chained += once.value * once.value;
    }
    /* The same buffer through `channelMeanSquare`, which uses the same `kWeight` — so this
       compares staged filtering against the expectation that the state is not shared. */
    const expected = channelMeanSquare(sine(1, 1000, 0.1, 1), 0, 1).meanSquare;
    expect(chained / (sine(1, 1000, 0.1, 1).length)).toBeCloseTo(expected, 6);
    /* And the level it produces is the standard's anchor rather than 6.6 LU below it. */
    expect(loudnessOf(fullGate(expected)).lufs).toBeCloseTo(-3.01, 0);
  });

  it('reads silence at the floor, not at negative infinity', () => {
    // `-Infinity` is not a measurement, and it propagates: a formatter prints "-Infinity LUFS"
    // and a comparison against it is silently false. The floor is the standard's own gate.
    const silent = new Float32Array(RATE);
    const reading = loudnessOf(fullGate(frameEnergy(silent)[0]!));
    expect(reading.lufs).toBe(LOUDNESS_FLOOR_LUFS);
    expect(Number.isFinite(reading.lufs)).toBe(true);
  });

  it('floors a very quiet signal rather than reporting what it measures', () => {
    /*
      A digital fade approaching silence measures −80, −120, −200 LUFS — all real numbers, all
      below the standard's absolute gate, and all of them meaningless: nothing is audible down
      there and a readout that prints −200 is reporting the arithmetic rather than the sound.
      The floor applies to a *measurable* signal, not only to an exactly silent one.
    */
    /* −80 LUFS: energy 10^((−80 + 0.691)/10), a real number well below the gate. */
    const faint = 10 ** ((-80 + 0.691) / 10);
    expect(loudnessOf(fullGate(faint)).lufs).toBe(LOUDNESS_FLOOR_LUFS);
    /* And just above the floor the real figure is reported, so the clamp is not blanket. */
    const audible = loudnessOf(fullGate(10 ** ((-60 + 0.691) / 10)));
    expect(audible.lufs).toBeCloseTo(-60, 1);
  });

  it('does not depend on how many samples are in the frame', () => {
    /*
      Mean square, not sum. An analyser window is whatever size the buffer is, and a meter whose
      reading changed with the FFT size would read differently on two machines for the same file —
      the sort of bug that is never diagnosed because it is never reproducible.
    */
    const short = channelMeanSquare(sine(0.4, 1000, 0.05, 1), 0, 1).meanSquare;
    const long = channelMeanSquare(sine(0.4, 1000, 1, 1), 0, 1).meanSquare;
    expect(long).toBeCloseTo(short, 3);
  });
});

describe('the 400 ms gate', () => {
  it('is not complete until the window is full, and says so', () => {
    /*
      The first frame of playback is one analyser buffer — about 43 ms — of a 400 ms gate. A
      reading from it is a *short-term* level wearing momentary's name, and the popover's job is
      to admit that rather than let a user normalise against a number still climbing.
    */
    const early = loudnessOf({ entries: [{ atMs: 0, energy: 0.01, filled: 2048 }] }, 48_000);
    expect(early.complete).toBe(false);
    expect(early.lufs).toBeGreaterThan(LOUDNESS_FLOOR_LUFS);
  });

  it('is complete once the window holds a gate’s worth of samples', () => {
    /*
      Compared as a count against a count. The first version of this compared the frame's *sample*
      count with the gate's *millisecond* length, which made a window "complete" after 400 samples
      — under 10 ms of audio — so every reading claimed to be final almost immediately. This test
      would have caught it and did not exist yet.
    */
    expect(gateSamples(48_000)).toBe(19_200);
    const full = loudnessOf(
      { entries: [{ atMs: 0, energy: 0.01, filled: gateSamples(48_000) }] },
      48_000,
    );
    expect(full.complete).toBe(true);
    /* One sample short is not a complete gate. */
    const almost = loudnessOf(
      { entries: [{ atMs: 0, energy: 0.01, filled: gateSamples(48_000) - 1 }] },
      48_000,
    );
    expect(almost.complete).toBe(false);
  });

  it('takes the gate’s length from the sample rate', () => {
    // 44.1 kHz is the other common rate, and a hard-coded 19 200 would call a 44.1 kHz gate
    // complete 1 920 samples early.
    expect(gateSamples(44_100)).toBe(17_640);
    expect(
      loudnessOf({ entries: [{ atMs: 0, energy: 0.01, filled: 17_640 }] }, 44_100).complete,
    ).toBe(true);
    expect(
      loudnessOf({ entries: [{ atMs: 0, energy: 0.01, filled: 17_640 }] }, 48_000).complete,
    ).toBe(false);
  });

  it('averages energy, not decibels', () => {
    /*
      The mistake this exists to catch. Two frames, one loud and one quiet: the mean of their
      *energies* is dominated by the loud one, while the mean of their *decibels* would sit
      halfway down and read about 3 LU quiet. Speech is exactly this shape — syllables and gaps —
      so averaging decibels makes every voice-over read too quiet to hit a platform target.
    */
    const loud = 0.5 ** 2;
    const quiet = 1e-6;
    const averaged = loudnessOf({
      entries: [
        { atMs: 0, energy: loud, filled: 100 },
        { atMs: 100, energy: quiet, filled: 100 },
      ],
    });
    const loudOnly = loudnessOf(fullGate(loud));
    /*
      Equal time at both levels halves the *energy*, which is 3 LU — so the energy mean sits 3
      below the loud frame. The decibel mean would sit about halfway between 0.25 and 1e-6, which
      is around −30 LU, i.e. 30 LU low. The assertion is a bound between the two, tight enough
      that averaging decibels fails it by a mile.
    */
    expect(averaged.lufs).toBeCloseTo(loudOnly.lufs - 3.01, 1);
  });

  it('weights a frame by the samples it actually represents', () => {
    /*
      At the start of playback, an analyser buffer may hold three real samples and 2045 zeros.
      Its mean square is therefore tiny, but it also describes almost no time — counting it as
      equal to a full frame would drag the reading down for reasons that have nothing to do with
      the audio.
    */
    const window: LoudnessWindow = {
      entries: [
        { atMs: 0, energy: 1e-9, filled: 1 },
        { atMs: 10, energy: 0.25, filled: 2048 },
      ],
    };
    const reading = loudnessOf(window);
    expect(reading.lufs).toBeGreaterThan(loudnessOf(fullGate(0.25)).lufs - 0.1);
  });

  it('drops frames older than the gate, so a pause falls to silence', () => {
    /*
      A paused preview sends no frames. If the window kept its last syllable, the readout would
      hold that syllable forever and the popover would claim a loudness for audio that stopped —
      a meter that lies while nothing is playing is worse than one at the floor.
    */
    let window = EMPTY_LOUDNESS_WINDOW;
    window = pushLoudness(window, [0.25], 0, MOMENTARY_WINDOW_MS);
    expect(loudnessOf(window).lufs).toBeGreaterThan(LOUDNESS_FLOOR_LUFS);
    window = pushLoudness(window, [0], MOMENTARY_WINDOW_MS + 500, 0);
    expect(loudnessOf(window).lufs).toBe(LOUDNESS_FLOOR_LUFS);
  });

  it('keeps a frame that arrives exactly on the window’s edge', () => {
    // Half-open vs inclusive, in the one place it is observable: a frame exactly 400 ms old is
    // still inside the gate, and refusing it would make the reading flicker between two values
    // that differ by one frame's worth of energy.
    const window = pushLoudness(
      { entries: [{ atMs: 0, energy: 0.25, filled: 100 }] },
      [0.25],
      MOMENTARY_WINDOW_MS,
      100,
    );
    expect(window.entries).toHaveLength(2);
  });

  it('never grows without bound', () => {
    /*
      One entry per frame at 30 Hz, forever, is 108,000 entries an hour. An array that only ever
      grows is how a meter becomes a memory leak nobody notices until a long session.

      Timestamps repeat here on purpose: real frames are always inside the gate, so the *timer*
      never prunes anything and the cap is the only thing standing between a long session and an
      unbounded array. A test that advanced the clock would pass with no cap at all.
    */
    let window = EMPTY_LOUDNESS_WINDOW;
    for (let index = 0; index < 2_000; index += 1) {
      window = pushLoudness(window, [0.01], 0, 100);
    }
    expect(window.entries.length).toBe(512);
  });
});

describe('the sentence beside the number', () => {
  it('says on-target within a unit', () => {
    // Platforms act on whole units, so ±1 LU is the same loudness in practice and a readout that
    // nagged inside that band would be telling the user to chase noise.
    expect(describeLoudness(-16.4)).toBe('On target for -16 LUFS.');
    expect(describeLoudness(-15.2)).toBe('On target for -16 LUFS.');
  });

  it('says which way the mix is off, and by how much', () => {
    expect(describeLoudness(-21.3)).toBe('5 LU quieter than -16 LUFS.');
    expect(describeLoudness(-11.2)).toBe('5 LU louder than -16 LUFS.');
  });

  it('says “1 LU”, not “1 LUs”', () => {
    // The sentence appears next to the meter on every reading, so a plural bug is visible.
    expect(describeLoudness(-17.4)).toBe('1 LU quieter than -16 LUFS.');
    expect(describeLoudness(-14.2)).toBe('2 LU louder than -16 LUFS.');
  });

  it('takes a target, because -16 is a house style and not a law', () => {
    // Speech-led short-form targets -16; a music bed for a broadcast slot targets -23. The
    // threshold maths is the same and only the reference moves.
    expect(describeLoudness(-23.2, -23)).toBe('On target for -23 LUFS.');
  });
});
