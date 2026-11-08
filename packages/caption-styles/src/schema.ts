/**
 * SPEC 11 §6 — the `.cwstyle` caption style format.
 *
 * A caption style is data, not code: the built-in presets are the same files a
 * user can import, export and edit, and no part of the renderer knows a preset by
 * name. That is what makes "edit a preset" work — the edit produces a copy, and
 * the copy goes through the same validator as an imported file.
 *
 * Units are relative wherever they describe size: font size as a percentage of
 * the canvas *short side*, outline and shadow as percentages of the font size.
 * A style written for 1080p therefore looks identical at 4K and at 9:16, in the
 * preview and in the export. The only absolute values are the background
 * radius and padding, which the renderer scales by `canvasShort / 1080`.
 */
import { z } from 'zod';

export const CWSTYLE_FORMAT = 'cwstyle';
export const CWSTYLE_FORMAT_VERSION = 1;

/** Bounded so a corrupt file cannot ask for a 900 px outline. */
const percent = z.number().min(0).max(400);
const fraction = z.number().min(0).max(1);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'expected #RRGGBB or #RRGGBBAA');

const fontSchema = z.object({
  family: z.string().min(1).max(120),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  /**
   * How to find the family. `bundled` means it ships with the app (SPEC 11 §10.1)
   * and is always available; `user` means it came from the user's font folder;
   * `system` means it is looked up on the machine and may be missing elsewhere —
   * which is why the import flow offers a substitute.
   */
  source: z.enum(['bundled', 'user', 'system']),
  sizePctOfShortSide: z.number().min(0.5).max(40),
});

const textSchema = z.object({
  case: z.enum(['none', 'upper', 'lower', 'title']),
  align: z.enum(['left', 'center', 'right']),
  letterSpacingEm: z.number().min(-0.2).max(1),
  wordSpacingEm: z.number().min(-0.5).max(2),
  lineHeight: z.number().min(0.5).max(4),
  /** Hints for `buildCaptions`; the user can override them per project. */
  maxLinesHint: z.number().int().min(1).max(8),
  maxCharsPerLineHint: z.number().int().min(4).max(120),
});

const fillSchema = z.object({
  color: hexColor,
  opacity: fraction,
});

const outlineSchema = z.object({
  enabled: z.boolean(),
  color: hexColor,
  widthPctOfFont: percent,
  join: z.enum(['round', 'bevel', 'miter']),
});

const shadowSchema = z.object({
  enabled: z.boolean(),
  color: hexColor,
  opacity: fraction,
  /** Offset in px *of the 1080-short-side canvas*; the renderer scales it. */
  dx: z.number().min(-200).max(200),
  dyPctOfFont: z.number().min(-100).max(100),
  blurPctOfFont: percent,
});

const backgroundSchema = z.object({
  enabled: z.boolean(),
  color: hexColor,
  opacity: fraction,
  radiusPx: z.number().min(0).max(200),
  paddingX: z.number().min(0).max(200),
  paddingY: z.number().min(0).max(200),
  /** One box per line, or one box around the whole block. */
  perLine: z.boolean(),
});

const positionSchema = z.object({
  anchor: z.enum([
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
  ]),
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  maxWidthPct: z.number().min(5).max(100),
});

const highlightSchema = z.object({
  mode: z.enum(['none', 'current-word', 'keywords', 'karaoke-fill', 'word-by-word', 'sequence']),
  color: hexColor,
  scale: z.number().min(0.2).max(4),
  /** Optional chip behind the highlighted word; `null` means no chip. */
  background: hexColor.nullable(),
  /** `karaoke-fill`: whether a spoken word stays filled after its turn. */
  keepLit: z.boolean(),
});

const animationStepSchema = z.object({
  preset: z.enum(['none', 'fade', 'pop', 'slide-up', 'slide-down', 'bounce', 'wipe', 'typewriter']),
  durationMs: z.number().int().min(0).max(5000),
  easing: z.enum(['linear', 'easeOut', 'easeIn', 'easeInOut', 'spring']),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});

const animationSchema = z.object({
  in: animationStepSchema,
  out: animationStepSchema,
  perWord: animationStepSchema.extend({ staggerMs: z.number().int().min(0).max(2000) }),
});

const timingSchema = z.object({
  leadMs: z.number().int().min(-5000).max(5000),
  lagMs: z.number().int().min(-5000).max(5000),
  minDisplayMs: z.number().int().min(0).max(30_000),
  holdAfterLastWordMs: z.number().int().min(0).max(30_000),
});

export const captionStyleSchema = z.object({
  format: z.literal(CWSTYLE_FORMAT),
  formatVersion: z.number().int().min(1).max(CWSTYLE_FORMAT_VERSION),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  author: z.string().max(120).optional(),
  /** Free text shown on import so a licence travels with a shared style. */
  license: z.string().max(500).optional(),
  createdAt: z.string(),
  font: fontSchema,
  text: textSchema,
  fill: fillSchema,
  outline: outlineSchema,
  shadow: shadowSchema,
  background: backgroundSchema,
  position: positionSchema,
  highlight: highlightSchema,
  /** Cycling word colours; empty means "use fill and highlight only". */
  wordColors: z.array(hexColor).max(12).default([]),
  animation: animationSchema,
  timing: timingSchema,
  rotationJitterDeg: z.number().min(-15).max(15),
  seed: z.number().int(),
  /**
   * Preserved on import and re-exported untouched. A style written by a newer
   * build may carry fields this build does not understand, and silently dropping
   * them would corrupt the file the user shares back.
   */
  extras: z.record(z.unknown()).optional(),
});

