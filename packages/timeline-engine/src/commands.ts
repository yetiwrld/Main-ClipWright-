// Commands: every edit is a pure function of (state, params) → new state or an
// error (SPEC 09 §2.3). Each command records immer patches so the caller can push
// one undo step per transaction (SPEC 09 §24).

import { current, enablePatches, produceWithPatches, type Patch } from 'immer';

// Undo relies on immer patches (SPEC 09 §24), so the plugin must be on before
// any command runs — including when the engine is imported by a test.
enablePatches();
import type { CompositionPayload, TimelineItem } from '@clipwright/project-schema';
import type { Keyframe } from '@clipwright/project-schema/schemas';
import { frameDurationUs, quantizeUs, type Fps } from './time';
import { itemEndUs, projectDurationUs, snapPoints, sortedItemsOfTrack, tracksInDrawOrder } from './selectors';

export type TimelineState = CompositionPayload;
export type EditMode = 'normal' | 'insert' | 'overwrite';

export interface CommandOk {
  ok: true;
  state: TimelineState;
  patches: Patch[];
  inverse: Patch[];
  /** Items the command touched — the caller selects these after undo/redo. */
  affectedItemIds: string[];
  /** Human-readable notes worth surfacing (bumps, ripples, clamps). */
  notes: string[];
}

export interface CommandError {
  ok: false;
  code:
    | 'not_found'
    | 'locked'
    | 'overlap'
    | 'too_short'
    | 'invalid'
    | 'source_bounds'
    | 'no_room';
  message: string;
}

export type CommandResult = CommandOk | CommandError;

/** Deep copy of a plain item (safe for structuredClone-able data). */
function copyPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep copy of a draft item: immer drafts are proxies and cannot be cloned. */
function copyDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(current(value))) as T;
}

function fail(code: CommandError['code'], message: string): CommandError {
  return { ok: false, code, message };
}

function sortTrackItems(draft: TimelineState, trackId: string): void {
  const track = draft.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return;
  track.itemIds = [...track.itemIds].sort((a, b) => {
    const left = draft.items[a];
    const right = draft.items[b];
    if (!left || !right) return 0;
    return left.startUs - right.startUs;
  });
}

function addToTrack(draft: TimelineState, trackId: string, itemId: string): void {
  const track = draft.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return;
  if (!track.itemIds.includes(itemId)) track.itemIds.push(itemId);
  sortTrackItems(draft, trackId);
}

function removeFromTrack(draft: TimelineState, trackId: string, itemId: string): void {
  const track = draft.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return;
  track.itemIds = track.itemIds.filter((id) => id !== itemId);
}

function overlapsAny(
  items: readonly { startUs: number; durationUs: number }[],
  startUs: number,
  durationUs: number,
): boolean {
  const endUs = startUs + durationUs;
  return items.some((item) => startUs < itemEndUs(item) && endUs > item.startUs);
}

/** Nearest gap on a track that fits `durationUs`, preferring `desiredStartUs`. */
function nearestFreeStart(
  occupied: readonly { startUs: number; durationUs: number }[],
  desiredStartUs: number,
  durationUs: number,
): number | null {
  const sorted = [...occupied].sort((a, b) => a.startUs - b.startUs);
  const candidates = new Set<number>([Math.max(0, desiredStartUs)]);
  let cursor = 0;
  for (const item of sorted) {
    candidates.add(cursor);
    cursor = Math.max(cursor, itemEndUs(item));
  }
  candidates.add(cursor);

  const fitting = [...candidates]
    .filter((start) => start >= 0 && !overlapsAny(sorted, start, durationUs))
    .sort((a, b) => Math.abs(a - desiredStartUs) - Math.abs(b - desiredStartUs) || a - b);
  return fitting[0] ?? null;
}

function canHold(item: TimelineItem, trackKind: string): boolean {
  switch (item.type) {
    case 'video':
    case 'image':
      return trackKind === 'video';
    case 'audio':
      return trackKind === 'audio';
    case 'caption':
      return trackKind === 'caption';
    case 'text':
      return trackKind === 'text';
    default:
      return true;
  }
}

export interface MoveTarget {
  itemId: string;
  startUs: number;
  trackId?: string;
}

/**
 * Move one or more items as a single transaction (SPEC 09 §12 Move, §13.2).
 * Normal mode: clamp into the nearest free gap, or bump to another compatible
 * track; Insert shifts later items right; Overwrite trims or removes what it
 * covers. Nothing is destroyed in Normal mode.
 */
export function moveItems(
  state: TimelineState,
  params: { moves: MoveTarget[]; fps: Fps; mode?: EditMode },
): CommandResult {
  const mode = params.mode ?? 'normal';
  if (!params.moves.length) return fail('invalid', 'Nothing to move.');

  const movingIds = new Set(params.moves.map((move) => move.itemId));
  const notes: string[] = [];

  // Validate everything before mutating so a refusal leaves the state untouched.
  for (const move of params.moves) {
    const item = state.items[move.itemId];
    if (!item) return fail('not_found', 'That item no longer exists.');
    const trackId = move.trackId ?? item.trackId;
    const track = state.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return fail('not_found', 'That track no longer exists.');
    if (track.locked) return fail('locked', `“${track.name}” is locked.`);
    const original = state.tracks.find((candidate) => candidate.id === item.trackId);
    if (original?.locked) return fail('locked', `“${original.name}” is locked.`);
    if (trackId !== item.trackId && !canHold(item, track.kind)) {
      return fail('invalid', `“${track.name}” cannot hold that clip.`);
    }
  }

  const [next, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const move of params.moves) {
      const item = draft.items[move.itemId] as TimelineItem;
      const originalTrackId = item.trackId;
      let trackId = move.trackId ?? originalTrackId;
      const targetTrack = draft.tracks.find((candidate) => candidate.id === trackId);
      if (!targetTrack) continue;
      const durationUs = item.durationUs;
      let startUs = quantizeUs(move.startUs, params.fps);

      const others = () =>
        sortedItemsOfTrack(draft as TimelineState, trackId).filter(
          (candidate) => !movingIds.has(candidate.id),
        );

      // SPEC 09 §13.2: on a magnetic main track, Normal behaves as Insert.
      const effectiveMode: EditMode =
        mode === 'normal' && targetTrack.role === 'main' && targetTrack.magnetic
          ? 'insert'
          : mode;

      if (effectiveMode === 'insert') {
        if (overlapsAny(others(), startUs, durationUs)) {
          splitAtPoint(draft, trackId, startUs, params.fps);
        }
        for (const other of sortedItemsOfTrack(draft as TimelineState, trackId)) {
          if (movingIds.has(other.id)) continue;
          if (other.startUs >= startUs) {
            other.startUs = quantizeUs(other.startUs + durationUs, params.fps);
          }
        }
      } else if (effectiveMode === 'overwrite') {
        for (const other of sortedItemsOfTrack(draft as TimelineState, trackId)) {
          if (movingIds.has(other.id)) continue;
          const otherEnd = itemEndUs(other);
          const coversStart = startUs <= other.startUs;
          const coversEnd = startUs + durationUs >= otherEnd;
          if (coversStart && coversEnd) {
            removeFromTrack(draft, trackId, other.id);
            delete draft.items[other.id];
            notes.push(`Replaced “${other.label}”.`);
            continue;
          }
          if (startUs > other.startUs && startUs < otherEnd) {
            const trimmed = quantizeUs(startUs - other.startUs, params.fps);
            if (trimmed < frameDurationUs(params.fps)) {
              removeFromTrack(draft, trackId, other.id);
              delete draft.items[other.id];
            } else {
              other.durationUs = trimmed;
            }
          } else if (startUs + durationUs > other.startUs && startUs + durationUs < otherEnd) {
            const shift = quantizeUs(startUs + durationUs - other.startUs, params.fps);
            other.startUs = quantizeUs(other.startUs + shift, params.fps);
            other.durationUs = Math.max(
              frameDurationUs(params.fps),
              quantizeUs(otherEnd - other.startUs, params.fps),
            );
          }
        }
      } else if (overlapsAny(others(), startUs, durationUs)) {
        // Normal mode never destroys anything by surprise (SPEC 09 §13.2).
        const free = nearestFreeStart(others(), startUs, durationUs);
        if (free === null) {
          const fallback = draft.tracks.find(
            (candidate) =>
              !candidate.locked &&
              candidate.role !== 'main' &&
              candidate.id !== trackId &&
              candidate.kind === targetTrack.kind &&
              !overlapsAny(
                sortedItemsOfTrack(draft as TimelineState, candidate.id).filter(
                  (candidateItem) => !movingIds.has(candidateItem.id),
                ),
                startUs,
                durationUs,
              ),
          );
          if (fallback) {
            trackId = fallback.id;
            notes.push(`Moved to “${fallback.name}” — that space was occupied.`);
          } else {
            startUs = quantizeUs(item.startUs, params.fps);
            notes.push('No free space — the clip stayed where it was.');
          }
        } else {
          startUs = free;
          notes.push('Placed in the nearest free gap.');
        }
      }

      if (trackId !== originalTrackId) removeFromTrack(draft, originalTrackId, item.id);
      item.trackId = trackId;
      item.startUs = startUs;
      addToTrack(draft, trackId, item.id);
    }

    // Magnetic main track: moving a main-track clip away closes the gap it
    // left (SPEC 09 §9.4.2). Clips still on the main track act as anchors.
    const mainTrack = draft.tracks.find((track) => track.role === 'main');
    if (mainTrack?.magnetic) {
      const movedFromMain = params.moves
        .map((move) => {
          const original = state.items[move.itemId];
          return original && state.tracks.find((track) => track.id === original.trackId)?.role === 'main'
            ? { itemId: move.itemId, oldStartUs: original.startUs }
            : null;
        })
        .filter((value): value is { itemId: string; oldStartUs: number } => value !== null);
      if (movedFromMain.length) {
        const skipIds = new Set(
          movedFromMain
            .filter((move) => draft.items[move.itemId]?.trackId === mainTrack.id)
            .map((move) => move.itemId),
        );
        const minStart = Math.min(...movedFromMain.map((move) => move.oldStartUs));
        closeMainGaps(draft, params.fps, minStart, skipIds);
      }
    }
  });

  return {
    ok: true,
    state: next,
    patches,
    inverse,
    affectedItemIds: params.moves.map((move) => move.itemId),
    notes,
  };
}

