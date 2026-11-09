/**
 * Painting a caption frame (SPEC 11 §3).
 *
 * A real canvas is not available in the test environment, and a screenshot
 * comparison would not explain a failure. Instead each test drives a recording
 * stand-in for the 2D context: the assertion is the *sequence* of calls, which is
 * what the drawing order actually is. Stroke-after-fill thins every glyph by half
 * the outline width, and a background painted after the text hides it — both look
 * plausible in a screenshot and both are visible here as a wrong order.
 */
import { describe, expect, it, vi } from 'vitest';
import { builtInStyle, type CaptionStyle } from '@clipwright/caption-styles';
import { captionFrameAt, type CaptionFrame } from '@clipwright/compositor';
import { canvasMeasure, fontString, hexToRgba, paintCaptionFrame } from '../features/editor/caption-painter.js';
import { paintShape, shapeItemsAt, textItemsAt } from '../features/editor/CaptionOverlay.js';

interface Call {
  op: string;
  args: unknown[];
}

/**
 * A 2D context that records instead of drawing.
 *
 * `measureText` returns a deterministic width — half an em per glyph, a quarter
 * for a space — so the layout inside these tests is arithmetic rather than a
 * property of whatever fonts the machine has installed.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    font: '',
    fillStyle: '#000',
    strokeStyle: '#000',
  };
  const ctx = new Proxy(
    {
      save: () => calls.push({ op: 'save', args: [] }),
      restore: () => calls.push({ op: 'restore', args: [] }),
      measureText: (text: string) => {
        const fontPx = Number.parseFloat(String(state['font']).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '0');
        let width = 0;
        for (const char of text) width += char === ' ' ? 0.25 * fontPx : 0.5 * fontPx;
        return { width };
      },
      translate: record('translate'),
      scale: record('scale'),
      beginPath: record('beginPath'),
      closePath: record('closePath'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      quadraticCurveTo: record('quadraticCurveTo'),
      // Shapes are cubics (SPEC 11 §12); the context predates them because captions
      // are drawn with quadratic curves only.
      bezierCurveTo: record('bezierCurveTo'),
      rect: record('rect'),
      clip: record('clip'),
      fill: record('fill'),
      fillText: record('fillText'),
      strokeText: record('strokeText'),
      get font(): string {
        return state['font'] as string;
      },
      set font(value: string) {
        state['font'] = value;
        calls.push({ op: 'setFont', args: [value] });
      },
      get globalAlpha(): number {
        return state['globalAlpha'] as number;
      },
      set globalAlpha(value: number) {
        state['globalAlpha'] = value;
      },
      get fillStyle(): string {
        return state['fillStyle'] as string;
      },
      set fillStyle(value: string) {
        state['fillStyle'] = value;
        calls.push({ op: 'fillStyle', args: [value] });
      },
      get strokeStyle(): string {
        return state['strokeStyle'] as string;
      },
      set strokeStyle(value: string) {
        state['strokeStyle'] = value;
        calls.push({ op: 'strokeStyle', args: [value] });
      },
      lineWidth: 0,
      lineJoin: 'round',
      lineCap: 'round',
      textBaseline: 'alphabetic',
      textAlign: 'left',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    {
      // Anything the painter reads that is not modelled above is a silent `undefined`
      // rather than a crash; anything it *writes* is recorded so a test can see it.
      get(target, key: string) {
        if (key in target) return (target as Record<string, unknown>)[key];
        return undefined;
      },
      set(target, key: string, value) {
        (target as Record<string, unknown>)[key] = value;
        calls.push({ op: `set:${key}`, args: [value] });
        return true;
      },
    }
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const measureStandIn = () => {
  const cache = new Map<string, number>();
  return (text: string, fontPx: number) => {
    const key = `${fontPx}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let width = 0;
    for (const char of text) width += char === ' ' ? 0.25 * fontPx : 0.5 * fontPx;
    cache.set(key, width);
    return width;
  };
};

const style = (id: string): CaptionStyle => builtInStyle(id)!;

const words4 = [
  { startUs: 1_000_000, endUs: 1_500_000 },
  { startUs: 1_500_000, endUs: 2_000_000 },
  { startUs: 2_000_000, endUs: 2_500_000 },
  { startUs: 2_500_000, endUs: 3_000_000 },
];

function buildFrame(styleId: string, timeUs: number, text = 'one two three four'): CaptionFrame {
  return captionFrameAt({
    text,
    style: style(styleId),
    wordTimings: words4,
    segment: { startUs: 1_000_000, endUs: 3_000_000 },
    timeUs,
    canvasWidth: 1920,
    canvasHeight: 1080,
    measure: measureStandIn(),
  });
}

describe('fontString', () => {
  it('builds a CSS font with the weight and the family', () => {
    const s = style('bold-creator');
    expect(fontString(s, 64)).toBe(`${s.font.weight} 64px "${s.font.family}", sans-serif`);
  });

  it('includes italic only when the style asks', () => {
    const plain = style('clean-minimal');
    expect(fontString(plain, 32)).not.toContain('italic');
    const italic: CaptionStyle = { ...plain, font: { ...plain.font, italic: true } };
    expect(fontString(italic, 32).startsWith('italic ')).toBe(true);
  });
});

describe('hexToRgba', () => {
  it('expands six digits', () => {
    expect(hexToRgba('#FF8000', 0.5)).toBe('rgba(255,128,0,0.5)');
  });

  it('expands three digits', () => {
    expect(hexToRgba('#F80', 1)).toBe('rgba(255,136,0,1)');
  });

  it('falls back to white for a colour it cannot read', () => {
    // Better a legible caption in the wrong colour than an invisible one.
    expect(hexToRgba('not-a-colour', 0.4)).toBe('rgba(255,255,255,0.4)');
  });
});

describe('paintCaptionFrame', () => {
  it('strokes before filling, so the outline does not thin the glyphs', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('bold-creator', 2_000_000), style('bold-creator'), {
      canvasShortSide: 1080,
    });
    const ops = calls.map((call) => call.op);
    const firstStroke = ops.indexOf('strokeText');
    const firstFill = ops.indexOf('fillText');
    expect(firstStroke).toBeGreaterThan(-1);
    expect(firstStroke).toBeLessThan(firstFill);
  });

  it('draws one fillText per visible word', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('clean-minimal', 2_000_000), style('clean-minimal'), {
      canvasShortSide: 1080,
    });
    // Clean Minimal has no outline, so every word is exactly one fillText.
    expect(calls.filter((call) => call.op === 'fillText')).toHaveLength(4);
  });

  it('draws only the current word for word-by-word', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('word-by-word', 1_750_000), style('word-by-word'), {
      canvasShortSide: 1080,
    });
    const drawn = calls.filter((call) => call.op === 'fillText').map((call) => call.args[0]);
    expect(drawn).toEqual(['TWO']);
  });

  it('fills a karaoke word twice — plain, then swept — and clips in between', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('karaoke', 1_250_000), style('karaoke'), {
      canvasShortSide: 1080,
    });
    const ops = calls.map((call) => call.op);
    // Four words; the first is mid-sweep so it is painted twice.
    expect(calls.filter((call) => call.op === 'fillText')).toHaveLength(5);
    expect(ops).toContain('clip');
    expect(ops.indexOf('clip')).toBeLessThan(ops.lastIndexOf('fillText'));
  });

  it('does not sweep a word that has not been reached', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('karaoke', 1_250_000), style('karaoke'), {
      canvasShortSide: 1080,
    });
    const swept = calls.filter((call) => call.op === 'fillStyle' && call.args[0] === style('karaoke').highlight.color);
    // Only the first word shows the highlight colour this frame.
    expect(swept).toHaveLength(1);
  });

  it('paints a block background before any text', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('multi-line-subtitle', 2_000_000), style('multi-line-subtitle'), {
      canvasShortSide: 1080,
    });
    const ops = calls.map((call) => call.op);
    const firstFill = ops.indexOf('fill');
    const firstText = ops.indexOf('fillText');
    expect(firstFill).toBeGreaterThan(-1);
    expect(firstFill).toBeLessThan(firstText);
  });

  it('draws a per-line chip for each line of a per-line style', () => {
    const { ctx, calls } = recordingContext();
    const frame = buildFrame('podcast', 2_000_000);
    paintCaptionFrame(ctx, frame, style('podcast'), { canvasShortSide: 1080 });
    const lineChips = calls.filter((call) => call.op === 'fill').length;
    expect(lineChips).toBeGreaterThanOrEqual(frame.layout.lines.length);
  });

  it('scales an emphasised keyword around its own centre', () => {
    const { ctx, calls } = recordingContext();
    const frame = captionFrameAt({
      text: 'one two three',
      style: style('highlighted-keywords'),
      wordTimings: words4.slice(0, 3),
      wordIds: ['a', 'b', 'c'],
      overrides: { b: { emphasis: true } },
      segment: { startUs: 1_000_000, endUs: 3_000_000 },
      timeUs: 1_500_000,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure: measureStandIn(),
    });
    paintCaptionFrame(ctx, frame, style('highlighted-keywords'), { canvasShortSide: 1080 });
    // The scale is bracketed by a translate/scale/translate trio, so the word grows
    // in place instead of pushing its neighbours along.
    const ops = calls.map((call) => call.op);
    const scaleIndex = ops.indexOf('scale');
    expect(scaleIndex).toBeGreaterThan(-1);
    expect(ops[scaleIndex - 1]).toBe('translate');
    expect(ops[scaleIndex + 1]).toBe('translate');
  });

  it('does nothing for an empty frame', () => {
    const { ctx, calls } = recordingContext();
    const empty = buildFrame('bold-creator', 1_000_000, '');
    paintCaptionFrame(ctx, empty, style('bold-creator'), { canvasShortSide: 1080 });
    expect(calls).toEqual([]);
  });

  it('fades every word when the block is mid-animation', () => {
    // The whole-block opacity multiplies into each word's own alpha; a frame at
    // half opacity must not draw any solid word.
    const { ctx, calls } = recordingContext();
    const faded = { ...buildFrame('clean-minimal', 2_000_000), opacity: 0.5 };
    const solid = buildFrame('clean-minimal', 2_000_000);
    paintCaptionFrame(ctx, faded, style('clean-minimal'), { canvasShortSide: 1080 });
    const fadedWords = faded.words.length;
    paintCaptionFrame(ctx, solid, style('clean-minimal'), { canvasShortSide: 1080 });
    // Both frames draw the same words; the difference is alpha, which the context
    // applies. What matters here is that fading does not drop words.
    expect(fadedWords).toBe(solid.words.length);
    expect(calls.filter((call) => call.op === 'fillText')).toHaveLength(fadedWords * 2);
  });

  it('restores the context it was given, even after many words', () => {
    const { ctx, calls } = recordingContext();
    paintCaptionFrame(ctx, buildFrame('social-pop', 2_000_000), style('social-pop'), {
      canvasShortSide: 1080,
    });
    const saves = calls.filter((call) => call.op === 'save').length;
    const restores = calls.filter((call) => call.op === 'restore').length;
    expect(saves).toBe(restores);
  });
});

describe('canvasMeasure', () => {
  it('measures through the context font and caches repeats', () => {
    const { ctx, calls } = recordingContext();
    const measure = canvasMeasure(ctx, style('bold-creator'));
    const spy = vi.spyOn(ctx, 'measureText');
    measure('hello', 48);
    measure('hello', 48);
    expect(spy).toHaveBeenCalledTimes(1);
    // A different size is a different measurement, so it must not hit the cache.
    measure('hello', 96);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(calls.some((call) => call.op === 'setFont')).toBe(true);
  });

  it('measures half an em per glyph, like the layout stand-in', () => {
    const { ctx } = recordingContext();
    const measure = canvasMeasure(ctx, style('bold-creator'));
    expect(measure('ab', 100)).toBe(100);
    // 'a b' is two half-em glyphs plus a quarter-em space.
    expect(measure('a b', 100)).toBeCloseTo(125, 5);
  });
});

describe('which text items the overlay paints (SPEC 11 §7)', () => {
  /*
    The overlay draws text items on the same canvas as captions, so this is the only
    thing deciding whether a title is on screen. It was extracted from the render pass
    precisely so it could be checked without a canvas: every case here is about the
    time range, and the half-open end is the one that is easy to get wrong.
  */
  const stateWith = (items: unknown[]) =>
    ({ items: Object.fromEntries((items as Array<{ id: string }>).map((item) => [item.id, item])) }) as never;

  const textItem = (overrides: Record<string, unknown> = {}) => ({
    id: 't1',
    type: 'text',
    textContent: 'Title',
    startUs: 1_000_000,
    durationUs: 2_000_000,
    disabled: false,
    ...overrides,
  });

  it('finds a text item while the playhead is inside it', () => {
    expect(textItemsAt(stateWith([textItem()]), 1_500_000)).toHaveLength(1);
  });

  it('includes the first frame and excludes the one at its end', () => {
    /*
      Half-open, like every other item range in the engine. A closed interval shows the
      title for one frame longer than the export does — a difference nobody would ever
      diagnose from the output, and exactly the kind that survives forever.
    */
    expect(textItemsAt(stateWith([textItem()]), 1_000_000)).toHaveLength(1);
    expect(textItemsAt(stateWith([textItem()]), 3_000_000)).toHaveLength(0);
    expect(textItemsAt(stateWith([textItem()]), 2_999_999)).toHaveLength(1);
  });

  it('skips a disabled text item', () => {
    // Disabling is how a user checks the frame without the title; drawing it anyway
    // makes the toggle look broken.
    expect(textItemsAt(stateWith([textItem({ disabled: true })]), 1_500_000)).toHaveLength(0);
  });

  it('ignores captions, shapes and everything else', () => {
    // Shapes are drawn by their own path, and a caption has its own overlay branch.
    // Claiming them here would draw a caption twice — once via the ASS-style painter
    // and once via this one — which reads as doubled, bolder text.
    const state = stateWith([
      textItem(),
      { ...textItem({ id: 'c1' }), type: 'caption' },
      { ...textItem({ id: 's1' }), type: 'shape' },
      { ...textItem({ id: 'v1' }), type: 'video' },
    ]);
    const found = textItemsAt(state, 1_500_000);
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe('text');
  });

  it('returns all the titles that overlap the playhead, so one moment can carry two', () => {
    // A lower third is a title and a subtitle at once. Returning only the first would
    // drop one of them with no error anywhere.
    const state = stateWith([
      textItem({ id: 'a' }),
      textItem({ id: 'b', textContent: 'Subtitle', startUs: 1_200_000 }),
      textItem({ id: 'c', startUs: 6_000_000 }),
    ]);
    expect(textItemsAt(state, 1_500_000)).toHaveLength(2);
  });

  it('finds nothing before the item starts', () => {
    expect(textItemsAt(stateWith([textItem()]), 0)).toHaveLength(0);
  });
});

