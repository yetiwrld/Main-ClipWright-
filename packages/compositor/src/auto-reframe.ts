/**
 * SPEC 13 §6.3 — the virtual camera that turns a subject's track into keyframes.
 *
 * Auto-reframe has two halves. The first is *detection*: sampling a proxy at 5 fps and
 * running a face or saliency model on each frame. That half needs `onnxruntime-node` and a
 * permissively licensed model shipped in the installer, and §6.4 explicitly allows a build
 * without it — "fall back to §6.4 and state it". The second half is this file: given where
 * the subject was in each sampled frame, decide where the camera looks, how it moves, and
 * what to write as keyframes. That half is pure arithmetic and is where every complaint
 * about auto-reframe actually comes from — a camera that jitters, that chases a face into
 * the edge of the frame, that spends a keyframe every frame, or that flips sides at a cut.
 *
 * Writing it as a separate, tested module is what makes the detection half swappable: a
 * future ONNX pass supplies sample points and gets the same camera out of it, and the
 * fallback path (§6.4's "static centre with the user's `initialFraming`") is the same code
 * with one sample instead of a hundred.
 *
 * Everything here is in **canvas fractions** — the same units `transform.x/y` and `scale`
 * are stored in — so nothing has to know the pixel size of either the source or the frame.
 */

/** One observation of the subject, at one instant. */
export interface SubjectSample {
  /** When the frame was sampled, relative to the start of the shot. */
  atUs: number;
  /**
   * The subject's centre, as fractions of the canvas width and height.
   *
   * `source`-relative would have been the other obvious choice and is the wrong one: the
   * camera is being aimed at a canvas, and the target is where the subject should land in
   * that canvas. Converting here would put the two sides of the conversion in different
   * files, and the one that was wrong would be whichever was not being looked at.
   *
   * Absent when no subject was found in that frame (§6.4) — the camera holds its last aim
   * rather than jumping to the centre and back.
   */
  x: number;
  y: number;
}

export interface CameraOptions {
  /**
   * How hard the camera resists changing direction. `low | medium | high`, §6.3's slider.
   *
   * A number rather than an enum so the smoothing maths has one input; the panel maps the
   * three named positions onto it. Higher is smoother and lags further behind a fast move.
   */
  smoothness?: number;
  /**
   * How far the subject may wander before the camera follows, as a fraction of the crop.
   *
   * §6.3's dead-zone: "the camera doesn't move while the subject stays within the central
   * 20% of the crop". Without it the camera tracks every micro-movement of a head and the
   * result looks like a handheld camera on a boat.
   */
  deadZone?: number;
  /**
   * The fastest the camera may pan, as a fraction of the crop width per second.
   *
   * §6.3 says 25%. This is what stops a camera whipping across the frame when a detection
   * jumps — the subject goes out of frame briefly and comes back, which reads as a
   * deliberate pan rather than as a glitch.
   */
  maxPanPerSecond?: number;
  /** Headroom above 100%: the crop is made this much tighter than cover (§6.3 step 3). */
  headroom?: number;
}

const DEFAULTS = {
  smoothness: 0.5,
  deadZone: 0.2,
  maxPanPerSecond: 0.25,
  headroom: 1,
} as const;

/** A resolved camera aim, in the same canvas fractions as the samples. */
export interface CameraAim {
  atUs: number;
  x: number;
  y: number;
  /** Whether this aim came from an actual detection or is the camera holding position. */
  tracked: boolean;
}

/**
 * The camera's aim at each sample.
 *
 * Three passes, in the order §6.3 gives them:
 *
 * 1. **Convert each detection to where the camera should look.** That is the subject's
 *    centre, offset for headroom — a portrait crop puts the eyes at ~38% from the top, so
 *    the camera looks *above* the subject's centre and the subject sits low in frame.
 * 2. **Hold through gaps.** A frame with no detection does not move the camera; it repeats
 *    the last aim. Jumping to the canvas centre and back is the single most obvious way
 *    auto-reframe looks broken, and it happens whenever a face turns away for a moment.
 * 3. **Smooth and clamp.** A one-pole filter resists direction changes, the dead-zone skips
 *    small corrections, and the pan limit caps how fast the aim may travel.
 *
 * The order matters and is not arbitrary: smoothing *before* the dead-zone would let a
 * correction that the zone then refuses leak into the following samples, so the camera would
 * creep towards a position it had decided not to take.
 */
