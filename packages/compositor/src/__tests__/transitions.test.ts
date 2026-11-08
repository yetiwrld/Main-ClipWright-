/**
 * SPEC 12 §4 — transition timing and shape.
 *
 * The command layer has been able to create a transition for a while; nothing
 * evaluated one. These tests pin the evaluation, which both renderers consume, so
 * the interesting assertions are the ones about *continuity*: a transition that
 * jumps, dips below full strength where it should not, or overshoots 1 produces a
 * visible flicker that is easy to miss in a still and impossible to miss in motion.
 */
import { describe, expect, it } from 'vitest';
import {
  easeWithBezier,
  transitionAt,
  transitionBezier,
  transitionProgress,
  transitionState,
  transitionWindow,
} from '../transitions.js';

const window = (durationUs: number, alignment: 'center' | 'start' | 'end') =>
  transitionWindow(1_000_000, { durationUs, alignment });

describe('transitionWindow', () => {
  it('centres a centred transition on the cut', () => {
    expect(window(400_000, 'center')).toEqual({
      startUs: 800_000,
      endUs: 1_200_000,
      durationUs: 400_000,
    });
  });

  it('puts a start-aligned transition entirely before the cut', () => {
    expect(window(400_000, 'start')).toEqual({
      startUs: 600_000,
      endUs: 1_000_000,
      durationUs: 400_000,
    });
  });

  it('puts an end-aligned transition entirely after the cut', () => {
    expect(window(400_000, 'end')).toEqual({
      startUs: 1_000_000,
      endUs: 1_400_000,
      durationUs: 400_000,
    });
  });

  it('keeps the window exactly `durationUs` long for an odd duration', () => {
    // Rounding the half is fine; rounding the *length* is not — a 401 µs centre
    // window that came out 400 long would break the last frame of the transition.
    const odd = window(401, 'center');
    expect(odd.endUs - odd.startUs).toBe(401);
  });

  it('clamps a negative duration to nothing rather than running backwards', () => {
    expect(window(-500, 'end').durationUs).toBe(0);
  });
});

describe('transitionProgress', () => {
  const win = window(400_000, 'center');

  it('is null before the window and after it', () => {
    expect(transitionProgress(win, 799_999, 'linear')).toBeNull();
    expect(transitionProgress(win, 1_200_000, 'linear')).toBeNull();
  });

  it('runs 0 → 1 across the window, exclusive of the end', () => {
    expect(transitionProgress(win, 800_000, 'linear')).toBe(0);
    expect(transitionProgress(win, 1_000_000, 'linear')).toBeCloseTo(0.5, 6);
    // The end instant returns null (handled above), so the last *sample* is < 1.
    expect(transitionProgress(win, 1_199_999, 'linear')).toBeGreaterThan(0.99);
  });

  it('is null for a zero-length transition instead of dividing by zero', () => {
    expect(transitionProgress(window(0, 'center'), 1_000_000, 'linear')).toBeNull();
  });

  it('applies the named easing', () => {
    // easeIn starts slowly, so early progress must lag linear.
    const linear = transitionProgress(win, 900_000, 'linear')!;
    const eased = transitionProgress(win, 900_000, 'easeIn')!;
    expect(eased).toBeLessThan(linear);
  });

  it('never leaves 0–1 even for an easing that overshoots', () => {
    // `easeOutBack` overshoots by design; a progress above 1 would make a
    // crossfade paint the incoming clip at more than full strength, which on the
    // export side means an out-of-range alpha.
    for (let timeUs = 800_000; timeUs < 1_200_000; timeUs += 5_000) {
      const p = transitionProgress(win, timeUs, 'easeOutBack');
      expect(p).not.toBeNull();
      expect(p!).toBeGreaterThanOrEqual(0);
      expect(p!).toBeLessThanOrEqual(1);
    }
  });
});

