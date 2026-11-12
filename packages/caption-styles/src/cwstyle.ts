/**
 * The `.cwstyle` format — versioned, zod-validated caption/text style data.
 * Units are relative (percent of canvas short side / of font size) so styles
 * look the same at any resolution. Unknown fields are KEPT on round-trip.
 */
import { z } from 'zod';

const ColorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\([^)]+\))$/, 'expected hex or rgba() colour');

export const CaptionStyleSchema = z.object({
  format: z.literal('cwstyle'),
  formatVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  author: z.string().default(''),
  license: z.string().default(''),
  createdAt: z.string().default(''),
  font: z.object({
    family: z.string().min(1),
    weight: z.number().int().min(100).max(900),
    italic: z.boolean().default(false),
    source: z.enum(['bundled', 'user', 'system']).default('bundled'),
    sizePctOfShortSide: z.number().positive().max(40),
  }),
  text: z.object({
    case: z.enum(['none', 'upper', 'lower', 'title']).default('none'),
    align: z.enum(['left', 'center', 'right']).default('center'),
    letterSpacingEm: z.number().default(0),
    wordSpacingEm: z.number().default(0),
    lineHeight: z.number().positive().default(1.15),
    maxLinesHint: z.number().int().min(1).max(4).default(2),
    maxCharsPerLineHint: z.number().int().min(4).max(60).default(20),
  }),
  fill: z.object({ color: ColorSchema.default('#FFFFFF'), opacity: z.number().min(0).max(1).default(1) }),
  outline: z.object({
    enabled: z.boolean().default(false),
    color: ColorSchema.default('#000000'),
    widthPctOfFont: z.number().min(0).max(30).default(0),
    join: z.enum(['round', 'miter', 'bevel']).default('round'),
  }),
  shadow: z.object({
    enabled: z.boolean().default(false),
    color: ColorSchema.default('#000000'),
    opacity: z.number().min(0).max(1).default(0.6),
    dx: z.number().default(0),           // px at 1080 short side, scaled by canvasShort/1080
    dyPctOfFont: z.number().default(6),
    blurPctOfFont: z.number().default(0),
  }),
  background: z.object({
    enabled: z.boolean().default(false),
    color: ColorSchema.default('#000000'),
    opacity: z.number().min(0).max(1).default(0.6),
    radiusPx: z.number().min(0).default(10),
    paddingX: z.number().min(0).default(12),
    paddingY: z.number().min(0).default(6),
    perLine: z.boolean().default(true),
  }),
  position: z.object({
    anchor: z.enum(['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right']).default('bottom-center'),
    xPct: z.number().min(0).max(100).default(50),
    yPct: z.number().min(0).max(100).default(78),
    maxWidthPct: z.number().min(20).max(100).default(86),
  }),
  highlight: z.object({
    mode: z.enum(['none', 'current-word', 'keywords', 'karaoke-fill', 'word-by-word', 'sequence']).default('none'),
    color: ColorSchema.default('#FFD400'),
    scale: z.number().min(1).max(2).default(1),
    keepLit: z.boolean().default(true),
  }),
  wordColors: z.array(ColorSchema).default([]),
  animation: z.object({
    in: z.object({ preset: z.string(), durationMs: z.number().nonnegative(), easing: z.string().default('easeOut'), params: z.record(z.unknown()).default({}) }),
    out: z.object({ preset: z.string(), durationMs: z.number().nonnegative(), easing: z.string().default('linear') }).optional(),
    perWord: z.object({ preset: z.string(), durationMs: z.number().nonnegative(), staggerMs: z.number().nonnegative().default(0) }).optional(),
  }),
  timing: z.object({
    leadMs: z.number().default(0),
    lagMs: z.number().default(0),
    minDisplayMs: z.number().default(600),
    holdAfterLastWordMs: z.number().default(150),
  }),
  rotationJitterDeg: z.number().min(0).max(15).default(0),
  seed: z.number().int().default(1),
}).passthrough();

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const parseCaptionStyle = (data: unknown): CaptionStyle => CaptionStyleSchema.parse(data);
export const safeParseCaptionStyle = (data: unknown) => CaptionStyleSchema.safeParse(data);

const base = {
  format: 'cwstyle' as const,
  formatVersion: 1 as const,
  author: 'Clipwright',
  license: 'Clipwright built-in (OFL fonts)',
  createdAt: '2026-01-01T00:00:00.000Z',
  fill: { color: '#FFFFFF', opacity: 1 },
  wordColors: [] as string[],
  rotationJitterDeg: 0,
  seed: 1,
};

const outline = (widthPctOfFont: number, color = '#000000') =>
  ({ enabled: true, color, widthPctOfFont, join: 'round' as const });
const noOutline = { enabled: false, color: '#000000', widthPctOfFont: 0, join: 'round' as const };
const shadow = (dyPctOfFont: number, opacity = 0.6, dx = 0, blurPctOfFont = 0, color = '#000000') =>
  ({ enabled: true, color, opacity, dx, dyPctOfFont, blurPctOfFont });
