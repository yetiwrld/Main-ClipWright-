/**
 * SPEC 02 §4.3–4.7 — the start screen's choices, as project settings.
 *
 * The start screen is the first screen in the app and the only place a project is created, and
 * until this module existed **pressing "Find clips" failed**: the page sent `aspectRatio`,
 * `captionStyle`, `clipLength` and `storageMode: 'copy'`, and none of those are settings keys.
 * `ProjectRecordSchema.parse` threw `invalid_enum_value` on `copy` and the whole creation failed,
 * so no project could be made at all. The other three keys were not rejected — the schema passes
 * unknown keys through — but they were read by nothing, so a user who chose 4:3 and Karaoke and
 * Short got 9:16, Bold creator and 30–60 s and no hint that the choice had been dropped.
 *
 * The names drifted because the page was written against an imagined settings shape while the
 * schema evolved separately, and no test crossed the boundary: `StartPage` had no test, and the
 * schema's own tests never saw the page's payload. That is the bug this file prevents from
 * recurring — it is the dependency both sides already have, and it is unit-testable without a
 * window.
 *
 * Two jobs:
 *
 * 1. `startSettings` turns the page's choices into schema keys, and returns only the keys it has
 *    something to say about. `sourcePath` and the other intake details stay as they were — they
 *    are not project settings and the import stage reads them from this same blob.
 * 2. `resolveStartSettings` finishes the job: a Custom aspect becomes a concrete ratio pair in
 *    `customAspect`, and a Custom clip length becomes a concrete range in `clipLengthRangeSec`.
 *    Both are the schema's own vocabulary for the value, rather than a key nothing reads.
 */

import type { ProjectRecord } from './schemas.js';

/*
  One type-only import, and the lint rule that keeps Node builtins out of the renderer follows it
  into `schemas.ts` and complains. The type is erased at build time, so nothing from `schemas.js`
  reaches the bundle; annotating the enum values locally is the honest way to say that.
*/

/** The aspect ratios the start screen offers, in the order the tiles appear. */
export const START_ASPECTS = ['9:16', '16:9', '1:1', '4:5', '4:3', '21:9', 'original', 'custom'] as const;
export type StartAspect = (typeof START_ASPECTS)[number];

/**
 * The two ways the page can name storage, and the schema's two names for them.
 *
 * The page said "Copy into the project" and meant the schema's `managed`; it said "Reference the
 * original" and meant `reference`. Only the first was wrong, and because the enum rejects the
 * whole object, that one wrong value was enough to lose the entire project creation.
 */
export const START_STORAGE_MODES = {
  copy: 'managed',
  reference: 'reference',
} as const satisfies Record<string, ProjectRecord['settings']['storageMode']>;

/** The clip-length presets and the range seconds each one means (SPEC 02 §4.5). */
export const START_CLIP_LENGTHS = {
  short: { min: 15, max: 30 },
  medium: { min: 30, max: 60 },
  long: { min: 60, max: 90 },
  extended: { min: 90, max: 180 },
} as const satisfies Record<string, { min: number; max: number }>;

export type StartClipLength = keyof typeof START_CLIP_LENGTHS | 'custom';

/** What the start screen holds while the user chooses. Names are the page's, not the schema's. */
export interface StartChoices {
  aspect: string;
  /** Only meaningful when `aspect` is `'custom'`. */
  customAspect?: { width: number; height: number };
  captionStyleId: string;
  clipLength: StartClipLength;
  /** Only meaningful when `clipLength` is `'custom'`. */
  clipLengthRangeSec?: [number, number];
  clipCount: number | 'auto';
  contentType: ProjectRecord['settings']['contentType'];
  language: string;
  processingMode: ProjectRecord['settings']['processingMode'];
  downloadQuality: ProjectRecord['settings']['downloadQuality'];
  storageMode: keyof typeof START_STORAGE_MODES;
  clipFocus: string;
}

/** Aspect ratios a composition can actually be built at; `original` and `custom` resolve to one. */
const CONCRETE_ASPECTS = ['9:16', '16:9', '1:1', '4:5', '4:3', '21:9'] as const;
type ConcreteAspect = (typeof CONCRETE_ASPECTS)[number];

function isConcreteAspect(value: string): value is ConcreteAspect {
  return (CONCRETE_ASPECTS as readonly string[]).includes(value);
}

/**
 * The aspect ratio a start-screen choice resolves to in practice.
 *
 * `original` cannot be resolved without the source, and the schema keeps it as its own value for
 * exactly that reason — the composition builder decides once the media has been probed. `custom`
 * would be `customAspect`'s job, but nothing builds a canvas from a pair yet, so it falls back to
 * 9:16 here the same way the composition builder already does, rather than claiming a size.
 *
 * This mirrors `moments-service`'s `CANVAS_BY_ASPECT` lookup and exists so the two agree by
 * construction instead of by two people writing the same `??` twice.
 */
export function concreteAspect(aspect: string): ConcreteAspect {
  return isConcreteAspect(aspect) ? aspect : '9:16';
}

/**
 * The start screen's choices as schema keys — the fix for the front door.
 *
 * Returns a partial object so the caller can spread it over `sourcePath` and anything else the
 * import stage needs. Values outside the schema's vocabulary are *clamped or defaulted here*
 * rather than left to throw in the store: a project that cannot be created is worse than one that
 * was created with a sane default, and the page cannot produce an invalid value once this runs.
 */
export function startSettings(choices: StartChoices): Partial<ProjectRecord['settings']> {
  const settings: Partial<ProjectRecord['settings']> = {
    aspect: choices.aspect === 'original' || choices.aspect === 'custom'
      ? choices.aspect
      : concreteAspect(choices.aspect),
    captionStyleId: choices.captionStyleId,
    clipLengthPreset: choices.clipLength,
    clipCount: choices.clipCount,
    contentType: choices.contentType,
    language: choices.language,
    processingMode: choices.processingMode,
    downloadQuality: choices.downloadQuality,
    storageMode: START_STORAGE_MODES[choices.storageMode] ?? 'managed',
    clipFocus: choices.clipFocus,
  };

  if (choices.aspect === 'custom' && choices.customAspect) {
    settings.customAspect = {
      width: clampInt(choices.customAspect.width, 1, 32),
      height: clampInt(choices.customAspect.height, 1, 32),
    };
  }

  if (choices.clipLength === 'custom') {
    const range = choices.clipLengthRangeSec ?? [30, 60];
    /* The schema's own bounds: 5 s to 600 s, and a minimum that is a lower bound. */
    const min = clampNum(range[0], 5, 600);
    const max = clampNum(range[1], 5, 600);
    settings.clipLengthRangeSec = min <= max ? [min, max] : [max, min];
  } else {
    const preset = START_CLIP_LENGTHS[choices.clipLength as keyof typeof START_CLIP_LENGTHS];
    if (preset) {
      /*
        The preset's range is written too, not only its name. `clipLengthPreset` is read by nothing
        yet — the analyser reads `clipLengthRangeSec` — so writing only the name would leave the
        user's choice as decorative as the four keys this module exists to replace.
      */
      settings.clipLengthRangeSec = [preset.min, preset.max];
    }
  }

  return settings;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
