/**
 * The equal-spacing hint (SPEC 10 §8.8's "distance guides between three items").
 *
 * Two spans of equal length, drawn between three items, saying "these gaps now match".
 * It is not a guide line: a line answers "what is this aligned to?", a span answers "how
 * much room is there?", and drawing a spacing hint as a hairline on a target would say
 * the wrong thing entirely.
 *
 * Drawn only while the drag is in flight, in the same space as the snap guides, and never
 * reachable by a pointer.
 */
import { memo } from 'react';
import type { SpacingSpan } from './snapping.js';
import { guidePercent } from './SnapGuides.js';

export interface SpacingHintsProps {
  /** The two equal gaps, or empty. */
  spans: readonly SpacingSpan[];
}

/**
 * How far off the canvas centre to draw the bar, as a percentage.
 *
 * A spacing hint has no position of its own — it says "these two gaps are the same" and
 * the number is on the bar. Drawing it along the centre line keeps it out of the way of
 * both gaps' own edges, and keeps it in one place while the user drags, so the eye is not
 * chasing it.
 */
export const SPACING_BAR_OFFSET = '50%';

export const SpacingHints = memo(function SpacingHints({ spans }: SpacingHintsProps) {
  if (spans.length === 0) return null;
  return (
    <div data-testid="spacing-hints" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
      {spans.map((span, index) => {
        /*
          The bar is drawn along the axis the gaps run along: a horizontal gap is a
          horizontal bar. `guidePercent` is the same top-left conversion the guide lines
          use, and reusing it is what keeps a hint from landing half a canvas out.
        */
        const start = Math.min(span.from, span.to);
        const end = Math.max(span.from, span.to);
        return (
          <div
            key={index}
            data-testid={`spacing-hint-${index}`}
            style={{
              position: 'absolute',
              /*
                Rounded to a thousandth of a percent. Not for precision — a sub-pixel is
                invisible — but because binary floating point turns a clean fraction into
                `9.999999999999998%`, and an artefact that shows up in the DOM is an
                artefact someone will one day assert on.
              */
              left: `${Math.round(guidePercent(start) * 1000) / 1000}%`,
              top: SPACING_BAR_OFFSET,
              width: `${Math.round((end - start) * 100_000) / 1000}%`,
              height: 1,
              background: 'var(--brand)',
              opacity: 0.6,
            }}
          />
        );
      })}
    </div>
  );
});
