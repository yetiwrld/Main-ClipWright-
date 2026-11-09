import { describe, expect, it } from 'vitest';
import {
  MIN_GUIDE_GAP,
  addGuide,
  axisForEdge,
  edgeAt,
  guideSnapTargets,
  guideToRemove,
  removeGuide,
  type UserGuideRecord,
} from '../features/editor/user-guides.js';

/**
 * User-placed composition guides (SPEC 10 §8.8).
 *
 * The gesture and the drawing are checked elsewhere; what is checked here is the storage
 * rule, the edge that started a drag, and the one conversion that has now gone wrong
 * three times in this codebase — top-left fractions to centre-relative targets.
 */

const guide = (id: string, axis: 'x' | 'y', at: number): UserGuideRecord => ({ id, axis, at });

describe('which edge a Ctrl-drag began on', () => {
  it('recognises all four edges', () => {
    expect(edgeAt(0.01, 0.5)).toBe('left');
    expect(edgeAt(0.99, 0.5)).toBe('right');
    expect(edgeAt(0.5, 0.01)).toBe('top');
    expect(edgeAt(0.5, 0.99)).toBe('bottom');
  });

  it('declines in the middle of the canvas', () => {
    // An ordinary drag over the picture must never be mistaken for a guide drag.
    expect(edgeAt(0.5, 0.5)).toBeNull();
    expect(edgeAt(0.2, 0.2)).toBeNull();
  });

  it('picks the nearest edge from a corner rather than two guides', () => {
    /*
      A corner is inside two edges' grab zones. Returning one keeps the gesture producing
      one line, which is what a single drag means — and the nearest is the one the user
      was reaching for.
    */
    expect(edgeAt(0.01, 0.03)).toBe('left');
    expect(edgeAt(0.03, 0.01)).toBe('top');
  });

  it('declines on numbers that are not numbers', () => {
    // A canvas with no measured size yet must not produce a guide at NaN.
    expect(edgeAt(Number.NaN, 0.5)).toBeNull();
    expect(edgeAt(0.5, Number.NaN)).toBeNull();
  });
});

describe('which axis a guide runs on', () => {
  it('pulls from a side and gets a line parallel to it', () => {
    /*
      Dragging inward from the left or right edge makes a *vertical* guide, which has a
      fixed x. This is the reading that matches the gesture, and getting it backwards
      would produce a horizontal line from a sideways pull.
    */
    expect(axisForEdge('left')).toBe('x');
    expect(axisForEdge('right')).toBe('x');
    expect(axisForEdge('top')).toBe('y');
    expect(axisForEdge('bottom')).toBe('y');
  });
});

describe('adding and removing guides', () => {
  it('appends a guide', () => {
    expect(addGuide([], guide('g1', 'x', 0.25))).toEqual([guide('g1', 'x', 0.25)]);
  });

  it('replaces a guide placed practically on top of another', () => {
    /*
      Two guides half a percent apart are one guide placed twice. Keeping both makes the
      snapping a coin toss between two targets a hair apart, and leaves a canvas nobody
      can tidy without deleting twice.
    */
    const existing = [guide('g1', 'x', 0.25)];
    const result = addGuide(existing, guide('g2', 'x', 0.25 + MIN_GUIDE_GAP / 2));
    expect(result).toHaveLength(1);
    // The newer position wins: the last thing the user did is what they meant.
    expect(result[0]!.id).toBe('g2');
  });

  it('keeps a guide on the other axis, however close', () => {
    // A vertical and a horizontal guide crossing is two deliberate lines, not a duplicate.
    const result = addGuide([guide('g1', 'y', 0.25)], guide('g2', 'x', 0.25));
    expect(result).toHaveLength(2);
  });

  it('clamps a guide into the canvas rather than dropping it', () => {
    // A pointer dragged past the edge still names a position; the line belongs on the
    // edge, not nowhere.
    expect(addGuide([], guide('g', 'x', 1.4))[0]!.at).toBe(1);
    expect(addGuide([], guide('g', 'x', -0.4))[0]!.at).toBe(0);
  });

  it('refuses to add a guide at a non-finite position', () => {
    // The NaN rule again: a guide at NaN draws nowhere and snaps nothing, forever.
    expect(addGuide([guide('g1', 'x', 0.5)], guide('g2', 'x', Number.NaN))).toHaveLength(1);
  });

  it('removes by id, and removing something absent is not an error', () => {
    const guides = [guide('g1', 'x', 0.2), guide('g2', 'y', 0.8)];
    expect(removeGuide(guides, 'g1')).toEqual([guide('g2', 'y', 0.8)]);
    expect(removeGuide(guides, 'nope')).toHaveLength(2);
  });
});

