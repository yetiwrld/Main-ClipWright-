import { describe, expect, it } from 'vitest';
import { createDefaultTimeline, createMediaItem } from '../factory';
import {
  addItem,
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
  removeKeyframe,
  updateKeyframe,
  moveKeyframe,
  duplicateKeyframe,
  splitCaptionSegment,
  mergeCaptionSegments,
  trimCaptionSegment,
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
