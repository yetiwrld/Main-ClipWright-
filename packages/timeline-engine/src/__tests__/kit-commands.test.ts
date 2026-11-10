import { describe, expect, it } from 'vitest';
import { applyPatches, enablePatches } from 'immer';
import {
  CwbrandFormat,
  CwbrandFormatVersion,
  planKitApplication,
  type BrandKit,
} from '@clipwright/brand-kits';
import {
  addTextItem,
  applyBrandKit,
  assetScale,
  createDefaultTimeline,
  detachKitItems,
  reapplyBrandKit,
  removeKitItems,
  type TimelineState,
} from '../index.js';

enablePatches();

/**
 * Applying a brand kit (SPEC 13 §8.2).
 *
 * The claims are the spec's own, stated as consequences: an application is ordinary items,
 * reapply replaces rather than duplicates, detach hands the items to the user for good, and
 * deleting a kit leaves everything it made standing. Each is true here because of *how* the
 * items are made, not because of a table that tracks them — which is what these tests check.
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

const CANVAS = { widthPx: 1920, heightPx: 1080 };
const APPLIED_AT = '2026-01-01T00:00:00.000Z';

function stateWithCaptions(): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  let state = base;
  for (const [index, id] of ['cap-1', 'cap-2'].entries()) {
    const result = addTextItem(state, {
      id,
      text: `Line ${index}`,
      startUs: index * 2_000_000,
      fps: 30,
    });
    if (!result.ok) throw new Error(result.message);
    state = result.state;
    // `addTextItem` makes a text item; the kit's caption work applies to captions, so the
    // type is set here rather than adding a caption-building fixture this file does not need.
    state = { ...state, items: { ...state.items, [id]: { ...state.items[id]!, type: 'caption' } } };
  }
  return state;
}

/** The plan for a kit with a logo, against a project that has its asset. */
function logoPlan(kitValue: BrandKit, available = ['logo-1']) {
  return planKitApplication(
    kitValue,
    CANVAS,
    10_000_000,
    { assetIds: new Set(available), captionStyleIds: new Set(['bold-creator']) },
  );
}

