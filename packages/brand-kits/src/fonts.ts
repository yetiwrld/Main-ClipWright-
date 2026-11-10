/**
 * Missing fonts (SPEC 13 §8.3 → SPEC 11 §10.2): *substitute and flag*.
 *
 * A kit names fonts. A kit is meant to travel — that is the whole point of a `.cwbrand` file —
 * and the machine it lands on may not have them. The rule the spec states is short and easy to
 * get wrong in one direction: **substitute and flag**. Not refuse, and not substitute silently.
 *
 * Refusing would make a shared kit unusable on any machine missing one family, which is most of
 * them. Substituting silently would put a caption in the wrong typeface with nothing to explain
 * it, and the user would reasonably conclude the app had ignored the kit.
 *
 * So this module answers two questions and nothing else:
 *
 * - **Is this family available here?** From a list of families the caller can actually load.
 * - **What is a similar one?** A measured answer, not a guess: the bundled families carry
 *   attributes (does it look like a sans, a serif, a condensed face, a script), and the
 *   substitute is chosen by those attributes rather than by name similarity. A kit asking for
 *   Playfair Display and falling back to Inter would be a serif poster turned into a modern
 *   sans; falling back to Lora keeps it a serif.
 *
 * The module is pure: a family name, a list of what exists, a FontRef out. It does not load
 * anything, and it does not depend on the font manifest file — the caller passes the families it
 * has, so the same code works for the bundled set, a user's imported fonts, and the test.
 */
import type { BrandKitFont } from './schema.js';

/**
 * What a family looks like, for choosing a substitute.
 *
 * Coarse on purpose. A finer taxonomy (grotesque vs humanist, didone vs transitional) would
 * claim a precision nobody measured, and the substitute only has to keep the *character* of the
 * type — a condensed scoreboard face should not become a wide serif.
 */
export type FontCharacter =
  | 'sans'
  | 'serif'
  | 'condensed'
  | 'display'
  | 'script'
  | 'mono';

export interface FontDescriptor {
  family: string;
  character: FontCharacter;
  /** Weights the family actually has, so a request for 800 can fall back to 700 knowingly. */
  weights: readonly number[];
}

/**
 * The bundled families, with the character each one has (SPEC 11 §10.1).
 *
 * The list is the *shape* of the fallback table rather than the manifest: the manifest says which
 * files ship, and this says what each family is like. Keeping them apart means a font added to
 * the manifest without a character does not silently become "sans" — the caller's descriptor
 * list decides, and a family with no descriptor is treated as an unknown character rather than a
 * default one.
 */
export const BUNDLED_FONT_CHARACTERS: Readonly<Record<string, FontCharacter>> = {
  Manrope: 'sans',
  Inter: 'sans',
  Montserrat: 'sans',
  Poppins: 'sans',
  Roboto: 'sans',
  'Roboto Condensed': 'condensed',
  Oswald: 'condensed',
  'Source Sans 3': 'sans',
  Nunito: 'sans',
  Lexend: 'sans',
  'DM Sans': 'sans',
  'Space Grotesk': 'sans',
  Lora: 'serif',
  'Playfair Display': 'serif',
  Anton: 'display',
  'Bebas Neue': 'condensed',
  'Archivo Black': 'display',
  Bangers: 'display',
  Caveat: 'script',
  'Permanent Marker': 'display',
  'JetBrains Mono': 'mono',
};

/** The order substitutes are tried within a character, most neutral first. */
const PREFERENCE: Readonly<Record<FontCharacter, readonly string[]>> = {
  sans: ['Inter', 'Manrope', 'Roboto', 'DM Sans', 'Nunito'],
  serif: ['Lora', 'Playfair Display'],
  condensed: ['Bebas Neue', 'Roboto Condensed', 'Oswald'],
  display: ['Anton', 'Archivo Black', 'Bangers', 'Permanent Marker'],
  script: ['Caveat'],
  mono: ['JetBrains Mono'],
};

/** What a family is like, from a descriptor list; `undefined` when nothing describes it. */
export function describeFamily(
  family: string,
  descriptors: readonly FontDescriptor[],
): FontDescriptor | undefined {
  return descriptors.find((entry) => entry.family === family);
}