export function cameraAims(
  samples: readonly SubjectSample[],
  options: CameraOptions = {},
): CameraAim[] {
  if (samples.length === 0) return [];
  const smoothness = clamp01(options.smoothness ?? DEFAULTS.smoothness);
  const deadZone = Math.max(0, options.deadZone ?? DEFAULTS.deadZone);
  const maxPan = Math.max(0, options.maxPanPerSecond ?? DEFAULTS.maxPanPerSecond);
  const headroom = Math.max(1, options.headroom ?? DEFAULTS.headroom);
  /*
    Headroom above 1 tightens the crop, which means the *visible* region is smaller than
    cover. The camera target moves correspondingly less far from centre for the same
    subject offset — a budget of `1/headroom` of the canvas. Written as a division rather
    than a multiplication so headroom 1 is exactly the untransformed case.
  */
  const budget = 1 / headroom;
  const ordering = [...samples].sort((a, b) => a.atUs - b.atUs);

  const aims: CameraAim[] = [];
  let aimX = 0.5;
  let aimY = 0.5;
  /*
    Whether the camera has been *placed* yet.

    The first tracked sample of a shot places the camera on the subject with no easing,
    because that is what "cuts reset instantly" means (§6.3 step 2): there is no previous
    position inside this shot to travel from, and easing in from the canvas centre would
    make every cut begin with a drift towards the subject — a transition nobody asked for,
    and one the user cannot remove because it is in the analysis output.

    The flag has to be set on the way through. An earlier version tested the state that
    "is this a gap" had left behind, which is false for every ordinary sample — so *every*
    frame placed the camera directly on the subject and the smoothing never ran at all.
    The camera looked like it was tracking a face by teleporting to it once per frame.
  */
  let placed = false;
  let lastUs = ordering[0]!.atUs;

  for (const sample of ordering) {
    const found = Number.isFinite(sample.x) && Number.isFinite(sample.y);
    /*
      A gap repeats the previous aim. `tracked` stays false for this sample and the one
      after, so the caller can tell a held frame from a detected one — the review panel
      marks those shots "No subject found — using manual framing" (§6.4), and that
      distinction has to survive into the data rather than being inferred from equal
      numbers, which a genuinely still subject also produces.
    */
    if (!found) {
      aims.push({ atUs: sample.atUs, x: aimX, y: aimY, tracked: false });
      lastUs = sample.atUs;
      continue;
    }

    const targetX = sample.x * budget;
    const targetY = sample.y * budget;

    if (!placed) {
      /*
        Placement: the shot's opening aim. This is the cut reset, and it is also the only
        sample that skips the filter — everything after it has a previous position to
        travel from and is smoothed, dead-zoned and pan-limited like any other move.
      */
      aimX = targetX;
      aimY = targetY;
      placed = true;
      lastUs = sample.atUs;
      aims.push({ atUs: sample.atUs, x: aimX, y: aimY, tracked: true });
      continue;
    }
    const deltaUs = Math.max(0, sample.atUs - lastUs);
    lastUs = sample.atUs;

    /*
      The dead-zone, per axis and applied to the *difference* rather than to the target.
      A subject inside the central band produces no correction at all, so a person who is
      simply talking does not make the camera drift.
    */
    const correctionX = Math.abs(targetX - aimX) <= deadZone ? 0 : targetX - aimX;
    const correctionY = Math.abs(targetY - aimY) <= deadZone ? 0 : targetY - aimY;

    /*
      One-pole smoothing. `alpha` rises with both smoothness and elapsed time: the same
      slider position has to mean the same *feel* at 5 fps and at 10 fps, so the filter is
      expressed as a time constant rather than a per-sample fraction. A per-sample constant
      that forgot the interval would make the "High" setting behave differently on a fast
      machine than on a slow one, which is the class of bug nobody reproduces.
    */
    const timeConstantUs = 400_000 * (0.25 + smoothness * 2.75);
    const alpha = 1 - Math.exp(-deltaUs / timeConstantUs);

    let nextX = aimX + correctionX * alpha;
    let nextY = aimY + correctionY * alpha;

    /*
      Pan limit, applied to the result of the filter rather than to the correction.
      Capping the correction leaves a fast move still able to arrive early whenever the
      filter happens to be near its target; capping the *distance travelled* per interval
      is the actual statement §6.3 makes ("max 25% of crop width per second").
    */
    const limit = (maxPan * Math.max(deltaUs, 1)) / 1_000_000;
    if (limit > 0) {
      nextX = aimX + clamp(nextX - aimX, -limit, limit);
      nextY = aimY + clamp(nextY - aimY, -limit, limit);
    }

    aimX = nextX;
    aimY = nextY;
    aims.push({ atUs: sample.atUs, x: aimX, y: aimY, tracked: true });
  }

  return aims;
}

/**
 * A shot boundary: the camera resets here rather than easing across it (§6.3 step 2).
 *
 * Kept as a separate concept because it is the one place the smoothing must not apply: a
 * cut is a new location, and easing from one room to another over half a second is a
 * transition nobody asked for. Splitting before aiming is what makes the reset exact.
 */
export function splitAtCuts<T extends { atUs: number }>(
  samples: readonly T[],
  cutsUs: readonly number[],
): T[][] {
  if (cutsUs.length === 0) return samples.length > 0 ? [[...samples]] : [];
  const cuts = [...cutsUs].sort((a, b) => a - b);
  const shots: T[][] = [];
  let current: T[] = [];
  let cutIndex = 0;
  for (const sample of [...samples].sort((a, b) => a.atUs - b.atUs)) {
    while (cutIndex < cuts.length && sample.atUs >= cuts[cutIndex]!) {
      if (current.length > 0) shots.push(current);
      current = [];
      cutIndex += 1;
    }
    current.push(sample);
  }
  if (current.length > 0) shots.push(current);
  return shots;
}

