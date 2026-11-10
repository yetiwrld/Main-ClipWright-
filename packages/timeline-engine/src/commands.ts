// Commands: every edit is a pure function of (state, params) → new state or an
// error (SPEC 09 §2.3). Each command records immer patches so the caller can push
// one undo step per transaction (SPEC 09 §24).

import { current, enablePatches, produceWithPatches, type Patch } from 'immer';

// Undo relies on immer patches (SPEC 09 §24), so the plugin must be on before
// any command runs — including when the engine is imported by a test.
enablePatches();
import type { CompositionPayload, TimelineItem } from '@clipwright/project-schema';
import type { Keyframe } from '@clipwright/project-schema/schemas';
import type { CaptionSegment, Marker } from '@clipwright/project-schema/schemas';

/**
 * One word inside a caption segment. The schema names it `wordId` +
 * `textOverride` because the text normally lives in the transcript: a caption
 * stores *which* words it shows, not a second copy of them. `textOverride` is
 * present only when a word was edited for this caption alone.
 */
type CaptionWordRef = CaptionSegment['wordRefs'][number];
import { frameDurationUs, quantizeUs, type Fps } from './time';
import { itemEndUs, projectDurationUs, snapPoints, sortedItemsOfTrack, tracksInDrawOrder } from './selectors';
import { createCaptionItem, createIconItem, createShapeItem, createTextItem } from './factory';

/**
 * How long a new text item or shape lasts (SPEC 11 §7 — "3 s default").
 *
 * A constant rather than a parameter on every caller: the default is a product
 * decision, and three call sites computing `3_000_000` themselves is three places to
 * change it.
 */
export const DEFAULT_TEXT_DURATION_US = 3_000_000;

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

/**
 * The items that travel with `itemIds` (SPEC 09 §9.6, §9.7): link partners and group
 * members, when the composition's **Linked selection** toggle is on.
 *
 * The rule the spec states is that a detached audio item and its video share a `linkId`,
 * and with Linked selection on, moving, trimming, splitting, deleting and speed changes
 * apply to both. None of the five commands did that — each expanded only the ids it was
 * given — so detaching audio and then dragging the picture left the sound behind, which
 * is the single most common thing a user does with linked media.
 *
 * Two deliberate limits:
 *
 * - **Groups are included, links are not transitive through groups.** A group holds an
 *   explicit `itemIds` list and a link holds a shared `linkId`; expanding one then the
 *   other would make a group member's link partner travel even though the user grouped
 *   only one of them. Expansion is one pass over each relation.
 * - **A locked track stops its own item, not the whole operation.** The commands already
 *   refuse a locked source track; expanding a selection must not let a locked partner be
 *   moved silently, so partners on locked tracks are dropped here and the command's own
 *   validation sees only what it may touch.
 */
export function withLinkedSelection(
  state: TimelineState,
  itemIds: readonly string[],
): string[] {
  const result = new Set(itemIds);
  // The toggle is document state, saved with the project, so it is read here rather than
  // passed in: every caller would otherwise have to remember to forward it, and the one
  // that forgot would be a silent inconsistency.
  if (state.toggles?.linkedSelection === false) return [...result];

  for (const id of itemIds) {
    const item = state.items[id];
    if (!item) continue;

    if (item.linkId) {
      for (const candidate of Object.values(state.items)) {
        if (candidate.linkId !== item.linkId) continue;
        const track = state.tracks.find((entry) => entry.id === candidate.trackId);
        if (track?.locked) continue;
        result.add(candidate.id);
      }
    }

    if (item.groupId) {
      const group = state.groups?.find((entry) => entry.id === item.groupId);
      for (const memberId of group?.itemIds ?? []) {
        const member = state.items[memberId];
        if (!member) continue;
        const track = state.tracks.find((entry) => entry.id === member.trackId);
        if (track?.locked) continue;
        result.add(memberId);
      }
    }
  }
  return [...result];
}

export function moveItems(
  state: TimelineState,
  params: { moves: MoveTarget[]; fps: Fps; mode?: EditMode },
): CommandResult {
  const mode = params.mode ?? 'normal';
  if (!params.moves.length) return fail('invalid', 'Nothing to move.');

  /*
    Expand the selection with linked partners and group members (SPEC 09 §9.6).

    A partner moves by the **same delta** as the item it follows, never to the same
    absolute position: a detached audio item that began 200 ms later than its picture
    must still begin 200 ms later afterwards, or the sound drifts against the lip. That
    is the whole reason a link is a relationship rather than a shared timestamp.
  */
  const explicit = new Set(params.moves.map((move) => move.itemId));
  const linkedMoves: MoveTarget[] = [];
  for (const move of params.moves) {
    const item = state.items[move.itemId];
    if (!item) continue;
    const delta = move.startUs - item.startUs;
    if (delta === 0) continue;
    for (const partnerId of withLinkedSelection(state, [move.itemId])) {
      if (explicit.has(partnerId)) continue;
      const partner = state.items[partnerId];
      if (!partner) continue;
      // A partner stays on its own track: moving the picture to another video track
      // must not drag the sound onto a track it cannot live on.
      linkedMoves.push({ itemId: partnerId, startUs: Math.max(0, partner.startUs + delta) });
      explicit.add(partnerId);
    }
  }

  const moves = [...params.moves, ...linkedMoves];
  if (!moves.length) return fail('invalid', 'Nothing to move.');

  /*
    Every move in this batch is inside `movingIds`, which the ripple paths already skip —
    a linked partner or group member must not be shifted a second time as a neighbour of
    the item it is travelling with.
  */
  const movingIds = new Set(moves.map((move) => move.itemId));
  const notes: string[] = [];
  if (linkedMoves.length > 0) {
    const noun = linkedMoves.length === 1 ? 'item' : 'items';
    notes.push(`Moved ${linkedMoves.length} linked ${noun} with it.`);
  }

  // Validate everything before mutating so a refusal leaves the state untouched.
  for (const move of moves) {
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
    for (const move of moves) {
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
      /*
        Every move in this batch, not only the ones the caller named: a linked partner is
        moved by this command too, so `closeMainGaps` must skip it. Leaving it out was a
        real bug — a group member sharing the main track was moved to 7 s and then pulled
        back to 6 s by the gap-closing pass, which looked like the link simply not working.
      */
      const movedFromMain = moves
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

  // Linked partners trim with the same edge (SPEC 09 §9.6). Computed from the state
  // before mutation so it is the same set the rest of the command works against.
  const linkedPartners = withLinkedSelection(state, [params.itemId]).filter(
    (id) => id !== params.itemId,
  );

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

    /*
      Trim linked partners with the same edge by the same delta (SPEC 09 §9.6). The
      partner's own clamps are honoured — `trimGeometry` is asked rather than the result
      being forced — so a detached audio item at the end of its source cannot be dragged
      past it just because the picture had room.
    */
    if (linkedPartners.length > 0) {
      const appliedDelta = params.edge === 'start' ? finalStart - item.startUs : 0;
      for (const partnerId of linkedPartners) {
        const partner = draft.items[partnerId] as TimelineItem | undefined;
        if (!partner) continue;
        const partnerTrack = draft.tracks.find((candidate) => candidate.id === partner.trackId);
        if (partnerTrack?.locked) continue;
        /*
          The partner's new edge is its *own* edge plus the delta the picture's edge
          moved by — not the picture's new edge. Using the picture's end directly made a
          partner that started elsewhere collapse onto it, and then `trimGeometry` clamped
          it to one frame: a sound that shrank to nothing while the picture looked right.
        */
        const endDelta = nextStart + nextDuration - itemEndUs(item);
        const wanted =
          params.edge === 'start' ? partner.startUs + appliedDelta : itemEndUs(partner) + endDelta;
        const geometry = trimGeometry(
          draft as TimelineState,
          partner,
          params.edge,
          wanted,
          params.fps,
          new Set([partnerId]),
        );
        partner.startUs = geometry.nextStart;
        partner.durationUs = geometry.nextDuration;
        sortTrackItems(draft, partner.trackId);
      }
    }

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

  /*
    Split a linked pair together (SPEC 09 §9.6). Splitting only the picture leaves the
    sound as one long item under two short ones, and the audio then has no frame boundary
    to follow at all — the timeline is legal, but nothing lines up any more.
  */
  const splitIds =
    params.itemIds && params.itemIds.length
      ? new Set(withLinkedSelection(state, params.itemIds))
      : undefined;

  const targets = Object.values(state.items).filter((item) => {
    if (splitIds && !splitIds.has(item.id)) return false;
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

  /*
    Deleting a picture deletes its detached sound (SPEC 09 §9.6). Without this the most
    ordinary action in the editor — select a clip, press Delete — leaves an audio item
    playing over black, which sounds like a bug in playback rather than a stray clip.
  */
  const deleteIds = withLinkedSelection(state, params.itemIds);

  for (const id of deleteIds) {
    const item = state.items[id];
    if (!item) continue;
    const track = state.tracks.find((candidate) => candidate.id === item.trackId);
    if (track?.locked) return fail('locked', `“${track.name}” is locked.`);
  }

  const removedOnMain = deleteIds.some((id) => {
    const item = state.items[id];
    return item && state.tracks.find((track) => track.id === item.trackId)?.role === 'main';
  });

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of deleteIds) {
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
        ...deleteIds.map((id) => state.items[id]?.startUs ?? 0),
      );
      closeMainGaps(draft, params.fps, minStart);
    }
  });

  return { ok: true, state: nextState, patches, inverse, affectedItemIds: deleteIds, notes: [] };
}