/** Internal split used by Insert mode; shares the rules of the public split. */
function splitAtPoint(draft: TimelineState, trackId: string, atUs: number, fps: Fps): void {
  const target = sortedItemsOfTrack(draft as TimelineState, trackId).find(
    (item) => atUs > item.startUs && atUs < itemEndUs(item),
  );
  if (!target) return;
  const leftDuration = quantizeUs(atUs - target.startUs, fps);
  const right: TimelineItem = {
    ...copyDraft(target),
    id: `${target.id}~${atUs.toString(36)}`,
    startUs: quantizeUs(target.startUs + leftDuration, fps),
    durationUs: Math.max(frameDurationUs(fps), target.durationUs - leftDuration),
    sourceInUs: Math.max(0, quantizeUs(target.sourceInUs + leftDuration * (target.speed ?? 1), fps)),
  };
  target.durationUs = Math.max(frameDurationUs(fps), leftDuration);
  draft.items[right.id] = right;
  addToTrack(draft, trackId, right.id);
}

export interface TrimParams {
  itemId: string;
  edge: 'start' | 'end';
  toUs: number;
  fps: Fps;
  ripple?: boolean;
}

function availableBefore(item: TimelineItem): number {
  const speed = item.speed ?? 1;
  return Math.max(0, Math.round(item.sourceInUs / speed));
}

function availableAfter(item: TimelineItem): number {
  const speed = item.speed ?? 1;
  if (!item.sourceDurationUs) return 24 * 3600 * 1_000_000;
  const used = item.sourceInUs + Math.round(item.durationUs * speed);
  return Math.max(0, Math.round((item.sourceDurationUs - used) / speed));
}

/** New start/duration for one edge trim, clamped by neighbours and source. */
function trimGeometry(
  state: TimelineState,
  item: TimelineItem,
  edge: 'start' | 'end',
  toUs: number,
  fps: Fps,
  excludeIds: Set<string>,
  ripple?: boolean,
): { nextStart: number; nextDuration: number; notes: string[] } {
  const minDuration = frameDurationUs(fps);
  const notes: string[] = [];
  const others = sortedItemsOfTrack(state, item.trackId).filter(
    (candidate) => candidate.id !== item.id && !excludeIds.has(candidate.id),
  );
  const previous = [...others].reverse().find((candidate) => itemEndUs(candidate) <= item.startUs);
  const following = others.find((candidate) => candidate.startUs >= itemEndUs(item));

  if (edge === 'start') {
    const requested = quantizeUs(toUs, fps);
    const sourceLimit = item.startUs - availableBefore(item);
    const previousEnd = previous ? itemEndUs(previous) : 0;
    const minStart = Math.max(0, previousEnd, sourceLimit);
    // With ripple the clip keeps its duration and pushes its followers, so the
    // start may travel later up to the source end; the earlier limit is the
    // floor that keeps followers off the previous clip (see trim ripple below).
    const maxStart = ripple
      ? quantizeUs(item.startUs + availableAfter(item), fps)
      : quantizeUs(itemEndUs(item) - minDuration, fps);
    const nextStart = Math.min(Math.max(requested, minStart), maxStart);
    if (requested < minStart && previous && minStart === previousEnd) {
      notes.push('Blocked by the previous clip.');
    } else if (requested < minStart) {
      notes.push('Blocked by the start of the source.');
    }
    return {
      nextStart,
      nextDuration: ripple
        ? item.durationUs
        : Math.max(minDuration, quantizeUs(itemEndUs(item) - nextStart, fps)),
      notes,
    };
  }

  const requestedEnd = quantizeUs(toUs, fps);
  const sourceEnd = itemEndUs(item) + availableAfter(item);
  // With ripple an extension pushes the following clip right instead of being clamped.
  const maxEnd =
    ripple && requestedEnd > itemEndUs(item)
      ? sourceEnd
      : following
        ? Math.min(following.startUs, sourceEnd)
        : sourceEnd;
  const minEnd = quantizeUs(item.startUs + minDuration, fps);
  const endUs = Math.min(Math.max(requestedEnd, minEnd), quantizeUs(maxEnd, fps));
  if (requestedEnd > maxEnd && following && maxEnd === following.startUs) {
    notes.push('Blocked by the next clip.');
  } else if (requestedEnd > maxEnd) {
    notes.push('Blocked by the end of the source.');
  }
  return {
    nextStart: item.startUs,
    nextDuration: Math.max(minDuration, quantizeUs(endUs - item.startUs, fps)),
    notes,
  };
}

