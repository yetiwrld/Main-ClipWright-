import type { Composition, Item, Marker, Track } from '@clipwright/project-schema';

/** A pure, immutable-ish timeline document. All operations return new arrays. */
export interface TimelineState {
  tracks: Track[];
  items: Item[];
  markers: Marker[];
}

export const stateFromComposition = (c: Composition): TimelineState => ({
  tracks: [...c.tracks].sort((a, b) => a.order - b.order),
  items: c.items.map((i) => ({ ...i })),
  markers: c.markers.map((m) => ({ ...m })),
});

export const emptyTrack = (id: string, type: Track['type'], name: string, order: number): Track => ({
  id, type, name, order,
  locked: false, hidden: false, height: 64,
});

export const overlaps = (aStart: number, aDur: number, bStart: number, bDur: number): boolean =>
  aStart < bStart + bDur && bStart < aStart + aDur;

/** Items on a track that intersect [startUs, startUs+durationUs), excluding `excludeId`. */
export const collisionsOnTrack = (
  state: TimelineState, trackId: string, startUs: number, durationUs: number, excludeId?: string,
): Item[] =>
  state.items.filter(
    (i) => i.trackId === trackId && i.id !== excludeId && overlaps(startUs, durationUs, i.startUs, i.durationUs),
  );

export const itemsOnTrack = (state: TimelineState, trackId: string): Item[] =>
  state.items.filter((i) => i.trackId === trackId).sort((a, b) => a.startUs - b.startUs);

export const trackAt = (state: TimelineState, trackId: string): Track | undefined =>
  state.tracks.find((t) => t.id === trackId);