/** Duplicate: the copy lands immediately after the original on the same track. */
export function duplicateItems(
  state: TimelineState,
  params: { itemIds: string[]; fps: Fps },
): CommandResult {
  if (!params.itemIds.length) return fail('invalid', 'Nothing is selected.');
  const copies: string[] = [];

  /*
    Duplicate the whole linked set (SPEC 09 §9.6). A copy of the picture without a copy
    of its sound is a clip that plays silently next to one that does not, and the pair
    is re-linked so the copy behaves like the original.
  */
  const duplicateIds = withLinkedSelection(state, params.itemIds);
  const duplicateSet = new Set(duplicateIds);
  /*
    One new link id per *original* link, shared by every copy that belonged to it — not
    one per copy. Giving each copy its own id would leave the duplicated pair unlinked
    from each other, so dragging the copy of the picture would leave the copy of the
    sound behind: the same bug, reintroduced on the copy.
  */
  const newLinkIds = new Map<string, string>();

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of duplicateIds) {
      const item = draft.items[id] as TimelineItem | undefined;
      if (!item) continue;
      const track = draft.tracks.find((candidate) => candidate.id === item.trackId);
      if (!track || track.locked) continue;
      const existing = sortedItemsOfTrack(draft as TimelineState, item.trackId).filter(
        (candidate) => !duplicateSet.has(candidate.id),
      );
      const startUs = quantizeUs(itemEndUs(item), params.fps);
      if (overlapsAny(existing, startUs, item.durationUs)) continue;
      const copyId = `${item.id}~copy${copies.length}`;
      draft.items[copyId] = { ...copyDraft(item), id: copyId, startUs };
      /*
        A copied pair shares a fresh link, not the original's: leaving the old `linkId`
        on the copy would make dragging the copy also drag the original.
      */
      if (item.linkId) {
        const existingLink = newLinkIds.get(item.linkId);
        const copyLink = existingLink ?? `link-${item.linkId}-copy${copies.length}`;
        if (!existingLink) newLinkIds.set(item.linkId, copyLink);
        draft.items[copyId]!.linkId = copyLink;
      }
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

/**
 * Add an adjustment layer above the tracks it should grade (SPEC 12 §3.1).
 *
 * An adjustment layer has no media and no picture: its only content is an effect
 * chain, which grades whatever is composited below it while it is on screen. The
 * command creates the track as well as the item, because an adjustment layer that
 * shares a track with clips would be ambiguous — a track holds one kind of content.
 *
 * It is placed on a new track of kind `effect`, immediately above `aboveTrackId`
 * (or on top of the stack). Placing it on top by default is the intent: a user who
 * asks for an adjustment layer wants to grade what is already there, and a layer
 * underneath everything would appear to do nothing.
 */
export function addAdjustmentLayer(
  state: TimelineState,
  params: {
    id: string;
    /** Timeline position and length; the whole visible range by default. */
    startUs: number;
    durationUs: number;
    fps: Fps;
    /** Track to sit above. Defaults to the topmost picture track, else the top. */
    aboveTrackId?: string;
    /** Chain to start with; usually a single effect added from the inspector. */
    effects?: TimelineItem['effects'];
  },
): CommandResult & { trackId?: string } {
  if (state.items[params.id]) return fail('invalid', 'That item already exists.');
  if (params.durationUs < frameDurationUs(params.fps)) {
    return fail('too_short', 'An adjustment layer must be at least one frame long.');
  }
  const startUs = quantizeUs(params.startUs, params.fps);

  /*
    Above the highest picture track by default. Ordering by `order` rather than by
    array position matters: the array order is presentation, `order` is what the
    compositor sorts by, and an adjustment layer inserted between them in the wrong
    one would grade nothing.
  */
  const pictureTracks = state.tracks.filter((track) => track.kind === 'video');
  const reference =
    state.tracks.find((track) => track.id === params.aboveTrackId) ??
    pictureTracks.reduce<typeof pictureTracks[number] | undefined>(
      (top, track) => (top === undefined || track.order > top.order ? track : top),
      undefined,
    );

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    // Everything at or above the reference moves up one, so the new layer can take
    // the reference's place and grade it rather than sit under it.
    const referenceOrder = reference?.order ?? draft.tracks.length - 1;
    for (const track of draft.tracks) {
      if (track.order > referenceOrder) track.order += 1;
    }
    const newOrder = referenceOrder + 1;
    const trackId = `trk_adj_${params.id}`;
    draft.tracks.push({
      id: trackId,
      role: 'adjustment',
      kind: 'effect',
      name: 'Adjustment',
      order: newOrder,
      hidden: false,
      locked: false,
      muted: false,
      solo: false,
      heightPx: 48,
      itemIds: [params.id],
      auto: false,
    } as (typeof draft.tracks)[number]);
    draft.items[params.id] = {
      id: params.id,
      trackId,
      type: 'adjustment',
      startUs,
      durationUs: params.durationUs,
      sourceInUs: 0,
      effects: params.effects ?? [],
    } as TimelineItem;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.id],
    notes: ['Adjustment layer added — it grades the tracks below it.'],
    trackId: `trk_adj_${params.id}`,
  };
}


/**
 * Add a text item, creating a text track for it when there is not one (SPEC 11 §7).
 *
 * Like an adjustment layer, this creates its own track: a text item cannot live on a
 * picture track (`canHold` refuses it), and a user pressing "Add text" has not asked
 * to manage tracks first. An existing text track is reused when it has room, because
 * otherwise every title would stack a new row and the timeline would grow sideways
 * while the canvas showed one line of type.
 *
 * Reusing a track means *finding* one with room rather than picking the first: a text
 * track already carrying a title for the same moment would refuse the item, and the
 * fallback path in `addItem` only searches within the same track kind.
 */
export function addTextItem(
  state: TimelineState,
  params: {
    id: string;
    text: string;
    startUs: number;
    durationUs?: number;
    fps: Fps;
    styleId?: string;
    /** A track to try first; the command still creates one rather than failing. */
    trackId?: string;
  },
): CommandResult & { trackId?: string } {
  if (state.items[params.id]) return fail('invalid', 'That item already exists.');
  const durationUs = params.durationUs ?? DEFAULT_TEXT_DURATION_US;
  if (durationUs < frameDurationUs(params.fps)) {
    return fail('too_short', 'A text item must be at least one frame long.');
  }
  const startUs = quantizeUs(params.startUs, params.fps);

  // A text track with a gap at this moment, preferring the one the user named.
  const named = state.tracks.find((track) => track.id === params.trackId && track.kind === 'text');
  const candidates = [
    ...(named ? [named] : []),
    ...state.tracks.filter((track) => track.kind === 'text' && track.id !== named?.id),
  ];
  const free = candidates.find(
    (track) =>
      !track.locked &&
      !overlapsAny(sortedItemsOfTrack(state, track.id), startUs, durationUs),
  );

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    let trackId = free?.id;
    if (!trackId) {
      // Above every existing track, so a new title is drawn over the footage rather
      // than behind it — an invisible text item is the worst possible first result.
      const topOrder = draft.tracks.reduce((top, track) => Math.max(top, track.order), -1);
      trackId = `trk_text_${params.id}`;
      draft.tracks.push({
        id: trackId,
        role: 'text',
        kind: 'text',
        name: 'Text',
        order: topOrder + 1,
        hidden: false,
        locked: false,
        muted: false,
        solo: false,
        heightPx: 48,
        itemIds: [],
        auto: false,
      } as (typeof draft.tracks)[number]);
    }
    const item = createTextItem({
      id: params.id,
      trackId,
      startUs,
      durationUs,
      text: params.text,
      styleId: params.styleId,
    });
    draft.items[item.id] = item;
    addToTrack(draft, trackId, item.id);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.id],
    notes: free ? ['Text added.'] : ['Text added on a new text track.'],
    trackId: nextState.items[params.id]?.trackId,
  };
}

/**
 * Add a shape item, on a graphics track of its own (SPEC 11 §12).
 *
 * Shapes go on `text` tracks rather than a separate kind: the schema's track kinds are
 * video/audio/caption/text/effect, and a graphics track would be a sixth kind that the
 * compositor does not need — a shape and a title draw in the same way and the same
 * order. `canHold` already permits it.
 */
