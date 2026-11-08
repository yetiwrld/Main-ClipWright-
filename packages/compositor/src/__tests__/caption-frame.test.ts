/**
 * SPEC 11 §3, §5, §7 — the frame builder, tested without a canvas.
 *
 * The interesting cases are the ones where the modes disagree about what a frame
 * even contains: `word-by-word` shows one word, `karaoke-fill` shows all of them
 * with a sweep, `keywords` ignores the clock. Testing only the default style would
 * pass with all three collapsed into one branch, which is exactly the bug these
 * tests exist to catch.
 */
import { describe, expect, it } from 'vitest';
import { builtInStyle, type CaptionStyle } from '@clipwright/caption-styles';
import {
  captionFrameAt,
  captionItemAt,
  type CaptionFrameInput,
  type CaptionWordOverride,
} from '../caption-frame.js';
import type { MeasureText } from '../text-layout.js';

/** Every glyph 0.5em, a space 0.25em — the same stand-in the layout tests use. */
const measure: MeasureText = (text, fontPx) => {
  let width = 0;
  for (const char of text) width += char === ' ' ? 0.25 * fontPx : 0.5 * fontPx;
  return width;
};

const style = (id: string, overrides: Partial<CaptionStyle> = {}): CaptionStyle => ({
  ...builtInStyle(id)!,
  ...overrides,
});

/** Four words, 500 ms each, starting at 1 s. */
const words = [
  { startUs: 1_000_000, endUs: 1_500_000 },
  { startUs: 1_500_000, endUs: 2_000_000 },
  { startUs: 2_000_000, endUs: 2_500_000 },
  { startUs: 2_500_000, endUs: 3_000_000 },
];

const frame = (input: Partial<CaptionFrameInput> & { style: CaptionStyle; timeUs: number }) =>
  captionFrameAt({
    text: 'one two three four',
    wordTimings: words,
    segment: { startUs: 1_000_000, endUs: 3_000_000 },
    canvasWidth: 1920,
    canvasHeight: 1080,
    measure,
    ...input,
  });

describe('karaoke fill (SPEC 11 §5, preset 4)', () => {
  const karaoke = style('karaoke');

  it('sweeps only the word being spoken', () => {
    const at = frame({ style: karaoke, timeUs: 1_250_000 });
    const [first, second] = at.words;
    expect(first!.fillFraction).toBeCloseTo(0.5, 5);
    expect(first!.fillColor).toBe(karaoke.highlight.color);
    expect(second!.fillFraction).toBe(0);
    expect(second!.fillColor).toBeNull();
  });

  it('keeps a spoken word fully filled when keepLit is set', () => {
    expect(karaoke.highlight.keepLit).toBe(true);
    const at = frame({ style: karaoke, timeUs: 2_250_000 });
    expect(at.words[0]!.fillFraction).toBe(1);
    expect(at.words[1]!.fillFraction).toBe(1);
    expect(at.words[2]!.fillFraction).toBeCloseTo(0.5, 5);
    expect(at.words[3]!.fillFraction).toBe(0);
  });

  it('releases spoken words when keepLit is off', () => {
    const releasable = style('karaoke', {
      highlight: { ...karaoke.highlight, keepLit: false },
    });
    const at = frame({ style: releasable, timeUs: 2_250_000 });
    expect(at.words[0]!.fillFraction).toBe(0);
    expect(at.words[2]!.fillFraction).toBeCloseTo(0.5, 5);
  });

  it('shows every word, so the line does not re-wrap mid-sentence', () => {
    const at = frame({ style: karaoke, timeUs: 1_100_000 });
    expect(at.words.every((word) => word.visible)).toBe(true);
  });

  it('never sweeps a word the user recoloured', () => {
    const at = frame({
      style: karaoke,
      timeUs: 1_250_000,
      wordIds: ['a', 'b', 'c', 'd'],
      overrides: { a: { color: '#00FF00' } },
    });
    expect(at.words[0]!.fillFraction).toBe(0);
    expect(at.words[0]!.color).toBe('#00FF00');
  });
});

describe('word by word (SPEC 11 §5, preset 5)', () => {
  const oneAtATime = style('word-by-word');

  it('draws exactly one word', () => {
    const at = frame({ style: oneAtATime, timeUs: 1_750_000 });
    // Anton upper-cases the text, so the rendered word is 'TWO' — comparing to the
    // source word would assert against the style's own casing rule.
    expect(at.words.filter((word) => word.visible).map((word) => word.text)).toEqual(['TWO']);
  });

  it('hides the word after its turn rather than dimming it', () => {
    const at = frame({ style: oneAtATime, timeUs: 2_100_000 });
    expect(at.words[0]!.visible).toBe(false);
    expect(at.words[0]!.opacity).toBe(0);
    expect(at.words[2]!.visible).toBe(true);
  });

  it('keeps the last word up during the hold, not nothing at all', () => {
    const at = frame({ style: oneAtATime, timeUs: 3_100_000 });
    expect(at.words.filter((word) => word.visible).map((word) => word.text)).toEqual(['FOUR']);
  });

  it('lays out all four words regardless, so the frame does not jump', () => {
    // Centring a one-word line differently from a four-word line is what made the
    // preset look like it was twitching; the layout is of the whole caption.
    const first = frame({ style: oneAtATime, timeUs: 1_100_000 });
    const last = frame({ style: oneAtATime, timeUs: 2_600_000 });
    expect(first.words).toHaveLength(4);
    expect(first.layout.bounds).toEqual(last.layout.bounds);
  });
});