const noShadow = { enabled: false, color: '#000000', opacity: 0, dx: 0, dyPctOfFont: 0, blurPctOfFont: 0 };
const noBackground = { enabled: false, color: '#000000', opacity: 0, radiusPx: 10, paddingX: 12, paddingY: 6, perLine: true };

export const BUILTIN_PRESETS: readonly CaptionStyle[] = [
  { ...base, id: 'clean-minimal', name: 'Clean Minimal',
    font: { family: 'Manrope', weight: 600, italic: false, source: 'bundled', sizePctOfShortSide: 5.4 },
    text: { case: 'none', align: 'center', letterSpacingEm: 0, wordSpacingEm: 0, lineHeight: 1.2, maxLinesHint: 2, maxCharsPerLineHint: 24 },
    outline: noOutline, shadow: shadow(2, 0.5, 0, 3), background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 78, maxWidthPct: 86 },
    highlight: { mode: 'none', color: '#FFD400', scale: 1, keepLit: true },
    animation: { in: { preset: 'fade', durationMs: 120, easing: 'linear', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 700, holdAfterLastWordMs: 150 } },

  { ...base, id: 'bold-creator', name: 'Bold Creator',
    font: { family: 'Montserrat', weight: 800, italic: false, source: 'bundled', sizePctOfShortSide: 7.2 },
    text: { case: 'upper', align: 'center', letterSpacingEm: 0.01, wordSpacingEm: 0, lineHeight: 1.1, maxLinesHint: 2, maxCharsPerLineHint: 20 },
    outline: outline(9), shadow: shadow(8, 0.85, 0, 0), background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 62, maxWidthPct: 88 },
    highlight: { mode: 'none', color: '#FFD400', scale: 1, keepLit: true },
    animation: { in: { preset: 'pop', durationMs: 140, easing: 'easeOut', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 600, holdAfterLastWordMs: 150 } },

  { ...base, id: 'highlighted-keywords', name: 'Highlighted Keywords',
    font: { family: 'Poppins', weight: 700, italic: false, source: 'bundled', sizePctOfShortSide: 6.8 },
    text: { case: 'none', align: 'center', letterSpacingEm: 0, wordSpacingEm: 0, lineHeight: 1.15, maxLinesHint: 2, maxCharsPerLineHint: 20 },
    outline: outline(5.5), shadow: noShadow, background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 68, maxWidthPct: 86 },
    highlight: { mode: 'keywords', color: '#FFD400', scale: 1.3, keepLit: true },
    animation: { in: { preset: 'pop', durationMs: 140, easing: 'easeOut', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 600, holdAfterLastWordMs: 150 } },

  { ...base, id: 'karaoke', name: 'Karaoke',
    font: { family: 'Poppins', weight: 700, italic: false, source: 'bundled', sizePctOfShortSide: 6.6 },
    text: { case: 'none', align: 'center', letterSpacingEm: 0, wordSpacingEm: 0, lineHeight: 1.2, maxLinesHint: 2, maxCharsPerLineHint: 22 },
    fill: { color: '#FFFFFF', opacity: 0.6 },
    outline: noOutline, shadow: shadow(2, 0.5, 0, 3), background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 70, maxWidthPct: 86 },
    highlight: { mode: 'karaoke-fill', color: '#FFD400', scale: 1, keepLit: true },
    animation: { in: { preset: 'fade', durationMs: 100, easing: 'linear', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 600, holdAfterLastWordMs: 200 } },

  { ...base, id: 'word-by-word', name: 'Word by Word',
    font: { family: 'Anton', weight: 400, italic: false, source: 'bundled', sizePctOfShortSide: 11 },
    text: { case: 'upper', align: 'center', letterSpacingEm: 0.02, wordSpacingEm: 0, lineHeight: 1.05, maxLinesHint: 1, maxCharsPerLineHint: 14 },
    outline: outline(6.5), shadow: noShadow, background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 55, maxWidthPct: 90 },
    highlight: { mode: 'word-by-word', color: '#FFFFFF', scale: 1, keepLit: false },
    animation: { in: { preset: 'pop', durationMs: 120, easing: 'easeOut', params: {} },
                 perWord: { preset: 'pop', durationMs: 120, staggerMs: 0 } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 300, holdAfterLastWordMs: 80 } },

  { ...base, id: 'multi-line-subtitle', name: 'Multi-line Subtitle',
    font: { family: 'Inter', weight: 500, italic: false, source: 'bundled', sizePctOfShortSide: 5.2 },
    text: { case: 'none', align: 'left', letterSpacingEm: 0, wordSpacingEm: 0, lineHeight: 1.25, maxLinesHint: 2, maxCharsPerLineHint: 32 },
    outline: noOutline, shadow: noShadow,
    background: { enabled: true, color: '#000000', opacity: 0.62, radiusPx: 10, paddingX: 12, paddingY: 6, perLine: true },
    position: { anchor: 'bottom-center', xPct: 50, yPct: 86, maxWidthPct: 88 },
    highlight: { mode: 'none', color: '#FFD400', scale: 1, keepLit: true },
    animation: { in: { preset: 'fade', durationMs: 100, easing: 'linear', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 800, holdAfterLastWordMs: 150 } },

  { ...base, id: 'animated-slide', name: 'Animated Slide',
    font: { family: 'Poppins', weight: 700, italic: false, source: 'bundled', sizePctOfShortSide: 6.8 },
    text: { case: 'none', align: 'center', letterSpacingEm: 0, wordSpacingEm: 0, lineHeight: 1.15, maxLinesHint: 2, maxCharsPerLineHint: 22 },
    outline: noOutline, shadow: shadow(2, 0.4, 0, 2), background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 66, maxWidthPct: 86 },
    highlight: { mode: 'sequence', color: '#4DA3FF', scale: 1, keepLit: true },
    animation: { in: { preset: 'slide', durationMs: 160, easing: 'easeOut', params: { direction: 'up', distancePct: 20 } },
                 perWord: { preset: 'sequence', durationMs: 120, staggerMs: 60 } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 700, holdAfterLastWordMs: 150 } },

  { ...base, id: 'editorial', name: 'Editorial',
    font: { family: 'Playfair Display', weight: 600, italic: false, source: 'bundled', sizePctOfShortSide: 5.6 },
    text: { case: 'none', align: 'center', letterSpacingEm: 0.01, wordSpacingEm: 0, lineHeight: 1.3, maxLinesHint: 2, maxCharsPerLineHint: 30 },
    fill: { color: '#F5F0E6', opacity: 1 },
    outline: outline(1.2), shadow: noShadow, background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 80, maxWidthPct: 80 },
    highlight: { mode: 'keywords', color: '#F5F0E6', scale: 1, keepLit: true },
    animation: { in: { preset: 'fade', durationMs: 150, easing: 'linear', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 900, holdAfterLastWordMs: 200 } },

  { ...base, id: 'podcast', name: 'Podcast',
    font: { family: 'Inter', weight: 700, italic: false, source: 'bundled', sizePctOfShortSide: 5.4 },
    text: { case: 'none', align: 'center', letterSpacingEm: 0, wordSpacingEm: 0, lineHeight: 1.2, maxLinesHint: 2, maxCharsPerLineHint: 28 },
    outline: noOutline, shadow: noShadow,
    background: { enabled: true, color: '#141416', opacity: 0.9, radiusPx: 8, paddingX: 14, paddingY: 7, perLine: true },
    position: { anchor: 'bottom-center', xPct: 50, yPct: 74, maxWidthPct: 84 },
    highlight: { mode: 'none', color: '#FFD400', scale: 1, keepLit: true },
    animation: { in: { preset: 'fade', durationMs: 100, easing: 'linear', params: {} } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 900, holdAfterLastWordMs: 150 } },

  { ...base, id: 'social-pop', name: 'Social Pop',
    font: { family: 'Bangers', weight: 400, italic: false, source: 'bundled', sizePctOfShortSide: 8.4 },
    text: { case: 'upper', align: 'center', letterSpacingEm: 0.02, wordSpacingEm: 0, lineHeight: 1.05, maxLinesHint: 2, maxCharsPerLineHint: 18 },
    outline: outline(7), shadow: noShadow, background: noBackground,
    position: { anchor: 'bottom-center', xPct: 50, yPct: 60, maxWidthPct: 88 },
    highlight: { mode: 'sequence', color: '#FFD400', scale: 1, keepLit: true },
    wordColors: ['#FFFFFF', '#FFD400', '#3DD68C'],
    rotationJitterDeg: 2, seed: 7,
    animation: { in: { preset: 'bounce', durationMs: 220, easing: 'easeOut', params: { overshoot: 1.12 } } },
    timing: { leadMs: 0, lagMs: 0, minDisplayMs: 500, holdAfterLastWordMs: 120 } },
];

export const getBuiltinPreset = (id: string): CaptionStyle | undefined =>
  BUILTIN_PRESETS.find((p) => p.id === id);

/** Resolve a style: preset → project-local copy → item overrides (item wins). */
export const resolveStyle = (
  baseId: string,
  projectLocal?: CaptionStyle | null,
  overrides?: Partial<CaptionStyle> | null,
): CaptionStyle => {
  const basePreset = projectLocal ?? getBuiltinPreset(baseId);
  if (!basePreset) throw new Error(`Unknown caption preset: ${baseId}`);
  if (!overrides) return basePreset;
  return { ...basePreset, ...overrides, font: { ...basePreset.font, ...(overrides.font ?? {}) } };
};
