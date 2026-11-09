/**
 * Reframing: dragging the picture under a fixed canvas rectangle (SPEC 10 §8.6).
 *
 * §8.6 asks for a **"Set framing…"** button that "lets the user drag the video under a fixed
 * canvas rectangle to set the framing keyframe for this moment (the manual precursor of
 * auto-reframe, `13`)". That wording is the whole design, and it is the *opposite* of the Crop
 * tool's: cropping moves a window over a still picture, while reframing moves the picture under
 * a still window. The window is the canvas, which the user cannot move, so the only thing a
 * drag can change is where the picture sits inside it — plus, with the modifiers every editor
 * gives this gesture, how big it is.
 *
 * The reason it is worth a mode of its own rather than another crop handle: what a user means
 * by "reframe" is *"this is the part of the shot I want"*, and that is a statement about the
 * canvas the finished video will be, not about a rectangle inside the picture. It also follows
 * from auto-reframe's output (`13` §...): that writes position and scale, not crop, so the
 * manual gesture has to produce the same shape of edit or the two cannot be compared, replaced
 * or keyframed together.
 *
 * Everything here is pure; the dragging itself lives in `CropFrame.tsx`'s sibling below it.
 */

import type { ExistingFraming } from './reframe-types.js';

/** The narrowest and widest a reframe may scale the picture, per `InitialFramingSchema`. */
export const REFRAME_MIN_SCALE = 0.1;
export const REFRAME_MAX_SCALE = 10;

/**
 * What the picture covers at a given scale, as a fraction of the canvas.
 *
 * The picture is drawn at `object-fit: fill` inside a box whose `aspectRatio` is
 * `source.width / source.height` and which is `width: 100%` of the canvas, so an unscaled
 * picture is as wide as the canvas and as tall as its own aspect makes it. That is *fit*, not
 * *fill* — a 16:9 picture in a 9:16 canvas is a short band across the middle — and it is what
 * the preview already does, so the numbers here are what the user sees rather than an ideal.
 */
export function reframeCoverage(
  scale: number,
  sourceAspect: number,
  canvasAspect: number,
): { width: number; height: number } {
  if (!Number.isFinite(scale) || scale <= 0) return { width: 0, height: 0 };
  if (!Number.isFinite(sourceAspect) || sourceAspect <= 0) return { width: 0, height: 0 };
  if (!Number.isFinite(canvasAspect) || canvasAspect <= 0) return { width: 0, height: 0 };
  // Width is the canvas's, by construction; height follows from the two ratios.
  return { width: scale, height: (scale * canvasAspect) / sourceAspect };
}

/**
 * The framing after a drag: the picture moves under the window.
 *
 * A drag of `by` (in canvas fractions) moves the *picture*, so its offset moves with the drag
 * rather than against it — push the picture right and it goes right. That is the sign that
 * makes the gesture read as "grab the shot and slide it", and it is the opposite of the sign a
 * crop-window drag would have.
 *
 * The picture is kept covering the canvas where it can be: a framing that slides the picture
 * off the window would show empty canvas, and §13's acceptance criteria say "no empty canvas
 * exposed". So each axis is clamped to the range that still covers, when the picture is large
 * enough to cover at all. Where it is *not* large enough — an unscaled 16:9 picture in a 9:16
 * canvas cannot cover vertically however it is moved — the axis is centred instead of being
 * clamped to a range that does not exist.
 */
export function reframedOffset(
  start: { x: number; y: number },
  by: { x: number; y: number },
  coverage: { width: number; height: number },
): { x: number; y: number } {
  const axis = (value: number, delta: number, size: number) => {
    if (!Number.isFinite(value)) return 0;
    const moved = value + (Number.isFinite(delta) ? delta : 0);
    /*
      Half the *overhang* is the furthest the centre can go: a picture of size `s` covers from
      `centre − s/2` to `centre + s/2`, so it still reaches the canvas's edge while
      `|centre| <= (s − 1) / 2`. A picture no bigger than the canvas has no overhang, and the
      only honest position is centred — which is what `max(0, …)` on the limit gives.
    */
    const limit = Math.max(0, (size - 1) / 2);
    return Math.min(limit, Math.max(-limit, moved));
  };
  return {
    x: axis(start.x, by.x, coverage.width),
    y: axis(start.y, by.y, coverage.height),
  };
}

