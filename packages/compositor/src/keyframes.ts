/**
 * SPEC 12 §2.1 — `evaluate()`, the one place a keyframed property gets its value.
 *
 * A keyframed property is an array of `(timeUs, value)` pairs on the item, and
 * every consumer — the preview, the export, the inspector's readout — has to agree
 * on what the value is at a given instant. Until this existed, nothing read
 * `item.keyframes` at all: the timeline drew little diamonds for them and no pixel
 * on screen moved. That is the worst kind of unfinished, because the UI looked like
 * it was working.
 *
 * Three rules the spec is specific about, and the reasons they are not arbitrary:
 *
 * - **Before the first key and after the last, the value is held.** Holding is what
 *   makes a two-key animation a transition between two states rather than an event
 *   that teleports the property back to its base value outside its own range.
 * - **`hold` does not interpolate.** A `hold` key means "stay at this value until
 *   the next key", which is how a step change (a cut to a different crop) is
 *   expressed without inventing a second property.
 * - **Easing belongs to the segment that starts at a key, not the one that ends
 *   there.** A key's `easing`/`bezier` describes the curve leaving it, so a change
 *   to how an animation *arrives* is made on the incoming key.
 *
 * `evaluate` returns `undefined` when the property has no keys, so callers can
 * fall back to the item's static value without special-casing an "animated" flag.
 */

import { easingValue } from '@clipwright/audio-core';
import type { Keyframe } from '@clipwright/project-schema/schemas';

/** A keyframe value: a scalar, or a four-component vector (crop insets, a colour). */
export type KeyframeValue = number | [number, number, number, number];

export type PropertyPath =
  | 'transform.x'
  | 'transform.y'
  | 'transform.scaleX'
  | 'transform.scaleY'
  | 'transform.rotation'
  | 'transform.anchorX'
  | 'transform.anchorY'
  | 'opacity'
  | 'volumeDb'
  | 'crop.left'
  | 'crop.top'
  | 'crop.right'
  | 'crop.bottom'
  /*
    The crop's corner radius (SPEC 10 §8.6). Keyable for the same reason as the edges: a
    rounded corner that appears partway through a clip is a mask reveal, and refusing it here
    would have meant the slider worked in the inspector but not on the timeline.
  */
  | 'crop.radius';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * A cubic-bezier easing curve evaluated as `y` at progress `x`.
 *
 * `Keyframe.bezier` stores control points, not a time→progress function, so the
 * curve has to be inverted: given x, find the parameter t whose x-component is x,
 * then read the y-component. Bisection is used rather than Newton because the
 * derivative is zero at the endpoints for some control points, where Newton fails
 * to converge — and a keyframe that fails to converge would stall a render.
 */
export function cubicBezier(
  outX: number,
  outY: number,
  inX: number,
  inY: number,
  x: number,
): number {
  const progress = clamp01(x);
  const curve = (t: number, p1: number, p2: number) => {
    const u = 1 - t;
    // P0 = 0, P3 = 1, so the constant terms drop out.
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
  };
  let low = 0;
  let high = 1;
  let t = progress;
  for (let step = 0; step < 24; step += 1) {
    const estimate = curve(t, outX, inX);
    if (Math.abs(estimate - progress) < 1e-6) break;
    if (estimate < progress) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return curve(t, outY, inY);
}

/** The eased progress across one segment, per the incoming key's settings. */
function segmentProgress(from: Keyframe, t: number): number {
  if (from.interpolation === 'hold') return 0;
  if (from.interpolation === 'bezier' && from.bezier) {
    const { outX, outY, inX, inY } = from.bezier;
    return cubicBezier(outX, outY, inX, inY, t);
  }
  if (from.easing) return clamp01(easingValue(from.easing.preset, t));
  // `preset` interpolation with no easing block is a file written by an older
  // build; treating it as linear is the only reading that does not stall.
  return t;
}

function lerp(from: KeyframeValue, to: KeyframeValue, t: number): KeyframeValue {
  if (typeof from === 'number' || typeof to === 'number') {
    const a = typeof from === 'number' ? from : from[0];
    const b = typeof to === 'number' ? to : to[0];
    return a + (b - a) * t;
  }
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
    from[3] + (to[3] - from[3]) * t,
  ];
}

/**
 * The value of a keyframed property at `timeUs`.
 *
 * Returns `undefined` only when there are no keys. The caller distinguishes "not
 * animated" from "animated to this value" — falling back to a static value when a
 * key exists would silently discard the animation.
 */
export function evaluate(keyframes: readonly Keyframe[] | undefined, timeUs: number): KeyframeValue | undefined {
  if (!keyframes || keyframes.length === 0) return undefined;
  // Sorted copy rather than trusting the caller: a key inserted by an undo of a
  // delete can arrive out of order, and an unsorted binary search reads a
  // plausible but wrong neighbouring key.
  const keys = [...keyframes].sort((a, b) => a.timeUs - b.timeUs);

  if (timeUs <= keys[0]!.timeUs) return keys[0]!.value as KeyframeValue;
  const last = keys[keys.length - 1]!;
  if (timeUs >= last.timeUs) return last.value as KeyframeValue;

  // The index of the *last* key at or before `timeUs`. Going through the last such
  // key rather than a segment loop is what makes duplicate timestamps unambiguous:
  // an exact hit on a duplicated instant returns the final key at that instant,
  // where a segment-driven search returns whichever duplicate its first matching
  // segment happened to end on.
  let low = 0;
  let high = keys.length - 1;
  let index = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (keys[middle]!.timeUs <= timeUs) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const from = keys[index]!;
  // An exact hit needs no interpolation, and is where duplicates resolve.
  if (from.timeUs === timeUs) return from.value as KeyframeValue;

  const to = keys[index + 1]!;
  // `from.timeUs < timeUs < to.timeUs` by construction, so the span is positive:
  // a zero span would divide to NaN and poison every transform downstream.
  const span = to.timeUs - from.timeUs;
  const t = (timeUs - from.timeUs) / span;
  return lerp(from.value as KeyframeValue, to.value as KeyframeValue, segmentProgress(from, t));
}

/** `evaluate` narrowed to a scalar, which is what most properties are. */
export function evaluateNumber(
  keyframes: readonly Keyframe[] | undefined,
  timeUs: number,
  fallback: number,
): number {
  const value = evaluate(keyframes, timeUs);
  if (value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  // A vector where a scalar belongs is a mis-authored file; the first component is
  // the least surprising reading and keeps the item visible.
  return Number.isFinite(value[0]) ? value[0] : fallback;
}

/**
 * The value at `timeUs` for a property path on an item, keyed the way the item
 * stores them (`item.keyframes['transform.x']`).
 */
export function evaluateProperty(
  keyframes: Record<string, readonly Keyframe[]> | undefined,
  path: PropertyPath,
  timeUs: number,
  fallback: number,
): number {
  return evaluateNumber(keyframes?.[path], timeUs, fallback);
}

/** The times where a property has a key, for the timeline's diamonds. */
export function keyframeTimes(keyframes: readonly Keyframe[] | undefined): number[] {
  if (!keyframes) return [];
  return [...new Set(keyframes.map((key) => key.timeUs))].sort((a, b) => a - b);
}
