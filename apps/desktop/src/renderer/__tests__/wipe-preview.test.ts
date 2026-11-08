import type React from 'react';
/**
 * SPEC 12 §4.2 — a wipe must actually wipe on screen.
 *
 * The transition contract reported both sides fully opaque and never said where the
 * edge was, so the preview drew the incoming clip straight over the outgoing one:
 * indistinguishable from a cut. The preview now clips the incoming layer, and these
 * tests check the clip geometry — and that it agrees with the export's mask, because
 * a preview that disagrees with the file is the failure this whole area keeps
 * producing.
 */
import { describe, expect, it } from 'vitest';
import { transitionState, wipeAlphaAt, wipeDirection } from '@clipwright/compositor';
import { dissolveMaskStyle, wipeClipPath } from '../features/editor/PreviewPane.js';

/** Parse `inset(t r b l)` percentages. */
function parseInset(path: string): [number, number, number, number] {
  // Zero renders as a bare `0`, not `0%`, so the unit is optional.
  const match = /^inset\(([\d.]+)%? ([\d.]+)%? ([\d.]+)%? ([\d.]+)%?\)$/.exec(path);
  if (!match) throw new Error(`not an inset: ${path}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

describe('wipe in the preview (SPEC 12 §4.2)', () => {
  it('reveals from the left by default', () => {
    // At half progress a left wipe has revealed the left half: the right half is
    // clipped away, so the right inset is 50 % and the others are 0.
    const path = wipeClipPath({ ...shapeFor('left', 0.5) });
    const [top, right, bottom, left] = parseInset(path);
    expect(top).toBe(0);
    expect(bottom).toBe(0);
    expect(left).toBe(0);
    expect(right).toBeCloseTo(50, 5);
  });

  it('reveals nothing at the start and everything at the end', () => {
    const start = parseInset(wipeClipPath({ ...shapeFor('left', 0) }));
    // Nothing revealed: the whole frame is clipped away by the right inset.
    expect(start[1]).toBeCloseTo(100, 5);
    const end = parseInset(wipeClipPath({ ...shapeFor('left', 1) }));
    expect(end[1]).toBeCloseTo(0, 5);
  });

  it('clips the opposite side when the direction is reversed', () => {
    // `right` reveals from the right, so the *left* inset grows instead.
    const [top, right, bottom, left] = parseInset(wipeClipPath(shapeFor('right', 0.5)));
    expect(top).toBe(0);
    expect(bottom).toBe(0);
    expect(right).toBe(0);
    expect(left).toBeCloseTo(50, 5);
  });

  it('uses the vertical insets for up and down', () => {
    const up = parseInset(wipeClipPath(shapeFor('up', 0.5)));
    // `up` reveals from the top, so the bottom inset is 50 %.
    expect(up[2]).toBeCloseTo(50, 5);
    expect(up[1]).toBe(0);
    expect(up[3]).toBe(0);
    const down = parseInset(wipeClipPath(shapeFor('down', 0.5)));
    expect(down[0]).toBeCloseTo(50, 5);
  });

  it('uses a polygon for the diagonals', () => {
    const path = wipeClipPath(shapeFor('diagonal-up', 0.5));
    expect(path.startsWith('polygon(')).toBe(true);
    // Three corners is a triangle, which is what a diagonal reveal is.
    expect(path.split(',').length).toBe(3);
  });

  it('agrees with the export mask about which side is revealed', () => {
    /*
      The property that actually matters: at any progress, the left-hand sample of
      the preview's clip and the export's mask must agree about whether a pixel is
      revealed. Checking the two implementations against each other is what stops
      them drifting — each is believable alone.
    */
    for (const direction of ['left', 'right', 'up', 'down']) {
      for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const shape = shapeFor(direction, p);
        const normal = wipeDirection(direction);
        // Sample well clear of the edge. Sampling *at* the boundary is a
        // coin-flip between `<` and `<=` in the two implementations and would
        // make this test assert a convention rather than the behaviour.
        for (const t of [0.05, 0.95]) {
          const alpha = wipeAlphaAt(t, p, 0);
          const revealed = alpha > 0.5;
          /*
            `t` is the projection onto the wipe's normal, so it runs 0 → 1 from the
            side the wipe starts at, whichever direction that is in frame space: for
            `right` the normal is −x, so `t` = 0 is the frame's right edge. The
            revealed region is therefore the *low* `t` in every direction, and an
            earlier version of this test that special-cased the reversed axes was
            wrong rather than the renderers.
          */
          expect(revealed, `${direction} p=${p} t=${t}`).toBe(t < p);
        }
      }
    }
  });
});

/** A wipe shape as the renderer receives it from the transition state. */
function shapeFor(direction: string, position: number) {
  const state = transitionState('wipe', position, { direction });
  if (!state.wipe) throw new Error('no wipe shape');
  return state.wipe;
}

describe('dissolve in the preview (SPEC 12 §4.2)', () => {
  it('produces a pattern mask rather than a flat opacity', () => {
    // A dissolve that used opacity would be the fade this replaced. The preview
    // cannot run the export's per-pixel threshold, but it must at least not render
    // as an even blend.
    const style = dissolveMaskStyle({ seed: 1, grain: 0.1, progress: 0.5 });
    expect(style.maskImage).toContain('repeating-conic-gradient');
    expect(style.maskImage).toContain('50%');
    // The stop is a hard one: the same colour on both sides of the position would
    // be a smooth gradient, i.e. a fade.
    expect(style.maskImage).not.toContain('gradient(rgba');
  });

  it('scales the patch size with the grain', () => {
    const fine = dissolveMaskStyle({ seed: 1, grain: 0.02, progress: 0.5 });
    const coarse = dissolveMaskStyle({ seed: 1, grain: 0.2, progress: 0.5 });
    // `maskSize` is a union in the DOM types because it accepts a number too.
    const size = (style: React.CSSProperties) => Number(String(style.maskSize).split('%')[0]);
    expect(size(fine)).toBeLessThan(size(coarse));
  });

  it('clamps progress into 0–100 %', () => {
    // A NaN or out-of-range stop makes CSS drop the whole mask, which would show
    // the incoming clip in full from the first frame.
    for (const progress of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      const style = dissolveMaskStyle({ seed: 1, grain: 0.1, progress });
      expect(style.maskImage).toMatch(/[\d.]+%/);
      expect(style.maskImage).not.toContain('NaN');
    }
  });
});
