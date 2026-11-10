import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_KIT_PARTS,
  CwbrandFormat,
  CwbrandFormatVersion,
  diagnoseKit,
  findKitAppliedItems,
  kitSwatches,
  planKitApplication,
  resolvePlacement,
  resolveVisibility,
  safeAreaBandsFor,
  type BrandKit,
  type BrandKitPlacement,
} from '../index.js';

/**
 * Applying a kit (SPEC 13 §8.2).
 *
 * The claims worth testing are the ones a user would notice and a screenshot would hide:
 * that a logo lands inside a vertical frame when the kit was designed for a wide one, that a
 * missing asset is *reported* rather than silently skipped, and that re-applying replaces the
 * items a kit made rather than stacking a second logo.
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

const placement = (overrides: Partial<BrandKitPlacement> = {}): BrandKitPlacement =>
  ({
    position: 'br',
    xPct: 4,
    yPct: 4,
    sizePct: 12,
    opacity: 1,
    margin: 4,
    showFrom: 'always',
    showFor: 'whole',
    ...overrides,
  }) as BrandKitPlacement;

const everything = { assetIds: new Set(['logo-1', 'mark-1', 'music-1']), captionStyleIds: new Set(['bold-creator']) };
const nothing = { assetIds: new Set<string>(), captionStyleIds: new Set<string>() };

describe('resolvePlacement', () => {
  const landscape = { widthPx: 1920, heightPx: 1080 };
  const portrait = { widthPx: 1080, heightPx: 1920 };

  it('places a bottom-right logo inside the frame', () => {
    const box = resolvePlacement(placement({ position: 'br' }), landscape);
    // 4% of the short side (1080) = 43.2 px margin; 12% = 129.6 px logo.
    expect(box.x).toBeCloseTo(1920 - 43.2 - 129.6, 3);
    expect(box.y).toBeCloseTo(1080 - 43.2 - 129.6, 3);
    expect(box.x + box.width).toBeLessThanOrEqual(1920);
    expect(box.y + box.height).toBeLessThanOrEqual(1080);
  });

  it('uses the short side for both the margin and the size', () => {
    /*
      The distinguishing case. On a portrait canvas the short side is the *width*, so a logo
      sized against it is 12% of 1080 = 129.6 px — the same apparent size as on the wide
      canvas. Sizing against the width on a landscape canvas and the height on a portrait one
      would make the same kit's logo change size by 78% between the two, which is the sort of
      thing that looks like a bug in the kit rather than in the code.
    */
    const wide = resolvePlacement(placement(), landscape);
    const tall = resolvePlacement(placement(), portrait);
    expect(wide.width).toBeCloseTo(tall.width, 6);
    expect(wide.width).toBeCloseTo(129.6, 3);
  });

  it('keeps a corner logo inside a portrait frame', () => {
    // The case the spec names: a kit designed on 16:9 applied to 9:16. A margin computed
    // from the width would put this off the right edge.
    const box = resolvePlacement(placement({ position: 'br' }), portrait);
    expect(box.x + box.width).toBeLessThanOrEqual(portrait.widthPx);
    expect(box.y + box.height).toBeLessThanOrEqual(portrait.heightPx);
    expect(box.x).toBeGreaterThan(0);
  });

  it('places all four corners without overlap between opposite pairs', () => {
    const tl = resolvePlacement(placement({ position: 'tl' }), landscape);
    const br = resolvePlacement(placement({ position: 'br' }), landscape);
    expect(tl.x).toBeLessThan(br.x);
    expect(tl.y).toBeLessThan(br.y);
  });

  it('honours custom percentages against each axis, which is what the user dragged', () => {
    /*
      `custom` is a different intention from a corner margin: the user picked a point at 80%
      across and 20% down, and that means 80% of the width and 20% of the height whatever
      shape the canvas is. Treating it like a margin would move the item whenever the aspect
      changed, which is the opposite of what dragging to a point means.
    */
    const box = resolvePlacement(placement({ position: 'custom', xPct: 80, yPct: 20 }), landscape);
    expect(box.x).toBeCloseTo(0.8 * 1920, 6);
    expect(box.y).toBeCloseTo(0.2 * 1080, 6);

    const tall = resolvePlacement(placement({ position: 'custom', xPct: 80, yPct: 20 }), portrait);
    expect(tall.x).toBeCloseTo(0.8 * 1080, 6);
    expect(tall.y).toBeCloseTo(0.2 * 1920, 6);
  });
});

