/**
 * SPEC 12 §3.1 — adjustment layers.
 *
 * An adjustment layer is an item with no picture of its own whose effect chain
 * grades everything *below* it on the visible tracks, for as long as it is on the
 * timeline. It is how a user drops one exposure correction over three clips instead
 * of grading each one by hand and keeping them in step afterwards.
 *
 * The schema has carried an `adjustment` item type and the effect-chain support since
 * the inspector work; nothing resolved one. This module answers the two questions a
 * renderer has to ask: which adjustment layers are live at this instant, and which
 * of them applies to a given layer.
 *
 * "Below" is decided by track order exactly as layering is: a higher `order` is
 * nearer the viewer, so an adjustment layer only grades layers with a *lower* order.
 * An adjustment layer on the same track as a clip would be ambiguous — tracks hold
 * one kind of content — so it is treated as not applying rather than guessing.
 */

import { activeEffects, type ActiveEffect } from './effects.js';

/** The parts of an item an adjustment layer needs to be resolved. */
export interface AdjustmentItem {
  id: string;
  type: string;
  startUs: number;
  durationUs: number;
  trackOrder: number;
  disabled?: boolean;
  hiddenTrack?: boolean;
  effects?: ReadonlyArray<{
    effectId: string;
    enabled?: boolean;
    params?: Record<string, number | boolean | string>;
  }>;
}

/** A live adjustment layer, with its chain already filtered and clamped. */
export interface AdjustmentLayer {
  id: string;
  trackOrder: number;
  effects: ActiveEffect[];
}

/**
 * The adjustment layers active at `timeUs`, bottom-most first.
 *
 * Ordering matters because their chains run in sequence: two stacked exposure layers
 * should compose in the same order they do on the timeline, and applying them in an
 * arbitrary order would make a +1 and a −1 not cancel.
 */
export function activeAdjustmentLayers(
  items: readonly AdjustmentItem[],
  timeUs: number,
): AdjustmentLayer[] {
  const layers: AdjustmentLayer[] = [];
  for (const item of items) {
    if (item.type !== 'adjustment') continue;
    if (item.disabled || item.hiddenTrack) continue;
    if (timeUs < item.startUs || timeUs >= item.startUs + item.durationUs) continue;
    const effects = activeEffects(item.effects);
    // An adjustment layer with an empty or fully disabled chain changes nothing;
    // dropping it keeps the export's "is there anything to do" checks meaningful.
    if (effects.length === 0) continue;
    layers.push({ id: item.id, trackOrder: item.trackOrder, effects });
  }
  return layers.sort((a, b) =>
    // Same tie-break as `visibleLayers`: a stable order so two identical runs
    // cannot differ.
    a.trackOrder !== b.trackOrder ? a.trackOrder - b.trackOrder : a.id.localeCompare(b.id),
  );
}

/**
 * The effects that apply to a layer at `layerTrackOrder`.
 *
 * Every live adjustment layer above the layer's track, in order. Returns an empty
 * array when nothing grades it, which is the common case and lets callers skip the
 * work entirely.
 */
export function effectsForLayer(
  layers: readonly AdjustmentLayer[],
  layerTrackOrder: number,
): ActiveEffect[] {
  const applicable: ActiveEffect[] = [];
  for (const layer of layers) {
    // Strictly above: an adjustment layer never grades its own track.
    if (layer.trackOrder <= layerTrackOrder) continue;
    applicable.push(...layer.effects);
  }
  return applicable;
}

/**
 * Whether an adjustment layer should be drawn as a layer in its own right.
 *
 * It never should — it has no picture — but the question is asked by renderers that
 * iterate items uniformly, and answering it here keeps the two renderers agreeing.
 */
export function isAdjustmentItem(item: { type: string }): boolean {
  return item.type === 'adjustment';
}