describe('highlighted keywords (SPEC 11 §5, preset 3)', () => {
  const keywords = style('highlighted-keywords');

  it('lights the words the user marked, not the word being spoken', () => {
    const at = frame({
      style: keywords,
      timeUs: 1_100_000,
      wordIds: ['a', 'b', 'c', 'd'],
      overrides: { c: { emphasis: true } } satisfies Record<string, CaptionWordOverride>,
    });
    const lit = at.words.filter((word) => word.color === keywords.highlight.color);
    // Poppins does not change case for this preset, so the source word survives.
    expect(lit.map((word) => word.text)).toEqual(['three']);
  });

  it('scales a marked word by the style amount for as long as it shows', () => {
    const at = frame({
      style: keywords,
      timeUs: 1_100_000,
      wordIds: ['a', 'b', 'c', 'd'],
      overrides: { a: { emphasis: true } },
    });
    expect(at.words[0]!.scale).toBe(keywords.highlight.scale);
    expect(at.words[1]!.scale).toBe(1);
  });

  it('leaves every word plain when nothing is marked', () => {
    const at = frame({ style: keywords, timeUs: 2_100_000 });
    expect(at.words.every((word) => word.color === keywords.fill.color)).toBe(true);
  });
});

describe('sequence and word colours (preset 10)', () => {
  const social = style('social-pop');

  it('cycles the style palette as words are spoken', () => {
    const at = frame({ style: social, timeUs: 1_100_000 });
    expect(at.words[0]!.color).toBe(social.wordColors[0]);
    // Not spoken yet: still the plain fill, so the colour arrives with the word.
    expect(at.words[1]!.color).toBe(social.fill.color);
    expect(at.words[2]!.color).toBe(social.fill.color);
  });

  it('wraps the palette for a long caption', () => {
    const at = frame({ style: social, timeUs: 2_900_000 });
    expect(at.words[3]!.color).toBe(social.wordColors[3 % social.wordColors.length]);
  });
});

describe('current-word highlighting (SPEC 11 §6)', () => {
  const current = style('bold-creator', {
    highlight: { ...builtInStyle('bold-creator')!.highlight, mode: 'current-word', color: '#FF0000' },
  });

  it('colours only the current word', () => {
    const at = frame({ style: current, timeUs: 1_750_000 });
    expect(at.words[1]!.color).toBe('#FF0000');
    expect(at.words[0]!.color).toBe(current.fill.color);
  });

  it('shows the whole line', () => {
    expect(frame({ style: current, timeUs: 1_750_000 }).words.every((word) => word.visible)).toBe(true);
  });
});

describe('block animation (SPEC 11 §5)', () => {
  it('fades in over the style duration', () => {
    const minimal = style('clean-minimal');
    const at = frame({ style: minimal, timeUs: 1_000_000 + minimal.animation.in.durationMs * 250 });
    expect(at.opacity).toBeGreaterThan(0);
    expect(at.opacity).toBeLessThan(1);
  });

  it('is fully opaque in the middle of the caption', () => {
    expect(frame({ style: style('clean-minimal'), timeUs: 2_000_000 }).opacity).toBeCloseTo(1, 5);
  });

  it('slides up by the percentage of font size the preset asks for', () => {
    const slide = style('animated-slide');
    // At the first frame none of the distance has been covered, so the offset is
    // the full one; by the end of the entrance it is zero.
    const atStart = frame({ style: slide, timeUs: 1_000_000 });
    const after = frame({ style: slide, timeUs: 1_000_000 + slide.animation.in.durationMs * 1000 + 1 });
    expect(atStart.translateYPx).toBeGreaterThan(0);
    expect(after.translateYPx).toBe(0);
  });

  it('leaves a style with no block animation fully opaque', () => {
    // Word by Word declares `in: none`, so it must not fade — but that is the
    // style's choice, not a special case for per-word animation: Animated Slide
    // wants both a block slide and per-word fades.
    const at = frame({ style: style('word-by-word'), timeUs: 1_200_000 });
    expect(at.opacity).toBe(1);
  });

  it('fades each word in for a style that asks for it', () => {
    const slide = style('animated-slide');
    const first = frame({ style: slide, timeUs: 1_500_000 });
    // Word one started at 1.0 s and its 120 ms fade is long done; word two began
    // at 1.5 s, so it is mid-fade.
    expect(first.words[0]!.opacity).toBeCloseTo(slide.fill.opacity, 5);
    expect(first.words[1]!.opacity).toBeLessThan(slide.fill.opacity);
  });

  it('pops a word up from the scale the preset names', () => {
    const oneAtATime = style('word-by-word');
    const at = frame({ style: oneAtATime, timeUs: 1_500_000 });
    const raw = oneAtATime.animation.perWord.params['from'];
    expect(at.words[1]!.scale).toBeCloseTo(typeof raw === 'number' ? raw : 0.8, 5);
  });

  it('keeps a caption readable at a hard cut when the style asks for one', () => {
    const instant = style('bold-creator', {
      animation: {
        ...builtInStyle('bold-creator')!.animation,
        in: { preset: 'none', durationMs: 0, easing: 'linear', params: {} },
      },
    });
    expect(frame({ style: instant, timeUs: 1_000_000 }).opacity).toBe(1);
  });
});