/** Trim one edge, clamped by the neighbouring clip and by the source media. */
export function trimItem(state: TimelineState, params: TrimParams): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `“${track.name}” is locked.`);

  const notes: string[] = [];
  const { nextStart, nextDuration, notes: geometryNotes } = trimGeometry(
    state,
    item,
    params.edge,
    params.toUs,
    params.fps,
    new Set(),
    params.ripple,
  );
  notes.push(...geometryNotes);

  // Ripple (SPEC 09 §13.3–13.4): extending/shortening this edge shifts the
  // later items on this track — and on the tracks of linked partners — by the
  // same delta. Locked tracks never move: a ripple that would push a locked
  // item is refused before anything is mutated.
  const rippleTrackIds = params.ripple
    ? [item.trackId, ...linkedTrackIds(state, item.id)]
    : [];
  const anchorUs =
    params.edge === 'start' ? item.startUs : Math.min(itemEndUs(item), nextStart + nextDuration);
  let deltaUs =
    params.edge === 'start'
      ? nextStart - item.startUs
      : nextStart + nextDuration - itemEndUs(item);

  // A start-edge ripple moving left would pile followers onto the previous
  // clip or below zero: floor the delta so the followers stay clear.
  if (params.ripple && params.edge === 'start' && deltaUs < 0) {
    const previous = sortedItemsOfTrack(state, item.trackId)
      .filter((candidate) => candidate.id !== item.id)
      .reverse()
      .find((candidate) => itemEndUs(candidate) <= item.startUs);
    const floor = Math.max(
      previous ? itemEndUs(previous) - item.startUs : -item.startUs,
      -itemEndUs(item),
    );
    if (deltaUs < floor) {
      deltaUs = floor;
      notes.push('Blocked by the previous clip.');
    }
  }
  const finalStart = params.edge === 'start' ? item.startUs + deltaUs : nextStart;

  if (params.ripple && deltaUs !== 0) {
    for (const trackId of rippleTrackIds) {
      const rippleTrack = state.tracks.find((candidate) => candidate.id === trackId);
      if (!rippleTrack) continue;
      if (
        sortedItemsOfTrack(state, trackId).some(
          (candidate) => candidate.startUs >= anchorUs && rippleTrack.locked,
        )
      ) {
        return fail('locked', `“${rippleTrack.name}” is locked; ripple refused.`);
      }
    }
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (params.edge === 'start') {
      const delta = finalStart - target.startUs;
      target.sourceInUs = Math.max(
        0,
        quantizeUs(target.sourceInUs + delta * (target.speed ?? 1), params.fps),
      );
    }
    target.startUs = finalStart;
    target.durationUs = nextDuration;

    if (params.ripple && deltaUs !== 0) {
      for (const trackId of rippleTrackIds) {
        for (const other of sortedItemsOfTrack(draft as TimelineState, trackId)) {
          if (other.id === params.itemId) continue;
          if (other.startUs >= anchorUs) {
            other.startUs = Math.max(0, quantizeUs(other.startUs + deltaUs, params.fps));
          }
        }
        sortTrackItems(draft, trackId);
      }
    } else {
      sortTrackItems(draft, item.trackId);
    }

    // Magnetic main track: shortening the end edge closes the gap after it.
    if (
      !params.ripple &&
      params.edge === 'end' &&
      nextDuration < item.durationUs &&
      track.role === 'main'
    ) {
      closeMainGaps(draft, params.fps, finalStart + nextDuration);
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes,
  };
}

/**
 * Magnetic main track (SPEC 09 §9.4.2): clips on the main track are always
 * packed end to end. Shifts every item at/after `fromUs` left to close the
 * gap, skipping `skipIds` (moved clips act as anchors). Locked items never
 * move — the cursor jumps past them and later items pack against their end.
 */
function closeMainGaps(
  draft: TimelineState,
  fps: Fps,
  fromUs: number,
  skipIds: Set<string> = new Set(),
): void {
  const main = draft.tracks.find((track) => track.role === 'main');
  if (!main || main.magnetic === false) return;
  let cursor = Math.max(0, quantizeUs(fromUs, fps));
  for (const item of sortedItemsOfTrack(draft, main.id)) {
    if (skipIds.has(item.id)) {
      cursor = Math.max(cursor, itemEndUs(item));
      continue;
    }
    if (item.startUs >= cursor) {
      if (item.startUs > cursor) item.startUs = cursor;
      cursor = itemEndUs(item);
    } else {
      cursor = Math.max(cursor, itemEndUs(item));
    }
  }
  sortTrackItems(draft, main.id);
}

/** Tracks of items sharing this item's linkId (SPEC 09 §9.6). */
function linkedTrackIds(state: TimelineState, itemId: string): string[] {
  const item = state.items[itemId];
  if (!item?.linkId) return [];
  const tracks: string[] = [];
  for (const candidate of Object.values(state.items)) {
    if (candidate.linkId !== item.linkId || candidate.id === itemId) continue;
    if (!tracks.includes(candidate.trackId)) tracks.push(candidate.trackId);
  }
  return tracks;
}

/**
 * Move selected items to the track above/below in draw order (SPEC 09 §12,
 * Alt+Up/Down). Same-track requests are a no-op; the move itself follows the
 * usual overlap policy through {@link moveItems}.
 */
export function moveItemsToTrack(
  state: TimelineState,
  params: { itemIds: string[]; direction: 'up' | 'down'; fps: Fps },
): CommandResult {
  if (!params.itemIds.length) return fail('invalid', 'Nothing to move.');

  const moves: MoveTarget[] = [];
  const notes: string[] = [];
  for (const itemId of params.itemIds) {
    const item = state.items[itemId];
    if (!item) return fail('not_found', 'That item no longer exists.');
    const order = tracksInDrawOrder(state);
    const index = order.findIndex((track) => track.id === item.trackId);
    const target = order[index + (params.direction === 'up' ? -1 : 1)];
    if (!target) {
      notes.push('No track above.');
      continue;
    }
    moves.push({ itemId, startUs: item.startUs, trackId: target.id });
  }

  if (!moves.length) return { ok: true, state, patches: [], inverse: [], affectedItemIds: [], notes };
  const result = moveItems(state, { moves, fps: params.fps });
  if (!result.ok) return result;
  return {
    ...result,
    affectedItemIds: params.itemIds.filter((id) => result.affectedItemIds.includes(id)),
    notes,
  };
}

/**
 * Trim every selected item's edge to the playhead in one transaction (SPEC 09
 * §12 Q/W). Selected items move together, so they are not each other's
 * blockers; with `ripple` the following unselected clips follow the selection.
 */
