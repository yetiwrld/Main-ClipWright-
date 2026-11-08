/**
 * ASS caption generation (SPEC 14 §4.3, SPEC 11 §3).
 *
 * These assert on the literal script text rather than on parsed values, because
 * ASS is positional: a `Style:` line has 23 comma-separated fields, and putting one
 * in the wrong place does not fail — it quietly makes the outline blue or the
 * alignment 3 instead of 2. A test that parses the line back with the same field
 * order as the writer would agree with any mistake the writer made.
 */
import { describe, expect, it } from 'vitest';
import { BUILT_IN_STYLES, builtInStyle, type CaptionStyle } from '@clipwright/caption-styles';
import {
  assAlignment,
  assColour,
  assCuesFromPlan,
  assDialogue,
  assHeader,
  assStyleLine,
  assStyleName,
  assTimestamp,
  buildAssScript,
  escapeAssText,
  type AssCue,
} from '../ass-captions.js';

const stylesById = (): Record<string, CaptionStyle> =>
  Object.fromEntries(BUILT_IN_STYLES.map((style) => [style.id, style]));

const options = (overrides: Partial<Parameters<typeof assHeader>[0]> = {}) => ({
  width: 1920,
  height: 1080,
  styles: stylesById(),
  defaultStyleId: 'bold-creator',
  ...overrides,
});

// `Style: ` is a prefix, not a field: splitting on every comma yields 24 pieces and
// the first is the literal label. Dropping it first is what makes index 0 the name.
const fields = (line: string) => line.replace(/^Style:\s*/, '').split(',');

describe('assTimestamp', () => {
  it('formats centiseconds with a non-padded hour', () => {
    expect(assTimestamp(0)).toBe('0:00:00.00');
    expect(assTimestamp(1_234_000)).toBe('0:00:01.23');
    expect(assTimestamp(3_661_500_000)).toBe('1:01:01.50');
  });

  it('rounds to the nearest centisecond rather than truncating', () => {
    // Truncation loses up to 10 ms per cue and drifts a long caption visibly late.
    expect(assTimestamp(1_239_000)).toBe('0:00:01.24');
  });

  it('clamps a negative time to zero', () => {
    // A negative lead can push a cue before the start of the export.
    expect(assTimestamp(-500_000)).toBe('0:00:00.00');
  });
});

describe('assColour', () => {
  it('reverses to ASS byte order', () => {
    expect(assColour('#FF8000')).toBe('&H000080FF&');
  });

  it('expands a three-digit hex', () => {
    expect(assColour('#0F0')).toBe('&H0000FF00&');
  });

  it('falls back to opaque white for something unparseable', () => {
    expect(assColour('nonsense')).toBe('&H00FFFFFF&');
  });
});

describe('assAlignment', () => {
  it('maps the nine anchors to the nine ASS codes', () => {
    // ASS numbers alignment 1–9 from the bottom-left and *counts up to the right*,
    // which is the opposite of every other layout system in this project. Getting
    // the vertical axis backwards is silent — the caption simply appears at the top.
    expect(assAlignment('bottom-left')).toBe(1);
    expect(assAlignment('bottom-center')).toBe(2);
    expect(assAlignment('bottom-right')).toBe(3);
    expect(assAlignment('center-left')).toBe(4);
    expect(assAlignment('center')).toBe(5);
    expect(assAlignment('center-right')).toBe(6);
    expect(assAlignment('top-left')).toBe(7);
    expect(assAlignment('top-center')).toBe(8);
    expect(assAlignment('top-right')).toBe(9);
  });
});

describe('assStyleName', () => {
  it('keeps the id readable', () => {
    expect(assStyleName('bold-creator')).toBe('cw-bold-creator');
  });

  it('replaces a comma, which would break every Dialogue line that used it', () => {
    expect(assStyleName('my,style')).toBe('cw-my_style');
  });

  it('replaces a space too, since ASS compares names after splitting on commas', () => {
    expect(assStyleName('My Style')).toBe('cw-My_Style');
  });
});

