/**
 * User-placed composition guides (SPEC 10 §8.8).
 *
 * Unlike the safe areas and the thirds — which are view state, computed from data and
 * never written — a user guide is something the user *made*. It marks where this video's
 * subject sits, and it has to survive the session. So it lives on the composition
 * (`guides`), travels with the project, and snap targets follow it.
 *
 * The storage space is a fraction of the canvas measured from the **top-left**, which is
 * the space the guides are drawn in. The snapping code works from the centre, so the
 * conversion happens once, here, on the way in — the same discipline `targetsForLines`
 * follows for the thirds.
 */

/** The smallest distance, as a fraction, between two guides on the same axis. */
export const MIN_GUIDE_GAP = 0.005;

/**
 * How close to an edge a `Ctrl`-drag counts as starting *from* that edge.
 *
 * Six percent, which is about the width of the preview's own padding at a typical size —
 * near enough that a user reaching for the edge does not have to aim, far enough that an
 * ordinary drag over the picture is never mistaken for one.
 */
export const EDGE_GRAB_FRACTION = 0.06;

/** Which edge a `Ctrl`-drag began on, if any. */
export function edgeAt(
  fractionX: number,
  fractionY: number,
  grab = EDGE_GRAB_FRACTION,
): 'left' | 'right' | 'top' | 'bottom' | null {
  if (!Number.isFinite(fractionX) || !Number.isFinite(fractionY)) return null;
  // The nearest edge wins, so a drag from a corner produces one guide rather than two.
  const distances = [
    { edge: 'left' as const, distance: fractionX },
    { edge: 'right' as const, distance: 1 - fractionX },
    { edge: 'top' as const, distance: fractionY },
    { edge: 'bottom' as const, distance: 1 - fractionY },
  ];
  const nearest = distances.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best,
  );
  return nearest.distance <= grab ? nearest.edge : null;
}

/**
 * Which axis a guide made from this edge runs on.
 *
 * A vertical guide has a fixed `x`. Pulling from a left or right edge makes a vertical
 * one; pulling from the top or bottom makes a horizontal one.
 */
export function axisForEdge(edge: 'left' | 'right' | 'top' | 'bottom'): 'x' | 'y' {
  return edge === 'left' || edge === 'right' ? 'x' : 'y';
}

/**
 * A guide as the model stores it.
 *
 * `[key: string]: unknown` because the schema is `.passthrough()`: a guide written by a
 * newer version keeps its extra fields through a round-trip, so the type has to admit
 * them or every call site would need a cast. The three known fields are what this module
 * reads.
 */
export interface UserGuideRecord {
  id: string;
  axis: 'x' | 'y';
  at: number;
  [key: string]: unknown;
}

/**
 * Adds a guide, replacing one that is already practically in the same place.
 *
 * Two guides half a percent apart are one guide the user placed twice; keeping both makes
 * a snapping mess (two targets a hair apart, and the tie-break decides at random) and a
 * canvas nobody can tidy without deleting twice. The *new* position wins, because the
 * last thing the user did is what they meant.
 */
export function addGuide(
  guides: readonly UserGuideRecord[],
  guide: UserGuideRecord,
  minGap = MIN_GUIDE_GAP,
): UserGuideRecord[] {
  if (!Number.isFinite(guide.at)) return [...guides];
  const at = Math.min(1, Math.max(0, guide.at));
  const kept = guides.filter(
    (existing) => existing.axis !== guide.axis || Math.abs(existing.at - at) >= minGap,
  );
  return [...kept, { ...guide, at }];
}

/** Removes a guide by id. Removing something absent is not an error. */
export function removeGuide(
  guides: readonly UserGuideRecord[],
  id: string,
): UserGuideRecord[] {
  return guides.filter((guide) => guide.id !== id);
}

/**
 * The snap lines a set of guides offers on one axis.
 *
 * Returned in centre-relative fractions, the space snapping works in — the shift is the
 * whole conversion, and it lives here rather than at each call site for the reason the
 * overlay targets do: getting it wrong puts every guide snap half a canvas out, and it
 * looks entirely plausible while doing so.
 */
export function guideSnapTargets(
  guides: readonly UserGuideRecord[],
  axis: 'x' | 'y',
): { at: number; kind: 'user-guide' }[] {
  return guides
    .filter((guide) => guide.axis === axis && Number.isFinite(guide.at))
    .map((guide) => ({ at: guide.at - 0.5, kind: 'user-guide' as const }));
}
