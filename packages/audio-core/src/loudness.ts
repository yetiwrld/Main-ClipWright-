/**
 * Loudness, in LUFS (SPEC 12 §6.3 "Loudness readout (momentary LUFS)").
 *
 * The peak meter next door answers "will this clip?", which is a question about the loudest
 * sample. This answers "how loud does this sit?", which is a question about the *average* over
 * time, weighted the way the ear weights it. They disagree constantly and both are useful: a
 * quiet mix with one door slam clips, and a mix with no peaks at all can still be 10 LU too
 * quiet for a platform's normalisation.
 *
 * The algorithm is BS.1770's, in the three parts that matter for a *momentary* (400 ms)
 * reading:
 *
 * 1. **K-weighting**, a pre-filter and an RLB high-pass, so that energy at 2–4 kHz — where the
 *    ear is most sensitive, and where sibilance lives — counts for more than energy at 40 Hz.
 *    The coefficients below are the ones the standard tabulates for 48 kHz; a source at another
 *    rate gets the same filters, which is a documented approximation rather than a silent one.
 * 2. **Mean square per channel**, over the gating window.
 * 3. **Summed across channels** and converted with `-0.691 + 10 log10(Σ)`.
 *
 * The scale is the standard's, and it is worth stating what it anchors on because the intuition
 * is wrong half the time: a full-scale 997 Hz sine in **one** channel reads **−3.01 LUFS**, not
 * 0. Two things push it down — a sine's mean square is half its peak square (−3 dB), and the
 * K-weighting shelf adds back about 0.7 dB — and the −0.691 offset is tuned to that sum. In the
 * same channel, a −20 dBFS sine reads −23 LUFS, because LUFS is an RMS-like measure and −20 dBFS
 * describes a *peak*. Anyone who expects those numbers to match their peak meter will be
 * surprised, which is exactly why the readout says "LUFS" and not "dB".
 *
 * ## The window is longer than an analyser's
 *
 * An `AnalyserNode`'s time-domain buffer is 2048 samples — about 43 ms at 48 kHz, roughly a
 * ninth of the 400 ms the standard gates on. A momentary reading computed from one buffer is
 * therefore a *short-term* level mislabelled: it jumps with every syllable and reads several LU
 * below the true figure on speech, where the gaps between words pull the mean down.
 *
 * So the meter keeps a **block** — a channel-parameterised ring of already-K-weighted energy —
 * and reports the mean over as much of the window as has been filled, flagged with whether that
 * is all of it. Before the window is full the figure is honest about being provisional. This is
 * the first of the two decisions in this file that are visible to the user.
 *
 * ## The other decision: silence is not a number
 *
 * A digital-silent passage has an energy sum of zero, whose log is negative infinity. Every
 * meter in the world shows `-inf` or a floor instead, and the floor is a *policy*: `-70 LUFS` is
 * the standard's own absolute gate, and it is where the readout stops pretending to measure
 * anything rather than a meaningless −∞.
 */

/** How long a momentary reading averages over (BS.1770: 400 ms). */
export const MOMENTARY_WINDOW_MS = 400;

/**
 * The quietest figure the readout will print.
 *
 * BS.1770's absolute gate — anything below it is silence for the purpose of loudness — and
 * showing it as a number rather than `-Infinity` keeps the readout a readout. A `-inf` in a
 * meter is the same species of bug as a `NaN` in a graph: it is not a measurement.
 */
export const LOUDNESS_FLOOR_LUFS = -70;

/**
 * The constant that anchors the scale.
 *
 * `-0.691` is BS.1770's; it is what makes a full-scale 1 kHz sine read 0 LUFS, and leaving it
 * out shifts every reading by 0.7 LU — small enough to look like rounding and wrong enough that
 * a clip normalised to −16 would in fact be −15.3.
 */
const K_OFFSET = -0.691;

/**
 * K-weighting, stage 1: the high-shelf "pre-filter".
 *
 * Numerator and denominator are BS.1770's tabulated values for 48 kHz, normalised by `a0`. The
 * shelf lifts the top end by about 4 dB above 2 kHz, which is the bulk of why a LUFS reading of
 * speech is lower than its RMS.
 */
const SHELF_B = [1.53512485958697, -2.69169618940638, 1.19839281085285] as const;
const SHELF_A = [1, -1.69065929318241, 0.73248077421585] as const;

