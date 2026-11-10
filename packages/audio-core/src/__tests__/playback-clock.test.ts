/**
 * The playback clock (SPEC 09 §23).
 *
 * Every case here is one of the two clocks getting something wrong that is invisible on a fast
 * machine and audible on a slow one. The interesting fixtures are therefore not "does it add
 * up" — that one is obvious — but the *hitches*: a frame that arrives 40 ms late, a rate that
 * was written the wrong way round, an `AudioContext` that keeps counting while the playhead does
 * not.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_RATES,
  anchorClock,
  clampPlaybackRate,
  isPlaybackRate,
  needsReanchor,
  playbackEnded,
  playbackStopUs,
  playheadAt,
  shouldDrawFrame,
} from '../playback-clock.js';

const anchor = (playheadUs = 0, atSeconds = 0, rate = 1) =>
  anchorClock(playheadUs, atSeconds, 'audio', rate);

describe('playheadAt', () => {
  it('advances at the rate the wall clock advances', () => {
    const start = anchor(0, 100);
    expect(playheadAt(start, 101)).toBe(1_000_000);
    expect(playheadAt(start, 101.5)).toBe(1_500_000);
  });

  it('counts from the playhead instant the anchor was taken at', () => {
    /* Playback started at 2 s into the project: a second later the playhead is at 3 s, not 1 s. */
    const start = anchor(2_000_000, 50);
    expect(playheadAt(start, 51)).toBe(3_000_000);
  });

  it('multiplies elapsed time by the rate, not the rate by elapsed time', () => {
    /*
      The classic way round to get this wrong: dividing by the rate instead of multiplying, which
      plays 2× at half speed. At 2× the playhead must cover *more* time than the clock does.
    */
    const fast = anchor(0, 0, 2);
    expect(playheadAt(fast, 1)).toBe(2_000_000);

    const slow = anchor(0, 0, 0.5);
    expect(playheadAt(slow, 1)).toBe(500_000);
  });

  it('does not run backwards when the clock does', () => {
    /*
      An `AudioContext` that is recreated, or a machine that suspends, can report a smaller
      `currentTime` than the anchor. Without the floor the playhead would jump *backwards* and the
      preview would restart the audio — a stutter with no visible cause.
    */
    const start = anchor(0, 10);
    expect(playheadAt(start, 9)).toBe(0);
    expect(playheadAt(start, 9.9)).toBe(0);
  });

  it('never produces a fractional microsecond the store would round differently', () => {
    /*
      Not a rounding *decision* — the store rounds — but a check that the arithmetic does not
      accumulate a float error large enough to matter across a long playback.
    */
    const start = anchor(0, 0);
    const after = playheadAt(start, 3600);
    expect(after).toBe(3_600_000_000);
    expect(Number.isInteger(after)).toBe(true);
  });
});

describe('a whole playback, frame by frame', () => {
  /*
    The integration the two halves exist for, walked through the same arithmetic the preview
    performs: anchor once, then ask for the playhead on every frame. Written as a sequence rather
    than as point checks because the failure this guards against — a rate applied at anchor time
    *and* again per frame — is invisible in any single reading and doubles the speed.
  */
  const walk = (rate: number, frames: number[], clockStart = 0) => {
    const start = anchorClock(0, clockStart, 'audio', rate);
    return frames.map((elapsed) => playheadAt(start, clockStart + elapsed));
  };

  it('advances linearly at real time', () => {
    expect(walk(1, [0, 0.5, 1, 1.5])).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });

  it('advances at double time at 2×, without applying the rate twice', () => {
    /*
      The double-application bug: an implementation that scaled `atSeconds` by the rate *and*
      multiplied `playheadAt`'s result by it would show 4× here while looking correct at the
      first frame, where elapsed is zero and both versions agree.
    */
    expect(walk(2, [0, 1, 2])).toEqual([0, 2_000_000, 4_000_000]);
  });

  it('advances at half time at 0.5×', () => {
    expect(walk(0.5, [0, 1, 2])).toEqual([0, 500_000, 1_000_000]);
  });

  it('measures elapsed time from the anchor, not from zero', () => {
    /* A context that was created long before playback started. */
    expect(walk(1, [0, 1], 1_000)).toEqual([0, 1_000_000]);
  });

  it('holds rather than rewinds when the clock goes back before the anchor', () => {
    const start = anchorClock(7_000_000, 5, 'audio', 1);
    expect(playheadAt(start, 4)).toBe(7_000_000);
    expect(playheadAt(start, 5)).toBe(7_000_000);
    expect(playheadAt(start, 6)).toBe(8_000_000);
  });
});

describe('anchorClock', () => {
  it('refuses a rate the transport does not offer, falling back to real time', () => {
    /*
      A stored setting from a hand-edited project, or a future version, must not play at 0×
      (stuck, silent) or 7× (an unlistenable rumble). 1× is the only defensible answer when the
      requested speed is not one the graph and the stretch were planned against.
    */
    expect(anchor(0, 0, 3).rate).toBe(1);
    expect(anchor(0, 0, Number.NaN).rate).toBe(1);
    expect(anchor(0, 0, 2).rate).toBe(2);
  });

  it('floors a negative playhead at zero rather than anchoring before the project', () => {
    expect(anchor(-50_000, 0).playheadUs).toBe(0);
  });

  it('records which clock it came from, so the two can never be read into one another', () => {
    expect(anchorClock(0, 0, 'audio', 1).source).toBe('audio');
    expect(anchorClock(0, 0, 'timer', 1).source).toBe('timer');
  });
});