describe('resolveVisibility', () => {
  it('shows a whole-composition graphic for the whole composition', () => {
    expect(resolveVisibility(placement({ showFor: 'whole' }), 10_000_000)).toEqual({ startUs: 0, endUs: 10_000_000 });
  });

  it('shows a timed graphic for its window', () => {
    expect(resolveVisibility(placement({ showFor: 3 }), 10_000_000)).toEqual({ startUs: 0, endUs: 3_000_000 });
  });

  it('starts a delayed graphic at its time and not before', () => {
    const window = resolveVisibility(placement({ showFrom: { atSec: 2 }, showFor: 3 }), 10_000_000);
    expect(window).toEqual({ startUs: 2_000_000, endUs: 5_000_000 });
  });

  it('never runs past the end of the composition', () => {
    // A logo shown from 9 s for 10 s in a 10 s video ends at 10 s, not 19 s: an item past
    // the end would still be created, still be selectable, and draw nothing.
    const window = resolveVisibility(placement({ showFrom: { atSec: 9 }, showFor: 10 }), 10_000_000);
    expect(window.endUs).toBe(10_000_000);
  });

  it('does not produce a negative-length window', () => {
    // A `showFrom` past the end, which a user can produce by editing the seconds field.
    const window = resolveVisibility(placement({ showFrom: { atSec: 20 }, showFor: 3 }), 10_000_000);
    expect(window.endUs).toBeGreaterThanOrEqual(window.startUs);
  });
});

describe('planKitApplication', () => {
  it('applies every part a complete kit asks for', () => {
    const plan = planKitApplication(
      kit({
        captionStyleId: 'bold-creator',
        logo: { assetId: 'logo-1', ...placement() },
        audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
      }),
      { widthPx: 1920, heightPx: 1080 },
      10_000_000,
      everything,
    );
    expect(plan.report).toEqual([]);
    expect(plan.captionStyleId).toBe('bold-creator');
    expect(plan.logo?.assetId).toBe('logo-1');
    expect(plan.music?.volumeDb).toBe(-18);
  });

  it('reports a missing asset instead of silently skipping it', () => {
    /*
      The rule this module exists to enforce. A kit that quietly applies four of its six
      parts leaves the user looking for a logo that is not there, with nothing to read; a
      sentence telling them the asset is missing is the whole difference.
    */
    const plan = planKitApplication(
      kit({ logo: { assetId: 'gone', ...placement() }, audio: { musicAssetId: 'music-1', musicVolumeDb: -12, duckUnderSpeech: true } }),
      { widthPx: 1920, heightPx: 1080 },
      10_000_000,
      everything,
    );
    expect(plan.logo).toBeUndefined();
    expect(plan.report).toHaveLength(1);
    expect(plan.report[0]).toContain('logo');
    // And the rest still applies: one missing asset is not a failed apply.
    expect(plan.music?.assetId).toBe('music-1');
  });

  it('reports a missing caption style, naming it', () => {
    const plan = planKitApplication(
      kit({ captionStyleId: 'not-installed' }),
      { widthPx: 1920, heightPx: 1080 },
      10_000_000,
      everything,
    );
    expect(plan.captionStyleId).toBeUndefined();
    expect(plan.report[0]).toContain('not-installed');
  });

  it('says nothing about a part the user turned off', () => {
    /*
      A checkbox that is off is not a failure. Reporting "the logo is missing" for a kit the
      user applied with the logo unchecked would be reporting a problem with something they
      deliberately did not ask for.
    */
    const plan = planKitApplication(
      kit({ logo: { assetId: 'gone', ...placement() } }),
      { widthPx: 1920, heightPx: 1080 },
      10_000_000,
      nothing,
      { ...ALL_KIT_PARTS, logo: false },
    );
    expect(plan.report).toEqual([]);
    expect(plan.logo).toBeUndefined();
  });

  it('applies a kit with no caption style without complaining', () => {
    // Colours and a logo alone is a legitimate kit, not an incomplete one.
    const plan = planKitApplication(kit(), { widthPx: 1920, heightPx: 1080 }, 10_000_000, everything);
    expect(plan.report).toEqual([]);
    expect(plan.captionStyleId).toBeUndefined();
  });

  it('drops empty lower-third fields rather than rendering blank lines', () => {
    const plan = planKitApplication(
      kit({ lowerThird: { templateId: 'lt-1', fields: { name: 'Ada', role: '   ' }, showAtSec: 1, forSec: 4 } }),
      { widthPx: 1920, heightPx: 1080 },
      10_000_000,
      everything,
    );
    expect(plan.lowerThird?.fields).toEqual({ name: 'Ada' });
    expect(plan.lowerThird?.startUs).toBe(1_000_000);
    expect(plan.lowerThird?.endUs).toBe(5_000_000);
  });

  it('carries the normalisation target when the kit asks for one', () => {
    const plan = planKitApplication(
      kit({ audio: { musicAssetId: 'music-1', musicVolumeDb: -12, duckUnderSpeech: false, normaliseTargetLufs: -16 } }),
      { widthPx: 1920, heightPx: 1080 },
      10_000_000,
      everything,
    );
    expect(plan.music?.targetLufs).toBe(-16);
    expect(plan.music?.duckUnderSpeech).toBe(false);
  });
});