describe('transitionState', () => {
  it('crossfades with opacities that sum to one', () => {
    // Summing to 1 is what stops the frame dimming halfway through. Two
    // independent ease-in curves would do exactly that, which is the classic
    // crossfade bug.
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const state = transitionState('crossfade', p);
      expect(state.fromOpacity + state.toOpacity).toBeCloseTo(1, 6);
    }
  });

  it('starts fully outgoing and ends fully incoming', () => {
    const start = transitionState('crossfade', 0);
    expect(start.fromOpacity).toBeCloseTo(1, 6);
    expect(start.toOpacity).toBeCloseTo(0, 6);
    const end = transitionState('crossfade', 1);
    expect(end.fromOpacity).toBeCloseTo(0, 6);
    expect(end.toOpacity).toBeCloseTo(1, 6);
  });

  it('fade-black actually reaches black at the midpoint', () => {
    // The property that separates a fade-to-black from a crossfade: at p=0.5 both
    // sides are invisible, so the canvas shows. A crossfade between two dark clips
    // can look similar and is not the same thing.
    const middle = transitionState('fade-black', 0.5);
    expect(middle.fromOpacity).toBe(0);
    expect(middle.toOpacity).toBe(0);
  });

  it('fade-black is dark on both sides of the midpoint too', () => {
    const justBefore = transitionState('fade-black', 0.49);
    const justAfter = transitionState('fade-black', 0.51);
    expect(justBefore.fromOpacity).toBeLessThan(0.05);
    expect(justAfter.toOpacity).toBeLessThan(0.05);
  });

  it('fade-black never shows both sides at once', () => {
    // If both were visible the frame would never reach black, which is the whole
    // point of the transition.
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const state = transitionState('fade-black', p);
      expect(Math.min(state.fromOpacity, state.toOpacity)).toBe(0);
    }
  });

  it('dip-color reports the colour it dips through', () => {
    expect(transitionState('dip-color', 0.5, { color: '#ff0000' }).dipColor).toBe('#ff0000');
  });

  it('dip-color defaults to black when no colour is given', () => {
    expect(transitionState('dip-color', 0.5, {}).dipColor).toBe('#000000');
  });

  it('dissolve keeps both sides at full strength and reports its noise field', () => {
    // Neither side fades. §4.2 defines a dissolve as a noise-thresholded mix, so
    // every pixel belongs entirely to one clip and the switch is decided by a fixed
    // noise field. An earlier version of this test asserted `toOpacity ≈ p`, which
    // described exactly the crossfade the spec distinguishes a dissolve from — a
    // test can hold an incorrect contract in place just as easily as a comment can.
    for (const p of [0.1, 0.5, 0.9]) {
      const state = transitionState('dissolve', p);
      expect(state.fromOpacity).toBe(1);
      expect(state.toOpacity).toBe(1);
      expect(state.dissolve).toBeDefined();
      expect(state.dissolve!.progress).toBeCloseTo(p, 6);
    }
  });

  it('slide moves both sides so no gap opens', () => {
    // The incoming edge and the outgoing edge have to travel together: at any p the
    // two offsets differ by exactly one frame width, otherwise the canvas shows
    // through between them.
    for (const p of [0, 0.3, 0.5, 0.8, 1]) {
      const state = transitionState('slide', p, { direction: 'left' });
      // Both travel leftward, so the difference is −1; the magnitude is the point.
      expect(Math.abs(state.toOffsetX - state.fromOffsetX)).toBeCloseTo(1, 6);
    }
  });

  it('slide respects the direction', () => {
    // `left` = the frame travels leftwards: the outgoing clip exits to the left and
    // the incoming one enters from the right.
    const left = transitionState('slide', 0.5, { direction: 'left' });
    const right = transitionState('slide', 0.5, { direction: 'right' });
    expect(left.fromOffsetX).toBeCloseTo(-0.5, 6);
    expect(left.toOffsetX).toBeCloseTo(0.5, 6);
    expect(right.fromOffsetX).toBeCloseTo(0.5, 6);
    expect(right.toOffsetX).toBeCloseTo(-0.5, 6);
  });

  it('slide starts with the outgoing clip centred and ends with the incoming one centred', () => {
    // The endpoints are what make a slide look continuous with the clips either
    // side of it; an offset of 1 at the wrong end leaves the frame blank.
    for (const direction of ['left', 'right'] as const) {
      const start = transitionState('slide', 0, { direction });
      const end = transitionState('slide', 1, { direction });
      expect(start.fromOffsetX).toBeCloseTo(0, 6);
      expect(start.toOffsetX).toBeCloseTo(direction === 'left' ? 1 : -1, 6);
      expect(end.fromOffsetX).toBeCloseTo(direction === 'left' ? -1 : 1, 6);
      expect(end.toOffsetX).toBeCloseTo(0, 6);
    }
  });

  it('zoom scales both sides and crossfades them', () => {
    const middle = transitionState('zoom', 0.5);
    expect(middle.fromScale).toBeGreaterThan(1);
    expect(middle.toScale).toBeGreaterThan(1);
    expect(middle.fromOpacity + middle.toOpacity).toBeCloseTo(1, 6);
    // The two scales are mirror images about the mid-point of the travel.
    const start = transitionState('zoom', 0);
    const end = transitionState('zoom', 1);
    expect(start.toScale).toBeGreaterThan(start.fromScale);
    expect(end.fromScale).toBeGreaterThan(end.toScale);
  });

  it('honours a zoom amount and ignores a nonsense one', () => {
    expect(transitionState('zoom', 0, { amount: 0.5 }).toScale).toBeCloseTo(1.5, 6);
    expect(transitionState('zoom', 0, { amount: -3 }).toScale).toBeCloseTo(1.25, 6);
  });

  it('clamps progress outside 0–1 rather than extrapolating', () => {
    expect(transitionState('crossfade', -2).toOpacity).toBe(0);
    expect(transitionState('crossfade', 9).toOpacity).toBe(1);
  });

  it('leaves both sides opaque for a wipe, and reports the edge instead', () => {
    // Neither side fades — a wipe is a moving clip, not a fade — but "both
    // opaque" on its own is what the renderers used to receive, and with no edge
    // to go on they drew the incoming clip over the outgoing one: a cut. The shape
    // is the part that makes it a wipe.
    const state = transitionState('wipe', 0.5, { direction: 'left' });
    expect(state.fromOpacity).toBe(1);
    expect(state.toOpacity).toBe(1);
    expect(state.wipe).toBeDefined();
    expect(state.wipe!.position).toBe(0.5);
  });
});

