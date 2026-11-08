/**
 * SPEC 10 §2/§6 — what a frame looks like when more than one item is on it.
 *
 * The preview drew exactly one item and the export wrote exactly one item, so a
 * clip on an overlay track was invisible above the main video in one and silently
 * won in the other. Both now go through `visibleLayers`, which answers three
 * questions the two paths were answering differently:
 *
 * - **which items contribute**, in the order they should be drawn;
 * - **at what opacity**, including the "opacity animates" case;
 * - **with what blend mode**, defaulting to normal.
 *
 * A layer at zero opacity is dropped rather than drawn, because the difference
 * matters: drawing it with alpha 0 is a no-op visually but it still occupies a
 * decoder and, for a `multiply` layer, it would darken the frame it is supposed to
 * be invisible over.
 */

import type { Keyframe, Transition } from '@clipwright/project-schema/schemas';
import { evaluateNumber } from './keyframes.js';
import { transitionWindow } from './transitions.js';

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'soft-light';

/** The parts of a timeline item that decide whether and how it is drawn. */
export interface LayerItem {
  id: string;
  startUs: number;
  durationUs: number;
  /** Order of the item's track; a higher `order` is drawn above. */
  trackOrder: number;
  opacity?: number;
  blendMode?: BlendMode;
  keyframes?: Record<string, readonly Keyframe[]>;
  /** Hidden or disabled items are not drawn at all. */
  disabled?: boolean;
  hiddenTrack?: boolean;
  /**
   * A transition entering this item (SPEC 12 §4). It matters here because a
   * transition widens the span the item is drawn over: a centred crossfade begins
   * before the item's own start, so an item that has not started yet can still be
   * on screen.
   */
  transitionIn?: Transition;
}

export interface VisibleLayer {
  id: string;
  /** 0–1 after keyframes are evaluated, including any transition fade. */
  opacity: number;
  blendMode: BlendMode;
  trackOrder: number;
  /**
   * How far through its incoming transition this layer is at the sampled time,
   * `0`–`1`, or `undefined` when no transition covers it.
   *
   * Reported rather than baked into `opacity` because the other transition types
   * are not fades: a slide moves the picture and a wipe needs an edge, and a caller
   * that only understood opacity would render those as a crossfade.
   */
  transitionProgress?: number;
}

/**
 * The items visible at `timeUs`, bottom layer first.
 *
 * Sorted by track order, then by start time: two items on one track that overlap
 * (a split that has not been re-sequenced) must draw in a defined order, and the
 * one that started later is the one on top — the same rule the caption overlay
 * uses to pick which caption to edit.
 */
export function visibleLayers(
  items: readonly LayerItem[],
  timeUs: number,
): VisibleLayer[] {
  const layers: VisibleLayer[] = [];
  for (const item of items) {
    if (item.disabled || item.hiddenTrack) continue;
    // The span the item is drawn over is its own range widened by an incoming
    // transition: a centred crossfade starts before `startUs`, and the frames
    // before the cut are still the *outgoing* clip's, so the incoming item cannot
    // simply be invisible there.
    const incoming = item.transitionIn
      ? transitionWindow(item.startUs, item.transitionIn)
      : undefined;
    const drawFrom = Math.min(item.startUs, incoming?.startUs ?? item.startUs);
    const drawTo = Math.max(item.startUs + item.durationUs, incoming?.endUs ?? 0);
    if (timeUs < drawFrom || timeUs >= drawTo) continue;

    // A transition only affects opacity for the fades; the others are applied by
    // the renderer using `transitionProgress`.
    const progress = progressThrough(incoming, timeUs, item.transitionIn);
    const fade = transitionOpacity(item.transitionIn, progress);

    const opacity = evaluateNumber(item.keyframes?.['opacity'], timeUs, item.opacity ?? 1);
    // Clamp rather than drop an out-of-range value: a keyframed opacity of 1.2 is
    // a file that asks for "fully opaque", not a reason to hide the clip.
    const clamped = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    const combined = clamped * fade;
    if (combined <= 0) continue;
    layers.push({
      id: item.id,
      opacity: combined,
      blendMode: item.blendMode ?? 'normal',
      trackOrder: item.trackOrder,
      ...(progress === null ? {} : { transitionProgress: progress }),
    });
  }
  return layers.sort((a, b) => {
    if (a.trackOrder !== b.trackOrder) return a.trackOrder - b.trackOrder;
    // Stable within a track so two decoders cannot swap places between frames.
    return a.id.localeCompare(b.id);
  });
}

