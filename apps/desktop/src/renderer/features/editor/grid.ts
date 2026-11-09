/**
 * The composition grid (SPEC 10 §8.8, §9).
 *
 * The spec describes one overlay with two settings — "3×3 thirds (default) or custom
 * N×M" — so this module is a single idea: a grid is a pair of divisors, and the lines
 * are wherever the divisions fall. The thirds are not a special case in the drawing code,
 * they are `{ columns: 3, rows: 3 }`, which is why the same `Ctrl+'` draws both and why
 * the snapping path has one definition of "grid line" rather than two.
 *
 * Everything here is a fraction of the canvas measured from the **top-left**, because
 * that is the space the lines are drawn in. Snapping works from the centre, and the
 * conversion happens once in `snapping.ts` the way it does for the safe areas.
 */

/** A grid, as the number of cells across and down. */
export interface GridSpec {
  columns: number;
  rows: number;
}

/**
 * The default, and the one the spec names explicitly.
 *
 * Stored as a name rather than as `{3, 3}` so that "did the user ask for a grid or am I
 * drawing the default?" is a question the type can answer: `preset` means the thirds,
 * `custom` means whatever `spec` says. Without that, changing the default would silently
 * change every composition that never asked for one.
 */
export const THIRDS_GRID: GridSpec = { columns: 3, rows: 3 };

/**
 * The smallest and largest divisor the editor will accept.
 *
 * Two, because a grid of one is not a grid — it is the canvas edge, which is already a
 * snap target. Twelve, because past that the cells are smaller than the guide label on a
 * typical preview and the lines stop reading as a grid at all; the cap also bounds the
 * cost of drawing, which matters because every line is a DOM node.
 */
export const GRID_MIN = 2;
export const GRID_MAX = 12;

/**
 * Coerces anything into a usable divisor, or `null` when it cannot be.
 *
 * Deliberately total rather than throwing: the values arrive from a number input, where
 * the user can and will type nothing, `-`, `2.5` or `99`, and a grid that disappeared
 * mid-keystroke would be unusable. A non-number returns `null` so the caller can keep the
 * previous value instead of collapsing to the minimum, which would make clearing the
 * field snap the grid to 2×2.
 */
export function clampDivisor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  /*
    A blank string is checked *before* `Number()` rather than by its result: `Number('')`
    and `Number('   ')` are both `0`, not `NaN`, so a test for `NaN` alone would let a
    cleared field through as zero and clamp it to the minimum — snapping the grid to 2×2
    on the keystroke that emptied the box.
  */
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(numeric)));
}

/**
 * Where the lines fall on one axis, as fractions.
 *
 * `n` divisions give `n - 1` lines, and the outer edges are **not** included: the canvas
 * border is already a snap target and already visible, so a line drawn on top of it would
 * be a second target in exactly the same place — the tie-break would then decide which,
 * and the guide label would name a grid line for a clip that snapped to the edge.
 */
export function gridLines(divisions: number): number[] {
  const count = clampDivisor(divisions) ?? GRID_MIN;
  const lines: number[] = [];
  for (let index = 1; index < count; index += 1) lines.push(index / count);
  return lines;
}

/**
 * The lines of a grid, already assigned to the axis they run across.
 *
 * A vertical line is at a fixed `x`, the same convention `user-guides.ts` uses for `axis`
 * — kept identical deliberately, because the two sets of lines are snapped to by the same
 * code and a flipped convention between them would be invisible until a clip jumped.
 */
export function gridTargetLines(spec: GridSpec): { x: number[]; y: number[] } {
  return { x: gridLines(spec.columns), y: gridLines(spec.rows) };
}

/** The overlay's grid setting: the spec's default, or the user's own divisors. */
export type GridChoice =
  | { preset: 'thirds' }
  | { preset: 'custom'; spec: GridSpec };

/** The default — what `Ctrl+'` turns on, and what it meant before custom grids existed. */
export const GRID_THIRDS: GridChoice = { preset: 'thirds' };

/** The divisors to draw, whichever setting is in force. */
export function effectiveGrid(choice: GridChoice): GridSpec {
  return choice.preset === 'thirds' ? THIRDS_GRID : choice.spec;
}

/**
 * A short human name for the setting, for the button that opens the grid controls.
 *
 * `3×3` rather than `Thirds` in the custom case, because the user typed those numbers and
 * seeing them echoed is how they know the change took.
 */
export function gridLabel(choice: GridChoice): string {
  const spec = effectiveGrid(choice);
  return `${spec.columns}×${spec.rows}`;
}

/** Whether the setting is the spec's default, which the menu marks. */
export function isThirds(choice: GridChoice): boolean {
  return choice.preset === 'thirds';
}