describe('assStyleLine', () => {
  it('writes exactly 23 fields', () => {
    // The format line has 23 columns. One short and every value after it shifts.
    expect(fields(assStyleLine(builtInStyle('bold-creator')!, 1920, 1080))).toHaveLength(23);
  });

  it('scales the font size by the short side, so every aspect matches the preview', () => {
    const style = builtInStyle('bold-creator')!;
    const wide = fields(assStyleLine(style, 1920, 1080));
    const tall = fields(assStyleLine(style, 1080, 1920));
    // Both are 7.2% of a 1080 short side.
    expect(wide[2]).toBe('78');
    expect(tall[2]).toBe('78');
  });

  it('puts the fill colour in PrimaryColour', () => {
    const line = assStyleLine(builtInStyle('bold-creator')!, 1920, 1080);
    expect(fields(line)[3]).toBe(assColour('#FFFFFF'));
  });

  it('inverts the fill opacity into the alpha byte', () => {
    const karaoke = builtInStyle('karaoke')!;
    // Karaoke is a \k style, so its base text lives in SecondaryColour; the base
    // text is white at 60% opacity, so alpha is 40% of 255 = 102.
    expect(fields(assStyleLine(karaoke, 1920, 1080))[4]).toBe('&H66FFFFFF&');
  });

  it('puts the karaoke highlight in PrimaryColour and the base text in Secondary', () => {
    // `\k` reveals PrimaryColour and leaves the rest in SecondaryColour. Swapping
    // them makes an unspoken karaoke word the highlight colour — which is exactly
    // the bug these two assertions lock down.
    const karaoke = builtInStyle('karaoke')!;
    const line = fields(assStyleLine(karaoke, 1920, 1080));
    expect(line[3]).toBe(assColour(karaoke.highlight.color));
    expect(line[4]).toBe('&H66FFFFFF&');
  });

  it('leaves the fill fully opaque when the style is', () => {
    expect(fields(assStyleLine(builtInStyle('bold-creator')!, 1920, 1080))[3]).toBe('&H00FFFFFF&');
  });

  it('writes the outline width in pixels, not percent', () => {
    const style = builtInStyle('bold-creator')!;
    const line = fields(assStyleLine(style, 1920, 1080));
    // 9% of a 78-px font ≈ 7.0 px.
    expect(Number(line[16])).toBeCloseTo(7.02, 1);
  });

  it('uses no outline for a style that has none', () => {
    expect(fields(assStyleLine(builtInStyle('clean-minimal')!, 1920, 1080))[16]).toBe('0.0');
  });

  it('marks bold from the weight, which ASS only has as a flag', () => {
    // ASS cannot express 800, so the flag is the whole truth about weight on export.
    expect(fields(assStyleLine(builtInStyle('bold-creator')!, 1920, 1080))[7]).toBe('-1');
    expect(fields(assStyleLine(builtInStyle('clean-minimal')!, 1920, 1080))[7]).toBe('0');
  });

  it('uses BorderStyle 1 so the shadow is a shadow and not a box', () => {
    // BorderStyle 3 would paint a filled rectangle behind every line.
    expect(fields(assStyleLine(builtInStyle('bold-creator')!, 1920, 1080))[15]).toBe('1');
  });

  it('carries the alignment from the style anchor', () => {
    const style = builtInStyle('bold-creator')!;
    expect(fields(assStyleLine(style, 1920, 1080))[18]).toBe(String(assAlignment(style.position.anchor)));
  });

  it('writes every built-in preset without producing a field-count change', () => {
    for (const style of BUILT_IN_STYLES) {
      const parsed = fields(assStyleLine(style, 1920, 1080));
      expect(parsed, style.id).toHaveLength(23);
      // A NaN in the output is a number that did not make it through a division.
      expect(parsed.join(','), style.id).not.toContain('NaN');
    }
  });
});

describe('assHeader', () => {
  it('pins PlayRes to the output size so sizes are not rescaled by libass', () => {
    const header = assHeader(options());
    expect(header).toContain('PlayResX: 1920');
    expect(header).toContain('PlayResY: 1080');
  });

  it('declares every style, sorted by id for a stable diff', () => {
    const header = assHeader(options());
    const names = [...header.matchAll(/^Style: (cw-\S+?),/gm)].map((match) => match[1]);
    expect(names).toHaveLength(BUILT_IN_STYLES.length);
    expect(names).toEqual([...names].sort());
  });

  it('includes the events format line with ten columns', () => {
    const header = assHeader(options());
    const format = header.split('\n').find((line) => line.startsWith('Format: Layer'));
    expect(format?.split(',').length).toBe(10);
  });
});

describe('escapeAssText', () => {
  it('escapes braces so a caption cannot inject an override block', () => {
    // A caption literally containing {\fs200} would otherwise render at a size the
    // user never chose.
    expect(escapeAssText('{\\fs200}big')).toContain('\\{');
    expect(escapeAssText('{\\fs200}big')).toContain('\\}');
  });

  it('escapes a backslash', () => {
    expect(escapeAssText('a\\b')).toBe('a\\\\b');
  });
});