/**
 * The framing after a *pinch* — the scale a wheel or a two-finger drag asks for.
 *
 * Scaling about the window's centre, which is the only pivot a fixed rectangle has. The offset
 * is re-clamped at the new size, because a framing that was legal at a smaller scale can sit
 * outside the coverage at a larger one — and letting it stay there would expose canvas.
 */
export function reframedScale(
  start: { x: number; y: number; scale: number },
  factor: number,
  sourceAspect: number,
  canvasAspect: number,
): { x: number; y: number; scale: number } {
  const nextScale = Math.min(
    REFRAME_MAX_SCALE,
    Math.max(REFRAME_MIN_SCALE, (Number.isFinite(start.scale) ? start.scale : 1) * factor),
  );
  const coverage = reframeCoverage(nextScale, sourceAspect, canvasAspect);
  const clamped = reframedOffset({ x: start.x, y: start.y }, { x: 0, y: 0 }, coverage);
  return { ...clamped, scale: nextScale };
}

/**
 * A framing rounded to something a person would actually write down.
 *
 * The gesture produces long decimals — `0.07333333333333333` — and storing those makes the
 * inspector unreadable, a keyframe comparison depend on floating-point noise, and two
 * identical framings from slightly different drags look like an edit. Six decimals is a
 * fraction of a canvas pixel at any resolution that matters.
 */
export function roundFraming(framing: { x: number; y: number; scale: number }): {
  x: number;
  y: number;
  scale: number;
} {
  /*
    `+ 0` folds `-0` into `+0`. The two are equal under `===` but not under `Object.is` or
    `toStrictEqual`, so a value that rounds to a negative zero compares unequal to itself the
    moment it is stored and read back — which is exactly the trap the pan clamp hit.
  */
  const round = (value: number) =>
    Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 + 0 : 0;
  return { x: round(framing.x), y: round(framing.y), scale: round(framing.scale) };
}

/**
 * Whether a reframe is a no-op against the framing already stored at this instant.
 *
 * `Enter` on a gesture that ended where it started must not push an undo step, for the same
 * reason the crop session's `cropChanged` refuses one: an empty undo entry makes the next
 * `Ctrl+Z` look broken.
 */
export function framingChanged(
  before: ExistingFraming,
  after: ExistingFraming,
  tolerance = 1e-6,
): boolean {
  const near = (a: number | undefined, b: number | undefined) =>
    Math.abs((a ?? 0) - (b ?? 0)) < tolerance;
  return !near(before.x, after.x) || !near(before.y, after.y) || !near(before.scale, after.scale);
}

/**
 * The keyframe paths a reframe writes.
 *
 * Position and scale *both*, in one set, because a framing is one point: writing the position
 * at this instant while leaving the scale to interpolate from a neighbouring key would produce
 * a framing the user never set. The function exists so the list is stated once — four paths
 * written by hand in three places is how one of them gets forgotten.
 *
 * The uniform `transform.scale` is deliberately not written: the per-axis pair wins the moment
 * either is off 1 (`effectiveScale`), so writing both spellings would leave two sources of
 * truth for one number.
 */
export function framingPaths(): readonly string[] {
  return ['transform.x', 'transform.y', 'transform.scaleX', 'transform.scaleY'];
}

/**
 * The reframe's four keyframe values, in the order `framingPaths` returns them.
 *
 * Kept beside the paths rather than in the component, so a test can assert the pairing: a
 * reframe that wrote x to `scaleX` would be a spectacular bug and a purely visual one.
 */
export function framingValues(framing: {
  x: number;
  y: number;
  scale: number;
}): readonly number[] {
  return [framing.x, framing.y, framing.scale, framing.scale];
}
