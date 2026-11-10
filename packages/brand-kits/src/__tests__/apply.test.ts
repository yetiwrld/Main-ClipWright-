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
