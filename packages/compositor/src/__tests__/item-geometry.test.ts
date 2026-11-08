/**
 * SPEC 10 §8.4–8.6 — the geometry the preview has to apply.
 *
 * The interesting cases are the ones where a stored value is ambiguous: an old
 * project carrying `scale` but not `scaleX`, a crop that would leave no picture at
 * all, and the default item that must not be wrapped in a transform it does not
 * need (every wrapper is a new stacking context, and the caption overlay sits
 * above it).
 */
import { describe, expect, it } from 'vitest';
import { croppedSource, effectiveScale, itemGeometry } from '../item-geometry.js';

describe('effectiveScale', () => {
  it('is 1 for an untouched item', () => {
    expect(effectiveScale(undefined)).toEqual({ x: 1, y: 1 });
    expect(effectiveScale({})).toEqual({ x: 1, y: 1 });
  });

  it('honours the legacy framing scale while the axes are untouched', () => {
    // `07 §6.2` writes `transform.scale` when a clip is created from a moment; a
    // build that ignored it would show every such clip at full size the first time
    // it was opened, which reads as the app having lost the framing.
    expect(effectiveScale({ scale: 1.4 })).toEqual({ x: 1.4, y: 1.4 });
  });

  it('lets the per-axis values win once either is set', () => {
    // The inspector writes scaleX and scaleY together, so a scale of 2 with an
    // untouched scaleY of 1 is a real non-square scale, not a stale default.
    expect(effectiveScale({ scale: 1.4, scaleX: 2 })).toEqual({ x: 2, y: 1 });
    expect(effectiveScale({ scale: 1.4, scaleY: 0.5 })).toEqual({ x: 1, y: 0.5 });
  });
});

