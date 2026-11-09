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
import { buildExportPlan } from '../planner.js';
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

describe('text items burn in (SPEC 11 §7)', () => {
  /*
    The schema has carried a `text` item type since the beginning, and until this
    existed nothing turned one into a cue — so an editor that drew a title on the
    canvas would produce a file with no title in it, silently. These tests are about
    that reachability first and about the details second.
  */
  const plan = (items: unknown[]) => ({ rangeStartUs: 0, items }) as never;

  const title = (overrides: Record<string, unknown> = {}) => ({
    type: 'text',
    startUs: 1_000_000,
    durationUs: 2_000_000,
    textContent: 'Chapter One',
    captionStyleId: 'bold-creator',
    ...overrides,
  });

  it('turns a text item into a cue', () => {
    const cues = assCuesFromPlan(plan([title()]));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('Chapter One');
  });

  it('uses the item\'s own span, shifted by the range start', () => {
    // A title is on screen for its whole duration — beginning to end, with no word
    // timings to subdivide it.
    const cues = assCuesFromPlan({ rangeStartUs: 500_000, items: [title()] } as never);
    expect(cues[0]!.startUs).toBe(500_000);
    expect(cues[0]!.endUs).toBe(2_500_000);
  });

  it('carries the style, so a title burns in its own look', () => {
    // Losing this burns every title in the default preset while still producing a
    // successful export — the same trap the caption-style test above covers.
    const cues = assCuesFromPlan(plan([title()]));
    expect(cues[0]!.styleId).toBe('bold-creator');
  });

  it('gives a text item no karaoke word list', () => {
    /*
      A title has no transcript behind it. Emitting `words` would make the burn-in try
      to sweep a highlight across timing that does not exist, which either throws or
      renders the title as a static-looking karaoke line.
    */
    const cues = assCuesFromPlan(plan([title()]));
    expect(cues[0]!.words).toBeUndefined();
  });

  it('skips an empty title rather than emitting a blank dialogue', () => {
    // The state between "add text" and typing. A blank cue still occupies a slot in the
    // script and, with a background style, draws an empty box over the footage.
    expect(assCuesFromPlan(plan([title({ textContent: '' })]))).toHaveLength(0);
    expect(assCuesFromPlan(plan([title({ textContent: '   ' })]))).toHaveLength(0);
    expect(assCuesFromPlan(plan([title({ textContent: undefined })]))).toHaveLength(0);
  });

  it('keeps captions, titles and shapes in the same script, in item order', () => {
    /*
      One burn-in draws all three, so a title above a caption must not displace it. The
      shape is the odd one out: it is a cue with empty text and a `shape` payload, which
      `assDialogue` renders as a drawing rather than as escaped text.
    */
    const cues = assCuesFromPlan(
      plan([
        { type: 'caption', startUs: 0, durationUs: 1_000_000, captionText: 'a caption', captionSegment: { text: 'a caption' } },
        title(),
        { type: 'shape', startUs: 0, durationUs: 1_000_000, shapeKind: 'rect' },
      ])
    );
    expect(cues.map((cue) => cue.text)).toEqual(['a caption', 'Chapter One', '']);
    // The cue carries geometry, not a kind: a rectangle is a closed subpath in the 100-box.
    expect(cues[2]!.shape?.geometry).toHaveLength(1);
    expect(cues[2]!.shape?.geometry[0]?.closed).toBe(true);
  });

  it('does not read caption text off a title, or the reverse', () => {
    /*
      The two fields mean different things and are read by different branches. A title
      that only carried `captionText` — or a caption that only carried `textContent` —
      must not cross over, or a future refactor could merge the fields without noticing
      that one of them is a transcript window and the other is a fixed string.
    */
    const titleWithCaptionText = { type: 'text', startUs: 0, durationUs: 1_000_000, captionText: 'wrong' };
    expect(assCuesFromPlan(plan([titleWithCaptionText]))).toHaveLength(0);

    const captionWithTextContent = { type: 'caption', startUs: 0, durationUs: 1_000_000, textContent: 'wrong', captionSegment: {} };
    expect(assCuesFromPlan(plan([captionWithTextContent]))).toHaveLength(0);
  });
});

