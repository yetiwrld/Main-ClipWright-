import { describe, expect, it } from 'vitest';
import type { Track } from '@clipwright/project-schema';
import {
  History, addItem, addMarker, addTrack, canPlace, collisionsOnTrack, itemsAt,
  moveItem, newItem, removeItems, rippleDeleteRange, snapTime, splitItem,
  stateFromComposition, timelineDurationUs, trimItemEnd, trimItemStart,
} from '../src/index.js';
import { CompositionSchema } from '@clipwright/project-schema';

const track = (id: string, order = 0): Track => ({ id, type: 'video', name: id, order, locked: false, hidden: false, height: 64 });
const mk = (id: string, trackId: string, startUs: number, durationUs: number) =>
  newItem({ id, trackId, kind: 'video', startUs, durationUs, inUs: 0 });

const baseState = () => ({
  tracks: [track('t1', 0), track('t2', 1)],
  items: [mk('a', 't1', 1_000_000, 2_000_000), mk('b', 't1', 4_000_000, 2_000_000)],
  markers: [],
});

describe('placement & overlap', () => {
  it('detects collisions on the same track only', () => {
    const s = baseState();
    expect(collisionsOnTrack(s, 't1', 1_500_000, 500_000).map((i) => i.id)).toEqual(['a']);
    expect(collisionsOnTrack(s, 't2', 1_500_000, 500_000)).toEqual([]);
    expect(canPlace(s, mk('x', 't1', 1_500_000, 500_000))).toBe(false);
    expect(canPlace(s, mk('x', 't1', 3_000_000, 900_000))).toBe(true);
  });

  it('moveItem refuses overlapping placements, allows free ones', () => {
    const s = baseState();
    expect(moveItem(s, 'a', 4_000_000)).toBeNull();
    const moved = moveItem(s, 'a', 6_100_000);
    expect(moved?.items.find((i) => i.id === 'a')?.startUs).toBe(6_100_000);
    const toOther = moveItem(s, 'a', 1_000_000, 't2');
    expect(toOther?.items.find((i) => i.id === 'a')?.trackId).toBe('t2');
  });

  it('rejects negative placement', () => {
    const moved = moveItem(baseState(), 'a', -5);
    expect(moved?.items.find((i) => i.id === 'a')?.startUs).toBe(0);
  });
});

describe('trim and split', () => {
  it('trim start adjusts inUs', () => {
    const s = trimItemStart(baseState(), 'a', 1_500_000);
    const a = s.items.find((i) => i.id === 'a')!;
    expect(a.startUs).toBe(1_500_000);
    expect(a.durationUs).toBe(1_500_000);
    expect(a.inUs).toBe(500_000);
  });

  it('trim end clamps to at least 1us and respects collisions', () => {
    const s = trimItemEnd(baseState(), 'a', 900_000); // would be shorter than start
    expect(s.items.find((i) => i.id === 'a')!.durationUs).toBe(1);
    const s2 = trimItemEnd(baseState(), 'a', 5_000_000); // would overlap b
    expect(s2.items.find((i) => i.id === 'a')!.durationUs).toBe(2_000_000);
  });

  it('split duplicates item into two adjacent items with correct inUs', () => {
    const s = splitItem(baseState(), 'a', 2_000_000);
    const left = s.items.find((i) => i.id === 'a')!;
    const right = s.items.find((i) => i.id.startsWith('a~'))!;
    expect(left.durationUs).toBe(1_000_000);
    expect(right.startUs).toBe(2_000_000);
    expect(right.inUs).toBe(1_000_000);
    expect(right.durationUs).toBe(1_000_000);
  });

  it('split outside the item is a no-op', () => {
    const s = baseState();
    expect(splitItem(s, 'a', 0).items).toHaveLength(2);
    expect(splitItem(s, 'a', 3_000_000).items).toHaveLength(2);
  });
});

describe('ripple delete', () => {
  it('removes covered items and shifts the tail left', () => {
    const s = { ...baseState(), markers: [{ id: 'm1', timeUs: 5_000_000, label: '', color: '#fff' }] };
    const out = rippleDeleteRange(s, 't1', 2_000_000, 4_000_000);
    // a was [1,3) → keeps [1,2); b was [4,6) → shifts to [2,4)
    const a = out.items.find((i) => i.id === 'a')!;
    const b = out.items.find((i) => i.id === 'b')!;
    expect(a.durationUs).toBe(1_000_000);
    expect(b.startUs).toBe(2_000_000);
    expect(out.markers[0]!.timeUs).toBe(3_000_000);
  });
});

describe('snapping', () => {
  it('snaps within threshold and reports the target', () => {
    const targets = [{ timeUs: 1_000_000, kind: 'item-edge' as const }];
    const hit = snapTime(1_004_000, targets, 10_000);
    expect(hit.timeUs).toBe(1_000_000);
    expect(hit.snappedTo?.kind).toBe('item-edge');
    const miss = snapTime(1_100_000, targets, 10_000);
    expect(miss.timeUs).toBe(1_100_000);
    expect(miss.snappedTo).toBeNull();
  });
});

describe('history / undo', () => {
  it('undo and redo move through recorded edits', () => {
    const h = new History(10);
    let s = baseState();
    const before = s;
    s = addItem(s, mk('c', 't2', 0, 1_000_000));
    s = h.record(s, 'add item', before);
    expect(s.items).toHaveLength(3);
    const undo1 = h.undo(s);
    expect(undo1.state.items).toHaveLength(2);
    expect(undo1.name).toBe('add item');
    const redo1 = h.redo(undo1.state);
    expect(redo1.state.items).toHaveLength(3);
  });

  it('record clears the redo stack', () => {
    const h = new History();
    let s = baseState();
    s = h.record(addItem(s, mk('c', 't2', 0, 1_000_000)), 'add', s);
    h.undo(s);
    s = h.record(removeItems(baseState(), ['a']), 'remove', baseState());
    expect(h.canRedo()).toBe(false);
  });
});

describe('queries', () => {
  it('itemsAt returns active items and timelineDurationUs works', () => {
    const s = baseState();
    expect(itemsAt(s, 1_500_000).map((i) => i.id)).toEqual(['a']);
    expect(timelineDurationUs(s)).toBe(6_000_000);
  });

  it('stateFromComposition round-trips items and sorts tracks', () => {
    const comp = CompositionSchema.parse({
      id: 'c1', projectId: 'p1', name: 'n', createdAt: 1, updatedAt: 1,
      tracks: [track('b', 1), track('a', 0)],
      items: [mk('i', 'a', 0, 1000)],
    });
    const s = stateFromComposition(comp);
    expect(s.tracks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.items).toHaveLength(1);
  });
});
