/**
 * SPEC 12 §4 — transitions between two clips.
 *
 * A transition is stored on the *incoming* item (`transitionIn`) and describes how
 * that item enters: over what window, with which shape, and with which easing. The
 * timeline command layer has supported creating and editing them for a while;
 * nothing evaluated them, so a crossfade existed in the project file and did not
 * exist on screen or in the export.
 *
 * This module is the evaluation half: given a transition and a time, what fraction
 * of the way through is it, and what does each side of the cut look like right
 * now. Preview and export both read these numbers, so the two cannot drift.
 *
 * Deliberately pure and free of pixel work: the preview applies the result with CSS
 * and the export with the software compositor, and each needs different rendering
 * but identical timing.
 */

import type { Transition } from '@clipwright/project-schema/schemas';
import { cubicBezier } from './keyframes.js';
import { easingValue } from '@clipwright/audio-core';

/** Where a transition sits relative to the cut. */
export type TransitionAlignment = 'center' | 'start' | 'end';

/** The window a transition occupies on the timeline, in absolute microseconds. */
export interface TransitionWindow {
  startUs: number;
  endUs: number;
  durationUs: number;
}

/**
 * The span a transition covers, given the incoming item's start.
 *
 * `center` straddles the cut, `start` lies entirely before it (the outgoing clip is
 * still full-frame while the incoming one fades in over it) and `end` entirely
 * after. These are the three cases an editor actually offers, and they differ only
 * in which side of the cut the overlap sits — not in the maths.
 */
export function transitionWindow(
  startUs: number,
  transition: Pick<Transition, 'durationUs' | 'alignment'>,
): TransitionWindow {
  const durationUs = Math.max(0, transition.durationUs);
  switch (transition.alignment) {
    case 'start':
      return { startUs: startUs - durationUs, endUs: startUs, durationUs };
    case 'end':
      return { startUs, endUs: startUs + durationUs, durationUs };
    case 'center':
    default: {
      const half = Math.round(durationUs / 2);
      return { startUs: startUs - half, endUs: startUs - half + durationUs, durationUs };
    }
  }
}

/**
 * Progress through a transition at a given time, 0 → 1, eased.
 *
 * Returns `null` outside the window rather than clamping: "no transition is
 * happening here" and "the transition is exactly finished" are different states,
 * and a caller that conflated them would keep the outgoing clip painted forever.
 */
export function transitionProgress(
  window: TransitionWindow,
  timeUs: number,
  easing: Transition['easing'] | undefined,
): number | null {
  if (window.durationUs <= 0) return null;
  if (timeUs < window.startUs || timeUs >= window.endUs) return null;
  const raw = (timeUs - window.startUs) / window.durationUs;
  const clamped = Math.min(1, Math.max(0, raw));
  // The transition's own easing, not a keyframe's. `linear` is the identity, so an
  // unknown preset falls back to it rather than to something that stalls.
  const eased = easing && easing !== 'linear' ? easingValue(easing, clamped) : clamped;
  return Math.min(1, Math.max(0, eased));
}

/** What a transitioned frame needs from each side. */
export interface TransitionState {
  /** Opacity to paint the outgoing (underneath) side at, 0–1. */
  fromOpacity: number;
  /** Opacity to paint the incoming (on top) side at, 0–1. */
  toOpacity: number;
  /**
   * Horizontal slide, as a fraction of frame width, applied to each side.
   * Positive moves the incoming layer in from the right.
   */
  fromOffsetX: number;
  toOffsetX: number;
  /** Scale applied to each side, for `zoom`. */
  fromScale: number;
  toScale: number;
  /** Colour a `dip-color` transition passes through, when there is one. */
  dipColor?: string;
  /**
   * For `wipe`: the sweeping edge, and how soft it is.
   *
   * A wipe is the one transition that cannot be expressed as an opacity or an
   * offset — which pixels show which side depends on their position — so the shape
   * is described here and each renderer rasterises it. Reporting both sides as
   * fully opaque without this (which this function used to do) told the renderers
   * to draw the incoming clip *over* the outgoing one, which is a hard cut with
   * extra steps.
   */
  wipe?: WipeShape;
}

