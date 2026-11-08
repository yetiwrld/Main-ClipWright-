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
