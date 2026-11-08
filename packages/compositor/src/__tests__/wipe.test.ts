/**
 * SPEC 12 §4.2 — `wipe`: "linear reveal along a direction with soft edge".
 *
 * The transition module used to describe a wipe as "both sides fully opaque" and
 * leave the edge to the renderers, but it did not say *where* the edge was, so
 * neither renderer clipped anything: the incoming clip simply painted over the
 * outgoing one. That is a hard cut, and it looked like one.
 *
 * These tests pin the geometry that a renderer needs: where the edge is at a given
 * progress, how wide the soft edge is, and which side is revealed.
 */
import { describe, expect, it } from 'vitest';
import { transitionState, wipeAlphaAt, wipeDirection } from '../transitions.js';

describe('wipe geometry (SPEC 12 §4.2)', () => {
  describe('wipeAlphaAt', () => {
    it('reveals nothing at the start and everything at the end', () => {
      // A hard edge is the default; at p = 0 the outgoing clip must be whole.
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        expect(wipeAlphaAt(t, 0, 0), `t=${t} at p=0`).toBe(0);
        expect(wipeAlphaAt(t, 1, 0), `t=${t} at p=1`).toBe(1);
      }
    });

    it('puts a hard edge at the progress position', () => {
      // At p = 0.5 the left half is revealed and the right half is not.
      expect(wipeAlphaAt(0.4, 0.5, 0)).toBe(1);
      expect(wipeAlphaAt(0.5, 0.5, 0)).toBe(1);
      expect(wipeAlphaAt(0.6, 0.5, 0)).toBe(0);
    });

    it('advances monotonically with progress', () => {
      // The classic "wipe runs backwards for a frame" bug is a sign or offset
      // error; sampling the whole ramp catches it.
      let previous = -1;
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const alpha = wipeAlphaAt(0.5, p, 0);
        expect(alpha).toBeGreaterThanOrEqual(previous);
        previous = alpha;
      }
    });

    it('softens the edge symmetrically around it', () => {
      // With softness the transition is a linear ramp: the value at the edge is
      // 0.5 and it is symmetric about the edge position.
      const edge = 0.5;
      expect(wipeAlphaAt(edge, 0.5, 0.4)).toBeCloseTo(0.5, 5);
      const inside = wipeAlphaAt(edge - 0.1, 0.5, 0.4);
      const outside = wipeAlphaAt(edge + 0.1, 0.5, 0.4);
      expect(inside + outside).toBeCloseTo(1, 5);
      expect(inside).toBeGreaterThan(outside);
    });

    it('widens the ramp as softness grows', () => {
      // The ramp runs from fully opaque to fully transparent as `t` increases, so
      // its width is (first transparent position - last opaque position). Measuring
      // it the other way round picks up the whole frame and says every softness is
      // equally wide, which is how this test first passed while being meaningless.
      const rampWidth = (softness: number) => {
        let lastOpaque = 0;
        let firstClear = 1;
        for (let i = 0; i <= 1000; i += 1) {
          const t = i / 1000;
          const a = wipeAlphaAt(t, 0.5, softness);
          if (a > 0.999) lastOpaque = Math.max(lastOpaque, t);
          if (a < 0.001) firstClear = Math.min(firstClear, t);
        }
        return firstClear - lastOpaque;
      };
      expect(rampWidth(0)).toBeLessThan(0.01);
      expect(rampWidth(0.2)).toBeCloseTo(0.2, 2);
      expect(rampWidth(0.5)).toBeCloseTo(0.5, 2);
      expect(rampWidth(0.2)).toBeLessThan(rampWidth(0.5));
    });

    it('never leaves the 0–1 range', () => {
      for (const t of [-0.5, 0, 0.5, 1, 1.5]) {
        for (const p of [-0.2, 0, 0.5, 1, 1.2]) {
          const alpha = wipeAlphaAt(t, p, 0.3);
          expect(alpha).toBeGreaterThanOrEqual(0);
          expect(alpha).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('wipeDirection', () => {
    it('maps each direction to a unit normal', () => {
      for (const direction of ['left', 'right', 'up', 'down', 'diagonal-up', 'diagonal-down']) {
        const { x, y } = wipeDirection(direction);
        expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
      }
    });

    it('reveals from the side the direction names', () => {
      // `left` names where the wipe comes *from*: the revealed region grows from
      // the left edge, so the normal points right.
      expect(wipeDirection('left')).toEqual({ x: 1, y: 0 });
      expect(wipeDirection('right')).toEqual({ x: -1, y: 0 });
      expect(wipeDirection('up').y).toBe(1);
      expect(wipeDirection('down').y).toBe(-1);
    });

    it('treats an unset direction as left', () => {
      // An old project file has no direction; it must not render as a no-op.
      expect(wipeDirection(undefined)).toEqual(wipeDirection('left'));
    });

    it('splits the diagonals evenly', () => {
      const up = wipeDirection('diagonal-up');
      expect(up.x).toBeCloseTo(-Math.SQRT1_2, 9);
      expect(up.y).toBeCloseTo(Math.SQRT1_2, 9);
    });
  });

  describe('transitionState for a wipe', () => {
    it('reports the wipe shape instead of a fade', () => {
      // This is the actual defect: both opacities of 1 with no shape told the
      // renderers to paint the incoming clip over the outgoing one.
      const state = transitionState('wipe', 0.4, {});
      expect(state.fromOpacity).toBe(1);
      expect(state.toOpacity).toBe(1);
      expect(state.wipe).toBeDefined();
      expect(state.wipe!.position).toBeCloseTo(0.4, 6);
      expect(state.wipe!.softness).toBe(0);
      expect(state.wipe!.reveal).toBe('incoming');
    });

    it('carries direction and softness through', () => {
      const state = transitionState('wipe', 0.5, { direction: 'up', softness: 0.3 });
      expect(state.wipe!.axisY).toBe(1);
      expect(state.wipe!.axisX).toBe(0);
      expect(state.wipe!.softness).toBeCloseTo(0.3, 6);
    });

    it('clamps a negative softness rather than inverting the edge', () => {
      // A negative ramp would make the edge fade the wrong way round.
      expect(transitionState('wipe', 0.5, { softness: -0.5 }).wipe!.softness).toBe(0);
    });

    it('gives the other transitions no wipe shape', () => {
      for (const type of ['crossfade', 'dissolve', 'fade-black', 'dip-color', 'slide', 'zoom'] as const) {
        expect(transitionState(type, 0.5, {}).wipe, type).toBeUndefined();
      }
    });
  });
});

describe('slide direction (SPEC 12 §4.2)', () => {
  it('moves both pictures horizontally for left and right', () => {
    // Both sides travel: moving only the incoming clip would expose the canvas
    // through the gap, which is a different transition.
    for (const direction of ['left', 'right']) {
      const state = transitionState('slide', 0.3, { direction });
      expect(Math.abs(state.fromOffsetX)).toBeGreaterThan(0);
      expect(Math.abs(state.toOffsetX)).toBeGreaterThan(0);
      expect(state.fromOffsetY).toBe(0);
      expect(state.toOffsetY).toBe(0);
    }
  });

  it('moves both pictures vertically for up and down', () => {
    // These used to fall through to the horizontal branch, so picking "from the
    // top" slid the picture sideways.
    for (const direction of ['up', 'down']) {
      const state = transitionState('slide', 0.3, { direction });
      expect(state.fromOffsetX).toBe(0);
      expect(state.toOffsetX).toBe(0);
      expect(Math.abs(state.fromOffsetY)).toBeGreaterThan(0);
      expect(Math.abs(state.toOffsetY)).toBeGreaterThan(0);
    }
  });

  it('puts the two clips end to end at every progress', () => {
    // The defining property of a push: the outgoing clip's trailing edge meets the
    // incoming clip's leading edge, so together they always cover the frame.
    for (const direction of ['left', 'right', 'up', 'down']) {
      for (const p of [0.1, 0.5, 0.9]) {
        const state = transitionState('slide', p, { direction });
        const vertical = state.fromOffsetY !== 0 || state.toOffsetY !== 0;
        const from = vertical ? state.fromOffsetY : state.fromOffsetX;
        const to = vertical ? state.toOffsetY : state.toOffsetX;
        // `to` starts at −1 and ends at 0; `from` starts at 0 and ends at +1 (for
        // the positive travel). Their sum is always one frame apart.
        expect(Math.abs(to - from), `${direction} p=${p}`).toBeCloseTo(1, 6);
      }
    }
  });

  it('travels the way the direction names', () => {
    // `left` names the direction of travel, so the outgoing clip exits left
    // (negative offset) and the incoming one arrives from the right (positive,
    // closing to zero). A wipe's `direction` means something different — where the
    // reveal starts — and the two are deliberately not forced to agree.
    const left = transitionState('slide', 0.05, { direction: 'left' });
    expect(left.fromOffsetX).toBeLessThan(0);
    expect(left.toOffsetX).toBeGreaterThan(0);
    const up = transitionState('slide', 0.05, { direction: 'up' });
    expect(up.fromOffsetY).toBeLessThan(0);
    expect(up.toOffsetY).toBeGreaterThan(0);
  });
});
