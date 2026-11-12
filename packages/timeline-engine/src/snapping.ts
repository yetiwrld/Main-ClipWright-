/** Snapping: 8 screen px at the given px/us scale. */
export interface SnapTarget { timeUs: number; kind: 'playhead' | 'item-edge' | 'marker' | 'zero'; }

export const SNAP_PX = 8;
/** Convert 8 screen px to µs at a given zoom (px per microsecond). */
export const snapThresholdUs = (pxPerUs: number): number => Math.round(SNAP_PX / pxPerUs);

export const collectSnapTargets = (
  playheadUs: number,
  itemEdges: number[],
  markers: number[],
): SnapTarget[] => [
  { timeUs: playheadUs, kind: 'playhead' },
  { timeUs: 0, kind: 'zero' },
  ...itemEdges.map((timeUs) => ({ timeUs, kind: 'item-edge' as const })),
  ...markers.map((timeUs) => ({ timeUs, kind: 'marker' as const })),
];

/**
 * Snap `timeUs` to the nearest target within thresholdUs.
 * Returns the snapped time and the target if any.
 */
export const snapTime = (
  timeUs: number, targets: SnapTarget[], thresholdUs: number,
): { timeUs: number; snappedTo: SnapTarget | null } => {
  let best: SnapTarget | null = null;
  let bestDist = thresholdUs + 1;
  for (const t of targets) {
    const d = Math.abs(t.timeUs - timeUs);
    if (d <= thresholdUs && d < bestDist) { bestDist = d; best = t; }
  }
  return best ? { timeUs: best.timeUs, snappedTo: best } : { timeUs, snappedTo: null };
};