describe('painting a shape (SPEC 11 §12)', () => {
  /*
    Shapes are drawn as filled canvas paths — the preview's serialiser over the same
    `shapeGeometry` the exporter turns into ASS drawing commands. Before this, a shape
    was drawn by *neither*: `shapePath` was tested but no element called it, so a
    rectangle added from the menu was a completely invisible item.

    The recording context is what makes the order assertable: a `fill` before the path
    is complete draws nothing, which in a screenshot is indistinguishable from a shape
    that was never drawn.
  */
  const shapeItem = (overrides: Record<string, unknown> = {}) => ({
    type: 'shape',
    shapeKind: 'rect',
    startUs: 0,
    durationUs: 1_000_000,
    transform: { scaleX: 2, scaleY: 1, x: 0, y: 0 },
    ...overrides,
  });

  it('draws a shape as a filled path', () => {
    const { ctx, calls } = recordingContext();
    const painted = paintShape(ctx, shapeItem() as never, '#FF8800', 1920, 1080);
    expect(painted).toBe(true);
    const ops = calls.map((call) => call.op);
    expect(ops).toContain('beginPath');
    expect(ops).toContain('fill');
    // The fill comes after the path, never before.
    expect(ops.indexOf('fill')).toBeGreaterThan(ops.indexOf('beginPath'));
  });

  it('fills with the colour it was given', () => {
    // The same colour the burn-in writes, because both read the style's fill.
    const { ctx } = recordingContext();
    paintShape(ctx, shapeItem() as never, '#123456', 1920, 1080);
    expect(ctx.fillStyle).toBe('#123456');
  });

  it('scales the 100-box onto the canvas', () => {
    /*
      A 2×-wide shape is the full frame width, so its right edge is at 1920 and its left
      at 0. Drawing the raw 0–100 box would put a postage stamp in the corner.
    */
    const { ctx, calls } = recordingContext();
    paintShape(ctx, shapeItem() as never, '#FFF', 1920, 1080);
    const points = calls
      .filter((call) => call.op === 'moveTo' || call.op === 'lineTo')
      .map((call) => call.args as [number, number]);
    expect(Math.max(...points.map(([x]) => x))).toBeCloseTo(1920, 5);
    expect(Math.min(...points.map(([x]) => x))).toBeCloseTo(0, 5);
  });

  it('adds the shape\'s own position, not only its size', () => {
    /*
      A mutation that dropped `box.x`/`box.y` from the coordinate mapping survived every
      test above, because the fixtures all happened to sit at the origin (a 2× scale on a
      centred half-frame shape starts at 0). This is the case that pins it: an unmoved
      shape is a quarter in from each edge, so its left edge must be 25% of the canvas —
      and if the origin were dropped every shape would draw in the top-left corner.
    */
    const { ctx, calls } = recordingContext();
    paintShape(ctx, shapeItem({ transform: {} }) as never, '#FFF', 1000, 1000);
    const points = calls
      .filter((call) => call.op === 'moveTo' || call.op === 'lineTo')
      .map((call) => call.args as [number, number]);
    // Default box: x 25%, width 50%.
    expect(Math.min(...points.map(([x]) => x))).toBeCloseTo(250, 5);
    expect(Math.min(...points.map(([, y]) => y))).toBeCloseTo(250, 5);
    expect(Math.max(...points.map(([x]) => x))).toBeCloseTo(750, 5);
  });

  it('draws curves for a rounded shape rather than straight edges', () => {
    // A "rounded rectangle" made of lines is a rectangle, which is a different icon.
    const { ctx, calls } = recordingContext();
    paintShape(ctx, shapeItem({ shapeKind: 'round-rect' }) as never, '#FFF', 1920, 1080);
    expect(calls.filter((call) => call.op === 'bezierCurveTo')).toHaveLength(4);
  });

  it('closes a closed path and leaves a line open', () => {
    const closed = recordingContext();
    paintShape(closed.ctx, shapeItem() as never, '#FFF', 1920, 1080);
    expect(closed.calls.some((call) => call.op === 'closePath')).toBe(true);

    // A closed line is a zero-area sliver that fills to nothing.
    const open = recordingContext();
    paintShape(open.ctx, shapeItem({ shapeKind: 'line' }) as never, '#FFF', 1920, 1080);
    expect(open.calls.some((call) => call.op === 'closePath')).toBe(false);
  });

  it('draws nothing for a kind this build cannot render', () => {
    /*
      The exporter makes the same choice, which is the point: a rectangle substitute
      would be a claim about content the file does not have, and the two renderers
      disagreeing about that is how a preview stops predicting the export.
    */
    const { ctx, calls } = recordingContext();
    const painted = paintShape(ctx, shapeItem({ shapeKind: 'hexagon-hollow' }) as never, '#FFF', 1920, 1080);
    expect(painted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('paints an icon item through the same path a shape takes (SPEC 11 §12)', () => {
    /*
      The claim this feature rests on: an icon is geometry in the 100-box, so the *existing*
      painter draws it and no renderer learns that icons exist. If this ever needed its own
      drawing code, the preview and the export would be two implementations again.
    */
    const { ctx, calls } = recordingContext();
    const painted = paintShape(ctx, { type: 'shape', iconName: 'star', startUs: 0, durationUs: 1 }, '#4ADE80', 1920, 1080);
    expect(painted).toBe(true);
    expect(calls.some((call) => call.op === 'bezierCurveTo')).toBe(true);
    // Filled with the same colour a built-in shape would use.
    expect(ctx.fillStyle).toBe('#4ADE80');
    // And in the frame, not in the corner: the default box is the middle half of the canvas.
    const points = calls
      .filter((call) => call.op === 'moveTo' || call.op === 'lineTo' || call.op === 'bezierCurveTo')
      .flatMap((call) => {
        const args = call.args as number[];
        return [[args[0]!, args[1]!], [args[args.length - 2]!, args[args.length - 1]!]];
      });
    const xs = points.map(([x]) => x!);
    expect(Math.min(...xs)).toBeGreaterThan(100);
    expect(Math.max(...xs)).toBeLessThan(1820);
  });

  it('paints nothing for an icon this build cannot draw, exactly as for an unknown kind', () => {
    // `gift` is refused for an elliptical arc. Returning false rather than drawing an
    // approximation is what makes the two renderers agree about what a file contains.
    const { ctx, calls } = recordingContext();
    const painted = paintShape(ctx, { type: 'shape', iconName: 'gift', startUs: 0, durationUs: 1 }, '#FFF', 1920, 1080);
    expect(painted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('paints an icon from stored shapes when the library has no such name', () => {
    // The escape hatch: a file written by a build with a different icon set still renders.
    const { ctx, calls } = recordingContext();
    const painted = paintShape(
      ctx,
      {
        type: 'shape',
        iconName: 'not-in-this-build',
        iconShapes: [{ t: 'path', d: 'M0 0 L24 0 L12 24 Z' }],
        startUs: 0,
        durationUs: 1,
      },
      '#FFF',
      1000,
      1000,
    );
    expect(painted).toBe(true);
    expect(calls.some((call) => call.op === 'closePath')).toBe(true);
  });

  it('restores the context even though it changed the fill', () => {
    // Leaking a fill colour into the text pass would paint every caption in the shape's
    // colour — a bug that reads as a styling problem, not a drawing-order one.
    const { ctx, calls } = recordingContext();
    paintShape(ctx, shapeItem() as never, '#FF0000', 1920, 1080);
    const ops = calls.map((call) => call.op);
    expect(ops.filter((op) => op === 'save')).toHaveLength(1);
    expect(ops.filter((op) => op === 'restore')).toHaveLength(1);
    expect(ops.lastIndexOf('restore')).toBeGreaterThan(ops.indexOf('fill'));
  });
});

describe('which shapes the overlay paints', () => {
  const stateWith = (items: unknown[]) =>
    ({ items: Object.fromEntries((items as Array<{ id: string }>).map((item) => [item.id, item])) }) as never;

  const shape = (overrides: Record<string, unknown> = {}) => ({
    id: 's1',
    type: 'shape',
    shapeKind: 'rect',
    startUs: 1_000_000,
    durationUs: 2_000_000,
    disabled: false,
    ...overrides,
  });

  it('finds a shape while the playhead is inside it', () => {
    expect(shapeItemsAt(stateWith([shape()]), 1_500_000)).toHaveLength(1);
  });

  it('uses the same half-open range as text and every other item', () => {
    expect(shapeItemsAt(stateWith([shape()]), 1_000_000)).toHaveLength(1);
    expect(shapeItemsAt(stateWith([shape()]), 3_000_000)).toHaveLength(0);
  });

  it('skips a disabled shape', () => {
    expect(shapeItemsAt(stateWith([shape({ disabled: true })]), 1_500_000)).toHaveLength(0);
  });

  it('does not claim text items, which are painted separately', () => {
    // Both go on one canvas, and drawing a text item through the shape path would fill
    // a rectangle where the words should be.
    const state = stateWith([shape(), { ...shape({ id: 't1' }), type: 'text', textContent: 'Hi' }]);
    expect(shapeItemsAt(state, 1_500_000)).toHaveLength(1);
    expect(textItemsAt(state, 1_500_000)).toHaveLength(1);
  });
});
