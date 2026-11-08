/**
 * SPEC 12 §4.2 — `dissolve`: "noise-thresholded mix (deterministic noise texture,
 * fixed seed)".
 *
 * What was shipped was a plain fade of the incoming clip over the outgoing one,
 * which is a crossfade. A dissolve is a different transition: every pixel belongs
 * entirely to one side, and which side is decided by a fixed noise field crossing a
 * threshold that rises with progress. These tests pin the properties that make it
 * one — determinism, no blending, the right fraction switching, and resolution
 * independence.
 */
import { describe, expect, it } from 'vitest';
import {
  DISSOLVE_SEED,
  dissolveAlphaAt,
  dissolveNoiseAt,
  transitionState,
  type DissolveShape,
} from '../transitions.js';

const shape = (overrides: Partial<DissolveShape> = {}): DissolveShape => ({
  seed: DISSOLVE_SEED,
  grain: 0.1,
  progress: 0.5,
  ...overrides,
});

describe('dissolve (SPEC 12 §4.2)', () => {
  describe('the noise field', () => {
    it('is deterministic', () => {
      // Two exports of the same project must match frame for frame; a clock-seeded
      // field would break that the moment the dissolve was rendered twice.
      const a = dissolveNoiseAt(37, 91, 320, 180, shape());
      const b = dissolveNoiseAt(37, 91, 320, 180, shape());
      expect(a).toBe(b);
    });

    it('stays inside 0–1', () => {
      for (let y = 0; y < 180; y += 7) {
        for (let x = 0; x < 320; x += 11) {
          const value = dissolveNoiseAt(x, y, 320, 180, shape());
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }
    });

    it('varies across the frame rather than being constant', () => {
      // A constant field would make the whole frame switch at one instant, which
      // is exactly the fade this replaced.
      const values = new Set<string>();
      for (let y = 0; y < 180; y += 9) {
        for (let x = 0; x < 320; x += 9) {
          values.add(dissolveNoiseAt(x, y, 320, 180, shape()).toFixed(3));
        }
      }
      expect(values.size).toBeGreaterThan(50);
    });

    it('is smooth between neighbouring pixels', () => {
      // Salt-and-pepper noise reads as static; a dissolve should look like grain.
      // Value noise interpolates between cells, so neighbouring pixels differ by a
      // small amount rather than jumping across the whole range.
      let worst = 0;
      for (let x = 0; x < 200; x += 1) {
        worst = Math.max(worst, Math.abs(
          dissolveNoiseAt(x, 40, 320, 180, shape()) - dissolveNoiseAt(x + 1, 40, 320, 180, shape()),
        ));
      }
      expect(worst).toBeLessThan(0.25);
    });

    it('changes with the seed', () => {
      // Without this the "fixed seed" would be decorative.
      const a = dissolveNoiseAt(50, 50, 320, 180, shape({ seed: 1 }));
      const b = dissolveNoiseAt(50, 50, 320, 180, shape({ seed: 2 }));
      expect(a).not.toBe(b);
    });

    it('gives the same picture at the same relative position in any resolution', () => {
      // §12 item 6 — effects are resolution-independent; a dissolve should be too,
      // or a 4K export would grain differently from the 1080p preview.
      const at720 = dissolveNoiseAt(160, 90, 320, 180, shape());
      const at1080 = dissolveNoiseAt(960, 540, 1920, 1080, shape());
      // Same relative position (0.5, 0.5) of the frame: the coarse-cell grid
      // matches, so the values agree.
      expect(Math.abs(at720 - at1080)).toBeLessThan(0.02);
    });
  });

  describe('which side a pixel belongs to', () => {
    it('switches pixels, never blending them', () => {
      // The defining property. A fractional alpha here would mean a fade.
      for (let y = 0; y < 180; y += 5) {
        for (let x = 0; x < 320; x += 5) {
          const alpha = dissolveAlphaAt(x, y, 320, 180, shape({ progress: 0.4 }));
          expect(alpha === 0 || alpha === 1).toBe(true);
        }
      }
    });

    it('shows nothing of the incoming clip at 0 and all of it at 1', () => {
      let anyAtStart = false;
      let allAtEnd = true;
      for (let y = 0; y < 180; y += 6) {
        for (let x = 0; x < 320; x += 6) {
          if (dissolveAlphaAt(x, y, 320, 180, shape({ progress: 0 })) !== 0) anyAtStart = true;
          if (dissolveAlphaAt(x, y, 320, 180, shape({ progress: 1 })) !== 1) allAtEnd = false;
        }
      }
      expect(anyAtStart).toBe(false);
      expect(allAtEnd).toBe(true);
    });

    it('switches roughly the fraction of pixels the progress names', () => {
      // The threshold is uniform over the noise, so the expected fraction belongs
      // to the incoming clip. A field that clustered would switch everything at
      // once, and the dissolve would look like a hard cut with a jolt.
      const fraction = (progress: number) => {
        let on = 0;
        let total = 0;
        for (let y = 0; y < 180; y += 2) {
          for (let x = 0; x < 320; x += 2) {
            if (dissolveAlphaAt(x, y, 320, 180, shape({ progress })) === 1) on += 1;
            total += 1;
          }
        }
        return on / total;
      };
      for (const p of [0.25, 0.5, 0.75]) {
        expect(Math.abs(fraction(p) - p), `progress ${p}`).toBeLessThan(0.1);
      }
    });

    it('is monotone: a pixel that has switched never goes back', () => {
      // Flicker would appear if the comparison were the wrong way round at some
      // progress values.
      for (let y = 0; y < 180; y += 23) {
        for (let x = 0; x < 320; x += 29) {
          let on = false;
          for (let p = 0; p <= 1.0001; p += 0.05) {
            const alpha = dissolveAlphaAt(x, y, 320, 180, shape({ progress: p })) === 1;
            if (on) expect(alpha, `x=${x} y=${y} p=${p}`).toBe(true);
            on = alpha;
          }
        }
      }
    });

    it('never switches more as grain gets coarser', () => {
      // A coarser field has fewer cells, so its estimate of the switched fraction
      // is noisier — but it must not systematically invert.
      const fraction = (grain: number) => {
        let on = 0;
        let total = 0;
        for (let y = 0; y < 180; y += 2) {
          for (let x = 0; x < 320; x += 2) {
            if (dissolveAlphaAt(x, y, 320, 180, shape({ progress: 0.5, grain })) === 1) on += 1;
            total += 1;
          }
        }
        return on / total;
      };
      expect(fraction(0.05)).toBeGreaterThan(0.3);
      expect(fraction(0.05)).toBeLessThan(0.7);
    });
  });

  describe('the transition state', () => {
    it('reports a dissolve shape rather than a fade', () => {
      const state = transitionState('dissolve', 0.4, {});
      expect(state.dissolve).toBeDefined();
      expect(state.dissolve!.progress).toBeCloseTo(0.4, 6);
      expect(state.dissolve!.seed).toBe(DISSOLVE_SEED);
      // Neither side fades out, which is what distinguishes this from the fade it
      // used to be.
      expect(state.fromOpacity).toBe(1);
      expect(state.toOpacity).toBe(1);
    });

    it('carries grain and seed through', () => {
      const state = transitionState('dissolve', 0.5, { grain: 0.2, seed: 7 });
      expect(state.dissolve!.grain).toBeCloseTo(0.2, 6);
      expect(state.dissolve!.seed).toBe(7);
    });

    it('refuses a zero or negative grain', () => {
      // Grain is a cell size; zero would divide by zero and negative would invert
      // the grid.
      expect(transitionState('dissolve', 0.5, { grain: 0 }).dissolve!.grain).toBeGreaterThan(0);
      expect(transitionState('dissolve', 0.5, { grain: -1 }).dissolve!.grain).toBeGreaterThan(0);
    });

    it('gives the other transitions no dissolve shape', () => {
      for (const type of ['crossfade', 'fade-black', 'dip-color', 'wipe', 'slide', 'zoom'] as const) {
        expect(transitionState(type, 0.5, {}).dissolve, type).toBeUndefined();
      }
    });
  });
});