describe('croppedSource', () => {
  it('is the whole source when nothing is cropped', () => {
    expect(croppedSource(undefined)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(croppedSource({})).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('shifts the origin and shrinks the rectangle', () => {
    expect(croppedSource({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.6, // 1 − 0.1 − 0.3
      height: 0.7, // 1 − 0.2 − 0.1
    });
  });

  it('never returns a rectangle with no area', () => {
    // The command refuses to create this, but a hand-edited file can contain it,
    // and a zero width here becomes an infinite scale factor in the view.
    const source = croppedSource({ left: 0.9, right: 0.9 });
    expect(source.width).toBeGreaterThan(0);
    expect(source.height).toBeGreaterThan(0);
  });

  it('clamps a negative edge rather than growing the picture', () => {
    const source = croppedSource({ left: -0.5, right: -0.5 });
    expect(source.x).toBe(0);
    expect(source.width).toBe(1);
  });
});

describe('itemGeometry', () => {
  it('marks a default item as identity', () => {
    // The caller skips the transform wrapper, and the caption canvas keeps its
    // own stacking context.
    expect(itemGeometry({}).identity).toBe(true);
    expect(itemGeometry({ crop: {}, transform: {} }).identity).toBe(true);
  });

  it('is not identity once anything is set', () => {
    expect(itemGeometry({ crop: { left: 0.1 } }).identity).toBe(false);
    expect(itemGeometry({ transform: { scale: 1.2 } }).identity).toBe(false);
    expect(itemGeometry({ transform: { rotation: 5 } }).identity).toBe(false);
    expect(itemGeometry({ transform: { x: 0.1 } }).identity).toBe(false);
    expect(itemGeometry({ transform: { flipH: true } }).identity).toBe(false);
  });

  it('carries the flip flags through', () => {
    const geometry = itemGeometry({ transform: { flipH: true, flipV: true } });
    expect(geometry.flipH).toBe(true);
    expect(geometry.flipV).toBe(true);
  });

  it('combines crop, scale, rotation and offset without dropping any', () => {
    const geometry = itemGeometry({
      crop: { left: 0.25, right: 0.25 },
      transform: { x: 0.1, y: -0.05, scaleX: 1.5, scaleY: 1.5, rotation: 30 },
    });
    expect(geometry.source).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(geometry.offsetX).toBe(0.1);
    expect(geometry.offsetY).toBe(-0.05);
    expect(geometry.scaleX).toBe(1.5);
    expect(geometry.scaleY).toBe(1.5);
    expect(geometry.rotation).toBe(30);
    expect(geometry.identity).toBe(false);
  });

  it('is a pure function of its input', () => {
    // Same stored values, same geometry — the preview and the export must not be
    // able to disagree about where a cropped clip sits.
    const input = { crop: { top: 0.1 }, transform: { scale: 1.2, rotation: 10 } };
    expect(itemGeometry(input)).toEqual(itemGeometry({ ...input }));
    expect(itemGeometry(input)).not.toBe(itemGeometry(input));
  });
});

/**
 * SPEC 12 §2.1 — a keyframed property has to reach the geometry.
 *
 * The distinction these tests draw is between "animated" and "not animated" per
 * *property*, not per item: a clip with a keyframed move and a static scale is the
 * normal case, and an implementation that decided once, per item, would freeze one
 * of them at its base value.
 */
describe('itemGeometry with keyframes', () => {
  const keys = (pairs: Array<[number, number]>) =>
    pairs.map(([timeUs, value]) => ({ timeUs, value, interpolation: 'linear' as const }));

  it('reads the static values when no time is given', () => {
    const geometry = itemGeometry({
      transform: { x: 0.5 },
      keyframes: { 'transform.x': keys([[0, 0], [1_000_000, 1]]) },
    });
    expect(geometry.offsetX).toBe(0.5);
  });

  it('animates a keyframed offset', () => {
    const keyframes = { 'transform.x': keys([[0, 0], [1_000_000, 1]]) };
    expect(itemGeometry({ keyframes, timeUs: 0 }).offsetX).toBe(0);
    expect(itemGeometry({ keyframes, timeUs: 250_000 }).offsetX).toBe(0.25);
    expect(itemGeometry({ keyframes, timeUs: 1_000_000 }).offsetX).toBe(1);
  });

  it('animates scale, rotation and crop together', () => {
    const keyframes = {
      'transform.scaleX': keys([[0, 1], [1_000_000, 2]]),
      'transform.scaleY': keys([[0, 1], [1_000_000, 2]]),
      'transform.rotation': keys([[0, 0], [1_000_000, 90]]),
      'crop.left': keys([[0, 0], [1_000_000, 0.4]]),
    };
    const geometry = itemGeometry({ keyframes, timeUs: 500_000 });
    expect(geometry.scaleX).toBe(1.5);
    expect(geometry.scaleY).toBe(1.5);
    expect(geometry.rotation).toBe(45);
    expect(geometry.source.x).toBeCloseTo(0.2, 6);
    expect(geometry.source.width).toBeCloseTo(0.8, 6);
  });

  it('leaves a property that is not animated at its static value', () => {
    // The mix is the point: an animated move must not drag the static scale along.
    const geometry = itemGeometry({
      transform: { scaleX: 1.25, scaleY: 1.25 },
      keyframes: { 'transform.x': keys([[0, 0], [1_000_000, 1]]) },
      timeUs: 500_000,
    });
    expect(geometry.offsetX).toBe(0.5);
    expect(geometry.scaleX).toBe(1.25);
  });

  it('prefers the animation over the static value for the same property', () => {
    const geometry = itemGeometry({
      transform: { rotation: 90 },
      keyframes: { 'transform.rotation': keys([[0, 0], [1_000_000, 10]]) },
      timeUs: 500_000,
    });
    expect(geometry.rotation).toBe(5);
  });

  it('is still identity when nothing is set and no keys exist', () => {
    expect(itemGeometry({ keyframes: {}, timeUs: 500 }).identity).toBe(true);
  });

  it('keeps the crop rectangle valid at every instant of an animated crop', () => {
    // A keyframed crop sweeps through many rectangles; every one has to stay
    // drawable, or a pan-and-zoom blanks the frame partway through.
    const keyframes = {
      'crop.left': keys([[0, 0], [1_000_000, 0.9]]),
      'crop.right': keys([[0, 0], [1_000_000, 0.9]]),
    };
    for (let timeUs = 0; timeUs <= 1_000_000; timeUs += 50_000) {
      const source = itemGeometry({ keyframes, timeUs }).source;
      expect(source.width).toBeGreaterThan(0);
      expect(source.x).toBeGreaterThanOrEqual(0);
      expect(source.x + source.width).toBeLessThanOrEqual(1.0000001);
    }
  });
});