/** The moving edge of a wipe, in normalised frame coordinates (0–1). */
export interface WipeShape {
  /** Normal pointing at the region the wipe has not yet revealed. */
  axisX: number;
  axisY: number;
  /** How far the revealed region reaches along the normal, 0–1. */
  position: number;
  /** Width of the soft edge, as a fraction of the frame's extent along the normal. */
  softness: number;
  /**
   * The incoming side is revealed behind the edge as it advances; the outgoing
   * side keeps everything the incoming one has not covered.
   */
  reveal: 'incoming';
}

/**
 * The direction a wipe sweeps, as a unit normal and the scale that keeps the edge
 * equidistant across a non-square frame.
 *
 * The spec lists L/R/U/D and the diagonals. A diagonal on a 16:9 frame has to be
 * normalised by the frame's extent along that direction, or the edge would drift at
 * a different apparent speed in x and y and the reveal would finish early on one
 * axis.
 */
export function wipeDirection(
  direction: Transition['params'] extends { direction?: infer D } ? D : unknown,
): { x: number; y: number } {
  switch (direction) {
    case 'right':
      return { x: -1, y: 0 };
    case 'up':
      return { x: 0, y: 1 };
    case 'down':
      return { x: 0, y: -1 };
    case 'diagonal-up':
      return { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
    case 'diagonal-down':
      return { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
    case 'left':
    default:
      // `left` is the default: the edge sweeps left-to-right, revealing from the
      // left, which is what a user means by an unqualified "wipe".
      return { x: 1, y: 0 };
  }
}

/**
 * The alpha of the incoming side at a normalised position along the wipe's normal,
 * given the shape and the progress `p`.
 *
 * `t` is 0 at the edge's starting side and 1 at the far side. `softness` widens a
 * linear ramp centred on the edge; at 0 the edge is hard, which is the classic
 * wipe, and the ramp is symmetric so the transition is reversible.
 */
export function wipeAlphaAt(
  t: number,
  progress: number,
  softness: number,
): number {
  const p = Math.min(1, Math.max(0, progress));
  // The endpoints are exact. Without this a hard edge sits *on* t = 0 at p = 0,
  // which the `t <= edge` test counts as revealed — so the incoming clip appears
  // as a one-pixel seam along the leading edge for the whole first frame.
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const half = Math.max(0, softness) / 2;
  // The edge runs from just outside 0 to just outside 1, so the soft ramp has
  // somewhere to live at both ends instead of being clipped in half.
  const edge = -half + p * (1 + 2 * half);
  if (half <= 1e-6) return t <= edge ? 1 : 0;
  return Math.min(1, Math.max(0, (edge - t) / (2 * half) + 0.5));
}

/**
 * How each side of the cut should be drawn at progress `p` (0 = fully outgoing,
 * 1 = fully incoming).
 *
 * Every mode is expressed as opacity/offset/scale so that both renderers can apply
 * it without knowing which transition it came from. A `wipe` is the one shape that
 * cannot be reduced this way — it needs a per-pixel edge — so it is reported as a
 * wipe and each renderer implements the clip itself.
 */
export function transitionState(
  type: Transition['type'],
  p: number,
  params: Transition['params'] = {},
): TransitionState {
  const progress = Math.min(1, Math.max(0, p));
  const base: TransitionState = {
    fromOpacity: 1,
    toOpacity: 1,
    fromOffsetX: 0,
    toOffsetX: 0,
    fromScale: 1,
    toScale: 1,
  };

  switch (type) {
    case 'crossfade':
      // The common case: the two pictures are visible together for the whole
      // window, summing to 1 so the frame does not dip in the middle. That only
      // holds when the outgoing side is opaque; a `dissolve` is the same maths
      // applied to already-transparent material, which is why it is listed
      // separately rather than folded in.
      return { ...base, fromOpacity: 1 - progress, toOpacity: progress };

    case 'dissolve':
      // A dissolve ramps the incoming side against the *canvas*, not against the
      // outgoing picture: the outgoing clip is still drawn at full strength, so
      // grain or transparency in the incoming material reads through.
      return { ...base, fromOpacity: 1, toOpacity: progress };

    case 'fade-black': {
      // Down to black at the midpoint, then up again. Each half is a fade against
      // the canvas, so the two sides are never visible together and the frame
      // genuinely reaches black — a crossfade with a dark clip only looks like it.
      return progress < 0.5
        ? { ...base, fromOpacity: 1 - progress * 2, toOpacity: 0 }
        : { ...base, fromOpacity: 0, toOpacity: (progress - 0.5) * 2 };
    }

    case 'dip-color': {
      // The same two-phase shape as `fade-black`, passing through a chosen colour.
      // The colour is reported so the renderer can paint the canvas (or a solid
      // layer) rather than assume black.
      const color = typeof params.color === 'string' ? params.color : '#000000';
      return progress < 0.5
        ? { ...base, fromOpacity: 1 - progress * 2, toOpacity: 0, dipColor: color }
        : { ...base, fromOpacity: 0, toOpacity: (progress - 0.5) * 2, dipColor: color };
    }

    case 'wipe': {
      // Both sides stay fully opaque — neither fades — but the incoming side is
      // clipped by a moving edge, so the *shape* travels with the state. Without
      // it a renderer could only draw the incoming clip over the outgoing one,
      // which is a cut, not a wipe.
      const normal = wipeDirection(params.direction);
      return {
        ...base,
        fromOpacity: 1,
        toOpacity: 1,
        wipe: {
          axisX: normal.x,
          axisY: normal.y,
          position: progress,
          softness: typeof params.softness === 'number' ? Math.max(0, params.softness) : 0,
          reveal: 'incoming',
        },
      };
    }

    case 'slide': {
      // Both pictures move together as one strip. `direction` names the way the
      // frame travels: `left` means the outgoing clip exits to the left and the
      // incoming one enters from the right. Moving only the incoming clip would
      // show the canvas through the gap, which is a different effect.
      const travel = params.direction === 'right' ? 1 : -1;
      return {
        ...base,
        fromOffsetX: travel * progress,
        toOffsetX: -travel * (1 - progress),
      };
    }

    case 'zoom': {
      // The outgoing clip pushes towards the viewer while the incoming one settles
      // from slightly large, which reads as a through-cut rather than a dissolve.
      const amount = typeof params.amount === 'number' && params.amount > 0 ? params.amount : 0.25;
      return {
        ...base,
        fromOpacity: 1 - progress,
        toOpacity: progress,
        fromScale: 1 + amount * progress,
        toScale: 1 + amount * (1 - progress),
      };
    }
  }
}

/**
 * The eased progress of a transition, or `null` when there is none at this time.
 *
 * A one-call convenience for renderers: most callers have the item's start time and
 * the transition, not a pre-computed window.
 */
export function transitionAt(
  startUs: number,
  transition: Transition | undefined,
  timeUs: number,
): { progress: number; state: TransitionState } | null {
  if (!transition || transition.durationUs <= 0) return null;
  const window = transitionWindow(startUs, transition);
  const progress = transitionProgress(window, timeUs, transition.easing);
  if (progress === null) return null;
  return { progress, state: transitionState(transition.type, progress, transition.params) };
}

/** A cubic-bezier control point set for a named easing, for renderers that need one. */
export function transitionBezier(easing: Transition['easing']): [number, number, number, number] {
  // The same curves the keyframe evaluator uses, expressed as control points so a
  // CSS transition can be built from the same numbers rather than a second table.
  switch (easing) {
    case 'easeIn':
      return [0.42, 0, 1, 1];
    case 'easeOut':
      return [0, 0, 0.58, 1];
    case 'easeInOut':
      return [0.42, 0, 0.58, 1];
    case 'linear':
    default:
      return [0, 0, 1, 1];
  }
}

/** Evaluate a bezier easing at `x`; exported so renderers share one implementation. */
export function easeWithBezier(points: [number, number, number, number], x: number): number {
  return cubicBezier(points[0], points[1], points[2], points[3], x);
}
