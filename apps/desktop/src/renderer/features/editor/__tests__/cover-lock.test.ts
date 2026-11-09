import { describe, expect, it } from 'vitest';
import {
  blocksCoverScale,
  clampCoverPosition,
  coverLimit,
  coverScaleFloor,
  coversCanvas,
  drawnExtent,
  isMainVideo,
  minCoverFactor,
  type CoverExtent,
} from '../cover-lock.js';

/** A picture that exactly fills the frame, dead centre. */
const filled = (over: Partial<CoverExtent> = {}): CoverExtent => ({
  width: 1,
  height: 1,
  offsetX: 0,
  offsetY: 0,
  ...over,
});

describe('where a covering picture may be dragged (SPEC 10 §8.5)', () => {
  it('pins an exactly-covering picture to the centre', () => {
    /*
      Width 1 means any offset exposes canvas on one side, so the limit is zero. This is
      the common case — the "fill" video the spec's sentence is about — and getting it
      wrong is a one-sided gap that is easy to miss on a dark background.
    */
    expect(coverLimit(1)).toBe(0);
    expect(clampCoverPosition({ x: 0.2, y: 0 }, filled())).toEqual({
      x: 0,
      y: 0,
      clampedX: true,
      clampedY: false,
    });
  });

  it('allows half the overhang when the picture is twice the canvas', () => {
    // 2× wide: its edges sit at offset ± 1, so it covers until |offset| = 0.5.
    expect(coverLimit(2)).toBe(0.5);
    const result = clampCoverPosition({ x: 0.9, y: 0 }, filled({ width: 2 }));
    expect(result.x).toBe(0.5);
    expect(result.clampedX).toBe(true);
  });

  it('negates the limit on the other side, rather than only clamping the positive one', () => {
    /*
      A clamp written with a single `Math.min` lets a picture slide off in one direction
      only — and a negative offset is the left edge of the frame, which is exactly the
      edge a user drags a clip towards.
    */
    expect(clampCoverPosition({ x: -0.9, y: 0 }, filled({ width: 2 })).x).toBe(-0.5);
  });

  it('leaves a picture narrower than the canvas alone', () => {
    /*
      A 0.4-wide overlay cannot cover at any position, so there is no range to clamp to.
      Returning a limit anyway would be a lower bound above the upper bound — the clamps
      fight and the clip lands somewhere arbitrary. The lock has nothing to protect here.
    */
    expect(coverLimit(0.4)).toBeNull();
    expect(clampCoverPosition({ x: 0.3, y: -0.3 }, filled({ width: 0.4, height: 0.4 }))).toEqual({
      x: 0.3,
      y: -0.3,
      clampedX: false,
      clampedY: false,
    });
  });

  it('clamps each axis by its own size', () => {
    // A wide-but-short picture is already not covering vertically; the two axes must not
    // share one limit, which is the bug a square canvas would hide.
    const extent = filled({ width: 2, height: 1 });
    const result = clampCoverPosition({ x: 0.9, y: 0.4 }, extent);
    expect(result.x).toBe(0.5);
    expect(result.y).toBe(0);
    expect(result.clampedY).toBe(true);
  });

  it('reports no clamp when the position is already inside the limit', () => {
    // The flag drives "the drag stopped here" feedback; claiming a clamp on a free move
    // would make every drag report as blocked.
    expect(clampCoverPosition({ x: 0.2, y: 0 }, filled({ width: 2 })).clampedX).toBe(false);
  });

  it('treats a non-finite size as no limit rather than producing NaN', () => {
    // A NaN extent comes from source metadata that has not loaded; clamping against it
    // would put the picture at NaN and the layer would not draw at all.
    expect(coverLimit(Number.NaN)).toBeNull();
    const result = clampCoverPosition({ x: 0.3, y: 0 }, filled({ width: Number.NaN }));
    expect(result.x).toBe(0.3);
  });
});

