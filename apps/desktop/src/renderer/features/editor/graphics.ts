/**
 * Text and shape items on the preview (SPEC 11 §7, §12).
 *
 * A text item is deliberately *a caption without words*. The schema has carried a
 * `text` item type, a `textContent` field and a `shapeKind` enum since the beginning;
 * nothing read any of them, so a project could declare a title and no renderer would
 * draw one. This module is the missing reader.
 *
 * The decision that keeps it cheap: a text item resolves its style through the same
 * `resolveStyle` and lays out through the same `layoutText` a caption does. That means
 * it inherits wrapping, alignment, outline, shadow, background, the nine anchors, and
 * the preview/export agreement those have already been tested for. A second styling
 * system for titles would be a second thing to keep in step, and the whole shape of
 * this project is that the preview and the file are one renderer.
 *
 * The functions here are pure — they take the item, the time and a measure function and
 * return geometry. Drawing is `caption-painter`, which is already tested separately.
 */
import type { CaptionStyle } from '@clipwright/caption-styles';
import type { TimelineItem } from '@clipwright/project-schema';
import {
  ICON_LIBRARY,
  SHAPE_KINDS,
  captionFrameAt,
  layoutText,
  shapeBoxAt,
  resolveIconItem,
  shapeGeometry,
  shapePath,
  type IconShape,
  type ShapeBoxPercent,
  type CaptionFrame,
  type MeasureText,
  type ShapeKind,
} from '@clipwright/compositor';

export { SHAPE_KINDS, shapeGeometry, shapePath, type ShapeKind };

/** An item that draws type or geometry rather than footage. */
export interface GraphicItemLike {
  type?: string;
  textContent?: string;
  shapeKind?: string;
  /** Lucide name, for an icon item (SPEC 11 §12). */
  iconName?: string;
  /** Stored children, when the file carries its own copy of the icon. */
  iconShapes?: readonly IconShape[];
  startUs: number;
  durationUs: number;
}

/** Whether this item is drawn by this module rather than by a `<video>` or `<img>`. */
export function isGraphicItem(item: { type?: string }): boolean {
  return item.type === 'text' || item.type === 'shape';
}

/**
 * Whether the item has anything to draw.
 *
 * An empty text item is a real state — the user added a title and has not typed yet —
 * and it must draw nothing rather than a caret or an invisible box. A shape with an
 * unknown kind is the same: it came from a newer file, and drawing a rectangle as a
 * fallback would be a lie about what the project contains.
 */
export function hasGraphicContent(item: GraphicItemLike): boolean {
  if (item.type === 'text') return (item.textContent ?? '').trim().length > 0;
  if (item.type === 'shape') {
    /*
      An icon item has no `shapeKind`: it is a shape whose geometry comes from the icon
      library. It is drawable when it resolves — the same question `paintShape` asks — so the
      two can never disagree about whether there is something to draw.
    */
    if (item.iconName || item.iconShapes?.length) {
      return resolveIconItem(item, ICON_LIBRARY).status === 'drawn';
    }
    return shapePath(item.shapeKind) !== null;
  }
  return false;
}

/**
 * A caption frame for a text item, so the existing painter can draw it.
 *
 * `wordTimings` is empty: a text item has no transcript behind it, and
 * `captionFrameAt` treats a missing timing as "already spoken", which is exactly right
 * — every word of a title is shown from its first frame. The segment is the item's own
 * span, so the style's in/out animation still plays over the item's duration rather
 * than over a span it does not have.
 */
export function textFrameAt(input: {
  item: GraphicItemLike;
  style: CaptionStyle;
  timeUs: number;
  canvasWidth: number;
  canvasHeight: number;
  measure: MeasureText;
}): CaptionFrame | null {
  const text = input.item.textContent ?? '';
  if (text.trim().length === 0) return null;
  return captionFrameAt({
    text,
    style: input.style,
    wordTimings: [],
    segment: {
      startUs: input.item.startUs,
      endUs: input.item.startUs + input.item.durationUs,
    },
    timeUs: input.timeUs,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    measure: input.measure,
  });
}

/**
 * The bounding box of a text item, for the canvas overlay and the selection frame.
 *
 * `null` when there is nothing to draw, so a caller never has to distinguish "no item"
 * from "an item with no extent".
 */
export function textBox(
  item: GraphicItemLike,
  style: CaptionStyle,
  canvasWidth: number,
  canvasHeight: number,
  measure: MeasureText
): { x: number; y: number; width: number; height: number } | null {
  const text = item.textContent ?? '';
  if (text.trim().length === 0) return null;
  const layout = layoutText({ text, style, canvasWidth, canvasHeight, measure });
  return { ...layout.bounds };
}

/**
 * Where a shape sits on the canvas, in percentages of the frame.
 *
 * Delegates to `shapeBoxAt` in the compositor, which the exporter also reads — the box
 * is one definition, not one per renderer. This wrapper exists only to keep the
 * renderer's call sites named the way the rest of this module is.
 */
export function shapeBox(item: {
  transform?: { x?: number; y?: number; scaleX?: number; scaleY?: number };
}): ShapeBoxPercent {
  return shapeBoxAt(item.transform);
}

/**
 * The style a graphic item draws with.
 *
 * The item's own `captionStyleId` wins, then the caller's default. It never invents a
 * style: a text item with no style renders as the default preset, which is what a
 * caption with no style does, and inventing a fourth fallback would make a title look
 * different from a caption that used the same missing id.
 */
export function graphicStyle<T extends CaptionStyle>(
  item: { captionStyleId?: string },
  resolve: (styleId: string | undefined) => T
): T {
  return resolve(item.captionStyleId);
}

/** Narrowing helper for a `TimelineItem` that the overlay can draw. */
export function asGraphic(item: TimelineItem): GraphicItemLike | null {
  if (!isGraphicItem(item)) return null;
  return item as GraphicItemLike;
}