export function trimItems(
  state: TimelineState,
  params: { itemIds: string[]; edge: 'start' | 'end'; toUs: number; fps: Fps; ripple?: boolean },
): CommandResult {
  if (!params.itemIds.length) return fail('invalid', 'Nothing to trim.');
  for (const itemId of params.itemIds) {
    const item = state.items[itemId];
    if (!item) return fail('not_found', 'That item no longer exists.');
    const track = state.tracks.find((candidate) => candidate.id === item.trackId);
    if (!track) return fail('not_found', 'That track no longer exists.');
    if (track.locked) return fail('locked', `“${track.name}” is locked.`);
  }

  const minDuration = frameDurationUs(params.fps);
  const exclude = new Set(params.itemIds);
  const notes: string[] = [];
  const geometry = new Map<string, { nextStart: number; nextDuration: number }>();
  for (const itemId of params.itemIds) {
    const geometryResult = trimGeometry(
      state,
      state.items[itemId]!,
      params.edge,
      params.toUs,
      params.fps,
      exclude,
      params.ripple,
    );
    geometry.set(itemId, geometryResult);
    notes.push(...geometryResult.notes);
  }

  // Selected items on the same track must not overlap after the trim: an
  // earlier clip's end never passes a later clip's start (the later clip clamps
  // instead, which is safer than silently overwriting).
  const selected = params.itemIds.map((id) => state.items[id]!);
  for (const trackId of new Set(selected.map((item) => item.trackId))) {
    const ordered = selected
      .filter((item) => item.trackId === trackId)
      .sort((a, b) => a.startUs - b.startUs);
    for (let index = 1; index < ordered.length; index += 1) {
      const earlier = geometry.get(ordered[index - 1]!.id)!;
      const later = geometry.get(ordered[index]!.id)!;
      if (params.edge === 'end') {
        const maxEnd = Math.min(earlier.nextStart + earlier.nextDuration, later.nextStart);
        earlier.nextDuration = Math.max(
          minDuration,
          quantizeUs(Math.min(earlier.nextDuration, maxEnd - earlier.nextStart), params.fps),
        );
      } else {
        later.nextStart = Math.max(
          later.nextStart,
          earlier.nextStart + earlier.nextDuration,
        );
        if (!params.ripple) {
          later.nextDuration = Math.max(
            minDuration,
            quantizeUs(itemEndUs(ordered[index]!) - later.nextStart, params.fps),
          );
        }
      }
    }
  }

  // Ripple: unselected clips that follow the selection move by the selection's
  // total delta. The anchor is the selection's leading edge for a start-edge
  // trim and its trailing edge for an end-edge trim.
  const anchorUs =
    params.edge === 'start'
      ? Math.min(...selected.map((item) => item.startUs))
      : Math.max(...selected.map((item) => itemEndUs(item)));
  const nextAnchorUs =
    params.edge === 'start'
      ? Math.min(...selected.map((item) => geometry.get(item.id)!.nextStart))
      : Math.max(
          ...selected.map((item) => geometry.get(item.id)!.nextStart + geometry.get(item.id)!.nextDuration),
        );
  let deltaUs = nextAnchorUs - anchorUs;

  if (params.ripple && params.edge === 'start' && deltaUs < 0) {
    // Keep the followers off the previous clip (and above zero).
    let floor = -Math.min(...selected.map((item) => itemEndUs(item)));
    for (const trackId of new Set(selected.map((item) => item.trackId))) {
      const previous = sortedItemsOfTrack(state, trackId)
        .filter((candidate) => !exclude.has(candidate.id))
        .reverse()
        .find((candidate) => itemEndUs(candidate) <= anchorUs);
      if (previous) floor = Math.max(floor, itemEndUs(previous) - anchorUs);
    }
    if (deltaUs < floor) {
      deltaUs = floor;
      notes.push('Blocked by the previous clip.');
    }
  }

  const rippleTrackIds = params.ripple
    ? [...new Set(selected.flatMap((item) => [item.trackId, ...linkedTrackIds(state, item.id)]))]
    : [];
  if (params.ripple && deltaUs !== 0) {
    for (const trackId of rippleTrackIds) {
      const rippleTrack = state.tracks.find((candidate) => candidate.id === trackId);
      if (!rippleTrack) continue;
      if (
        sortedItemsOfTrack(state, trackId).some(
          (candidate) => candidate.startUs >= anchorUs && rippleTrack.locked,
        )
      ) {
        return fail('locked', `“${rippleTrack.name}” is locked; ripple refused.`);
      }
    }
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const itemId of params.itemIds) {
      const target = draft.items[itemId] as TimelineItem;
      const next = geometry.get(itemId)!;
      if (params.edge === 'start') {
        const delta = next.nextStart - target.startUs;
        target.sourceInUs = Math.max(
          0,
          quantizeUs(target.sourceInUs + delta * (target.speed ?? 1), params.fps),
        );
      }
      target.startUs = next.nextStart;
      target.durationUs = next.nextDuration;
    }
    if (params.ripple && deltaUs !== 0) {
      const selectedIds = new Set(params.itemIds);
      for (const trackId of rippleTrackIds) {
        for (const other of sortedItemsOfTrack(draft as TimelineState, trackId)) {
          if (selectedIds.has(other.id)) continue;
          if (other.startUs >= anchorUs) {
            other.startUs = Math.max(0, quantizeUs(other.startUs + deltaUs, params.fps));
          }
        }
        sortTrackItems(draft, trackId);
      }
    } else {
      for (const itemId of params.itemIds) sortTrackItems(draft, state.items[itemId]!.trackId);
    }

    // Magnetic main track: shortened end edges close the gaps after them.
    if (!params.ripple && params.edge === 'end') {
      const onMain = selected.filter(
        (item) => state.tracks.find((track) => track.id === item.trackId)?.role === 'main',
      );
      if (onMain.length) {
        const maxEnd = Math.max(
          ...onMain.map((item) => geometry.get(item.id)!.nextStart + geometry.get(item.id)!.nextDuration),
        );
        closeMainGaps(draft, params.fps, maxEnd);
      }
    }
  });

  return { ok: true, state: nextState, patches, inverse, affectedItemIds: params.itemIds, notes };
}

/**
 * Rolling edit (SPEC 09 §13.3): Ctrl+drag at a junction between two adjacent
 * clips moves the cut point. The left clip's end and the right clip's start
 * change by the same amount, the total span is unchanged, and the move is
 * limited by the available source on both sides.
 */
export function rollAt(
  state: TimelineState,
  params: { leftItemId: string; rightItemId: string; atUs: number; fps: Fps },
): CommandResult {
  const left = state.items[params.leftItemId];
  const right = state.items[params.rightItemId];
  if (!left || !right) return fail('not_found', 'That item no longer exists.');
  if (left.trackId !== right.trackId) {
    return fail('invalid', 'Rolling edit needs two clips on the same track.');
  }
  const track = state.tracks.find((candidate) => candidate.id === left.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `“${track.name}” is locked.`);

  const minDuration = frameDurationUs(params.fps);
  const leftEnd = itemEndUs(left);
  const rightEnd = itemEndUs(right);
  if (Math.abs(leftEnd - right.startUs) > minDuration) {
    return fail('invalid', 'Those clips are not adjacent.');
  }

  // The junction can travel within both clips' source limits.
  const speed = left.speed ?? 1;
  const sourceLimit =
    left.startUs +
    Math.round(
      ((left.sourceDurationUs ?? 24 * 3600 * 1_000_000) - left.sourceInUs) / speed,
    );
  const minJunction = Math.max(left.startUs + minDuration, 0);
  const maxJunction = Math.min(sourceLimit, rightEnd - minDuration);
  const junction = Math.min(
    Math.max(quantizeUs(params.atUs, params.fps), minJunction),
    quantizeUs(maxJunction, params.fps),
  );

  const notes: string[] = [];
  if (params.atUs < minJunction) notes.push('Blocked by the start of the left clip.');
  if (params.atUs > maxJunction) notes.push('Blocked by the end of the right clip.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const leftTarget = draft.items[params.leftItemId] as TimelineItem;
    const rightTarget = draft.items[params.rightItemId] as TimelineItem;
    leftTarget.durationUs = Math.max(minDuration, quantizeUs(junction - leftTarget.startUs, params.fps));
    rightTarget.startUs = junction;
    rightTarget.durationUs = Math.max(minDuration, quantizeUs(rightEnd - junction, params.fps));
    sortTrackItems(draft, left.trackId);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.leftItemId, params.rightItemId],
    notes,
  };
}

