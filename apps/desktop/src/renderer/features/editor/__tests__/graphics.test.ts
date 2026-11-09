/**
 * Text and shape items (SPEC 11 §7, §12).
 *
 * The bug these exist to prevent is the one that was actually present: the schema
 * declared `textContent`, `shapeKind` and the `text`/`shape` item types, and nothing
 * read any of them. A project could contain a title, the file validated, the timeline
 * showed a chip, and no renderer drew a pixel. Half of these tests are therefore about
 * *reachability* — that the item types are recognised at all — rather than about
 * geometry.
 *
 * The other half are about the two decisions most likely to be wrong: an empty text
 * item must draw nothing (not a box, not a caret), and an unknown shape kind must draw
 * nothing rather than falling back to a rectangle, because a rectangle is a claim about
 * what the file contains.
 */
import { describe, expect, it } from 'vitest';
import { builtInStyle } from '@clipwright/caption-styles';
import type { MeasureText } from '@clipwright/compositor';
import {
  SHAPE_KINDS,
  hasGraphicContent,
  isGraphicItem,
  shapeBox,
  shapePath,
  textBox,
  textFrameAt,
} from '../graphics.js';

/** Deterministic stand-in for canvas text metrics: every glyph half an em. */
const measure: MeasureText = (text, fontPx) => {
  let width = 0;
  for (const char of text) width += char === ' ' ? 0.25 * fontPx : 0.5 * fontPx;
  return width;
};

const style = builtInStyle('bold-creator')!;
const textItem = (textContent: string, durationUs = 3_000_000) => ({
  type: 'text',
  textContent,
  startUs: 0,
  durationUs,
});

describe('which items this module draws', () => {
  it('claims text and shape, and nothing else', () => {
    expect(isGraphicItem({ type: 'text' })).toBe(true);
    expect(isGraphicItem({ type: 'shape' })).toBe(true);
    // The four that are somebody else's job: a video is a <video>, a caption has its own
    // overlay, an adjustment layer has no picture, an audio item is never drawn.
    for (const type of ['video', 'image', 'caption', 'adjustment', 'audio']) {
      expect(isGraphicItem({ type }), type).toBe(false);
    }
  });

  it('treats an empty or whitespace-only text item as having nothing to draw', () => {
    // The state a user is in between clicking "Add text" and typing. It must not draw a
    // background box or an empty outline where the text will be.
    expect(hasGraphicContent(textItem(''))).toBe(false);
    expect(hasGraphicContent(textItem('   '))).toBe(false);
    expect(hasGraphicContent(textItem('\n\t '))).toBe(false);
  });

  it('draws an icon only when this build can resolve it (SPEC 11 §12)', () => {
    /*
      An icon item is a shape with no `shapeKind`, so the "does it draw" question has to ask
      the icon library. Answering it any other way — presence of `iconName`, say — would put a
      tile in the timeline that paints nothing, which is the failure this project keeps
      having to remove.
    */
    const icon = (patch: Record<string, unknown>) => ({
      type: 'shape',
      startUs: 0,
      durationUs: 1,
      ...patch,
    });
    expect(hasGraphicContent(icon({ iconName: 'star' }))).toBe(true);
    // Refused by name: `gift`'s ribbon is an elliptical arc.
    expect(hasGraphicContent(icon({ iconName: 'gift' }))).toBe(false);
    expect(hasGraphicContent(icon({ iconName: 'no-such-icon' }))).toBe(false);
    // Stored shapes are enough on their own, with no name at all — the escape hatch for a
    // file written by a build with a different icon set.
    expect(hasGraphicContent(icon({ iconShapes: [{ t: 'path', d: 'M0 0 L24 0' }] }))).toBe(true);
    expect(hasGraphicContent(icon({ iconShapes: [] }))).toBe(false);
  });

  it('draws a text item with content', () => {
    expect(hasGraphicContent(textItem('Hello'))).toBe(true);
  });

  it('draws a shape only when its kind is one the renderer knows', () => {
    for (const kind of SHAPE_KINDS) {
      expect(hasGraphicContent({ type: 'shape', shapeKind: kind, startUs: 0, durationUs: 1 })).toBe(
        true
      );
    }
    // A file from a newer version. Drawing a rectangle would show the user something
    // the file does not contain.
    expect(
      hasGraphicContent({ type: 'shape', shapeKind: 'hexagon-hollow', startUs: 0, durationUs: 1 })
    ).toBe(false);
    expect(hasGraphicContent({ type: 'shape', startUs: 0, durationUs: 1 })).toBe(false);
  });
});

