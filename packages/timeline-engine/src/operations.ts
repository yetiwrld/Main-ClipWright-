import type { Item, Marker, Track } from '@clipwright/project-schema';
import type { TimelineState } from './state.js';
import { collisionsOnTrack } from './state.js';

export const newItem = (partial: Partial<Item> & Pick<Item, 'id' | 'trackId' | 'kind' | 'startUs' | 'durationUs'>): Item => ({
  name: '', inUs: 0, volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false,
  transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false },
  effects: [],
  ...partial,
});

export const addItem = (s: TimelineState, item: Item): TimelineState => ({ ...s, items: [...s.items, item] });

export const removeItems = (s: TimelineState, ids: readonly string[]): TimelineState => {
  const set = new Set(ids);
  return { ...s, items: s.items.filter((i) => !set.has(i.id)) };
};

export const canPlace = (s: TimelineState, item: Item): boolean =>
  collisionsOnTrack(s, item.trackId, item.startUs, item.durationUs, item.id).length === 0;

/** Move an item (optionally to another track). Returns null if it would overlap. */
export const moveItem = (
  s: TimelineState, itemId: string, newStartUs: number, newTrackId?: string,
): TimelineState | null => {
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return s;
  const moved: Item = { ...item, startUs: Math.max(0, Math.round(newStartUs)), trackId: newTrackId ?? item.trackId };
  if (!canPlace(s, moved)) return null;
  return { ...s, items: s.items.map((i) => (i.id === itemId ? moved : i)) };
};

/** Trim the start of an item; adjusts inUs for media. Returns null if below 1 frame. */
export const trimItemStart = (s: TimelineState, itemId: string, newStartUs: number): TimelineState => {
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return s;
  const endUs = item.startUs + item.durationUs;
  const clamped = Math.max(0, Math.min(Math.round(newStartUs), endUs - 1));
  const delta = clamped - item.startUs;
  if (delta > 0 && !canPlace(s, { ...item, startUs: clamped, durationUs: item.durationUs - delta })) return s;
  const adjusted: Item = {
    ...item, startUs: clamped, durationUs: endUs - clamped, inUs: Math.max(0, item.inUs + delta),
  };
  return { ...s, items: s.items.map((i) => (i.id === itemId ? adjusted : i)) };
};

/** Trim the end of an item. */
export const trimItemEnd = (s: TimelineState, itemId: string, newEndUs: number): TimelineState => {
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return s;
  const clamped = Math.max(item.startUs + 1, Math.round(newEndUs));
  if (!canPlace(s, { ...item, durationUs: clamped - item.startUs })) return s;
  const adjusted: Item = { ...item, durationUs: clamped - item.startUs };
  return { ...s, items: s.items.map((i) => (i.id === itemId ? adjusted : i)) };
};

/** Split an item at an absolute time. Returns the state with two items, or unchanged. */
export const splitItem = (s: TimelineState, itemId: string, atUs: number): TimelineState => {
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return s;
  const at = Math.round(atUs);
  if (at <= item.startUs || at >= item.startUs + item.durationUs) return s;
  const left: Item = { ...item, durationUs: at - item.startUs };
  const right: Item = {
    ...item,
    id: `${item.id}~${at.toString(36)}`,
    startUs: at,
    durationUs: item.startUs + item.durationUs - at,
    inUs: item.inUs + (at - item.startUs),
  };
  return { ...s, items: [...s.items.filter((i) => i.id !== itemId), left, right] };
};

/** Ripple-delete a range on one track: remove overlapping items and shift the tail left. */
export const rippleDeleteRange = (s: TimelineState, trackId: string, fromUs: number, toUs: number): TimelineState => {
  const amount = toUs - fromUs;
  if (amount <= 0) return s;
  const items: Item[] = [];
  for (const item of s.items) {
    if (item.trackId !== trackId) { items.push(item); continue; }
    const end = item.startUs + item.durationUs;
    if (end <= fromUs) { items.push(item); continue; }           // before range
    if (item.startUs >= toUs) {                                   // after range
      items.push({ ...item, startUs: item.startUs - amount });
      continue;
    }
    // overlaps the range: keep left and/or right remainders
    if (item.startUs < fromUs) {
      items.push({ ...item, durationUs: fromUs - item.startUs });
    }
    if (end > toUs) {
      items.push({
        ...item,
        id: `${item.id}~r${fromUs.toString(36)}`,
        startUs: fromUs,
        durationUs: end - toUs,
        inUs: item.inUs + (toUs - item.startUs),
      });
    }
  }
  const markers = s.markers.map((m) =>
    m.timeUs >= toUs ? { ...m, timeUs: m.timeUs - amount } : m,
  );
  return { ...s, items, markers };
};

/** Insert: push items on the track at/after atUs right by amount. */
export const insertSpace = (s: TimelineState, trackId: string, atUs: number, amountUs: number): TimelineState => ({
  ...s,
  items: s.items.map((i) => (i.trackId === trackId && i.startUs >= atUs ? { ...i, startUs: i.startUs + amountUs } : i)),
  markers: s.markers.map((m) => (m.timeUs >= atUs ? { ...m, timeUs: m.timeUs + amountUs } : m)),
});

export const addTrack = (s: TimelineState, track: Track): TimelineState => ({ ...s, tracks: [...s.tracks, track] });

export const removeTrack = (s: TimelineState, trackId: string): TimelineState => ({
  ...s,
  tracks: s.tracks.filter((t) => t.id !== trackId),
  items: s.items.filter((i) => i.trackId !== trackId),
});

export const updateTrack = (s: TimelineState, trackId: string, patch: Partial<Track>): TimelineState => ({
  ...s,
  tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, ...patch, id: t.id } : t)),
});

export const addMarker = (s: TimelineState, marker: Marker): TimelineState => ({ ...s, markers: [...s.markers, marker] });
export const removeMarker = (s: TimelineState, markerId: string): TimelineState => ({ ...s, markers: s.markers.filter((m) => m.id !== markerId) });

/** Total duration = end of the latest item. */
export const timelineDurationUs = (s: TimelineState): number =>
  s.items.reduce((end, i) => Math.max(end, i.startUs + i.durationUs), 0);

/** Active items at a time (for preview/export planning). */
export const itemsAt = (s: TimelineState, timeUs: number): Item[] =>
  s.items.filter((i) => timeUs >= i.startUs && timeUs < i.startUs + i.durationUs);