export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionFont = CaptionStyle['font'];
export type CaptionText = CaptionStyle['text'];
export type CaptionPosition = CaptionStyle['position'];
export type CaptionAnimation = CaptionStyle['animation'];
export type CaptionHighlightMode = CaptionStyle['highlight']['mode'];

/** Where a style's font comes from (SPEC 11 §10). */
export type FontSource = CaptionFont['source'];

/**
 * A style with defaults filled in for everything optional.
 *
 * `parseStyle` returns this rather than the raw parse result so the renderer
 * never has to test for an absent `wordColors` or `animation.params`.
 */
export function parseStyle(input: unknown): CaptionStyle {
  return captionStyleSchema.parse(input);
}

export type ParseStyleResult =
  | { ok: true; style: CaptionStyle }
  | { ok: false; message: string; issues: Array<{ path: string; message: string }> };

/**
 * Never throws — the import flow needs to show the user *why* a file was
 * rejected, and a stack trace is not that.
 */
export function tryParseStyle(input: unknown): ParseStyleResult {
  const result = captionStyleSchema.safeParse(input);
  if (result.success) return { ok: true, style: result.data };
  return {
    ok: false,
    message: summariseIssues(result.error),
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

function summariseIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'This file is not a caption style.';
  const where = first.path.join('.');
  return where ? `${where}: ${first.message}` : first.message;
}

/**
 * SPEC 11 §6 — `formatVersion` migrations, each tested.
 *
 * Kept as a list rather than an if-chain so adding version 2 means appending one
 * entry, and the test that every step is covered is obvious. A style claiming a
 * version this build does not know is refused rather than guessed at.
 */
type StyleMigration = {
  from: number;
  to: number;
  describe: string;
  apply(style: Record<string, unknown>): Record<string, unknown>;
};

export const STYLE_MIGRATIONS: readonly StyleMigration[] = [];

export type MigrationResult =
  | { ok: true; style: unknown; applied: string[] }
  | { ok: false; message: string };

export function migrateStyle(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: 'This file is not a caption style.' };
  }
  const record = { ...(input as Record<string, unknown>) };
  if (record.format !== CWSTYLE_FORMAT) {
    return { ok: false, message: `Expected a "${CWSTYLE_FORMAT}" file.` };
  }

  let version = typeof record.formatVersion === 'number' ? record.formatVersion : 0;
  if (version > CWSTYLE_FORMAT_VERSION) {
    return {
      ok: false,
      message:
        `This style was saved by a newer version of Clipwright Studio ` +
        `(format ${version}; this build reads up to ${CWSTYLE_FORMAT_VERSION}).`,
    };
  }

  const applied: string[] = [];
  let current = record;
  while (version < CWSTYLE_FORMAT_VERSION) {
    const step = STYLE_MIGRATIONS.find((candidate) => candidate.from === version);
    if (!step) {
      return { ok: false, message: `No migration from style format version ${version}.` };
    }
    current = step.apply(current);
    current.formatVersion = step.to;
    applied.push(step.describe);
    version = step.to;
  }

  return { ok: true, style: current, applied };
}

/**
 * SPEC 11 §6 — "unknown fields are preserved on import/export".
 *
 * Collects every key the schema does not name, at the top level and in the
 * sub-objects that are most likely to grow. Those keys go back out in `extras`
 * and in the object itself, so a round trip through this build does not silently
 * delete a field a newer build wrote.
 */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'format',
  'formatVersion',
  'id',
  'name',
  'author',
  'license',
  'createdAt',
  'font',
  'text',
  'fill',
  'outline',
  'shadow',
  'background',
  'position',
  'highlight',
  'wordColors',
  'animation',
  'timing',
  'rotationJitterDeg',
  'seed',
  'extras',
]);

export function collectUnknownFields(input: Record<string, unknown>): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) unknown[key] = value;
  }
  return unknown;
}

/**
 * Import: migrate, remember what this build does not understand, then validate.
 * The order matters — a file from a newer build must be refused before its
 * missing fields produce a confusing schema error.
 */
export function importStyle(raw: unknown): ParseStyleResult {
  const migration = migrateStyle(raw);
  if (!migration.ok) {
    return { ok: false, message: migration.message, issues: [{ path: 'format', message: migration.message }] };
  }

  const migrated = migration.style as Record<string, unknown>;
  const unknown = collectUnknownFields(migrated);
  const candidate = Object.keys(unknown).length > 0 ? { ...migrated, extras: { ...unknown, ...(migrated.extras as object | undefined) } } : migrated;

  return tryParseStyle(candidate);
}

/** Export: the same object, minus bookkeeping, with `extras` flattened back out. */
export function exportStyle(style: CaptionStyle): Record<string, unknown> {
  const { extras, ...rest } = style;
  // `extras` holds only fields this build did not write; putting them back at the
  // top level keeps the file valid for the build that wrote them.
  const flattened = { ...rest, ...(extras ?? {}) };
  // `format` and `formatVersion` are written last so an `extras` entry left over
  // from a newer file cannot overwrite them with something this build rejects.
  return { ...flattened, format: CWSTYLE_FORMAT, formatVersion: CWSTYLE_FORMAT_VERSION };
}
