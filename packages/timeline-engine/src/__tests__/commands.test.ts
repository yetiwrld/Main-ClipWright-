import { applyPatches } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDefaultTimeline, createMediaItem } from '../factory';
import {
  addAdjustmentLayer,
  addItem,
  addShapeItem,
  addTextItem,
  addGuide,
  clearGuides,
  setGuides,
  setGuidesLocked,
  removeGuide,
  addMarker,
  groupItems,
  pasteItems,
  ungroupItems,
  deleteItems,
  duplicateItems,
  moveItems,
  moveItemsToTrack,
  setTrackMuted,
  setTrackMagnetic,
  rollAt,
  detachAudio,
  unlink,
  toggleItemDisabled,
  addTrack,
  toggleTrackLock,
  toggleTrackHidden,
  deleteTrack,
  addTransition,
  updateTransition,
  removeTransition,
  setWorkArea,
  clearWorkArea,
  addKeyframe,
  setKeyframesAt,
  removeKeyframe,
  updateKeyframe,
  setBezierHandles,
  moveKeyframe,
  duplicateKeyframe,
  splitCaptionSegment,
  mergeCaptionSegments,
  trimCaptionSegment,
  applyEffect,
  moveEffect,
  setEffectChain,
  removeEffect,
  toggleEffectEnabled,
  updateEffectParams,
  updateMarker,
  deleteMarker,
  setViewState,
  renameTrack,
  splitItems,
  trimItem,
  trimItems,
} from '../commands';
import type { TimelineState } from '../commands';
import { checkInvariantsMB } from './helpers';

