import { describe, expect, it } from 'vitest';
import {
  BUNDLED_FONT_CHARACTERS,
  nearestWeight,
  resolveKitFonts,
  substituteFont,
  type BrandKitFont,
  type FontDescriptor,
} from '../index.js';

/**
 * Missing fonts (SPEC 13 §8.3 → SPEC 11 §10.2): *substitute and flag*.
 *
 * The two ways to get this wrong are opposite and both tempting: refuse a kit because one family
 * is absent (which makes a shared kit unusable on most machines), or substitute in silence
 * (which puts a caption in the wrong typeface with nothing to explain it). Every test here is
 * about the middle: a usable result *and* a sentence naming both families.
 *
 * The catalogues are deliberately small and unusual — never the full bundled set — so a
 * substitute chosen for the wrong reason cannot be right by luck.
 */
const INTER: FontDescriptor = { family: 'Inter', character: 'sans', weights: [400, 500, 600, 700] };
const LORA: FontDescriptor = { family: 'Lora', character: 'serif', weights: [400, 500, 600] };
const ANTON: FontDescriptor = { family: 'Anton', character: 'display', weights: [400] };
const BEBAS: FontDescriptor = { family: 'Bebas Neue', character: 'condensed', weights: [400] };

const CATALOGUE = { families: [INTER, LORA, ANTON, BEBAS] };

function font(overrides: Partial<BrandKitFont> = {}): BrandKitFont {
  return { family: 'Inter', weight: 700, italic: false, source: 'bundled', ...overrides };
}

describe('substituteFont', () => {
  it('leaves a present family alone', () => {
    const result = substituteFont(font(), CATALOGUE);
    expect(result.substituted).toBe(false);
    expect(result.resolved.family).toBe('Inter');
    expect(result.resolved.weight).toBe(700);
    // Nothing to say, so nothing is said — a warning on every caption would be noise.
    expect(result.warning).toBe('');
  });

  it('rounds the weight to one the present family actually has, silently', () => {
    /*
      SPEC 11 §10.1: "if a requested weight isn't present the nearest is used". No warning — the
      family is there and the type is the user's — but the number has to be one the font can
      render. Inter here has 400–700; a kit asking for 900 must land on 700, not on 900, because
      a canvas `font` string asking for a weight that does not exist is silently substituted by
      the browser and the result is not what the kit said.
    */
    const result = substituteFont(font({ weight: 900 }), CATALOGUE);
    expect(result.substituted).toBe(false);
    expect(result.resolved.weight).toBe(700);
    expect(result.warning).toBe('');
  });

  it('flags a missing family and says which one and what it used', () => {
    const result = substituteFont(font({ family: 'Poppins' }), CATALOGUE);
    expect(result.substituted).toBe(true);
    expect(result.resolved.family).toBe('Inter');
    // Both names in the sentence: a user told only "font missing" has no way to judge whether
    // the result is acceptable, and no way to ask for something else.
    expect(result.warning).toContain('Poppins');
    expect(result.warning).toContain('Inter');
    // The spec's own words for the inspector banner (SPEC 11 §10.2).
    expect(result.warning).toMatch(/^Font missing: /);
  });

  it('keeps a serif a serif and a display face a display face', () => {
    /*
      The whole reason the catalogue carries a character: a kit asking for Playfair Display and
      landing on Inter is a serif poster turned into a modern sans, which is a different design
      rather than a substitute. Each case has exactly one family of its character available, so
      a substitution that ignores the character lands on Inter and fails.
    */
    expect(substituteFont(font({ family: 'Playfair Display' }), CATALOGUE).resolved.family).toBe('Lora');
    expect(substituteFont(font({ family: 'Archivo Black' }), CATALOGUE).resolved.family).toBe('Anton');
    expect(substituteFont(font({ family: 'Roboto Condensed' }), CATALOGUE).resolved.family).toBe('Bebas Neue');
  });

  it('treats an unknown family as a sans and admits it', () => {
    // Nothing describes "Comic Neue", so the substitute is chosen for the commonest caption
    // character. The warning is unchanged — the user still needs the name they asked for.
    const result = substituteFont(font({ family: 'Comic Neue' }), CATALOGUE);
    expect(result.resolved.family).toBe('Inter');
    expect(result.warning).toContain('Comic Neue');
  });

  it('marks the substitute as bundled, because a substitute is one this build has', () => {
    // A FontRef carries where its family came from. Copying `source: 'user'` onto a family that
    // ships with the app would make the inspector warn about a package export that does not
    // depend on the user's font folder at all.
    const result = substituteFont(font({ family: 'Poppins', source: 'user' }), CATALOGUE);
    expect(result.substituted).toBe(true);
    expect(result.resolved.source).toBe('bundled');
  });

  it('keeps the italic flag, which is not a property of the family', () => {
    const result = substituteFont(font({ family: 'Poppins', italic: true }), CATALOGUE);
    expect(result.resolved.italic).toBe(true);
  });

  it('falls back to the first family when nothing has the right character', () => {
    // A catalogue with no serif at all. Picking an arbitrary family is acceptable; claiming it
    // has "a similar style" is not, so the sentence says there is none.
    const only = { families: [INTER] };
    const result = substituteFont(font({ family: 'Playfair Display' }), only);
    expect(result.resolved.family).toBe('Inter');
    expect(result.warning).toContain('no font with a similar style');
  });

  it('reports a machine with no fonts rather than returning a family it does not have', () => {
    // The one case where the result cannot be honoured: the caller is told the system default
    // will be used, and the returned FontRef is the request rather than an invented family.
    const result = substituteFont(font({ family: 'Poppins' }), { families: [] });
    expect(result.substituted).toBe(false);
    expect(result.resolved.family).toBe('Poppins');
    expect(result.warning).toContain('system default');
  });
});