export function addShapeItem(
  state: TimelineState,
  params: {
    id: string;
    /**
     * A built-in kind, or — when `iconName` is given instead — omitted.
     *
     * Union rather than two more optional fields, so the command cannot be called with
     * neither and produce an item that draws nothing. An icon item has no `shapeKind`: its
     * geometry comes from the icon library (SPEC 11 §12).
     */
    shapeKind?: NonNullable<TimelineItem['shapeKind']>;
    /** A Lucide icon name; mutually exclusive with `shapeKind`. */
    iconName?: string;
    /** The icon's children, when the file should carry its own copy. */
    iconShapes?: TimelineItem['iconShapes'];
    /** Outline thickness in the 100-box, 0.5–4. Absent means the library default. */
    iconStrokeWidth?: number;
    startUs: number;
    durationUs?: number;
    fps: Fps;
    styleId?: string;
    trackId?: string;
  },
): CommandResult & { trackId?: string } {
  if (state.items[params.id]) return fail('invalid', 'That item already exists.');
  const isIcon = params.iconName !== undefined;
  if (isIcon === (params.shapeKind !== undefined)) {
    /*
      Refused rather than resolved by precedence. An item with both would leave two
      renderers free to disagree about which wins, and an item with neither is an item
      that draws nothing — the silent failure this whole feature is built to avoid.
    */
    return fail('invalid', 'Give either a shape kind or an icon name.');
  }
  const durationUs = params.durationUs ?? DEFAULT_TEXT_DURATION_US;
  if (durationUs < frameDurationUs(params.fps)) {
    return fail('too_short', 'A shape must be at least one frame long.');
  }
  const startUs = quantizeUs(params.startUs, params.fps);

  const named = state.tracks.find((track) => track.id === params.trackId && track.kind === 'text');
  const candidates = [
    ...(named ? [named] : []),
    ...state.tracks.filter((track) => track.kind === 'text' && track.id !== named?.id),
  ];
  const free = candidates.find(
    (track) =>
      !track.locked &&
      !overlapsAny(sortedItemsOfTrack(state, track.id), startUs, durationUs),
  );

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    let trackId = free?.id;
    if (!trackId) {
      const topOrder = draft.tracks.reduce((top, track) => Math.max(top, track.order), -1);
      trackId = `trk_gfx_${params.id}`;
      draft.tracks.push({
        id: trackId,
        role: 'graphics',
        kind: 'text',
        name: 'Graphics',
        order: topOrder + 1,
        hidden: false,
        locked: false,
        muted: false,
        solo: false,
        heightPx: 48,
        itemIds: [],
        auto: false,
      } as (typeof draft.tracks)[number]);
    }
    const item = isIcon
      ? createIconItem({
          id: params.id,
          trackId,
          startUs,
          durationUs,
          iconName: params.iconName!,
          ...(params.iconShapes ? { iconShapes: params.iconShapes } : {}),
          ...(params.iconStrokeWidth !== undefined
            ? { iconStrokeWidth: params.iconStrokeWidth }
            : {}),
          styleId: params.styleId,
        })
      : createShapeItem({
          id: params.id,
          trackId,
          startUs,
          durationUs,
          shapeKind: params.shapeKind!,
          styleId: params.styleId,
        });
    draft.items[item.id] = item;
    addToTrack(draft, trackId, item.id);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.id],
    notes: free ? ['Shape added.'] : ['Shape added on a new graphics track.'],
    trackId: nextState.items[params.id]?.trackId,
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

/**
 * Places a user composition guide (SPEC 10 §8.8).
 *
 * A command rather than a direct write, because a guide is document state: it travels
 * with the project, so placing one must be undoable like any other edit. The near-
 * duplicate rule lives in the renderer's `addGuide`, which the caller applies to the
 * current list before asking for this — the command does not need to know about it.
 */
export function addGuide(
  state: TimelineState,
  params: { id: string; axis: 'x' | 'y'; at: number },
): CommandResult {
  if (!Number.isFinite(params.at)) return fail('invalid', 'That position is not a number.');
  const at = Math.min(1, Math.max(0, params.at));
  return setGuides(state, {
    guides: [...state.guides, { id: params.id, axis: params.axis, at, locked: false }],
  });
}

/**
 * Replaces the whole guide list (SPEC 10 §8.8).
 *
 * The renderer needs this rather than `addGuide` alone: its near-duplicate rule replaces
 * a guide that is practically on top of the new one, which is a *filter of the existing
 * list* and not an append. Passing the finished list keeps that rule in one place — the
 * pure `addGuide` in `user-guides.ts` — instead of splitting it between the command and
 * its caller.
 */
export function setGuides(
  state: TimelineState,
  params: { guides: TimelineState['guides'] },
): CommandResult {
  const guides = params.guides
    .filter((guide) => Number.isFinite(guide.at))
    .map((guide) => ({
      ...guide,
      at: Math.min(1, Math.max(0, guide.at)),
    }));
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.guides = guides;
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/** Removes a user composition guide (SPEC 10 §8.8). */
export function removeGuide(state: TimelineState, params: { id: string }): CommandResult {
  if (!state.guides.some((guide) => guide.id === params.id)) {
    return fail('not_found', 'That guide is already gone.');
  }
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.guides = draft.guides.filter((guide) => guide.id !== params.id);
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/**
 * Locks or unlocks every guide (SPEC 10 §8.8's Guides menu: *Lock*).
 *
 * Whole-set rather than per-guide because that is what the menu item is: one control that
 * makes the guides stop being removable, and stops them being removed. A per-guide lock
 * would need a click target on a hairline, which is the thing the removal gesture's
 * generous reach exists to avoid.
 */
export function setGuidesLocked(
  state: TimelineState,
  params: { locked: boolean },
): CommandResult {
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.guides = draft.guides.map((guide) => ({ ...guide, locked: params.locked }));
  });
  return { ok: true, state: nextState, patches, inverse, affectedItemIds: [], notes: [] };
}

/**
 * Removes every *unlocked* guide (SPEC 10 §8.8's Guides menu: *Clear*).
 *
 * Locked guides survive, so *Lock* is a real safety net rather than a label. If every guide
 * is locked the command fails rather than silently doing nothing, so the menu can say why.
 */
