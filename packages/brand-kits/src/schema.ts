/**
 * SPEC 13 §8 — the `.cwbrand` brand kit format.
 *
 * A brand kit is a reusable bundle: colours, fonts, a caption look, a logo, an intro and
 * an outro, a lower third, and music settings. Applying one to a clip produces **ordinary
 * items and styles** — an image item on a graphics track, a clip inserted at the start, a
 * `captionStyleId` — never a special kind of object the rest of the app has to know about.
 * That is the decision this format is arranged around: a kit is a *recipe* for ordinary
 * commands, and a project it was applied to contains nothing but the commands' normal
 * output.
 *
 * Three rules carried over from `.cwstyle` (`docs/decisions.md` §8), all for the same
 * reasons:
 *
 * - **Data, never code.** Nothing in the app knows a kit by name; `kit.json` is the file a
 *   user can export, edit and re-import, and it goes through this validator either way.
 * - **Relative units.** Every position and size is a percentage, so a kit designed on 16:9
 *   places its logo sensibly on 9:16 instead of putting it off-screen. The one exception is
 *   durations, which are seconds because a title is "on for three seconds" whatever the
 *   frame size.
 * - **Unknown fields are preserved.** A kit saved by a newer build keeps its extra fields
 *   through a round trip here, so opening and saving a file in an older build does not
 *   quietly delete half of it.
 */
import { z } from 'zod';

export const CwbrandFormat = 'cwbrand' as const;
export const CwbrandFormatVersion = 1 as const;

/** Bounded so a corrupt file cannot ask for a logo that covers the frame. */
const percent = z.number().min(0).max(100);
const opacity = z.number().min(0).max(1);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'expected #RRGGBB or #RRGGBBAA');

/**
 * A font reference, the same shape `11 §10` uses for caption styles.
 *
 * `source` is what makes a missing font *explainable*: a `bundled` family ships with the
 * app and cannot be missing, a `system` one is looked up on this machine and may be absent
 * on another, so the import flow knows to offer a substitute for exactly that case.
 */
const fontRefSchema = z.object({
  family: z.string().min(1).max(120),
  weight: z.number().int().min(100).max(900).default(400),
  italic: z.boolean().default(false),
  source: z.enum(['bundled', 'user', 'system']).default('system'),
});

/**
 * Where a graphic sits, in canvas percentages.
 *
 * `margin` is a percentage of the short side rather than pixels, so a corner logo keeps a
 * consistent distance from the edge at any output size. It is ignored for `custom`, where
 * `xPct`/`yPct` say exactly where the thing goes.
 */
const placementSchema = z.object({
  position: z.enum(['tl', 'tr', 'bl', 'br', 'custom']),
  xPct: percent.default(4),
  yPct: percent.default(4),
  sizePct: z.number().min(1).max(100).default(12),
  opacity: opacity.default(1),
  margin: percent.default(4),
  /**
   * When it appears. `always` and `start` are separate even though both begin at zero:
   * `always` is for a watermark that should survive a trim of the opening, `start` for
   * something that belongs to the first seconds.
   */
  showFrom: z.union([z.literal('start'), z.literal('always'), z.object({ atSec: z.number().min(0) })]).default('always'),
  showFor: z.union([z.literal('whole'), z.number().min(0)]).default('whole'),
});

/**
 * An asset the kit needs, by media-library id.
 *
 * The kit stores the *id* rather than a path: an asset can be moved or relinked
 * (`docs/decisions.md` on the volume id), and a kit that pinned a path would break the
 * first time the file moved. A missing id is a reportable condition, not a parse error —
 * the kit is still valid, and `diagnoseKit` says what could not be found.
 */
const assetRefSchema = z.object({
  assetId: z.string().min(1),
});

const logoPlacementSchema = placementSchema;

const clipRefSchema = z.object({
  assetId: z.string().min(1).optional(),
  compositionTemplateId: z.string().min(1).optional(),
  durationSec: z.number().min(0.1).max(600),
}).refine(
  (value) => value.assetId !== undefined || value.compositionTemplateId !== undefined,
  { message: 'a clip needs an assetId or a compositionTemplateId' },
);

const lowerThirdSchema = z.object({
  templateId: z.string().min(1),
  fields: z
    .object({
      name: z.string().max(120).optional(),
      role: z.string().max(120).optional(),
    })
    .default({}),
  showAtSec: z.number().min(0).default(0),
  forSec: z.number().min(0.1).max(600).default(4),
});

const textDefaultsSchema = z.object({
  titleStyle: z.string().min(1).optional(),
  subtitleStyle: z.string().min(1).optional(),
});

const audioSchema = z.object({
  musicAssetId: z.string().min(1).optional(),
  musicVolumeDb: z.number().min(-60).max(12).default(-12),
  duckUnderSpeech: z.boolean().default(true),
  normaliseTargetLufs: z.number().min(-40).max(0).optional(),
});

/**
 * The eight custom colours the spec allows beyond the five named ones.
 *
 * A list rather than a record so the order survives a round trip — a palette shown in the
 * UI should look the same after export and re-import, and object key order is not something
 * JSON preserves reliably.
 */
const customColourSchema = z.object({
  name: z.string().min(1).max(60),
  value: hexColor,
});

export const BRAND_KIT_MAX_CUSTOM_COLOURS = 8;