/** Toggle the magnetic main track (SPEC 09 §9.4.2). Only the main track accepts it. */
export function setTrackMagnetic(
  state: TimelineState,
  params: { trackId: string; magnetic: boolean },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.role !== 'main') return fail('invalid', 'Only the main track can be magnetic.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.tracks.find((candidate) => candidate.id === params.trackId);
    if (target) target.magnetic = params.magnetic;
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/** SPEC 09 §12 Split: both halves keep every property; the right half gets a new id. */
export function splitItems(
  state: TimelineState,
  params: { itemIds?: string[]; atUs: number; fps: Fps },
): CommandResult {
  const atUs = quantizeUs(params.atUs, params.fps);
  const minDuration = frameDurationUs(params.fps);

  const targets = Object.values(state.items).filter((item) => {
    if (params.itemIds && params.itemIds.length && !params.itemIds.includes(item.id)) return false;
    const track = state.tracks.find((candidate) => candidate.id === item.trackId);
    if (!track || track.locked) return false;
    return atUs > item.startUs + minDuration && atUs < itemEndUs(item) - minDuration;
  });

  if (!targets.length) return fail('too_short', 'Nothing under the playhead can be split.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const target of targets) {
      const item = draft.items[target.id] as TimelineItem;
      const leftDuration = quantizeUs(atUs - item.startUs, params.fps);
      const right: TimelineItem = {
        ...copyDraft(item),
        id: `${item.id}~${atUs.toString(36)}`,
        startUs: atUs,
        durationUs: Math.max(minDuration, item.durationUs - leftDuration),
        sourceInUs: Math.max(
          0,
          quantizeUs(item.sourceInUs + leftDuration * (item.speed ?? 1), params.fps),
        ),
      };
      item.durationUs = Math.max(minDuration, leftDuration);
      draft.items[right.id] = right;
      addToTrack(draft, item.trackId, right.id);
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: targets.map((item) => item.id),
    notes: [],
  };
}

/**
 * Delete (SPEC 09 §12). `ripple` closes the gap left by the removed duration on
 * the affected tracks; `rippleAll` does the same on every unlocked track.
 */
export function deleteItems(
  state: TimelineState,
  params: { itemIds: string[]; fps: Fps; ripple?: boolean; rippleAll?: boolean },
): CommandResult {
  if (!params.itemIds.length) return fail('invalid', 'Nothing is selected.');

  for (const id of params.itemIds) {
    const item = state.items[id];
    if (!item) continue;
    const track = state.tracks.find((candidate) => candidate.id === item.trackId);
    if (track?.locked) return fail('locked', `“${track.name}” is locked.`);
  }

  const removedOnMain = params.itemIds.some((id) => {
    const item = state.items[id];
    return item && state.tracks.find((track) => track.id === item.trackId)?.role === 'main';
  });

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of params.itemIds) {
      const item = draft.items[id];
      if (!item) continue;
      const trackId = item.trackId;
      const startUs = item.startUs;
      const durationUs = item.durationUs;
      removeFromTrack(draft, trackId, id);
      delete draft.items[id];

      if (!params.ripple) continue;
      const affected = new Set<string>([trackId]);
      if (params.rippleAll) {
        for (const track of draft.tracks) if (!track.locked) affected.add(track.id);
      }
      for (const affectedId of affected) {
        const track = draft.tracks.find((candidate) => candidate.id === affectedId);
        if (!track || track.locked) continue;
        for (const other of sortedItemsOfTrack(draft as TimelineState, affectedId)) {
          if (other.startUs >= startUs + durationUs) {
            other.startUs = Math.max(0, quantizeUs(other.startUs - durationUs, params.fps));
          }
        }
        sortTrackItems(draft, affectedId);
      }
    }

    // Magnetic main track: a non-ripple delete still closes the gap (SPEC 09 §9.4.2).
    if (!params.ripple && removedOnMain) {
      const minStart = Math.min(
        ...params.itemIds.map((id) => state.items[id]?.startUs ?? 0),
      );
      closeMainGaps(draft, params.fps, minStart);
    }
  });

  return { ok: true, state: nextState, patches, inverse, affectedItemIds: params.itemIds, notes: [] };
}

/** Duplicate: the copy lands immediately after the original on the same track. */
export function duplicateItems(
  state: TimelineState,
  params: { itemIds: string[]; fps: Fps },
): CommandResult {
  if (!params.itemIds.length) return fail('invalid', 'Nothing is selected.');
  const copies: string[] = [];

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of params.itemIds) {
      const item = draft.items[id] as TimelineItem | undefined;
      if (!item) continue;
      const track = draft.tracks.find((candidate) => candidate.id === item.trackId);
      if (!track || track.locked) continue;
      const existing = sortedItemsOfTrack(draft as TimelineState, item.trackId).filter(
        (candidate) => !params.itemIds.includes(candidate.id),
      );
      const startUs = quantizeUs(itemEndUs(item), params.fps);
      if (overlapsAny(existing, startUs, item.durationUs)) continue;
      const copyId = `${item.id}~copy${copies.length}`;
      draft.items[copyId] = { ...copyDraft(item), id: copyId, startUs };
      addToTrack(draft, item.trackId, copyId);
      copies.push(copyId);
    }
  });

  if (!copies.length) return fail('no_room', 'There is no free space right after the selection.');
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: copies, notes: [] };
}

/**
 * Add a new item (a drop from the media library). Placement follows Normal mode:
 * the requested time if it is free, otherwise the nearest free gap on that track,
 * otherwise a compatible unlocked track, otherwise a refusal.
 */
export function addItem(
  state: TimelineState,
  params: { item: TimelineItem; fps: Fps; startUs?: number; trackId?: string },
): CommandResult & { trackId?: string } {
  const trackId = params.trackId ?? params.item.trackId;
  const track = state.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `“${track.name}” is locked.`);
  if (!canHold(params.item, track.kind)) {
    return fail('invalid', `“${track.name}” cannot hold that clip.`);
  }
  if (state.items[params.item.id]) return fail('invalid', 'That item already exists.');
  if (params.item.durationUs < frameDurationUs(params.fps)) {
    return fail('too_short', 'A clip must be at least one frame long.');
  }
  if (params.item.sourceDurationUs !== undefined && params.item.mediaId) {
    const needed = params.item.sourceInUs + params.item.durationUs * (params.item.speed ?? 1);
    if (params.item.sourceInUs < 0 || needed > params.item.sourceDurationUs + 1) {
      return fail('source_bounds', 'That clip is longer than its source media.');
    }
  }

  const notes: string[] = [];
  let startUs = quantizeUs(params.startUs ?? params.item.startUs, params.fps);
  let placedTrackId = trackId;
  const occupied = sortedItemsOfTrack(state, trackId);
  const magneticMain = track.role === 'main' && track.magnetic === true;
  if (overlapsAny(occupied, startUs, params.item.durationUs)) {
    if (magneticMain) {
      // SPEC 09 §13.2: dropping on a magnetic main track inserts and ripples.
      const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
        if (overlapsAny(sortedItemsOfTrack(draft as TimelineState, trackId), startUs, params.item.durationUs)) {
          splitAtPoint(draft, trackId, startUs, params.fps);
        }
        for (const other of sortedItemsOfTrack(draft as TimelineState, trackId)) {
          if (other.startUs >= startUs) {
            other.startUs = quantizeUs(other.startUs + params.item.durationUs, params.fps);
          }
        }
        const item = { ...copyPlain(params.item), trackId, startUs } as TimelineItem;
        draft.items[item.id] = item;
        addToTrack(draft, trackId, item.id);
      });
      return {
        ok: true,
        state: nextState,
        patches,
        inverse,
        affectedItemIds: [params.item.id],
        notes: ['Inserted on the main track.'],
        trackId,
      };
    }
    const free = nearestFreeStart(occupied, startUs, params.item.durationUs);
    if (free === null) {
      const fallback = state.tracks.find(
        (candidate) =>
          !candidate.locked &&
          candidate.role !== 'main' &&
          candidate.id !== trackId &&
          candidate.kind === track.kind &&
          !overlapsAny(
            sortedItemsOfTrack(state, candidate.id),
            startUs,
            params.item.durationUs,
          ),
      );
      if (!fallback) return fail('no_room', `There is no free space on “${track.name}”.`);
      placedTrackId = fallback.id;
      notes.push(`Placed on “${fallback.name}” — “${track.name}” was occupied.`);
    } else {
      startUs = free;
      notes.push('Placed in the nearest free gap.');
    }
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const item = { ...copyPlain(params.item), trackId: placedTrackId, startUs } as TimelineItem;
    draft.items[item.id] = item;
    addToTrack(draft, placedTrackId, item.id);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.item.id],
    notes,
    trackId: placedTrackId,
  };
}