export function clearGuides(state: TimelineState): CommandResult {
  const unlocked = state.guides.filter((guide) => !guide.locked);
  if (state.guides.length > 0 && unlocked.length === 0) {
    return fail('locked', 'Every guide is locked. Unlock them first.');
  }
  if (state.guides.length === 0) return fail('not_found', 'There are no guides to clear.');
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.guides = draft.guides.filter((guide) => guide.locked);
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
    patch: Partial<
      Pick<NonNullable<TimelineItem['transitionIn']>, 'durationUs' | 'alignment' | 'type'>
    > & {
      /**
       * Type-specific parameters (SPEC 12 §4.2): a wipe's `direction` and
       * `softness`, a dissolve's `grain`, a dip's `color`, a slide's `mode`, a
       * zoom's `amount`.
       *
       * Merged into the existing params rather than replacing them, so changing a
       * wipe's direction does not silently reset its softness. A key set to
       * `undefined` is removed.
       */
      params?: Record<string, number | boolean | string | undefined>;
    };
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
    if (params.patch.params) {
      const merged = { ...(target.transitionIn.params ?? {}) };
      for (const [key, value] of Object.entries(params.patch.params)) {
        // `undefined` means "remove", which is how a control clears an override and
        // falls back to the type's default — distinct from storing the default.
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      target.transitionIn.params = merged;
    }
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
 * Write several keyframes at one instant as **one** undo step (SPEC 10 §8.6, §13).
 *
 * `addKeyframe` and `updateKeyframe` each commit on their own, which is right for a single
 * diamond and wrong for anything that writes a *point*. The Crop tool's reframe is exactly
 * that case: a framing is a position and a scale, and four separate commands would leave the
 * undo stack with four entries for one gesture — so `Ctrl+Z` after setting a framing would undo
 * a quarter of it, and the picture would land on a state the user never chose.
 *
 * Existing keys at the instant are *replaced* rather than refused, which is the other
 * difference from `addKeyframe`. Setting the framing for a moment the user has already framed
 * is a correction, not an error, and refusing it would make the second attempt at a framing a
 * dead button.
 *
 * Interpolation is carried over from the key being replaced when there is one, so a curve the
 * user shaped on a bias keyframe is not silently flattened to linear by re-framing that moment.
 */
export function setKeyframesAt(
  state: TimelineState,
  params: {
    itemId: string;
    timeUs: number;
    /** Property path to value, all written at the same instant. */
    values: Readonly<Record<string, number>>;
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const paths = Object.keys(params.values);
  if (paths.length === 0) return fail('invalid', 'There is nothing to write.');
  // Quantised once, outside the loop: two paths quantised separately would still agree, but
  // doing it per path invites a later edit that computes the instant from something that drifts.
  const localTime = quantizeUs(Math.max(0, params.timeUs), params.fps);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.keyframes) target.keyframes = {};
    for (const path of paths) {
      const existing = target.keyframes[path] ?? [];
      const previous = existing.find((kf) => kf.timeUs === localTime);
      const entry = {
        timeUs: localTime,
        value: params.values[path]!,
        interpolation: previous?.interpolation ?? ('linear' as const),
      };
      target.keyframes[path] = [
        ...existing.filter((kf) => kf.timeUs !== localTime),
        entry,
      ].sort((a, b) => a.timeUs - b.timeUs);
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Keyframes set.'],
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
 * Set the bezier control handles on a keyframe (SPEC 12 §2.6).
 *
 * `bezier` describes the curve *leaving* this key, in the same cubic-bezier form
 * CSS uses: the two control points are `(outX, outY)` and `(inX, inY)`, with x in
 * 0–1 measured across the segment and y free to overshoot. Because a key's
 * interpolation decides how its segment is evaluated, setting handles also sets
 * `interpolation` to `'bezier'` — storing handles on a `linear` key would leave
 * them ignored by the evaluator and make the edit appear to do nothing.
 *
 * x is clamped into the unit interval and y is not, which is what §2.6 asks for:
 * a handle dragged before its own key would make the curve non-monotonic in time,
 * so `evaluate` could not answer "what is the value now" without picking a branch.
 */
export function setBezierHandles(
  state: TimelineState,
  params: {
    itemId: string;
    property: string;
    timeUs: number;
    bezier: { outX: number; outY: number; inX: number; inY: number };
    fps: Fps;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const localTime = quantizeUs(params.timeUs, params.fps);
  const existing = item.keyframes?.[params.property] ?? [];
  if (!existing.some((keyframe) => keyframe.timeUs === localTime)) {
    return fail('not_found', 'No keyframe at that time.');
  }

  /*
    Clamp rather than reject. A user dragging a handle past its neighbour's time is
    making a shape the model has no room for, and snapping the handle to the end of
    the segment gives the shape they were reaching for; refusing the drag would
    leave the handle stuck mid-gesture.
  */
  const clampX = (value: number) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const finiteOr = (value: number, fallback: number) =>
    Number.isFinite(value) ? value : fallback;
  const bezier = {
    outX: clampX(params.bezier.outX),
    outY: finiteOr(params.bezier.outY, 0),
    inX: clampX(params.bezier.inX),
    inY: finiteOr(params.bezier.inY, 1),
  };

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const kfList = (draft.items[params.itemId] as TimelineItem).keyframes?.[params.property];
    if (!kfList) return;
    const keyframe = kfList.find((candidate) => candidate.timeUs === localTime);
    if (!keyframe) return;
    keyframe.bezier = bezier;
    keyframe.interpolation = 'bezier';
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Curve updated.'],
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
/**
 * Find the nearest word boundary in a caption segment (SPEC 09 §20).
 * Returns the timeUs of the word boundary closest to the target time,
 * or the segment start/end if no boundary is closer.
 */
function nearestWordBoundary(
  segment: { startUs: number; endUs: number; wordRefs: Array<{ startUs: number; endUs: number }> },
  targetUs: number,
): number {
  if (segment.wordRefs.length === 0) return targetUs;
  let best = segment.startUs;
  let bestDist = Math.abs(segment.startUs - targetUs);
  for (const word of segment.wordRefs) {
    const dist = Math.abs(word.startUs - targetUs);
    if (dist < bestDist) {
      bestDist = dist;
      best = word.startUs;
    }
  }
  return best;
}

/**
 * Split a caption segment at the nearest word boundary to the playhead
 * (SPEC 09 §20). The right half gets a new id. Words outside the new
 * range are removed from each half.
 */
export function splitCaptionSegment(
  state: TimelineState,
  params: { itemId: string; timeUs: number; fps: Fps },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (item.type !== 'caption') return fail('invalid', 'Only caption items can be split at word boundaries.');
  if (!item.captionSegment) return fail('invalid', 'That caption item has no segment.');

  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const segment = item.captionSegment;
  const splitUs = nearestWordBoundary(segment, params.timeUs);
  if (splitUs <= segment.startUs || splitUs >= segment.endUs) {
    return fail('invalid', 'The playhead is outside the caption segment.');
  }

  const leftWords = segment.wordRefs.filter((w) => w.endUs <= splitUs);
  const rightWords = segment.wordRefs.filter((w) => w.startUs >= splitUs);

  // Each half's fallback is the slice of the original text its words cover, so a
  // caption with no overrides still splits into real text.
  const originalWords = segment.text.split(/\s+/).filter(Boolean);
  const leftFallback = originalWords.slice(0, leftWords.length).join(' ');
  const rightFallback = originalWords.slice(leftWords.length).join(' ');
  const leftText = captionTextFrom(leftWords, leftFallback);
  const rightText = captionTextFrom(rightWords, rightFallback);

  const newId = `cap-${Date.now()}`;

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const rightItem = {
      ...copyPlain(item),
      id: newId,
      startUs: splitUs,
      durationUs: item.durationUs - (splitUs - item.startUs),
      captionSegment: {
        ...segment,
        id: newId,
        wordRefs: rightWords,
        startUs: splitUs,
        text: rightText,
      },
    } as TimelineItem;
    draft.items[newId] = rightItem;
    addToTrack(draft, item.trackId, newId);

    const leftTarget = draft.items[params.itemId] as TimelineItem;
    leftTarget.durationUs = splitUs - item.startUs;
    if (leftTarget.captionSegment) {
      leftTarget.captionSegment.wordRefs = leftWords;
      leftTarget.captionSegment.text = leftText;
      leftTarget.captionSegment.endUs = splitUs;
    }
    sortTrackItems(draft, item.trackId);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId, newId],
    notes: ['Caption split at word boundary.'],
  };
}

/**
 * Merge two adjacent caption segments on the same track (SPEC 09 §20,
 * Ctrl+J). The right segment is removed and its words are appended to
 * the left segment.
 */
export function mergeCaptionSegments(
  state: TimelineState,
  params: { leftItemId: string; rightItemId: string; fps: Fps },
): CommandResult {
  const left = state.items[params.leftItemId];
  const right = state.items[params.rightItemId];
  if (!left || !right) return fail('not_found', 'That item no longer exists.');
  if (left.type !== 'caption' || right.type !== 'caption') return fail('invalid', 'Only caption items can be merged.');
  if (!left.captionSegment || !right.captionSegment) return fail('invalid', 'That caption item has no segment.');
  if (left.trackId !== right.trackId) return fail('invalid', 'Caption segments must be on the same track.');

  const track = state.tracks.find((candidate) => candidate.id === left.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const leftEnd = itemEndUs(left);
  if (Math.abs(leftEnd - right.startUs) > frameDurationUs(params.fps)) {
    return fail('invalid', 'Those caption segments are not adjacent.');
  }

  const leftSeg = left.captionSegment;
  const rightSeg = right.captionSegment;
  if (!leftSeg || !rightSeg) return fail('invalid', 'That caption item has no segment.');
  const mergedWords = [...leftSeg.wordRefs, ...rightSeg.wordRefs];
  const mergedText = captionTextFrom(mergedWords, `${leftSeg.text} ${rightSeg.text}`.trim());
  const rightEndUs = rightSeg.endUs;

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const leftTarget = draft.items[params.leftItemId] as TimelineItem;
    if (leftTarget.captionSegment) {
      leftTarget.captionSegment.wordRefs = mergedWords;
      leftTarget.captionSegment.text = mergedText;
      leftTarget.captionSegment.endUs = rightEndUs;
    }
    leftTarget.durationUs = rightEndUs - leftTarget.startUs;
    delete draft.items[params.rightItemId];
    removeFromTrack(draft, left.trackId, params.rightItemId);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.leftItemId],
    notes: ['Caption segments merged.'],
  };
}

/**
 * Trim a caption segment, snapping to word boundaries (SPEC 09 §20).
 * Words outside the new range are removed from this segment only.
 */
export function trimCaptionSegment(
  state: TimelineState,
  params: { itemId: string; edge: 'start' | 'end'; timeUs: number; fps: Fps },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (item.type !== 'caption') return fail('invalid', 'Only caption items can be trimmed at word boundaries.');
  if (!item.captionSegment) return fail('invalid', 'That caption item has no segment.');

  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const segment = item.captionSegment;
  const minDuration = frameDurationUs(params.fps);

  if (params.edge === 'start') {
    const snapUs = nearestWordBoundary(segment, params.timeUs);
    const newStart = Math.max(item.startUs, Math.min(snapUs, itemEndUs(item) - minDuration));
    if (newStart === item.startUs) return fail('invalid', 'The trim did not change the start.');

    const remainingWords = segment.wordRefs.filter((w) => w.endUs > newStart);
    const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
      const target = draft.items[params.itemId] as TimelineItem;
      target.startUs = newStart;
      target.durationUs = itemEndUs(item) - newStart;
      if (target.captionSegment) {
        target.captionSegment.wordRefs = remainingWords;
        target.captionSegment.startUs = newStart;
        const remainingText = captionTextFrom(remainingWords, '', segment.text);
        target.captionSegment.text = remainingText;
      }
      sortTrackItems(draft, item.trackId);
    });
    return { ok: true, state: nextState, patches, inverse, affectedItemIds: [params.itemId], notes: ['Caption trimmed at word boundary.'] };
  } else {
    const snapUs = nearestWordBoundary(segment, params.timeUs);
    const itemEnd = itemEndUs(item);
    const newEnd = Math.min(itemEnd, Math.max(snapUs, item.startUs + minDuration));
    if (newEnd === itemEnd) return fail('invalid', 'The trim did not change the end.');

    const remainingWords = segment.wordRefs.filter((w) => w.startUs < newEnd);
    const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
      const target = draft.items[params.itemId] as TimelineItem;
      target.durationUs = newEnd - item.startUs;
      if (target.captionSegment) {
        target.captionSegment.wordRefs = remainingWords;
        target.captionSegment.endUs = newEnd;
        const remainingText = captionTextFrom(remainingWords, '', segment.text);
        target.captionSegment.text = remainingText;
      }
      sortTrackItems(draft, item.trackId);
    });
    return { ok: true, state: nextState, patches, inverse, affectedItemIds: [params.itemId], notes: ['Caption trimmed at word boundary.'] };
  }
}
/**
 * Apply an effect to an item (SPEC 09 §15.5, §17). Effects are stored on
 * the item's `effects` array as EffectInstance {id, effectId, enabled, params}.
 */
