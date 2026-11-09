/**
 * The alignment lines a snap is currently using (SPEC 10 §8.8).
 *
 * A snap that moves the picture without showing *why* is indistinguishable from the
 * clip jumping — which is the anxiety the whole feature exists to remove. So the line is
 * not decoration: it is the difference between "the editor is fighting me" and "the
 * editor is helping me".
 *
 * Drawn in the same space as the overlays and the selection, above the picture and below
 * the handles, and never reachable by a pointer.
 */
import { memo } from 'react';
import type { SnapGuide } from './snapping.js';

export interface SnapGuidesProps {
  guides: { x: SnapGuide | null; y: SnapGuide | null };
}

/**
 * The distance a guide shows, or `null` when there is nothing worth saying.
 *
 * Rounded to whole pixels: a label reading `2.3899 px` is noise at the moment it appears,
 * and sub-pixel precision is not information anyone acts on during a drag.
 *
 * A zero is dropped rather than shown. It means the item was already exactly on the line
 * when the drag arrived, which is common — sliding along the canvas centre line keeps
 * re-snapping to it — and a label pinned at `0 px` reads as a stuck overlay rather than
 * as alignment.
 */
export function guideLabel(deltaPx: number): string | null {
  if (!Number.isFinite(deltaPx)) return null;
  const rounded = Math.round(Math.abs(deltaPx));
  return rounded === 0 ? null : `${rounded} px`;
}

/**
 * A target's position as a percentage of the canvas.
 *
 * Targets are canvas fractions measured from the *centre* (−0.5..0.5), while CSS
 * positions from the top-left. The half-canvas shift is the whole conversion, and it is
 * exactly the kind of off-by-a-half that draws a guide somewhere plausible and wrong.
 */
export function guidePercent(at: number): number {
  return (at + 0.5) * 100;
}

export const SnapGuides = memo(function SnapGuides({ guides }: SnapGuidesProps) {
  if (!guides.x && !guides.y) return null;
  /*
    Both axes when both bit: a drag into a corner snaps on two lines at once, and showing
    only one of the two distances would understate what just happened.
  */
  const guideLabels = [guides.x, guides.y]
    .map((guide) => (guide ? guideLabel(guide.deltaPx) : null))
    .filter((label): label is string => label !== null);
  return (
    <div
      data-testid="snap-guides"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}
    >
      {guides.x ? (
        <div
          data-testid="snap-guide-x"
          data-kind={guides.x.target.kind}
          style={{
            position: 'absolute',
            left: `${guidePercent(guides.x.target.at)}%`,
            top: 0,
            // A hairline, not a band: a guide is meant to be read past, and a 2 px line
            // at 25% opacity still covers the edge it is pointing at.
            width: 1,
            height: '100%',
            background: 'var(--brand)',
            opacity: 0.6,
          }}
        />
      ) : null}
      {guides.y ? (
        <div
          data-testid="snap-guide-y"
          data-kind={guides.y.target.kind}
          style={{
            position: 'absolute',
            top: `${guidePercent(guides.y.target.at)}%`,
            left: 0,
            height: 1,
            width: '100%',
            background: 'var(--brand)',
            opacity: 0.6,
          }}
        />
      ) : null}
      {/*
        The distance label (SPEC 10 §8.8). Placed at the crossing of the two lines when
        both are present, so one label serves the gesture instead of two competing ones —
        and offset a little from the crossing so it does not sit under the line itself.

        `pointerEvents: none` is inherited from the wrapper; the label must never be
        something the pointer can hit, or a snap would make the canvas ungrabbable at
        exactly the place the user is dragging.
      */}
      {guideLabels.length > 0 ? (
        <div
          data-testid="snap-guide-label"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: guides.x ? `${guidePercent(guides.x.target.at)}%` : '50%',
            top: guides.y ? `${guidePercent(guides.y.target.at)}%` : '50%',
            transform: 'translate(8px, 8px)',
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-overlay)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
          }}
        >
          {guideLabels.join(' · ')}
        </div>
      ) : null}
    </div>
  );
});