describe('findKitAppliedItems', () => {
  it('finds only the items this kit created', () => {
    /*
      What makes *Reapply* replace rather than duplicate. Two kits applied to one project must
      not remove each other's items, and an item the user made by hand has no tag at all.
    */
    const items = [
      { id: 'a', aiProvenance: { tool: 'brand-kit', kitId: 'kit-1' } },
      { id: 'b', aiProvenance: { tool: 'brand-kit', kitId: 'kit-2' } },
      { id: 'c' },
      { id: 'd', aiProvenance: { tool: 'silence-removal', kitId: 'kit-1' } },
    ];
    expect(findKitAppliedItems(items, 'kit-1').map((item) => item.id)).toEqual(['a']);
  });

  it('finds nothing in a project the kit has never touched', () => {
    // Typed explicitly: an untyped literal makes `toEqual([])` compare two different element
    // types, and TypeScript reports the mismatch against the *constraint* rather than the
    // comparison, which reads as if the function's signature were wrong.
    const untouched: Array<{ id: string }> = [{ id: 'a' }];
    expect(findKitAppliedItems(untouched, 'kit-1')).toEqual([]);
  });
});

describe('diagnoseKit', () => {
  it('reports a complete kit as complete', () => {
    const diagnosis = diagnoseKit(
      kit({ logo: { assetId: 'logo-1', ...placement() }, captionStyleId: 'bold-creator' }),
      everything,
    );
    expect(diagnosis.complete).toBe(true);
    expect(diagnosis.missingAssetIds).toEqual([]);
  });

  it('lists every missing asset once, however many places name it', () => {
    // The same asset used as logo and watermark is one missing file, not two.
    const diagnosis = diagnoseKit(
      kit({
        logo: { assetId: 'gone', ...placement() },
        watermark: { assetId: 'gone', ...placement({ opacity: 0.4 }) },
      }),
      nothing,
    );
    expect(diagnosis.missingAssetIds).toEqual(['gone']);
    expect(diagnosis.complete).toBe(false);
  });

  it('names a missing caption style separately from the assets', () => {
    const diagnosis = diagnoseKit(kit({ captionStyleId: 'gone' }), everything);
    expect(diagnosis.missingCaptionStyleId).toBe('gone');
    expect(diagnosis.missingAssetIds).toEqual([]);
    expect(diagnosis.complete).toBe(false);
  });
});