export function addMarker(
  state: TimelineState,
  params: { timeUs: number; fps: Fps; name?: string; color?: string },
): CommandResult {
  const timeUs = quantizeUs(params.timeUs, params.fps);
  const id = `marker~${timeUs.toString(36)}~${state.markers.length}`;
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.markers.push({
      id,
      timeUs,
      name: params.name ?? `Marker ${draft.markers.length + 1}`,
      color: params.color ?? '#FFB000',
    });
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

export function setTrackMuted(
  state: TimelineState,
  params: { trackId: string; muted: boolean },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.tracks.find((candidate) => candidate.id === params.trackId);
    if (target) target.muted = params.muted;
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/** Toggle the disabled flag on an item (SPEC 09 §12, context menu Enable/Disable). */
export function toggleItemDisabled(
  state: TimelineState,
  params: { itemId: string },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    target.disabled = !target.disabled;
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [params.itemId], notes: [] };
}

/** Add a new track of the given kind above (or below) a reference track. */
export function addTrack(
  state: TimelineState,
  params: { kind: 'video' | 'audio' | 'text' | 'caption'; aboveTrackId?: string },
): CommandResult {
  const kinds: Record<string, string> = {
    video: 'New video',
    audio: 'New audio',
    text: 'New text',
    caption: 'New captions',
  };
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const order = draft.tracks.length;
    const newTrack = {
      id: `trk_new_${Date.now()}`,
      role: 'overlay' as const,
      kind: params.kind,
      name: kinds[params.kind],
      order,
      hidden: false,
      locked: false,
      muted: false,
      solo: false,
      heightPx: 48,
      itemIds: [],
      auto: false,
    };
    if (params.aboveTrackId) {
      const refIndex = draft.tracks.findIndex((t) => t.id === params.aboveTrackId);
      if (refIndex >= 0) {
        draft.tracks.splice(refIndex, 0, newTrack);
      } else {
        draft.tracks.push(newTrack);
      }
    } else {
      draft.tracks.push(newTrack);
    }
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: ['Track added.'] };
}

/** Toggle the lock flag on a track (SPEC 09 §9.1). */
export function toggleTrackLock(
  state: TimelineState,
  params: { trackId: string },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.tracks.find((candidate) => candidate.id === params.trackId);
    if (target) target.locked = !target.locked;
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/** Toggle the hidden flag on a track (SPEC 09 §9.1). */
export function toggleTrackHidden(
  state: TimelineState,
  params: { trackId: string },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.tracks.find((candidate) => candidate.id === params.trackId);
    if (target) target.hidden = !target.hidden;
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/** Delete a track and its items (SPEC 09 §21, track header context menu). */
export function deleteTrack(
  state: TimelineState,
  params: { trackId: string },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.tracks = draft.tracks.filter((candidate) => candidate.id !== params.trackId);
    for (const id of track.itemIds) {
      delete draft.items[id];
    }
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: track.itemIds, notes: ['Track deleted.'] };
}

/**
 * Detach audio from a video item (SPEC 09 §9.6): creates a linked audio item
 * on the first available audio track at the same time range, mutes the video's
 * embedded audio, and shares a linkId so both move together.
 */
export function detachAudio(
  state: TimelineState,
  params: { videoItemId: string; fps: Fps },
): CommandResult {
  const video = state.items[params.videoItemId];
  if (!video) return fail('not_found', 'That item no longer exists.');
  if (video.type !== 'video') return fail('invalid', 'Only video items have audio to detach.');

  const startUs = quantizeUs(video.startUs, params.fps);
  const durationUs = quantizeUs(video.durationUs, params.fps);

  // Try each unlocked audio track; pick the first one where the detached
  // audio does not overlap an existing item.
  const audioTracks = state.tracks.filter(
    (candidate) => candidate.kind === 'audio' && !candidate.locked,
  );
  const audioTrack = audioTracks.find((track) => {
    return !track.itemIds.some((id) => {
      const existing = state.items[id];
      if (!existing) return false;
      return startUs < itemEndUs(existing) && existing.startUs < startUs + durationUs;
    });
  });
  if (!audioTrack) {
    return fail('invalid', 'No free audio track to detach audio onto.');
  }

  const linkId = `link-${Date.now()}`;
  const audioId = `${params.videoItemId}-audio`;

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const audioItem = {
      ...video,
      id: audioId,
      trackId: audioTrack.id,
      type: 'audio' as const,
      startUs,
      durationUs,
      linkId,
      muted: false,
    };
    draft.items[audioId] = audioItem;
    draft.tracks = draft.tracks.map((track) =>
      track.id === audioTrack.id
        ? { ...track, itemIds: [...track.itemIds, audioId] }
        : track,
    );
    const videoTarget = draft.items[params.videoItemId] as TimelineItem;
    videoTarget.linkId = linkId;
    videoTarget.muted = true;
    sortTrackItems(draft, audioTrack.id);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.videoItemId, audioId],
    notes: ['Audio detached and linked.'],
  };
}

/**
 * Unlink items that share a linkId (SPEC 09 §9.6): each item keeps its position
 * but loses the link, so they can be edited independently.
 */
export function unlink(
  state: TimelineState,
  params: { itemId: string },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (!item.linkId) return fail('invalid', 'That item is not linked.');

  const linkId = item.linkId;
  const affected: string[] = [];
  for (const candidate of Object.values(state.items)) {
    if (candidate.linkId === linkId) affected.push(candidate.id);
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of affected) {
      const target = draft.items[id] as TimelineItem;
      delete target.linkId;
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: affected,
    notes: ['Link removed.'],
  };
}

/**
 * Paste copied items (SPEC 09 §12): the earliest item lands at `atUs`, relative
 * spacing and track offsets are preserved, and Normal placement rules apply.
 */