export function applyEffect(
  state: TimelineState,
  params: {
    itemId: string;
    effectId: string;
    params?: Record<string, number | boolean | string>;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const existing = item.effects ?? [];
  if (existing.some((e) => e.effectId === params.effectId)) {
    return fail('invalid', 'That effect is already applied.');
  }

  const instance = {
    id: `eff-${Date.now()}`,
    effectId: params.effectId,
    enabled: true,
    params: params.params ?? {},
  };

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.effects) target.effects = [];
    target.effects.push(instance);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Effect applied.'],
  };
}

/**
 * Remove an effect from an item (SPEC 09 §21 — context menu 'Replace
 * transition · Delete' and effects panel remove button).
 */
/**
 * Move an effect within an item's chain (SPEC 09 §17, SPEC 12 §3.1).
 *
 * Chain order matters — `blur → contrast` is not `contrast → blur` — and the spec's
 * acceptance list requires the chain to be "reorderable". Without this command the
 * order was whatever order effects happened to be added in, with no way to change it
 * short of removing and re-adding each one.
 */
export function moveEffect(
  state: TimelineState,
  params: { itemId: string; effectId: string; toIndex: number },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const existing = item.effects ?? [];
  const fromIndex = existing.findIndex((effect) => effect.effectId === params.effectId);
  if (fromIndex === -1) return fail('not_found', 'That effect is not applied.');
  if (!Number.isInteger(params.toIndex) || params.toIndex < 0 || params.toIndex >= existing.length) {
    return fail('invalid', 'That position is not in the effect chain.');
  }
  if (fromIndex === params.toIndex) {
    return fail('invalid', 'The effect is already in that position.');
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.effects) return;
    const [moved] = target.effects.splice(fromIndex, 1);
    if (moved) target.effects.splice(params.toIndex, 0, moved);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Effect moved.'],
  };
}

/**
 * Replace an item's effect chain wholesale (SPEC 09 §12, SPEC 12 §3).
 *
 * This is the paste half of "copy effects / paste effects": the copied chain is a
 * value, so pasting is an ordinary assignment rather than a re-application of each
 * effect. Fresh instance ids are minted so the pasted chain is not tied to the
 * source item — two clips must be able to hold equivalent chains and then diverge.
 */
export function setEffectChain(
  state: TimelineState,
  params: {
    itemId: string;
    chain: ReadonlyArray<{
      effectId: string;
      enabled?: boolean;
      params?: Record<string, number | boolean | string>;
    }>;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const chain = params.chain.map((effect, index) => ({
    id: `${params.itemId}~fx${index}_${effect.effectId}`,
    effectId: effect.effectId,
    enabled: effect.enabled ?? true,
    params: { ...(effect.params ?? {}) },
  }));

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    target.effects = chain;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: [chain.length === 0 ? 'Effects cleared.' : 'Effects pasted.'],
  };
}

export function removeEffect(
  state: TimelineState,
  params: { itemId: string; effectId: string },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const existing = item.effects ?? [];
  if (!existing.some((e) => e.effectId === params.effectId)) {
    return fail('not_found', 'That effect is not applied.');
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.effects) return;
    target.effects = target.effects.filter((e) => e.effectId !== params.effectId);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Effect removed.'],
  };
}

/**
 * Toggle an effect's enabled state (SPEC 09 §17 — effects panel toggle).
 */
export function toggleEffectEnabled(
  state: TimelineState,
  params: { itemId: string; effectId: string },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const existing = item.effects ?? [];
  const instance = existing.find((e) => e.effectId === params.effectId);
  if (!instance) return fail('not_found', 'That effect is not applied.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.effects) return;
    const eff = target.effects.find((e) => e.effectId === params.effectId);
    if (eff) eff.enabled = !eff.enabled;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Effect toggled.'],
  };
}

/**
 * Update an effect's params (SPEC 09 §17 — inspector effect params).
 */
export function updateEffectParams(
  state: TimelineState,
  params: {
    itemId: string;
    effectId: string;
    params: Record<string, number | boolean | string>;
  },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');

  const existing = item.effects ?? [];
  const instance = existing.find((e) => e.effectId === params.effectId);
  if (!instance) return fail('not_found', 'That effect is not applied.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId] as TimelineItem;
    if (!target.effects) return;
    const eff = target.effects.find((e) => e.effectId === params.effectId);
    if (eff) eff.params = { ...eff.params, ...params.params };
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Effect params updated.'],
  };
}
/**
 * SPEC 09 §17, SPEC 12 §6.2 — edit the properties the inspector shows.
 *
 * Opacity, volume, gain, pan, speed, blend mode, fades, crop and transform all live
 * on the item, and until this command existed none of them could be changed: the
 * inspector showed volume disabled and the rest not at all. A property with no
 * command is a property the file format supports and the app cannot reach.
 *
 * One command rather than fourteen, because they share every piece of machinery —
 * track locking, the patch pair, the clamp — and separate commands would drift on
 * the first one that forgot the lock check.
 *
 * Values are validated here rather than trusted from the caller, because the
 * inspector's slider can be dragged and a bad value reaching the file is worse than
 * a rejected edit: the schema would refuse on load, and the user would lose the
 * whole composition instead of one gesture.
 */