describe('a text item lays out like a caption', () => {
  it('produces a frame for a text item with content', () => {
    const frame = textFrameAt({
      item: textItem('Hello world'),
      style,
      timeUs: 0,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
    });
    expect(frame).not.toBeNull();
    expect(frame!.words.length).toBe(2);
  });

  it('shows every word from the first frame', () => {
    /*
      A text item has no transcript behind it, so `wordTimings` is empty. If the frame
      builder read a missing timing as "not spoken yet" the title would be invisible
      until the end of its own span — the exact opposite of what a title is for.
    */
    /*
      `bold-creator` upper-cases its text, so the words come back `NOW`/`ON`/`AIR`. That
      is the style doing its job — asserted rather than quietly worked around, because a
      text item that ignored the style's case rule would be a real bug.
    */
    const frame = textFrameAt({
      item: textItem('Now on air'),
      style,
      timeUs: 0,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
    });
    expect(frame!.words.every((word) => word.visible)).toBe(true);
    expect(frame!.words.map((word) => word.text)).toEqual(['NOW', 'ON', 'AIR']);
  });

  it('returns null rather than an empty frame for a blank title', () => {
    // A frame with zero words would still be "a frame", and the painter's early return
    // is the only thing stopping it drawing the style's background overlay.
    const frame = textFrameAt({
      item: textItem('  '),
      style,
      timeUs: 0,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
    });
    expect(frame).toBeNull();
  });

  it('wraps long text the same way a caption would', () => {
    // The point of reusing `layoutText`: same wrapping, so a title cannot break its lines
    // differently from a caption carrying the same words in the same style.
    const long = 'a title long enough that it has to wrap onto more than one line to fit';
    const frame = textFrameAt({
      item: textItem(long),
      style,
      timeUs: 0,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
    });
    expect(frame!.layout.lines.length).toBeGreaterThan(1);
  });

  it('animates the in/out over the item\'s own span', () => {
    /*
      The segment is the item's range, so a style with an entrance animation fades in at
      the start of the item. Passing `{0, 0}` — the obvious mistake when there is no
      caption segment to copy — would make the animation complete before the item began
      and the title would pop in at full opacity.
    */
    const item = { ...textItem('Fade'), startUs: 1_000_000, durationUs: 2_000_000 };
    const early = textFrameAt({
      item,
      style,
      timeUs: 1_000_000,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
    });
    const late = textFrameAt({
      item,
      style,
      timeUs: 2_900_000,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
    });
    // Whatever the style's animation does, the two instants must not be the same frame:
    // that is what proves the span reached the frame builder at all.
    expect(early!.opacity).not.toBe(late!.opacity);
  });
});

