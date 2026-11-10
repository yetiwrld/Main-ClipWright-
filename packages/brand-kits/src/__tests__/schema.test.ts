import { describe, expect, it } from 'vitest';
import {
  BRAND_KIT_MAX_CUSTOM_COLOURS,
  CwbrandFormat,
  CwbrandFormatVersion,
  exportBrandKit,
  importBrandKit,
  tryParseBrandKit,
  type BrandKit,
} from '../index.js';

/**
 * The `.cwbrand` format (SPEC 13 §8.1).
 *
 * The decisions being pinned are the ones that make a kit file safe to open: a wrong file is
 * refused with a reason, a newer file survives a round trip through an older build, and a
 * corrupt value cannot reach the renderer as something impossible.
 */
function kit(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    format: CwbrandFormat,
    formatVersion: CwbrandFormatVersion,
    id: 'kit-1',
    name: 'Studio',
    colors: {
      primary: '#FF7A00',
      secondary: '#1F2937',
      accent: '#4DA3FF',
      background: '#0B0B0F',
      text: '#FFFFFF',
      custom: [],
    },
    fonts: {},
    safeAreaPreset: 'none',
    ...overrides,
  } as BrandKit;
}

describe('the brand kit schema', () => {
  it('accepts a minimal kit and fills in the defaults', () => {
    const result = tryParseBrandKit(kit());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A kit with no logo, no audio and no fonts is a legitimate kit — colours alone.
    expect(result.kit.colors.custom).toEqual([]);
    expect(result.kit.fonts).toEqual({});
    expect(result.kit.safeAreaPreset).toBe('none');
  });

  it('refuses a file that is not a kit, and says why', () => {
    const result = tryParseBrandKit({ format: 'cwstyle', formatVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A `format` literal mismatch is the first thing a wrong file hits, and the message has
    // to point at the field rather than reading like a stack trace.
    expect(result.message).toContain('format');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('refuses a colour that is not a colour', () => {
    const broken = { ...kit(), colors: { ...kit().colors, primary: 'orange' } };
    const result = tryParseBrandKit(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path.startsWith('colors.primary'))).toBe(true);
  });

  it('refuses a placement outside the canvas', () => {
    // A logo at 140% is off-screen, and drawing it anyway would look like a missing logo.
    const broken = kit({ logo: { assetId: 'asset-1', position: 'custom', xPct: 140, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' } });
    expect(tryParseBrandKit(broken).ok).toBe(false);
  });

  it('refuses an opacity above one', () => {
    const broken = kit({ logo: { assetId: 'asset-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1.5, margin: 4, showFrom: 'always', showFor: 'whole' } });
    expect(tryParseBrandKit(broken).ok).toBe(false);
  });

  it('refuses more custom colours than the spec allows', () => {
    /*
      The bound is in the format rather than only in the editor: a file with 400 colours is
      either corrupt or from a build with a different idea of the palette, and loading it
      into a colour picker would be a performance problem before it was a design one.
    */
    const many = Array.from({ length: BRAND_KIT_MAX_CUSTOM_COLOURS + 1 }, (_, index) => ({
      name: `c${index}`,
      value: '#123456',
    }));
    const broken = kit({ colors: { ...kit().colors, custom: many } });
    expect(tryParseBrandKit(broken).ok).toBe(false);
  });

  it('refuses an intro with neither an asset nor a template', () => {
    // A clip reference that points at nothing would insert an empty item, which is a
    // silently blank two seconds rather than an error the user can see.
    expect(
      tryParseBrandKit(kit({ intro: { durationSec: 2 } as never })).ok,
    ).toBe(false);
  });

  it('accepts an intro with a template instead of an asset', () => {
    const result = tryParseBrandKit(kit({ intro: { compositionTemplateId: 'tpl-1', durationSec: 2 } }));
    expect(result.ok).toBe(true);
  });
});

describe('importing a kit file', () => {
  it('tells a brand kit from another file type by its format field', () => {
    const result = importBrandKit({ format: 'cwstyle', formatVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not a brand kit');
  });

  it('refuses a version this build does not read, naming both versions', () => {
    /*
      Not "unknown error". A newer kit opened in an older build has a specific cause and a
      specific fix (update the app), and a message that says which version it found is the
      difference between a user updating and a user reporting a bug.
    */
    const result = importBrandKit({ ...kit(), formatVersion: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('version 2');
    expect(result.message).toContain('version 1');
  });

  it('keeps fields from a newer build through a round trip', () => {
    /*
      The rule `.cwstyle` established and this format inherits: opening a file written by a
      newer build and saving it again must not delete what this build does not understand.
      `brandKits` with a hand-made future field is the test, because that is exactly the
      case a real user hits — a colleague on a newer version.
    */
    const future = { ...kit(), somethingFromVersion2: { a: 1 } };
    const imported = importBrandKit(future);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.kit.extras).toEqual({ somethingFromVersion2: { a: 1 } });

    const written = exportBrandKit(imported.kit);
    expect(written.somethingFromVersion2).toEqual({ a: 1 });
    // And the parking space itself does not leak into the file.
    expect('extras' in written).toBe(false);
  });

  it('round-trips a known kit without inventing or losing fields', () => {
    const original = kit({
      captionStyleId: 'bold-creator',
      audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 14, opacity: 0.9, margin: 4, showFrom: 'always', showFor: 'whole' },
    });
    const imported = importBrandKit(original);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(exportBrandKit(imported.kit)).toMatchObject({
      format: 'cwbrand',
      id: 'kit-1',
      captionStyleId: 'bold-creator',
      audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
      logo: { assetId: 'logo-1', position: 'br', sizePct: 14, opacity: 0.9 },
    });
  });

  it('rejects something that is not an object at all', () => {
    for (const value of [null, 'a string', 42, undefined]) {
      expect(importBrandKit(value).ok, String(value)).toBe(false);
    }
  });
});
