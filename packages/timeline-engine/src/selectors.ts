// Read-only queries over a composition payload (SPEC 09 §2). The UI reads every
// derived value from here so that no component invents its own timeline maths.

import type { CompositionPayload, TimelineItem, Track } from '@clipwright/project-schema';
import { frameDurationUs, quantizeUs, type Fps } from './time';

export type TimelineState = CompositionPayload;

export function sortedItemsOfTrack(state: TimelineState, trackId: string): TimelineItem[] {
  const track = state.tracks.find((candidate) => candidate.id === trackId);
  const ids = track ? new Set(track.itemIds) : null;
  const items = Object.values(state.items).filter(
    (item) => (ids ? ids.has(item.id) : true) && item.trackId === trackId,
  );
  return items.sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
}

export function itemEndUs(item: { startUs: number; durationUs: number }): number {
  return item.startUs + item.durationUs;
}

/** End of the last item on any visible track, at least one second (SPEC 09 §3). */
export function projectDurationUs(state: TimelineState): number {
  let end = 0;
  for (const track of state.tracks) {
    if (track.hidden) continue;
    for (const id of track.itemIds) {
      const item = state.items[id];
      if (item) end = Math.max(end, itemEndUs(item));
    }
  }
  return Math.max(end, 1_000_000);
}

/** Duration used by the ruler and fit-to-project: includes hidden tracks. */
export function contentDurationUs(state: TimelineState): number {
  let end = 0;
  for (const item of Object.values(state.items)) end = Math.max(end, itemEndUs(item));
  return end;
}

export function mainTrack(state: TimelineState): Track | undefined {
  return state.tracks.find((track) => track.role === 'main');
}

export function tracksInDrawOrder(state: TimelineState): Track[] {
  return [...state.tracks].sort((a, b) => b.order - a.order);
}

export function itemsAt(state: TimelineState, us: number, trackId?: string): TimelineItem[] {
  return Object.values(state.items).filter(
    (item) =>
      (!trackId || item.trackId === trackId) && us >= item.startUs && us < itemEndUs(item),
  );
}

/** Every item edge, plus zero — the candidates Up/Down jump between. */
export function editPointsUs(state: TimelineState): number[] {
  const points = new Set<number>([0]);
  for (const item of Object.values(state.items)) {
    points.add(item.startUs);
    points.add(itemEndUs(item));
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * Snap targets from SPEC 09 §14: playhead, every item edge, markers, work-area
 * ends and the timeline start. Caption word boundaries are added by the caption
 * feature once captions exist.
 */
export function snapPoints(state: TimelineState, playheadUs: number): number[] {
  const points = new Set<number>([0, playheadUs]);
  for (const item of Object.values(state.items)) {
    points.add(item.startUs);
    points.add(itemEndUs(item));
  }
  for (const marker of state.markers) points.add(marker.timeUs);
  if (state.workArea) {
    points.add(state.workArea.inUs);
    points.add(state.workArea.outUs);
  }
  return [...points].sort((a, b) => a - b);
}

export interface SnapResult {
  us: number;
  snappedTo: number | null;
}

/**
 * Snap to the nearest target within `thresholdPx`, at any zoom (SPEC 09 §14).
 * Times are quantised to the frame grid either way.
 */
export function snapUs(
  us: number,
  points: readonly number[],
  pxPerSecond: number,
  fps: Fps,
  thresholdPx = 8,
): SnapResult {
  const thresholdUs = (thresholdPx / Math.max(0.01, pxPerSecond)) * 1_000_000;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point - us);
    if (distance <= thresholdUs && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  if (best === null) return { us: quantizeUs(us, fps), snappedTo: null };
  return { us: quantizeUs(best, fps), snappedTo: quantizeUs(best, fps) };
}

/** Frame index range visible in a viewport, with one frame of tail. */
export function visibleFrameRange(
  scrollX: number,
  viewportWidth: number,
  pxPerSecond: number,
  fps: Fps,
): { fromFrame: number; toFrame: number } {
  const pxPerUs = pxPerSecond / 1_000_000;
  const fromUs = Math.max(0, scrollX / pxPerUs);
  const toUs = (scrollX + viewportWidth) / pxPerUs;
  return {
    fromFrame: Math.floor((fromUs * fps) / 1_000_000),
    toFrame: Math.ceil((toUs * fps) / 1_000_000) + 1,
  };
}

export function minItemDurationUs(fps: Fps): number {
  return frameDurationUs(fps);
}