/**
 * The palette a kit starts with — black and white, which is nobody's brand.
 *
 * A default rather than a design token: these are *data* (a kit's colours are the user's, stored
 * in a file), so they belong here rather than in the design system, and the renderer's
 * token lint rightly refuses hex values in a UI file. Every one is a value the schema requires,
 * so a new kit validates before the user has changed anything — and a capture with no style to
 * read gets the same set, so the two cannot disagree about what "no colours" means.
 */
export const DEFAULT_KIT_COLOURS = {
  primary: '#FFFFFF',
  secondary: '#000000',
  accent: '#FFFFFF',
  background: '#000000',
  text: '#FFFFFF',
} as const;

export const brandKitSchema = z.object({
  format: z.literal(CwbrandFormat),
  formatVersion: z.literal(CwbrandFormatVersion),
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  colors: z.object({
    primary: hexColor,
    secondary: hexColor,
    accent: hexColor,
    background: hexColor,
    text: hexColor,
    custom: z.array(customColourSchema).max(BRAND_KIT_MAX_CUSTOM_COLOURS).default([]),
  }),
  fonts: z
    .object({
      heading: fontRefSchema,
      body: fontRefSchema,
      caption: fontRefSchema,
    })
    .partial()
    .default({}),
  /** The caption look the kit applies, by `.cwstyle` id. */
  captionStyleId: z.string().min(1).optional(),
  /** Per-field overrides applied on top of `captionStyleId`. */
  captionOverrides: z.record(z.string(), z.unknown()).optional(),
  logo: logoPlacementSchema.extend({ assetId: z.string().min(1) }).optional(),
  /** Same shape as the logo, usually semi-transparent. */
  watermark: logoPlacementSchema.extend({ assetId: z.string().min(1) }).optional(),
  intro: clipRefSchema.optional(),
  outro: clipRefSchema.optional(),
  lowerThird: lowerThirdSchema.optional(),
  textDefaults: textDefaultsSchema.optional(),
  audio: audioSchema.optional(),
  safeAreaPreset: z.enum(['tiktok', 'reels', 'shorts', 'none']).default('none'),
  /**
   * Fields this build does not know, parked so a newer build's kit survives a round trip
   * through an older one. Written by `importBrandKit`, never by the editor.
   */
  extras: z.record(z.string(), z.unknown()).optional(),
});

export type BrandKit = z.infer<typeof brandKitSchema>;
export type BrandKitPlacement = z.infer<typeof placementSchema>;
/** A font reference — family, weight, italic and where the family comes from (SPEC 11 §10). */
export type BrandKitFont = z.infer<typeof fontRefSchema>;

export type ParseKitResult =
  | { ok: true; kit: BrandKit }
  | { ok: false; message: string; issues: Array<{ path: string; message: string }> };

function summariseIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'This file is not a brand kit.';
  const where = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${where}${first.message}`;
}

/**
 * Parse without throwing: the import flow has to tell the user *why* a file was rejected,
 * and a stack trace is not that.
 */
export function tryParseBrandKit(input: unknown): ParseKitResult {
  const result = brandKitSchema.safeParse(input);
  if (result.success) return { ok: true, kit: result.data };
  return {
    ok: false,
    message: summariseIssues(result.error),
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'format',
  'formatVersion',
  'id',
  'name',
  'colors',
  'fonts',
  'captionStyleId',
  'captionOverrides',
  'logo',
  'watermark',
  'intro',
  'outro',
  'lowerThird',
  'textDefaults',
  'audio',
  'safeAreaPreset',
  'extras',
]);

/**
 * The fields this build does not recognise, so they can be carried through a round trip.
 *
 * Exported rather than inlined because the writer needs the same list: a field is only
 * "unknown" by comparison with what `brandKitSchema` declares, and two copies of that list
 * would drift.
 */
export function collectUnknownKitFields(input: Record<string, unknown>): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) unknown[key] = value;
  }
  return unknown;
}

/**
 * Import a `.cwbrand`'s `kit.json`, preserving fields from a newer build.
 *
 * There are no migrations yet — version 1 is the first format — but the import path goes
 * through a named function anyway so the first migration has an obvious home, and so the
 * round-trip behaviour is decided here rather than invented at each call site.
 */
export function importBrandKit(raw: unknown): ParseKitResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'This file is not a brand kit.', issues: [{ path: '', message: 'expected an object' }] };
  }
  const record = raw as Record<string, unknown>;
  if (record.format !== CwbrandFormat) {
    return {
      ok: false,
      message: 'This file is not a brand kit.',
      issues: [{ path: 'format', message: `expected "${CwbrandFormat}"` }],
    };
  }
  if (record.formatVersion !== CwbrandFormatVersion) {
    return {
      ok: false,
      message: `This brand kit is version ${String(record.formatVersion)}; this build reads version ${CwbrandFormatVersion}.`,
      issues: [{ path: 'formatVersion', message: 'unsupported version' }],
    };
  }

  const unknown = collectUnknownKitFields(record);
  const candidate =
    Object.keys(unknown).length > 0
      ? { ...record, extras: { ...unknown, ...(record.extras as object | undefined) } }
      : record;
  return tryParseBrandKit(candidate);
}

/**
 * Write a kit back out, with any parked unknown fields restored to the top level.
 *
 * The inverse of `importBrandKit`: a kit round-tripped through this build is byte-identical
 * in the fields it does not understand, so an older build cannot silently strip a newer
 * one's data. `extras` itself is dropped, since its contents are now at the top again.
 */
export function exportBrandKit(kit: BrandKit): Record<string, unknown> {
  const { extras, ...rest } = kit;
  return { ...rest, ...(extras ?? {}) };
}