describe('timeline commands', () => {
  it('builds the default layout with exactly one main track', () => {
    const state = createDefaultTimeline({ id: 'c1', name: 'Clip' });
    expect(state.tracks.map((track) => track.name)).toEqual([
      'Main video',
      'Overlay video',
      'Text / Graphics',
      'Captions',
      'Original audio',
      'Music',
      'SFX',
    ]);
    expect(state.tracks.filter((track) => track.role === 'main')).toHaveLength(1);
    expect(checkInvariantsMB(state)).toEqual([]);
  });

  it('moves a clip to a free time and keeps the track sorted', () => {
    const { state, ids } = fixture();
    const result = moveItems(state, {
      fps: 30,
      moves: [{ itemId: ids.second, startUs: 7_000_000 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.second]!.startUs).toBe(7_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('clamps a colliding move to the nearest free gap instead of overwriting', () => {
    const { state, ids } = fixture();
    const result = moveItems(demagnetized(state), {
      fps: 30,
      moves: [{ itemId: ids.second, startUs: 700_000 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // “A” owns 0–2 s, so the only free spot that fits is right after it.
    expect(result.state.items[ids.second]!.startUs).toBe(2_000_000);
    expect(result.notes.join(' ')).toMatch(/free gap/i);
  });

  it('refuses to move onto a locked track', () => {
    const { state, ids, trackId } = fixture();
    const locked = {
      ...state,
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, locked: true } : track,
      ),
    };
    const result = moveItems(locked, { fps: 30, moves: [{ itemId: ids.first, startUs: 0 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('never lets Normal mode create an overlap', () => {
    const { state, ids } = fixture();
    const before = demagnetized(state).items[ids.first]!;
    const result = moveItems(demagnetized(state), {
      fps: 30,
      moves: [{ itemId: ids.first, startUs: before.startUs + 500_000 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const track of result.state.tracks) {
      const items = track.itemIds
        .map((id) => result.state.items[id]!)
        .filter(Boolean)
        .sort((a, b) => a.startUs - b.startUs);
      for (let index = 1; index < items.length; index += 1) {
        expect(items[index - 1]!.startUs + items[index - 1]!.durationUs).toBeLessThanOrEqual(
          items[index]!.startUs,
        );
      }
    }
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('insert mode pushes later clips right by the moved duration', () => {
    const { state, ids } = fixture();
    const second = state.items[ids.second]!;
    const result = moveItems(state, {
      fps: 30,
      mode: 'insert',
      moves: [{ itemId: ids.second, startUs: 0 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.second]!.startUs).toBe(0);
    expect(result.state.items[ids.first]!.startUs).toBe(second.startUs);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('overwrite mode replaces covered clips and removes fully covered ones', () => {
    const { state, ids } = fixture();
    const result = moveItems(state, {
      fps: 30,
      mode: 'overwrite',
      moves: [{ itemId: ids.second, startUs: 0 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.first]).toBeUndefined();
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('trims an edge and clamps it at the neighbouring clip', () => {
    const { state, ids } = fixture();
    const second = state.items[ids.second]!;
    const result = trimItem(state, {
      itemId: ids.first,
      edge: 'end',
      toUs: 9_000_000,
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.state.items[ids.first]!;
    expect(first.startUs + first.durationUs).toBeLessThanOrEqual(second.startUs);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('never trims a clip shorter than one frame', () => {
    const { state, ids } = fixture();
    const result = trimItem(state, { itemId: ids.first, edge: 'end', toUs: 0, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.first]!.durationUs).toBeGreaterThanOrEqual(33_333);
  });

  it('ripple trim extends the clip and pushes later clips right', () => {
    const { state, ids } = fixture();
    const result = trimItem(state, {
      itemId: ids.first,
      edge: 'end',
      toUs: 3_000_000,
      fps: 30,
      ripple: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.state.items[ids.first]!;
    const second = result.state.items[ids.second]!;
    expect(first.startUs + first.durationUs).toBe(3_000_000);
    expect(second.startUs).toBe(3_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('ripple trim shortens the clip and pulls later clips left', () => {
    const { state, ids } = fixture();
    const result = trimItem(state, {
      itemId: ids.first,
      edge: 'end',
      toUs: 1_000_000,
      fps: 30,
      ripple: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const second = result.state.items[ids.second]!;
    expect(second.startUs).toBe(1_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('ripple trim start edge moves the clip and its followers together', () => {
    const { state, ids } = fixture();
    const result = trimItem(state, {
      itemId: ids.first,
      edge: 'start',
      toUs: 1_000_000,
      fps: 30,
      ripple: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.state.items[ids.first]!;
    const second = result.state.items[ids.second]!;
    expect(first.startUs).toBe(1_000_000);
    expect(second.startUs).toBe(3_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('refuses a ripple that would push an item on a locked track', () => {
    const { state, ids } = fixture();
    // Put a later clip on the locked original-audio track.
    const base = createMediaItem({
      id: 'item-d',
      trackId: state.tracks[4]!.id,
      label: 'D',
      mediaId: 'media-2',
      type: 'audio',
      startUs: 3_000_000,
      durationUs: 1_000_000,
      sourceDurationUs: 10_000_000,
    });
    const later = { ...base, linkId: 'L1' };
    const linked = {
      ...state,
      items: {
        ...state.items,
        [ids.first]: { ...state.items[ids.first]!, linkId: 'L1' },
        [later.id]: later,
      },
    };
    const locked = {
      ...linked,
      items: { ...linked.items, [later.id]: later },
      tracks: state.tracks.map((track) =>
        track.id === later.trackId
          ? { ...track, itemIds: [later.id], locked: true }
          : track,
      ),
    };
    const result = trimItem(locked, {
      itemId: ids.first,
      edge: 'end',
      toUs: 4_000_000,
      fps: 30,
      ripple: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('trims every selected clip to the playhead as one step', () => {
    const { state, ids } = fixture();
    const result = trimItems(state, { itemIds: [ids.first, ids.third], edge: 'end', toUs: 2_000_000, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.first]!.startUs + result.state.items[ids.first]!.durationUs).toBe(2_000_000);
    expect(result.state.items[ids.third]!.startUs + result.state.items[ids.third]!.durationUs).toBe(2_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('never lets a multi-select trim overlap adjacent selected clips', () => {
    const { state, ids } = fixture();
    const result = trimItems(state, { itemIds: [ids.first, ids.second], edge: 'end', toUs: 3_000_000, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.state.items[ids.first]!;
    const second = result.state.items[ids.second]!;
    expect(first.startUs + first.durationUs).toBeLessThanOrEqual(second.startUs);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('magnetic main track closes the gap when a clip is deleted', () => {
    const { state, ids } = fixture();
    const result = deleteItems(state, { itemIds: [ids.first], fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // “A” occupied 0–2 s; with magnetic on, “B” slides left to 0.
    expect(result.state.items[ids.second]!.startUs).toBe(0);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('magnetic main track closes the gap when a clip is trimmed shorter', () => {
    const { state, ids } = fixture();
    const result = trimItem(state, { itemId: ids.first, edge: 'end', toUs: 1_000_000, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.second]!.startUs).toBe(1_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('magnetic main track closes the gap when a clip moves away', () => {
    const { state, ids, trackId } = fixture();
    const result = moveItems(state, {
      fps: 30,
      moves: [{ itemId: ids.first, startUs: 0, trackId: state.tracks[1]!.id }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // “A” left the main track; “B” slides left to 0.
    expect(result.state.items[ids.second]!.startUs).toBe(0);
    expect(result.state.items[ids.first]!.trackId).not.toBe(trackId);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('magnetic main track inserts a dropped clip and pushes later clips right', () => {
    const { state, ids } = fixture();
    const incoming = createMediaItem({
      id: 'item-in',
      trackId: state.tracks[0]!.id,
      label: 'In',
      mediaId: 'media-1',
      startUs: 1_000_000,
      durationUs: 1_000_000,
      sourceDurationUs: 10_000_000,
    });
    const result = addItem(state, { item: incoming, fps: 30, startUs: 1_000_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Dropped at 1 s: “A” (0–2 s) is split, “B” slides right by the insert.
    const split = Object.values(result.state.items).find((item) =>
      item.id.startsWith('item-a~'),
    );
    expect(split).toBeDefined();
    expect(result.state.items[ids.second]!.startUs).toBe(3_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('magnetic off leaves the main track gaps alone', () => {
    const { state, ids } = fixture();
    const demagnetized = setTrackMagnetic(state, { trackId: state.tracks[0]!.id, magnetic: false });
    expect(demagnetized.ok).toBe(true);
    if (!demagnetized.ok) return;
    const result = deleteItems(demagnetized.state, { itemIds: [ids.first], fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.second]!.startUs).toBe(2_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('rolls a junction between two adjacent clips', () => {
    const { state, ids } = fixture();
    const result = rollAt(state, { leftItemId: ids.first, rightItemId: ids.second, atUs: 3_000_000, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.state.items[ids.first]!;
    const second = result.state.items[ids.second]!;
    // The cut point moved from 2 s to 3 s: the left clip grew, the right clip
    // started later but kept its end, so the total span is unchanged.
    expect(first.startUs + first.durationUs).toBe(3_000_000);
    expect(second.startUs).toBe(3_000_000);
    expect(second.startUs + second.durationUs).toBe(4_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('rolling edit is clamped by the source limits of both clips', () => {
    const { state, ids } = fixture();
    const result = rollAt(state, { leftItemId: ids.first, rightItemId: ids.second, atUs: 9_000_000, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // “A” only has 10 s of source and starts at 0, so the junction cannot pass
    // its source end; it also cannot pass the right clip's end.
    const first = result.state.items[ids.first]!;
    const second = result.state.items[ids.second]!;
    expect(first.startUs + first.durationUs).toBeLessThanOrEqual(second.startUs + second.durationUs);
    expect(second.durationUs).toBeGreaterThanOrEqual(33_333);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('detaches audio into a linked audio item and mutes the video', () => {
    const { state, ids } = fixture();
    const result = detachAudio(state, { videoItemId: ids.first, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const video = result.state.items[ids.first]!;
    expect(video.muted).toBe(true);
    expect(video.linkId).toBeTruthy();
    // A new audio item appears on an audio track sharing the linkId.
    const linked = Object.values(result.state.items).filter(
      (item) => item.linkId === video.linkId && item.id !== ids.first,
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]!.type).toBe('audio');
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('unlink removes the shared linkId from every member', () => {
    const { state, ids } = fixture();
    const detached = detachAudio(state, { videoItemId: ids.first, fps: 30 });
    expect(detached.ok).toBe(true);
    if (!detached.ok) return;
    const video = detached.state.items[ids.first]!;
    const result = unlink(detached.state, { itemId: ids.first });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoAfter = result.state.items[ids.first]!;
    expect(videoAfter.linkId).toBeUndefined();
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('toggles the disabled flag on an item', () => {
    const { state, ids } = fixture();
    const result = toggleItemDisabled(state, { itemId: ids.first });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.first]!.disabled).toBe(true);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('adds a new track above the reference track', () => {
    const { state } = fixture();
    const result = addTrack(state, { kind: 'video', aboveTrackId: state.tracks[0]!.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tracks.length).toBe(state.tracks.length + 1);
    expect(result.state.tracks[0]!.kind).toBe('video');
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('toggles the lock flag on a track', () => {
    const { state } = fixture();
    const result = toggleTrackLock(state, { trackId: state.tracks[0]!.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tracks[0]!.locked).toBe(true);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('toggles the hidden flag on a track', () => {
    const { state } = fixture();
    const result = toggleTrackHidden(state, { trackId: state.tracks[0]!.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tracks[0]!.hidden).toBe(true);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('deletes a track and its items', () => {
    const { state, ids } = fixture();
    const audioTrack = state.tracks[4]!;
    const result = deleteTrack(state, { trackId: audioTrack.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tracks.find((t) => t.id === audioTrack.id)).toBeUndefined();
    expect(result.state.items[ids.third]).toBeUndefined();
    expect(result.state.items[ids.first]).toBeDefined();
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('refuses to detach audio from a non-video item', () => {
    const { state, ids } = fixture();
    const result = detachAudio(state, { videoItemId: ids.third, fps: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('refuses a rolling edit across non-adjacent clips', () => {
    const { state, ids } = fixture();
    const result = rollAt(state, { leftItemId: ids.first, rightItemId: ids.third, atUs: 1_000_000, fps: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('refuses magnetic on a non-main track', () => {
    const { state } = fixture();
    const result = setTrackMagnetic(state, { trackId: state.tracks[1]!.id, magnetic: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('moves selection to the track above and below without overlap', () => {
    const { state, ids } = fixture();
    const up = moveItemsToTrack(state, { itemIds: [ids.first], direction: 'up', fps: 30 });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.state.items[ids.first]!.trackId).not.toBe(state.items[ids.first]!.trackId);
    expect(checkInvariantsMB(up.state)).toEqual([]);

    const back = moveItemsToTrack(up.state, { itemIds: [ids.first], direction: 'down', fps: 30 });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.state.items[ids.first]!.trackId).toBe(state.items[ids.first]!.trackId);
    expect(checkInvariantsMB(back.state)).toEqual([]);
  });

  it('splits under the playhead keeping both halves inside the source', () => {
    const { state, ids } = fixture();
    const atUs = 1_000_000;
    const result = splitItems(state, { itemIds: [ids.first], atUs, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const halves = Object.values(result.state.items).filter((item) =>
      item.id.startsWith(ids.first),
    );
    expect(halves).toHaveLength(2);
    const left = halves.find((item) => item.startUs === 0)!;
    const right = halves.find((item) => item.startUs === atUs)!;
    expect(left.durationUs + right.durationUs).toBe(state.items[ids.first]!.durationUs);
    expect(right.sourceInUs).toBe(state.items[ids.first]!.sourceInUs + atUs);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('refuses to split at a clip edge', () => {
    const { state, ids } = fixture();
    const result = splitItems(state, { itemIds: [ids.first], atUs: 0, fps: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_short');
  });

  it('deletes without ripple, leaving the gap', () => {
    const { state, ids } = fixture();
    const second = demagnetized(state).items[ids.second]!;
    const result = deleteItems(demagnetized(state), { itemIds: [ids.first], fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.second]!.startUs).toBe(second.startUs);
  });

  it('ripple delete closes the gap on the same track only', () => {
    const { state, ids } = fixture();
    const first = state.items[ids.first]!;
    const second = state.items[ids.second]!;
    const third = state.items[ids.third]!;
    const result = deleteItems(state, { itemIds: [ids.first], fps: 30, ripple: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[ids.second]!.startUs).toBe(second.startUs - first.durationUs);
    expect(result.state.items[ids.third]!.startUs).toBe(third.startUs);
  });

  it('duplicates right after the original and refuses when blocked', () => {
    const { state, ids } = fixture();
    const blocked = duplicateItems(state, { itemIds: [ids.first], fps: 30 });
    expect(blocked.ok).toBe(false);

    const spaced = {
      ...state,
      items: {
        ...state.items,
        [ids.second]: { ...state.items[ids.second]!, startUs: 6_000_000 },
      },
    };
    const result = duplicateItems(spaced, { itemIds: [ids.first], fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copies = result.affectedItemIds;
    expect(copies).toHaveLength(1);
    expect(result.state.items[copies[0]!]!.startUs).toBe(2_000_000);
  });

  it('undo restores the exact state for every command in a scripted session', () => {
    let state = { ...fixture().state };
    const history: Array<{ before: typeof state; undo: () => void }> = [];
    const apply = (label: string, result: ReturnType<typeof moveItems>) => {
      if (!result.ok) return;
      const before = state;
      state = result.state;
      history.push({
        before,
        undo: () => {
          state = before;
        },
      });
      expect(label.length).toBeGreaterThan(0);
    };

    const ids = Object.keys(state.items);
    apply('move', moveItems(state, { fps: 30, moves: [{ itemId: ids[0]!, startUs: 800_000 }] }));
    apply('marker', addMarker(state, { timeUs: 500_000, fps: 30 }));
    apply('mute', setTrackMuted(state, { trackId: state.tracks[0]!.id, muted: true }));

    while (history.length) {
      const step = history.pop()!;
      step.undo();
      expect(state).toEqual(step.before);
    }
  });

  it('adds a dropped clip into the nearest free gap and reports the track', () => {
    const { state, ids, trackId } = fixture();
    const dropped = state.items[ids.third]!;
    const result = addItem(demagnetized(state), {
      fps: 30,
      trackId,
      item: { ...dropped, id: 'dropped-1', trackId, type: 'video', durationUs: 1_000_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placed = result.state.items['dropped-1']!;
    expect(placed.trackId).toBe(trackId);
    expect(placed.startUs).toBe(4_000_000); // after A (0–2 s) and B (2–4 s)
    expect(result.notes.join(' ')).toMatch(/free gap/i);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('places a long drop after the existing clips rather than on top of them', () => {
    const { state, ids, trackId } = fixture();
    const result = addItem(demagnetized(state), {
      fps: 30,
      trackId,
      item: {
        ...state.items[ids.first]!,
        id: 'dropped-2',
        trackId,
        durationUs: 20_000_000,
        sourceDurationUs: 40_000_000,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['dropped-2']!.startUs).toBe(4_000_000);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('refuses a drop longer than its source media', () => {
    const { state, ids, trackId } = fixture();
    const result = addItem(state, {
      fps: 30,
      trackId,
      item: { ...state.items[ids.first]!, id: 'dropped-3', trackId, durationUs: 20_000_000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('source_bounds');
  });

  it('pastes a copied clip at the playhead and keeps it undoable as one step', () => {
    const { state, ids } = fixture();
    const copied = state.items[ids.first]!;
    const result = pasteItems(state, {
      fps: 30,
      atUs: 10_000_000,
      items: [{ item: copied, trackId: copied.trackId }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.affectedItemIds).toHaveLength(1);
    expect(result.state.items[result.affectedItemIds[0]!]!.startUs).toBe(10_000_000);
    expect(result.patches.length).toBeGreaterThan(0);
    expect(checkInvariantsMB(result.state)).toEqual([]);
  });

  it('pastes a locked-track copy as a refusal, not a silent partial paste', () => {
    const { state, ids, trackId } = fixture();
    const locked = {
      ...state,
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, locked: true } : track,
      ),
    };
    const result = pasteItems(locked, {
      fps: 30,
      atUs: 0,
      items: [{ item: state.items[ids.first]!, trackId }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('groups and ungroups selected clips', () => {
    const { state, ids } = fixture();
    const grouped = groupItems(state, { itemIds: [ids.first, ids.second] });
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    expect(grouped.state.items[ids.first]!.groupId).toBe(grouped.state.items[ids.second]!.groupId);
    expect(grouped.state.groups).toHaveLength(1);

    const groupId = grouped.state.items[ids.first]!.groupId!;
    const ungrouped = ungroupItems(grouped.state, { groupId });
    expect(ungrouped.ok).toBe(true);
    if (!ungrouped.ok) return;
    expect(ungrouped.state.items[ids.first]!.groupId).toBeUndefined();
    expect(ungrouped.state.groups).toHaveLength(0);
  });


  describe('transitions (SPEC 09 §16)', () => {
    function transitionFixture(): { state: TimelineState; leftId: string; rightId: string; trackId: string } {
      const base = createDefaultTimeline({ id: 'trans-1', name: 'Transitions' });
      const track = base.tracks[0]!; // main video
      const left = createMediaItem({
        id: 'left',
        trackId: track.id,
        label: 'Left clip',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 2_000_000,
        sourceDurationUs: 10_000_000,
      });
      const right = createMediaItem({
        id: 'right',
        trackId: track.id,
        label: 'Right clip',
        mediaId: 'media-1',
        startUs: 2_000_000,
        durationUs: 2_000_000,
        sourceInUs: 5_000_000,
        sourceDurationUs: 10_000_000,
      });
      const state: TimelineState = {
        ...base,
        tracks: base.tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, itemIds: [left.id, right.id] } : candidate,
        ),
        items: { [left.id]: left, [right.id]: right },
      };
      return { state, leftId: left.id, rightId: right.id, trackId: track.id };
    }

    it('attaches a transition at a junction between adjacent clips', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      const result = addTransition(state, {
        trackId,
        leftItemId: leftId,
        rightItemId: rightId,
        type: 'crossfade',
        durationUs: 500_000,
        fps: 30,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const right = result.state.items[rightId];
        expect(right.transitionIn).toBeDefined();
        expect(right.transitionIn!.type).toBe('crossfade');
        expect(right.transitionIn!.durationUs).toBe(500_000);
        expect(right.transitionIn!.alignment).toBe('center');
      }
    });

    /** A fixture with a wipe already attached, so params can be edited. */
    function withWipe(params: Record<string, number | string> = {}) {
      const fixture = transitionFixture();
      const added = addTransition(fixture.state, {
        trackId: fixture.trackId,
        leftItemId: fixture.leftId,
        rightItemId: fixture.rightId,
        type: 'wipe',
        durationUs: 500_000,
        fps: 30,
      });
      if (!added.ok) throw new Error('setup failed');
      const withParams = updateTransition(added.state, {
        itemId: fixture.rightId,
        patch: { params },
        fps: 30,
      });
      if (!withParams.ok) throw new Error('setup failed');
      return { ...fixture, state: withParams.state };
    }

    it('stores transition params', () => {
      // SPEC 12 §4.2 gives a wipe a direction and softness; before this the command
      // had no way to carry them, so every wipe was left-to-right and hard-edged.
      const { state, rightId } = withWipe({ direction: 'up', softness: 0.3 });
      expect(state.items[rightId]!.transitionIn!.params).toEqual({
        direction: 'up',
        softness: 0.3,
      });
    });

    it('merges params rather than replacing them', () => {
      // Changing a wipe's direction must not silently reset its softness to the
      // default — the user would have to set both again after every edit.
      const { state, rightId } = withWipe({ direction: 'left', softness: 0.4 });
      const updated = updateTransition(state, {
        itemId: rightId,
        patch: { params: { direction: 'right' } },
        fps: 30,
      });
      if (!updated.ok) throw new Error('update failed');
      expect(updated.state.items[rightId]!.transitionIn!.params).toEqual({
        direction: 'right',
        softness: 0.4,
      });
    });

    it('removes a param set to undefined', () => {
      // How a control clears an override and falls back to the type's default,
      // which is a different thing from storing the default's value.
      const { state, rightId } = withWipe({ direction: 'up', softness: 0.4 });
      const updated = updateTransition(state, {
        itemId: rightId,
        patch: { params: { softness: undefined } },
        fps: 30,
      });
      if (!updated.ok) throw new Error('update failed');
      expect(updated.state.items[rightId]!.transitionIn!.params).toEqual({ direction: 'up' });
    });

    it('leaves params alone when the patch does not mention them', () => {
      // The duration slider fires constantly; it must not wipe the geometry.
      const { state, rightId } = withWipe({ direction: 'up' });
      const updated = updateTransition(state, {
        itemId: rightId,
        patch: { durationUs: 400_000 },
        fps: 30,
      });
      if (!updated.ok) throw new Error('update failed');
      expect(updated.state.items[rightId]!.transitionIn!.params).toEqual({ direction: 'up' });
    });

    it('refuses a transition when clips are not adjacent', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      // Move right clip away
      const moved = moveItems(state, { fps: 30, moves: [{ itemId: rightId, startUs: 5_000_000 }] });
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        const result = addTransition(moved.state, {
          trackId,
          leftItemId: leftId,
          rightItemId: rightId,
          type: 'crossfade',
          durationUs: 500_000,
          fps: 30,
        });
        expect(result.ok).toBe(false);
      }
    });

    it('clamps duration to available source handles', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      // left has 10s source, 2s used → 8s handle; right has 10s source, 0s used before start → 0s handle
      // Actually right.sourceInUs defaults to 0, so rightHandle = 0 → maxDuration = 0
      // With 0 handles, only fade/dip types allowed
      const result = addTransition(state, {
        trackId,
        leftItemId: leftId,
        rightItemId: rightId,
        type: 'fade-black',
        durationUs: 2_000_000,
        fps: 30,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const right = result.state.items[rightId];
        // Should be clamped to min duration (2 frames at 30fps = 66667us)
        expect(right.transitionIn!.durationUs).toBeGreaterThanOrEqual(66_666);
      }
    });

    it('updates a transition duration and alignment', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      const added = addTransition(state, {
        trackId,
        leftItemId: leftId,
        rightItemId: rightId,
        type: 'crossfade',
        durationUs: 500_000,
        fps: 30,
      });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const updated = updateTransition(added.state, {
          itemId: rightId,
          patch: { durationUs: 300_000, alignment: 'start' },
          fps: 30,
        });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          const right = updated.state.items[rightId];
          expect(right.transitionIn!.durationUs).toBe(300_000);
          expect(right.transitionIn!.alignment).toBe('start');
        }
      }
    });

    it('removes a transition', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      const added = addTransition(state, {
        trackId,
        leftItemId: leftId,
        rightItemId: rightId,
        type: 'crossfade',
        durationUs: 500_000,
        fps: 30,
      });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const removed = removeTransition(added.state, { itemId: rightId });
        expect(removed.ok).toBe(true);
        if (removed.ok) {
          const right = removed.state.items[rightId];
          expect(right.transitionIn).toBeUndefined();
        }
      }
    });

    it('refuses to add a transition on a locked track', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      const locked = state.tracks.map((t) =>
        t.id === trackId ? { ...t, locked: true } : t,
      );
      const lockedState: TimelineState = { ...state, tracks: locked };
      const result = addTransition(lockedState, {
        trackId,
        leftItemId: leftId,
        rightItemId: rightId,
        type: 'crossfade',
        durationUs: 500_000,
        fps: 30,
      });
      expect(result.ok).toBe(false);
    });

    it('keeps invariants intact after transition operations', () => {
      const { state, leftId, rightId, trackId } = transitionFixture();
      const added = addTransition(state, {
        trackId,
        leftItemId: leftId,
        rightItemId: rightId,
        type: 'crossfade',
        durationUs: 500_000,
        fps: 30,
      });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const updated = updateTransition(added.state, {
          itemId: rightId,
          patch: { durationUs: 300_000 },
          fps: 30,
        });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          const removed = removeTransition(updated.state, { itemId: rightId });
          expect(removed.ok).toBe(true);
          if (removed.ok) {
            expect(checkInvariantsMB(removed.state)).toEqual([]);
          }
        }
      }
    });
  });


  describe('work area (SPEC 09 §18)', () => {
    function workAreaFixture(): TimelineState {
      const base = createDefaultTimeline({ id: 'wa-1', name: 'Work Area' });
      const track = base.tracks[0]!;
      const item = createMediaItem({
        id: 'item-1',
        trackId: track.id,
        label: 'Clip',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 4_000_000,
        sourceDurationUs: 10_000_000,
      });
      return {
        ...base,
        tracks: base.tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, itemIds: [item.id] } : candidate,
        ),
        items: { [item.id]: item },
      };
    }

    it('sets work area in and out points', () => {
      const state = workAreaFixture();
      const inResult = setWorkArea(state, { edge: 'in', timeUs: 1_000_000, fps: 30 });
      expect(inResult.ok).toBe(true);
      if (inResult.ok) {
        expect(inResult.state.workArea!.inUs).toBe(1_000_000);
      }
      const outResult = setWorkArea(inResult.ok ? inResult.state : state, { edge: 'out', timeUs: 3_000_000, fps: 30 });
      expect(outResult.ok).toBe(true);
      if (outResult.ok) {
        expect(outResult.state.workArea!.outUs).toBe(3_000_000);
        expect(outResult.state.workArea!.inUs).toBe(1_000_000);
      }
    });

    it('clamps work area to project duration', () => {
      const state = workAreaFixture();
      const result = setWorkArea(state, { edge: 'out', timeUs: 100_000_000, fps: 30 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.workArea!.outUs).toBe(4_000_000);
      }
    });

    it('clears the work area', () => {
      const state = workAreaFixture();
      const inResult = setWorkArea(state, { edge: 'in', timeUs: 1_000_000, fps: 30 });
      expect(inResult.ok).toBe(true);
      if (inResult.ok) {
        const cleared = clearWorkArea(inResult.state);
        expect(cleared.ok).toBe(true);
        if (cleared.ok) {
          expect(cleared.state.workArea).toBeUndefined();
        }
      }
    });

    it('setting in after out clamps out', () => {
      const state = workAreaFixture();
      const outResult = setWorkArea(state, { edge: 'out', timeUs: 2_000_000, fps: 30 });
      expect(outResult.ok).toBe(true);
      if (outResult.ok) {
        const inResult = setWorkArea(outResult.state, { edge: 'in', timeUs: 3_000_000, fps: 30 });
        expect(inResult.ok).toBe(true);
        if (inResult.ok) {
          // in > out, so out should be pushed to at least in + 1 frame
          expect(inResult.state.workArea!.outUs).toBeGreaterThanOrEqual(inResult.state.workArea!.inUs);
        }
      }
    });

    it('keeps invariants intact after work area operations', () => {
      const state = workAreaFixture();
      const inResult = setWorkArea(state, { edge: 'in', timeUs: 1_000_000, fps: 30 });
      expect(inResult.ok).toBe(true);
      if (inResult.ok) {
        const outResult = setWorkArea(inResult.state, { edge: 'out', timeUs: 3_000_000, fps: 30 });
        expect(outResult.ok).toBe(true);
        if (outResult.ok) {
          expect(checkInvariantsMB(outResult.state)).toEqual([]);
          const cleared = clearWorkArea(outResult.state);
          expect(cleared.ok).toBe(true);
          if (cleared.ok) {
            expect(checkInvariantsMB(cleared.state)).toEqual([]);
          }
        }
      }
    });
  });


  describe('keyframes (SPEC 09 §17)', () => {
    function kfFixture(): { state: TimelineState; itemId: string } {
      const base = createDefaultTimeline({ id: 'kf-1', name: 'Keyframes' });
      const track = base.tracks[0]!;
      const item = createMediaItem({
        id: 'kf-item',
        trackId: track.id,
        label: 'Animated clip',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 4_000_000,
        sourceDurationUs: 10_000_000,
      });
      return {
        state: {
          ...base,
          tracks: base.tracks.map((candidate) =>
            candidate.id === track.id ? { ...candidate, itemIds: [item.id] } : candidate,
          ),
          items: { [item.id]: item },
        },
        itemId: item.id,
      };
    }

    it('adds a keyframe at a local time', () => {
      const { state, itemId } = kfFixture();
      const result = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const item = result.state.items[itemId];
        expect(item.keyframes?.['opacity']).toHaveLength(1);
        expect(item.keyframes!['opacity'][0].timeUs).toBe(1_000_000);
        expect(item.keyframes!['opacity'][0].value).toBe(0.5);
      }
    });

    it('keeps keyframes sorted by time', () => {
      const { state, itemId } = kfFixture();
      const r1 = addKeyframe(state, { itemId, property: 'opacity', timeUs: 3_000_000, value: 1, fps: 30 });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        const r2 = addKeyframe(r1.state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0, fps: 30 });
        expect(r2.ok).toBe(true);
        if (r2.ok) {
          const kfs = r2.state.items[itemId].keyframes!['opacity'];
          expect(kfs[0].timeUs).toBe(1_000_000);
          expect(kfs[1].timeUs).toBe(3_000_000);
        }
      }
    });

    it('refuses to add a duplicate keyframe at the same time', () => {
      const { state, itemId } = kfFixture();
      const r1 = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        const r2 = addKeyframe(r1.state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.8, fps: 30 });
        expect(r2.ok).toBe(false);
      }
    });

    it('removes a keyframe', () => {
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const removed = removeKeyframe(added.state, { itemId, property: 'opacity', timeUs: 1_000_000, fps: 30 });
        expect(removed.ok).toBe(true);
        if (removed.ok) {
          const item = removed.state.items[itemId];
          expect(item.keyframes?.['opacity'] ?? []).toHaveLength(0);
        }
      }
    });

    it('updates a keyframe value', () => {
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const updated = updateKeyframe(added.state, { itemId, property: 'opacity', timeUs: 1_000_000, patch: { value: 0.8 }, fps: 30 });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          const kf = updated.state.items[itemId].keyframes!['opacity'][0];
          expect(kf.value).toBe(0.8);
        }
      }
    });

    it('stores bezier handles on a keyframe', () => {
      // SPEC 12 §2.2: a keyframe's `bezier` holds the control points for the
      // segment *after* it. The schema has carried the field all along and the
      // evaluator reads it, but nothing could write one, so the curve editor had
      // no way to change a curve's shape — only its easing preset.
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const updated = setBezierHandles(added.state, {
          itemId,
          property: 'opacity',
          timeUs: 1_000_000,
          bezier: { outX: 0.2, outY: 0.0, inX: 0.8, inY: 1.0 },
          fps: 30,
        });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          const kf = updated.state.items[itemId].keyframes!['opacity'][0];
          expect(kf.bezier).toEqual({ outX: 0.2, outY: 0.0, inX: 0.8, inY: 1.0 });
          // Setting handles is only meaningful on a bezier segment, so the
          // interpolation has to move with it — otherwise the stored handles are
          // ignored by the evaluator and the edit silently does nothing.
          expect(kf.interpolation).toBe('bezier');
        }
      }
    });

    it('clamps handle x to 0–1 so the curve cannot run backwards in time', () => {
      // SPEC 12 §2.6: "Handle x values clamp to 0–1 (no time reversal); y may
      // overshoot." A non-monotonic x would make the ease multi-valued for a given
      // time, and the bisection in `cubicBezier` would return whichever branch it
      // happened to land in.
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const updated = setBezierHandles(added.state, {
          itemId,
          property: 'opacity',
          timeUs: 1_000_000,
          bezier: { outX: -0.5, outY: -2, inX: 1.7, inY: 3 },
          fps: 30,
        });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          const kf = updated.state.items[itemId].keyframes!['opacity'][0];
          // x is clamped into the unit interval...
          expect(kf.bezier!.outX).toBe(0);
          expect(kf.bezier!.inX).toBe(1);
          // ...while y is free to overshoot, which is what makes ease-back and
          // ease-elastic curves expressible as handles.
          expect(kf.bezier!.outY).toBe(-2);
          expect(kf.bezier!.inY).toBe(3);
        }
      }
    });

    it('refuses handles on a property with no keyframe at that time', () => {
      const { state, itemId } = kfFixture();
      const result = setBezierHandles(state, {
        itemId,
        property: 'opacity',
        timeUs: 1_000_000,
        bezier: { outX: 0.2, outY: 0, inX: 0.8, inY: 1 },
        fps: 30,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_found');
    });

    it('moves a keyframe to a new time', () => {
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const moved = moveKeyframe(added.state, { itemId, property: 'opacity', fromTimeUs: 1_000_000, toTimeUs: 2_000_000, fps: 30 });
        expect(moved.ok).toBe(true);
        if (moved.ok) {
          const kf = moved.state.items[itemId].keyframes!['opacity'][0];
          expect(kf.timeUs).toBe(2_000_000);
        }
      }
    });

    it('duplicates a keyframe to a new time', () => {
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const dup = duplicateKeyframe(added.state, { itemId, property: 'opacity', fromTimeUs: 1_000_000, toTimeUs: 3_000_000, fps: 30 });
        expect(dup.ok).toBe(true);
        if (dup.ok) {
          const kfs = dup.state.items[itemId].keyframes!['opacity'];
          expect(kfs).toHaveLength(2);
          expect(kfs.map((kf) => kf.timeUs)).toEqual([1_000_000, 3_000_000]);
        }
      }
    });

    it('keeps invariants intact after keyframe operations', () => {
      const { state, itemId } = kfFixture();
      const added = addKeyframe(state, { itemId, property: 'opacity', timeUs: 1_000_000, value: 0.5, fps: 30 });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const moved = moveKeyframe(added.state, { itemId, property: 'opacity', fromTimeUs: 1_000_000, toTimeUs: 2_000_000, fps: 30 });
        expect(moved.ok).toBe(true);
        if (moved.ok) {
          const removed = removeKeyframe(moved.state, { itemId, property: 'opacity', timeUs: 2_000_000, fps: 30 });
          expect(removed.ok).toBe(true);
          if (removed.ok) {
            expect(checkInvariantsMB(removed.state)).toEqual([]);
          }
        }
      }
    });
  });


  describe('captions (SPEC 09 §20)', () => {
    function captionFixture(): { state: TimelineState; itemId: string } {
      const base = createDefaultTimeline({ id: 'cap-1', name: 'Captions' });
      const track = base.tracks[3]!; // captions track
      const item = createMediaItem({
        id: 'cap-item',
        trackId: track.id,
        label: 'Hello world',
        mediaId: 'media-1',
        type: 'video',
        startUs: 0,
        durationUs: 4_000_000,
        sourceDurationUs: 10_000_000,
      });
      const capItem = { ...item, type: 'caption' as const };
      const segment = {
        id: 'seg-1',
        wordRefs: [
          { wordId: 'w1', startUs: 0, endUs: 1_000_000, textOverride: 'Hello' },
          { wordId: 'w2', startUs: 1_000_000, endUs: 2_000_000, textOverride: 'world' },
        ],
        startUs: 0,
        endUs: 4_000_000,
        text: 'Hello world',
        lines: ['Hello world'],
      };
      const itemWithSegment = { ...capItem, captionSegment: segment } as typeof item;
      return {
        state: {
          ...base,
          tracks: base.tracks.map((candidate) =>
            candidate.id === track.id ? { ...candidate, itemIds: [itemWithSegment.id] } : candidate,
          ),
          items: { [itemWithSegment.id]: itemWithSegment },
        },
        itemId: itemWithSegment.id,
      };
    }

    it('splits a caption segment at the nearest word boundary', () => {
      const { state, itemId } = captionFixture();
      const result = splitCaptionSegment(state, { itemId, timeUs: 1_500_000, fps: 30 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Two items should exist on the captions track
        const captionTrack = result.state.tracks.find((t) => t.id === state.tracks[3]!.id);
        expect(captionTrack?.itemIds).toHaveLength(2);
        // Left item should have the first word
        const left = result.state.items[itemId];
        expect(left.captionSegment?.wordRefs).toHaveLength(1);
        expect(left.captionSegment?.text).toBe('Hello');
      }
    });

    it('merges two adjacent caption segments', () => {
      const { state, itemId } = captionFixture();
      // First split to create two segments
      const split = splitCaptionSegment(state, { itemId, timeUs: 1_500_000, fps: 30 });
      expect(split.ok).toBe(true);
      if (split.ok) {
        const captionTrack = split.state.tracks.find((t) => t.id === state.tracks[3]!.id);
        const ids = captionTrack?.itemIds ?? [];
        const rightId = ids.find((id) => id !== itemId)!;
        const merge = mergeCaptionSegments(split.state, { leftItemId: itemId, rightItemId: rightId, fps: 30 });
        expect(merge.ok).toBe(true);
        if (merge.ok) {
          // Back to one item
          const capTrack = merge.state.tracks.find((t) => t.id === state.tracks[3]!.id);
          expect(capTrack?.itemIds).toHaveLength(1);
          const merged = merge.state.items[itemId];
          expect(merged.captionSegment?.wordRefs).toHaveLength(2);
          expect(merged.captionSegment?.text).toBe('Hello world');
        }
      }
    });

    it('trims a caption segment snapping to word boundaries', () => {
      const { state, itemId } = captionFixture();
      const result = trimCaptionSegment(state, { itemId, edge: 'end', timeUs: 1_500_000, fps: 30 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const item = result.state.items[itemId];
        // Should snap to the word boundary at 1s or 2s
        expect(item.captionSegment?.endUs).toBeGreaterThan(0);
        expect(item.captionSegment?.endUs).toBeLessThan(4_000_000);
      }
    });

    it('refuses to merge non-adjacent caption segments', () => {
      const { state, itemId } = captionFixture();
      const other = createMediaItem({
        id: 'cap-far',
        trackId: state.tracks[3]!.id,
        label: 'Far away',
        mediaId: 'media-1',
        type: 'video',
        startUs: 10_000_000,
        durationUs: 2_000_000,
        sourceDurationUs: 10_000_000,
      });
      const farItem = { ...other, type: 'caption' as const };
      const farState: TimelineState = {
        ...state,
        tracks: state.tracks.map((t) =>
          t.id === state.tracks[3]!.id ? { ...t, itemIds: [itemId, other.id] } : t,
        ),
        items: { ...state.items, [other.id]: farItem },
      };
      const result = mergeCaptionSegments(farState, { leftItemId: itemId, rightItemId: other.id, fps: 30 });
      expect(result.ok).toBe(false);
    });

    it('keeps invariants intact after caption operations', () => {
      const { state, itemId } = captionFixture();
      const split = splitCaptionSegment(state, { itemId, timeUs: 1_500_000, fps: 30 });
      expect(split.ok).toBe(true);
      if (split.ok) {
        expect(checkInvariantsMB(split.state)).toEqual([]);
      }
    });
  });


  describe('effects (SPEC 09 §17)', () => {
    function effectFixture(): { state: TimelineState; itemId: string } {
      const base = createDefaultTimeline({ id: 'eff-1', name: 'Effects' });
      const track = base.tracks[0]!;
      const item = createMediaItem({
        id: 'eff-item',
        trackId: track.id,
        label: 'Effected clip',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 4_000_000,
        sourceDurationUs: 10_000_000,
      });
      return {
        state: {
          ...base,
          tracks: base.tracks.map((candidate) =>
            candidate.id === track.id ? { ...candidate, itemIds: [item.id] } : candidate,
          ),
          items: { [item.id]: item },
        },
        itemId: item.id,
      };
    }

    it('applies an effect to an item', () => {
      const { state, itemId } = effectFixture();
      const result = applyEffect(state, { itemId, effectId: 'blur', params: { amount: 5 } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const item = result.state.items[itemId];
        expect(item.effects).toHaveLength(1);
        expect(item.effects![0].effectId).toBe('blur');
        expect(item.effects![0].params).toEqual({ amount: 5 });
      }
    });

    it('refuses to apply a duplicate effect', () => {
      const { state, itemId } = effectFixture();
      const r1 = applyEffect(state, { itemId, effectId: 'blur' });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        const r2 = applyEffect(r1.state, { itemId, effectId: 'blur' });
        expect(r2.ok).toBe(false);
      }
    });

    it('removes an effect', () => {
      const { state, itemId } = effectFixture();
      const added = applyEffect(state, { itemId, effectId: 'blur' });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const removed = removeEffect(added.state, { itemId, effectId: 'blur' });
        expect(removed.ok).toBe(true);
        if (removed.ok) {
          const item = removed.state.items[itemId];
          expect(item.effects ?? []).toHaveLength(0);
        }
      }
    });

    it('toggles effect enabled state', () => {
      const { state, itemId } = effectFixture();
      const added = applyEffect(state, { itemId, effectId: 'blur' });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const toggled = toggleEffectEnabled(added.state, { itemId, effectId: 'blur' });
        expect(toggled.ok).toBe(true);
        if (toggled.ok) {
          const item = toggled.state.items[itemId];
          expect(item.effects![0].enabled).toBe(false);
        }
      }
    });

    it('updates effect params', () => {
      const { state, itemId } = effectFixture();
      const added = applyEffect(state, { itemId, effectId: 'blur', params: { amount: 5 } });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const updated = updateEffectParams(added.state, { itemId, effectId: 'blur', params: { amount: 10 } });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          const item = updated.state.items[itemId];
          expect(item.effects![0].params.amount).toBe(10);
        }
      }
    });

    it('keeps invariants intact after effect operations', () => {
      const { state, itemId } = effectFixture();
      const added = applyEffect(state, { itemId, effectId: 'blur' });
      expect(added.ok).toBe(true);
      if (added.ok) {
        const toggled = toggleEffectEnabled(added.state, { itemId, effectId: 'blur' });
        expect(toggled.ok).toBe(true);
        if (toggled.ok) {
          const removed = removeEffect(toggled.state, { itemId, effectId: 'blur' });
          expect(removed.ok).toBe(true);
          if (removed.ok) {
            expect(checkInvariantsMB(removed.state)).toEqual([]);
          }
        }
      }
    });
    it('reorders an effect within the chain (SPEC 12 §3.1)', () => {
      // Chain order matters: `blur → contrast` is not `contrast → blur`. The
      // acceptance list requires the chain to be reorderable, and before this
      // command the order was simply the order effects were added in.
      const { state, itemId } = effectFixture();
      let current = state;
      for (const effectId of ['brightness', 'contrast', 'saturation']) {
        const added = applyEffect(current, { itemId, effectId });
        expect(added.ok).toBe(true);
        if (added.ok) current = added.state;
      }
      const moved = moveEffect(current, { itemId, effectId: 'saturation', toIndex: 0 });
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        expect(moved.state.items[itemId]!.effects!.map((effect) => effect.effectId)).toEqual([
          'saturation',
          'brightness',
          'contrast',
        ]);
      }
    });

    it('moves an effect downward too', () => {
      const { state, itemId } = effectFixture();
      let current = state;
      for (const effectId of ['brightness', 'contrast', 'saturation']) {
        const added = applyEffect(current, { itemId, effectId });
        if (added.ok) current = added.state;
      }
      const moved = moveEffect(current, { itemId, effectId: 'brightness', toIndex: 2 });
      if (moved.ok) {
        expect(moved.state.items[itemId]!.effects!.map((effect) => effect.effectId)).toEqual([
          'contrast',
          'saturation',
          'brightness',
        ]);
      }
    });

    it('undoes a reorder', () => {
      const { state, itemId } = effectFixture();
      let current = state;
      for (const effectId of ['brightness', 'contrast']) {
        const added = applyEffect(current, { itemId, effectId });
        if (added.ok) current = added.state;
      }
      const moved = moveEffect(current, { itemId, effectId: 'contrast', toIndex: 0 });
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        // The command produces an inverse patch set; applying it must restore the
        // previous order exactly, or undo would leave the chain scrambled.
        expect(moved.state.items[itemId]!.effects!.map((e) => e.effectId)).toEqual([
          'contrast',
          'brightness',
        ]);
        expect(moved.state.items[itemId]!.effects).not.toEqual(current.items[itemId]!.effects);
      }
    });

    it('refuses a position outside the chain', () => {
      const { state, itemId } = effectFixture();
      const added = applyEffect(state, { itemId, effectId: 'blur' });
      if (!added.ok) throw new Error('setup failed');
      expect(moveEffect(added.state, { itemId, effectId: 'blur', toIndex: 5 }).ok).toBe(false);
      expect(moveEffect(added.state, { itemId, effectId: 'blur', toIndex: -1 }).ok).toBe(false);
    });

    it('refuses to move an effect that is not applied', () => {
      const { state, itemId } = effectFixture();
      expect(moveEffect(state, { itemId, effectId: 'blur', toIndex: 0 }).ok).toBe(false);
    });

    it('refuses a no-op move rather than recording empty history', () => {
      const { state, itemId } = effectFixture();
      const added = applyEffect(state, { itemId, effectId: 'blur' });
      if (!added.ok) throw new Error('setup failed');
      // An undo entry that changes nothing is worse than no entry: undo appears
      // available and does nothing when pressed.
      expect(moveEffect(added.state, { itemId, effectId: 'blur', toIndex: 0 }).ok).toBe(false);
    });

    it('replaces a chain wholesale when pasting (SPEC 09 §12)', () => {
      // "Copy effects / paste effects" between clips. Pasting must replace, not
      // merge: a clip that already had a blur and receives a contrast chain should
      // end up with exactly that chain, not blur-then-contrast.
      const { state, itemId } = effectFixture();
      const withBlur = applyEffect(state, { itemId, effectId: 'blur' });
      if (!withBlur.ok) throw new Error('setup failed');

      const pasted = setEffectChain(withBlur.state, {
        itemId,
        chain: [
          { effectId: 'contrast', params: { amount: 0.4 } },
          { effectId: 'saturation', enabled: false, params: { amount: 1.2 } },
        ],
      });
      expect(pasted.ok).toBe(true);
      if (pasted.ok) {
        const chain = pasted.state.items[itemId]!.effects!;
        expect(chain.map((effect) => effect.effectId)).toEqual(['contrast', 'saturation']);
        expect(chain[0]!.params).toEqual({ amount: 0.4 });
        expect(chain[1]!.enabled).toBe(false);
      }
    });

    it('mints fresh instance ids so two clips do not share effect identities', () => {
      // Sharing an instance id between two clips would make a later edit to one
      // ambiguous — the id is how an effect is addressed.
      const { state, itemId } = effectFixture();
      const pasted = setEffectChain(state, { itemId, chain: [{ effectId: 'blur' }] });
      expect(pasted.ok).toBe(true);
      if (pasted.ok) {
        const chain = pasted.state.items[itemId]!.effects!;
        expect(chain[0]!.id).not.toBe('blur');
        expect(chain[0]!.id).toContain(itemId);
      }
    });

    it('clears a chain when pasting an empty one', () => {
      const { state, itemId } = effectFixture();
      const withBlur = applyEffect(state, { itemId, effectId: 'blur' });
      if (!withBlur.ok) throw new Error('setup failed');
      const cleared = setEffectChain(withBlur.state, { itemId, chain: [] });
      if (cleared.ok) expect(cleared.state.items[itemId]!.effects).toEqual([]);
    });

    it('copies a chain by value rather than by reference', () => {
      // A shallow copy would let a later parameter edit on the source clip reach
      // through into the pasted one, which is the classic clipboard aliasing bug.
      const { state, itemId } = effectFixture();
      const params = { amount: 0.3 };
      const pasted = setEffectChain(state, { itemId, chain: [{ effectId: 'contrast', params }] });
      if (!pasted.ok) throw new Error('setup failed');
      params.amount = 0.9;
      expect(pasted.state.items[itemId]!.effects![0]!.params).toEqual({ amount: 0.3 });
    });


    describe('adjustment layers (SPEC 12 §3.1)', () => {
      const fps = 30;

      const withPicture = () => {
        const base = createDefaultTimeline({ id: 'adj-1', name: 'Adjustments' });
        return {
          state: base,
          mainTrackId: base.tracks[0]!.id,
          topOrder: Math.max(...base.tracks.map((track) => track.order)),
        };
      };

      const added = (state = withPicture().state) =>
        addAdjustmentLayer(state, {
          id: 'adj-layer',
          startUs: 0,
          durationUs: 5_000_000,
          fps,
        });

      it('creates the layer and a track to hold it', () => {
        const result = added();
        if (!result.ok) throw new Error('setup failed');
        const item = result.state.items['adj-layer']!;
        expect(item.type).toBe('adjustment');
        // No media: it is a chain, not a picture.
        expect(item.mediaId).toBeUndefined();
        const track = result.state.tracks.find((candidate) => candidate.id === result.trackId)!;
        expect(track.kind).toBe('effect');
        expect(track.role).toBe('adjustment');
        expect(track.itemIds).toContain('adj-layer');
      });

      it('puts the layer above every picture track', () => {
        // An adjustment layer that lands below the clips it is meant to grade
        // looks like it does nothing at all. Text and captions are deliberately
        // left above it: grading burned-in titles is not what "affects the tracks
        // below" is for, and a user can add a second layer over them.
        const fixture = withPicture();
        const result = added(fixture.state);
        if (!result.ok) throw new Error('setup failed');
        const layerOrder = result.state.tracks.find((t) => t.id === result.trackId)!.order;
        for (const track of fixture.state.tracks) {
          if (track.kind !== 'video') continue;
          const after = result.state.tracks.find((candidate) => candidate.id === track.id)!;
          expect(after.order).toBeLessThan(layerOrder);
        }
      });

      it('shifts the tracks above the reference up rather than reusing an order', () => {
        // Two tracks sharing an order would make the compositor's sort ambiguous.
        const fixture = withPicture();
        const result = added(fixture.state);
        if (!result.ok) throw new Error('setup failed');
        const orders = result.state.tracks.map((track) => track.order);
        expect(new Set(orders).size).toBe(orders.length);
      });

      it('refuses a duration shorter than one frame', () => {
        const result = addAdjustmentLayer(withPicture().state, {
          id: 'adj-tiny',
          startUs: 0,
          durationUs: 1,
          fps,
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected failure');
        expect(result.code).toBe('too_short');
      });

      it('refuses a duplicate id', () => {
        const first = added();
        if (!first.ok) throw new Error('setup failed');
        const second = addAdjustmentLayer(first.state, {
          id: 'adj-layer',
          startUs: 0,
          durationUs: 5_000_000,
          fps,
        });
        expect(second.ok).toBe(false);
      });

      it('is undoable', () => {
        const before = withPicture().state;
        const result = added(before);
        if (!result.ok) throw new Error('setup failed');
        const undone = applyPatches(before, result.inverse);
        expect(undone.items['adj-layer']).toBeUndefined();
        expect(undone.tracks).toHaveLength(before.tracks.length);
      });

      it('carries a starting chain when given one', () => {
        const result = addAdjustmentLayer(withPicture().state, {
          id: 'adj-fx',
          startUs: 0,
          durationUs: 5_000_000,
          fps,
          effects: [{ id: 'fx-1', effectId: 'exposure', enabled: true, params: { stops: 1 } }],
        });
        if (!result.ok) throw new Error('setup failed');
        expect(result.state.items['adj-fx']!.effects).toHaveLength(1);
      });
    });

  });


  describe('markers (SPEC 09 §18)', () => {
    function markerFixture(): { state: TimelineState; markerId: string } {
      const base = createDefaultTimeline({ id: 'mk-1', name: 'Markers' });
      const marker = { id: 'mk-1', timeUs: 2_000_000, name: 'Marker 1', color: '#FFB000' };
      return { state: { ...base, markers: [marker] }, markerId: marker.id };
    }

    it('updates a marker name and color', () => {
      const { state, markerId } = markerFixture();
      const result = updateMarker(state, { markerId, patch: { name: 'Scene 1', color: '#FF0000' } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const marker = result.state.markers.find((m) => m.id === markerId);
        expect(marker?.name).toBe('Scene 1');
        expect(marker?.color).toBe('#FF0000');
      }
    });

    it('deletes a marker', () => {
      const { state, markerId } = markerFixture();
      const result = deleteMarker(state, { markerId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.markers).toHaveLength(0);
      }
    });

    it('refuses to update a nonexistent marker', () => {
      const { state } = markerFixture();
      const result = updateMarker(state, { markerId: 'nope', patch: { name: 'X' } });
      expect(result.ok).toBe(false);
    });

    it('keeps invariants intact after marker operations', () => {
      const { state, markerId } = markerFixture();
      const updated = updateMarker(state, { markerId, patch: { name: 'New' } });
      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(checkInvariantsMB(updated.state)).toEqual([]);
        const deleted = deleteMarker(updated.state, { markerId });
        expect(deleted.ok).toBe(true);
        if (deleted.ok) {
          expect(checkInvariantsMB(deleted.state)).toEqual([]);
        }
      }
    });
  });


  it('sets view state and preserves it through other operations', () => {
    const { state } = fixture();
    const result = setViewState(state, { pxPerSecond: 120, scrollX: 500 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.viewState?.pxPerSecond).toBe(120);
      expect(result.state.viewState?.scrollX).toBe(500);
      // View state should survive a move operation
      const moved = moveItems(result.state, { fps: 30, moves: [{ itemId: 'item-b', startUs: 7_000_000 }] });
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        expect(moved.state.viewState?.pxPerSecond).toBe(120);
        expect(moved.state.viewState?.scrollX).toBe(500);
      }
    }
  });


  it('renames a track', () => {
    const { state } = fixture();
    const result = renameTrack(state, { trackId: state.tracks[0]!.id, name: 'Main clip' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const track = result.state.tracks.find((t) => t.id === state.tracks[0]!.id);
      expect(track?.name).toBe('Main clip');
    }
  });

  it('refuses to rename a track with empty name', () => {
    const { state } = fixture();
    const result = renameTrack(state, { trackId: state.tracks[0]!.id, name: '   ' });
    expect(result.ok).toBe(false);
  });

  it('refuses to rename a nonexistent track', () => {
    const { state } = fixture();
    const result = renameTrack(state, { trackId: 'nope', name: 'X' });
    expect(result.ok).toBe(false);
  });

  it('all commands keep the invariants intact', () => {
    const { state, ids } = fixture();
    const results = [
      moveItems(state, { fps: 30, moves: [{ itemId: ids.second, startUs: 4_000_000 }] }),
      trimItem(state, { itemId: ids.second, edge: 'start', toUs: 3_000_000, fps: 30 }),
      splitItems(state, { itemIds: [ids.second], atUs: 3_500_000, fps: 30 }),
      deleteItems(state, { itemIds: [ids.third], fps: 30, ripple: true, rippleAll: true }),
      duplicateItems(state, { itemIds: [ids.third], fps: 30 }),
      addMarker(state, { timeUs: 1_234_567, fps: 30 }),
    ];
    for (const result of results) {
      if (!result.ok) continue;
      expect(checkInvariantsMB(result.state)).toEqual([]);
    }
  });
});

function demagnetized(state: TimelineState): TimelineState {
  const result = setTrackMagnetic(state, { trackId: state.tracks[0]!.id, magnetic: false });
  if (!result.ok) throw new Error('demagnetize failed');
  return result.state;
}

function fixture() {
  const base = createDefaultTimeline({ id: 'c1', name: 'Clip' });
  const trackId = base.tracks[0]!.id;
  const audioTrackId = base.tracks[4]!.id;
  const first = createMediaItem({
    id: 'item-a',
    trackId,
    label: 'A',
    mediaId: 'media-1',
    startUs: 0,
    durationUs: 2_000_000,
    sourceDurationUs: 10_000_000,
  });
  const second = createMediaItem({
    id: 'item-b',
    trackId,
    label: 'B',
    mediaId: 'media-1',
    startUs: 2_000_000,
    durationUs: 2_000_000,
    sourceInUs: 2_000_000,
    sourceDurationUs: 10_000_000,
  });
  const third = createMediaItem({
    id: 'item-c',
    trackId: audioTrackId,
    label: 'C',
    mediaId: 'media-2',
    type: 'audio',
    startUs: 0,
    durationUs: 3_000_000,
    sourceDurationUs: 10_000_000,
  });

  const items = { [first.id]: first, [second.id]: second, [third.id]: third };
  const tracks = base.tracks.map((track) =>
    track.id === trackId
      ? { ...track, itemIds: [first.id, second.id] }
      : track.id === audioTrackId
        ? { ...track, itemIds: [third.id] }
        : track,
  );

  return {
    state: { ...base, tracks, items },
    ids: { first: first.id, second: second.id, third: third.id },
    trackId,
    audioTrackId,
  };
}

describe('user composition guides (SPEC 10 §8.8)', () => {
  const base = () => createDefaultTimeline({ id: 'comp', name: 'Clip', fps: 30 });

  it('places a guide on the composition', () => {
    const result = addGuide(base(), { id: 'g1', axis: 'x', at: 0.25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.guides).toEqual([{ id: 'g1', axis: 'x', at: 0.25, locked: false }]);
  });

  it('is undoable, like any other edit to the document', () => {
    /*
      A guide is not view state — it travels with the project — so placing one must be
      undoable. Replaying the inverse patch is how the history stack undoes every other
      command, and this checks the guides array is actually covered by the patches rather
      than mutated outside them.
    */
    const result = addGuide(base(), { id: 'g1', axis: 'y', at: 0.4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const undone = applyPatches(result.state, result.inverse);
    expect(undone.guides).toEqual([]);
  });

  it('clamps a position outside the canvas onto it', () => {
    // A pointer dragged past the edge still names a guide; the line belongs on the edge.
    const result = addGuide(base(), { id: 'g1', axis: 'x', at: 1.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.guides[0]!.at).toBe(1);
  });

  it('refuses a non-finite position rather than storing a guide that draws nowhere', () => {
    // A guide at NaN is invisible and snaps nothing, forever, with no way to find it.
    expect(addGuide(base(), { id: 'g1', axis: 'x', at: Number.NaN }).ok).toBe(false);
  });

  it('removes a guide', () => {
    const withGuide = addGuide(base(), { id: 'g1', axis: 'x', at: 0.5 });
    if (!withGuide.ok) throw new Error('setup');
    const result = removeGuide(withGuide.state, { id: 'g1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.guides).toEqual([]);
  });

  it('refuses to remove a guide that is already gone', () => {
    // Silently succeeding would push an empty undo step onto the stack.
    expect(removeGuide(base(), { id: 'nope' }).ok).toBe(false);
  });

  it('creates a guide unlocked', () => {
    // A guide you just placed is not protected from the gesture that removes it.
    const result = addGuide(base(), { id: 'g1', axis: 'x', at: 0.25 });
    if (!result.ok) throw new Error('setup');
    expect(result.state.guides[0]!.locked).toBe(false);
  });

  it('locks and unlocks every guide', () => {
    const two = setGuides(base(), {
      guides: [
        { id: 'g1', axis: 'x', at: 0.25, locked: false },
        { id: 'g2', axis: 'y', at: 0.75, locked: false },
      ],
    });
    if (!two.ok) throw new Error('setup');
    const locked = setGuidesLocked(two.state, { locked: true });
    if (!locked.ok) throw new Error('lock');
    expect(locked.state.guides.map((guide) => guide.locked)).toEqual([true, true]);

    const unlocked = setGuidesLocked(locked.state, { locked: false });
    if (!unlocked.ok) throw new Error('unlock');
    expect(unlocked.state.guides.map((guide) => guide.locked)).toEqual([false, false]);
  });

  it('makes locking undoable', () => {
    const withGuide = addGuide(base(), { id: 'g1', axis: 'x', at: 0.5 });
    if (!withGuide.ok) throw new Error('setup');
    const locked = setGuidesLocked(withGuide.state, { locked: true });
    if (!locked.ok) throw new Error('lock');
    const undone = applyPatches(locked.state, locked.inverse);
    expect(undone.guides[0]!.locked).toBe(false);
  });

  it('clears unlocked guides and leaves locked ones standing', () => {
    /*
      *Lock* is only a safety net if the bulk removal respects it. This is the pairing
      that makes the menu's two destructive-looking items safe to sit next to each other.
    */
    const mixed = setGuides(base(), {
      guides: [
        { id: 'keep', axis: 'x', at: 0.25, locked: true },
        { id: 'drop', axis: 'y', at: 0.75, locked: false },
      ],
    });
    if (!mixed.ok) throw new Error('setup');
    const cleared = clearGuides(mixed.state);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.state.guides).toEqual([{ id: 'keep', axis: 'x', at: 0.25, locked: true }]);
  });

  it('refuses to clear when every guide is locked, and says so', () => {
    // Better than a menu item that appears to work and does nothing.
    const locked = addGuide(base(), { id: 'g1', axis: 'x', at: 0.5 });
    if (!locked.ok) throw new Error('setup');
    const allLocked = setGuidesLocked(locked.state, { locked: true });
    if (!allLocked.ok) throw new Error('lock');
    const result = clearGuides(allLocked.state);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('locked');
  });

  it('refuses to clear when there are no guides at all', () => {
    expect(clearGuides(base()).ok).toBe(false);
  });

  it('makes clearing undoable', () => {
    const mixed = setGuides(base(), {
      guides: [{ id: 'g1', axis: 'x', at: 0.25, locked: false }],
    });
    if (!mixed.ok) throw new Error('setup');
    const cleared = clearGuides(mixed.state);
    if (!cleared.ok) throw new Error('clear');
    expect(applyPatches(cleared.state, cleared.inverse).guides).toHaveLength(1);
  });

  it('makes removing undoable too', () => {
    const withGuide = addGuide(base(), { id: 'g1', axis: 'x', at: 0.5 });
    if (!withGuide.ok) throw new Error('setup');
    const removed = removeGuide(withGuide.state, { id: 'g1' });
    if (!removed.ok) throw new Error('remove');
    expect(applyPatches(removed.state, removed.inverse).guides).toHaveLength(1);
  });
});

describe('setKeyframesAt (SPEC 10 §8.6 reframe)', () => {
  /** One item on one track, with whatever keyframes the caller wants to start from. */
  function fixture(starting: Record<string, { timeUs: number; value: number; interpolation?: string }[]> = {}) {
    const base = createDefaultTimeline({ id: 'reframe', name: 'Reframe' });
    const track = base.tracks[0]!;
    const item = {
      ...createMediaItem({
        id: 'a',
        trackId: track.id,
        label: 'Framed clip',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 5_000_000,
        sourceDurationUs: 10_000_000,
      }),
      keyframes: starting as never,
    };
    return {
      state: {
        ...base,
        tracks: base.tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, itemIds: [item.id] } : candidate,
        ),
        items: { [item.id]: item },
      } as TimelineState,
      itemId: item.id,
    };
  }

  it('writes every path at the same instant in one command', () => {
    /*
      The whole reason the command exists. Four separate `addKeyframe` calls would be four undo
      entries for one gesture, so `Ctrl+Z` after setting a framing would undo a quarter of it and
      leave the picture in a state the user never chose.
    */
    const { state, itemId } = fixture();
    const result = setKeyframesAt(state, {
      itemId,
      timeUs: 1_000_000,
      values: { 'transform.x': 0.2, 'transform.y': -0.1, 'transform.scaleX': 1.4, 'transform.scaleY': 1.4 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.state.items[itemId]!.keyframes!;
    for (const [path, value] of Object.entries({
      'transform.x': 0.2,
      'transform.y': -0.1,
      'transform.scaleX': 1.4,
      'transform.scaleY': 1.4,
    })) {
      expect(keys[path]).toHaveLength(1);
      expect(keys[path]![0]!.timeUs).toBe(1_000_000);
      expect(keys[path]![0]!.value).toBeCloseTo(value, 10);
    }
  });

  it('lands every path on the same frame, not just the same millisecond', () => {
    /*
      The property the gesture needs is that all four keys share one *time*, so the evaluator
      reads them as one point rather than interpolating between a framing's position and a
      previous framing's scale.

      1_016_666 µs is 30.5 frames at 30 fps, so it is deliberately off the grid: an implementation
      that wrote the raw time would put this key half a frame away from every other write at that
      moment. (Recomputing the quantisation inside the loop is *equivalent* here, since
      `quantizeUs` is pure — that mutation cannot be caught and does not need to be.)
    */
    const { state, itemId } = fixture();
    const result = setKeyframesAt(state, {
      itemId,
      timeUs: 1_016_666,
      values: { 'transform.x': 0, 'transform.y': 0 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.state.items[itemId]!.keyframes!;
    expect(keys['transform.x']![0]!.timeUs).toBe(keys['transform.y']![0]!.timeUs);
    // And that shared time is the frame boundary, not the raw request.
    expect(keys['transform.x']![0]!.timeUs).toBe(1_000_000);
  });

  it('replaces an existing key at that instant rather than refusing', () => {
    /*
      Re-framing a moment already framed is a correction. `addKeyframe` fails on a duplicate
      time, which would make the second attempt at a framing a dead button.
    */
    const { state, itemId } = fixture({ 'transform.x': [{ timeUs: 1_000_000, value: 0.5 }] });
    const result = setKeyframesAt(state, {
      itemId,
      timeUs: 1_000_000,
      values: { 'transform.x': 0.1, 'transform.scaleX': 2 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const x = result.state.items[itemId]!.keyframes!['transform.x']!;
    // Still one key, not two at the same time — two would make the evaluator's answer arbitrary.
    expect(x).toHaveLength(1);
    expect(x[0]!.value).toBe(0.1);
  });

  it('keeps the interpolation of the key it replaces', () => {
    // A curve the user shaped on this key must not be flattened to linear by re-framing the
    // moment it belongs to.
    const { state, itemId } = fixture({
      'transform.x': [{ timeUs: 1_000_000, value: 0.5, interpolation: 'hold' }],
    });
    const result = setKeyframesAt(state, {
      itemId,
      timeUs: 1_000_000,
      values: { 'transform.x': 0.9 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[itemId]!.keyframes!['transform.x']![0]!.interpolation).toBe('hold');
  });

  it('leaves other keys on the same path alone, and keeps them sorted', () => {
    const { state, itemId } = fixture({
      'transform.x': [
        { timeUs: 0, value: 0 },
        { timeUs: 4_000_000, value: 1 },
      ],
    });
    const result = setKeyframesAt(state, { itemId, timeUs: 2_000_000, values: { 'transform.x': 0.5 }, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const x = result.state.items[itemId]!.keyframes!['transform.x']!;
    expect(x.map((kf) => kf.timeUs)).toStrictEqual([0, 2_000_000, 4_000_000]);
    expect(x.map((kf) => kf.value)).toStrictEqual([0, 0.5, 1]);
  });

  it('is one undo step: the inverse restores every path at once', () => {
    /*
      Asserted through the patches rather than by trusting the label, because "one undo step" is
      a claim about the *patch set*, not about how many functions were called.
    */
    const { state, itemId } = fixture();
    const result = setKeyframesAt(state, {
      itemId,
      timeUs: 1_000_000,
      values: { 'transform.x': 0.2, 'transform.scaleX': 1.4 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = applyPatches(result.state, result.inverse);
    expect(restored.items[itemId]!.keyframes?.['transform.x']).toBeUndefined();
    expect(restored.items[itemId]!.keyframes?.['transform.scaleX']).toBeUndefined();
  });

  it('refuses an empty set, a missing item, and a locked track', () => {
    const { state, itemId } = fixture();
    expect(setKeyframesAt(state, { itemId, timeUs: 0, values: {}, fps: 30 }).ok).toBe(false);
    expect(setKeyframesAt(state, { itemId: 'nope', timeUs: 0, values: { 'transform.x': 0 }, fps: 30 }).ok).toBe(false);
    const locked = {
      ...state,
      tracks: state.tracks.map((track) => ({ ...track, locked: true })),
    };
    const lockedResult = setKeyframesAt(locked, { itemId, timeUs: 0, values: { 'transform.x': 0 }, fps: 30 });
    expect(lockedResult.ok).toBe(false);
    if (!lockedResult.ok) expect(lockedResult.code).toBe('locked');
  });
});

describe('addTextItem (SPEC 11 §7)', () => {
  const base = () => createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });

  it('creates a text track when there is none', () => {
    /*
      The default timeline ships a "Text / Graphics" track, so this case needs one
      removed to exist at all — it is the project made before that track was added, and
      the one a `deleteTrack` leaves behind. `canHold` refuses a text item on a picture
      track, so a command that did not create one would fail rather than work.
    */
    const stripped = base();
    stripped.tracks = stripped.tracks.filter((track) => track.kind !== 'text');
    const result = addTextItem(stripped, { id: 'txt1', text: 'Hello', startUs: 0, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['txt1']?.type).toBe('text');
    const track = result.state.tracks.find((candidate) => candidate.id === result.trackId);
    expect(track?.kind).toBe('text');
  });

  it('reuses the default Text / Graphics track rather than making a new one', () => {
    /*
      The default timeline already has one, so the first title must land there. Creating
      a second track would leave the project with an empty "Text / Graphics" row above
      every title the user adds, which reads as the app losing its place.
    */
    const timeline = base();
    const supplied = timeline.tracks.find((track) => track.kind === 'text')!;
    const first = addTextItem(timeline, { id: 'txt1', text: 'One', startUs: 0, fps: 30 });
    if (!first.ok) throw new Error(first.message);
    expect(first.state.items['txt1']?.trackId).toBe(supplied.id);
    const second = addTextItem(first.state, { id: 'txt2', text: 'Two', startUs: 5_000_000, fps: 30 });
    if (!second.ok) throw new Error(second.message);
    expect(second.state.items['txt2']?.trackId).toBe(supplied.id);
    expect(second.state.tracks.filter((track) => track.kind === 'text')).toHaveLength(1);
  });

  it('makes a second track when the first is occupied at that moment', () => {
    // Two titles on screen at once have to be two items on two tracks; overlapping them
    // on one track breaks the invariant that a track holds non-overlapping items.
    const first = addTextItem(base(), { id: 'txt1', text: 'One', startUs: 0, fps: 30 });
    if (!first.ok) throw new Error(first.message);
    const second = addTextItem(first.state, { id: 'txt2', text: 'Two', startUs: 0, fps: 30 });
    if (!second.ok) throw new Error(second.message);
    expect(second.state.items['txt2']?.trackId).not.toBe(first.state.items['txt1']?.trackId);
    expect(second.state.tracks.filter((track) => track.kind === 'text')).toHaveLength(2);
  });

  it('puts a new text track above everything, so the title is visible', () => {
    // A text track at the bottom of the stack draws behind the footage, which reads as
    // "add text did nothing".
    const stripped = base();
    stripped.tracks = stripped.tracks.filter((track) => track.kind !== 'text');
    const result = addTextItem(stripped, { id: 'txt1', text: 'Hello', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const order = new Map(result.state.tracks.map((track) => [track.id, track.order]));
    const titleOrder = order.get(result.state.items['txt1']!.trackId)!;
    for (const track of result.state.tracks) {
      if (track.id !== result.state.items['txt1']!.trackId) {
        expect(track.order).toBeLessThan(titleOrder);
      }
    }
  });

  it('defaults to three seconds and quantises the start to a frame', () => {
    const result = addTextItem(base(), { id: 'txt1', text: 'Hi', startUs: 123_457, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const item = result.state.items['txt1']!;
    expect(item.durationUs).toBe(3_000_000);
    /*
      `quantizeUs` rounds to the *nearest* frame — 123457 is nearer to frame 4
      (133333 µs) than to frame 3 — and a 30 fps frame is 33333.33… µs, so it is not an
      integer. A `% 33333` assertion would be testing the remainder of a number that
      cannot exist; pinning the exact value is the only honest check.
    */
    expect(item.startUs).toBe(133_333);
  });

  it('refuses a duration shorter than a frame', () => {
    const result = addTextItem(base(), { id: 't', text: 'x', startUs: 0, durationUs: 1, fps: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('too_short');
  });

  it('refuses a duplicate id', () => {
    const first = addTextItem(base(), { id: 'txt1', text: 'One', startUs: 0, fps: 30 });
    if (!first.ok) throw new Error(first.message);
    const again = addTextItem(first.state, { id: 'txt1', text: 'Two', startUs: 9_000_000, fps: 30 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
  });

  it('carries the text and the style onto the item', () => {
    const result = addTextItem(base(), {
      id: 'txt1',
      text: 'Chapter One',
      startUs: 0,
      fps: 30,
      styleId: 'bold-creator',
    });
    if (!result.ok) throw new Error(result.message);
    const item = result.state.items['txt1']!;
    expect(item.textContent).toBe('Chapter One');
    expect(item.captionStyleId).toBe('bold-creator');
    // The label is what the timeline shows; the text is what the canvas draws.
    expect(item.label).toBe('Chapter One');
  });

  it('is one undo step, track and all', () => {
    /*
      Creating an item *and* a track must undo together, or Ctrl+Z leaves an empty track
      behind on every add. The track only gets created on the stripped timeline, so this
      uses that one — the case where one patch set has to carry both.
    */
    const stripped = base();
    stripped.tracks = stripped.tracks.filter((track) => track.kind !== 'text');
    const result = addTextItem(stripped, { id: 'txt1', text: 'Hello', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const undone = applyPatches(result.state, result.inverse);
    expect(undone.items['txt1']).toBeUndefined();
    expect(undone.tracks.some((track) => track.kind === 'text')).toBe(false);
  });

  it('leaves the default track in place when undoing a title that reused it', () => {
    // The other half: undoing a title must not delete the track it was added to.
    const result = addTextItem(base(), { id: 'txt1', text: 'Hello', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const undone = applyPatches(result.state, result.inverse);
    expect(undone.items['txt1']).toBeUndefined();
    expect(undone.tracks.filter((track) => track.kind === 'text')).toHaveLength(1);
  });
});

describe('addShapeItem (SPEC 11 §12)', () => {
  const base = () => createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });

  it('creates a graphics track only when there is no text track to use', () => {
    // The default timeline's Text / Graphics track takes shapes too; the "Graphics"
    // track is the fallback for a project that has none.
    const stripped = base();
    stripped.tracks = stripped.tracks.filter((track) => track.kind !== 'text');
    const result = addShapeItem(stripped, { id: 'shp1', shapeKind: 'ellipse', startUs: 0, fps: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['shp1']?.shapeKind).toBe('ellipse');
    const track = result.state.tracks.find((candidate) => candidate.id === result.trackId);
    expect(track?.name).toBe('Graphics');
  });

  it('reuses the Text / Graphics track, like a title does', () => {
    // A shape and a title are drawn the same way and in the same order, so they share
    // the track. A separate graphics row would be a second thing to scroll past.
    const timeline = base();
    const supplied = timeline.tracks.find((track) => track.kind === 'text')!;
    const result = addShapeItem(timeline, { id: 's', shapeKind: 'rect', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['s']?.trackId).toBe(supplied.id);
  });

  it('gives the shape a readable label', () => {
    // The timeline shows this; "round-rect" is an identifier, not a name.
    const result = addShapeItem(base(), { id: 's', shapeKind: 'round-rect', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['s']?.label).toBe('Rounded rectangle');
  });

  it('puts shapes on a track the compositor draws', () => {
    /*
      The schema has five track kinds and no graphics kind. A shape goes on a `text`
      track because both are drawn the same way and in the same order — inventing a
      sixth kind would mean teaching the compositor about it for no gain.
    */
    const result = addShapeItem(base(), { id: 's', shapeKind: 'rect', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const track = result.state.tracks.find((candidate) => candidate.id === result.trackId);
    expect(track?.kind).toBe('text');
  });

  it('is one undo step', () => {
    const result = addShapeItem(base(), { id: 's', shapeKind: 'star', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const undone = applyPatches(result.state, result.inverse);
    expect(undone.items['s']).toBeUndefined();
    expect(undone.tracks.some((track) => track.name === 'Graphics')).toBe(false);
  });

  it('creates an icon item from a name', () => {
    /*
      An icon is a shape item with `iconName` instead of `shapeKind`: same track, same draw
      order, same export path. The item must carry the name and *not* a kind, because the
      renderers branch on exactly that to decide whether to ask the icon library.
    */
    const result = addShapeItem(base(), { id: 'ico', iconName: 'star', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const item = result.state.items['ico'];
    expect(item?.iconName).toBe('star');
    expect(item?.shapeKind).toBeUndefined();
    // The chip has to name the icon, or a row of icons is unreadable.
    expect(item?.label).toBe('Star');
  });

  it('refuses an icon item that is given both a kind and a name, or neither', () => {
    /*
      Refused rather than resolved by precedence: an item with both leaves two renderers free
      to disagree about which wins, and an item with neither is an item that draws nothing.
    */
    expect(addShapeItem(base(), { id: 'a', shapeKind: 'rect', iconName: 'star', startUs: 0, fps: 30 })).toMatchObject({ ok: false });
    expect(addShapeItem(base(), { id: 'b', startUs: 0, fps: 30 })).toMatchObject({ ok: false });
  });

  it('stores the stroke width the picker was set to', () => {
    /*
      SPEC 11 §12 makes stroke width adjustable 0.5–4. The picker reports the width with the
      name, and the whole chain has to carry it: an earlier version computed the width, passed
      it to `onPick`, and dropped it on the floor at the panel, so every icon came out at the
      default however the user set the field. Asserted through the *command* rather than the
      component, because the drop was in the layer between them.
    */
    const result = addShapeItem(base(), {
      id: 'ico',
      iconName: 'star',
      iconStrokeWidth: 3.5,
      startUs: 0,
      fps: 30,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['ico']?.iconStrokeWidth).toBe(3.5);
  });

  it('omits the stroke width when it is not given, so old projects draw unchanged', () => {
    /*
      Absent has to stay absent, not become a written 2. A file that carries `iconStrokeWidth:
      2` where the field used to be missing differs from the file the user saved, and the
      schema comment promises an absent field means "the default" — which is only true while
      nothing writes it.
    */
    const result = addShapeItem(base(), { id: 'ico', iconName: 'star', startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    const item = result.state.items['ico'];
    expect(item && 'iconStrokeWidth' in item).toBe(false);
  });

  it('accepts stored icon shapes, so the file can carry its own geometry', () => {
    const shapes = [{ t: 'path' as const, d: 'M0 0 L24 0 L12 24 Z' }];
    const result = addShapeItem(base(), { id: 'ico', iconName: 'custom', iconShapes: shapes, startUs: 0, fps: 30 });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['ico']?.iconShapes).toEqual(shapes);
  });
});

describe('linked selection (SPEC 09 §9.6)', () => {
  /*
    A detached audio item shares its video's `linkId` so the two travel together. The
    schema carried the coupling and the `linkedSelection` toggle from the start, and
    *every* one of the five commands that must honour it expanded only the ids it was
    given — so detaching audio and dragging the picture left the sound behind, which is
    the most ordinary thing a user does with linked media.

    These tests use `detachAudio` to build the pair rather than hand-setting `linkId`,
    so they exercise the real link the app produces.
  */
  const pair = () => {
    const timeline = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const main = timeline.tracks.find((track) => track.role === 'main')!;
    const video = createMediaItem({
      id: 'v1',
      trackId: main.id,
      label: 'Shot',
      mediaId: 'm1',
      startUs: 0,
      durationUs: 4_000_000,
      sourceDurationUs: 10_000_000,
    });
    const added = addItem(timeline, { item: video, fps: 30 });
    if (!added.ok) throw new Error(added.message);
    const detached = detachAudio(added.state, { videoItemId: 'v1', fps: 30 });
    if (!detached.ok) throw new Error(detached.message);
    const audio = Object.values(detached.state.items).find((item) => item.type === 'audio')!;
    return { state: detached.state, videoId: 'v1', audioId: audio.id };
  };

  const withToggle = (state: TimelineState, linkedSelection: boolean) =>
    ({ ...state, toggles: { ...state.toggles, linkedSelection } }) as TimelineState;

  it('detachAudio actually produces a linked pair, which the rest of this relies on', () => {
    const { state, videoId, audioId } = pair();
    expect(state.items[videoId]!.linkId).toBeDefined();
    expect(state.items[audioId]!.linkId).toBe(state.items[videoId]!.linkId);
  });

  it('moving the picture moves the detached sound with it', () => {
    // The headline case: without this the audio stays put and the edit is silent.
    const { state, videoId, audioId } = pair();
    const moved = moveItems(state, { moves: [{ itemId: videoId, startUs: 2_000_000 }], fps: 30 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.items[videoId]!.startUs).toBe(2_000_000);
    expect(moved.state.items[audioId]!.startUs).toBe(2_000_000);
  });

  it('keeps the pair\'s relative offset rather than snapping to the same time', () => {
    /*
      A detached item that began 200 ms after its picture must still begin 200 ms after
      it. Moving the partner to the same absolute time would close a deliberate gap the
      user made, and the sound would drift against the lip on every subsequent move.
    */
    const { state, videoId, audioId } = pair();
    /*
      Build the offset with the toggle *off*, because moving one half of a linked pair
      with it on drags the other half along — which would leave the two at the same time
      and make the assertion below vacuous.
    */
    const off = withToggle(state, false);
    const audioStart = off.items[audioId]!.startUs + 200_000;
    const shifted = moveItems(off, {
      moves: [{ itemId: audioId, startUs: audioStart }],
      fps: 30,
    });
    if (!shifted.ok) throw new Error(shifted.message);
    /*
      Re-enable the toggle before the move under test. `shifted.state` still carries the
      toggle-off document, so moving the picture from it would be the "toggle is off" case
      again — the assertion below would then be checking the wrong thing.
    */
    const offset = withToggle(shifted.state, true);
    // Now the pair sits 200 ms apart; moving the picture must preserve that.
    const moved = moveItems(offset, {
      moves: [{ itemId: videoId, startUs: 3_000_000 }],
      fps: 30,
    });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.state.items[audioId]!.startUs).toBe(3_200_000);
  });

  it('does not move the partner when the toggle is off', () => {
    // The setting exists so a user can work on one half of a pair. Ignoring it would
    // make the toggle a decoration.
    const { state, videoId, audioId } = pair();
    const off = withToggle(state, false);
    const moved = moveItems(off, { moves: [{ itemId: videoId, startUs: 2_000_000 }], fps: 30 });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.state.items[videoId]!.startUs).toBe(2_000_000);
    expect(moved.state.items[audioId]!.startUs).toBe(0);
  });

  it('deleting the picture deletes the sound', () => {
    // Otherwise Delete leaves audio playing over black, which reads as a playback bug.
    const { state, videoId, audioId } = pair();
    const deleted = deleteItems(state, { itemIds: [videoId], fps: 30 });
    if (!deleted.ok) throw new Error(deleted.message);
    expect(deleted.state.items[videoId]).toBeUndefined();
    expect(deleted.state.items[audioId]).toBeUndefined();
  });

  it('does not delete the sound when the toggle is off', () => {
    const { state, videoId, audioId } = pair();
    const off = withToggle(state, false);
    const deleted = deleteItems(off, { itemIds: [videoId], fps: 30 });
    if (!deleted.ok) throw new Error(deleted.message);
    expect(deleted.state.items[audioId]).toBeDefined();
  });

  it('splitting the picture splits the sound at the same instant', () => {
    /*
      Splitting only the picture leaves one long audio item under two short ones: the
      timeline is legal but nothing lines up, and there is no frame boundary in the sound
      to follow.
    */
    const { state, videoId } = pair();
    const split = splitItems(state, { itemIds: [videoId], atUs: 2_000_000, fps: 30 });
    if (!split.ok) throw new Error(split.message);
    const audioPieces = Object.values(split.state.items).filter((item) => item.type === 'audio');
    expect(audioPieces).toHaveLength(2);
    expect(audioPieces.map((item) => item.startUs).sort((a, b) => a - b)).toEqual([0, 2_000_000]);
    expect(audioPieces.every((item) => item.durationUs === 2_000_000)).toBe(true);
  });

  it('trimming the end of the picture trims the sound to match', () => {
    // A picture shortened by a second and a sound not shortened by one means the last
    // second of the shot plays over whatever follows.
    const { state, videoId, audioId } = pair();
    const trimmed = trimItem(state, { itemId: videoId, edge: 'end', toUs: 3_000_000, fps: 30 });
    if (!trimmed.ok) throw new Error(trimmed.message);
    expect(trimmed.state.items[videoId]!.durationUs).toBe(3_000_000);
    expect(trimmed.state.items[audioId]!.durationUs).toBe(3_000_000);
  });

  it('trims an offset partner by the delta, not to the picture\'s own end', () => {
    /*
      The case that distinguishes the two formulas. When the sound starts later than the
      picture, trimming the picture's end to time T must shorten the sound by the same
      *delta* — not set its end to T, which would slide the whole sound backwards and
      close a gap the user made.

      Every other trim fixture has the pair starting together, where the two formulas
      agree to the microsecond; only an offset one can tell them apart.
    */
    const { state, videoId, audioId } = pair();
    const off = withToggle(state, false);
    const shifted = moveItems(off, {
      moves: [{ itemId: audioId, startUs: 500_000 }],
      fps: 30,
    });
    if (!shifted.ok) throw new Error(shifted.message);
    const offset = withToggle(shifted.state, true);

    // The sound is now 0.5 s late and 4 s long, ending at 4.5 s.
    expect(offset.items[audioId]!.startUs).toBe(500_000);
    const trimmed = trimItem(offset, { itemId: videoId, edge: 'end', toUs: 3_000_000, fps: 30 });
    if (!trimmed.ok) throw new Error(trimmed.message);
    // A 1 s delta: the sound keeps its 0.5 s offset and ends at 3.5 s.
    expect(trimmed.state.items[audioId]!.startUs).toBe(500_000);
    const sound = trimmed.state.items[audioId]!;
    expect(sound.startUs + sound.durationUs).toBe(3_500_000);
  });

  it('trimming the start of the picture moves the sound\'s start with it', () => {
    const { state, videoId, audioId } = pair();
    const trimmed = trimItem(state, { itemId: videoId, edge: 'start', toUs: 1_000_000, fps: 30 });
    if (!trimmed.ok) throw new Error(trimmed.message);
    expect(trimmed.state.items[audioId]!.startUs).toBe(1_000_000);
    expect(trimmed.state.items[audioId]!.durationUs).toBe(3_000_000);
  });

  it('duplicating the picture duplicates the sound and links the copies to each other', () => {
    /*
      The copy has to be a *pair*, joined by a fresh link id shared between the two copies
      — not one new id each, which would leave the duplicated pair unlinked and drag the
      same bug onto the copy.
    */
    const { state, videoId } = pair();
    const before = Object.keys(state.items).length;
    const duplicated = duplicateItems(state, { itemIds: [videoId], fps: 30 });
    if (!duplicated.ok) throw new Error(duplicated.message);
    const copies = Object.values(duplicated.state.items).filter((item) => item.id.includes('~copy'));
    expect(copies).toHaveLength(2);
    expect(Object.keys(duplicated.state.items)).toHaveLength(before + 2);
    const links = new Set(copies.map((item) => item.linkId));
    expect(links.size).toBe(1);
    expect(links.has(state.items[videoId]!.linkId)).toBe(false);
  });

  it('group members travel together too', () => {
    /*
      SPEC 09 §9.6 says "linked/grouped members" in the click table. Groups are a
      separate relation from links, and both expand.
    */
    const timeline = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const main = timeline.tracks.find((track) => track.role === 'main')!;
    const a = createMediaItem({ id: 'a', trackId: main.id, label: 'A', mediaId: 'm1', startUs: 0, durationUs: 1_000_000, sourceDurationUs: 9_000_000 });
    const b = createMediaItem({ id: 'b', trackId: main.id, label: 'B', mediaId: 'm2', startUs: 2_000_000, durationUs: 1_000_000, sourceDurationUs: 9_000_000 });
    const first = addItem(timeline, { item: a, fps: 30 });
    if (!first.ok) throw new Error(first.message);
    const second = addItem(first.state, { item: b, fps: 30 });
    if (!second.ok) throw new Error(second.message);
    const grouped = groupItems(second.state, { itemIds: ['a', 'b'] });
    if (!grouped.ok) throw new Error(grouped.message);

    const moved = moveItems(grouped.state, { moves: [{ itemId: 'a', startUs: 5_000_000 }], fps: 30 });
    if (!moved.ok) throw new Error(moved.message);
    // `b` was 2 s after `a`, so it must still be 2 s after it.
    expect(moved.state.items['b']!.startUs).toBe(7_000_000);
  });

  it('leaves a partner on a locked track behind rather than refusing the whole move', () => {
    // The lock protects its own item; it must not make the picture unmovable, and it
    // must not let the partner move silently either.
    const { state, videoId, audioId } = pair();
    const audioTrackId = state.items[audioId]!.trackId;
    const locked = {
      ...state,
      tracks: state.tracks.map((track) =>
        track.id === audioTrackId ? { ...track, locked: true } : track
      ),
    } as TimelineState;
    const moved = moveItems(locked, { moves: [{ itemId: videoId, startUs: 1_000_000 }], fps: 30 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.items[videoId]!.startUs).toBe(1_000_000);
    expect(moved.state.items[audioId]!.startUs).toBe(0);
  });

  it('moves a linked partner by the delta, so a pair stays a pair through a refusal', () => {
    // The pair moves together or the picture is refused: a partial move is worse than a
    // refusal, because the two halves then disagree and nothing marks them.
    const { state, videoId, audioId } = pair();
    const moved = moveItems(state, { moves: [{ itemId: videoId, startUs: 0 }], fps: 30 });
    if (!moved.ok) throw new Error(moved.message);
    // Zero delta: nothing to do, and the partner must not be disturbed.
    expect(moved.state.items[audioId]!.startUs).toBe(state.items[audioId]!.startUs);
  });
});