describe('needsReanchor', () => {
  it('is quiet about the difference a clock is expected to have', () => {
    /*
      The point of a tolerance: re-anchoring on every frame's own drift would fight the clock it
      is trying to follow, making the correction itself the jitter.
    */
    expect(needsReanchor(anchor(0, 0), 1_000_000, 1_020_000, 80_000)).toBe(false);
  });

  it('fires when the playhead was set from outside the clock', () => {
    /* A scrub or a seek: the anchor says "here", the playhead is somewhere else entirely. */
    expect(needsReanchor(anchor(0, 0), 1_000_000, 5_000_000, 80_000)).toBe(true);
  });

  it('fires in both directions', () => {
    expect(needsReanchor(anchor(0, 0), 5_000_000, 1_000_000, 80_000)).toBe(true);
  });

  it('compares against the tolerance exactly, not past it', () => {
    expect(needsReanchor(anchor(0, 0), 1_000_000, 1_080_000, 80_000)).toBe(false);
    expect(needsReanchor(anchor(0, 0), 1_000_000, 1_080_001, 80_000)).toBe(true);
  });
});

describe('shouldDrawFrame', () => {
  it('draws a frame once half a frame has passed, so a rate of 60 on a 30 fps project still moves', () => {
    /*
      The half-frame threshold is not arbitrary. At 1× on a 30 fps project a 60 Hz preview asks
      twice per project frame; drawing only when a *whole* frame has passed would leave every
      second request undrawn — the picture would stutter at 30 while the clock ran at 60. Half a
      frame means the newest request wins and the frame is drawn once it can show something new.
    */
    const frameUs = 1_000_000 / 30;
    expect(shouldDrawFrame(frameUs * 0.5, 0, frameUs)).toBe(true);
    expect(shouldDrawFrame(frameUs * 0.4, 0, frameUs)).toBe(false);
  });

  it('measures lateness against the clock, not against the last frame', () => {
    /*
      A renderer that asks "has a frame's worth of time passed since I last drew" drifts when it
      drops a frame: the dropped frame's time is never accounted for. Asking "is the clock at a
      different frame than the one on screen" self-corrects — after a 3-frame hitch the next draw
      is the newest frame, not the one after the old one.
    */
    const frameUs = 1_000_000 / 30;
    /* Three frames were missed; the next draw must still happen. */
    expect(shouldDrawFrame(frameUs * 3, 0, frameUs)).toBe(true);
  });

  it('does not draw when the clock has not moved at all', () => {
    expect(shouldDrawFrame(5_000_000, 5_000_000, 33_333)).toBe(false);
  });
});

describe('playbackEnded and playbackStopUs', () => {
  it('stops at the project end by default', () => {
    expect(playbackStopUs(10_000_000)).toBe(10_000_000);
    expect(playbackEnded(10_000_000, 10_000_000)).toBe(true);
    expect(playbackEnded(9_999_999, 10_000_000)).toBe(false);
  });

  it('stops at the work area when one is set', () => {
    expect(playbackStopUs(10_000_000, 4_000_000)).toBe(4_000_000);
  });

  it('clamps a work area beyond the project to the project end', () => {
    /* Playing silence past the last clip is not what setting a work area meant. */
    expect(playbackStopUs(10_000_000, 40_000_000)).toBe(10_000_000);
  });

  it('ignores a missing, zero or nonsensical work area rather than stopping immediately', () => {
    /*
      The failure this prevents is a playback that ends before it starts: a zero work-area out
      read literally would stop the transport on frame one, which looks like a dead Play button.
    */
    expect(playbackStopUs(10_000_000, 0)).toBe(10_000_000);
    expect(playbackStopUs(10_000_000, null)).toBe(10_000_000);
    expect(playbackStopUs(10_000_000, Number.NaN)).toBe(10_000_000);
    expect(playbackStopUs(10_000_000, -5)).toBe(10_000_000);
  });

  it('says playback has not ended when there is no stop point to reach', () => {
    expect(playbackEnded(5_000_000, 0)).toBe(false);
  });
});

describe('playback rates', () => {
  it('offers exactly the four the spec lists', () => {
    expect([...PLAYBACK_RATES]).toEqual([0.5, 1, 1.5, 2]);
  });

  it('rejects values that only look like a rate', () => {
    expect(isPlaybackRate(1)).toBe(true);
    expect(isPlaybackRate('1' as unknown as number)).toBe(false);
    expect(isPlaybackRate(1.25)).toBe(false);
  });

  it('clamps an unlisted stored rate to the nearest legal one', () => {
    expect(clampPlaybackRate(1.7)).toBe(1.5);
    expect(clampPlaybackRate(1.9)).toBe(2);
    expect(clampPlaybackRate(0.1)).toBe(0.5);
    expect(clampPlaybackRate(99)).toBe(2);
  });

  it('falls back to real time for a rate that is not a number at all', () => {
    /*
      1× rather than 0×, which would be silence with the playhead stuck, and rather than the
      fastest legal rate: an infinite rate is a *corrupt* value, not a request for speed, and
      treating corruption as "as fast as possible" turns a bug into a scramble through the
      project. Unknown input gets the least surprising speed.
    */
    expect(clampPlaybackRate(Number.NaN)).toBe(1);
    expect(clampPlaybackRate(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampPlaybackRate(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});
