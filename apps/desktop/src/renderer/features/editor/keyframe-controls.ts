/**
 * Inspector-side keyframe editing (SPEC 12 §2.4).
 *
 * §2.4 asks for two related behaviours that both live on the *property row*:
 *
 * - a **diamond** per row that toggles a keyframe at the playhead, recording the
 *   property's current evaluated value, plus ◀ ▶ buttons that jump between that
 *   property's keys;
 * - **auto-keyframing** — when a property already has keys and the user changes it,
 *   a key is written or updated at the playhead. When it has none, the edit changes
 *   the static value and writes no animation, so a user cannot create animation by
 *   accident.
 *
 * The rules are expressed here as pure functions rather than inline in the component
 * because they are the part with edge cases worth testing: a playhead outside the
 * clip, a key that already exists at the playhead, and the difference between
 * "update the key that is already here" and "insert a new one".
 */
import type { Keyframe } from '@clipwright/project-schema/schemas';

/** A property the inspector exposes a diamond for, and how it maps onto the model. */
export interface AnimatableProperty {
  /** Path used in `item.keyframes`, matching the compositor's `PropertyPath`. */
  path: string;
  /** Label the row shows. */
  label: string;
}

/**
 * The properties the inspector can animate.
 *
 * Deliberately conservative: each entry here is a path the compositor or the audio
 * envelope actually reads. Exposing a diamond for a path nothing evaluates would
 * let a user animate something and see no change, which is the failure mode this
 * whole audit keeps finding.
 */
export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  { path: 'opacity', label: 'Opacity' },
  { path: 'volumeDb', label: 'Volume' },
  { path: 'transform.scaleX', label: 'Scale X' },
  { path: 'transform.scaleY', label: 'Scale Y' },
  { path: 'transform.x', label: 'Position X' },
  { path: 'transform.y', label: 'Position Y' },
  { path: 'transform.rotation', label: 'Rotation' },
  { path: 'crop.left', label: 'Crop left' },
  { path: 'crop.right', label: 'Crop right' },
  { path: 'crop.top', label: 'Crop top' },
  { path: 'crop.bottom', label: 'Crop bottom' },
];

/**
 * Whether a keyframe write is allowed at this playhead, and why not when it is not.
 *
 * §2.4: "If the playhead is outside the item, the edit is blocked with a tooltip."
 * The comparison is half-open at the end — `[start, start + duration)` — because the
 * item is not drawn on its last frame; a key exactly at the end would never be seen.
 */
export function keyframeWriteRefusal(
  item: { startUs: number; durationUs: number } | undefined,
  playheadUs: number,
): string | null {
  if (!item) return 'No clip is selected.';
  if (playheadUs < item.startUs) return 'The playhead is before this clip.';
  if (playheadUs >= item.startUs + item.durationUs) return 'The playhead is past the end of this clip.';
  return null;
}

/** The keyframe at `timeUs`, if the property already has one there. */
export function keyframeAt(
  keys: readonly Keyframe[] | undefined,
  timeUs: number,
): Keyframe | undefined {
  return (keys ?? []).find((key) => key.timeUs === timeUs);
}

/**
 * The time a ◀ or ▶ button should jump to, or `null` when there is no such key.
 *
 * Keys are compared as a sorted list whatever order they are stored in, since a
 * project edited by another tool need not be sorted and "next" has to mean next in
 * time rather than next in the array.
 */
export function adjacentKeyTime(
  keys: readonly Keyframe[] | undefined,
  playheadUs: number,
  direction: 'previous' | 'next',
): number | null {
  const times = (keys ?? [])
    .map((key) => key.timeUs)
    .slice()
    .sort((a, b) => a - b);
  if (direction === 'previous') {
    let best: number | null = null;
    for (const time of times) {
      if (time < playheadUs) best = time;
    }
    return best;
  }
  for (const time of times) {
    if (time > playheadUs) return time;
  }
  return null;
}

/**
 * What a property edit should do — write a keyframe, or change the static value.
 *
 * This is §2.4's auto-keyframing rule expressed as a decision rather than a side
 * effect: with existing keys the edit becomes a keyframe at the playhead (updating
 * the one already there if the playhead sits on it); with none it stays static, so
 * dragging a slider on a clip that has never been animated does not silently start
 * an animation the user did not ask for.
 */
export type PropertyEditPlan =
  | { kind: 'static' }
  | { kind: 'insert-key'; timeUs: number; value: number }
  | { kind: 'update-key'; timeUs: number; value: number };

export function planPropertyEdit(
  existingKeys: readonly Keyframe[] | undefined,
  item: { startUs: number; durationUs: number } | undefined,
  playheadUs: number,
  value: number,
): PropertyEditPlan {
  if (!existingKeys || existingKeys.length === 0) return { kind: 'static' };
  // Auto-keyframing still has to respect the clip boundary: a change made while the
  // playhead is elsewhere cannot be written to a key that would not be visible
  // there, so it falls back to the static value rather than inventing a key at a
  // clamped time the user did not pick.
  if (keyframeWriteRefusal(item, playheadUs) !== null) return { kind: 'static' };
  const local = playheadUs - (item?.startUs ?? 0);
  if (keyframeAt(existingKeys, local)) return { kind: 'update-key', timeUs: local, value };
  return { kind: 'insert-key', timeUs: local, value };
}