/** The weight a family actually has, nearest to the one asked for. */
export function nearestWeight(requested: number, available: readonly number[]): number {
  if (available.length === 0) return requested;
  /*
    Nearest by distance, and ties go to the *heavier* one: a caption set at 700 is meant to look
    bold, and rounding 700 down to 600 makes it look like a mistake. A requested weight outside
    the family's range lands on the end, not on a clamped duplicate.
  */
  let best = available[0]!;
  for (const weight of available) {
    const distance = Math.abs(weight - requested);
    const bestDistance = Math.abs(best - requested);
    if (distance < bestDistance || (distance === bestDistance && weight > best)) best = weight;
  }
  return best;
}

/** The families a substitute may come from: those the caller says exist, described. */
export interface FontCatalogue {
  families: readonly FontDescriptor[];
}

/** A substitution: what was asked for, what will be used, and why. */
export interface FontSubstitution {
  requested: BrandKitFont;
  /**
   * What to use instead. Equal to `requested` when nothing was missing — the caller can compare
   * by family rather than test for a separate success flag.
   */
  resolved: BrandKitFont;
  /** True when the family is not in the catalogue and `resolved.family` differs. */
  substituted: boolean;
  /** The sentence to show. Empty when nothing was substituted. */
  warning: string;
}

/**
 * Resolve a font against what this machine has.
 *
 * The two substitutions, in the order they can happen:
 *
 * 1. **The weight.** A family can be present and thin — Inter without 900 — and the nearest
 *    available is used without a warning, because SPEC 11 §10.1 says exactly that ("if a
 *    requested weight isn't present the nearest is used and the UI shows only the weights that
 *    exist"). It is a normal condition, not a fault.
 * 2. **The family.** Absent means a warning *and* a substitute, because §10.2's rule is
 *    "substitute and flag" — the notice names both so the user can choose a different
 *    replacement rather than being told only that something is wrong.
 */
export function substituteFont(
  requested: BrandKitFont,
  catalogue: FontCatalogue,
): FontSubstitution {
  const exact = describeFamily(requested.family, catalogue.families);
  if (exact) {
    const weight = nearestWeight(requested.weight, exact.weights);
    return {
      requested,
      resolved: { ...requested, weight },
      substituted: false,
      warning: '',
    };
  }

  /*
    The character is looked up from the bundled table first. An unknown family is treated as a
    sans — the commonest choice for captions — and *says so*, because the alternative is a
    substitute chosen by nothing at all.
  */
  const wanted = BUNDLED_FONT_CHARACTERS[requested.family] ?? 'sans';
  const known = new Set(catalogue.families.map((entry) => entry.family));
  const chosen = PREFERENCE[wanted].find((family) => known.has(family));
  if (!chosen) {
    /*
      Nothing in the catalogue has that character. Rather than picking an arbitrary family, the
      first available one is used and the warning says the choice was a fallback's fallback —
      a pool with no serif in it should not be reported as though it had one.
    */
    const first = catalogue.families[0];
    if (!first) {
      return {
        requested,
        resolved: requested,
        substituted: false,
        warning: `Font missing: ${requested.family}. No fonts are available, so the system default will be used.`,
      };
    }
    return {
      requested,
      resolved: { ...requested, family: first.family, weight: nearestWeight(requested.weight, first.weights) },
      substituted: true,
      warning: `Font missing: ${requested.family}. Using ${first.family} instead — no font with a similar style is available.`,
    };
  }

  const descriptor = catalogue.families.find((entry) => entry.family === chosen)!;
  return {
    requested,
    resolved: {
      ...requested,
      family: chosen,
      weight: nearestWeight(requested.weight, descriptor.weights),
      // The family changed, so the source must: a substitute is by definition one this build has.
      source: 'bundled',
    },
    substituted: true,
    warning: `Font missing: ${requested.family}. Using ${chosen} instead, which has a similar style.`,
  };
}

/** Resolve every font a kit names, collecting the warnings. */
export function resolveKitFonts(
  fonts: Partial<Record<'heading' | 'body' | 'caption', BrandKitFont>>,
  catalogue: FontCatalogue,
): { fonts: Partial<Record<'heading' | 'body' | 'caption', BrandKitFont>>; warnings: string[] } {
  const resolved: Partial<Record<'heading' | 'body' | 'caption', BrandKitFont>> = {};
  const warnings: string[] = [];
  for (const slot of ['heading', 'body', 'caption'] as const) {
    const font = fonts[slot];
    if (!font) continue;
    const result = substituteFont(font, catalogue);
    resolved[slot] = result.resolved;
    if (result.warning && !warnings.includes(result.warning)) warnings.push(result.warning);
  }
  return { fonts: resolved, warnings };
}
