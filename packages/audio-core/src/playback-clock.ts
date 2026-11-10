/**
 * The playback clock (SPEC 09 §23).
 *
 * > **Master clock:** when any audio plays, the **audio output position is the clock**; the
 * > playhead derives from it so video never drifts from audio. With no audio, use a monotonic
 * > high-resolution timer. The preview renders the frame for the clock time; if frames can't
 * > keep up it **drops frames, never slows audio**.
 *
 * That paragraph is the whole of this file, and the reason it is a file rather than six lines in
 * the preview is that the two clocks disagree in ways that are easy to get wrong and impossible
 * to see:
 *
 * - **`performance.now()` is not a clock for audio.** An animation frame is a *deadline*, not a
 *   tick: a frame that takes 40 ms instead of 16 makes the next `now()` 40 ms later, so
 *   accumulating deltas on a slow machine runs *late* and the sound, which does not care, runs on
 *   time. The two are then permanently offset by however long the hitch lasted, and the preview
 *   shows a waveform with the sound in the wrong place. Deriving from the audio device instead
 *   means a slow frame renders an older picture — dropping frames — and the playhead still
 *   matches what is coming out of the speakers.
 * - **An `AudioContext` clock is not the playhead.** `context.currentTime` counts from when the
 *   context was created and keeps counting while the playhead is paused, seeking, or looping. The
 *   playhead is an *offset* from an anchor taken at the moment playback started, and every seek
 *   re-anchors it.
 * - **The clock must survive a dropped context.** No Web Audio means no audio clock, which is
 *   the timer case; a build that trusted one would stop playing rather than fall back.
 *
 * Nothing here reads a real `AudioContext`. `now` is passed in, which keeps the arithmetic
 * testable in Node and keeps this module ignorant of the graph next door.
 */

/** Where a clock reading came from. Useful in a test and in a diagnostic, never decorative. */
export type ClockSource = 'audio' | 'timer';

export interface ClockAnchor {
  /**
   * The clock's own reading when playback was last anchored, in seconds.
   *
   * For the audio clock that is `AudioContext.currentTime`; for the timer it is
   * `performance.now() / 1000`. The two are never mixed — an anchor is only read back by the
   * clock that wrote it, which is what makes `source` part of the anchor rather than a label.
   */
  readonly atSeconds: number;
  /** The playhead time that instant corresponded to, in microseconds. */
  readonly playheadUs: number;
  readonly source: ClockSource;
  /** Playback rate the anchor was taken at (0.5, 1, 1.5, 2 — SPEC 09 §23). */
  readonly rate: number;
}

/** Playback rates the transport offers (SPEC 09 §23). */
export const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/**
 * Slower and faster than real time, in the same unit.
 *
 * A rate multiplies *elapsed wall time* to get *elapsed playhead time*: at 2× an hour of audio
 * passes in half an hour, which is what a user means by "twice as fast". Writing it the other way
 * round is the classic bug — it plays at half speed and looks like the stretch failed.
 *
 * The spec's rates are the only ones accepted, because an unlisted rate is not a rounding
 * difference: `preservesPitch` and the graph's gain curve are both planned against these, and a
 * rate invented by a caller would silently desynchronise them.
 */
export function isPlaybackRate(value: number): value is PlaybackRate {
  return (PLAYBACK_RATES as readonly number[]).includes(value);
}

/**
 * The playhead instant a clock reading corresponds to.
 *
 * Pure, so a test can walk a whole playback through it. Elapsed time is floored at zero: a clock
 * that goes backwards (an `AudioContext` that was recreated under us, a system suspend) must not
 * drag the playhead back to before the anchor and restart the audio.
 */
export function playheadAt(anchor: ClockAnchor, nowSeconds: number): number {
  const elapsed = Math.max(0, nowSeconds - anchor.atSeconds);
  return anchor.playheadUs + elapsed * 1_000_000 * anchor.rate;
}

