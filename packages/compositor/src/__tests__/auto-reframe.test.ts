import { describe, expect, it } from 'vitest';
import {
  cameraAims,
  cameraKeyframes,
  capKeyframes,
  simplifyPath,
  splitAtCuts,
  type SubjectSample,
} from '../auto-reframe.js';

/**
 * SPEC 13 §6.3 — the virtual camera.
 *
 * Every test here is a spec clause or a failure mode, not a restatement of the code. The
 * failures this guards against are the ones auto-reframe actually has in the wild: a camera
 * that chases a head's micro-movement, that snaps to centre and back whenever a face turns
 * away, that whips across the frame on a bad detection, that eases across a cut, and that
 * writes a keyframe per sample.
 */

const sample = (atMs: number, x: number, y: number): SubjectSample => ({ atUs: atMs * 1000, x, y });

describe('turning samples into a camera aim (SPEC 13 §6.3 step 1)', () => {
  it('aims at the subject when it is already centred', () => {
    // The baseline: no correction needed, so the aim is where the subject is.
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(200, 0.5, 0.5)]);
    expect(aims.every((aim) => aim.x === 0.5 && aim.y === 0.5)).toBe(true);
  });

  it('moves towards a subject that is off to one side', () => {
    /*
      A subject at 0.8 must pull the camera towards 0.8. This is the whole point of the
      feature, and the sign is easy to invert: aiming *away* from the subject crops it out,
      which is worse than doing nothing.
    */
    const aims = cameraAims([sample(0, 0.8, 0.5), sample(4000, 0.8, 0.5)], { deadZone: 0 });
    expect(aims[aims.length - 1]!.x).toBeGreaterThan(0.5);
  });

  it('lags a moving subject rather than snapping to it', () => {
    /*
      The camera must not be at the subject's current position one frame after it arrives:
      that is what makes the output look like a slideshow rather than a camera. Asserted as
      "strictly between where it started and where the subject is", which is the property
      the smoothing exists to produce and which neither a snap nor a frozen camera satisfies.
    */
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(200, 0.9, 0.5)], {
      deadZone: 0,
      maxPanPerSecond: 10,
    });
    expect(aims[1]!.x).toBeGreaterThan(0.5);
    expect(aims[1]!.x).toBeLessThan(0.9);
  });
});

describe('the dead-zone (SPEC 13 §6.3 step 2)', () => {
  it('does not move for a subject inside the central band', () => {
    /*
      "the camera doesn't move while the subject stays within the central 20% of the crop".
      A talking head moves by a fraction of a percent per frame; a camera that follows it
      looks handheld.
    */
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(200, 0.55, 0.5), sample(400, 0.52, 0.5)], {
      deadZone: 0.2,
    });
    expect(aims.every((aim) => aim.x === 0.5)).toBe(true);
  });

  it('does move once the subject leaves the band', () => {
    // The other direction: a dead-zone that never releases is a frozen camera.
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(400, 0.95, 0.5)], {
      deadZone: 0.2,
      maxPanPerSecond: 10,
    });
    expect(aims[1]!.x).toBeGreaterThan(0.5);
  });
});

describe('the pan limit (SPEC 13 §6.3 step 2)', () => {
  it('caps how far the aim may travel in one interval', () => {
    /*
      "max 25% of crop width per second". A detection that jumps across the frame — a wrong
      face, a cut to a different subject — must become a fast pan, not a teleport. At 400 ms
      and 25%/s the aim may move 0.1 of the canvas width, so a jump from 0.5 to 0.95 cannot
      arrive in one step no matter how the filter is tuned.
    */
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(400, 0.95, 0.5)], {
      deadZone: 0,
      maxPanPerSecond: 0.25,
      smoothness: 0,
    });
    expect(aims[1]!.x - 0.5).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('scales the cap with the elapsed time', () => {
    /*
      Twice the interval may travel twice as far. A limit expressed per *sample* rather
      than per second would make the camera twice as fast on a 10 fps analysis pass as on a
      5 fps one — the sort of setting-dependent bug that never reproduces on the developer's
      machine.
    */
    const short = cameraAims([sample(0, 0.5, 0.5), sample(400, 0.95, 0.5)], {
      deadZone: 0,
      maxPanPerSecond: 0.25,
      smoothness: 0,
    });
    const long = cameraAims([sample(0, 0.5, 0.5), sample(800, 0.95, 0.5)], {
      deadZone: 0,
      maxPanPerSecond: 0.25,
      smoothness: 0,
    });
    expect(long[1]!.x - 0.5).toBeGreaterThan(short[1]!.x - 0.5);
  });
});