describe('assDialogue', () => {
  const cue: AssCue = {
    startUs: 1_000_000,
    endUs: 2_000_000,
    text: 'hello there',
    words: [
      { text: 'hello', startUs: 1_000_000, endUs: 1_500_000 },
      { text: 'there', startUs: 1_500_000, endUs: 2_000_000 },
    ],
  };

  it('writes ten fields, with the text as everything after the ninth comma', () => {
    // `Dialogue: 0` is the layer column and its label together, exactly as in the
    // format line. The text field legitimately contains commas — `\pos(x,y)` does —
    // so it is split at nine, not at every comma.
    const parts = assDialogue(cue, options()).split(',');
    const head = parts.slice(0, 9);
    const text = parts.slice(9).join(',');
    expect(head).toHaveLength(9);
    expect(text).toContain('hello');
  });

  it('positions and anchors from the style', () => {
    const line = assDialogue(cue, options());
    // Bold Creator sits at 50% / 62% and is centre-anchored.
    expect(line).toContain('\\an5\\pos(960,670)');
  });

  it('emits karaoke timing per word', () => {
    const line = assDialogue(cue, options());
    // Bold Creator is not a karaoke style, so the tag is a plain `\k`.
    expect(line).toContain('{\\k50}hello');
    expect(line).toContain('{\\k50}there');
  });

  it('sweeps rather than jumps for a karaoke style', () => {
    // `\kf` animates the fill across the word, which is what the preview draws;
    // `\k` would snap the whole word over and look like a different caption.
    const karaoke: AssCue = { ...cue, styleId: 'karaoke' };
    const line = assDialogue(karaoke, options());
    expect(line).toContain('{\\kf50}hello');
  });

  it('rounds a word shorter than a centisecond to zero rather than dropping it', () => {
    // A zero-length \k still advances the highlight; omitting the word would lose
    // the text entirely.
    const fast: AssCue = {
      ...cue,
      words: [{ text: 'zip', startUs: 1_000_000, endUs: 1_004_000 }],
    };
    expect(assDialogue(fast, options())).toContain('{\\k0}zip');
  });

  it('holds the cue past its last word by the style amount', () => {
    const line = assDialogue(cue, options());
    // 2.0 s plus Bold Creator's 150 ms hold.
    expect(line.split(',')[2]).toBe('0:00:02.15');
  });

  it('honours an explicit hold override', () => {
    expect(assDialogue(cue, options({ holdMs: 500 })).split(',')[2]).toBe('0:00:02.50');
  });

  it('falls back to plain text for a cue with no word timings', () => {
    const typed: AssCue = { startUs: 0, endUs: 1_000_000, text: 'typed by hand' };
    const line = assDialogue(typed, options());
    expect(line).toContain('typed by hand');
    expect(line).not.toContain('\\k');
  });

  it('turns a stored newline into an ASS line break', () => {
    const twoLine: AssCue = { startUs: 0, endUs: 1_000_000, text: 'first\nsecond' };
    expect(assDialogue(twoLine, options())).toContain('first\\Nsecond');
  });

  it('prefixes a speaker line when the cue has one', () => {
    const spoken: AssCue = { ...cue, speaker: 'Ada' };
    expect(assDialogue(spoken, options())).toContain('Ada\\N');
  });

  it('uses the cue style, not the default', () => {
    const styled: AssCue = { ...cue, styleId: 'karaoke' };
    expect(assDialogue(styled, options())).toContain(',cw-karaoke,');
  });

  it('falls back to the default style for an unknown id', () => {
    // A project saved with a style this build does not have must still burn in.
    const unknown: AssCue = { ...cue, styleId: 'deleted-style' };
    const line = assDialogue(unknown, options());
    expect(line).toContain(',cw-bold-creator,');
  });

  it('applies a negative lead by starting the cue earlier', () => {
    const early = builtInStyle('bold-creator')!;
    const withLead = { ...early, timing: { ...early.timing, leadMs: -100 } };
    const line = assDialogue(cue, options({ styles: { 'bold-creator': withLead }, defaultStyleId: 'bold-creator' }));
    expect(line.split(',')[1]).toBe('0:00:00.90');
  });
});

