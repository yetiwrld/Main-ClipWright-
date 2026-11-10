/**
 * SPEC 13 §8 — applying a brand kit.
 *
 * The whole point of this module is that **a kit is a recipe, not a kind of object**. Applying
 * one produces ordinary timeline items and ordinary style assignments; nothing downstream —
 * the renderers, the exporter, the timeline — learns what a brand kit is. That is what makes
 * "delete the kit and the applied items stay" true by construction rather than by careful
 * bookkeeping.
 *
 * The module is pure: it takes a kit and the little it needs to know about the project, and
 * returns a description of the commands to run. The caller performs them, which keeps this
 * testable without a store, a canvas or an ffmpeg binary.
 *
 * Three decisions are worth stating up front because they are the ones a user would notice:
 *
 * 1. **Nothing is applied silently.** `planKitApplication` returns a `report` listing what it
 *    could not do (a missing music asset, a missing caption style) rather than skipping it.
 *    A kit that quietly applies four of its six parts is worse than one that says so.
 * 2. **Logo positions are percentages, resolved per composition.** A kit designed on 16:9 is
 *    applied to a 9:16 project without moving the logo off-screen, because `resolvePlacement`
 *    computes from the target's own aspect ratio.
 * 3. **Intro and outro are clips, and a kit applied twice replaces them.** The provenance tag
 *    is what makes that possible; see `findKitAppliedItems`.
 */

import type { BrandKit, BrandKitPlacement } from './schema.js';

/** Which parts of a kit to apply. Everything defaults to on; the UI shows these as checkboxes. */
export interface KitApplyParts {
  captions: boolean;
  logo: boolean;
  introOutro: boolean;
  lowerThird: boolean;
  music: boolean;
  /** Fonts and colours for existing text items. */
  textDefaults: boolean;
}

export const ALL_KIT_PARTS: KitApplyParts = {
  captions: true,
  logo: true,
  introOutro: true,
  lowerThird: true,
  music: true,
  textDefaults: true,
};

/**
 * The provenance tag written onto every item a kit creates (SPEC 13 §8.2).
 *
 * It exists so *Reapply* and *Detach* can find what a kit made. It is deliberately on the
 * item rather than in a side table: the item is the thing that survives a save, a duplicate
 * and a copy between projects, and a side table would lose track of it at the first of those.
 */
export interface KitProvenance {
  tool: 'brand-kit';
  kitId: string;
  /**
   * When the kit was applied, ISO 8601.
   *
   * Required by the schema, and not merely bookkeeping: *Reapply* needs to tell "this item
   * came from the last time I applied the kit" from "this came from a run before the kit
   * changed", and the timestamp is the only thing on the item that says which.
   */
  appliedAt: string;
  /** The provenance format's own version, so a future shape can be told apart. */
  version: number;
}

/** The provenance a kit writes onto every item it creates. */
export function kitProvenance(kitId: string, appliedAt: string): KitProvenance {
  return { tool: 'brand-kit', kitId, appliedAt, version: 1 };
}

/** What the caller needs to know about the project to place things sensibly. */
export interface KitTarget {
  widthPx: number;
  heightPx: number;
}

/** A rectangle in canvas pixels, which is what a placement resolves to. */
export interface PlacedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolve a percentage placement to pixels for a given canvas.
 *
 * The corner positions use `margin` as a percentage of the **short side**, which is what
 * keeps a corner logo the same distance from the edge whether the canvas is landscape or
 * vertical. Using the width would put a vertical video's logo twice as far from the side as
 * from the top, which reads as a mistake.
 *
 * `sizePct` is of the short side too, so a logo stays the same apparent size across aspect
 * ratios rather than ballooning on a wide canvas.
 *
 * The returned box is where the item should sit with the **top-left** at `x`,`y`, since the
 * timeline's transform is a position plus a scale. Aspect ratio is preserved by the
 * caller, which knows the asset's dimensions; this function cannot, and inventing a box
 * would be worse than returning the square the placement describes.
 */
