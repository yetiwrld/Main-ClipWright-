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
import { effectiveScale } from '@clipwright/compositor';
import type { Keyframe } from '@clipwright/project-schema/schemas';

/** A property the inspector exposes a diamond for, and how it maps onto the model. */
export interface AnimatableProperty {
  /** Path used in `item.keyframes`, matching the compositor's `PropertyPath`. */
  path: string;
  /**
   * Accessible name the row's diamond and jumpers use.
   *
   * Both scale axes share the single "Scale" field when the clip is uniform, so that
   * one diamond governs the pair; when the axes differ the inspector splits the row
   * and each axis gets its own "Scale X" / "Scale Y" diamond. Both spellings
   * therefore exist in the interface, which is why this list names "Scale" rather
   * than claiming only one of the two axis rows.
   */
  label: string;
}

/**
 * Every property the inspector draws a keyframe diamond for.
 *
 * This list is the contract, and a test walks it against the rendered inspector —
 * an entry here with no row behind it fails, and so does a row that offers a diamond
 * for a path the renderer never evaluates. Both directions matter: the first would
 * promise a control that is not there, the second would let a user animate something
 * and see nothing move.
 *
 * `label` is the row's visible label, which is not always unique on its own — the
 * crop rows read "Left"/"Top"/… under a "Crop" heading — so `accessibleName` carries
 * the longer form used in the buttons' accessible names.
 */
export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  { path: 'opacity', label: 'Opacity' },
  { path: 'volumeDb', label: 'Volume' },
  { path: 'transform.scaleX', label: 'Scale' },
  { path: 'transform.scaleY', label: 'Scale' },
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

/**
 * The scale the renderer will actually apply, for display and for keying.
 *
 * The inspector used to read `transform.scaleX` directly, which disagrees with the
 * picture whenever a project carries the legacy `transform.scale` field: the
 * compositor honours that field while *both* axes sit at their default of 1, so a
 * clip stored as `{ scale: 1.5, scaleX: 1, scaleY: 1 }` renders at 150% while the
 * sidebar says 100%. Worse for §2.4 — a diamond on that row would record 1 and
 * create a key that silently resizes the clip the instant it is made.
 *
 * Delegated to the compositor rather than reimplemented here, so the number the
 * user sees cannot drift from the number the renderer uses.
 */
export function displayedScale(transform: { scaleX?: number; scaleY?: number; scale?: number }): number {
  // A clip scaled on one axis only is not representable by a single number. The
  // caller checks `isUniformScale` first and shows both axes when it is false.
  return effectiveScale(transform).x;
}

/** Whether both axes agree, so a single Scale field can represent the clip. */
export function isUniformScale(transform: { scaleX?: number; scaleY?: number; scale?: number }): boolean {
  const scale = effectiveScale(transform);
  return scale.x === scale.y;
}

/**
 * Plan an edit that moves several properties together, as the single Scale field does.
 *
 * Two axes that are shown as one control have to be *keyed* as one control too. The
 * static write sets `scaleX` and `scaleY` at once, so keying only one of them would
 * leave the other pinned while the keyed one animates — the picture would stretch,
 * which is precisely what the single field exists to prevent.
 *
 * If either axis is already animated, both are keyed: keeping them apart would give
 * the animation a shape the user never drew for the axis they cannot see.
 */
export function planPairedEdit(
  existingKeys: ReadonlyArray<readonly Keyframe[] | undefined>,
  item: { startUs: number; durationUs: number } | undefined,
  playheadUs: number,
  value: number,
): PropertyEditPlan {
  const anyAnimated = existingKeys.some((keys) => (keys?.length ?? 0) > 0);
  if (!anyAnimated) return { kind: 'static' };
  if (keyframeWriteRefusal(item, playheadUs) !== null) return { kind: 'static' };
  const local = playheadUs - (item?.startUs ?? 0);
  const alreadyKeyed = existingKeys.some((keys) => keyframeAt(keys, local) !== undefined);
  return alreadyKeyed
    ? { kind: 'update-key', timeUs: local, value }
    : { kind: 'insert-key', timeUs: local, value };
}