describe('buildAssScript', () => {
  const cues: AssCue[] = [
    { startUs: 3_000_000, endUs: 4_000_000, text: 'third' },
    { startUs: 0, endUs: 1_000_000, text: 'first' },
    { startUs: 1_000_000, endUs: 2_000_000, text: 'second' },
  ];

  it('sorts cues into timeline order', () => {
    const script = buildAssScript(cues, options());
    const order = script
      .split('\n')
      .filter((line) => line.startsWith('Dialogue:'))
      // The text field is everything after the ninth comma; a `\pos(x,y)` override
      // puts commas of its own inside it.
      .map((line) => line.split(',').slice(9).join(',').replace(/^\{[^}]*\}/, ''));
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('drops an empty cue rather than spending render time on nothing', () => {
    const withEmpty = [...cues, { startUs: 5_000_000, endUs: 6_000_000, text: '   ' }];
    const dialogues = buildAssScript(withEmpty, options()).split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(3);
  });

  it('keeps a cue whose text is empty but whose words are not', () => {
    // A caption generated from a transcript can have its text resolved from the
    // word refs at render time; dropping it on the text alone would lose the cue.
    const wordsOnly: AssCue = {
      startUs: 0,
      endUs: 1_000_000,
      text: '',
      words: [{ text: 'word', startUs: 0, endUs: 1_000_000 }],
    };
    expect(buildAssScript([wordsOnly], options())).toContain('word');
  });

  it('ends with a newline', () => {
    // A file whose last line has no terminator makes some muxers warn.
    expect(buildAssScript(cues, options()).endsWith('\n')).toBe(true);
  });

  it('produces the same script for the same input, byte for byte', () => {
    // The export plan is deterministic (SPEC 14 §2.3); the subtitle file has to be
    // too, or two identical exports would differ.
    expect(buildAssScript(cues, options())).toBe(buildAssScript(cues, options()));
  });
});

describe('assCuesFromPlan', () => {
  const plan = (items: unknown[]) => ({ rangeStartUs: 0, items }) as never;

  const caption = (overrides: Record<string, unknown> = {}) => ({
    type: 'caption',
    startUs: 500_000,
    durationUs: 1_500_000,
    captionText: 'Hello there world',
    captionStyleId: 'karaoke',
    captionSegment: {
      text: 'Hello there world',
      wordRefs: [
        { wordId: 'w1', startUs: 500_000, endUs: 900_000 },
        { wordId: 'w2', startUs: 900_000, endUs: 1_300_000 },
      ],
    },
    ...overrides,
  });

  const transcript = { w1: 'Hello', w2: 'there' };

  it('carries the caption style through to the cue', () => {
    // Losing this burns every caption in the default look while still looking
    // like a successful export.
    const [cue] = assCuesFromPlan(plan([caption()]), (id) => transcript[id as never]);
    expect(cue!.styleId).toBe('karaoke');
  });

  it('shifts times by the range start', () => {
    // The script is in output time; the plan is in composition time. Exporting
    // 10 s–20 s must put a 12 s caption at 2 s.
    const shifted = assCuesFromPlan({ rangeStartUs: 10_000_000, items: [caption()] } as never, (id) => transcript[id as never]);
    expect(shifted[0]!.startUs).toBe(-9_500_000 + 0);
    expect(shifted[0]!.words?.[0]!.startUs).toBe(500_000 - 10_000_000);
  });

  it('resolves word text from the transcript, since refs carry only timing', () => {
    const [cue] = assCuesFromPlan(plan([caption()]), (id) => transcript[id as never]);
    expect(cue!.words?.map((word) => word.text)).toEqual(['Hello', 'there']);
  });

  it('prefers a per-caption text override', () => {
    const edited = caption({
      captionSegment: {
        text: 'Hi there',
        wordRefs: [
          { wordId: 'w1', startUs: 500_000, endUs: 900_000, textOverride: 'Hi' },
          { wordId: 'w2', startUs: 900_000, endUs: 1_300_000 },
        ],
      },
    });
    const [cue] = assCuesFromPlan(plan([edited]), (id) => transcript[id as never]);
    expect(cue!.words?.map((word) => word.text)).toEqual(['Hi', 'there']);
  });

  it('drops karaoke words entirely when any word has no text', () => {
    // A partial karaoke list would silently omit a word from the burn-in; plain
    // text for the whole cue is the honest degradation.
    const [cue] = assCuesFromPlan(plan([caption()]), () => undefined);
    expect(cue!.words).toBeUndefined();
    expect(cue!.text).toBe('Hello there world');
  });

  it('skips a caption with neither text nor resolvable words', () => {
    const empty = caption({ captionText: '', captionSegment: { text: '', wordRefs: [] } });
    expect(assCuesFromPlan(plan([empty]), () => undefined)).toEqual([]);
  });

  it('ignores items that are not captions', () => {
    const video = { type: 'video', startUs: 0, durationUs: 1_000_000 };
    expect(assCuesFromPlan(plan([video, caption()]), (id) => transcript[id as never])).toHaveLength(1);
  });

  it('falls back to captionText when the segment has no text', () => {
    const noText = caption({ captionSegment: { text: '', wordRefs: [] } });
    const [cue] = assCuesFromPlan(plan([noText]), () => undefined);
    expect(cue!.text).toBe('Hello there world');
  });
});
