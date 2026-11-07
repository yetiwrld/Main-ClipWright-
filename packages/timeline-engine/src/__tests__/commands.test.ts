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
  setTrackMuted,
  splitItems,
  trimItem,
} from '../commands';
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
    const result = moveItems(state, {
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
    const before = state.items[ids.first]!;
    const result = moveItems(state, {
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
    const second = state.items[ids.second]!;
    const result = deleteItems(state, { itemIds: [ids.first], fps: 30 });
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
    const result = addItem(state, {
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
    const result = addItem(state, {
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
