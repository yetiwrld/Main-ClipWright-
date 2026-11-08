/**
 * SPEC 11 §2 — layout is a pure function and is tested as one.
 *
 * The measure function here is deliberately simple — every glyph 0.5em wide, a
 * space 0.25em — so a line's expected width is arithmetic rather than a
 * screenshot. Wrapping, alignment and word rectangles are exactly the things that
 * used to differ between preview and export, and they are all decidable from the
 * measurements without a canvas.
 */
import { describe, expect, it } from 'vitest';
import { BUILT_IN_STYLES, builtInStyle, type CaptionStyle } from '@clipwright/caption-styles';
import {
  applyCase,
  blockBackground,
  currentWordIndex,
  layoutText,
  splitWords,
  wordProgress,
  type MeasureText,
} from '../text-layout.js';

/** Deterministic stand-in for the canvas text metrics. */
const measure: MeasureText = (text, fontPx) => {
  let width = 0;
  for (const char of text) width += char === ' ' ? 0.25 * fontPx : 0.5 * fontPx;
  return width;
};

const style = (id: string, overrides: Partial<CaptionStyle> = {}): CaptionStyle => ({
  ...builtInStyle(id)!,
  ...overrides,
});

const layout = (text: string, captionStyle: CaptionStyle, width = 1920, height = 1080) =>
  layoutText({ text, style: captionStyle, canvasWidth: width, canvasHeight: height, measure });

describe('text casing (SPEC 11 §6)', () => {
  it('applies the four modes', () => {
    expect(applyCase('Hello World', 'none')).toBe('Hello World');
    expect(applyCase('Hello World', 'upper')).toBe('HELLO WORLD');
    expect(applyCase('Hello World', 'lower')).toBe('hello world');
    expect(applyCase('hello world', 'title')).toBe('Hello World');
  });

  it('keeps apostrophes and accents intact when titling', () => {
    expect(applyCase("don't stop", 'title')).toBe("Don't Stop");
    expect(applyCase('élan vital', 'title')).toBe('Élan Vital');
  });

  it('does not corrupt emoji or symbols', () => {
    expect(applyCase('nice 🎬 clip', 'upper')).toBe('NICE 🎬 CLIP');
  });
});

describe('words', () => {
  it('splits on whitespace only, keeping hyphenated and apostrophised words whole', () => {
    // Splitting `well-known` would make karaoke light half a word.
    expect(splitWords('a well-known don’t')).toEqual(['a', 'well-known', 'don’t']);
  });

  it('ignores runs of whitespace', () => {
    expect(splitWords('  one   two \n three ')).toEqual(['one', 'two', 'three']);
  });
});

