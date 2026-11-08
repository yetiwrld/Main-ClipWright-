/**
 * The anchor point (SPEC 10 §4, §8.2).
 *
 * The spec gives the transform order exactly: `translate(position) · rotate · scale ·
 * translate(−anchor)`. Read right to left, that means a point is moved to the anchor
 * frame, scaled, rotated, then placed — so an off-centre anchor makes the picture
 * *swing around that point* rather than turn about its middle.
 *
 * Both renderers already translate then rotate about the picture's centre, so the
 * anchor is expressed by folding `R · S · (centre − anchor)` into the offset. That
 * keeps one definition of the maths and means neither renderer's transform
 * structure changes — which matters because they are separate implementations
 * (CSS on screen, an ffmpeg filter chain in the file) and the only thing keeping
 * them agreeing is that both read these resolved numbers.
 */
import { describe, expect, it } from 'vitest';
import { itemGeometry } from '../item-geometry.js';

/** Geometry with only the fields a test cares about, filled from the defaults. */
const geometryWith = (transform: Record<string, unknown>) =>
  itemGeometry({ transform } as never);

describe('the anchor is a no-op at the centre', () => {
  it('leaves the offset alone whatever the rotation', () => {
    /*
      The default anchor is the picture's centre, so every project made before this
      existed must render exactly as it did. A regression here would move every clip
      in every saved project, which is the worst possible outcome for a change to
      shared geometry.
    */
    for (const rotation of [0, 17, 90, 180, -45, 359]) {
      const geometry = geometryWith({ rotation });
      expect(geometry.offsetX, `rotation ${rotation}`).toBeCloseTo(0, 10);
      expect(geometry.offsetY, `rotation ${rotation}`).toBeCloseTo(0, 10);
    }
  });

  it('leaves a positioned clip exactly where it was', () => {
    // Position and anchor are independent: moving the clip must not disturb where
    // the anchor maths puts it.
    const geometry = geometryWith({ x: 0.2, y: -0.1, rotation: 37 });
    expect(geometry.offsetX).toBeCloseTo(0.2, 10);
    expect(geometry.offsetY).toBeCloseTo(-0.1, 10);
  });

  it('treats a missing anchor as the centre', () => {
    // Projects saved before the anchor existed have no `anchorX`/`anchorY` at all.
    expect(geometryWith({ rotation: 90 }).offsetX).toBeCloseTo(0, 10);
    expect(geometryWith({ anchorX: 0.5, anchorY: 0.5, rotation: 90 }).offsetX).toBeCloseTo(0, 10);
  });
});

describe('an off-centre anchor swings the picture around itself', () => {
  it('puts the picture below its anchor when the anchor is the top-left corner', () => {
    /*
      Unrotated, the picture's centre is half a picture away from a corner anchor, so
      an anchor at (0,0) moves the offset by (+0.5,+0.5) in canvas fractions. This is
      the case a user sees the instant they pick a corner anchor: the picture jumps
      so that its corner sits where its middle was.
    */
    const geometry = geometryWith({ anchorX: 0, anchorY: 0, rotation: 0 });
    expect(geometry.offsetX).toBeCloseTo(0.5, 10);
    expect(geometry.offsetY).toBeCloseTo(0.5, 10);
  });

  it('swings a corner-anchored picture through a quarter turn', () => {
    // Rotating 90° clockwise carries the vector from the anchor to the centre
    // from (+0.5,+0.5) to (−0.5,+0.5): the picture is now to the left of the anchor.
    const geometry = geometryWith({ anchorX: 0, anchorY: 0, rotation: 90 });
    expect(geometry.offsetX).toBeCloseTo(-0.5, 10);
    expect(geometry.offsetY).toBeCloseTo(0.5, 10);
  });

  it('lands the picture opposite its starting side after a half turn', () => {
    const geometry = geometryWith({ anchorX: 0, anchorY: 0, rotation: 180 });
    expect(geometry.offsetX).toBeCloseTo(-0.5, 10);
    expect(geometry.offsetY).toBeCloseTo(-0.5, 10);
  });

  it('mirrors the swing for an opposite corner', () => {
    // The bottom-right anchor is the negation of the top-left one: the vector to the
    // centre points the other way, so a quarter turn sends it the other way too.
    const geometry = geometryWith({ anchorX: 1, anchorY: 1, rotation: 90 });
    expect(geometry.offsetX).toBeCloseTo(0.5, 10);
    expect(geometry.offsetY).toBeCloseTo(-0.5, 10);
  });
});