/**
 * K-weighting, stage 2: the RLB high-pass.
 *
 * Rolls off below ~38 Hz. Its job is to keep rumble and handling noise — which the ear barely
 * hears and a mean-square meter would happily count — from inflating the number.
 */
const RLB_B = [1, -2, 1] as const;
const RLB_A = [1, -1.99004745483398, 0.99007225036621] as const;

/** A biquad's two state variables. Two stages means two of these per channel. */
export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export const ZERO_BIQUAD: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };

/**
 * One biquad step, transposed direct form II.
 *
 * The transposed form because it carries two state values per stage instead of four and is the
 * one that stays stable when coefficients are retuned mid-stream — which is exactly what happens
 * when a meter keeps running across a source change.
 */
function biquad(
  sample: number,
  state: BiquadState,
  b: readonly [number, number, number],
  a: readonly [number, number, number],
): { value: number; state: BiquadState } {
  const value = (b[0]! * sample + state.x1) / a[0]!;
  const next: BiquadState = {
    x1: (b[1]! * sample - a[1]! * value + state.x2) / a[0]!,
    x2: (b[2]! * sample - a[2]! * value) / a[0]!,
    y1: 0,
    y2: 0,
  };
  return { value, state: next };
}

/** Both K-weighting stages for one channel. */
export interface KWeightState {
  shelf: BiquadState;
  rlb: BiquadState;
}

export const ZERO_K_WEIGHT: KWeightState = { shelf: ZERO_BIQUAD, rlb: ZERO_BIQUAD };

/**
 * K-weight one sample, carrying the filter state forward.
 *
 * State is threaded through the return value rather than held in a mutable object because the
 * caller — a 30 Hz meter — processes a whole analyser window per channel per frame, and a
 * stateful filter whose state is a module-level variable is one that cannot be reset, tested
 * twice in parallel, or reasoned about when a sample is skipped.
 */
export function kWeight(sample: number, state: KWeightState): { value: number; state: KWeightState } {
  const shelf = biquad(sample, state.shelf, SHELF_B, SHELF_A);
  /*
    The second stage takes the *second stage's* state. It read `shelf.state` at first — the
    shelf's state threaded into the high-pass — and the two filters then contaminated each
    other, reading a full-scale sine 6.6 LU quiet. It is the kind of bug a steady-state
    frequency-response check cannot see at all: the coefficients are right and each filter is
    right in isolation; only the state that reaches them is wrong.
  */
  const rlb = biquad(shelf.value, state.rlb, RLB_B, RLB_A);
  return { value: rlb.value, state: { shelf: shelf.state, rlb: rlb.state } };
}

/**
 * K-weight a whole buffer for one channel and return its **mean square**.
 *
 * Mean square rather than sum: the reading must not depend on how many samples happened to be
 * in the window, or a longer analyser buffer would read louder than a shorter one at the same
 * level. That is the single property that makes two meters agree, so it is worth the division.
 *
 * `channel` and `channels` select one lane out of an interleaved buffer, the same convention
 * `channelPeakDb` uses next door.
 */
export function channelMeanSquare(
  samples: Float32Array,
  channel: 0 | 1,
  channels: number,
  state: KWeightState = ZERO_K_WEIGHT,
): { meanSquare: number; state: KWeightState } {
  let sum = 0;
  let count = 0;
  let current = state;
  for (let index = channel; index < samples.length; index += channels) {
    const weighted = kWeight(samples[index] ?? 0, current);
    current = weighted.state;
    sum += weighted.value * weighted.value;
    count += 1;
  }
  return { meanSquare: count === 0 ? 0 : sum / count, state: current };
}

/**
 * A rolling window of mean-square readings, one per channel.
 *
 * The meter feeds one entry per frame; the window reports the mean over the last 400 ms. Entries
 * carry their own timestamp so a paused preview — where frames stop arriving — does not smear a
 * stale reading into a fresh one: after 400 ms of nothing, the window empties and the readout
 * falls to silence instead of holding the last syllable forever.
 */
export interface LoudnessWindow {
  /** The per-entry energy, oldest first. Each entry is the summed channel mean square. */
  entries: Array<{ atMs: number; energy: number; filled: number }>;
}

export const EMPTY_LOUDNESS_WINDOW: LoudnessWindow = { entries: [] };

/**
 * Fold one frame's per-channel mean squares into the window.
 *
 * `filled` is how many of the window's frames are real samples rather than the silence an
 * analyser reports before playback starts. Those leading zeros are **not** averaged in: a meter
 * that included them would read −20 LU on its first frame and climb over the next 400 ms, which
 * looks like the audio fading in.
 */