export function setItemProperties(
  state: TimelineState,
  params: {
    itemIds: string[];
    patch: {
      opacity?: number;
      volumeDb?: number;
      gainDb?: number;
      pan?: number;
      speed?: number;
      muted?: boolean;
      blendMode?: TimelineItem['blendMode'];
      fadeInUs?: number;
      fadeOutUs?: number;
      fadeCurve?: TimelineItem['fadeCurve'];
      crop?: Partial<TimelineItem['crop']>;
      transform?: Partial<TimelineItem['transform']>;
      /**
       * A shape item's kind (SPEC 11 §12). Editing it is how a rectangle becomes a star
       * after it was added, rather than deleting and re-adding.
       */
      shapeKind?: NonNullable<TimelineItem['shapeKind']>;
      /**
       * An icon's outline thickness, 0.5–4 in the 100-box (SPEC 11 §12).
       *
       * Added because the picker could set it and nothing else could: a user who wanted a
       * heavier star had to delete the icon and add it again with the field already at the
       * value they wanted. The value was stored, drawn and exported; only editing was
       * missing.
       */
      iconStrokeWidth?: number;
      /**
       * Which icon an existing item draws (SPEC 11 §12).
       *
       * The last piece of the same gap: the picker was an "add" flow, so changing a star
       * into a heart meant deleting the item and losing its timing. `iconShapes` is cleared
       * on the way through — stored geometry belongs to the icon it was stored for, and
       * keeping it would leave the item drawing the old icon from its own copy while the
       * name said otherwise.
       */
      iconName?: string;
      /**
       * Noise reduction for this item (SPEC 12 §6.8).
       *
       * `null` clears it — that is *Revert*, and it is a command like any other, so it is undoable
       * and appears in the history the way a user expects an edit to. The original audio was never
       * written to, so clearing this field is the whole of the revert: there is no file to restore.
       */
      noiseReduction?: TimelineItem['noiseReduction'] | null;
    };
    fps: Fps;
  },
): CommandResult {
  const targets = params.itemIds.filter((id) => state.items[id]);
  if (targets.length === 0) return fail('not_found', 'No clips were selected.');

  const lockedTrack = state.tracks.find(
    (track) => track.locked && targets.some((id) => state.items[id]!.trackId === track.id),
  );
  if (lockedTrack) return fail('locked', `"${lockedTrack.name}" is locked.`);

  const { patch } = params;

  if (patch.opacity !== undefined && (patch.opacity < 0 || patch.opacity > 1)) {
    return fail('invalid', 'Opacity must be between 0 and 100%.');
  }
  if (patch.volumeDb !== undefined && (patch.volumeDb < -60 || patch.volumeDb > 12)) {
    return fail('invalid', 'Volume must be between −60 and +12 dB.');
  }
  if (patch.gainDb !== undefined && (patch.gainDb < -24 || patch.gainDb > 24)) {
    return fail('invalid', 'Gain must be between −24 and +24 dB.');
  }
  if (patch.pan !== undefined && (patch.pan < -100 || patch.pan > 100)) {
    return fail('invalid', 'Pan must be between −100 and +100.');
  }
  if (patch.speed !== undefined && (patch.speed < 0.1 || patch.speed > 8)) {
    return fail('invalid', 'Speed must be between 0.1× and 8×.');
  }
  /*
    The same 0.5–4 the schema enforces, checked here so the command fails with a message
    instead of the patch throwing somewhere inside `produceWithPatches`. A slider cannot
    leave this range; a corrupted project or a future caller can.
  */
  if (
    patch.iconStrokeWidth !== undefined &&
    (!Number.isFinite(patch.iconStrokeWidth) ||
      patch.iconStrokeWidth < 0.5 ||
      patch.iconStrokeWidth > 4)
  ) {
    return fail('invalid', 'Stroke width must be between 0.5 and 4.');
  }
  /*
    A `shapeKind` on an icon would give one item two sources of geometry, and the two
    renderers are allowed to disagree about which wins — the same reason `addShapeItem`
    refuses an item with both. Refused rather than resolved by precedence.
  */
  const bothGeometries = targets.find((id) => {
    const item = state.items[id]!;
    return patch.shapeKind !== undefined && item.iconName !== undefined;
  });
  if (bothGeometries) {
    return fail('invalid', 'An icon draws its own shape; it cannot also have a kind.');
  }
  /*
    The other half of the same rule, and the one that needed saying separately: a *shape*
    must not acquire an icon name, and a clip with no geometry at all (a video, a caption)
    must not either. Both would create the two-sources-of-geometry item the check above
    refuses from the other direction.
  */
  const notAnIcon = targets.find((id) => {
    const item = state.items[id]!;
    return patch.iconName !== undefined && (item.iconName === undefined || item.shapeKind !== undefined);
  });
  if (notAnIcon) {
    return fail('invalid', 'Only an icon item can be given an icon name.');
  }

  const geometrySources = targets.find((id) => {
    const item = state.items[id]!;
    const kind = patch.shapeKind ?? item.shapeKind;
    const icon = patch.iconName ?? item.iconName;
    return kind !== undefined && icon !== undefined;
  });
  if (geometrySources) {
    return fail('invalid', 'An item draws one shape or one icon, not both.');
  }

  // Crop edges are fractions of the source; opposite edges that sum past 1 would
  // describe a negative-width frame. Checked per item because the patch may merge
  // with different existing values.
  const cropProblem = targets.find((id) => {
    if (!patch.crop) return false;
    const crop = { ...state.items[id]!.crop, ...patch.crop };
    return crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1;
  });
  if (cropProblem) return fail('invalid', 'Those crop edges leave no picture.');

  const negativeCrop = patch.crop
    ? (['left', 'top', 'right', 'bottom'] as const).some(
        (edge) => patch.crop![edge] !== undefined && (patch.crop![edge] as number) < 0,
      )
    : false;
  if (negativeCrop) return fail('invalid', 'Crop edges cannot be negative.');

  // A crossfade longer than half the clip would overlap itself and, on a very short
  // clip, produce a fade whose two halves fight each other.
  const fadeProblem = targets.find((id) => {
    const item = state.items[id]!;
    const fadeIn = patch.fadeInUs ?? item.fadeInUs;
    const fadeOut = patch.fadeOutUs ?? item.fadeOutUs;
    return (patch.fadeInUs !== undefined || patch.fadeOutUs !== undefined) && fadeIn + fadeOut > item.durationUs / 2;
  });
  if (fadeProblem) {
    return fail('invalid', 'Those fades are longer than half the clip.');
  }

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of targets) {
      const target = draft.items[id] as TimelineItem;
      if (patch.opacity !== undefined) target.opacity = patch.opacity;
      if (patch.volumeDb !== undefined) target.volumeDb = patch.volumeDb;
      if (patch.gainDb !== undefined) target.gainDb = patch.gainDb;
      if (patch.pan !== undefined) target.pan = patch.pan;
      if (patch.speed !== undefined) target.speed = patch.speed;
      if (patch.muted !== undefined) target.muted = patch.muted;
      if (patch.blendMode !== undefined) target.blendMode = patch.blendMode;
      if (patch.fadeInUs !== undefined) target.fadeInUs = Math.max(0, Math.round(patch.fadeInUs));
      if (patch.fadeOutUs !== undefined) target.fadeOutUs = Math.max(0, Math.round(patch.fadeOutUs));
      if (patch.fadeCurve !== undefined) target.fadeCurve = patch.fadeCurve;
      // Crop and transform merge per field: the inspector edits one corner at a
      // time, and replacing the whole object would reset the other three.
      if (patch.shapeKind !== undefined) target.shapeKind = patch.shapeKind;
      if (patch.noiseReduction !== undefined) {
        /*
          `null` means revert, and produces `undefined` rather than a null on the item — the schema
          treats absent and null differently, and a project carrying `noiseReduction: null` would
          read as "has this field" to every `!== undefined` check downstream.
        */
        target.noiseReduction = patch.noiseReduction ?? undefined;
      }
      if (patch.iconStrokeWidth !== undefined) target.iconStrokeWidth = patch.iconStrokeWidth;
      if (patch.iconName !== undefined) {
        target.iconName = patch.iconName;
        // Stored geometry belongs to the icon it was stored for.
        target.iconShapes = undefined;
      }
      if (patch.crop) target.crop = { ...target.crop, ...patch.crop };
      if (patch.transform) target.transform = { ...target.transform, ...patch.transform };
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: targets,
    notes: [],
  };
}

/**
 * Update a marker's name, note, or color (SPEC 09 §18).
 * Double-click a marker to edit in the app; this is the engine command.
 */
export function updateMarker(
  state: TimelineState,
  params: {
    markerId: string;
    patch: Partial<Pick<Marker, 'name' | 'note' | 'color'>>;
  },
): CommandResult {
  const marker = state.markers.find((m) => m.id === params.markerId);
  if (!marker) return fail('not_found', 'That marker no longer exists.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.markers.find((m) => m.id === params.markerId);
    if (!target) return;
    if (params.patch.name !== undefined) target.name = params.patch.name;
    if (params.patch.note !== undefined) target.note = params.patch.note;
    if (params.patch.color !== undefined) target.color = params.patch.color;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: ['Marker updated.'],
  };
}

/**
 * Delete a marker (SPEC 09 §18). Delete key removes the selected marker.
 */
export function deleteMarker(
  state: TimelineState,
  params: { markerId: string },
): CommandResult {
  const marker = state.markers.find((m) => m.id === params.markerId);
  if (!marker) return fail('not_found', 'That marker no longer exists.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.markers = draft.markers.filter((m) => m.id !== params.markerId);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: ['Marker deleted.'],
  };
}
/**
 * Update the timeline view state (SPEC 09 §25): zoom level, scroll position,
 * and header width. View state is not part of the editing history — it is
 * persisted with the project but not undoable via Ctrl+Z.
 */

/**
 * Change one or more of the composition's editing toggles (SPEC 09 §9.6, §12).
 *
 * These live in the document — saved with the project and part of the undo stack — and
 * until now nothing in the editor could write them: `linkedSelection`, `coverLock` and
 * the rest were schema fields with no control and no command, so the defaults in
 * `CompositionTogglesSchema` were the only values a project could ever have.
 *
 * A patch rather than a whole object, so toggling one flag cannot silently reset the
 * other nine to their schema defaults.
 */
export function setToggles(
  state: TimelineState,
  params: { patch: Partial<NonNullable<TimelineState['toggles']>> },
): CommandResult {
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    draft.toggles = { ...(draft.toggles ?? {}), ...params.patch } as NonNullable<
      TimelineState['toggles']
    >;
  });
  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: [],
  };
}

export function setViewState(
  state: TimelineState,
  params: {
    pxPerSecond?: number;
    scrollX?: number;
    scrollY?: number;
    headerWidthPx?: number;
  },
): CommandResult {
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const current = draft.viewState ?? {};
    draft.viewState = {
      pxPerSecond: params.pxPerSecond ?? current.pxPerSecond ?? 80,
      scrollX: params.scrollX ?? current.scrollX ?? 0,
      scrollY: params.scrollY ?? current.scrollY ?? 0,
      headerWidthPx: params.headerWidthPx ?? current.headerWidthPx ?? 184,
    };
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: ['View state updated.'],
  };
}
/**
 * Rename a track (SPEC 09 §9.1, §22 F2). The track name is displayed in the
 * track header and used in export metadata.
 */