describe('transitionAt', () => {
  const transition = {
    id: 'tr',
    type: 'crossfade' as const,
    durationUs: 400_000,
    alignment: 'center' as const,
    params: {},
    easing: 'linear' as const,
    crossfadeAudio: true,
  };

  it('returns null when there is no transition', () => {
    expect(transitionAt(1_000_000, undefined, 1_000_000)).toBeNull();
  });

  it('returns null outside the window', () => {
    expect(transitionAt(1_000_000, transition, 500_000)).toBeNull();
  });

  it('returns progress and state inside the window', () => {
    const at = transitionAt(1_000_000, transition, 1_000_000);
    expect(at).not.toBeNull();
    expect(at!.progress).toBeCloseTo(0.5, 6);
    expect(at!.state.toOpacity).toBeCloseTo(0.5, 6);
  });
});

describe('easing helpers', () => {
  it('maps the named presets to control points', () => {
    expect(transitionBezier('linear')).toEqual([0, 0, 1, 1]);
    expect(transitionBezier('easeInOut')).toEqual([0.42, 0, 0.58, 1]);
    // An unknown preset degrades to linear rather than to something exotic.
    expect(transitionBezier('nonesuch' as never)).toEqual([0, 0, 1, 1]);
  });

  it('evaluates a linear bezier as the identity', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(easeWithBezier([0, 0, 1, 1], x)).toBeCloseTo(x, 4);
    }
  });

  it('accelerates out of the start for easeIn', () => {
    expect(easeWithBezier([0.42, 0, 1, 1], 0.25)).toBeLessThan(0.25);
  });
});