describe('scaling below cover (SPEC 10 §8.5)', () => {
  it('blocks a scale that takes a covering picture under 1', () => {
    expect(blocksCoverScale(filled(), { width: 0.8, height: 0.8 })).toBe(true);
  });

  it('allows scaling up', () => {
    expect(blocksCoverScale(filled(), { width: 1.5, height: 1.5 })).toBe(false);
  });

  it('does not block when the axis that would drop below 1 was not covering anyway', () => {
    /*
      A picture 0.6 tall was never covering vertically, so shrinking it further exposes
      nothing that was not already exposed. Blocking here would make the lock a veto on
      every overlay scale — the setting would have to be turned off to do ordinary work,
      which is how a protection becomes a nuisance and then gets ignored.
    */
    expect(blocksCoverScale(filled({ height: 0.6 }), { width: 1.2, height: 0.4 })).toBe(false);
  });

  it('blocks only the axis that crosses 1', () => {
    // Width was covering and would not be; height never was.
    expect(blocksCoverScale(filled({ height: 0.6 }), { width: 0.9, height: 0.5 })).toBe(true);
  });

  it('does not block a scale that stays exactly at cover', () => {
    // Landing on 1 is still covering; an exclusive comparison would fight the user at
    // the last frame of the drag.
    expect(blocksCoverScale(filled(), { width: 1, height: 1 })).toBe(false);
  });
});

describe('whether a picture covers the frame right now', () => {
  it('is true for a centred picture at scale 1', () => {
    expect(coversCanvas(filled())).toBe(true);
  });

  it('is false when the picture is off-centre', () => {
    expect(coversCanvas(filled({ offsetX: 0.05 }))).toBe(false);
  });

  it('is false when the picture is smaller than the frame', () => {
    expect(coversCanvas(filled({ height: 0.9 }))).toBe(false);
  });

  it('is false when the picture is larger but pushed too far', () => {
    /*
      The case that separates "big enough" from "actually covering": a 2× picture pushed
      a full canvas to the side still *looks* cropped in a thumbnail and exposes nothing
      at the far edge — but at 0.6 it has run out of overhang, and the exposed strip is
      real. A size-only check would call this covered.
    */
    expect(coversCanvas(filled({ width: 2, height: 2, offsetX: 0.6 }))).toBe(false);
    expect(coversCanvas(filled({ width: 2, height: 2, offsetX: 0.4 }))).toBe(true);
  });
});

