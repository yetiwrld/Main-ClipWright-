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
  captionFrameAt,
  layoutText,
  type CaptionFrame,
  type MeasureText,
} from '@clipwright/compositor';

/** An item that draws type or geometry rather than footage. */
export interface GraphicItemLike {
  type?: string;
  textContent?: string;
  shapeKind?: string;
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
  if (item.type === 'shape') return shapePath(item.shapeKind) !== null;
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

/** The shape kinds the renderer can draw, in the order the panel lists them. */
export const SHAPE_KINDS = [
  'rect',
  'round-rect',
  'ellipse',
  'triangle',
  'polygon',
  'star',
  'line',
  'arrow',
  'bubble',
] as const;

export type ShapeKind = (typeof SHAPE_KINDS)[number];

/**
 * The SVG path for a shape kind, in a 100×100 box, or `null` for an unknown kind.
 *
 * SVG paths rather than canvas calls because the same string feeds the preview's `<svg>`
 * and, later, the export's rasteriser: one definition instead of two that can drift,
 * which is the rule the rest of this project follows. Coordinates are in a fixed box
 * and scaled by the caller, so a shape is crisp at any size — a stroke drawn at preview
 * scale and stretched would be the one thing that looks different in the file.
 *
 * A `null` return is deliberate for an unrecognised kind: it is a project from a newer
 * version, and substituting a rectangle would show the user something the file does not
 * contain.
 */
export function shapePath(kind: string | undefined): string | null {
  switch (kind) {
    case 'rect':
      return 'M0 0 H100 V100 H0 Z';
    case 'round-rect':
      // A radius of 18 on a 100 box, the same proportion the style's corner default uses.
      return 'M18 0 H82 A18 18 0 0 1 100 18 V82 A18 18 0 0 1 82 100 H18 A18 18 0 0 1 0 82 V18 A18 18 0 0 1 18 0 Z';
    case 'ellipse':
      // Two half-arcs rather than `<ellipse>`: one path string for every kind means the
      // caller has one drawing path, not a switch over SVG element types.
      return 'M0 50 A50 50 0 0 1 100 50 A50 50 0 0 1 0 50 Z';
    case 'triangle':
      return 'M50 0 L100 100 L0 100 Z';
    case 'polygon':
      return polygonPath(5);
    case 'star':
      return starPath(5, 0.4);
    case 'line':
      // A line is drawn as a stroked path, so it has no fill area: the centre-line of a
      // thin bar. Its thickness comes from the stroke width, not from the path.
      return 'M0 50 H100';
    case 'arrow':
      // Shaft plus a head, as one filled outline so the head scales with the shaft
      // rather than being a separate stamp at a fixed size.
      return 'M0 42 H62 V26 L100 50 L62 74 V58 H0 Z';
    case 'bubble':
      // A rounded box with a tail at the bottom left, the conventional speech shape.
      return 'M16 4 H84 A12 12 0 0 1 96 16 V64 A12 12 0 0 1 84 76 H40 L20 96 V76 H16 A12 12 0 0 1 4 64 V16 A12 12 0 0 1 16 4 Z';
    default:
      return null;
  }
}

/** A regular polygon with `sides` vertices, point up, inscribed in the unit box. */
function polygonPath(sides: number): string {
  const points = vertices(sides, 50, 50, 50, -Math.PI / 2);
  return `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join(' L')} Z`;
}

/** A star alternating between two radii; `innerRatio` is the inner one. */
function starPath(points: number, innerRatio: number): string {
  const outer = vertices(points, 50, 50, 50, -Math.PI / 2);
  const inner = vertices(points, 50, 50, 50 * innerRatio, -Math.PI / 2 + Math.PI / points);
  const mixed: Array<[number, number]> = [];
  for (let index = 0; index < points; index += 1) {
    mixed.push(outer[index]!);
    mixed.push(inner[index]!);
  }
  return `M${mixed.map(([x, y]) => `${round(x)} ${round(y)}`).join(' L')} Z`;
}

function vertices(
  count: number,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const angle = startAngle + (index * 2 * Math.PI) / count;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

/** Two decimals is below a device pixel at any sane scale, and keeps the string short. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Where a shape sits on the canvas, as a CSS box in percentages.
 *
 * Percentage rather than pixels because the preview is scaled by CSS and the export is
 * rendered at full resolution: a shape positioned in pixels would be the wrong size in
 * one of them. The default is a centred block half the frame wide, which is what a user
 * expects "add a rectangle" to produce — a full-frame rectangle would cover the
 * footage they are trying to annotate.
 */
export function shapeBox(item: {
  transform?: { x?: number; y?: number; scaleX?: number; scaleY?: number };
}): { left: string; top: string; width: string; height: string } {
  const scale = Math.max(0.01, item.transform?.scaleX ?? 1);
  const scaleY = Math.max(0.01, item.transform?.scaleY ?? 1);
  const width = 50 * scale;
  const height = 50 * scaleY;
  const centreX = 50 + (item.transform?.x ?? 0) * 100;
  const centreY = 50 + (item.transform?.y ?? 0) * 100;
  return {
    left: `${centreX - width / 2}%`,
    top: `${centreY - height / 2}%`,
    width: `${width}%`,
    height: `${height}%`,
  };
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
