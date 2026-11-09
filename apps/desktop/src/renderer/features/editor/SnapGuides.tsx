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
import type { SnapTarget } from './snapping.js';

export interface SnapGuidesProps {
  guides: { x: SnapTarget | null; y: SnapTarget | null };
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
  return (
    <div
      data-testid="snap-guides"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}
    >
      {guides.x ? (
        <div
          data-testid="snap-guide-x"
          data-kind={guides.x.kind}
          style={{
            position: 'absolute',
            left: `${guidePercent(guides.x.at)}%`,
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
          data-kind={guides.y.kind}
          style={{
            position: 'absolute',
            top: `${guidePercent(guides.y.at)}%`,
            left: 0,
            height: 1,
            width: '100%',
            background: 'var(--brand)',
            opacity: 0.6,
          }}
        />
      ) : null}
    </div>
  );
});