describe('nearestWeight', () => {
  it('picks the closest available weight', () => {
    expect(nearestWeight(700, [400, 500, 600])).toBe(600);
    expect(nearestWeight(300, [400, 500, 600])).toBe(400);
  });

  it('breaks a tie towards the heavier weight', () => {
    // A caption set at 700 is meant to look bold; rounding it down to 600 makes it look like a
    // mistake, and the two are equally close.
    expect(nearestWeight(650, [600, 700])).toBe(700);
  });

  it('returns the request when the family has no weights listed', () => {
    // Better a plausible number than `undefined` reaching a canvas font string.
    expect(nearestWeight(800, [])).toBe(800);
  });
});

describe('resolveKitFonts', () => {
  it('resolves each slot and deduplicates the warnings', () => {
    /*
      A kit that names one missing family for all three slots should produce **one** banner.
      Three identical sentences stacked in the inspector is the kind of warning users learn to
      scroll past, which costs the warning its purpose.
    */
    const result = resolveKitFonts(
      { heading: font({ family: 'Poppins' }), body: font({ family: 'Poppins' }), caption: font({ family: 'Inter' }) },
      CATALOGUE,
    );
    expect(result.fonts.heading?.family).toBe('Inter');
    expect(result.fonts.caption?.family).toBe('Inter');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Poppins');
  });

  it('leaves an absent slot absent', () => {
    // A kit need not name every font, and inventing one for a slot the user did not fill would
    // apply a typeface nobody chose.
    const result = resolveKitFonts({ caption: font() }, CATALOGUE);
    expect(result.fonts).not.toHaveProperty('heading');
    expect(result.fonts).not.toHaveProperty('body');
    expect(result.warnings).toEqual([]);
  });

  it('reports each distinct missing family once', () => {
    const result = resolveKitFonts(
      { heading: font({ family: 'Poppins' }), caption: font({ family: 'Playfair Display' }) },
      CATALOGUE,
    );
    expect(result.warnings).toHaveLength(2);
  });
});

describe('BUNDLED_FONT_CHARACTERS', () => {
  it('describes every family the fallback table can choose', () => {
    /*
      A family listed as a substitute but with no character is unreachable: the preference lists
      are keyed by character, so a family nobody describes can never be chosen. Pinning the pair
      keeps the table from growing a family that silently does nothing.
    */
    const substituteFamilies = new Set([
      'Inter', 'Manrope', 'Roboto', 'DM Sans', 'Nunito',
      'Lora', 'Playfair Display',
      'Bebas Neue', 'Roboto Condensed', 'Oswald',
      'Anton', 'Archivo Black', 'Bangers', 'Permanent Marker',
      'Caveat', 'JetBrains Mono',
    ]);
    for (const family of substituteFamilies) {
      expect(BUNDLED_FONT_CHARACTERS[family], family).toBeTruthy();
    }
  });

  it('calls the condensed faces condensed, not sans', () => {
    // The distinction the whole fallback rests on: Bebas Neue is a scoreboard face, and a kit
    // that names it should not come back as Inter.
    expect(BUNDLED_FONT_CHARACTERS['Bebas Neue']).toBe('condensed');
    expect(BUNDLED_FONT_CHARACTERS['Roboto Condensed']).toBe('condensed');
    expect(BUNDLED_FONT_CHARACTERS['Playfair Display']).toBe('serif');
    expect(BUNDLED_FONT_CHARACTERS['JetBrains Mono']).toBe('mono');
  });
});