describe('scale applies before rotation, as the spec orders it', () => {
  it('doubles the anchor arm when the picture is scaled by two', () => {
    /*
      `translate · rotate · scale · translate(−anchor)` — scale is applied to the
      translated point, so a 2× picture has twice the distance between its anchor and
      its centre. Rotating and *then* scaling would leave the arm at 0.5, which is
      the bug this ordering check exists to catch.
    */
    const geometry = geometryWith({ anchorX: 0, anchorY: 0, scaleX: 2, scaleY: 2 });
    expect(geometry.offsetX).toBeCloseTo(1, 10);
    expect(geometry.offsetY).toBeCloseTo(1, 10);
  });

  it('scales each axis independently', () => {
    // A non-uniform scale stretches the arm per axis rather than by an average.
    const geometry = geometryWith({ anchorX: 0, anchorY: 0, scaleX: 2, scaleY: 0.5 });
    expect(geometry.offsetX).toBeCloseTo(1, 10);
    expect(geometry.offsetY).toBeCloseTo(0.25, 10);
  });

  it('rotates the scaled arm rather than scaling the rotated one', () => {
    // Scale 2x2 then rotate 90°: (1,1) becomes (−1,1). Scaling after the rotation
    // would give (−1,1) only by coincidence at 90°, so the 37° case is the real
    // discriminator and is checked against its closed form.
    const geometry = geometryWith({ anchorX: 0, anchorY: 0, scaleX: 2, scaleY: 2, rotation: 90 });
    expect(geometry.offsetX).toBeCloseTo(-1, 10);
    expect(geometry.offsetY).toBeCloseTo(1, 10);

    /*
      Closed form at 37°: the 2× arm from a corner anchor is (1,1) in canvas
      fractions, so `R·(1,1)` is `(cos − sin, sin + cos)`. Computed here rather than
      eyeballed — this expectation was wrong once already.
    */
    const angle = (37 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotated = geometryWith({ anchorX: 0, anchorY: 0, scaleX: 2, scaleY: 2, rotation: 37 });
    expect(rotated.offsetX).toBeCloseTo(cos - sin, 10);
    expect(rotated.offsetY).toBeCloseTo(sin + cos, 10);
  });
});

describe('the anchor is keyframeable (SPEC 12 §2.1)', () => {
  it('reads an animated anchor at the requested instant', () => {
    /*
      `transform.anchorX`/`anchorY` are in the spec's `PropertyPath` union, and moving
      an anchor over time is the standard way to make a picture swing through an arc.
      Reading only the static anchor would freeze that at the first frame.
    */
    const geometry = itemGeometry({
      transform: { anchorX: 0, anchorY: 0 },
      keyframes: {
        'transform.anchorX': [
          { timeUs: 0, value: 0.5, interpolation: 'linear' },
          { timeUs: 1_000_000, value: 0, interpolation: 'linear' },
        ],
      },
      timeUs: 0,
    } as never);
    // At t=0 the animated anchor is the centre, so no swing.
    expect(geometry.offsetX).toBeCloseTo(0, 10);

    const later = itemGeometry({
      transform: { anchorX: 0, anchorY: 0 },
      keyframes: {
        'transform.anchorX': [
          { timeUs: 0, value: 0.5, interpolation: 'linear' },
          { timeUs: 1_000_000, value: 0, interpolation: 'linear' },
        ],
      },
      timeUs: 1_000_000,
    } as never);
    expect(later.offsetX).toBeCloseTo(0.5, 10);
  });
});

describe('the identity flag accounts for the anchor', () => {
  it('is not identity when the anchor merely moves the picture', () => {
    /*
      `identity` lets a caller skip the whole wrapper. An anchor at a corner with no
      other transform is *not* the identity — the picture has moved half a frame — so
      reporting it as one would draw it in the wrong place.
    */
    expect(geometryWith({ anchorX: 0, anchorY: 0 }).identity).toBe(false);
  });

  it('is still identity for a centred anchor with no other transform', () => {
    expect(geometryWith({ anchorX: 0.5, anchorY: 0.5 }).identity).toBe(true);
    expect(geometryWith({}).identity).toBe(true);
  });
});