/** Anchor a clock reading to a playhead instant. */
export function anchorClock(
  playheadUs: number,
  atSeconds: number,
  source: ClockSource,
  rate: number,
): ClockAnchor {
  return {
    atSeconds,
    playheadUs: Math.max(0, playheadUs),
    source,
    rate: isPlaybackRate(rate) ? rate : 1,
  };
}

/**
 * Whether a re-anchor is needed, and why.
 *
 * A clock has to be re-anchored when the playhead is *set* from outside — a scrub, a seek, the
 * transport's jump — because the anchor is "playhead was here at this clock reading" and any
 * other playhead change makes it a lie. It does **not** need re-anchoring when the playhead moves
 * because the clock moved: that is the clock working.
 *
 * `driftUs` also matters. Even a good clock accumulates error against the other one, and the
 * preview's own seek logic has a tolerance for exactly this reason. Re-anchoring when the two
 * disagree by more than that tolerance keeps the correction invisible rather than making it a
 * jump.
 */
export function needsReanchor(
  anchor: ClockAnchor,
  expectedPlayheadUs: number,
  actualPlayheadUs: number,
  toleranceUs: number,
): boolean {
  return Math.abs(actualPlayheadUs - expectedPlayheadUs) > toleranceUs;
}

/**
 * Whether a frame should be *drawn* at this instant, given how much of the budget is left.
 *
 * The spec's "drop frames, never slow audio" is a rule about what the picture does when it cannot
 * keep up: the clock is the audio and the playhead is whatever the audio says, so a frame that
 * arrives late is simply not drawn. What makes this subtle is that "late" is measured against the
 * *clock*, not against the previous frame — a renderer that measures against its own last frame
 * drifts exactly as the timer clock does.
 */
export function shouldDrawFrame(
  playheadUs: number,
  lastDrawnPlayheadUs: number,
  frameDurationUs: number,
): boolean {
  return playheadUs - lastDrawnPlayheadUs >= frameDurationUs * 0.5;
}

/**
 * The end-of-playback decision for a clock reading.
 *
 * Split out because "stop at the end" and "stop at the work-area out" are the same question and a
 * caller that answered them separately once is how a project with a work area plays into the
 * footage past it. `stopUs` is whichever bound applies, already resolved by the caller.
 */
export function playbackEnded(
  playheadUs: number,
  stopUs: number,
): boolean {
  return stopUs > 0 && playheadUs >= stopUs;
}

/**
 * The instant to stop at, given the project duration and an optional work-area out.
 *
 * The work area wins when it is set and inside the project: it is the user's explicit statement
 * about what a playback pass means. A work area *after* the project end is clamped, because
 * playing silence past the last clip is not what anyone meant by setting it.
 */
export function playbackStopUs(durationUs: number, workAreaOutUs?: number | null): number {
  if (typeof workAreaOutUs !== 'number' || !Number.isFinite(workAreaOutUs)) return durationUs;
  if (workAreaOutUs <= 0) return durationUs;
  return Math.min(workAreaOutUs, durationUs);
}

/**
 * Clamp a rate to the spec's set, nearest to what was asked.
 *
 * Used where a rate arrives from stored settings rather than from the transport's own buttons: a
 * project written by a future version, or hand-edited, should play at the nearest legal speed
 * rather than at 0× (silence, stuck) or 7× (an unlistenable rumble).
 */
export function clampPlaybackRate(rate: number): PlaybackRate {
  if (isPlaybackRate(rate)) return rate;
  /*
    No `Number.isFinite` guard, deliberately: every candidate's distance to `NaN`, `Infinity` or
    `-Infinity` is `NaN` or `Infinity`, and both compare false against the starting `bestDistance`
    of `Infinity`. So the loop already leaves `best` at 1 for exactly the values that cannot be
    measured, and a guard in front of it would be a branch no input can reach — dead code that
    reads like a safety net.
  */
  let best: PlaybackRate = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of PLAYBACK_RATES) {
    const distance = Math.abs(candidate - rate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