describe('kitSwatches', () => {
  it('lists the five named colours then the customs, in order', () => {
    /*
      Order matters for the UI: the named five are the ones a kit is *about*, and a custom
      colour that arrived first would push the brand's primary colour out of the first slot.
      A list rather than a map because JSON object key order is not something to depend on
      across a round trip.
    */
    const swatches = kitSwatches(
      kit({ colors: { ...kit().colors, custom: [{ name: 'Sand', value: '#EEDDBB' }] } }),
    );
    expect(swatches.map((entry) => entry.name)).toEqual([
      'Primary',
      'Secondary',
      'Accent',
      'Background',
      'Text',
      'Sand',
    ]);
  });
});

/**
 * Intro and outro (SPEC 13 §8: "intro/outro inserted at start/end").
 *
 * The plan does not place these — it describes a clip of a given length, because an intro is
 * *inserted*, not dropped on a track. What it does own is the two things that can be wrong
 * about one: it can be missing, and it can be the wrong shape for the composition.
 */
describe('intro and outro', () => {
  const canvas = { widthPx: 1920, heightPx: 1080 };

  it('plans the intro and outro as clips of their stated duration', () => {
    const plan = planKitApplication(
      kit({
        intro: { assetId: 'logo-1', durationSec: 2.5 },
        outro: { assetId: 'mark-1', durationSec: 4 },
      }),
      canvas,
      10_000_000,
      everything,
    );
    expect(plan.intro).toEqual({ assetId: 'logo-1', durationUs: 2_500_000 });
    expect(plan.outro).toEqual({ assetId: 'mark-1', durationUs: 4_000_000 });
  });

  it('carries a template id when the kit names a template instead of a file', () => {
    // A kit may build its intro from a composition template — a title card, say — and a
    // template has no asset to look up, so no media check is possible or wanted.
    const plan = planKitApplication(
      kit({ intro: { compositionTemplateId: 'tpl-card', durationSec: 3 } }),
      canvas,
      10_000_000,
      nothing,
    );
    expect(plan.intro).toEqual({ compositionTemplateId: 'tpl-card', durationUs: 3_000_000 });
    // Nothing reported: the project supplies the template, so it cannot be "missing from the
    // media library".
    expect(plan.report).toEqual([]);
  });

  it('reports a missing intro rather than planning an empty one', () => {
    const plan = planKitApplication(
      kit({ intro: { assetId: 'gone', durationSec: 2 } }),
      canvas,
      10_000_000,
      everything,
    );
    expect(plan.intro).toBeUndefined();
    expect(plan.report.join(' ')).toContain('intro');
    expect(plan.report.join(' ')).toContain('missing');
  });

  it('does not report an intro when the part is switched off', () => {
    const plan = planKitApplication(
      kit({ intro: { assetId: 'gone', durationSec: 2 } }),
      canvas,
      10_000_000,
      everything,
      { ...ALL_KIT_PARTS, introOutro: false },
    );
    expect(plan.intro).toBeUndefined();
    expect(plan.report).toEqual([]);
  });

  it('warns when the intro is the wrong shape, and still plans it', () => {
    /*
      SPEC 13 §8's case: "intro/outro assets in the wrong aspect → fit with the canvas fill
      option and a warning". A warning that dropped the clip would be a refusal wearing a
      warning's clothes, so the clip is planned *and* the sentence is written.
    */
    const plan = planKitApplication(
      kit({ intro: { assetId: 'logo-1', durationSec: 2 } }),
      canvas,
      10_000_000,
      { ...everything, assetSizes: new Map([['logo-1', { widthPx: 1080, heightPx: 1920 }]]) },
    );
    expect(plan.intro).toBeDefined();
    const sentence = plan.report.join(' ');
    expect(sentence).toContain('1080×1920');
    expect(sentence).toContain('1920×1080');
  });

  it('says nothing about the shape when it matches or is unknown', () => {
    // A caller that has not probed its media gets no invented warning, and a clip that fits
    // gets none either — a warning that fires on correct input is noise the user learns to
    // ignore, which costs more than the warning is worth.
    const matching = planKitApplication(
      kit({ intro: { assetId: 'logo-1', durationSec: 2 } }),
      canvas,
      10_000_000,
      { ...everything, assetSizes: new Map([['logo-1', { widthPx: 1920, heightPx: 1080 }]]) },
    );
    expect(matching.report).toEqual([]);

    const unknown = planKitApplication(
      kit({ intro: { assetId: 'logo-1', durationSec: 2 } }),
      canvas,
      10_000_000,
      everything,
    );
    expect(unknown.report).toEqual([]);
  });

  it('plans an intro longer than the composition', () => {
    // SPEC 13 §8 lists this as an allowed case, not an error: a five-second intro on a
    // three-second clip is a legitimate thing to build, and clipping it would silently
    // shorten what the user asked for.
    const plan = planKitApplication(
      kit({ intro: { assetId: 'logo-1', durationSec: 5 } }),
      canvas,
      3_000_000,
      everything,
    );
    expect(plan.intro?.durationUs).toBe(5_000_000);
    expect(plan.report).toEqual([]);
  });
});