describe('gaps in the detection (SPEC 13 §6.4)', () => {
  it('holds its aim when a frame has no subject', () => {
    /*
      The single most obvious way auto-reframe looks broken: a face turns away for three
      frames, the camera leaps to the canvas centre, then leaps back. §6.4's answer is to
      keep the last aim, not to guess.
    */
    const aims = cameraAims([
      sample(0, 0.7, 0.5),
      { atUs: 200_000, x: Number.NaN, y: Number.NaN },
      { atUs: 400_000, x: Number.NaN, y: Number.NaN },
    ]);
    expect(aims[1]!.x).toBeCloseTo(aims[0]!.x, 10);
    expect(aims[2]!.x).toBeCloseTo(aims[0]!.x, 10);
  });

  it('marks a held frame as untracked, so the panel can say so', () => {
    /*
      §6.4: shots with no subject are marked "No subject found — using manual framing".
      That marker cannot be inferred from equal numbers, because a genuinely still subject
      also produces equal numbers.
    */
    const aims = cameraAims([
      sample(0, 0.5, 0.5),
      { atUs: 200_000, x: Number.NaN, y: Number.NaN },
    ]);
    expect(aims[0]!.tracked).toBe(true);
    expect(aims[1]!.tracked).toBe(false);
  });

  it('resumes tracking when the subject comes back', () => {
    // A shorter version of the same failure: the camera must not stay frozen forever.
    const aims = cameraAims(
      [
        sample(0, 0.5, 0.5),
        { atUs: 200_000, x: Number.NaN, y: Number.NaN },
        sample(2000, 0.9, 0.5),
      ],
      { deadZone: 0, maxPanPerSecond: 10 },
    );
    expect(aims[2]!.tracked).toBe(true);
    expect(aims[2]!.x).toBeGreaterThan(0.5);
  });
});

describe('headroom (SPEC 13 §6.3 step 3)', () => {
  it('moves the camera less for the same subject offset when tighter', () => {
    /*
      Headroom above 100% tightens the crop, so the same subject movement is a *larger*
      share of a smaller frame — which is why the budget divides by headroom rather than
      multiplying. A camera that ignored this would swing too far on a zoomed-in crop and
      put the subject off the edge.
    */
    const options = { deadZone: 0, maxPanPerSecond: 10, smoothness: 0 };
    const loose = cameraAims([sample(0, 0.5, 0.5), sample(400, 0.9, 0.5)], { ...options, headroom: 1 });
    const tight = cameraAims([sample(0, 0.5, 0.5), sample(400, 0.9, 0.5)], { ...options, headroom: 1.3 });
    // Both start at the first sample scaled by their own budget, so compare the *travel*.
    const looseTravel = loose[1]!.x - loose[0]!.x;
    const tightTravel = tight[1]!.x - tight[0]!.x;
    expect(tightTravel).toBeLessThan(looseTravel);
  });
});

describe('cutting a shot (SPEC 13 §6.3 step 2)', () => {
  it('splits samples at a cut', () => {
    // A cut is a new location; easing across it is a transition nobody asked for.
    const shots = splitAtCuts([sample(0, 0.2, 0.5), sample(1000, 0.2, 0.5), sample(2000, 0.8, 0.5)], [1500_000]);
    expect(shots).toHaveLength(2);
    expect(shots[0]).toHaveLength(2);
    expect(shots[1]).toHaveLength(1);
  });

  it('returns one shot when there are no cuts', () => {
    expect(splitAtCuts([sample(0, 0.5, 0.5), sample(1000, 0.5, 0.5)], [])).toHaveLength(1);
  });

  it('resets the camera at each cut rather than easing across', () => {
    /*
      The end-to-end statement of the reset: aiming the two shots separately puts the second
      shot's first aim on its own subject, while aiming them together would leave it part-way
      between the two rooms.
    */
    const samples = [sample(0, 0.2, 0.5), sample(1000, 0.2, 0.5), sample(1100, 0.8, 0.5)];
    const together = cameraAims(samples, { deadZone: 0, maxPanPerSecond: 0.05 });
    const split = splitAtCuts(samples, [1050_000]).flatMap((shot) =>
      cameraAims(shot, { deadZone: 0, maxPanPerSecond: 0.05 }),
    );
    // Joined, the pan limit holds the camera near 0.2; split, the second shot starts at 0.8.
    expect(together[2]!.x).toBeLessThan(0.5);
    expect(split[2]!.x).toBeGreaterThan(0.7);
  });

  it('drops nothing when the samples are out of order', () => {
    // Detection results arrive per batch and need not be sorted; sorting inside keeps the
    // split honest instead of trusting the caller.
    const shots = splitAtCuts([sample(2000, 0.8, 0.5), sample(0, 0.2, 0.5)], [1500_000]);
    expect(shots.flat()).toHaveLength(2);
    expect(shots[0]![0]!.atUs).toBe(0);
  });
});