export function renameTrack(
  state: TimelineState,
  params: { trackId: string; name: string },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  const trimmed = params.name.trim();
  if (trimmed.length === 0) return fail('invalid', 'Track name cannot be empty.');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.tracks.find((candidate) => candidate.id === params.trackId);
    if (target) target.name = trimmed;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [],
    notes: ['Track renamed.'],
  };
}

/* ------------------------------------------------------------------ *
 * Caption editing (SPEC 11 §2.5, §8)
 *
 * Every caption edit is a command here, never in a component. The reason is in
 * §2.5: "UI components contain no caption logic". A caption has three coupled
 * representations — the words, the displayed lines, and the start/end times — and
 * letting a component update one of them produces captions whose text and timing
 * disagree, which is invisible until export.
 * ------------------------------------------------------------------ */

/**
 * The text a caption actually shows: the words whose midpoint lies inside its
 * range (SPEC 11 §3). Derived every time rather than stored, so trimming and
 * extending cannot leave the two disagreeing.
 */
/**
 * The text for a set of word refs.
 *
 * `textOverride` is only present when a word was edited for this caption alone;
 * otherwise the text lives in the transcript. Falling back to the segment's own
 * text keeps a split or merge from producing an empty caption when the refs carry
 * no overrides — which is the normal case for captions generated from a
 * transcript.
 */
function captionTextFrom(
  wordRefs: ReadonlyArray<CaptionWordRef>,
  fallback: string,
  segmentText?: string,
): string {
  const overrides = wordRefs.map((word) => word.textOverride ?? '').filter(Boolean);
  // All words carried text: use it.
  if (overrides.length === wordRefs.length && wordRefs.length > 0) return overrides.join(' ');
  // None did: the text lives elsewhere. Prefer an explicit slice; a split passes
  // the half it covers, while a trim can only slice the segment's own words
  // positionally, because word refs carry no text of their own.
  if (overrides.length === 0) {
    if (fallback) return fallback;
    if (segmentText) return segmentText.split(/\s+/).filter(Boolean).slice(0, wordRefs.length).join(' ');
    return '';
  }
  // Mixed — this should not happen, but guessing would corrupt the caption.
  return overrides.join(' ');
}

function visibleCaptionText(segment: Pick<CaptionSegment, 'startUs' | 'endUs' | 'wordRefs' | 'text'>): string {
  const visible = segment.wordRefs.filter((word) => {
    const midpoint = (word.startUs + word.endUs) / 2;
    return midpoint >= segment.startUs && midpoint <= segment.endUs;
  });

  // Overrides are absent on the normal path — a caption generated from a
  // transcript names its words by id and stores no text of its own. Slicing the
  // segment's existing text by the same word positions keeps retiming from
  // blanking the caption, which is what joining an empty override list did.
  const overrides = visible.map((word) => word.textOverride ?? '');
  if (visible.length > 0 && overrides.every(Boolean)) return overrides.join(' ');

  const originalWords = segment.text.split(/\s+/).filter(Boolean);
  const firstVisible = segment.wordRefs.findIndex((word) => visible.includes(word));
  if (firstVisible === -1) return '';
  return originalWords.slice(firstVisible, firstVisible + visible.length).join(' ');
}

/**
 * Gives edited text timings, keeping the old ones where the word count matches.
 *
 * Editing a typo must not move anything, so with equal counts each new word
 * inherits the old word's interval regardless of how different the characters
 * are. With a different count the segment's own range is divided proportionally
 * by character length, which keeps relative spoken pace roughly intact and never
 * runs outside the caption.
 */
function retimeWords(
  texts: string[],
  previous: CaptionWordRef[],
  startUs: number,
  endUs: number,
): CaptionWordRef[] {
  if (texts.length === previous.length) {
    return texts.map((text, index) => ({ ...previous[index]!, textOverride: text }));
  }

  const totalChars = texts.reduce((sum, text) => sum + Math.max(1, text.length), 0);
  const span = Math.max(1, endUs - startUs);
  let cursor = startUs;
  return texts.map((text, index) => {
    const share = (Math.max(1, text.length) / totalChars) * span;
    const wordStart = Math.round(cursor);
    cursor += share;
    // The last word ends exactly at the segment end, so accumulated rounding
    // cannot leave a gap or overrun.
    const wordEnd = index === texts.length - 1 ? endUs : Math.round(cursor);
    return {
      wordId: `${previous[0]?.wordId ?? 'w'}-edit-${index}`,
      startUs: wordStart,
      endUs: Math.max(wordStart + 1, wordEnd),
      textOverride: text,
    };
  });
}

/** Context needed by commands that re-derive line breaks from a style. */
export interface CaptionLayoutContext {
  /** Renders text into display lines. Injected so the engine holds no layout code. */
  wrap(text: string, maxCharsPerLine: number, maxLines: number): string[];
}

/**
 * SPEC 11 §8 — change a caption's text.
 *
 * The words are rebuilt from the new text but keep the *count* of word timings:
 * a user fixing a typo should not lose the timing, and a user replacing a word
 * should have the new word take the old word's slot. If the word count changes,
 * the remaining time is redistributed proportionally to character count, and the
 * segment is marked `manualText` so `regenerateCaptions` will not overwrite it.
 */
export function editCaptionText(
  state: TimelineState,
  params: { itemId: string; text: string; layout?: CaptionLayoutContext; maxCharsPerLine?: number; maxLines?: number },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (item.type !== 'caption' || !item.captionSegment) {
    return fail('invalid', 'That item is not a caption.');
  }
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const text = params.text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return fail('invalid', 'A caption cannot be empty. Use delete instead.');

  const segment = item.captionSegment;
  const newWords = text.split(' ').filter((word) => word.length > 0);
  const oldRefs = segment.wordRefs;

  const refs = retimeWords(newWords, oldRefs, segment.startUs, segment.endUs);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId]!;
    const draftSegment = target.captionSegment!;
    draftSegment.text = text;
    draftSegment.lines = params.layout
      ? params.layout.wrap(text, params.maxCharsPerLine ?? 24, params.maxLines ?? 2)
      : newWords.reduce<string[]>((lines, word) => {
          const last = lines[lines.length - 1];
          const limit = params.maxCharsPerLine ?? 24;
          if (last !== undefined && (last + ' ' + word).length <= limit) {
            lines[lines.length - 1] = `${last} ${word}`;
          } else lines.push(word);
          return lines;
        }, []).slice(0, params.maxLines ?? 2);
    draftSegment.wordRefs = refs;
    draftSegment.manualText = true;
    draftSegment.transcriptChanged = false;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: oldRefs.length === newWords.length ? ['Caption text edited.'] : ['Caption text edited; word timings were redistributed.'],
  };
}

/**
 * SPEC 11 §8 — retime a caption by dragging its edges.
 *
 * Trimming never rewrites word text: words outside the new range stay in the
 * model but stop being displayed, so extending the caption restores them. That is
 * §3's rule and the reason this is not simply a duration change.
 */
export function retimeCaption(
  state: TimelineState,
  params: { itemId: string; startUs?: number; endUs?: number; fps: Fps },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (item.type !== 'caption' || !item.captionSegment) {
    return fail('invalid', 'That item is not a caption.');
  }
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const segment = item.captionSegment;
  const startUs = quantizeUs(params.startUs ?? segment.startUs, params.fps);
  const endUs = quantizeUs(params.endUs ?? item.startUs + item.durationUs, params.fps);

  if (startUs < 0) return fail('invalid', 'A caption cannot start before zero.');
  if (endUs - startUs < frameDurationUs(params.fps)) {
    return fail('too_short', 'A caption must be at least one frame long.');
  }
  if (startUs === segment.startUs && endUs === segment.endUs) {
    // Nothing changed; still a valid no-op so a drag that ends where it began is
    // not reported as an error.
    return { ok: true, state, patches: [], inverse: [], affectedItemIds: [], notes: [] };
  }

  const durationUs = endUs - startUs;
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId]!;
    target.startUs = startUs;
    target.durationUs = durationUs;
    target.captionSegment!.startUs = startUs;
    target.captionSegment!.endUs = endUs;
    target.captionSegment!.manualTiming = true;
    // Visible text is derived, never stored: §3 says the visible text always
    // equals the words whose midpoint lies inside the range.
    target.captionSegment!.text = visibleCaptionText(target.captionSegment!);
    target.captionSegment!.lines = [
      target.captionSegment!.text.length > 0 ? target.captionSegment!.text : '',
    ].filter(Boolean);
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: ['Caption retimed; words outside the range are hidden, not removed.'],
  };
}

/**
 * SPEC 11 §8 — *Trim words to range*.
 *
 * The explicit counterpart to `retimeCaption`: the words outside the range are
 * removed from the model rather than hidden. Only this command drops words, and
 * only when the user asks for it.
 */
