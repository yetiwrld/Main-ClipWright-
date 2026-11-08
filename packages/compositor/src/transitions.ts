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
  /** Vertical slide, as a fraction of frame height. Positive moves a layer down. */
  fromOffsetY: number;
  toOffsetY: number;
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
  /**
   * For `dissolve`: a per-pixel threshold, `0`–`1`, and the seed its noise was
   * generated from.
   *
   * §4.2 defines a dissolve as a noise-thresholded mix rather than a fade: each
   * pixel switches from the outgoing picture to the incoming one when a fixed noise
   * field at that pixel falls below the progress. That makes the two pictures
   * interleave in patches — film-grain dissolve — instead of blending everywhere at
   * once. Reporting it as a shape keeps the renderers from guessing.
   */
  dissolve?: DissolveShape;
}

/** The noise field a `dissolve` thresholds (SPEC 12 §4.2). */
export interface DissolveShape {
  /** Seed of the deterministic noise. Fixed so two exports match frame for frame. */
  seed: number;
  /** Feature size of the noise, in fractions of the frame. Larger is coarser. */
  grain: number;
  /** Progress, 0–1. */
  progress: number;
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
    fromOffsetY: 0,
    toOffsetY: 0,
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

    case 'dissolve': {
      // §4.2: a noise-thresholded mix, not a fade. Both sides stay fully opaque
      // and each pixel belongs entirely to one of them, chosen by a fixed noise
      // field — which is what makes the cut read as grain rather than as a
      // transparency ramp. A plain fade here would be an unremarkable crossfade
      // wearing the dissolve's name.
      const grain = typeof params.grain === 'number' ? Math.max(0.001, params.grain) : 0.5;
      const seed = typeof params.seed === 'number' ? params.seed : DISSOLVE_SEED;
      return { ...base, dissolve: { seed, grain, progress } };
    }

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
      /*
        Both pictures move together as one strip; moving only the incoming clip
        would show the canvas through the gap, which is a different effect.

        `direction` names the way the *picture travels*, which is the opposite of
        saying which side the incoming clip arrives from: `left` means the outgoing
        clip exits to the left and the incoming one arrives from the right. That is
        the long-standing convention here and the preview and export both follow it,
        so the inspector's labels say "travel" rather than "comes from".

        (A wipe's `direction` uses the other reading — where the reveal starts —
        because a reveal has a starting edge rather than a motion. The two option
        lists are separate for that reason.)

        §4.2's `mode` decides *who stays still*, and that is the whole difference
        between the three: `push` moves both pictures as one strip, `cover` slides
        the incoming clip over a stationary outgoing one, and `reveal` slides the
        outgoing clip away to uncover a stationary incoming one. The still side
        reports a zero offset, which is all a renderer needs — it already treats an
        offset as "move this layer by this much", so nothing has to know the mode
        at draw time. An unset or unrecognised mode is `push`, because that is what
        an unqualified slide has always meant here and a project stored before
        `mode` existed must not change how it renders.
      */
      const direction = params.direction;
      const mode = params.mode === 'cover' || params.mode === 'reveal' ? params.mode : 'push';
      const vertical = direction === 'up' || direction === 'down';
      // `up`: the strip travels upward, so the outgoing clip exits through the top
      // and the incoming one enters from below.
      const travel = vertical ? (direction === 'up' ? -1 : 1) : direction === 'right' ? 1 : -1;
      const travelOffset = (amount: number) => (vertical ? { y: amount } : { x: amount });

      /*
        `cover` is an offset and nothing else: the incoming clip slides over an
        outgoing clip that does not move, and since the incoming layer is already
        painted on top, reporting a zero offset for the outgoing side is the whole
        implementation.
      */
      if (mode === 'cover') {
        const incoming = travelOffset(-travel * (1 - progress));
        return {
          ...base,
          toOffsetX: incoming.x ?? 0,
          toOffsetY: incoming.y ?? 0,
        };
      }

      /*
        `reveal` is the mirror image — the outgoing clip slides away and uncovers an
        incoming clip that does not move — but it cannot be expressed by offsets
        alone. The incoming layer is painted *on top*, so leaving it still would
        cover the outgoing clip instead of being uncovered by it, and the frame would
        show the incoming clip at every progress: a cut at p = 0.

        What actually reveals the incoming clip is the *hole* the outgoing one leaves
        behind, and that hole is a moving edge — the same shape a wipe reports. So
        the incoming side is clipped to the region the outgoing clip has vacated,
        which is a wipe whose edge travels with it. Nothing extra is needed from
        either renderer: they already know how to clip a layer to a wipe.
      */
      if (mode === 'reveal') {
        const outgoing = travelOffset(travel * progress);
        return {
          ...base,
          fromOffsetX: outgoing.x ?? 0,
          fromOffsetY: outgoing.y ?? 0,
          wipe: {
            /*
              The normal has to point at the region the outgoing clip has *vacated*,
              and that is the way the pictures travel. Check it against the geometry:
              a `left` slide moves the outgoing clip to `-p`, so at p = 0.5 it covers
              the left half and has cleared the right — and `axisX = -1` is the normal
              whose mask (`t <= edge` with `t` running from the far side) is 1 on the
              right. Using `-travel` here revealed the side the outgoing clip was
              still standing on, which is a wipe travelling the wrong way.
            */
            axisX: vertical ? 0 : travel,
            axisY: vertical ? travel : 0,
            position: progress,
            softness: 0,
            reveal: 'incoming',
          },
        };
      }