describe('guides as snap targets', () => {
  it('shifts a stored fraction into centre-relative space', () => {
    /*
      Stored from the top-left, snapped from the centre. The half-canvas shift has now
      gone wrong three separate times in this codebase — safe areas, thirds, and here —
      so it is a function with a test rather than a subtraction at each call site.
    */
    expect(guideSnapTargets([guide('g', 'x', 0.75)], 'x')[0]!.at).toBeCloseTo(0.25, 10);
    expect(guideSnapTargets([guide('g', 'x', 0.25)], 'x')[0]!.at).toBeCloseTo(-0.25, 10);
    expect(guideSnapTargets([guide('g', 'y', 0.5)], 'y')[0]!.at).toBeCloseTo(0, 10);
  });

  it('offers only the guides on the axis asked for', () => {
    // A vertical guide must not become a horizontal snap target.
    const guides = [guide('gx', 'x', 0.3), guide('gy', 'y', 0.7)];
    // `toBeCloseTo`: 0.3 − 0.5 is −0.2 but 0.7 − 0.5 is 0.19999999999999996.
    expect(guideSnapTargets(guides, 'x')).toHaveLength(1);
    expect(guideSnapTargets(guides, 'x')[0]!.at).toBeCloseTo(-0.2, 10);
    expect(guideSnapTargets(guides, 'y')).toHaveLength(1);
    expect(guideSnapTargets(guides, 'y')[0]!.at).toBeCloseTo(0.2, 10);
  });

  it('labels them as user guides', () => {
    // The guide drawn for one must not claim to be an item edge.
    expect(guideSnapTargets([guide('g', 'x', 0.5)], 'x')[0]!.kind).toBe('user-guide');
  });

  it('offers nothing when the user has made none', () => {
    expect(guideSnapTargets([], 'x')).toEqual([]);
  });
});

describe('finding the guide a removal gesture is aimed at', () => {
  const guides = [guide('v1', 'x', 0.25), guide('v2', 'x', 0.8), guide('h1', 'y', 0.25)];

  it('finds the guide nearest the pointer on its axis', () => {
    expect(guideToRemove(guides, 'x', 0.26)?.id).toBe('v1');
  });

  it('ignores the axis the gesture runs on — a guide is grabbable anywhere along it', () => {
    /*
      A vertical guide crosses the whole picture, so a gesture on the `x` axis is matched
      on `x` alone; the distance along `y` is irrelevant and is not even passed in. A
      removal that required hitting the line itself would be a target a pixel wide.
    */
    expect(guideToRemove(guides, 'y', 0.25)?.id).toBe('h1');
  });

  it('returns nothing when the nearest guide is out of reach', () => {
    // Otherwise a removal gesture anywhere on a sparse canvas would delete something.
    expect(guideToRemove(guides, 'x', 0.5)).toBeNull();
  });

  it('picks the nearer of two guides in reach', () => {
    const close = [guide('a', 'x', 0.300), guide('b', 'x', 0.305)];
    expect(guideToRemove(close, 'x', 0.304)?.id).toBe('b');
  });

  it('declines a degenerate reach rather than matching everything', () => {
    // The same NaN guard the snapping uses, for the same reason: every comparison against
    // NaN is false, so a naive `distance > reach` would skip nothing and delete a guide
    // the pointer was nowhere near.
    expect(guideToRemove(guides, 'x', 0.25, Number.NaN)).toBeNull();
    expect(guideToRemove(guides, 'x', 0.25, 0)).toBeNull();
  });

  it('returns nothing from an empty project', () => {
    expect(guideToRemove([], 'x', 0.25)).toBeNull();
  });
});