export function resolvePlacement(
  placement: BrandKitPlacement,
  canvas: KitTarget,
): PlacedBox {
  const shortSide = Math.min(canvas.widthPx, canvas.heightPx);
  const size = (placement.sizePct / 100) * shortSide;
  const margin = (placement.margin / 100) * shortSide;

  let x: number;
  let y: number;
  switch (placement.position) {
    case 'tl':
      x = margin;
      y = margin;
      break;
    case 'tr':
      x = canvas.widthPx - margin - size;
      y = margin;
      break;
    case 'bl':
      x = margin;
      y = canvas.heightPx - margin - size;
      break;
    case 'br':
      x = canvas.widthPx - margin - size;
      y = canvas.heightPx - margin - size;
      break;
    case 'custom':
      /*
        `custom` uses the stored percentages directly, against each axis, because that is
        what the user dragged to: a point at 80% across is 80% of the width whatever the
        aspect. That is a different intention from a corner margin, and conflating them
        would move the item when the canvas changed shape.
      */
      x = (placement.xPct / 100) * canvas.widthPx;
      y = (placement.yPct / 100) * canvas.heightPx;
      break;
  }
  return { x, y, width: size, height: size };
}

/**
 * When a placed graphic is on screen, in microseconds relative to the composition.
 *
 * `showFrom: 'always'` and `'start'` both begin at zero and differ only in intent — see the
 * schema — so the resolved window is the same; `showFor` decides the end. `whole` means the
 * composition's length, which the caller supplies because a kit has no idea how long the
 * video is.
 */
export function resolveVisibility(
  placement: BrandKitPlacement,
  compositionDurationUs: number,
): { startUs: number; endUs: number } {
  const startUs = typeof placement.showFrom === 'object' ? Math.round(placement.showFrom.atSec * 1_000_000) : 0;
  const endUs =
    placement.showFor === 'whole'
      ? compositionDurationUs
      : Math.min(compositionDurationUs, startUs + Math.round(placement.showFor * 1_000_000));
  return { startUs, endUs: Math.max(startUs, endUs) };
}

/**
 * What applying a kit to one clip would do, as data.
 *
 * Every field is optional in the result because a kit need not have every part, and a part
 * that cannot be applied is reported rather than invented. The caller turns this into
 * commands; keeping it declarative is what lets the tests assert the *decisions* (which
 * item, what size, what colour) without a timeline.
 */
export interface KitApplicationPlan {
  captionStyleId?: string;
  captionOverrides?: Record<string, unknown>;
  logo?: {
    assetId: string;
    box: PlacedBox;
    opacity: number;
    startUs: number;
    endUs: number;
  };
  watermark?: {
    assetId: string;
    box: PlacedBox;
    opacity: number;
    startUs: number;
    endUs: number;
  };
  lowerThird?: { templateId: string; fields: Record<string, string>; startUs: number; endUs: number };
  /**
   * The intro clip, inserted at the start; `durationUs` is what the timeline must grow by.
   *
   * `compositionTemplateId` is carried alongside `assetId` rather than resolved here: a kit may
   * name a template instead of a file, and only the caller knows how to build one. Whichever is
   * present is what it uses.
   */
  intro?: { assetId?: string; compositionTemplateId?: string; durationUs: number };
  /** The outro clip, appended after everything. Same shape as the intro. */
  outro?: { assetId?: string; compositionTemplateId?: string; durationUs: number };
  /** The music bed, with the ducking and normalisation the kit asks for. */
  music?: { assetId: string; volumeDb: number; duckUnderSpeech: boolean; targetLufs?: number };
  /**
   * Problems worth telling the user about, in plain sentences. Not errors: a kit with a
   * missing music asset still applies its other parts, and the report says which part was
   * skipped and why.
   */
  report: string[];
}

/** What the project can or cannot supply, so the plan can report honestly. */
export interface KitAvailability {
  /** Media ids that exist. A kit naming anything else is reported, not fatal. */
  assetIds: ReadonlySet<string>;
  /** `.cwstyle` ids that exist. */
  captionStyleIds: ReadonlySet<string>;
  /**
   * Pixel dimensions of known assets, so an intro or outro in the wrong aspect can be
   * flagged. Optional: a caller that has not probed its media reports no warning rather than
   * inventing one, and a template has no dimensions at all.
   */
  assetSizes?: ReadonlyMap<string, { widthPx: number; heightPx: number }>;
}

/**
 * Build the plan for applying `kit` to a composition of the given size and length.
 *
 * `parts` is the checkbox set. A part the user turned off is not reported as missing — it was
 * not asked for — which is why the availability checks are gated on the part being enabled.
 */