describe('the text box', () => {
  it('reports the laid-out extent, not the item\'s duration', () => {
    const box = textBox(textItem('Hi'), style, 1920, 1080, measure);
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  it('is null for a blank title', () => {
    expect(textBox(textItem(''), style, 1920, 1080, measure)).toBeNull();
  });
});

describe('shape geometry', () => {
  it('has a path for every kind the panel offers', () => {
    // The list and the renderer must agree: a kind in `SHAPE_KINDS` with no path is a
    // button that adds an invisible item.
    for (const kind of SHAPE_KINDS) {
      expect(shapePath(kind), kind).not.toBeNull();
    }
    expect(SHAPE_KINDS.length).toBe(9);
  });

  it('returns null for an unknown kind', () => {
    expect(shapePath('hexagon-hollow')).toBeNull();
    expect(shapePath(undefined)).toBeNull();
  });

  it('draws every path inside its 100×100 box', () => {
    /*
      A path outside the box is a shape that spills out of its own element: the caller
      renders into a box the size the user sees, so a coordinate of 140 would be clipped
      rather than visible. The rounded rect, bubble and star are the ones with enough
      arc and trigonometry to get this wrong.
    */
    for (const kind of SHAPE_KINDS) {
      const numbers = (shapePath(kind)!.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      for (const value of numbers) {
        expect(value, `${kind}: ${value}`).toBeGreaterThanOrEqual(0);
        expect(value, `${kind}: ${value}`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('starts every path with a move, so it is a real path', () => {
    // A path that began with `L` or `A` is invalid to some renderers and is silently
    // dropped by others, which would show as a missing shape on one platform only.
    for (const kind of SHAPE_KINDS) {
      expect(shapePath(kind)!.startsWith('M'), kind).toBe(true);
    }
  });

  it('gives the star more points than the polygon', () => {
    // The star is 2× its point count in vertices; a star drawn with five vertices is a
    // pentagon, and would look correct in a test that only checked it was not null.
    const starVertices = (shapePath('star')!.match(/[ML]/g) ?? []).length;
    const polygonVertices = (shapePath('polygon')!.match(/[ML]/g) ?? []).length;
    expect(starVertices).toBe(polygonVertices * 2);
  });

  it('keeps the line a line rather than closing it into a sliver', () => {
    // A stroked centre-line has no `Z` and no thickness of its own; if it were closed it
    // would be a zero-area shape that fills to nothing.
    expect(shapePath('line')).not.toContain('Z');
    expect(shapePath('rect')).toContain('Z');
  });

  it('hangs the speech bubble tail below the box, as a bubble does', () => {
    // The one shape that deliberately reaches the bottom edge: y=96 is the tail point.
    // If it were drawn at the same y as the body the shape would read as a plain rounded
    // box, which is a different icon.
    expect(shapePath('bubble')).toContain('96');
  });
});

describe('where a shape sits', () => {
  it('defaults to a centred block rather than the whole frame', () => {
    // A full-frame rectangle would hide the footage the user is annotating.
    const box = shapeBox({});
    expect(box.x).toBe(25);
    expect(box.y).toBe(25);
    expect(box.width).toBe(50);
    expect(box.height).toBe(50);
  });

  it('moves with the item\'s transform', () => {
    // `transform.x`/`.y` are fractions of the canvas, so 0.1 is ten percent across.
    const box = shapeBox({ transform: { x: 0.1, y: -0.2 } });
    expect(box.x).toBe(35);
    expect(box.y).toBe(5);
  });

  it('scales with the item, keeping the centre fixed', () => {
    // Scaling a centred shape must grow it about the middle; growing from the top-left
    // is the bug that makes "make it bigger" also move the shape.
    const box = shapeBox({ transform: { scaleX: 2, scaleY: 2 } });
    expect(box.width).toBe(100);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.height).toBe(100);
  });

  it('scales each axis independently', () => {
    const box = shapeBox({ transform: { scaleX: 2, scaleY: 0.5 } });
    expect(box.width).toBe(100);
    expect(box.height).toBe(25);
  });

  it('refuses a zero or negative scale rather than producing a NaN box', () => {
    // A `NaN` in a percentage silently drops the element without throwing, which would
    // look like a missing shape rather than a broken one.
    for (const scaleX of [0, -1]) {
      const box = shapeBox({ transform: { scaleX } });
      expect(Number.isFinite(box.width)).toBe(true);
      expect(box.width).toBeGreaterThan(0);
    }
  });
});