describe('a shape becomes a drawing, not text (SPEC 11 §12)', () => {
  /*
    The gap this closes was silent: a shape produced no cue, so a rectangle over a clip
    was in the editor and not in the file. The failure mode now available is subtler —
    a shape cue that went down the *text* path would have its drawing commands escaped
    and the style's position applied to absolute coordinates, producing a plausible but
    wrong picture. Both halves are pinned below.
  */
  const plan = (items: unknown[]) => ({ rangeStartUs: 0, items }) as never;
  const options = {
    width: 1920,
    height: 1080,
    styles: { 'bold-creator': builtInStyle('bold-creator')! },
    defaultStyleId: 'bold-creator',
  };

  const shape = (overrides: Record<string, unknown> = {}) => ({
    type: 'shape',
    startUs: 0,
    durationUs: 1_000_000,
    shapeKind: 'rect',
    captionStyleId: 'bold-creator',
    geometry: { transform: { scaleX: 2, scaleY: 1, x: 0, y: 0 } },
    ...overrides,
  });

  it('emits a cue for a shape', () => {
    const cues = assCuesFromPlan(plan([shape()]));
    expect(cues).toHaveLength(1);
    /*
      Geometry rather than a kind, so the serialiser has nothing left to look up. That is what
      lets an icon — which has no `shapeKind` at all — take the same path, instead of being
      dropped by a `if (!item.shapeKind) continue` that looked correct.
    */
    expect(cues[0]!.shape?.geometry.length).toBeGreaterThan(0);
  });

  it('carries the box from the item\'s transform', () => {
    // The default box is half the frame, centred; a 2× scale makes it the full width.
    const cues = assCuesFromPlan(plan([shape()]));
    expect(cues[0]!.shape?.box).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it('renders a dialogue line containing drawing commands', () => {
    const [cue] = assCuesFromPlan(plan([shape()]));
    const line = assDialogue(cue!, options);
    // `\p1` enters drawing mode and a `m`/`l` body follows it.
    expect(line).toContain('\\p1');
    expect(line).toMatch(/\bm\d+/);
    // And it is a real Dialogue line, so libass will draw it.
    expect(line.startsWith('Dialogue: 0,')).toBe(true);
  });

  it('scales the drawing to the output resolution', () => {
    /*
      The box is a percentage of the frame, so at 1920×1080 a full-width rectangle is
      1920 wide. Drawing it at its percent value would produce a shape the size of a
      postage stamp in the corner of a 1080p export.
    */
    const [cue] = assCuesFromPlan(plan([shape()]));
    const line = assDialogue(cue!, options);
    expect(line).toContain('1920');
    expect(line).not.toContain('100 0 l100 1080');
  });

  it('does not put text into a drawing body', () => {
    /*
      Drawing mode reads digits as coordinates. A shape cue that also carried a label
      would render the label's characters as a scribble — and an escaped `\N` would end
      the drawing early.
    */
    const [cue] = assCuesFromPlan(plan([shape()]));
    const line = assDialogue(cue!, options);
    expect(line).not.toContain('\\N');
    /*
      Exactly one override block, at the start of the body. That single brace is the real
      assertion: a second one would be a karaoke or per-word block leaked in from the
      text path, and the drawing commands would be inside it.
    */
    expect(line.split('{').length).toBe(2);
    expect(line.split('}').length).toBe(2);
  });

  it('uses the style fill for the shape\'s colour', () => {
    // A shape has no colour of its own; it borrows the caption style's, so there is one
    // answer to "what colour is this" rather than a field the editor cannot set.
    const [cue] = assCuesFromPlan(plan([shape()]));
    const line = assDialogue(cue!, options);
    const fill = builtInStyle('bold-creator')!.fill.color;
    expect(line).toContain(assColour(fill));
  });

  it('draws nothing for a shape kind this build cannot render', () => {
    /*
      A newer file. A rectangle would be a claim about content the file does not have.

      The check moved earlier: the cue is now built with its geometry resolved, so an
      undrawable shape produces no cue rather than a cue the serialiser returns `''` for. The
      observable result is the same — nothing in the script — and this asserts the result
      rather than which function dropped it.
    */
    const cues = assCuesFromPlan(plan([shape({ shapeKind: 'hexagon-hollow' })]));
    expect(cues).toHaveLength(0);
    // And no cue is ever built with empty geometry, which would serialise to a bare
    // `Dialogue:` line: a blank cue in the script that costs a render and shows nothing.
    expect(cues.every((cue) => cue.shape === undefined || cue.shape.geometry.length > 0)).toBe(true);
  });

  it('skips a shape with no kind and no icon at all', () => {
    expect(assCuesFromPlan(plan([shape({ shapeKind: undefined })]))).toHaveLength(0);
  });

  it('burns an icon item in as a drawing, though it has no shapeKind (SPEC 11 §12)', () => {
    /*
      The bug this exists for: an icon item is a shape with `iconName` and no `shapeKind`, and
      the shape branch began `if (!item.shapeKind) continue` — so every icon was in the editor
      and absent from every export, with nothing reported. The icon resolves to the same kind
      of geometry a rectangle does, so it takes the same path.
    */
    const [cue] = assCuesFromPlan(plan([{ type: 'shape', startUs: 0, durationUs: 1_000_000, iconName: 'star' }]));
    expect(cue).toBeDefined();
    expect(cue!.shape?.geometry.length).toBeGreaterThan(0);
    const line = assDialogue(cue!, options);
    expect(line).toContain('Dialogue:');
    // An ASS drawing, not escaped text: no text body and no drawing-mode escape leak.
    expect(line.length).toBeGreaterThan('Dialogue: 0,'.length);
  });

  it('carries an icon from the project through the planner to the script', () => {
    /*
      End to end, through `buildExportPlan` rather than a hand-built cue. The hand-built
      builders in this file cast to `never`, so they cannot catch a field the *planner* drops
      — and the planner copies fields by hand, which is exactly where an icon would vanish
      between the project file and the render.
    */
    const built = buildExportPlan({
      compositionId: 'comp-1',
      projectId: 'proj-1',
      preset: '1080p',
      aspect: '16:9',
      fps: 30,
      format: 'mp4',
      quality: 'standard',
      rateControl: 'vbr',
      audioBitrate: 192,
      includeAudio: false,
      burnCaptions: true,
      saveSubtitles: false,
      subtitleFormats: [],
      embedProjectName: true,
      normaliseLoudness: false,
      targetLufs: -16,
      isDraft: false,
      rangeUs: [0, 1_000_000],
      compositionFps: 30,
      compositionDurationUs: 1_000_000,
      items: [
        {
          id: 'ico_1',
          trackId: 'track-1',
          type: 'shape',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          disabled: false,
          muted: false,
          hasAudio: false,
          iconName: 'star',
        },
      ],
    });
    const icon = built.items.find((item) => item.itemId === 'ico_1');
    expect(icon?.iconName).toBe('star');

    const [cue] = assCuesFromPlan(built);
    expect(cue).toBeDefined();
    expect(cue!.shape?.geometry.length).toBeGreaterThan(0);
    expect(assDialogue(cue!, options)).toContain('Dialogue:');
  });

  it('leaves out an icon this build cannot draw rather than substituting one', () => {
    // `gift` is refused for an elliptical arc; the preview cannot draw it either, so the
    // user sees it missing where they placed it rather than only in the rendered file.
    expect(assCuesFromPlan(plan([{ type: 'shape', startUs: 0, durationUs: 1_000_000, iconName: 'gift' }]))).toHaveLength(0);
    expect(assCuesFromPlan(plan([{ type: 'shape', startUs: 0, durationUs: 1_000_000, iconName: 'no-such-icon' }]))).toHaveLength(0);
  });

  it('suppresses the caption style\'s outline on the drawing', () => {
    /*
      The borrowed style almost certainly has an outline — every preset does, because
      captions need one to read over footage. Applying it to a filled rectangle draws a
      border the preview never shows.
    */
    const [cue] = assCuesFromPlan(plan([shape()]));
    const line = assDialogue(cue!, options);
    expect(line).toContain('\\bord0');
  });

  it('anchors at the top-left so absolute coordinates are not shifted', () => {
    // `\an5` would move every shape by half the frame, since the coordinates are already
    // absolute within it.
    const [cue] = assCuesFromPlan(plan([shape()]));
    expect(assDialogue(cue!, options)).toContain('\\an7');
  });
});
