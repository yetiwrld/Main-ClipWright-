// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SpacingHints } from '../features/editor/SpacingHints.js';

/**
 * The equal-spacing hint (SPEC 10 §8.8).
 *
 * Two equal bars saying "these gaps match". The maths that *finds* a spacing is tested in
 * `snapping.test.ts`; what is checked here is that it is drawn where it says it is.
 */

const span = (from: number, to: number) => ({ from, to, length: Math.abs(to - from) });

afterEach(cleanup);

describe('drawing a spacing hint', () => {
  it('draws nothing when there is no spacing to show', () => {
    // The drag has a spacing on most pointer moves only once it is nearly equal, so this
    // is the common case and must not leave an empty overlay tree behind.
    render(<SpacingHints spans={[]} />);
    expect(screen.queryByTestId('spacing-hints')).toBeNull();
  });

  it('draws one bar per gap', () => {
    // Two gaps is the whole idea: one bar cannot say "these match".
    render(<SpacingHints spans={[span(-0.4, -0.15), span(0.15, 0.4)]} />);
    expect(screen.getByTestId('spacing-hint-0')).toBeTruthy();
    expect(screen.getByTestId('spacing-hint-1')).toBeTruthy();
    expect(screen.queryByTestId('spacing-hint-2')).toBeNull();
  });

  it('positions a bar with the same centre-to-top-left shift the guides use', () => {
    /*
      −0.4 to −0.15 is 25% of the canvas starting at 10% across, because −0.4 in
      centre-relative fractions is 0.1 of the width from the left. Getting this wrong
      draws the hint half a canvas away from the gap it describes — the same failure the
      guide lines guard against, and just as plausible-looking.
    */
    render(<SpacingHints spans={[span(-0.4, -0.15)]} />);
    const bar = screen.getByTestId('spacing-hint-0');
    expect(bar.style.left).toBe('10%');
    expect(bar.style.width).toBe('25%');
  });

  it('draws both bars the same length, since the gaps are equal', () => {
    // If the two bars differ, either the maths or the drawing is wrong — and this is the
    // one property the hint is making a claim about.
    render(<SpacingHints spans={[span(-0.4, -0.15), span(0.15, 0.4)]} />);
    expect(screen.getByTestId('spacing-hint-0').style.width).toBe(
      screen.getByTestId('spacing-hint-1').style.width,
    );
  });

  it('normalises a span given right-to-left', () => {
    // The maths returns spans in whichever order the neighbours were found in.
    render(<SpacingHints spans={[span(-0.15, -0.4)]} />);
    const bar = screen.getByTestId('spacing-hint-0');
    expect(bar.style.left).toBe('10%');
    expect(bar.style.width).toBe('25%');
  });

  it('is invisible to the pointer', () => {
    // A hint that could be hit would make the canvas ungrabbable where a user is dragging.
    render(<SpacingHints spans={[span(-0.4, -0.15)]} />);
    expect(screen.getByTestId('spacing-hints').getAttribute('aria-hidden')).toBe('true');
  });
});
