import { describe, expect, it } from 'vitest';
import { applyPatches, enablePatches } from 'immer';
import {
  CwbrandFormat,
  CwbrandFormatVersion,
  planKitApplication,
  type BrandKit,
} from '@clipwright/brand-kits';
import {
  addItem,
  addTextItem,
  applyBrandKit,
  assetScale,
  createDefaultTimeline,
  detachKitItems,
  insertKitClip,
  reapplyBrandKit,
  removeKitItems,
  createMediaItem,
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

/**
 * Intro and outro (SPEC 13 §8: "intro/outro inserted at start/end").
 *
 * The interesting claim is not that a clip appears — it is that everything else stays where
 * the user put it *relative to the picture*. These are Insert-mode tests (SPEC 09 §13.2) that
 * happen to be run by a kit.
 */
describe('insertKitClip', () => {
  function withMainClips(): TimelineState {
    const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const main = base.tracks.find((track) => track.role === 'main')!;
    let state = base;
    for (const [index, id] of ['v-1', 'v-2'].entries()) {
      const item = createMediaItem({
        id,
        trackId: main.id,
        label: id,
        mediaId: `media-${id}`,
        type: 'video',
        startUs: index * 4_000_000,
        durationUs: 4_000_000,
        sourceDurationUs: 4_000_000,
      });
      const result = addItem(state, { item, fps: 30 });
      if (!result.ok) throw new Error(result.message);
      state = result.state;
    }
    // A caption under the first second, which must move with the picture.
    const caption = addTextItem(state, { id: 'cap-1', text: 'Hello', startUs: 1_000_000, fps: 30 });
    if (!caption.ok) throw new Error(caption.message);
    return { ...caption.state, items: { ...caption.state.items, 'cap-1': { ...caption.state.items['cap-1']!, type: 'caption' } } };
  }

  const clip = { assetId: 'intro-asset', durationUs: 2_000_000 };
  const insertIntro = (state: TimelineState, overrides = {}) =>
    insertKitClip(state, {
      kit: kit(),
      kind: 'intro',
      clip,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 8_000_000,
      ...overrides,
    });

  it('puts the intro at the very start', () => {
    const result = insertIntro(withMainClips());
    if (!result.ok) throw new Error(result.message);
    const intro = result.state.items[result.itemId!]!;
    expect(intro.startUs).toBe(0);
    expect(intro.durationUs).toBe(2_000_000);
    expect(intro.mediaId).toBe('intro-asset');
    expect(intro.aiProvenance).toMatchObject({ tool: 'brand-kit', kitId: 'kit-1' });
  });

  it('pushes the whole project right by the intro, on every unlocked track', () => {
    /*
      This is the claim that matters. A new clip at 0 that did not ripple would put the intro
      *on top of* the first shot — a two-second clip covering two seconds of the user's video.
      And a ripple that moved only the main track would slide every caption and title two
      seconds earlier against the picture.
    */
    const before = withMainClips();
    const result = insertIntro(before);
    if (!result.ok) throw new Error(result.message);
    const after = result.state;

    expect(after.items['v-1']!.startUs).toBe(2_000_000);
    expect(after.items['v-2']!.startUs).toBe(6_000_000);
    expect(after.items['cap-1']!.startUs).toBe(3_000_000);
  });

  it('preserves the spacing between clips', () => {
    // The point of a ripple is the *gap* staying: a four-second gap is still four seconds.
    const result = insertIntro(withMainClips());
    if (!result.ok) throw new Error(result.message);
    const gap = result.state.items['v-2']!.startUs - (result.state.items['v-1']!.startUs + result.state.items['v-1']!.durationUs);
    expect(gap).toBe(0);
  });

  it('does not move a locked track', () => {
    const base = withMainClips();
    const captionTrack = base.tracks.find((track) => track.id === base.items['cap-1']!.trackId)!;
    const locked = {
      ...base,
      tracks: base.tracks.map((track) => (track.id === captionTrack.id ? { ...track, locked: true } : track)),
    };
    const result = insertIntro(locked);
    if (!result.ok) throw new Error(result.message);
    // The caption stays, even though that means it now sits under the intro. Skipping is the
    // rule the other kit commands follow, and refusing would fail the whole application on
    // any project with a locked track.
    expect(result.state.items['cap-1']!.startUs).toBe(1_000_000);
    // And the picture still moved, so the lock did not quietly cancel the operation.
    expect(result.state.items['v-1']!.startUs).toBe(2_000_000);
  });

  it('appends the outro after the composition end', () => {
    const result = insertKitClip(withMainClips(), {
      kit: kit(),
      kind: 'outro',
      clip: { assetId: 'outro-asset', durationUs: 3_000_000 },
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 8_000_000,
    });
    if (!result.ok) throw new Error(result.message);
    const outro = result.state.items[result.itemId!]!;
    expect(outro.startUs).toBe(8_000_000);
    expect(outro.durationUs).toBe(3_000_000);
    // Nothing moved: an outro is after everything, so there is nothing to ripple.
    expect(result.state.items['v-1']!.startUs).toBe(0);
    expect(result.state.items['v-2']!.startUs).toBe(4_000_000);
  });

  it('creates a main track when the project has none', () => {
    // A kit applied to an empty composition: refusing here would be a kit you cannot use
    // until you have imported a clip.
    const empty: TimelineState = { ...createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 }), tracks: [] };
    const result = insertIntro(empty);
    if (!result.ok) throw new Error(result.message);
    const main = result.state.tracks.find((track) => track.role === 'main');
    expect(main).toBeDefined();
    // A main track's purpose is to stay closed up, so the one the kit makes is magnetic.
    expect(main?.magnetic).toBe(true);
    expect(result.state.items[result.itemId!]?.trackId).toBe(main?.id);
  });

  it('is one undo step that puts every clip back', () => {
    // An apply that could be half-undone would leave the project with an intro inserted into
    // a timeline that had already closed up around it.
    const result = insertIntro(withMainClips());
    if (!result.ok) throw new Error(result.message);
    const undone = applyPatches(result.state, result.inverse);
    expect(undone.items['v-1']!.startUs).toBe(0);
    expect(undone.items['cap-1']!.startUs).toBe(1_000_000);
    expect(undone.items[result.itemId!]).toBeUndefined();
  });

  it('refuses rather than inserting an empty clip for a template', () => {
    const result = insertIntro(withMainClips(), {
      clip: { compositionTemplateId: 'tpl-1', durationUs: 2_000_000 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
  });
});

describe('a kit’s music bed (SPEC 12 §6.7)', () => {
  /*
    This whole block exists because the feature was *described* and not *built*. `planKitApplication`
    computed `plan.music`, `planSummary` printed "Music bed added with the kit's ducking", and
    `applyBrandKit` had no music branch at all — so pressing Apply placed the logo, applied the
    captions, and silently did nothing about the music. The brand-kits tests asserted the plan's
    contents and passed, because the plan was right; nothing asserted that an *item* came out.

    So these tests deliberately do not look at the plan. They apply a kit and look for the clip.
  */
  const musicKit = () =>
    kit({
      audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
    });

  const planFor = (value: BrandKit) =>
    planKitApplication(value, CANVAS, 10_000_000, {
      assetIds: new Set(['music-1']),
      captionStyleIds: new Set(['bold-creator']),
    });

  const base = () => createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });

  it('actually creates the bed, rather than only saying it did', () => {
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const beds = Object.values(result.state.items).filter((item) => item.mediaId === 'music-1');
    expect(beds).toHaveLength(1);
  });

  it('applies a kit whose *only* part is music', () => {
    /*
      The guard used to refuse this: a plan with music and nothing else was "nothing to apply
      here", which was honest before the bed existed and wrong the moment it did.
    */
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(result.ok).toBe(true);
  });

  it('spans the project without making it longer', () => {
    /*
      The bed sits *under* the edit: applying a kit must not move a single cut. An insert would
      ripple everything right and a longer clip than the project would change the export length.
    */
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 7_500_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bed = Object.values(result.state.items).find((item) => item.mediaId === 'music-1')!;
    expect(bed.startUs).toBe(0);
    expect(bed.durationUs).toBe(7_500_000);
  });

  it('never runs past the music it has', () => {
    /*
      A bed longer than its source is a silent tail: the mixer decodes what exists and places it,
      so a clip claiming thirty seconds over a ten-second track leaves twenty seconds of nothing
      while the timeline draws a waveform that implies otherwise.
    */
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 30_000_000,
      musicDurationUs: 10_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bed = Object.values(result.state.items).find((item) => item.mediaId === 'music-1')!;
    expect(bed.durationUs).toBe(10_000_000);
    expect(bed.sourceDurationUs).toBe(10_000_000);
  });

  it('carries the kit’s volume and ducking onto the item', () => {
    /*
      The two values that reach the mix. `duckUnderSpeech` is the one that matters most: the mixer
      has read it since it was written, so a bed arriving without it would be a bed that plays at a
      flat level under dialogue and the "ducking" in the panel's sentence would be a word.
    */
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bed = Object.values(result.state.items).find((item) => item.mediaId === 'music-1')!;
    expect(bed.volumeDb).toBe(-18);
    expect(bed.duckUnderSpeech).toBe(true);
  });

  it('does not duck when the kit says not to', () => {
    const brandKit = kit({
      audio: { musicAssetId: 'music-1', musicVolumeDb: -12, duckUnderSpeech: false },
    });
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bed = Object.values(result.state.items).find((item) => item.mediaId === 'music-1')!;
    expect(bed.duckUnderSpeech).toBe(false);
  });

  it('puts the bed on the music track, below the picture', () => {
    /* The role is what tells the mixer — and any later ducking control — what this track is. */
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bed = Object.values(result.state.items).find((item) => item.mediaId === 'music-1')!;
    const track = result.state.tracks.find((candidate) => candidate.id === bed.trackId)!;
    expect(track.role).toBe('music');
    expect(track.kind).toBe('audio');
    /*
      Below every *picture* track. `order` is the stack position and the mixer sums in that order,
      so a bed above the picture would be layered over the dialogue — the same items, the wrong
      layer.

      Not below every track: the default timeline ships `music` at −20 and `sfx` at −30, so sound
      effects are deliberately beneath a bed. Asserting against all tracks would fail for a reason
      that is right, which is the sort of expectation that gets weakened instead of understood.
    */
    const picture = result.state.tracks.filter((candidate) => candidate.kind !== 'audio');
    expect(picture.length).toBeGreaterThan(0);
    for (const other of picture) expect(track.order).toBeLessThan(other.order);
  });

  it('makes a music track when the project has none, below everything else', () => {
    /*
      The default timeline ships a `music` track, so the ordinary case *reuses* it and the
      creation branch never runs. It still has to be right: a project imported or migrated without
      a music track would otherwise put the bed wherever the new track happened to land — and the
      first version of this test asserted the ordering against the default project, where no new
      track is made at all, so it passed while testing nothing on the branch it was written for.
    */
    const brandKit = musicKit();
    const state = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const withoutMusic: TimelineState = {
      ...state,
      tracks: state.tracks.filter((candidate) => candidate.role !== 'music'),
    };
    const result = applyBrandKit(withoutMusic, {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bed = Object.values(result.state.items).find((item) => item.mediaId === 'music-1')!;
    const created = result.state.tracks.find((candidate) => candidate.id === bed.trackId)!;
    expect(created.role).toBe('music');
    expect(created.kind).toBe('audio');
    expect(created.name).toBe('Kit music');
    /* Below every picture track, and not the topmost track in the project. */
    for (const other of result.state.tracks.filter((c) => c.kind !== 'audio')) {
      expect(created.order).toBeLessThan(other.order);
    }
    const topmost = result.state.tracks.reduce((top, candidate) =>
      candidate.order > top.order ? candidate : top,
    );
    expect(topmost.id).not.toBe(created.id);
  });

  it('reuses the music track across two kits rather than making a second one', () => {
    /*
      The track is found by role for this reason: a second kit with a bed would otherwise create a
      second music track, and the two would each hold one bed with nothing to say which is live.
    */
    const first = musicKit();
    const applied = applyBrandKit(base(), {
      kit: first,
      plan: planFor(first),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const second = kit({
      id: 'kit-2',
      audio: { musicAssetId: 'music-1', musicVolumeDb: -20, duckUnderSpeech: true },
    });
    const again = applyBrandKit(applied.state, {
      kit: second,
      plan: planKitApplication(second, CANVAS, 10_000_000, {
        assetIds: new Set(['music-1']),
        captionStyleIds: new Set(['bold-creator']),
      }),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const musicTracks = again.state.tracks.filter((candidate) => candidate.role === 'music');
    expect(musicTracks).toHaveLength(1);
  });

  it('replaces the bed on reapply instead of stacking a second one', () => {
    /*
      Two beds under one edit is not merely louder: the user hears a phasing effect they cannot
      explain and has no way to see why from the timeline, because both clips look identical.
    */
    const brandKit = musicKit();
    const plan = planFor(brandKit);
    const first = applyBrandKit(base(), {
      kit: brandKit,
      plan,
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = reapplyBrandKit(first.state, {
      kit: brandKit,
      plan,
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const beds = Object.values(second.state.items).filter((item) => item.mediaId === 'music-1');
    expect(beds).toHaveLength(1);
  });

  it('replaces the bed when the same kit is applied twice, without reapply', () => {
    /*
      The path `reapplyBrandKit` does *not* cover, and the one the replacement loop exists for:
      reapply removes the kit's items first, so by the time `applyBrandKit` runs there is nothing
      to collide with and deleting the loop would pass every reapply test. A second plain apply —
      which the panel does whenever the user presses Apply again — reaches the loop with a bed
      already on the track, and must still leave exactly one.
    */
    const brandKit = musicKit();
    const plan = planFor(brandKit);
    const params = {
      kit: brandKit,
      plan,
      canvas: CANVAS,
      /* Literal-typed: `fps` is `30 | 60`, and a bare `30` widens to `number` in an object. */
      fps: 30 as const,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    };
    const first = applyBrandKit(base(), params);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyBrandKit(first.state, params);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const beds = Object.values(second.state.items).filter((item) => item.mediaId === 'music-1');
    expect(beds).toHaveLength(1);
  });

  it('is removed by removeKitItems like everything else the kit made', () => {
    /* "Delete the kit, keep its work" has to include the bed, or the music outlives its kit. */
    const brandKit = musicKit();
    const applied = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const removed = removeKitItems(applied.state, brandKit.id);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(Object.values(removed.state.items).some((item) => item.mediaId === 'music-1')).toBe(false);
  });

  it('undoes the bed along with the rest, in one step', () => {
    /*
      An undo that restored the logo and left the music playing would be worse than no undo: the
      project would be in a state the user never created and cannot describe.
    */
    const brandKit = kit({
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 12, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
      audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
    });
    const plan = planKitApplication(brandKit, CANVAS, 10_000_000, {
      assetIds: new Set(['logo-1', 'music-1']),
      captionStyleIds: new Set(['bold-creator']),
    });
    const state = base();
    const applied = applyBrandKit(state, {
      kit: brandKit,
      plan,
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 10_000_000,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const undone = applyPatches(applied.state, applied.inverse);
    expect(Object.keys(undone.items)).toEqual(Object.keys(state.items));
  });

  it('does not add a zero-length bed to an empty project', () => {
    /*
      A composition with no length has nothing to play music under. A one-frame sliver would draw
      on the timeline, cost a decode, and mean nothing.
    */
    const brandKit = musicKit();
    const result = applyBrandKit(base(), {
      kit: brandKit,
      plan: planFor(brandKit),
      canvas: CANVAS,
      fps: 30,
      appliedAt: APPLIED_AT,
      compositionEndUs: 0,
    });
    /*
      There is nothing to apply at all now, so the command refuses rather than succeeding with no
      effect — the same rule the guard applies to a kit with no graphics.
    */
    expect(result.ok).toBe(false);
  });
});