describe('reducing the path to keyframes (SPEC 13 §6.3 step 4)', () => {
  it('keeps the endpoints of a straight path', () => {
    // A line needs two points; dropping either end makes the clip jump at its first frame.
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(1000, 0.6, 0.5), sample(2000, 0.7, 0.5)]);
    const keys = simplifyPath(aims);
    expect(keys[0]!.atUs).toBe(0);
    expect(keys[keys.length - 1]!.atUs).toBe(2000_000);
  });

  it('drops a point that lies on the line between its neighbours', () => {
    /*
      The whole point of the reduction: three collinear samples need two keys, not three.
      A no-op simplifier passes every other test in this block, so this is the one that
      makes the reduction real.
    */
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(1000, 0.6, 0.5), sample(2000, 0.7, 0.5)]);
    expect(simplifyPath(aims)).toHaveLength(2);
  });

  it('keeps a point that turns the path', () => {
    // A corner is where the camera changes direction, and thinning it changes the shot.
    const aims = cameraAims([sample(0, 0.5, 0.5), sample(1000, 0.5, 0.5), sample(2000, 0.5, 0.5)]);
    // Flat path: two keys are enough.
    expect(simplifyPath(aims)).toHaveLength(2);
    // Now a V, which must keep its apex.
    const vee = [
      { atUs: 0, x: 0.5, y: 0.5, tracked: true },
      { atUs: 1_000_000, x: 0.8, y: 0.5, tracked: true },
      { atUs: 2_000_000, x: 0.5, y: 0.5, tracked: true },
    ];
    expect(simplifyPath(vee)).toHaveLength(3);
  });

  it('considers both axes together', () => {
    /*
      A point that is on the line in x but off it in y must be kept. Simplifying the axes
      separately would drop it and the camera would cut the corner of a diagonal pan.
    */
    const aims = [
      { atUs: 0, x: 0, y: 0, tracked: true },
      { atUs: 1_000_000, x: 0.5, y: 0.8, tracked: true },
      { atUs: 2_000_000, x: 1, y: 0, tracked: true },
    ];
    expect(simplifyPath(aims)).toHaveLength(3);
  });
});

describe('capping the keyframe count (SPEC 13 §6.3 step 4)', () => {
  const keys = Array.from({ length: 100 }, (_, index) => ({
    atUs: index * 100_000,
    x: index / 100,
    y: 0.5,
  }));

  it('leaves a path under the cap alone', () => {
    /*
      Spread over a realistic span rather than taken as the first five of the dense fixture.
      Five keys packed into 0.4 s is 12.5/s — genuinely over §6.3's 8/s — so a fixture that
      sliced the front off `keys` was asserting that the cap does *not* apply, and the cap
      was right to disagree. A test whose data is illegal produces a failure about the
      fixture, not about the code, which is why it is worth rewriting rather than loosening
      the assertion.
    */
    const few = [0, 1, 2, 3, 4].map((index) => ({
      atUs: index * 1_000_000,
      x: index / 10,
      y: 0.5,
    }));
    expect(capKeyframes(few, { maxPerSecond: 8, maxTotal: 400 })).toHaveLength(5);
  });

  it('thins a dense path to the per-second cap', () => {
    /*
      100 keys over 9.9 seconds is ~10/s, above the spec's 8/s. The result must come in at
      or under the cap *and* keep both ends.
    */
    const capped = capKeyframes(keys, { maxPerSecond: 8, maxTotal: 400 });
    expect(capped.length).toBeLessThanOrEqual(80);
    expect(capped[0]!.atUs).toBe(0);
    expect(capped[capped.length - 1]!.atUs).toBe(keys[keys.length - 1]!.atUs);
  });

  it('respects the absolute cap on a very long clip', () => {
    // §6.3's "≤ 400 per clip": a 10-minute clip at 8/s would otherwise ask for 4800 keys.
    const long = Array.from({ length: 5000 }, (_, index) => ({
      atUs: index * 100_000,
      x: 0.5,
      y: 0.5,
    }));
    expect(capKeyframes(long, { maxPerSecond: 8, maxTotal: 400 })).toHaveLength(400);
  });

  it('keeps the timeline order it was given', () => {
    // Thinning must not shuffle: keyframe paths are evaluated by time.
    const capped = capKeyframes(keys, { maxPerSecond: 4, maxTotal: 400 });
    for (let index = 1; index < capped.length; index += 1) {
      expect(capped[index]!.atUs).toBeGreaterThan(capped[index - 1]!.atUs);
    }
  });
});

describe('the whole camera', () => {
  it('produces keyframes from a panning subject', () => {
    // The integration answer: a subject crossing the frame becomes a handful of keys that
    // start where it did and end where it went.
    const samples = Array.from({ length: 30 }, (_, index) => sample(index * 200, 0.2 + index * 0.02, 0.5));
    const keys = cameraKeyframes(samples, { deadZone: 0 });
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.length).toBeLessThan(samples.length);
    expect(keys[0]!.x).toBeLessThan(keys[keys.length - 1]!.x);
  });

  it('returns nothing for no samples rather than a NaN keyframe', () => {
    // The panel asks before an analysis has run; a key at NaN would blank the layer.
    expect(cameraKeyframes([])).toEqual([]);
  });

  it('is deterministic for the same input', () => {
    // A background job that produced a different edit on a re-run would make "apply again"
    // meaningless.
    const samples = Array.from({ length: 20 }, (_, index) => sample(index * 200, 0.3 + (index % 5) * 0.05, 0.5));
    expect(cameraKeyframes(samples)).toEqual(cameraKeyframes(samples));
  });
});
