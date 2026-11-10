/**
 * The kit form's model (SPEC 13 §8.2).
 *
 * A form cannot hold a `BrandKit` — a user is allowed to be halfway through choosing a logo —
 * so the draft is strings and switches and `draftToKit` is the boundary. These are the cases
 * worth pinning: a part switched on with nothing chosen is a *problem* rather than a silent
 * omission, every problem is reported at once rather than one per press of Save, and the
 * round trip through a saved kit is lossless.
 */
import { describe, expect, it } from 'vitest';
import { CwbrandFormat, CwbrandFormatVersion, type BrandKit } from '@clipwright/brand-kits';
import { draftFromKit, draftToKit, emptyDraft, mintKitId } from '../brand-kit-draft.js';

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

/** A draft that is valid as it stands, so each test can break exactly one thing. */
function validDraft() {
  return { ...emptyDraft('kit-1'), name: 'Studio' };
}

describe('draftToKit', () => {
  it('turns a named draft into a kit that validates', () => {
    const result = draftToKit(validDraft());
    expect(result.ok).toBe(true);
    expect(result.kit?.name).toBe('Studio');
    expect(result.kit?.format).toBe(CwbrandFormat);
  });

  it('refuses a kit with no name, and names the field', () => {
    const result = draftToKit({ ...validDraft(), name: '   ' });
    expect(result.ok).toBe(false);
    expect(result.problems.map((entry) => entry.field)).toContain('name');
  });

  it('refuses a colour that is not a hex value', () => {
    // The schema would reject it too, but a zod issue reads "invalid string" and the form needs
    // to say what to type.
    const draft = validDraft();
    draft.colors.primary = 'orange';
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.find((entry) => entry.field === 'colors.primary')?.message).toMatch(/hex value/i);
  });

  it('collects every problem at once instead of stopping at the first', () => {
    /*
      A form that fails one field per press of Save makes the user play a guessing game. This is
      the assertion that keeps the checks appending rather than returning.
    */
    const draft = validDraft();
    draft.name = '';
    draft.colors.accent = 'nope';
    draft.logo.enabled = true;
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.map((entry) => entry.field).sort()).toEqual(['colors.accent', 'logo', 'name']);
  });

  it('refuses a logo switched on with no image chosen', () => {
    // The user said they wanted a logo; a kit that quietly omitted it would apply everything
    // except the thing they turned on.
    const draft = validDraft();
    draft.logo.enabled = true;
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.find((entry) => entry.field === 'logo')?.message).toMatch(/switch it off/i);
  });

  it('leaves a part switched off out of the kit entirely', () => {
    // Not a logo with an empty asset — no logo key at all, so the kit has nothing to place and
    // the plan has nothing to report.
    const result = draftToKit(validDraft());
    expect(result.ok).toBe(true);
    expect(result.kit).not.toHaveProperty('logo');
    expect(result.kit).not.toHaveProperty('watermark');
    expect(result.kit).not.toHaveProperty('intro');
  });

  it('builds a logo with the corner and percentages the form holds', () => {
    const draft = validDraft();
    draft.logo = { ...draft.logo, enabled: true, assetId: 'logo-1', position: 'tr', sizePct: 9, margin: 3.5, opacity: 0.8 };
    const result = draftToKit(draft);
    expect(result.ok).toBe(true);
    expect(result.kit?.logo).toMatchObject({
      assetId: 'logo-1',
      position: 'tr',
      sizePct: 9,
      margin: 3.5,
      opacity: 0.8,
      showFor: 'whole',
    });
  });

  it('refuses a size outside the range the form offers', () => {
    const draft = validDraft();
    draft.logo = { ...draft.logo, enabled: true, assetId: 'logo-1', sizePct: 400 };
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.find((entry) => entry.field === 'logo')?.message).toMatch(/1%.*100%/);
  });

  it('refuses an intro switched on with no clip', () => {
    const draft = validDraft();
    draft.intro.enabled = true;
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.find((entry) => entry.field === 'intro')?.message).toMatch(/intro clip/i);
  });

  it('refuses an intro length the schema would reject, in the form’s own words', () => {
    /*
      Zero seconds is the interesting case: the schema's minimum is 0.1, so a zod issue would
      read "Number must be greater than or equal to 0.1" at path `intro.durationSec` — a message
      about a field the form calls "Seconds". The check exists to say which control to fix, and
      this is the assertion that it runs rather than leaving it to the schema.
    */
    const draft = validDraft();
    draft.intro = { enabled: true, assetId: 'intro-1', durationSec: 0 };
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.find((entry) => entry.field === 'intro')?.message).toMatch(/0\.1 and 600/);
  });

  it('builds an intro with its length in seconds', () => {
    const draft = validDraft();
    draft.intro = { enabled: true, assetId: 'intro-1', durationSec: 2.5 };
    const result = draftToKit(draft);
    expect(result.kit?.intro).toEqual({ assetId: 'intro-1', durationSec: 2.5 });
  });

  it('adds music only when a track is chosen', () => {
    const withMusic = validDraft();
    withMusic.audio = { musicAssetId: 'music-1', musicVolumeDb: -20, duckUnderSpeech: false };
    expect(draftToKit(withMusic).kit?.audio).toEqual({
      musicAssetId: 'music-1',
      musicVolumeDb: -20,
      duckUnderSpeech: false,
    });
    expect(draftToKit(validDraft()).kit).not.toHaveProperty('audio');
  });

  it('trims the name rather than storing the spaces', () => {
    // A name of "Studio " sorts differently from "Studio" and looks like a typo in a list.
    expect(draftToKit({ ...validDraft(), name: '  Studio  ' }).kit?.name).toBe('Studio');
  });

  it('refuses more custom colours than the schema allows', () => {
    const draft = validDraft();
    draft.colors.custom = Array.from({ length: 9 }, (_value, index) => ({
      name: `Colour ${index}`,
      value: '#FFFFFF',
    }));
    const result = draftToKit(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.find((entry) => entry.field === 'colors.custom')?.message).toMatch(/at most 8/);
  });
});

