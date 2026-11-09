import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSeekCoalescer,
  seekThreshold,
  shouldSeek,
  type SeekCoalescer,
} from '../features/editor/seek-coalescer.js';

describe('coalescing seeks', () => {
  let seeks: number[];
  let coalescer: SeekCoalescer;

  beforeEach(() => {
    seeks = [];
    coalescer = createSeekCoalescer({ seek: (seconds) => seeks.push(seconds) });
  });

  it('seeks immediately when nothing is in flight', () => {
    coalescer.request(1.5);
    expect(seeks).toEqual([1.5]);
    expect(coalescer.isSeeking()).toBe(true);
  });

  it('holds a target that arrives mid-seek instead of starting a second seek', () => {
    /*
      The whole point. A second assignment aborts the first decode, so a scrub that
      kept assigning would spend the drag never finishing a single seek.
    */
    coalescer.request(1);
    coalescer.request(2);
    expect(seeks).toEqual([1]);
    expect(coalescer.pendingTarget()).toBe(2);
  });

  it('follows only the newest of several targets', () => {
    /*
      Overwritten, not queued. A pointer that moved through three positions during one
      decode wants the third; replaying them in order makes the picture chase the
      pointer rather than follow it.
    */
    coalescer.request(1);
    coalescer.request(2);
    coalescer.request(3);
    coalescer.request(4);
    expect(coalescer.pendingTarget()).toBe(4);
    coalescer.settled();
    expect(seeks).toEqual([1, 4]);
  });

  it('stops after the last target has been reached', () => {
    // Convergence: once the element has settled and nothing is waiting, no further
    // seeks happen. A coalescer that always re-seeked would loop forever.
    coalescer.request(1);
    coalescer.settled();
    expect(coalescer.isSeeking()).toBe(false);
    expect(seeks).toEqual([1]);
  });

  it('issues no seek for a settle with nothing pending', () => {
    // `seeked` can fire for a seek the coalescer did not start — the element seeking
    // itself on load, for instance — and that must not produce a spurious request.
    coalescer.settled();
    expect(seeks).toEqual([]);
    expect(coalescer.isSeeking()).toBe(false);
  });

  it('drops a pending target on cancel', () => {
    /*
      When the source changes or playback starts, a scrub target left over from the
      previous state is not meaningful any more — following it would yank the picture
      back to wherever the pointer last was.
    */
    coalescer.request(1);
    coalescer.request(2);
    coalescer.cancel();
    expect(coalescer.pendingTarget()).toBeNull();
    coalescer.settled();
    expect(seeks).toEqual([1]);
  });

  it('ignores a target that is not a finite number', () => {
    // NaN would be assigned to `currentTime`, which throws an `InvalidStateError` in a
    // browser — the clip would stop following the playhead entirely.
    coalescer.request(Number.NaN);
    coalescer.request(Number.POSITIVE_INFINITY);
    expect(seeks).toEqual([]);
    expect(coalescer.isSeeking()).toBe(false);
  });

  it('keeps one seek in flight through a fast drag of many events', () => {
    /*
      The measured shape of the bug: a drag emits a target per pointer move, and the
      old code assigned `currentTime` for every one of them. After this, however many
      events arrive, at most one seek is outstanding at a time.
    */
    coalescer.request(0);
    for (let i = 1; i <= 100; i += 1) coalescer.request(i / 10);
    expect(seeks).toHaveLength(1);
    // And settling lands on the last position, not on the second one.
    coalescer.settled();
    expect(seeks.at(-1)).toBeCloseTo(10, 10);
    expect(seeks).toHaveLength(2);
  });
});

describe('when a seek is worth it', () => {
  it('tolerates more drift while playing than while paused', () => {
    /*
      Playing: the element advances itself and a seek interrupts it, so a correction is
      a visible hitch. Paused: the element is the only thing that can show the frame
      under the playhead, so being half a frame out is already wrong.
    */
    expect(seekThreshold(true, 30)).toBeGreaterThan(seekThreshold(false, 30));
    expect(seekThreshold(true, 30)).toBeCloseTo(0.2, 10);
    expect(seekThreshold(false, 30)).toBeCloseTo(1 / 60, 10);
  });

  it('scales the paused threshold with the frame rate', () => {
    // Half a frame at 60 fps is half the time it is at 30.
    expect(seekThreshold(false, 60)).toBeCloseTo(1 / 120, 10);
    expect(seekThreshold(true, 60)).toBeCloseTo(0.2, 10);
  });

  it('falls back to 30 fps when the rate is unusable', () => {
    // A project whose fps has not loaded yet must not produce an infinite threshold,
    // which would mean never seeking at all.
    expect(seekThreshold(false, 0)).toBeCloseTo(1 / 60, 10);
    expect(Number.isFinite(seekThreshold(true, Number.NaN))).toBe(true);
  });

  it('seeks to correct a drift past the threshold, and not before', () => {
    const options = { playing: false, fps: 30 };
    expect(shouldSeek(0, 0.01, options)).toBe(false);
    expect(shouldSeek(0, 0.02, options)).toBe(true);
    // Symmetric: being ahead of the target is as wrong as being behind it.
    expect(shouldSeek(0.02, 0, options)).toBe(true);
  });

  it('refuses to seek on a non-finite comparison', () => {
    // `NaN` comparisons are all false, so a naive `Math.abs(a - b) > t` would silently
    // never seek — the clip freezes with no error anywhere.
    expect(shouldSeek(Number.NaN, 1, { playing: false, fps: 30 })).toBe(false);
    expect(shouldSeek(1, Number.NaN, { playing: false, fps: 30 })).toBe(false);
  });

  it('does not seek while playing for a drift the element will close itself', () => {
    // The element is running; correcting a couple of frames would be a stutter for no
    // gain, because playback closes that gap on its own.
    expect(shouldSeek(0, 0.05, { playing: true, fps: 30 })).toBe(false);
    expect(shouldSeek(0, 0.5, { playing: true, fps: 30 })).toBe(true);
  });
});