export function pushLoudness(
  window: LoudnessWindow,
  channelMeanSquares: readonly number[],
  nowMs: number,
  filled: number,
): LoudnessWindow {
  /*
    Energy, not power-in-dB: the mean of a set of mean squares is only the right average if it is
    taken before the log. Averaging decibels gives a quieter answer than the true one — the
    arithmetic mean of −6 and −60 dB is −33, while the energy they represent averages to −6.0.
  */
  const energy = channelMeanSquares.reduce((total, value) => total + value, 0);
  const kept = window.entries.filter((entry) => nowMs - entry.atMs <= MOMENTARY_WINDOW_MS);
  return {
    entries: [...kept, { atMs: nowMs, energy, filled }].slice(-512),
  };
}

/**
 * Mean energy across the window, weighted by how much of the gate each frame actually covers.
 *
 * The weighting is the point. An analyser frame *is* a mean square over ~43 ms, but the frames
 * arriving in one gate may each represent a different number of real samples — at the start of
 * playback, when only part of a buffer is audio. Ignoring `filled` would let three real samples
 * count as much as 2048.
 */
function windowEnergy(window: LoudnessWindow): { energy: number; filled: number } {
  let weighted = 0;
  let total = 0;
  for (const entry of window.entries) {
    if (entry.filled <= 0) continue;
    weighted += entry.energy * entry.filled;
    total += entry.filled;
  }
  return { energy: total === 0 ? 0 : weighted / total, filled: total };
}

/** What the readout shows, and how much of it to believe. */
export interface LoudnessReading {
  /** Momentary loudness in LUFS, floored at `LOUDNESS_FLOOR_LUFS`. */
  lufs: number;
  /**
   * Whether the 400 ms gate is full.
   *
   * `false` means the figure so far is a partial one, and the popover says so. Saying nothing
   * would let a user normalise against a number that is still climbing.
   */
  complete: boolean;
  /** Total samples the window currently represents, for the popover's caveat. */
  samples: number;
}

export const SILENT_READING: LoudnessReading = {
  lufs: LOUDNESS_FLOOR_LUFS,
  complete: false,
  samples: 0,
};

/** Samples per channel in one complete gate, at a given sample rate. */
export function gateSamples(sampleRate: number): number {
  return Math.round((MOMENTARY_WINDOW_MS * sampleRate) / 1000);
}

/**
 * The window's momentary loudness, or the floor when there is nothing to measure.
 *
 * A reading that is *complete* and at the floor is silence; one that is incomplete and at the
 * floor is "not yet". They are the same number and different facts, which is why `complete` is
 * part of the type rather than something a caller derives.
 */
export function loudnessOf(window: LoudnessWindow, sampleRate = 48_000): LoudnessReading {
  const { energy, filled } = windowEnergy(window);
  if (filled === 0 || energy <= 0) return SILENT_READING;
  const lufs = K_OFFSET + 10 * Math.log10(energy);
  return {
    lufs: Math.max(LOUDNESS_FLOOR_LUFS, lufs),
    /*
      Compared as a count against a count. The first version of this line compared the frame's
      *sample* count with the gate's *millisecond* length, so a window was "complete" after 400
      samples — under 10 ms of audio — and every reading claimed to be final almost immediately.
      The sample rate is a parameter because the two cannot be compared without it.
    */
    complete: filled >= gateSamples(sampleRate),
    samples: filled,
  };
}

/**
 * How a loudness figure compares to a target — the sentence the popover shows.
 *
 * The thresholds are the user's, not the ear's: ±1 LU is "on target" because no platform's
 * normalisation acts on less, and beyond ±6 LU the remark stops being a nudge and says what it
 * will cost. Deliberately no recommendation of *which* target: that is a per-platform question
 * and this module has no business guessing.
 */
export function describeLoudness(lufs: number, target = -16): string {
  const delta = lufs - target;
  if (Math.abs(delta) < 1) return `On target for ${target} LUFS.`;
  if (delta < 0) {
    const gap = Math.abs(delta).toFixed(0);
    return gap === '1'
      ? `1 LU quieter than ${target} LUFS.`
      : `${gap} LU quieter than ${target} LUFS.`;
  }
  const gap = delta.toFixed(0);
  return gap === '1'
    ? `1 LU louder than ${target} LUFS.`
    : `${gap} LU louder than ${target} LUFS.`;
}