export function planKitApplication(
  kit: BrandKit,
  canvas: KitTarget,
  compositionDurationUs: number,
  availability: KitAvailability,
  parts: KitApplyParts = ALL_KIT_PARTS,
): KitApplicationPlan {
  const plan: KitApplicationPlan = { report: [] };

  if (parts.captions) {
    if (kit.captionStyleId === undefined) {
      // No caption look in the kit is a normal state, not a problem: a kit may be colours
      // and a logo only. Nothing is reported.
    } else if (!availability.captionStyleIds.has(kit.captionStyleId)) {
      plan.report.push(
        `The kit's caption style "${kit.captionStyleId}" is not installed, so captions were left as they are.`,
      );
    } else {
      plan.captionStyleId = kit.captionStyleId;
      if (kit.captionOverrides) plan.captionOverrides = kit.captionOverrides;
    }
  }

  if (parts.logo) {
    if (kit.logo) {
      if (availability.assetIds.has(kit.logo.assetId)) {
        const window = resolveVisibility(kit.logo, compositionDurationUs);
        plan.logo = {
          assetId: kit.logo.assetId,
          box: resolvePlacement(kit.logo, canvas),
          opacity: kit.logo.opacity,
          startUs: window.startUs,
          endUs: window.endUs,
        };
      } else {
        plan.report.push(`The kit's logo is missing from the media library, so none was placed.`);
      }
    }
    if (kit.watermark) {
      if (availability.assetIds.has(kit.watermark.assetId)) {
        const window = resolveVisibility(kit.watermark, compositionDurationUs);
        plan.watermark = {
          assetId: kit.watermark.assetId,
          box: resolvePlacement(kit.watermark, canvas),
          opacity: kit.watermark.opacity,
          startUs: window.startUs,
          endUs: window.endUs,
        };
      } else {
        plan.report.push(`The kit's watermark is missing from the media library, so none was placed.`);
      }
    }
  }

  if (parts.lowerThird && kit.lowerThird) {
    /*
      The fields are copied rather than referenced, and empty ones are dropped: a lower third
      with `name: ''` renders a blank line, which looks like a bug rather than a choice.
    */
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(kit.lowerThird.fields)) {
      if (typeof value === 'string' && value.trim().length > 0) fields[key] = value;
    }
    plan.lowerThird = {
      templateId: kit.lowerThird.templateId,
      fields,
      startUs: Math.round(kit.lowerThird.showAtSec * 1_000_000),
      endUs: Math.round((kit.lowerThird.showAtSec + kit.lowerThird.forSec) * 1_000_000),
    };
  }

  /*
    Intro and outro are the only parts that change the composition's *length*, so both are
    planned with the duration the timeline will need, not with a placement. A kit's intro is
    allowed to be longer than the clip (SPEC 13 §8's cases): it is inserted, never trimmed to
    fit, and the plan says nothing about it — the command inserts whatever the duration says.
  */
  for (const which of ['intro', 'outro'] as const) {
    if (!parts.introOutro) break;
    const ref = kit[which];
    if (!ref) continue;
    const namedByAsset = ref.assetId !== undefined;
    if (namedByAsset && !availability.assetIds.has(ref.assetId!)) {
      plan.report.push(`The kit's ${which} clip is missing from the media library, so none was inserted.`);
      continue;
    }
    /*
      A template needs no media check: it is built from the project's own settings, and
      reporting it missing would be complaining about a thing the project supplies.
    */
    const durationUs = Math.max(Math.round(ref.durationSec * 1_000_000), 1);
    plan[which] = {
      ...(ref.assetId !== undefined ? { assetId: ref.assetId } : {}),
      ...(ref.compositionTemplateId !== undefined
        ? { compositionTemplateId: ref.compositionTemplateId }
        : {}),
      durationUs,
    };

    /*
      Wrong aspect is a warning, not a refusal: the clip is fitted to the canvas when drawn
      (SPEC 13 §8 lists "fit with the canvas fill option and a warning"), so the kit still
      applies and the user is told what they will see. Only assets with known dimensions can
      be judged, and a square canvas never mismatches.
    */
    const size = ref.assetId !== undefined ? availability.assetSizes?.get(ref.assetId) : undefined;
    if (size && size.widthPx > 0 && size.heightPx > 0) {
      const assetAspect = size.widthPx / size.heightPx;
      const canvasAspect = canvas.widthPx / canvas.heightPx;
      // A tenth of a percent is a rounding difference, not bars: rotate 16:9 by 90° and the
      // aspect is off by 3×, so nothing sensible sits near this line.
      if (Math.abs(assetAspect - canvasAspect) / canvasAspect > 0.001) {
        plan.report.push(
          `The kit's ${which} is ${size.widthPx}×${size.heightPx} but the composition is ${canvas.widthPx}×${canvas.heightPx}, so it was fitted and may show bars.`,
        );
      }
    }
  }

  if (parts.music && kit.audio?.musicAssetId !== undefined) {
    if (availability.assetIds.has(kit.audio.musicAssetId)) {
      plan.music = {
        assetId: kit.audio.musicAssetId,
        volumeDb: kit.audio.musicVolumeDb,
        duckUnderSpeech: kit.audio.duckUnderSpeech,
        ...(kit.audio.normaliseTargetLufs !== undefined
          ? { targetLufs: kit.audio.normaliseTargetLufs }
          : {}),
      };
    } else {
      plan.report.push(`The kit's music is missing from the media library, so no bed was added.`);
    }
  }

  return plan;
}