      // `push`, the default: both pictures move together as one strip.
      if (vertical) {
        return {
          ...base,
          fromOffsetY: travel * progress,
          toOffsetY: -travel * (1 - progress),
        };
      }
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

/**
 * The fixed seed a dissolve uses when the transition does not name one (§4.2:
 * "deterministic noise texture, fixed seed").
 *
 * Determinism is a requirement, not a nicety: two exports of the same project must
 * produce identical frames, and a noise field seeded from the clock would fail that
 * the moment the same dissolve was rendered twice.
 */
export const DISSOLVE_SEED = 0x5eed_1234;

/**
 * A deterministic value in `[0, 1)` for a pixel, given the dissolve's grain and seed.
 *
 * This is value noise: a hash of the coarse cell the pixel falls in, smoothly
 * interpolated between neighbouring cells so the patches have soft edges rather
 * than looking like a checkerboard. A hash of the exact pixel would give
 * salt-and-pepper noise, which reads as static and looks wrong at video scale.
 */
export function dissolveNoiseAt(
  x: number,
  y: number,
  width: number,
  height: number,
  shape: Pick<DissolveShape, 'seed' | 'grain'>,
): number {
  // Grain is in frame fractions; converting to cells keeps a dissolve looking the
  // same at any export resolution, which §12 item 6 requires of effects generally.
  const cellsX = Math.max(1, Math.round(1 / shape.grain));
  const cellsY = Math.max(1, Math.round((height / Math.max(1, width)) / shape.grain));
  const gx = (x / width) * cellsX;
  const gy = (y / height) * cellsY;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  // Smoothstep the interpolation so the patch edges fade instead of banding.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sample = (cx: number, cy: number) => hash2(cx, cy, shape.seed);
  const top = sample(x0, y0) * (1 - sx) + sample(x0 + 1, y0) * sx;
  const bottom = sample(x0, y0 + 1) * (1 - sx) + sample(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** A stable 32-bit hash of a cell, mapped into `[0, 1)`. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 0x27d4eb2d) ^ (y * 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 0x1_0000_0000;
}

/**
 * The noise value below which `progress` of the field lies.
 *
 * Thresholding the raw noise against the progress looks right and is not: the field
 * is bilinear interpolation of hashed cells, so its values cluster around the middle
 * and a quarter of the way through the transition only ~15 % of pixels had switched
 * — the dissolve stalls at the start and the end and rushes through the middle.
 * Mapping progress through the field's own quantiles makes the switched fraction
 * equal the progress, which is what a dissolve is supposed to do.
 *
 * The quantiles depend only on the seed, so they are computed once and cached.
 */
const thresholdCache = new Map<number, Float32Array>();

function dissolveThresholds(seed: number): Float32Array {
  const cached = thresholdCache.get(seed);
  if (cached) return cached;
  const samples: number[] = [];
  // Sampling one cell's worth of fractional positions covers the whole
  // distribution: every pixel's noise is a bilinear blend of four hashes at some
  // (fx, fy), and those are uniform inside a cell.
  const steps = 32;
  let h = seed;
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
  };
  for (let iy = 0; iy < steps; iy += 1) {
    for (let ix = 0; ix < steps; ix += 1) {
      const fx = (ix + 0.5) / steps;
      const fy = (iy + 0.5) / steps;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const top = next() * (1 - sx) + next() * sx;
      const bottom = next() * (1 - sx) + next() * sx;
      samples.push(top * (1 - sy) + bottom * sy);
    }
  }
  samples.sort((a, b) => a - b);
  const table = Float32Array.from(samples);
  thresholdCache.set(seed, table);
  return table;
}

/**
 * Which side a dissolve's pixel belongs to at the current progress.
 *
 * Returns the incoming clip's alpha: `1` once the pixel's noise value has fallen
 * below the threshold for this progress. There is deliberately no partial value — a
 * dissolve switches pixels, it does not fade them — so the frame never shows a blend
 * of the two.
 */
export function dissolveAlphaAt(
  x: number,
  y: number,
  width: number,
  height: number,
  shape: DissolveShape,
): number {
  if (shape.progress <= 0) return 0;
  if (shape.progress >= 1) return 1;
  const thresholds = dissolveThresholds(shape.seed);
  const index = Math.min(
    thresholds.length - 1,
    Math.max(0, Math.round(shape.progress * (thresholds.length - 1))),
  );
  return dissolveNoiseAt(x, y, width, height, shape) < thresholds[index]! ? 1 : 0;
}