describe('applyBrandKit', () => {
  it('creates an ordinary image item for the logo, on its own track', () => {
    /*
      "Ordinary" is the whole design: the item is a `media` item of type `image`, which the
      renderers and the exporter already know how to draw. Nothing sets a flag that means
      "this is a brand kit logo".
    */
    const brandKit = kit({
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
    });
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = Object.values(result.state.items).filter((item) => item.mediaId === 'logo-1');
    expect(items).toHaveLength(1);
    const logo = items[0]!;
    expect(logo.type).toBe('image');
    expect(logo.aiProvenance).toMatchObject({ tool: 'brand-kit', kitId: 'kit-1', appliedAt: APPLIED_AT });
    /*
      And it reached a track of its own, or it would exist and draw nowhere. Names matter
      here: the track is what a user selects and deletes, so it has to be findable, and it
      must not be a track they also use for titles.
    */
    const track = result.state.tracks.find((candidate) => candidate.itemIds.includes(logo.id));
    expect(track).toBeDefined();
    expect(track?.name).toBe('Brand kit');
    expect(track?.role).toBe('graphics');
  });

  it('positions the logo in the bottom right, as a fraction of the canvas', () => {
    /*
      The transform is a fraction of the canvas, not pixels — the same convention the
      inspector shows as a percentage. A logo at the bottom-right of a 1920×1080 frame has its
      centre about a quarter of the width right of centre and about a half of the height down
      from centre; the exact numbers come from `resolvePlacement` and are asserted here so a
      unit slip (pixels stored as fractions, or vice versa) cannot pass.
    */
    const brandKit = kit({
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
    });
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    const logo = Object.values(result.state.items).find((item) => item.mediaId === 'logo-1')!;

    // Placed box: x 1747.2, y 907.2, 129.6 square. Centre = (1812, 972).
    // Offset from the frame centre (960, 540) = (852, 432); as fractions: 0.44375, 0.4.
    expect(logo.transform.x).toBeCloseTo(852 / 1920, 5);
    expect(logo.transform.y).toBeCloseTo(432 / 1080, 5);
  });

  it('writes the logo opacity from the kit', () => {
    const brandKit = kit({
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 0.35, margin: 4, showFrom: 'always', showFor: 'whole' },
    });
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    const logo = Object.values(result.state.items).find((item) => item.mediaId === 'logo-1')!;
    expect(logo.opacity).toBeCloseTo(0.35, 6);
  });

  it('leaves a text item that is not a caption alone', () => {
    // A title is not a caption, and restyling every text item on the timeline because the
    // kit was applied would overwrite titles the user wrote by hand.
    const brandKit = kit({ captionStyleId: 'bold-creator' });
    const withText = addTextItem(stateWithCaptions(), { id: 'title-1', text: 'Intro', startUs: 0, fps: 30 });
    if (!withText.ok) throw new Error(withText.message);
    const result = applyBrandKit(withText.state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['title-1']?.captionStyleId).toBeUndefined();
    // And the captions still got it, so the test above is not passing for a trivial reason.
    expect(result.state.items['cap-1']?.captionStyleId).toBe('bold-creator');
  });

  it('skips an explicitly named item that is not a caption', () => {
    /*
      `captionItemIds` comes from the UI's selection, and a selection can contain anything —
      a title, a shape, a clip. The named list is a *request*, not a promise: an id that is
      not a caption is ignored, so a stray selection cannot become a stray caption style.
    */
    const brandKit = kit({ captionStyleId: 'bold-creator' });
    const withText = addTextItem(stateWithCaptions(), { id: 'title-1', text: 'Intro', startUs: 0, fps: 30 });
    if (!withText.ok) throw new Error(withText.message);
    const result = applyBrandKit(withText.state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      captionItemIds: ['cap-1', 'title-1'],
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['cap-1']?.captionStyleId).toBe('bold-creator');
    expect(result.state.items['title-1']?.captionStyleId).toBeUndefined();
    // And the caption that was not named is untouched, so the named list is honoured.
    expect(result.state.items['cap-2']?.captionStyleId).toBeUndefined();
  });

  it('assigns the caption style to the captions in range', () => {
    const brandKit = kit({ captionStyleId: 'bold-creator' });
    const state = stateWithCaptions();
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['cap-1']?.captionStyleId).toBe('bold-creator');
    expect(result.state.items['cap-2']?.captionStyleId).toBe('bold-creator');
  });

  it('leaves a caption on a locked track alone', () => {
    /*
      The same rule `setItemProperties` follows, so the two cannot disagree about what
      "locked" means: a locked track is not written to, and the operation does not fail for
      everything else because of it.
    */
    const brandKit = kit({ captionStyleId: 'bold-creator' });
    let state = stateWithCaptions();
    const captionTrack = state.tracks.find((candidate) => candidate.id === state.items['cap-1']!.trackId)!;
    state = {
      ...state,
      tracks: state.tracks.map((candidate) =>
        candidate.id === captionTrack.id ? { ...candidate, locked: true } : candidate,
      ),
    };
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['cap-1']?.captionStyleId).toBeUndefined();
  });

  it('refuses a plan with nothing to do rather than reporting success', () => {
    // "It worked and nothing happened" is the worst outcome for a button meant to place a
    // logo, so an empty plan is a failure the caller can explain.
    const brandKit = kit();
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    expect(result.ok).toBe(false);
  });

  it('is one undo step', () => {
    const brandKit = kit({
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
    });
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    const undone = applyPatches(result.state, result.inverse);
    expect(Object.values(undone.items).some((item) => item.mediaId === 'logo-1')).toBe(false);
    // The track the apply created goes too, or the undo leaves an empty "Brand kit" row.
    expect(undone.tracks.some((track) => track.name === 'Brand kit')).toBe(false);
  });

  it('places a logo and a watermark as two items', () => {
    const brandKit = kit({
      logo: { assetId: 'logo-1', position: 'tl', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
      watermark: { assetId: 'mark-1', position: 'br', xPct: 4, yPct: 4, sizePct: 30, opacity: 0.3, margin: 4, showFrom: 'always', showFor: 'whole' },
    });
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit, ['logo-1', 'mark-1']),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    expect(Object.values(result.state.items).filter((item) => item.mediaId === 'logo-1')).toHaveLength(1);
    expect(Object.values(result.state.items).filter((item) => item.mediaId === 'mark-1')).toHaveLength(1);
    // The report says which kind each is, so a UI can select them separately.
    expect(result.applied?.map((entry) => entry.kind).sort()).toEqual(['logo', 'watermark']);
  });
});