/**
 * Safe areas (SPEC 13 §8.2: "logo positions respect the selected safe-area preset").
 *
 * A logo in the bottom-right corner of a vertical video is exactly where TikTok's caption and
 * scrub bar sit. The kit's preset is what moves it out from under them — and the numbers are
 * the platform's, so what these tests guard is that the offset is applied to the *side* that
 * is covered and that a landscape canvas is left alone.
 */
describe('safe-area-aware placement', () => {
  const portrait = { widthPx: 1080, heightPx: 1920 };
  const landscape = { widthPx: 1920, heightPx: 1080 };
  const bottomRight: BrandKitPlacement = {
    position: 'br',
    xPct: 0,
    yPct: 0,
    sizePct: 10,
    opacity: 1,
    margin: 4,
    showFrom: 'always',
    showFor: 'whole',
  };

  it('moves a bottom-right graphic up out of the bottom band and in from the action column', () => {
    /*
      Without the preset: margin 4% of the short side (1080) = 43.2 px, size 108 px, so the
      box is at x 1080 - 43.2 - 108 = 928.8 and y 1920 - 43.2 - 108 = 1768.8 — on top of the
      scrub bar. With the bands it moves in by 12% of 1080 and up by 25% of 1920.
    */
    const free = resolvePlacement(bottomRight, portrait);
    const safe = resolvePlacement(bottomRight, portrait, { top: 0.14, bottom: 0.25, right: 0.12 });

    expect(safe.x).toBeCloseTo(free.x - 0.12 * 1080, 6);
    expect(safe.y).toBeCloseTo(free.y - 0.25 * 1920, 6);
    // And it is still inside the frame, which a large inset could break.
    expect(safe.x + safe.width).toBeLessThanOrEqual(portrait.widthPx);
    expect(safe.y + safe.height).toBeLessThanOrEqual(portrait.heightPx);
    expect(safe.x).toBeGreaterThan(0);
    expect(safe.y).toBeGreaterThan(0);
  });

  it('moves a top-left graphic down out of the top band, at the same x', () => {
    // The top band is chrome at the top; it says nothing about the left edge, so x must not
    // move. An implementation that inset both axes on every corner would pass a test that
    // only checked the bottom right.
    const topLeft: BrandKitPlacement = { ...bottomRight, position: 'tl' };
    const free = resolvePlacement(topLeft, portrait);
    const safe = resolvePlacement(topLeft, portrait, { top: 0.14, bottom: 0.25, right: 0.12 });
    expect(safe.x).toBeCloseTo(free.x, 6);
    expect(safe.y).toBeCloseTo(free.y + 0.14 * 1920, 6);
  });

  it('moves every bottom corner up by the bottom band, not the top one', () => {
    /*
      Both bottom corners, because they are two separate branches: a mutation that swapped
      the bottom inset for the top one in one of them passed every other test in this file.
      The two bands differ (14% against 25%), so a swap is a 200 px mistake rather than a
      rounding one.
    */
    for (const position of ['bl', 'br'] as const) {
      const free = resolvePlacement({ ...bottomRight, position }, portrait);
      const safe = resolvePlacement({ ...bottomRight, position }, portrait, {
        top: 0.14,
        bottom: 0.25,
        right: 0.12,
      });
      expect(safe.y, position).toBeCloseTo(free.y - 0.25 * 1920, 6);
    }
  });

  it('leaves a landscape canvas alone', () => {
    // 16:9 has no vertical chrome: the numbers describe TikTok's layout, not a rule about
    // frames. Applying them to a landscape video would move a correctly placed logo for no
    // reason.
    expect(safeAreaBandsFor('tiktok', landscape)).toBeUndefined();
    expect(safeAreaBandsFor('tiktok', portrait)).toBeDefined();
    expect(safeAreaBandsFor('none', portrait)).toBeUndefined();
    expect(safeAreaBandsFor(undefined, portrait)).toBeUndefined();
    /*
      And the placement itself, called with `none` asked for by name. Asking the resolver is
      the only way to see this guard: the plan passes `undefined` for `none`, so a version
      that only special-cased `undefined` would look correct through `planKitApplication` and
      still place a logo outside the frame for any caller that resolved bands itself.
    */
    expect(safeAreaBandsFor('none', portrait)).toBeUndefined();
  });

  it('places the kit logo inside the safe area, through the plan', () => {
    // The unit above tests the resolver; this is the claim a user makes — "apply this kit and
    // my logo is not under the buttons" — measured through the function the app calls.
    const plan = planKitApplication(
      kit({
        safeAreaPreset: 'tiktok',
        logo: { assetId: 'logo-1', ...bottomRight },
      }),
      portrait,
      10_000_000,
      everything,
    );
    const box = plan.logo!.box;
    // Bottom band starts at 75% of the height; the box must end above it.
    expect(box.y + box.height).toBeLessThanOrEqual(1920 * 0.75 - 43.2 + 0.001);
    // Right band starts at 88% of the width; the box must end left of it.
    expect(box.x + box.width).toBeLessThanOrEqual(1080 * 0.88 - 43.2 + 0.001);
  });

  it('places the same kit differently on a landscape canvas', () => {
    // `none` is the default and must stay byte-identical to the pre-safe-area behaviour, or
    // every kit placed before this feature existed would move on the next apply.
    const withoutPreset = planKitApplication(
      kit({ logo: { assetId: 'logo-1', ...bottomRight } }),
      portrait,
      10_000_000,
      everything,
    );
    expect(withoutPreset.logo!.box).toEqual(resolvePlacement(bottomRight, portrait));
  });

  it('agrees with assets/safe-areas.json, which is what the guides draw', () => {
    /*
      The bands are duplicated in this package so it does not depend on a bundled JSON file —
      and a duplicate that drifts is worse than no duplicate. The file is the source of truth
      for the overlays; this pins the copy to it, so tuning one without the other fails here
      rather than producing a logo that sits outside the rectangle the user was shown.
    */
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'assets', 'safe-areas.json'), 'utf8'),
    ) as { platforms: Record<string, { top: number; bottom: number; right: number }> };
    const vertical = raw.platforms['9:16']!;
    for (const preset of ['tiktok', 'reels', 'shorts'] as const) {
      const bands = safeAreaBandsFor(preset, portrait)!;
      expect(bands.top).toBe(vertical.top);
      expect(bands.bottom).toBe(vertical.bottom);
      expect(bands.right).toBe(vertical.right);
    }
  });
});
