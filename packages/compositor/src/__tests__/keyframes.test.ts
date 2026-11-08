/**
 * SPEC 12 §2.1 — `evaluate()`.
 *
 * The rules that matter, and the specific bug each one prevents:
 *
 * - holding outside the key range, so a two-key animation does not snap back to
 *   the base value before it starts or after it ends;
 * - `hold` interpolation, which is how a step change is written down;
 * - easing attached to the *outgoing* key, which decides where a change to the
 *   curve is made;
 * - two keys at the same instant, where a division by a zero span would produce
 *   NaN and poison every transform downstream of it.
 */
import { describe, expect, it } from 'vitest';
import { cubicBezier, evaluate, evaluateNumber, evaluateProperty, keyframeTimes } from '../keyframes.js';
import type { Keyframe } from '@clipwright/project-schema/schemas';

const key = (timeUs: number, value: number, extra: Partial<Keyframe> = {}): Keyframe =>
  ({ timeUs, value, interpolation: 'linear', ...extra }) as Keyframe;

describe('evaluate', () => {
  it('returns undefined when the property has no keys', () => {
    // The caller has to be able to tell "not animated" from "animated to zero".
    expect(evaluate(undefined, 0)).toBeUndefined();
    expect(evaluate([], 500)).toBeUndefined();
  });

  it('holds the first value before the first key', () => {
    // Otherwise an animation that starts at 2 s shows a different value from 0–2 s
    // and the clip jumps when playback begins.
    expect(evaluate([key(2_000_000, 10), key(4_000_000, 20)], 0)).toBe(10);
    expect(evaluate([key(2_000_000, 10), key(4_000_000, 20)], 1_999_999)).toBe(10);
  });

  it('holds the last value after the last key', () => {
    expect(evaluate([key(0, 10), key(1_000_000, 20)], 9_000_000)).toBe(20);
  });

  it('returns the exact value at a key', () => {
    const keys = [key(0, 0), key(1_000_000, 100)];
    expect(evaluate(keys, 0)).toBe(0);
    expect(evaluate(keys, 1_000_000)).toBe(100);
  });

  it('interpolates linearly in between', () => {
    const keys = [key(0, 0), key(1_000_000, 100)];
    expect(evaluate(keys, 250_000)).toBe(25);
    expect(evaluate(keys, 500_000)).toBe(50);
    expect(evaluate(keys, 750_000)).toBe(75);
  });

  it('interpolates each component of a vector key', () => {
    const keys = [
      { timeUs: 0, value: [0, 0, 0, 0], interpolation: 'linear' },
      { timeUs: 1_000_000, value: [0.2, 0.4, 0.6, 0.8], interpolation: 'linear' },
    ] as Keyframe[];
    expect(evaluate(keys, 500_000)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('holds through a hold segment instead of interpolating', () => {
    // A step: the crop stays put, then changes at the next key.
    const keys = [key(0, 0, { interpolation: 'hold' }), key(1_000_000, 100)];
    expect(evaluate(keys, 500_000)).toBe(0);
    expect(evaluate(keys, 999_999)).toBe(0);
    expect(evaluate(keys, 1_000_000)).toBe(100);
  });

  it('applies the easing of the key the segment leaves', () => {
    // Ease-in on the *first* key means the movement starts slowly. If easing were
    // read off the incoming key instead, this would be a straight line.
    const keys = [key(0, 0, { interpolation: 'preset', easing: { preset: 'easeInCubic' } }), key(1_000_000, 100)];
    const midpoint = evaluate(keys, 500_000) as number;
    expect(midpoint).toBeLessThan(50); // 0.5³ = 0.125
    expect(midpoint).toBeCloseTo(12.5, 6);
  });

  it('applies ease-out as the mirror image', () => {
    const keys = [key(0, 0, { interpolation: 'preset', easing: { preset: 'easeOutCubic' } }), key(1_000_000, 100)];
    const midpoint = evaluate(keys, 500_000) as number;
    expect(midpoint).toBeGreaterThan(50);
    expect(midpoint).toBeCloseTo(87.5, 6);
  });

  it('eases a bezier segment through its control points', () => {
    const keys = [
      key(0, 0, { interpolation: 'bezier', bezier: { outX: 0.42, outY: 0, inX: 0.58, inY: 1 } }),
      key(1_000_000, 100),
    ];
    const value = evaluate(keys, 500_000) as number;
    // Symmetric control points put the midpoint at half, but the ends move slowly.
    expect(value).toBeCloseTo(50, 1);
    expect(evaluate(keys, 100_000) as number).toBeLessThan(10);
    expect(evaluate(keys, 900_000) as number).toBeGreaterThan(90);
  });

  it('survives two keys at the same instant', () => {
    // A zero span divides to NaN, and NaN multiplies into every transform the item
    // draws with — the frame goes blank or the export fails without a message.
    const keys = [key(0, 0), key(1_000_000, 10), key(1_000_000, 20), key(2_000_000, 20)];
    const value = evaluate(keys, 1_000_000) as number;
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBe(20);
  });

  it('sorts keys that arrive out of order', () => {
    // Undoing a delete can restore a key in the middle of the array.
    const keys = [key(2_000_000, 200), key(0, 0), key(1_000_000, 100)];
    expect(evaluate(keys, 500_000)).toBe(50);
    expect(evaluate(keys, 1_500_000)).toBe(150);
  });

  it('treats a single key as a constant', () => {
    expect(evaluate([key(1_000_000, 42)], 0)).toBe(42);
    expect(evaluate([key(1_000_000, 42)], 9_000_000)).toBe(42);
  });

  it('is a pure function of its input', () => {
    const keys = [key(0, 0), key(1_000_000, 100)];
    const before = JSON.stringify(keys);
    evaluate(keys, 500_000);
    // The sort must not reorder the caller's array in place.
    expect(JSON.stringify(keys)).toBe(before);
  });
});

describe('cubicBezier', () => {
  it('passes through the endpoints', () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBeCloseTo(1, 6);
  });

  it('is monotone for a monotone curve', () => {
    const samples = Array.from({ length: 21 }, (_, index) => cubicBezier(0.25, 0.1, 0.25, 1, index / 20));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!).toBeGreaterThanOrEqual(samples[index - 1]!);
    }
  });

  it('clamps progress outside 0–1', () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, -1)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1, 2)).toBeCloseTo(1, 6);
  });

  it('handles control points on the edge, where Newton would fail', () => {
    // outX = 0 puts the curve's derivative at zero at t=0; a Newton iteration
    // divides by that and returns NaN, stalling the render.
    const value = cubicBezier(0, 0, 1, 1, 0.5);
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBeCloseTo(0.5, 2);
  });
});