describe('overrides survive a style swap (SPEC 11 §7)', () => {
  it('applies a colour and a scale on any style', () => {
    for (const id of ['bold-creator', 'karaoke', 'clean-minimal']) {
      const at = frame({
        style: style(id),
        timeUs: 1_100_000,
        wordIds: ['a', 'b', 'c', 'd'],
        overrides: { b: { color: '#123456', scale: 1.5 } },
      });
      expect(at.words[1]!.color, id).toBe('#123456');
      expect(at.words[1]!.scale, id).toBe(1.5);
    }
  });

  it('keys overrides by word id, so re-timing keeps the emphasis', () => {
    // The ids are what the caption stores; using the position would move the
    // emphasis to a different word the first time the caption is split.
    const at = frame({
      style: style('highlighted-keywords'),
      timeUs: 1_100_000,
      wordIds: ['w4', 'w3', 'w2', 'w1'],
      overrides: { w2: { emphasis: true } },
    });
    expect(at.words.filter((word) => word.scale > 1).map((word) => word.text)).toEqual(['three']);
  });
});

describe('clipping', () => {
  it('reports dropped words rather than letting text vanish', () => {
    const tiny = style('multi-line-subtitle', {
      text: { ...builtInStyle('multi-line-subtitle')!.text, maxLinesHint: 1 },
      position: { ...builtInStyle('multi-line-subtitle')!.position, maxWidthPct: 10 },
    });
    const at = frame({ style: tiny, timeUs: 2_000_000 });
    expect(at.droppedWords.length).toBeGreaterThan(0);
  });
});

describe('captionItemAt', () => {
  const items = [
    { id: 'a', type: 'caption', startUs: 0, durationUs: 1_000_000 },
    { id: 'b', type: 'caption', startUs: 1_000_000, durationUs: 1_000_000 },
    { id: 'v', type: 'video', startUs: 0, durationUs: 9_000_000 },
  ];

  it('picks the caption under the playhead', () => {
    expect(captionItemAt(items, 500_000)?.id).toBe('a');
    expect(captionItemAt(items, 1_500_000)?.id).toBe('b');
  });

  it('returns null in a gap and never picks a non-caption', () => {
    expect(captionItemAt(items, 2_000_000)).toBeNull();
    expect(captionItemAt([items[2]!], 500_000)).toBeNull();
  });

  it('treats the end as exclusive, so the next caption wins the boundary', () => {
    expect(captionItemAt([items[0]!, items[1]!], 1_000_000)?.id).toBe('b');
  });

  it('prefers the later of two overlapping captions', () => {
    const overlapping = [
      { id: 'early', type: 'caption', startUs: 0, durationUs: 2_000_000 },
      { id: 'late', type: 'caption', startUs: 500_000, durationUs: 2_000_000 },
    ];
    expect(captionItemAt(overlapping, 1_000_000)?.id).toBe('late');
  });
});

describe('frame anatomy', () => {
  it('gives every drawn word a rectangle inside the canvas', () => {
    const at = frame({ style: style('multi-line-subtitle'), timeUs: 2_000_000 });
    for (const word of at.words) {
      expect(word.rect.x).toBeGreaterThanOrEqual(0);
      expect(word.rect.x + word.rect.width).toBeLessThanOrEqual(1920 + 1);
    }
  });

  it('returns an empty frame for empty text instead of throwing', () => {
    const at = frame({ style: style('bold-creator'), timeUs: 1_000_000, text: '' });
    expect(at.words).toEqual([]);
    expect(at.layout.lines).toEqual([]);
    expect(at.droppedWords).toEqual([]);
  });

  it('survives a caption with no word timings', () => {
    // A hand-typed caption has text but may have no timings at all.
    const at = frame({ style: style('karaoke'), timeUs: 1_500_000, wordTimings: [] });
    expect(at.words).toHaveLength(4);
    expect(at.words.every((word) => word.fillFraction === 0)).toBe(true);
  });
});
