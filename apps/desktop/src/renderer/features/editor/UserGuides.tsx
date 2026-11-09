/**
 * The user's own composition guides (SPEC 10 §8.8).
 *
 * Unlike the safe areas and the thirds these are document state, so they draw whether or
 * not the compliance overlay is on — they are the user's marks, not the app's advice — and
 * they persist with the project.
 *
 * Drawn above the picture and below the handles, and `pointerEvents: none` throughout: a
 * guide is something to line things up against, never something that can take a drag away
 * from the clip underneath. Removing one is a click on the *layer* of the guides menu, not
 * on the line itself, precisely so a line across the picture never becomes a target.
 */
import { memo } from 'react';
import type { UserGuideRecord } from './user-guides.js';

export interface UserGuidesProps {
  guides: readonly UserGuideRecord[];
}

export const UserGuides = memo(function UserGuides({ guides }: UserGuidesProps) {
  if (guides.length === 0) return null;
  return (
    <div
      data-testid="user-guides"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}
    >
      {guides.map((guide) => (
        <div
          key={guide.id}
          data-testid={`user-guide-${guide.id}`}
          data-axis={guide.axis}
          style={
            guide.axis === 'x'
              ? {
                  /*
                    Multiplied straight to a percentage, with no half-canvas shift: a
                    stored guide is already a fraction from the top-left, which *is* the
                    space CSS positions in. The shift belongs only in `guideSnapTargets`,
                    where the value has to become centre-relative for snapping — doing it
                    here as well would cancel out, and looking symmetrical while being
                    wrong is how that mistake survives review.
                  */
                  position: 'absolute',
                  left: `${guide.at * 100}%`,
                  top: 0,
                  width: 1,
                  height: '100%',
                  background: 'var(--brand-amber)',
                  opacity: 0.55,
                }
              : {
                  position: 'absolute',
                  top: `${guide.at * 100}%`,
                  left: 0,
                  height: 1,
                  width: '100%',
                  background: 'var(--brand-amber)',
                  opacity: 0.55,
                }
          }
        />
      ))}
    </div>
  );
});