describe('reapplyBrandKit', () => {
  const withLogo = () =>
    kit({
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
    });

  it('replaces the previous application instead of adding a second logo', () => {
    /*
      The failure this guards: applying twice leaving two logos on top of each other, which
      looks like a rendering bug and is really a bookkeeping one.
    */
    const brandKit = withLogo();
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const first = applyBrandKit(state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!first.ok) throw new Error(first.message);

    const second = reapplyBrandKit(first.state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: '2026-02-02T00:00:00.000Z',
    });
    if (!second.ok) throw new Error(second.message);

    expect(Object.values(second.state.items).filter((item) => item.mediaId === 'logo-1')).toHaveLength(1);
    expect(second.removed).toBe(1);
  });

  it('does not touch items another kit made', () => {
    // Two kits on one project must not remove each other's work.
    const brandKit = withLogo();
    const other = { ...kit({ name: 'Other' }), id: 'kit-2', logo: { assetId: 'logo-2', position: 'tl', xPct: 4, yPct: 4, sizePct: 10, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' } } as BrandKit;

    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const a = applyBrandKit(state, { kit: brandKit, plan: logoPlan(brandKit), canvas: CANVAS, fps: 30, appliedAt: APPLIED_AT });
    if (!a.ok) throw new Error(a.message);
    const b = applyBrandKit(a.state, {
      kit: other,
      plan: logoPlan(other, ['logo-1', 'logo-2']),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!b.ok) throw new Error(b.message);

    const reapplied = reapplyBrandKit(b.state, {
      kit: brandKit,
      plan: logoPlan(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: '2026-03-03T00:00:00.000Z',
    });
    if (!reapplied.ok) throw new Error(reapplied.message);
    expect(Object.values(reapplied.state.items).filter((item) => item.mediaId === 'logo-2')).toHaveLength(1);
    expect(Object.values(reapplied.state.items).filter((item) => item.mediaId === 'logo-1')).toHaveLength(1);
    // One item replaced, not two: the other kit's logo was never a candidate for removal,
    // and a count of 2 would mean the UI told the user something untrue about an undo.
    expect(reapplied.removed).toBe(1);
  });
});

describe('removeKitItems and detachKitItems', () => {
  const brandKit = () =>
    kit({ logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' } });

  const applied = () => {
    const value = brandKit();
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = applyBrandKit(state, {
      kit: value,
      plan: logoPlan(value),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
    });
    if (!result.ok) throw new Error(result.message);
    return result.state;
  };

  it('removes exactly what the kit made, and forgets it on its track', () => {
    const state = applied();
    const result = removeKitItems(state, 'kit-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.values(result.state.items).filter((item) => item.mediaId === 'logo-1')).toHaveLength(0);
    /*
      A track that still lists a deleted id is the kind of bug that shows up much later, as a
      selection that cannot be cleared or an export that skips a gap. The ids are checked
      against the item map, so a dangling reference of any kind fails here.
    */
    for (const track of result.state.tracks) {
      for (const id of track.itemIds) expect(result.state.items[id]).toBeDefined();
    }
  });

  it('removes nothing when the kit was never applied', () => {
    // Not an error: removing a kit from a project that never had it is a no-op the UI can
    // offer without guarding.
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const result = removeKitItems(state, 'kit-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toHaveLength(0);
  });

  it('detach keeps the items and clears the tag', () => {
    /*
      The spec's *Detach from kit*, and a deliberately one-way door: after this a reapply
      will not remove the items, because nothing says they came from the kit. Kept and
      asserted because it is the only kit operation that applying the kit again cannot undo.
    */
    const state = applied();
    const result = detachKitItems(state, 'kit-1');
    if (!result.ok) throw new Error(result.message);
    const logo = Object.values(result.state.items).find((item) => item.mediaId === 'logo-1');
    expect(logo).toBeDefined();
    expect(logo?.aiProvenance).toBeUndefined();
  });

  it('a detached item survives a later reapply', () => {
    // The consequence of the one-way door, measured rather than described.
    const brandKitValue = brandKit();
    const detached = detachKitItems(applied(), 'kit-1');
    if (!detached.ok) throw new Error(detached.message);
    const result = reapplyBrandKit(detached.state, {
      kit: brandKitValue,
      plan: logoPlan(brandKitValue),
      canvas: CANVAS,
      fps: 30,
      appliedAt: '2026-04-04T00:00:00.000Z',
    });
    if (!result.ok) throw new Error(result.message);
    /*
      Two logos now: the detached original, which is the user's, and the new one. That is
      correct rather than a bug — detaching means "this one is mine", so a later apply adds
      its own alongside it.
    */
    expect(Object.values(result.state.items).filter((item) => item.mediaId === 'logo-1')).toHaveLength(2);
  });
});

describe('assetScale', () => {
  it('scales an asset to fill its placed box', () => {
    expect(assetScale({ widthPx: 1000, heightPx: 500 }, { width: 200, height: 100 })).toEqual({
      scaleX: 0.2,
      scaleY: 0.2,
    });
  });

  it('returns unity when the asset has no probed size', () => {
    // A project whose asset has not been probed still places the logo at its natural size,
    // rather than at NaN or at zero — both of which draw nothing and look like a missing logo.
    expect(assetScale({}, { width: 200, height: 100 })).toEqual({ scaleX: 1, scaleY: 1 });
    expect(assetScale({ widthPx: 0, heightPx: 0 }, { width: 200, height: 100 })).toEqual({ scaleX: 1, scaleY: 1 });
  });
});