/** A keyframe the camera produces: a time and the two offsets to write. */
export interface CameraKey {
  atUs: number;
  x: number;
  y: number;
}

/**
 * Reduce a path to a manageable number of keyframes (§6.3 step 4).
 *
 * Ramer–Douglas–Peucker on `(atUs, x)` and `(atUs, y)` considered together: a point is kept
 * when it is further than `tolerance` from the line between the points either side of it, on
 * *either* axis. Simplifying the axes separately would double the keyframe count and put the
 * two out of step, so the path would lean during a pan.
 *
 * The output always contains the first and last samples: dropping an endpoint would make the
 * clip jump to a different framing at its very first and last frames.
 */
export function simplifyPath(aims: readonly CameraAim[], tolerance = 0.0015): CameraKey[] {
  if (aims.length === 0) return [];
  if (aims.length <= 2) return aims.map(toKey);
  const keep = new Uint8Array(aims.length);
  keep[0] = 1;
  keep[aims.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, aims.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let worst = -1;
    let worstDistance = 0;
    for (let index = first + 1; index < last; index += 1) {
      const distance = segmentDistance(aims[first]!, aims[last]!, aims[index]!);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }
    if (worst !== -1 && worstDistance > tolerance) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return aims.filter((_, index) => keep[index] === 1).map(toKey);
}

/**
 * Cap the keyframe density, so a long clip cannot bury the timeline in points (§6.3's
 * "cap 8 per second, merged to ≤ 400 per clip").
 *
 * Thinning rather than re-simplifying: the cap is about how many keys a user can
 * *see and edit*, and re-running RDP with a looser tolerance would change the path rather
 * than sample it less often. Endpoints are preserved for the reason `simplifyPath` keeps
 * them.
 */
export function capKeyframes(
  keys: readonly CameraKey[],
  options: { maxPerSecond?: number; maxTotal?: number } = {},
): CameraKey[] {
  const maxPerSecond = options.maxPerSecond ?? 8;
  const maxTotal = options.maxTotal ?? 400;
  if (keys.length === 0) return [];
  const spanUs = Math.max(1, keys[keys.length - 1]!.atUs - keys[0]!.atUs);
  const allowedByRate = Math.max(2, Math.ceil((spanUs / 1_000_000) * maxPerSecond));
  const allowed = Math.min(maxTotal, allowedByRate);
  if (keys.length <= allowed) return [...keys];

  /*
    Even spacing by index, always including both ends. Picking the *nearest* key to each
    even slot would bias towards whichever side of a tie `Math.round` fell on, and on a
    repeating path that bias is visible as the camera favouring one direction.
  */
  /*
    No dedupe guard, and that is a proof rather than an omission: with `allowed <=
    keys.length` the step `(keys.length - 1) / (allowed - 1)` is at least 1, and
    `Math.round` is monotone with a difference of at least 1 across a step that large — so
    consecutive slots always land on different indices. An earlier version carried a guard
    against collisions that cannot occur; a mutation test that removed it changed nothing,
    which is how the dead branch was found.
  */
  const picked: CameraKey[] = [];
  for (let slot = 0; slot < allowed; slot += 1) {
    picked.push(keys[Math.round((slot * (keys.length - 1)) / (allowed - 1))]!);
  }
  return picked;
}

/** The whole camera: samples to keyframes, in one call. */
export function cameraKeyframes(
  samples: readonly SubjectSample[],
  options: CameraOptions & { maxPerSecond?: number; maxTotal?: number; tolerance?: number } = {},
): CameraKey[] {
  const aims = cameraAims(samples, options);
  return capKeyframes(simplifyPath(aims, options.tolerance ?? 0.0015), {
    ...(options.maxPerSecond === undefined ? {} : { maxPerSecond: options.maxPerSecond }),
    ...(options.maxTotal === undefined ? {} : { maxTotal: options.maxTotal }),
  });
}

function toKey(aim: CameraAim): CameraKey {
  return { atUs: aim.atUs, x: aim.x, y: aim.y };
}

/** Perpendicular distance from `point` to the segment `first`–`last`, on both axes. */
function segmentDistance(first: CameraAim, last: CameraAim, point: CameraAim): number {
  const spanUs = last.atUs - first.atUs;
  if (spanUs === 0) {
    return Math.hypot(point.x - first.x, point.y - first.y);
  }
  /*
    Normalise time to 0–1 so the two axes are comparable: time is in microseconds and the
    offsets in canvas fractions, and a distance mixing the two units would let the tolerance
    mean something different for a long clip than a short one.
  */
  const t = (point.atUs - first.atUs) / spanUs;
  const expectedX = first.x + (last.x - first.x) * t;
  const expectedY = first.y + (last.y - first.y) * t;
  return Math.hypot(point.x - expectedX, point.y - expectedY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : DEFAULTS.smoothness, 0, 1);
}