describe('layout (SPEC 11 §2)', () => {
  it('sizes the font from the short side, not the width', () => {
    const square = layout('Test', style('clean-minimal'), 1000, 1000);
    const landscape = layout('Test', style('clean-minimal'), 1000, 2000);
    // Short side is 1000 in both, so the font must match — this is what makes a
    // style look the same at any aspect ratio.
    expect(square.fontPx).toBeCloseTo(landscape.fontPx, 5);
  });

  it('scales with resolution', () => {
    const hd = layout('Test', style('clean-minimal'), 1920, 1080);
    const uhd = layout('Test', style('clean-minimal'), 3840, 2160);
    expect(uhd.fontPx).toBeCloseTo(hd.fontPx * 2, 5);
  });

  it('wraps at the measured width', () => {
    const captionStyle = style('clean-minimal', {
      text: { ...style('clean-minimal').text, maxLinesHint: 4 },
      position: { ...style('clean-minimal').position, maxWidthPct: 40 },
      font: { ...style('clean-minimal').font, sizePctOfShortSide: 5 },
    });
    const result = layout('one two three four five six seven eight nine ten', captionStyle);
    expect(result.lines.length).toBeGreaterThan(1);
    // No line exceeds the box, which is the promise the wrapping makes.
    const boxWidth = (captionStyle.position.maxWidthPct / 100) * 1920;
    for (const line of result.lines) {
      expect(line.width).toBeLessThanOrEqual(boxWidth + 0.001);
    }
  });

  it('gives every word a rectangle inside its line', () => {
    const result = layout('one two three', style('bold-creator'));
    expect(result.words).toHaveLength(3);
    for (const word of result.words) {
      expect(word.y).toBe(result.lines[0]!.y);
      expect(word.height).toBeGreaterThan(0);
      expect(word.width).toBeGreaterThan(0);
    }
    // Words advance left to right.
    const xs = result.words.map((word) => word.x);
    expect(xs).toEqual([...xs].sort((left, right) => left - right));
  });

  it('gives words contiguous indexes across lines', () => {
    const captionStyle = style('clean-minimal', {
      position: { ...style('clean-minimal').position, maxWidthPct: 25 },
      text: { ...style('clean-minimal').text, maxLinesHint: 5 },
    });
    const result = layout('alpha beta gamma delta epsilon', captionStyle);
    expect(result.words.map((word) => word.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports overflow instead of silently dropping text', () => {
    const captionStyle = style('clean-minimal', {
      position: { ...style('clean-minimal').position, maxWidthPct: 20 },
      text: { ...style('clean-minimal').text, maxLinesHint: 1 },
    });
    const result = layout('one two three four five six seven', captionStyle);
    expect(result.overflowed).toBe(true);
    expect(result.droppedWords.length).toBeGreaterThan(0);
    expect(result.lines).toHaveLength(1);
  });

  it('centres the block on xPct for a centre anchor', () => {
    const result = layout('centred', style('bold-creator'));
    const blockCentre = result.bounds.x + result.bounds.width / 2;
    expect(blockCentre).toBeCloseTo(960, 0);
  });

  it('keeps the block centre fixed at yPct however many lines it has', () => {
    // A caption that jumps upward when a second line appears is unreadable.
    const one = layout('short', style('bold-creator'));
    const two = layout('a much longer caption that wraps onto two lines here', style('bold-creator'));
    const centre = (result: typeof one) => result.bounds.y + result.bounds.height / 2;
    expect(centre(two)).toBeCloseTo(centre(one), 0);
  });

  it('anchors bottom styles by their bottom edge', () => {
    const captionStyle = style('multi-line-subtitle');
    const result = layout('bottom aligned', captionStyle);
    const bottomEdge = result.bounds.y + result.bounds.height;
    expect(bottomEdge).toBeCloseTo((captionStyle.position.yPct / 100) * 1080, 0);
  });

  it('honours left, centre and right alignment within the block', () => {
    const base = style('multi-line-subtitle', {
      position: { anchor: 'bottom-center', xPct: 50, yPct: 80, maxWidthPct: 60 },
      text: { ...style('multi-line-subtitle').text, maxLinesHint: 4 },
      background: { ...style('multi-line-subtitle').background, enabled: false },
    });
    // The *second* line is the short one. Alignment only shows on a line that is
    // narrower than the block — the block is as wide as its widest line, so a
    // single full-width line cannot shift anywhere, in any mode.
    const long = 'the quick brown fox jumps over the lazy dog and keeps going on and on forever';

    const left = layout(long, { ...base, text: { ...base.text, align: 'left' } });
    const centre = layout(long, { ...base, text: { ...base.text, align: 'center' } });
    const right = layout(long, { ...base, text: { ...base.text, align: 'right' } });

    expect(left.lines.length).toBeGreaterThan(1);
    const last = (result: typeof left) => result.lines[result.lines.length - 1]!.words[0]!.x;
    expect(last(left)).toBeLessThan(last(centre));
    expect(last(right)).toBeGreaterThan(last(centre));
    // The first line is the widest, so it is the block itself and does not move.
    expect(left.lines[0]!.words[0]!.x).toBeCloseTo(centre.lines[0]!.words[0]!.x, 5);
  });

  it('returns an empty layout for empty text rather than throwing', () => {
    const result = layout('   ', style('clean-minimal'));
    expect(result.lines).toEqual([]);
    expect(result.words).toEqual([]);
    expect(result.bounds.width).toBe(0);
  });

  it('lets a single over-long word overflow its own line instead of splitting it', () => {
    // Splitting a word across caption lines is worse than overhanging the margin.
    const result = layout('supercalifragilisticexpialidocious', style('clean-minimal', {
      position: { ...style('clean-minimal').position, maxWidthPct: 10 },
    }));
    expect(result.lines).toHaveLength(1);
    expect(result.words[0]!.text).toBe('supercalifragilisticexpialidocious');
  });

  it('applies the style casing before measuring', () => {
    const result = layout('hello', style('bold-creator'));
    expect(result.words[0]!.text).toBe('HELLO');
  });
});

describe('backgrounds (SPEC 11 §5)', () => {
  it('produces one box per line when perLine is set', () => {
    const captionStyle = style('podcast', {
      position: { ...style('podcast').position, maxWidthPct: 25 },
      text: { ...style('podcast').text, maxLinesHint: 5 },
    });
    const result = layout('one two three four five', captionStyle);
    expect(result.lines.length).toBeGreaterThan(1);
    for (const line of result.lines) expect(line.background).not.toBeNull();
    expect(blockBackground(result, captionStyle, 1080)).toBeNull();
  });

  it('produces one block box when perLine is false', () => {
    const captionStyle = style('multi-line-subtitle');
    const result = layout('two lines of subtitle text here', captionStyle);
    for (const line of result.lines) expect(line.background).toBeNull();
    const block = blockBackground(result, captionStyle, 1080);
    expect(block).not.toBeNull();
    expect(block!.width).toBeGreaterThan(result.bounds.width);
    expect(block!.height).toBeGreaterThan(result.bounds.height);
  });

  it('produces nothing when backgrounds are disabled', () => {
    const captionStyle = style('bold-creator');
    const result = layout('no box', captionStyle);
    expect(result.lines.every((line) => line.background === null)).toBe(true);
    expect(blockBackground(result, captionStyle, 1080)).toBeNull();
  });

  it('scales padding with the canvas, so a 4K export matches the 1080p preview', () => {
    const captionStyle = style('multi-line-subtitle');
    const hd = layout('test', captionStyle, 1920, 1080);
    const uhd = layout('test', captionStyle, 3840, 2160);
    const hdBlock = blockBackground(hd, captionStyle, 1080)!;
    const uhdBlock = blockBackground(uhd, captionStyle, 2160)!;
    expect(uhdBlock.width).toBeCloseTo(hdBlock.width * 2, 0);
  });
});

describe('word timing (SPEC 11 §5 karaoke and word-by-word)', () => {
  const words = [
    { startUs: 0, endUs: 500_000 },
    { startUs: 500_000, endUs: 900_000 },
    { startUs: 900_000, endUs: 1_400_000 },
  ];

  it('finds the word being spoken', () => {
    const captionStyle = style('karaoke');
    expect(currentWordIndex(words, 100_000, captionStyle)).toBe(0);
    expect(currentWordIndex(words, 600_000, captionStyle)).toBe(1);
    expect(currentWordIndex(words, 1_000_000, captionStyle)).toBe(2);
  });

  it('returns -1 before the first word', () => {
    expect(currentWordIndex(words, -1, style('karaoke'))).toBe(-1);
  });

  it('shifts the window by lead and lag', () => {
    const early = style('karaoke', {
      timing: { ...style('karaoke').timing, leadMs: 100 },
    });
    // 100 ms of lead means word 2 is already current at 450 ms.
    expect(currentWordIndex(words, 450_000, early)).toBe(1);
    expect(currentWordIndex(words, 450_000, style('karaoke'))).toBe(0);
  });

  it('reports karaoke fill progress clamped to 0–1', () => {
    expect(wordProgress(words[0]!, -100)).toBe(0);
    expect(wordProgress(words[0]!, 250_000)).toBeCloseTo(0.5, 3);
    expect(wordProgress(words[0]!, 9_000_000)).toBe(1);
  });

  it('treats a zero-length word as instantly complete', () => {
    expect(wordProgress({ startUs: 100, endUs: 100 }, 99)).toBe(0);
    expect(wordProgress({ startUs: 100, endUs: 100 }, 100)).toBe(1);
  });
});

describe('every shipped preset lays out without error', () => {
  for (const preset of BUILT_IN_STYLES) {
    it(`${preset.name}`, () => {
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
        [1080, 1080],
        [1080, 1350],
      ] as const) {
        const result = layoutText({
          text: 'A caption that is long enough to wrap across two lines on a narrow canvas',
          style: preset,
          canvasWidth: width,
          canvasHeight: height,
          measure,
        });
        expect(result.lines.length).toBeGreaterThan(0);
        expect(Number.isFinite(result.bounds.x)).toBe(true);
        expect(Number.isFinite(result.bounds.y)).toBe(true);
      }
    });
  }
});