describe('the floor under a covering picture\'s scale (SPEC 10 §8.5)', () => {
  it('allows no shrink for a picture that exactly covers', () => {
    // Already at 1: any reduction stops covering, so the factor is 1 and the scale is
    // pinned where it is.
    expect(minCoverFactor(filled())).toBe(1);
    expect(coverScaleFloor({ x: 1, y: 1 }, { x: 0.5, y: 0.5 }, filled())).toEqual({ x: 1, y: 1 });
  });

  it('lets a 2× picture shrink to half before it stops covering', () => {
    // Its extent falls from 2 to 1, which is exactly the cover threshold.
    expect(minCoverFactor(filled({ width: 2, height: 2 }))).toBe(0.5);
    expect(coverScaleFloor({ x: 1, y: 1 }, { x: 0.4, y: 0.4 }, filled({ width: 2, height: 2 }))).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it('takes the stricter of the two axes', () => {
    /*
      A 4×1.5 picture: width allows down to 0.25, height only to 0.667. Taking the looser
      one would let the height fall out of cover while the width was still fine — a gap
      along the top or bottom, which is the axis the user is *not* watching.
    */
    expect(minCoverFactor(filled({ width: 4, height: 1.5 }))).toBeCloseTo(2 / 3, 10);
  });

  it('leaves an enlarged picture alone', () => {
    expect(coverScaleFloor({ x: 1, y: 1 }, { x: 2, y: 2 }, filled())).toEqual({ x: 2, y: 2 });
  });

  it('does not interfere when the picture never covered', () => {
    // A 0.5-wide picture: the lock has no floor to impose, so the scale is untouched.
    // `0` is the "no opinion" answer — not `1`, which would be a floor that forbids
    // every reduction and would break shrinking an overlay.
    expect(minCoverFactor(filled({ width: 0.5, height: 0.5 }))).toBe(0);
    const next = { x: 0.2, y: 0.2 };
    expect(coverScaleFloor({ x: 1, y: 1 }, next, filled({ width: 0.5, height: 0.5 }))).toBe(next);
  });

  it('ignores an axis that was already out of cover while flooring the other', () => {
    // 3 wide (covers), 0.8 tall (does not): the width still decides, alone.
    expect(minCoverFactor(filled({ width: 3, height: 0.8 }))).toBeCloseTo(1 / 3, 10);
  });
});

describe('which clip the fill lock governs (SPEC 10 §8.5)', () => {
  const tracks = [
    { id: 'main', role: 'main' },
    { id: 'overlay', role: 'overlay' },
  ];

  it('is the main video', () => {
    expect(isMainVideo({ type: 'video', trackId: 'main' }, { tracks })).toBe(true);
  });

  it('is not a video on another track', () => {
    /*
      A video can legitimately sit on an overlay track — a picture-in-picture insert, a
      cutaway. Clamping one to the frame would forbid the placement it exists for.
    */
    expect(isMainVideo({ type: 'video', trackId: 'overlay' }, { tracks })).toBe(false);
  });

  it('is not a non-video on the main track', () => {
    // A full-frame graphic on the main track is still a graphic, and the lock is about
    // footage: a caption has to be placeable.
    for (const type of ['image', 'text', 'caption', 'shape', 'audio']) {
      expect(isMainVideo({ type, trackId: 'main' }, { tracks })).toBe(false);
    }
  });

  it('is false rather than throwing when the track is gone', () => {
    // Mid-migration or after a track delete, the item may outlive its track reference by
    // a render. A convenience whose absence is the old behaviour must not crash a drag.
    expect(isMainVideo({ type: 'video', trackId: 'missing' }, { tracks })).toBe(false);
    expect(isMainVideo({ type: 'video', trackId: 'main' }, {})).toBe(false);
    expect(isMainVideo({ type: 'video' }, { tracks })).toBe(false);
  });
});

describe('the picture\'s drawn size in canvas fractions (SPEC 10 §8.5)', () => {
  const portrait = 1080 / 1920; // the default 9:16 canvas
  const wide = 1920 / 1080;

  it('fills a 9:16 canvas with a 9:16 source', () => {
    const extent = drawnExtent({
      source: { width: 1, height: 1 },
      scaleX: 1,
      scaleY: 1,
      sourceAspect: portrait,
      canvasAspect: portrait,
    });
    expect(extent.width).toBe(1);
    expect(extent.height).toBeCloseTo(1, 10);
  });

  it('letterboxes a 16:9 source in a 9:16 canvas', () => {
    /*
      The case that decides whether the lock is a help or an obstruction: this clip cannot
      cover at scale 1, so nothing may be clamped. Height is sourceAspect/canvasAspect
      inverted — 0.316 of the canvas — and `coverLimit` then returns null for it.
    */
    const extent = drawnExtent({
      source: { width: 1, height: 1 },
      scaleX: 1,
      scaleY: 1,
      sourceAspect: wide,
      canvasAspect: portraiture(),
    });
    expect(extent.height).toBeCloseTo(portraiture() / wide, 10);
    expect(coverLimit(extent.height)).toBeNull();
  });

  it('treats a sideways crop as a punch-in, not a narrower picture', () => {
    /*
      Cropping half the width makes the *picture* twice as large: the box still spans the
      canvas width and the inner video is magnified to fill it. Multiplying `source.width`
      into the extent would have said 0.5 and declared the clip no longer covering — the
      opposite of what happened.
    */
    const extent = drawnExtent({
      source: { width: 0.5, height: 1 },
      scaleX: 1,
      scaleY: 1,
      sourceAspect: portrait,
      canvasAspect: portrait,
    });
    expect(extent.width).toBe(1);
    expect(extent.height).toBeCloseTo(2, 10);
  });

  it('scales each axis by its own factor', () => {
    const extent = drawnExtent({
      source: { width: 1, height: 1 },
      scaleX: 2,
      scaleY: 3,
      sourceAspect: portrait,
      canvasAspect: portrait,
    });
    expect(extent.width).toBe(2);
    expect(extent.height).toBeCloseTo(3, 10);
  });

  it('falls back to the unscaled height before the frame has loaded', () => {
    // No aspect yet: the honest guess is that the source matches the canvas, which is
    // also what the preview itself assumes for that first frame.
    const extent = drawnExtent({
      source: { width: 1, height: 1 },
      scaleX: 1,
      scaleY: 1,
      sourceAspect: Number.NaN,
      canvasAspect: portraiture(),
    });
    expect(extent.height).toBe(1);
  });
});

function portraiture(): number {
  return 1080 / 1920;
}