/**
 * Which items a kit already applied to this composition.
 *
 * This is what makes *Reapply* replace rather than duplicate: the caller removes these
 * before applying the current version of the kit. Reading the tag off the item — rather than
 * keeping a list on the kit — is what makes it survive a save, a duplicate and a copy between
 * projects, and what makes *Delete kit* leave the items alone (they are ordinary items whose
 * tag simply points at a kit that no longer exists).
 */
export function findKitAppliedItems<T extends Record<string, unknown>>(
  /**
   * `T` is inferred from the array and returned unchanged, so the caller keeps every field
   * its items arrived with — a structurally narrowed return type would make `item.id` a type
   * error at the call site, which is how this signature first failed its own typecheck.
   *
   * The constraint is `Record<string, unknown>` rather than the provenance shape itself
   * because of TypeScript's **weak-type detection**: `{ id: string }` and
   * `{ aiProvenance?: … }` share no properties, so a value that has never been tagged —
   * the commonest thing this function is asked about — is rejected as an argument. Reading
   * the tag through a local narrows it properly, and the caller's item type is preserved
   * because the constraint is only a constraint.
   */
  items: ReadonlyArray<T>,
  kitId: string,
): T[] {
  return items.filter((item) => {
    const provenance = item['aiProvenance'] as { tool?: string; kitId?: string } | undefined;
    return provenance?.tool === 'brand-kit' && provenance.kitId === kitId;
  });
}

/**
 * What a kit needs that this workspace does not have, for the kit list's warning chips.
 *
 * Separate from `planKitApplication` on purpose: this answers "is this kit usable *here*"
 * before anything is applied, which is a different question from "what would applying it do
 * to this clip". The UI shows the first on the card and the second in the preview.
 */
export interface KitDiagnosis {
  missingAssetIds: string[];
  missingCaptionStyleId?: string;
  /** True when the kit would apply with no omissions at all. */
  complete: boolean;
}

export function diagnoseKit(kit: BrandKit, availability: KitAvailability): KitDiagnosis {
  const missing: string[] = [];
  const noteAsset = (id: string | undefined) => {
    if (id !== undefined && !availability.assetIds.has(id) && !missing.includes(id)) missing.push(id);
  };
  noteAsset(kit.logo?.assetId);
  noteAsset(kit.watermark?.assetId);
  noteAsset(kit.audio?.musicAssetId);
  noteAsset(kit.intro?.assetId);
  noteAsset(kit.outro?.assetId);

  const missingCaptionStyleId =
    kit.captionStyleId !== undefined && !availability.captionStyleIds.has(kit.captionStyleId)
      ? kit.captionStyleId
      : undefined;

  return {
    missingAssetIds: missing,
    ...(missingCaptionStyleId !== undefined ? { missingCaptionStyleId } : {}),
    complete: missing.length === 0 && missingCaptionStyleId === undefined,
  };
}

/** A kit's colours as the five named slots plus customs, which is what a swatch row draws. */
export function kitSwatches(kit: BrandKit): Array<{ name: string; value: string }> {
  const { primary, secondary, accent, background, text, custom } = kit.colors;
  return [
    { name: 'Primary', value: primary },
    { name: 'Secondary', value: secondary },
    { name: 'Accent', value: accent },
    { name: 'Background', value: background },
    { name: 'Text', value: text },
    ...custom.map((entry) => ({ name: entry.name, value: entry.value })),
  ];
}
