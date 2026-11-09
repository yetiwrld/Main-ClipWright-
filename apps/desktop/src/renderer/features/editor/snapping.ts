/**
 * Object snapping for canvas drags (SPEC 10 §8.8).
 *
 * Everything here is in **canvas fractions**, the same unit `transform.x`/`y` use, so
 * a snap moves the model by exactly the amount the guide shows. Pixels appear only in
 * one place — the 8 px threshold — because the spec measures the snap *distance* on
 * screen (a zoom-independent "close enough"), while the *result* has to be a document
 * value.
 *
 * That split is the whole design. A threshold in fractions would snap from further away
 * on a wide window than on a narrow one; a result in pixels would need converting back
 * before it could be stored, and the conversion is where rounding drifts in.
 */

/** One alignment candidate: a line the dragged item's edge or centre can land on. */
export interface SnapTarget {
  /** Position in canvas fractions, measured from the canvas centre. */
  at: number;
  /** What this line is, for choosing which guide to draw and for tests. */
  kind: 'canvas-centre' | 'canvas-edge' | 'item-edge' | 'item-centre';
}

/** The edges and centre of an item, in canvas fractions from the canvas centre. */
export interface ItemBounds {
  left: number;
  centre: number;
  right: number;
}

/** A snap that happened: which edge landed, on what, and where it ended up. */
export interface SnapResult {
  /** The position after snapping, in canvas fractions. */
  position: number;
  /** The target line that was hit, or `null` when nothing was near enough. */
  target: SnapTarget | null;
  /** How far the position moved to land on it, in canvas fractions. */
  delta: number;
}

/**
 * The default snap distance, in screen pixels (SPEC 10 §8.8).
 *
 * Eight pixels is not arbitrary: it is about the distance at which a pointer can still
 * be said to have aimed at a line rather than merely passed it.
 */
export const SNAP_PX = 8;

/**
 * The alignment lines a drag should consider on one axis.
 *
 * Canvas centre, both canvas edges, and the edges and centres of every other item. The
 * spec also lists safe-area edges and the grid; neither is a *document* line, so both
 * arrive as targets from the caller rather than being computed here.
 */
export function snapTargetsFor(
  axis: 'x' | 'y',
  options: {
    /** Every other visible item's bounds on this axis. */
    others: readonly ItemBounds[];
  },
): SnapTarget[] {
  const targets: SnapTarget[] = [
    // The canvas spans −0.5..0.5 around its centre, so its centre line is 0 and its
    // edges are half a canvas out.
    { at: 0, kind: 'canvas-centre' },
    { at: -0.5, kind: 'canvas-edge' },
    { at: 0.5, kind: 'canvas-edge' },
  ];
  for (const other of options.others) {
    targets.push({ at: other.left, kind: 'item-edge' });
    targets.push({ at: other.centre, kind: 'item-centre' });
    targets.push({ at: other.right, kind: 'item-edge' });
  }
  return targets;
}

/**
 * Snap one axis of a drag.
 *
 * The item's own three lines — leading edge, centre, trailing edge — are each tested
 * against every target, and the *closest* pairing wins. Testing all three is what makes
 * the gesture feel like it understands intent: dragging a clip's left edge toward
 * another's left edge snaps flush, while dragging its centre toward that same line snaps
 * centred, and the user gets whichever they aimed at without choosing a mode.
 *
 * `threshold` is in fractions (converted from `SNAP_PX` by the caller, which knows the
 * canvas size). `halfExtent` is the item's half-size on this axis, so the edges can be
 * derived from the centre position.
 */
export function snapAxis(
  position: number,
  halfExtent: number,
  targets: readonly SnapTarget[],
  threshold: number,
): SnapResult {
  /*
    `Number.isFinite(threshold)` rather than `threshold <= 0`, and the difference is the
    whole guard. Every comparison against `NaN` is false, so `Math.abs(delta) > NaN` never
    skips a candidate — a NaN threshold silently accepts *every* target and snaps the item
    to whichever line came first. A canvas that had not been measured yet would therefore
    look like snapping to the canvas centre, always, which is a plausible-looking wrong
    answer and was caught only by testing the degenerate case directly.
  */
  if (
    !Number.isFinite(position) ||
    !Number.isFinite(halfExtent) ||
    !Number.isFinite(threshold) ||
    threshold <= 0
  ) {
    return { position, target: null, delta: 0 };
  }
  /*
    The three lines the item offers, as offsets from its centre: its leading edge, its
    centre, and its trailing edge. A candidate snap is "move the position by this much
    so that this line lands on that target".
  */
  const lines = [position - halfExtent, position, position + halfExtent];
  let best: { delta: number; target: SnapTarget } | null = null;
  for (const target of targets) {
    for (const line of lines) {
      const delta = target.at - line;
      if (Math.abs(delta) > threshold) continue;
      /*
        Ties keep the first candidate, and the targets are ordered canvas-first, so a
        line that is equidistant from the canvas centre and an item's edge resolves to
        the canvas. That is the more legible guide to draw and the more predictable one
        to feel.
      */
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, target };
    }
  }
  if (!best) return { position, target: null, delta: 0 };
  return { position: position + best.delta, target: best.target, delta: best.delta };
}

/**
 * The snap threshold in canvas fractions.
 *
 * `SNAP_PX` is a *screen* distance, so it becomes a fraction by dividing by the canvas's
 * size in pixels. A zero-sized canvas (the panel before layout) yields 0, which makes
 * `snapAxis` decline to snap rather than divide by zero into `Infinity` and snap
 * everything.
 */
export function snapThresholdPx(canvasPixels: number): number {
  if (!Number.isFinite(canvasPixels) || canvasPixels <= 0) return 0;
  return SNAP_PX / canvasPixels;
}

/**
 * Whether snapping should apply to this event.
 *
 * `Alt` bypasses it (SPEC 10 §8.2). This is a one-line function and it exists anyway,
 * because the rule is a *product* decision — the same modifier that disables snapping in
 * every other editor — and it deserves a name and a test rather than an inline `!`.
 */
export function snappingApplies(event: { altKey: boolean }): boolean {
  return !event.altKey;
}

/**
 * An item's bounds on one axis, from the values the document stores.
 *
 * The picture is drawn centred on `offsetX`/`offsetY` — the preview's own transform is
 * `translate(offset · 100%)` on a full-inset element — so the offsets are already the
 * *centre* of the drawn picture in canvas fractions, and the half-extent is half the
 * drawn size.
 *
 * A rotated item's drawn bounds are its axis-aligned bounding box, which is larger than
 * its unrotated size. Snapping to the box rather than to the picture's own edges is the
 * honest choice: the box is what the user sees and what they are aiming at.
 */
export function itemBounds(
  centre: number,
  extent: number,
  rotation: number,
  /**
   * The picture's unrotated size in canvas fractions of this axis, and of the other.
   * Needed because a rotation mixes the two axes, and on a non-square canvas the mix
   * depends on both.
   */
  otherExtent: number,
  canvasAspect: number,
): ItemBounds {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  /*
    The axis-aligned width of a rotated rectangle: `w·|cos| + h·|sin|`, with `h`
    converted out of the other axis's fractions. This is the same arithmetic the export's
    `rotate` filter produces, and getting it wrong here would snap to a box the picture
    does not occupy.
  */
  const other = otherExtent * (Number.isFinite(canvasAspect) && canvasAspect > 0 ? 1 / canvasAspect : 1);
  const drawn = Number.isFinite(rotation) && rotation !== 0 ? extent * cos + other * sin : extent;
  const half = drawn / 2;
  return { left: centre - half, centre, right: centre + half };
}