/**
 * Whether a layer can be composited at all.
 *
 * A single fully opaque, normally-blended layer needs no blend pass — it *is* the
 * frame. Detecting that keeps the common case (one video on the main track) on the
 * cheap path it had before layering existed.
 */
export function needsCompositing(layers: readonly VisibleLayer[]): boolean {
  if (layers.length === 0) return false;
  if (layers.length > 1) return true;
  const only = layers[0]!;
  return only.opacity < 1 || only.blendMode !== 'normal';
}

/**
 * The ffmpeg `blend` filter's mode name for a Clipwright blend mode.
 *
 * ffmpeg's vocabulary is not ours: our `add` is ffmpeg's `addition`, and
 * `soft-light` is spelled with an underscore. A wrong name here is not a warning —
 * ffmpeg rejects the whole graph, so the export fails with a message about a filter
 * rather than anything the user can act on.
 */
export function ffmpegBlendMode(mode: BlendMode): string {
  switch (mode) {
    case 'add':
      return 'addition';
    case 'soft-light':
      return 'softlight';
    case 'normal':
      return 'normal';
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
  }
}

/**
 * The `blend` filter argument for a layer, as ffmpeg 4.1 actually supports it.
 *
 * Measured against the bundled binary, and each of these findings reversed a
 * simpler design:
 *
 * - `all_mode=<mode>` alone applies a blend mode but no opacity;
 * - `all_expr=<expr>` alone applies arbitrary per-pixel maths but **silently
 *   overrides `all_mode`** (a `multiply` graph and a `normal` graph produced
 *   byte-identical output when both also carried `all_expr`);
 * - the expression language has no `multiply()`/`addition()` functions — it errors
 *   with "Unknown function" — so a mode cannot be written as an expression either.
 *
 * The workable form is therefore two stages: blend the layer with `all_mode`, then
 * mix that result back toward the frame below with `all_expr`. `A` in the second
 * stage is the base frame and `B` the already-blended result — note that neither
 * stage uses a blend *function*, because 4.1 has none.
 *
 * At full opacity the second stage is skipped entirely, because `A*0 + B*1` is
 * `B` and costs a filter for nothing.
 */
export function layerBlendFilter(mode: BlendMode, opacity: number): string | null {
  const alpha = Math.min(1, Math.max(0, opacity));
  if (alpha <= 0) return null;
  const first = mode === 'normal' ? null : `blend=all_mode=${ffmpegBlendMode(mode)}`;
  if (alpha >= 1) return first;
  // `A` is the base frame and `B` the layer (or the blended result). Mixing toward
  // `B*alpha` instead of toward the blend would fade the layer to black rather than
  // to the picture underneath — the classic "fade to nothing" bug.
  const a = Number((1 - alpha).toFixed(6));
  const b = Number(alpha.toFixed(6));
  const mix = `blend=all_expr='A*${a}+B*${b}'`;
  return first ? `${first},${mix}` : mix;
}

/** How far through its incoming transition an item is, or `null` if none covers it. */
function progressThrough(
  window: { startUs: number; endUs: number; durationUs: number } | undefined,
  timeUs: number,
  transition: Transition | undefined,
): number | null {
  if (!window || !transition || window.durationUs <= 0) return null;
  if (timeUs < window.startUs || timeUs >= window.endUs) return null;
  return Math.min(1, Math.max(0, (timeUs - window.startUs) / window.durationUs));
}

/**
 * The opacity multiplier a transition imposes on the incoming item.
 *
 * Only the two shapes that keep one side dark contribute a pure fade; a crossfade
 * needs *both* clips and is resolved by the renderer, which knows about the
 * outgoing one. Returning 1 for those is deliberate: multiplying here as well would
 * apply the fade twice.
 */
function transitionOpacity(transition: Transition | undefined, progress: number | null): number {
  if (!transition || progress === null) return 1;
  if (transition.type === 'fade-black' || transition.type === 'dip-color') {
    return progress < 0.5 ? 0 : (progress - 0.5) * 2;
  }
  return 1;
}