describe('evaluateNumber', () => {
  it('falls back when the property is not animated', () => {
    expect(evaluateNumber(undefined, 0, 7)).toBe(7);
  });

  it('falls back on a non-finite value rather than drawing NaN', () => {
    const keys = [{ timeUs: 0, value: Number.NaN, interpolation: 'linear' }] as Keyframe[];
    expect(evaluateNumber(keys, 0, 7)).toBe(7);
  });

  it('reads the first component of a vector', () => {
    const keys = [{ timeUs: 0, value: [0.3, 0.4, 0.5, 0.6], interpolation: 'linear' }] as Keyframe[];
    expect(evaluateNumber(keys, 0, 0)).toBe(0.3);
  });
});

describe('evaluateProperty', () => {
  it('reads the path the item stores the animation under', () => {
    const map = { 'transform.x': [key(0, 0), key(1_000_000, 100)] };
    expect(evaluateProperty(map, 'transform.x', 500_000, 0)).toBe(50);
    expect(evaluateProperty(map, 'transform.y', 500_000, 12)).toBe(12);
  });

  it('copes with no keyframe map at all', () => {
    expect(evaluateProperty(undefined, 'opacity', 0, 1)).toBe(1);
  });
});

describe('keyframeTimes', () => {
  it('returns sorted unique times for the timeline diamonds', () => {
    const keys = [key(1_000_000, 0), key(0, 0), key(1_000_000, 5), key(2_000_000, 0)];
    expect(keyframeTimes(keys)).toEqual([0, 1_000_000, 2_000_000]);
  });

  it('returns nothing for a property without keys', () => {
    expect(keyframeTimes(undefined)).toEqual([]);
  });
});