export function pasteItems(
  state: TimelineState,
  params: {
    items: Array<{ item: TimelineItem; trackId: string }>;
    atUs: number;
    fps: Fps;
    mode?: EditMode;
  },
): CommandResult {
  if (!params.items.length) return fail('invalid', 'The clipboard is empty.');
  const earliest = Math.min(...params.items.map((entry) => entry.item.startUs));
  const targetStart = quantizeUs(params.atUs, params.fps);
  const placedIds: string[] = [];
  const notes: string[] = [];

  for (const entry of params.items) {
    const track = state.tracks.find((candidate) => candidate.id === entry.trackId);
    if (!track) return { ok: false, code: 'invalid', message: 'That track no longer exists.' };
    if (track.locked) return fail('locked', `“${track.name}” is locked.`);
  }

  let current = state;
  for (const [index, entry] of params.items.entries()) {
    const offsetUs = entry.item.startUs - earliest;
    const id = `${entry.item.id}~paste${index}_${targetStart.toString(36)}`;
    const outcome = addItem(current, {
      fps: params.fps,
      trackId: entry.trackId,
      startUs: targetStart + offsetUs,
      item: { ...entry.item, id },
    });
    if (!outcome.ok) return outcome;
    current = outcome.state;
    placedIds.push(id);
    notes.push(...outcome.notes);
  }

  // Replaying the same paste twice must still be undoable as one step, so the
  // patches are diffed against the original state rather than the last one.
  const patches: Patch[] = [];
  const inverse: Patch[] = [];
  for (const id of placedIds) {
    if (!state.items[id] && current.items[id]) {
      patches.push({ op: 'add', path: ['items', id], value: current.items[id] });
      inverse.push({ op: 'remove', path: ['items', id] });
    }
  }
  for (const track of current.tracks) {
    const before = state.tracks.find((candidate) => candidate.id === track.id);
    if (before && before.itemIds.join('|') !== track.itemIds.join('|')) {
      patches.push({ op: 'replace', path: ['tracks', state.tracks.indexOf(before), 'itemIds'], value: track.itemIds });
      inverse.push({
        op: 'replace',
        path: ['tracks', state.tracks.indexOf(before), 'itemIds'],
        value: before.itemIds,
      });
    }
  }

  return { ok: true, state: current, patches, inverse, affectedItemIds: placedIds, notes };
}

/** Group selected items so they move, trim, split and delete together. */
export function groupItems(
  state: TimelineState,
  params: { itemIds: string[]; groupId?: string },
): CommandResult {
  if (params.itemIds.length < 2) return fail('invalid', 'Select at least two clips to group.');
  const groupId = params.groupId ?? `grp_${params.itemIds[0]!.slice(-4)}${params.itemIds.length}`;
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of params.itemIds) {
      const item = draft.items[id];
      if (item) item.groupId = groupId;
    }
    if (!draft.groups.some((group) => group.id === groupId)) {
      draft.groups.push({ id: groupId, itemIds: [...params.itemIds] } as never);
    }
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: params.itemIds, notes: [] };
}

export function ungroupItems(
  state: TimelineState,
  params: { groupId: string },
): CommandResult {
  const members = Object.values(state.items).filter((item) => item.groupId === params.groupId);
  if (!members.length) return fail('not_found', 'There is no group to ungroup.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const member of members) {
      const item = draft.items[member.id];
      if (item) delete item.groupId;
    }
    draft.groups = draft.groups.filter((group) => group.id !== params.groupId);
  });
  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: members.map((item) => item.id),
    notes: [],
  };
}

/** Snap points for a gesture; re-exported so the UI needs one import. */
export { snapPoints };

/**
 * Attach a transition at a junction between two adjacent items on the same
 * video track (SPEC 09 §16). The transition is stored on the later item as
 * `transitionIn {type, durationUs, alignment}`.
 *
 * Duration is clamped to [2 frames, min(leftHandle, rightHandle)] where
 * handles are the available source media before/after the junction. If no
 * handles exist (clips use full source), only fade/dip types are allowed.
 * Transitions never change the total timeline length.
 */
export function addTransition(
  state: TimelineState,
  params: {
    trackId: string;
    leftItemId: string;
    rightItemId: string;
    type: 'crossfade' | 'dissolve' | 'fade-black' | 'dip-color' | 'wipe' | 'slide' | 'zoom';
    durationUs?: number;
    alignment?: 'center' | 'start' | 'end';
    fps: Fps;
  },
): CommandResult {
  const left = state.items[params.leftItemId];
  const right = state.items[params.rightItemId];
  if (!left || !right) return fail('not_found', 'That item no longer exists.');
  if (left.trackId !== right.trackId) return fail('invalid', 'Transitions need two clips on the same track.');
  if (left.trackId !== params.trackId) return fail('invalid', 'That item is not on the given track.');

  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);
  if (track.kind !== 'video') return fail('invalid', 'Transitions only work on video tracks.');

  const minDuration = frameDurationUs(params.fps) * 2;
  const leftEnd = itemEndUs(left);
  if (Math.abs(leftEnd - right.startUs) > frameDurationUs(params.fps)) {
    return fail('invalid', 'Those clips are not adjacent.');
  }

  // Calculate available handles
  const leftHandle = Math.max(0, Math.round((left.sourceDurationUs ?? 0) - (left.sourceInUs ?? 0) - left.durationUs));
  const rightHandle = Math.max(0, right.sourceInUs ?? 0);
  const maxDuration = Math.min(leftHandle, rightHandle);

  const fadeTypes = ['fade-black', 'dip-color'];
  const requestedType = params.type;
  if (maxDuration < minDuration && !fadeTypes.includes(requestedType)) {
    return fail('no_room', 'No source handles available for this transition type. Only fade/dip transitions work without handles.');
  }

  let duration = params.durationUs ?? Math.round(0.5 * 1_000_000);
  duration = Math.max(minDuration, Math.min(duration, maxDuration > 0 ? maxDuration : minDuration));
  duration = quantizeUs(duration, params.fps);

  const alignment = params.alignment ?? 'center';
  const transitionId = `trans-${Date.now()}`;

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const rightTarget = draft.items[params.rightItemId] as TimelineItem;
    rightTarget.transitionIn = {
      id: transitionId,
      type: requestedType,
      durationUs: duration,
      alignment,
      params: {},
      easing: 'easeInOut',
      crossfadeAudio: true,
    };
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.rightItemId],
    notes: ['Transition added.'],
  };
}

/**
 * Update a transition's properties (SPEC 09 §16): duration, alignment, or type.
 * Duration is clamped to available handles; alignment is one of center/start/end.
 */
export function updateTransition(
  state: TimelineState,
  params: {
    itemId: string;
    patch: Partial<Pick<NonNullable<TimelineItem['transitionIn']>, 'durationUs' | 'alignment' | 'type'>>;
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (!item.transitionIn) return fail('invalid', 'That item has no transition.');

  const transition = item.transitionIn;
  const minDuration = frameDurationUs(params.fps) * 2;

  // Calculate available handles for clamping
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');

  // Find the left item (the one before this item on the same track)
  const sortedIds = [...track.itemIds].sort((a, b) => state.items[a]!.startUs - state.items[b]!.startUs);
  const idx = sortedIds.indexOf(item.id);
  if (idx <= 0) return fail('invalid', 'This item is the first on its track; no junction for a transition.');
  const leftItem = state.items[sortedIds[idx - 1]!];
  if (!leftItem) return fail('not_found', 'The left item no longer exists.');

  const leftEnd = itemEndUs(leftItem);
  if (Math.abs(leftEnd - item.startUs) > frameDurationUs(params.fps)) {
    return fail('invalid', 'The left clip is no longer adjacent.');
  }

  const leftHandle = Math.max(0, Math.round((leftItem.sourceDurationUs ?? 0) - (leftItem.sourceInUs ?? 0) - leftItem.durationUs));
  const rightHandle = Math.max(0, item.sourceInUs ?? 0);
  const maxDuration = Math.min(leftHandle, rightHandle);

  let newDuration = transition.durationUs;
  if (params.patch.durationUs !== undefined) {
    newDuration = Math.max(minDuration, Math.min(params.patch.durationUs, maxDuration > 0 ? maxDuration : minDuration));
    newDuration = quantizeUs(newDuration, params.fps);
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.transitionIn) return;
    target.transitionIn.durationUs = newDuration;
    if (params.patch.alignment) target.transitionIn.alignment = params.patch.alignment;
    if (params.patch.type) target.transitionIn.type = params.patch.type;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Transition updated.'],
  };
}

