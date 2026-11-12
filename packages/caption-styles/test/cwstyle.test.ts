import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, CaptionStyleSchema, parseCaptionStyle, resolveStyle } from '../src/index.js';

describe('built-in presets', () => {
  it('ships exactly the ten required presets and they all validate', () => {
    expect(BUILTIN_PRESETS).toHaveLength(10);
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(10);
    for (const p of BUILTIN_PRESETS) {
      expect(() => CaptionStyleSchema.parse(p), p.id).not.toThrow();
    }
  });

  it('includes the required default Bold Creator preset', () => {
    const bold = BUILTIN_PRESETS.find((p) => p.id === 'bold-creator')!;
    expect(bold.font.case ?? bold.text.case).toBe('upper');
    expect(bold.name).toBe('Bold Creator');
  });
});

describe('parse & round-trip', () => {
  it('round-trips a preset losslessly', () => {
    const p = BUILTIN_PRESETS[0]!;
    const parsed = parseCaptionStyle(JSON.parse(JSON.stringify(p)));
    expect(parsed).toEqual(p);
  });

  it('keeps unknown fields on import (forward compat)', () => {
    const p = { ...BUILTIN_PRESETS[0]!, futureThing: 'x' };
    const parsed = parseCaptionStyle(p);
    expect((parsed as Record<string, unknown>).futureThing).toBe('x');
  });

  it('rejects malformed styles with a plain error', () => {
    const bad = { ...BUILTIN_PRESETS[0]!, font: { family: '' } };
    expect(() => parseCaptionStyle(bad)).toThrow();
    expect(() => parseCaptionStyle({ format: 'nope' })).toThrow();
  });
});

describe('resolveStyle', () => {
  it('prefers project-local copy over built-in, and item overrides over both', () => {
    const local = { ...BUILTIN_PRESETS[0]!, id: 'bold-creator', name: 'My Bold' };
    expect(resolveStyle('bold-creator', local).name).toBe('My Bold');
    const overridden = resolveStyle('bold-creator', null, { name: 'Override' });
    expect(overridden.name).toBe('Override');
  });

  it('throws a clear error for an unknown preset', () => {
    expect(() => resolveStyle('does-not-exist')).toThrow(/Unknown caption preset/);
  });
});