describe('draftFromKit', () => {
  it('round-trips a kit through the form unchanged', () => {
    /*
      Edit opens the form from a saved kit and Save writes it back. A field lost in that trip
      would be silently deleted from a user's kit every time they opened it.
    */
    const original = kit({
      captionStyleId: 'bold-creator',
      safeAreaPreset: 'tiktok',
      logo: {
        assetId: 'logo-1',
        position: 'br',
        xPct: 0,
        yPct: 0,
        sizePct: 12,
        opacity: 1,
        margin: 4,
        showFrom: 'always',
        showFor: 'whole',
      },
      audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
    });
    const result = draftToKit(draftFromKit(original));
    expect(result.ok).toBe(true);
    expect(result.kit?.name).toBe(original.name);
    expect(result.kit?.colors).toEqual(original.colors);
    expect(result.kit?.captionStyleId).toBe('bold-creator');
    expect(result.kit?.safeAreaPreset).toBe('tiktok');
    expect(result.kit?.logo?.assetId).toBe('logo-1');
    expect(result.kit?.audio?.duckUnderSpeech).toBe(true);
  });

  it('opens a kit with no logo as a draft whose logo is switched off', () => {
    // Switched off, not a logo with zeros in it: turning it on later must start from something
    // sensible rather than from an empty asset at size 0.
    const draft = draftFromKit(kit());
    expect(draft.logo.enabled).toBe(false);
    expect(draft.logo.sizePct).toBeGreaterThan(0);
  });

  it('maps a custom placement to a corner it can show', () => {
    /*
      The form has four corners. A kit whose logo used `custom` has a position the form cannot
      express, so it shows the nearest thing it can and keeps the size and margin — the corner
      is the one field a round trip through this form can change, and it is a deliberate limit
      rather than a data loss nobody noticed.
    */
    const draft = draftFromKit(
      kit({
        logo: {
          assetId: 'logo-1',
          position: 'custom',
          xPct: 80,
          yPct: 20,
          sizePct: 12,
          opacity: 1,
          margin: 4,
          showFrom: 'always',
          showFor: 'whole',
        },
      }),
    );
    expect(draft.logo.enabled).toBe(true);
    expect(draft.logo.sizePct).toBe(12);
    expect(['tl', 'tr', 'bl', 'br']).toContain(draft.logo.position);
  });
});

describe('mintKitId', () => {
  it('makes a readable id from the name', () => {
    expect(mintKitId('Studio Kit', new Set())).toBe('studio-kit');
    expect(mintKitId('  Client A / Q4  ', new Set())).toBe('client-a-q4');
  });

  it('never returns an id another kit already has', () => {
    // The id is the map key and the provenance tag, so a collision would make two kits share
    // their applied items.
    expect(mintKitId('studio', new Set(['studio']))).toBe('studio-2');
    expect(mintKitId('studio', new Set(['studio', 'studio-2']))).toBe('studio-3');
  });

  it('falls back to a usable id when the name has no letters', () => {
    expect(mintKitId('***', new Set())).toBe('kit');
  });
});