/**
 * Remove a transition from an item (SPEC 09 §16). The item keeps its position
 * and properties; only the transitionIn is cleared.
 */
export function removeTransition(
  state: TimelineState,
  params: { itemId: string },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (!item.transitionIn) return fail('invalid', 'That item has no transition.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    delete target.transitionIn;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Transition removed.'],
  };
}
/**
 * Set the work area in/out points (SPEC 09 §18). I sets inUs, O sets outUs.
 * Both points are clamped to the project duration and in < out.
 */
export function setWorkArea(
  state: TimelineState,
  params: { edge: 'in' | 'out'; timeUs: number; fps: Fps },
): CommandResult {
  const projectEnd = projectDurationUs(state);
  const quantized = quantizeUs(Math.max(0, Math.min(params.timeUs, projectEnd)), params.fps);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const existing = draft.workArea ?? { inUs: 0, outUs: projectEnd };
    if (params.edge === 'in') {
      draft.workArea = { inUs: quantized, outUs: Math.max(quantized + frameDurationUs(params.fps), existing.outUs) };
    } else {
      draft.workArea = { inUs: Math.min(quantized - frameDurationUs(params.fps), existing.inUs), outUs: quantized };
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: [`Work area ${params.edge} set.`],
  };
}

/**
 * Clear the work area (SPEC 09 §18). Alt+X in the editor.
 */
export function clearWorkArea(
  state: TimelineState,
): CommandResult {
  if (!state.workArea) return { ok: true, state, patches: [], inverse: [], affectedItemIds: [], notes: ['No work area to clear.'] };

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.workArea = undefined;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: ['Work area cleared.'],
  };
}
/**
 * Add a keyframe for a property on an item (SPEC 09 §17).
 * Keyframes are stored locally on the item; times are in item-local time
 * (0 = item start).
 */
export function addKeyframe(
  state: TimelineState,
  params: {
    itemId: string;
    property: string;
    timeUs: number;
    value: number | [number, number, number, number];
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const localTime = quantizeUs(Math.max(0, params.timeUs), params.fps);
  const keyframes = item.keyframes ?? {};
  const existing = keyframes[params.property] ?? [];

  if (existing.some((kf) => kf.timeUs === localTime)) {
    return fail('invalid', 'A keyframe already exists at that time.');
  }

  const sorted = [...existing, { timeUs: localTime, value: params.value, interpolation: 'linear' as const }].sort((a, b) => a.timeUs - b.timeUs);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.keyframes) target.keyframes = {};
    target.keyframes[params.property] = sorted;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Keyframe added.'],
  };
}

/**
 * Remove a keyframe (SPEC 09 §17). Delete key removes the selected keyframe.
 */
export function removeKeyframe(
  state: TimelineState,
  params: { itemId: string; property: string; timeUs: number; fps: Fps },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const keyframes = item.keyframes ?? {};
  const existing = keyframes[params.property] ?? [];
  const localTime = quantizeUs(params.timeUs, params.fps);

  if (!existing.some((kf) => kf.timeUs === localTime)) {
    return fail('not_found', 'No keyframe at that time.');
  }

  const filtered = existing.filter((kf) => kf.timeUs !== localTime);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.keyframes) return;
    if (filtered.length === 0) {
      delete target.keyframes[params.property];
    } else {
      target.keyframes[params.property] = filtered;
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Keyframe removed.'],
  };
}

/**
 * Update a keyframe's value, easing, or interpolation (SPEC 09 §17).
 */
export function updateKeyframe(
  state: TimelineState,
  params: {
    itemId: string;
    property: string;
    timeUs: number;
    patch: Partial<Pick<Keyframe, 'value' | 'interpolation' | 'easing'>>;
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const keyframes = item.keyframes ?? {};
  const existing = keyframes[params.property] ?? [];
  const localTime = quantizeUs(params.timeUs, params.fps);

  const target = existing.find((kf) => kf.timeUs === localTime);
  if (!target) return fail('not_found', 'No keyframe at that time.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const itemDraft = draft.items[params.itemId] as TimelineItem;
    if (!itemDraft.keyframes) return;
    const kfList = itemDraft.keyframes[params.property];
    if (!kfList) return;
    const kf = kfList.find((candidate) => candidate.timeUs === localTime);
    if (!kf) return;
    if (params.patch.value !== undefined) kf.value = params.patch.value;
    if (params.patch.interpolation !== undefined) kf.interpolation = params.patch.interpolation;
    if (params.patch.easing !== undefined) kf.easing = params.patch.easing;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Keyframe updated.'],
  };
}

/**
 * Move a keyframe to a new local time (SPEC 09 §17). Times are quantized and
 * kept within the item's duration.
 */
export function moveKeyframe(
  state: TimelineState,
  params: {
    itemId: string;
    property: string;
    fromTimeUs: number;
    toTimeUs: number;
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const keyframes = item.keyframes ?? {};
  const existing = keyframes[params.property] ?? [];
  const fromLocal = quantizeUs(params.fromTimeUs, params.fps);
  const toLocal = quantizeUs(Math.max(0, Math.min(params.toTimeUs, item.durationUs)), params.fps);

  if (!existing.some((kf) => kf.timeUs === fromLocal)) {
    return fail('not_found', 'No keyframe at that time.');
  }

  const moved = existing.map((kf) =>
    kf.timeUs === fromLocal ? { ...kf, timeUs: toLocal } : kf,
  ).sort((a, b) => a.timeUs - b.timeUs);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.keyframes) return;
    target.keyframes[params.property] = moved;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Keyframe moved.'],
  };
}

/**
 * Duplicate a keyframe to a new local time (SPEC 09 §17).
 */
export function duplicateKeyframe(
  state: TimelineState,
  params: {
    itemId: string;
    property: string;
    fromTimeUs: number;
    toTimeUs: number;
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const keyframes = item.keyframes ?? {};
  const existing = keyframes[params.property] ?? [];
  const fromLocal = quantizeUs(params.fromTimeUs, params.fps);
  const toLocal = quantizeUs(Math.max(0, Math.min(params.toTimeUs, item.durationUs)), params.fps);

  const source = existing.find((kf) => kf.timeUs === fromLocal);
  if (!source) return fail('not_found', 'No keyframe at that time.');
  if (existing.some((kf) => kf.timeUs === toLocal)) {
    return fail('invalid', 'A keyframe already exists at the target time.');
  }

  const withCopy = [...existing, { ...source, timeUs: toLocal }].sort((a, b) => a.timeUs - b.timeUs);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.keyframes) return;
    target.keyframes[params.property] = withCopy;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Keyframe duplicated.'],
  };
}