export function trimCaptionWordsToRange(state: TimelineState, params: { itemId: string }): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (!item.captionSegment) return fail('invalid', 'That item is not a caption.');
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);
  if (!track) return fail('not_found', 'That track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const segment = item.captionSegment;
  const kept = segment.wordRefs.filter((word) => {
    const midpoint = (word.startUs + word.endUs) / 2;
    return midpoint >= segment.startUs && midpoint <= segment.endUs;
  });
  if (kept.length === segment.wordRefs.length) {
    return { ok: true, state, patches: [], inverse: [], affectedItemIds: [], notes: ['No words were outside the range.'] };
  }

  const removedCount = segment.wordRefs.length - kept.length;
  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId]!;
    target.captionSegment!.wordRefs = kept;
    target.captionSegment!.text = captionTextFrom(kept, '', segment.text);
    target.captionSegment!.manualText = true;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: [`Removed ${removedCount} word${removedCount === 1 ? '' : 's'} outside the caption range.`],
  };
}

/**
 * SPEC 11 §8 — apply a style to captions.
 *
 * Records the style id and *updates the project-local copy* the caller passes, so
 * a preset changing in a future release cannot alter a finished project (§2.2).
 * Overrides are cleared unless the caller asks to keep them, because "apply this
 * style" means exactly that; the inspector's per-item overrides are re-applied by
 * the caller when it wants them preserved.
 */
export function applyCaptionStyle(
  state: TimelineState,
  params: { itemIds: string[]; styleId: string; keepOverrides?: boolean; overrides?: Record<string, unknown> },
): CommandResult {
  const targets = params.itemIds.filter((id) => state.items[id]?.type === 'caption');
  if (targets.length === 0) return fail('not_found', 'No captions were selected.');

  const lockedTrack = state.tracks.find(
    (track) => track.locked && targets.some((id) => state.items[id]!.trackId === track.id),
  );
  if (lockedTrack) return fail('locked', `"${lockedTrack.name}" is locked.`);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of targets) {
      const target = draft.items[id]!;
      target.captionStyleId = params.styleId;
      if (!params.keepOverrides) target.styleOverrides = params.overrides ?? undefined;
      else if (params.overrides) {
        target.styleOverrides = { ...(target.styleOverrides ?? {}), ...params.overrides };
      }
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: targets,
    notes: [`Style applied to ${targets.length} caption${targets.length === 1 ? '' : 's'}.`],
  };
}

/**
 * SPEC 11 §8 — toggle emphasis on individual words.
 *
 * Stored per word rather than baked into the style, so swapping styles keeps the
 * user's emphasis (§7). An emphasis toggle on the same word twice returns it to
 * the style's default rather than storing `emphasis: false`.
 */
export function setWordEmphasis(
  state: TimelineState,
  params: { itemId: string; wordIndex: number; emphasis: boolean; color?: string; scale?: number },
): CommandResult {
  const item = state.items[params.itemId];
  if (!item) return fail('not_found', 'That item no longer exists.');
  if (!item.captionSegment) return fail('invalid', 'That item is not a caption.');

  const segment = item.captionSegment;
  const word = segment.wordRefs[params.wordIndex];
  if (!word) return fail('invalid', 'That word is not part of this caption.');

  const current = segment.wordOverrides?.[word.wordId] ?? {};
  const next = params.emphasis
    ? { ...current, emphasis: true, ...(params.color ? { color: params.color } : {}), ...(params.scale !== undefined ? { scale: params.scale } : {}) }
    : (() => {
        const cleaned = { ...current };
        delete (cleaned as { emphasis?: boolean }).emphasis;
        if (!params.color) delete (cleaned as { color?: string }).color;
        if (params.scale === undefined) delete (cleaned as { scale?: number }).scale;
        return cleaned;
      })();

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const target = draft.items[params.itemId]!;
    const overrides = { ...(target.captionSegment!.wordOverrides ?? {}) };
    if (Object.keys(next).length === 0) delete overrides[word.wordId];
    else overrides[word.wordId] = next as { emphasis?: boolean; color?: string; scale?: number };
    target.captionSegment!.wordOverrides = overrides;
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [params.itemId],
    notes: [params.emphasis ? 'Word emphasised.' : 'Emphasis removed.'],
  };
}

/**
 * SPEC 11 §9 — regenerate captions from the transcript, leaving hand-edited ones
 * alone.
 *
 * `manualText` is the marker: a caption the user typed is never overwritten by a
 * regeneration, because losing a hand fix is worse than keeping a stale one.
 * `force` exists for the explicit "Regenerate all" that §4 describes.
 */
export function regenerateCaptions(
  state: TimelineState,
  params: { trackId: string; segments: Array<{ startUs: number; endUs: number; text: string; words: Array<{ id: string; text: string; startUs: number; endUs: number; confidence?: number }> }>; force?: boolean },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That caption track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);
  if (track.kind !== 'caption') return fail('invalid', `"${track.name}" cannot hold captions.`);

  const existing = sortedItemsOfTrack(state, params.trackId).filter((item) => item.type === 'caption');
  const preserved = existing.filter((item) => item.captionSegment?.manualText === true && params.force !== true);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    // Remove the captions this regeneration will replace, keep the hand-edited.
    for (const item of existing) {
      if (preserved.some((kept) => kept.id === item.id)) continue;
      delete draft.items[item.id];
    }

    let index = 0;
    for (const segment of params.segments) {
      // Skip a generated segment that would collide with a preserved caption;
      // overlapping captions on one track are an invariant violation (§3).
      const clashes = preserved.some(
        (kept) => segment.startUs < kept.startUs + kept.durationUs && segment.endUs > kept.startUs,
      );
      if (clashes) continue;

      const id = `${params.trackId}-cap-regen-${index++}`;
      draft.items[id] = createCaptionItem({
        id,
        trackId: params.trackId,
        startUs: segment.startUs,
        durationUs: segment.endUs - segment.startUs,
        words: segment.words.map((word, wordIndex) => ({
          wordId: word.id || `${id}-w${wordIndex}`,
          startUs: word.startUs,
          endUs: word.endUs,
          textOverride: word.text,
        })),
        fallbackText: segment.text,
      });
    }
  });

  const replaced = existing.length - preserved.length;
  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: Object.keys(params.segments).length > 0 ? [params.trackId] : [],
    notes: [
      `Regenerated ${params.segments.length} caption${params.segments.length === 1 ? '' : 's'}` +
        (preserved.length > 0 ? `; kept ${preserved.length} you had edited.` : '.'),
      ...(replaced > 0 && preserved.length > 0 ? ['Hand-edited captions were left untouched.'] : []),
    ],
  };
}

/**
 * SPEC 11 §9 — realign captions after the transcript changed under them.
 *
 * Matches each caption's words to the new transcript by text, keeping the
 * caption's own boundaries when a match is found and flagging the rest as
 * `transcriptChanged` so the panel can offer a review. Nothing is deleted.
 */
export function syncCaptionsWithTranscript(
  state: TimelineState,
  params: { trackId: string; words: Array<{ text: string; startUs: number; endUs: number }> },
): CommandResult {
  const track = state.tracks.find((candidate) => candidate.id === params.trackId);
  if (!track) return fail('not_found', 'That caption track no longer exists.');
  if (track.locked) return fail('locked', `"${track.name}" is locked.`);

  const captions = sortedItemsOfTrack(state, params.trackId).filter((item) => item.type === 'caption');
  if (captions.length === 0) return fail('not_found', 'That track has no captions to sync.');

  const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const transcript = params.words.map((word) => ({ ...word, key: normalise(word.text) }));

  let matched = 0;
  let changed = 0;

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const caption of captions) {
      const target = draft.items[caption.id]!;
      if (target.captionSegment?.manualText === true) continue;

      const captionWords = target.captionSegment!.wordRefs;
      if (captionWords.length === 0) continue;

      const captionText = captionWords.map((word) => word.textOverride ?? '');
      const firstKey = normalise(captionText[0] ?? '');
      const startIndex = firstKey ? transcript.findIndex((word) => word.key === firstKey) : -1;
      const window = startIndex === -1 ? [] : transcript.slice(startIndex, startIndex + captionWords.length);
      const aligned =
        window.length === captionWords.length &&
        window.every((word, index) => word.key === normalise(captionText[index] ?? ''));

      if (aligned) {
        matched += 1;
        target.captionSegment!.wordRefs = window.map((word, index) => ({
          ...captionWords[index]!,
          startUs: word.startUs,
          endUs: word.endUs,
        }));
        target.captionSegment!.startUs = window[0]!.startUs;
        target.captionSegment!.endUs = window[window.length - 1]!.endUs;
        target.startUs = window[0]!.startUs;
        target.durationUs = window[window.length - 1]!.endUs - window[0]!.startUs;
        target.captionSegment!.transcriptChanged = false;
      } else {
        changed += 1;
        target.captionSegment!.transcriptChanged = true;
      }
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: captions.map((caption) => caption.id),
    notes: [
      `Realigned ${matched} caption${matched === 1 ? '' : 's'} with the transcript.`,
      ...(changed > 0 ? [`${changed} no longer match and are flagged for review.`] : []),
    ],
  };
}
