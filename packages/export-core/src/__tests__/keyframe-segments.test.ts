/**
 * SPEC 12 §2.2 — segmenting a keyframed item for a decoder without time.
 *
 * The three properties that matter, and what each one costs if it is wrong:
 *
 * - **one segment when nothing animates** — the old behaviour has to survive, or
 *   every export gets slower the moment keyframes exist;
 * - **no zero-length segment** — ffmpeg fails on a `trim` with an empty range and
 *   the export stops with a message about a filter, not about the keyframe;
 * - **equal neighbours merge** — a user who places two keys with the same value
 *   (very common: the app starts the second key at the first one's value) should
 *   not pay for a second decode.
 */
import { describe, expect, it } from 'vitest';
import { geometrySegments, sameGeometry, segmentBoundaries } from '../keyframe-segments.js';
import type { GeometrySegment } from '../keyframe-segments.js';

/** The test's stand-in for the caller's geometry type. */
type GeometrySample = GeometrySegment<{ transform?: { scaleX?: number; scaleY?: number } }>['geometry'];

const at = (scale: number) => (): GeometrySample => ({ transform: { scaleX: scale, scaleY: scale } });

describe('segmentBoundaries', () => {
  it('is just the start when no keyframes exist', () => {
    expect(segmentBoundaries([], 5_000_000)).toEqual([0]);
  });

  it('collects and sorts every key time', () => {
    expect(segmentBoundaries([[2_000_000], [1_000_000, 3_000_000]], 5_000_000)).toEqual([
      0, 1_000_000, 2_000_000, 3_000_000,
    ]);
  });

  it('deduplicates a time two properties share', () => {
    // A move and a rotation keyed at the same instant are one boundary, not two.
    expect(segmentBoundaries([[1_000_000], [1_000_000]], 5_000_000)).toEqual([0, 1_000_000]);
  });

  it('drops a key at zero, which is already the start', () => {
    expect(segmentBoundaries([[0, 1_000_000]], 5_000_000)).toEqual([0, 1_000_000]);
  });

  it('drops a key at or past the end, which would make an empty segment', () => {
    expect(segmentBoundaries([[5_000_000, 9_000_000]], 5_000_000)).toEqual([0]);
  });
});

describe('geometrySegments', () => {
  it('returns one segment for a static item', () => {
    // The common case, and the one that must not regress: one decode, as before.
    const segments = geometrySegments({ durationUs: 2_000_000, geometryAt: at(1) });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ startUs: 0, endUs: 2_000_000, geometry: { transform: { scaleX: 1, scaleY: 1 } } });
  });

  it('splits at each keyframe and bakes a constant value per segment', () => {
    const values = [1, 2, 3];
    let call = 0;
    const segments = geometrySegments({
      durationUs: 3_000_000,
      keyframeTimes: [[1_000_000, 2_000_000]],
      // The geometry at a segment's start is what gets baked for that segment.
      geometryAt: () => ({ transform: { scaleX: values[call++]!, scaleY: values[0]! } }),
    });
    expect(segments.map((segment) => [segment.startUs, segment.endUs])).toEqual([
      [0, 1_000_000],
      [1_000_000, 2_000_000],
      [2_000_000, 3_000_000],
    ]);
    expect(segments.map((segment) => segment.geometry.transform?.scaleX)).toEqual([1, 2, 3]);
  });

  it('covers the range exactly, with no gap and no overlap', () => {
    const segments = geometrySegments({
      durationUs: 4_000_000,
      keyframeTimes: [[1_000_000, 2_500_000]],
      geometryAt: at(1.5),
    });
    expect(segments[0]!.startUs).toBe(0);
    expect(segments[segments.length - 1]!.endUs).toBe(4_000_000);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.startUs).toBe(segments[index - 1]!.endUs);
    }
  });

  it('merges neighbouring segments whose values are equal', () => {
    // A hold, or two keys the user gave the same value. Splitting anyway would
    // double the decode cost for a picture that does not change.
    const segments = geometrySegments({
      durationUs: 3_000_000,
      keyframeTimes: [[1_000_000, 2_000_000]],
      geometryAt: at(1),
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.endUs).toBe(3_000_000);
  });

  it('keeps a segment that changes only the rotation', () => {
    const segments = geometrySegments({
      durationUs: 2_000_000,
      keyframeTimes: [[1_000_000]],
      geometryAt: (timeUs) => ({ transform: { rotation: timeUs === 0 ? 0 : 45 } }),
    });
    expect(segments).toHaveLength(2);
    expect(segments[1]!.geometry.transform?.rotation).toBe(45);
  });

  it('caps the segment count rather than spawning a decode per key', () => {
    // A pathological file with a key on every frame would otherwise start hundreds
    // of ffmpeg processes and never finish.
    const times = Array.from({ length: 200 }, (_, index) => (index + 1) * 10_000);
    const segments = geometrySegments({
      durationUs: 2_000_100,
      keyframeTimes: [times],
      geometryAt: (timeUs) => ({ transform: { x: timeUs / 2_000_100 } }),
      maxSegments: 8,
    });
    expect(segments.length).toBeLessThanOrEqual(8);
    expect(segments[segments.length - 1]!.endUs).toBe(2_000_100);
  });

  it('never emits a zero-length segment', () => {
    const segments = geometrySegments({
      durationUs: 1_000_000,
      keyframeTimes: [[1_000_000, 0, 500_000]],
      geometryAt: (timeUs) => ({ transform: { x: timeUs } }),
    });
    for (const segment of segments) {
      expect(segment.endUs).toBeGreaterThan(segment.startUs);
    }
  });

  it('clamps a fractional duration to whole microseconds', () => {
    const segments = geometrySegments({ durationUs: 1_000_000.7, geometryAt: at(1) });
    expect(segments[0]!.endUs).toBe(1_000_001);
  });

  it('never produces a zero-length range for a zero duration', () => {
    // An item can be trimmed to nothing by an undo of an insert; an empty range
    // makes ffmpeg fail with a message about the trim filter.
    const segments = geometrySegments({ durationUs: 0, geometryAt: at(1) });
    expect(segments[0]!.endUs).toBeGreaterThan(0);
  });
});

describe('sameGeometry', () => {
  it('treats two empty samples as equal', () => {
    expect(sameGeometry({}, {})).toBe(true);
  });

  it('ignores differences below six decimals', () => {
    // The values come out of floating-point interpolation; a difference in the
    // last bit must not cost a second pass over the source.
    expect(sameGeometry({ transform: { x: 0.5 } }, { transform: { x: 0.5 + 1e-9 } })).toBe(true);
  });

  it('notices a difference that would change the picture', () => {
    expect(sameGeometry({ transform: { x: 0.5 } }, { transform: { x: 0.5001 } })).toBe(false);
  });

  it('compares flips as booleans, not numbers', () => {
    expect(sameGeometry({ transform: { flipH: true } }, { transform: { flipH: false } })).toBe(false);
    expect(sameGeometry({ transform: { flipH: false } }, {})).toBe(true);
  });

  it('compares every crop edge', () => {
    const base = { crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 } };
    expect(sameGeometry(base, { crop: { ...base.crop } })).toBe(true);
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      expect(sameGeometry(base, { crop: { ...base.crop, [edge]: 0.2 } }), edge).toBe(false);
    }
  });
});
