/**
 * SPEC 11 §5 — the ten built-in caption style presets.
 *
 * The presets are `.cwstyle` files under `assets/caption-presets/`, not
 * TypeScript objects, because they have to be *the same artefact* a user imports
 * and exports. A preset written as code would drift from the format the moment
 * someone edited it, and "edit a preset" (which produces a copy through the same
 * validator) would be exercising a different path than the shipped files.
 *
 * Every file is validated by `parseStyle` when this module loads. That runs in
 * the app, in the tests and in `check-repo`, so a malformed preset is a build
 * failure rather than a blank caption on someone's timeline.
 */
import cleanMinimal from '../../../assets/caption-presets/clean-minimal.json';
import boldCreator from '../../../assets/caption-presets/bold-creator.json';
import highlightedKeywords from '../../../assets/caption-presets/highlighted-keywords.json';
import karaoke from '../../../assets/caption-presets/karaoke.json';
import wordByWord from '../../../assets/caption-presets/word-by-word.json';
import multiLineSubtitle from '../../../assets/caption-presets/multi-line-subtitle.json';
import animatedSlide from '../../../assets/caption-presets/animated-slide.json';
import editorial from '../../../assets/caption-presets/editorial.json';
import podcast from '../../../assets/caption-presets/podcast.json';
import socialPop from '../../../assets/caption-presets/social-pop.json';
import { parseStyle, type CaptionStyle } from './schema.js';

/** Import order is display order in the Captions panel gallery (SPEC 11 §4). */
const BUILT_IN_SOURCES: readonly unknown[] = [
  cleanMinimal,
  boldCreator,
  highlightedKeywords,
  karaoke,
  wordByWord,
  multiLineSubtitle,
  animatedSlide,
  editorial,
  podcast,
  socialPop,
];

export const BUILT_IN_STYLES: readonly CaptionStyle[] = BUILT_IN_SOURCES.map((source) => parseStyle(source));

/** SPEC 11 §5 — Bold Creator is the preset the start page pre-selects. */
export const DEFAULT_STYLE_ID = 'bold-creator';

export function builtInStyle(id: string): CaptionStyle | undefined {
  return BUILT_IN_STYLES.find((style) => style.id === id);
}

export const DEFAULT_STYLE: CaptionStyle = builtInStyle(DEFAULT_STYLE_ID) ?? BUILT_IN_STYLES[1]!;

/**
 * SPEC 11 §6 — "style is resolved as preset (by id) → project-local copy → item
 * overrides". This is the second and third step.
 *
 * A project keeps a copy of every style it has used, so a preset changing in a
 * later release cannot alter a finished project. The lookup therefore prefers the
 * project copy and only falls back to the built-in.
 */
export type StyleOverrides = Partial<Omit<CaptionStyle, 'id' | 'format' | 'formatVersion'>>;

export function resolveStyle(
  styleId: string | undefined,
  projectCopies: Readonly<Record<string, CaptionStyle>>,
  overrides?: StyleOverrides
): CaptionStyle {
  const base =
    (styleId ? projectCopies[styleId] : undefined) ??
    (styleId ? builtInStyle(styleId) : undefined) ??
    DEFAULT_STYLE;

  if (!overrides) return base;

  // Shallow-merge per group rather than replacing whole objects: an override of
  // `{ font: { weight: 900 } }` should not blank the family.
  const merged: CaptionStyle = { ...base };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof CaptionStyle, unknown]>) {
    if (value === undefined) continue;
    const current = merged[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
    ) {
      (merged as Record<string, unknown>)[key] = { ...current, ...(value as object) };
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * SPEC 11 §5 — every preset must be legible on both bright and dark video.
 *
 * `docs/verification.md` records the contrast test; this is the data it uses, so
 * the test and the renderer agree about what "the preset's text colour" means
 * when the text sits on a background chip.
 */
export function styleTextColor(style: CaptionStyle): string {
  return style.fill.color;
}

/** The colour actually painted behind the text, if any. */
export function styleBackgroundColor(style: CaptionStyle): { color: string; opacity: number } | null {
  if (!style.background.enabled) return null;
  return { color: style.background.color, opacity: style.background.opacity };
}
