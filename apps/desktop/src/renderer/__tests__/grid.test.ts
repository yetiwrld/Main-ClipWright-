/**
 * The composition grid's arithmetic (SPEC 10 §8.8, §9).
 *
 * A grid is a divisor pair and the lines are wherever the divisions fall — the thirds are
 * `3×3` and nothing else. Everything here is a fraction from the top-left, the space the
 * lines are drawn in; the centre-relative conversion belongs to `snapping.ts` and is
 * checked there.
 */
import { describe, expect, it } from 'vitest';
import {
  GRID_MAX,
  GRID_MIN,
  GRID_THIRDS,
  THIRDS_GRID,
  clampDivisor,
  effectiveGrid,
  gridLabel,
  gridLines,
  gridTargetLines,
  isThirds,
} from '../features/editor/grid.js';

describe('grid lines', () => {
  it('puts the thirds where the thirds have always been', () => {
    /*
      The regression that matters most: this overlay has been the rule of thirds since it
      existed, so making it a divisor pair must not move the lines by so much as a pixel.
      `toBeCloseTo` because 2/3 is not exact in binary and comparing the literals directly
      is how a correct implementation fails.
    */
    const lines = gridLines(3);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBeCloseTo(1 / 3, 10);
    expect(lines[1]).toBeCloseTo(2 / 3, 10);
  });

  it('gives n - 1 lines for n divisions', () => {
    // Four cells need three internal lines; the count is the whole geometry.
    expect(gridLines(4)).toHaveLength(3);
    expect(gridLines(12)).toHaveLength(11);
  });

  it('leaves the frame edges out', () => {
    /*
      The edge is already visible and already a snap target. A line drawn on it would be a
      second target in exactly the same place, and the tie-break would then decide which
      one a clip caught — the label naming a grid line for a clip that snapped to the edge.
    */
    const lines = gridLines(4);
    expect(lines).not.toContain(0);
    expect(lines).not.toContain(1);
    expect(Math.min(...lines)).toBeGreaterThan(0);
    expect(Math.max(...lines)).toBeLessThan(1);
  });

  it('spaces the lines evenly across the frame', () => {
    // Even is the only thing a grid claims. Computed rather than listed, so the test is
    // about the arithmetic and not about 0.25 being typed seven times.
    const lines = gridLines(5);
    for (let index = 0; index < lines.length; index += 1) {
      expect(lines[index]).toBeCloseTo((index + 1) / 5, 10);
    }
  });

  it('puts the columns on x and the rows on y', () => {
    /*
      A vertical line has a fixed x, the same convention `user-guides.ts` uses for `axis`.
      The two sets are snapped to by one piece of code, so a flipped convention between
      them would be invisible until a clip jumped sideways.
    */
    const lines = gridTargetLines({ columns: 4, rows: 2 });
    expect(lines.x).toHaveLength(3);
    expect(lines.y).toHaveLength(1);
    expect(lines.y[0]).toBe(0.5);
  });
});

describe('choosing a grid', () => {
  it('starts as the thirds', () => {
    // The spec's default, and what `Ctrl+'` has always drawn.
    expect(isThirds(GRID_THIRDS)).toBe(true);
    expect(effectiveGrid(GRID_THIRDS)).toEqual(THIRDS_GRID);
  });

  it('draws a custom grid from its own divisors', () => {
    expect(effectiveGrid({ preset: 'custom', spec: { columns: 5, rows: 4 } })).toEqual({
      columns: 5,
      rows: 4,
    });
  });

  it('names itself by its divisors', () => {
    /*
      The label is how the setting is visible at all — the lines themselves say nothing
      about whether they are 3×3 or 5×4. The thirds read as `3×3` too, because that is what
      they are; calling them "Thirds" would be two names for one setting in a menu that has
      to compare them.
    */
    expect(gridLabel(GRID_THIRDS)).toBe('3×3');
    expect(gridLabel({ preset: 'custom', spec: { columns: 5, rows: 4 } })).toBe('5×4');
  });
});

describe('a divisor typed by hand', () => {
  it('rounds a fraction to the nearest whole number', () => {
    // `2.5` is what someone types when they mean three but are not sure the field takes
    // integers.
    expect(clampDivisor('2.5')).toBe(3);
    expect(clampDivisor(2.4)).toBe(2);
  });

  it('clamps rather than refusing, inside the range', () => {
    expect(clampDivisor(1)).toBe(GRID_MIN);
    expect(clampDivisor(99)).toBe(GRID_MAX);
    expect(clampDivisor(-4)).toBe(GRID_MIN);
  });

  it('refuses a value that cannot be a grid at all', () => {
    /*
      `null` rather than the minimum, deliberately: an empty field has to be able to stay
      empty while it is being cleared and re-typed. Answering `2` there would snap the grid
      to 2×2 for one keystroke, which is a flash the user did not ask for. The dialog uses
      `null` to disable its own Apply button.
    */
    expect(clampDivisor('')).toBeNull();
    expect(clampDivisor('   ')).toBeNull();
    expect(clampDivisor('abc')).toBeNull();
    expect(clampDivisor(Number.NaN)).toBeNull();
    expect(clampDivisor(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampDivisor(null)).toBeNull();
    expect(clampDivisor(undefined)).toBeNull();
  });

  it('accepts a numeric string, which is what a text field gives', () => {
    expect(clampDivisor('4')).toBe(4);
    expect(clampDivisor(' 6 ')).toBe(6);
  });

  it('never yields a number `gridLines` would choke on', () => {
    // The two functions are checked together because the invariant is about the pair: any
    // divisor that survives `clampDivisor` has to produce a usable set of lines.
    for (const raw of ['', 'abc', '1', '2.5', '99', '-3', String(Number.NaN)]) {
      const divisor = clampDivisor(raw);
      if (divisor === null) continue;
      const lines = gridLines(divisor);
      expect(lines.length).toBe(divisor - 1);
      expect(lines.every((line) => line > 0 && line < 1)).toBe(true);
    }
  });
});

describe('gridLines against a nonsense divisor', () => {
  it('falls back to the minimum rather than drawing nothing', () => {
    /*
      `gridLines` is called with a stored divisor, so it cannot rely on the dialog having
      validated anything. A zero would draw no lines at all and the overlay would look
      broken with no message; `NaN` would draw nothing for the same reason.
    */
    expect(gridLines(0)).toHaveLength(1);
    expect(gridLines(Number.NaN)).toHaveLength(1);
  });

  it('caps at the maximum however large the number', () => {
    // A thousand lines are a thousand DOM nodes, so the cap is a performance bound as well
    // as a legibility one.
    expect(gridLines(500)).toHaveLength(GRID_MAX - 1);
  });
});
