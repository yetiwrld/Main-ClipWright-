/**
 * A framing as it is stored, for the reframe gesture's signatures.
 *
 * Split into its own file purely so `reframe.ts` can be imported by tests that run in a plain
 * Node environment: a type-only import would be erased anyway, but keeping the shape here means
 * a reader can see the unit of account without scrolling through the gesture's arithmetic.
 *
 * The units are the item's own: `x`/`y` are fractions of the canvas side, so a framing means
 * the same thing at proxy size and at export size, and `scale` is the same per-axis number the
 * transform stores.
 */
export interface ExistingFraming {
  x?: number;
  y?: number;
  scale?: number;
}
