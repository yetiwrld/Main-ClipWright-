import { describe, expect, it } from 'vitest';
import {
  CWSTYLE_FORMAT,
  CWSTYLE_FORMAT_VERSION,
  collectUnknownFields,
  exportStyle,
  importStyle,
  migrateStyle,
  parseStyle,
  tryParseStyle,
  type CaptionStyle,
} from '../schema.js';
import { BUILT_IN_STYLES, DEFAULT_STYLE, DEFAULT_STYLE_ID, builtInStyle, resolveStyle } from '../presets.js';

const validStyle = () => JSON.parse(JSON.stringify(BUILT_IN_STYLES[0]!));

describe('the .cwstyle schema (SPEC 11 §6)', () => {
  it('accepts every shipped preset', () => {
    // BUILT_IN_STYLES is built by parsing all ten, so reaching here at all means
    // they validate — this asserts the count so a missing import is noticed.
    expect(BUILT_IN_STYLES).toHaveLength(10);
  });

  it('names all ten presets with the exact names SPEC 11 §5 requires', () => {
    expect(BUILT_IN_STYLES.map((style) => style.name)).toEqual([
      'Clean Minimal',
      'Bold Creator',
      'Highlighted Keywords',
      'Karaoke',
      'Word by Word',
      'Multi-line Subtitle',
      'Animated Slide',
      'Editorial',
      'Podcast',
      'Social Pop',
    ]);
  });

  it('defaults to Bold Creator, as SPEC 02 §4.4 requires', () => {
    expect(DEFAULT_STYLE_ID).toBe('bold-creator');
    expect(DEFAULT_STYLE.name).toBe('Bold Creator');
    expect(builtInStyle('bold-creator')).toBeDefined();
  });

  it('rejects a colour that is not #RRGGBB', () => {
    const style = validStyle();
    style.fill.color = 'white';
    const result = tryParseStyle(style);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('fill.color');
  });

  it('rejects a colour with the wrong digit count', () => {
    const style = validStyle();
    style.outline.color = '#FFF';
    expect(tryParseStyle(style).ok).toBe(false);
  });

  it('bounds values that would break rendering', () => {
    // A 900 px outline would take longer to draw than the frame allows, and a
    // 400% font would overflow any canvas.
    const style = validStyle();
    style.outline.widthPctOfFont = 500;
    expect(tryParseStyle(style).ok).toBe(false);

    const huge = validStyle();
    huge.font.sizePctOfShortSide = 120;
    expect(tryParseStyle(huge).ok).toBe(false);
  });

  it('refuses a file that is not a .cwstyle at all', () => {
    const result = tryParseStyle({ hello: 'world' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it('reports a message rather than throwing, so the import dialog can show it', () => {
    // The import flow calls this on whatever the user dropped on the panel.
    expect(() => tryParseStyle(null)).not.toThrow();
    expect(() => tryParseStyle('a string')).not.toThrow();
    expect(() => tryParseStyle([])).not.toThrow();
  });
});

describe('formatVersion migrations (SPEC 11 §6)', () => {
  it('accepts the current version unchanged', () => {
    const result = migrateStyle(validStyle());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applied).toEqual([]);
  });

  it('refuses a file from a newer build instead of guessing', () => {
    const style = { ...validStyle(), formatVersion: CWSTYLE_FORMAT_VERSION + 1 };
    const result = migrateStyle(style);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The message has to tell the user what to do, not just what failed.
      expect(result.message).toContain('newer version');
      expect(result.message).toContain(String(CWSTYLE_FORMAT_VERSION));
    }
  });

  it('refuses a file with no recognisable format', () => {
    expect(migrateStyle({ format: 'something-else', formatVersion: 1 }).ok).toBe(false);
    expect(migrateStyle(null).ok).toBe(false);
    expect(migrateStyle('text').ok).toBe(false);
  });

  it('has a migration step for every version below the current one', async () => {
    // Every gap must be covered, or a version-1 file from an older release would
    // hit "no migration" at import time.
    const { STYLE_MIGRATIONS } = await import('../schema.js');
    const covered = new Set(STYLE_MIGRATIONS.map((step) => step.from));
    for (let version = 1; version < CWSTYLE_FORMAT_VERSION; version += 1) {
      expect(covered.has(version), `no migration from format version ${version}`).toBe(true);
    }
  });
});

describe('unknown fields survive a round trip (SPEC 11 §6)', () => {
  it('collects top-level fields the schema does not name', () => {
    const unknown = collectUnknownFields({ name: 'x', futureFeature: { a: 1 } });
    expect(unknown).toEqual({ futureFeature: { a: 1 } });
  });

  it('keeps a field from a newer build through import and export', () => {
    const fromNewer = { ...validStyle(), someFutureKnob: 42 };
    const imported = importStyle(fromNewer);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.style.extras?.someFutureKnob).toBe(42);

    const exported = exportStyle(imported.style);
    // Back at the top level, where the build that wrote it expects to find it.
    expect(exported.someFutureKnob).toBe(42);
    expect(exported.extras).toBeUndefined();
  });

  it('does not let a stray extras entry overwrite the format header', () => {
    const style: CaptionStyle = {
      ...parseStyle(validStyle()),
      extras: { format: 'not-a-cwstyle', formatVersion: 99 },
    };
    const exported = exportStyle(style);
    expect(exported.format).toBe(CWSTYLE_FORMAT);
    expect(exported.formatVersion).toBe(CWSTYLE_FORMAT_VERSION);
  });

  it('exports a file this build can read back', () => {
    for (const style of BUILT_IN_STYLES) {
      const round = importStyle(exportStyle(style));
      expect(round.ok, `round trip failed for ${style.name}`).toBe(true);
    }
  });
});

describe('style resolution (SPEC 11 §6)', () => {
  it('prefers the project copy over the built-in', () => {
    const local = { ...builtInStyle('bold-creator')!, name: 'My Bold' };
    const resolved = resolveStyle('bold-creator', { 'bold-creator': local });
    expect(resolved.name).toBe('My Bold');
  });

  it('falls back to the built-in when the project has no copy', () => {
    expect(resolveStyle('karaoke', {}).name).toBe('Karaoke');
  });

  it('falls back to the default for an unknown id rather than rendering nothing', () => {
    // A project saved with a style from a preset that was later removed must
    // still show its captions.
    expect(resolveStyle('deleted-preset', {}).name).toBe('Bold Creator');
    expect(resolveStyle(undefined, {}).name).toBe('Bold Creator');
  });

  it('merges overrides per group instead of replacing them', () => {
    const resolved = resolveStyle('bold-creator', {}, { font: { weight: 400 } } as never);
    // The weight changed; everything else about the font survived.
    expect(resolved.font.weight).toBe(400);
    expect(resolved.font.family).toBe('Montserrat');
    expect(resolved.font.sizePctOfShortSide).toBeGreaterThan(0);
  });

  it('ignores undefined overrides', () => {
    const base = builtInStyle('clean-minimal')!;
    expect(resolveStyle('clean-minimal', {}, { fill: undefined })).toEqual(base);
  });
});
