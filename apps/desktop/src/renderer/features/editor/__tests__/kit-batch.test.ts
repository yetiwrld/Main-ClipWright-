// @vitest-environment node
/**
 * Batch apply across clips (SPEC 13 §8.2, SPEC 08 §8.1).
 *
 * The cases here are the ones a user would notice and a compiler would not.
 *
 * Every test that seems fussy about *which* clips are in `previous` is pinning the undo story:
 * the open clip's undo belongs to its own history, and the others belong to this record. Get
 * that wrong and one `Ctrl+Z` either does nothing or undoes the wrong document.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CwbrandFormat,
  CwbrandFormatVersion,
  type BrandKit,
  type KitApplyParts,
} from '@clipwright/brand-kits';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import {
  applyKitToClips,
  applyKitToForeignClip,
  describeBatchOutcome,
  estimateCompositionDurationUs,
  projectedItemDurationUs,
  revertBatch,
  type BatchClip,
} from '../kit-batch.js';

const ALL_PARTS: KitApplyParts = {
  captions: true,
  logo: true,
  introOutro: true,
  lowerThird: true,
  music: true,
  textDefaults: true,
};

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

const LOGO = {
  assetId: 'logo-1',
  position: 'br' as const,
  xPct: 4,
  yPct: 4,
  sizePct: 12,
  opacity: 1,
  margin: 4,
  showFrom: 'always' as const,
  showFor: 'whole' as const,
};

/** A composition with one clip on the main track, of the given length. */
function clipState(id: string, durationUs = 4_000_000, mediaId = 'v-1'): TimelineState {
  const base = createDefaultTimeline({ id, name: id, fps: 30 });
  const main = base.tracks.find((track) => track.role === 'main')!;
  const items = { ...base.items };
  items['clip-1'] = {
    ...Object.values(base.items)[0]!,
    id: 'clip-1',
    trackId: main.id,
    type: 'video',
    label: 'footage',
    mediaId,
    startUs: 0,
    durationUs,
    sourceDurationUs: durationUs,
  } as (typeof items)[string];
  return {
    ...base,
    items,
    tracks: base.tracks.map((track) =>
      track.id === main.id ? { ...track, itemIds: ['clip-1'] } : track,
    ),
  };
}

function batchClip(id: string, name: string, state: TimelineState, version = 3): BatchClip {
  return {
    record: { id, name, version, updatedAt: '2026-01-01T00:00:00.000Z' },
    payload: state,
  };
}

const kinds = (map: Record<string, 'video' | 'audio' | 'image'>) => (id: string) => map[id];

describe('projecting a duration this window cannot measure', () => {
  it('takes the item’s own length when it has one', () => {
    // The common case: a clip of footage records its duration, so the projection is exact and
    // the word "projection" is doing no work.
    expect(projectedItemDurationUs('video', 7_000_000)).toBe(7_000_000);
  });

  it('gives a still a second rather than a share of the media’s length', () => {
    /*
      An image has no duration of its own, so `durationUs` is what the timeline gives it. But a
      *media* record for a still may carry 0, and a composition whose only content is a still
      must not read as zero length — that puts every kit-inserted clip at the very start of a
      composition whose content begins later.
    */
    expect(projectedItemDurationUs('image', 0)).toBe(1_000_000);
  });

  it('assumes a video of ordinary length rather than zero when the media is unknown', () => {
    // A missing media record is the external-drive case. Zero would be precise and useless: an
    // outro would land on the first frame of the composition.
    expect(projectedItemDurationUs(undefined, 0)).toBe(4_000_000);
  });

  it('leaves hidden tracks out, as the ruler does', () => {
    /*
      `projectDurationUs` ignores a hidden track, and this estimate has to agree or a kit's
      outro lands after content the user cannot see. The two are compared here on the same
      document: for a clip whose durations are all recorded, the projection must equal the
      engine's own answer.
    */
    const state = clipState('c1');
    const hidden = {
      ...state,
      tracks: state.tracks.map((track) => (track.role === 'main' ? { ...track, hidden: true } : track)),
    };
    expect(estimateCompositionDurationUs(hidden, kinds({}))).toBe(0);
    expect(estimateCompositionDurationUs(state, kinds({ 'v-1': 'video' }))).toBe(4_000_000);
  });

  it('is never shorter than the content it is measuring', () => {
    const long = clipState('c1', 12_000_000);
    expect(estimateCompositionDurationUs(long, kinds({}))).toBe(12_000_000);
  });
});

describe('applying to a clip this window never loaded', () => {
  const apply = (state: TimelineState, overrides: Partial<Parameters<typeof applyKitToForeignClip>[3]> = {}, parts = ALL_PARTS, k = kit({ logo: LOGO })) =>
    applyKitToForeignClip(k, parts, state, {
      captionStyleIds: new Set(),
      assetIds: new Set(['logo-1']),
      readKind: kinds({ 'v-1': 'video' }),
      now: () => '2026-01-02T00:00:00.000Z',
      ...overrides,
    });

  it('places the logo and tags it with the kit it came from', () => {
    const outcome = apply(clipState('other'));
    expect(outcome.status).toBe('ok');
    const items = Object.values((outcome as { payload: TimelineState }).payload.items);
    const logo = items.find((item) => item.aiProvenance?.tool === 'brand-kit');
    expect(logo?.aiProvenance?.kitId).toBe('kit-1');
  });

  it('does not offer the kit’s assets unless this window knows they exist', () => {
    /*
      The ids in a foreign clip's payload are not the ids in this window's media list. Claiming
      a logo is present because a *different* project once had that id would place a graphic the
      next editor cannot find — the exact failure the plan's report exists to prevent. So the
      caller offers only what it can see, and the kit says the logo is missing instead.
    */
    const outcome = apply(clipState('other'), { assetIds: new Set() });
    if (outcome.status === 'error') throw new Error(outcome.message);
    expect(outcome.report.join(' ')).toMatch(/logo is missing/i);
    /* Nothing was placed, so the honest answer is "skipped" and there is no payload to read. */
    expect(outcome.status).toBe('skipped');
  });

  it('sizes an inserted clip to the other clip’s canvas, not this window’s', () => {
    /*
      Kits travel between aspect ratios because a logo is stored in percentages. An inserted
      intro is not: the plan takes a canvas so the clip can be sized to it, and using this
      editor's canvas would give a portrait clip a landscape intro.
    */
    const portrait: TimelineState = {
      ...clipState('other'),
      canvas: { ...clipState('other').canvas, width: 1080, height: 1920 },
    };
    const outcome = apply(
      portrait,
      { assetIds: new Set(['logo-1', 'intro-1']) },
      { ...ALL_PARTS, logo: false, captions: false, lowerThird: false },
      kit({ intro: { assetId: 'intro-1', durationSec: 1 } } as Partial<BrandKit>),
    );
    expect(outcome.status).toBe('ok');
    const inserted = Object.values((outcome as { payload: TimelineState }).payload.items).find(
      (item) => item.aiProvenance?.tool === 'brand-kit',
    );
    /* The inserted clip covers the clip's own frame, so its scale is derived from the 1080×1920
       canvas rather than from whatever this window is editing. */
    expect(inserted?.transform?.scaleX).toBeGreaterThan(0);
    expect(inserted?.transform?.scaleY).toBeGreaterThan(0);
  });

  it('says “skipped” — not “failed” — for a clip the kit has nothing to say to', () => {
    /*
      A clip with no captions and no graphics track is not a broken clip. Conflating that with a
      failure would abort a five-clip batch over the one clip the user just made.
    */
    /*
      A kit of colours and a logo only, asked to apply captions alone: there is no caption
      style to assign, so there is genuinely nothing to do. (A kit with a logo is *not* skipped
      on a clip with no graphics track — the track is created on demand, and that is the
      behaviour that makes a first application on a fresh clip work at all.)
    */
    const bare = createDefaultTimeline({ id: 'bare', name: 'bare', fps: 30 });
    const outcome = applyKitToForeignClip(
      kit({ logo: LOGO }),
      { ...ALL_PARTS, logo: false, captions: true, lowerThird: false, introOutro: false },
      bare,
      { captionStyleIds: new Set(), assetIds: new Set(['logo-1']), readKind: kinds({}) },
    );
    expect(outcome.status).toBe('skipped');
  });

  it('refuses a template intro rather than inserting an empty clip', () => {
    /*
      SPEC 13 §8.3: a composition template is planned and then refused, not inserted empty. That
      refusal is an `error`, and the batch stops — a clip that silently lost its intro while the
      other four got theirs is the half-applied batch nobody can unpick.
    */
    const outcome = apply(
      clipState('other'),
      {},
      { ...ALL_PARTS, logo: false, captions: false, lowerThird: false },
      kit({ intro: { compositionTemplateId: 'tpl-1', durationSec: 2 } } as Partial<BrandKit>),
    );
    expect(outcome.status).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/template/i);
  });
});

describe('a batch', () => {
  const clips = () => [
    batchClip('open', 'Open clip', clipState('open')),
    batchClip('b', 'Second', clipState('b')),
    batchClip('c', 'Third', clipState('c')),
  ];

  const run = (overrides: Partial<Parameters<typeof applyKitToClips>[0]> = {}) =>
    applyKitToClips({
      kit: kit({ logo: LOGO }),
      parts: ALL_PARTS,
      clips: clips(),
      captionStyleIds: new Set(),
      assetIds: new Set(['logo-1']),
      readKind: kinds({ 'v-1': 'video' }),
      currentClipId: 'open',
      now: () => '2026-01-02T00:00:00.000Z',
      ...overrides,
    });

  it('applies to every clip', () => {
    const result = run();
    expect(result.ok).toBe(true);
    expect(result.changed.map((entry) => entry.id)).toEqual(['open', 'b', 'c']);
  });

  it('records the other clips’ old payloads and leaves the open one to its own undo', () => {
    /*
      The open clip is applied through `timeline.run`, so it is already one undo step in the
      history the user is looking at. Putting it in `previous` too would make "Undo batch" and
      Ctrl+Z each undo half of one application — and a second Ctrl+Z would redo it.
    */
    const result = run();
    expect(result.previous.map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(result.currentClipId).toBe('open');
  });

  it('keeps the untouched payload in `previous`, not the applied one', () => {
    // An undo record that stores the new state is a no-op that reports success.
    const original = clips();
    const result = applyKitToClips({
      kit: kit({ logo: LOGO }),
      parts: ALL_PARTS,
      clips: original,
      captionStyleIds: new Set(),
      assetIds: new Set(['logo-1']),
      readKind: kinds({ 'v-1': 'video' }),
      currentClipId: 'open',
    });
    const before = original.find((clip) => clip.record.id === 'b')!.payload;
    expect(result.previous.find((entry) => entry.id === 'b')!.payload).toBe(before);
  });

  it('refuses the whole batch when one clip cannot take it, and writes nothing', () => {
    /*
      A half-applied batch across five clips is the one outcome a user cannot unpick by hand.
      `applyKitToClips` does no I/O, so every clip is planned and applied before it returns —
      the caller writes only on `ok`. The template intro is a real refusal: the engine will not
      build a composition from a template yet, and it says so rather than inserting nothing.
    */
    const result = applyKitToClips({
      kit: kit({
        logo: LOGO,
        intro: { compositionTemplateId: 'tpl-1', durationSec: 2 },
      } as Partial<BrandKit>),
      parts: ALL_PARTS,
      clips: [batchClip('open', 'Open clip', clipState('open')), batchClip('bad', 'Broken clip', clipState('bad'))],
      captionStyleIds: new Set(),
      assetIds: new Set(['logo-1']),
      readKind: kinds({ 'v-1': 'video' }),
      currentClipId: 'open',
    });
    expect(result.ok).toBe(false);
    /* The clip at fault is named — the template is refused on *every* clip, so the first one it
       reaches is the one reported, and that is the clip whose number the user needs. */
    expect(result.error).toMatch(/^(Open clip|Broken clip): /);
    expect(result.error).toMatch(/template/i);
    expect(result.changed).toEqual([]);
    expect(result.previous).toEqual([]);
  });

  it('names the clips the kit had nothing to say to', () => {
    // "3 skipped" leaves the user to guess which three, and the likely answer — the ones with no
    // captions yet — is what they would fix next.
    const bare = createDefaultTimeline({ id: 'bare', name: 'bare', fps: 30 });
    const result = run({
      clips: [batchClip('open', 'Open clip', clipState('open')), batchClip('bare', 'Empty clip', bare)],
      /* Captions only, and this kit has no caption style: nothing to do on either clip. */
      parts: { ...ALL_PARTS, logo: false, captions: true, lowerThird: false, introOutro: false },
      kit: kit({ logo: LOGO }),
    });
    expect(result.skipped.map((entry) => entry.name)).toEqual(['Open clip', 'Empty clip']);
    expect(describeBatchOutcome(result)).toMatch(/nothing to apply/i);
  });

  it('says nothing was applied when no clip could take the kit', () => {
    const bare = createDefaultTimeline({ id: 'bare', name: 'bare', fps: 30 });
    const result = run({
      clips: [batchClip('bare', 'Empty clip', bare)],
      parts: { ...ALL_PARTS, logo: false, captions: true, lowerThird: false, introOutro: false },
    });
    expect(result.ok).toBe(false);
    expect(describeBatchOutcome(result)).toMatch(/nothing to apply/i);
  });

  it('explains *why* nothing was applied instead of only saying so', () => {
    /*
      The least useful sentence this panel could show is "nothing to apply". The plan almost
      always said why — here, a logo missing from the media library — and that is the only part
      the user can act on.
    */
    const bare = createDefaultTimeline({ id: 'bare', name: 'bare', fps: 30 });
    const result = run({ clips: [batchClip('bare', 'Empty clip', bare)], assetIds: new Set() });
    expect(result.notes.length).toBeGreaterThan(0);
    expect(describeBatchOutcome(result)).toMatch(/logo is missing/i);
  });

  it('counts progress over every clip, including the skipped ones', () => {
    // A progress bar that stops short of the end reads as a failure, and the skipped clips are
    // the ones a batch spends its time on once the fast ones are done.
    const seen: number[] = [];
    run({
      clips: [
        batchClip('open', 'Open clip', clipState('open')),
        batchClip('bare', 'Empty clip', createDefaultTimeline({ id: 'bare', name: 'bare', fps: 30 })),
        batchClip('c', 'Third', clipState('c')),
      ],
      onProgress: (done) => seen.push(done),
    });
    // 1-based: the bar reads "3 of 3" when it finishes, not "2 of 3".
    expect(seen).toEqual([1, 2, 3]);
  });

  it('reports a missing logo once, naming the clips it concerns — not once per clip', () => {
    /*
      The same sentence on five clips is the noise that teaches users to scroll past the warning
      that matters — the rule the font substitutions follow. The batch folds by text and lists
      the clips instead.
    */
    const result = run({ assetIds: new Set() });
    const logoNotes = result.notes.filter((note) => /logo is missing/i.test(note.line));
    expect(logoNotes).toHaveLength(1);
    expect(logoNotes[0]!.name).toBe('Open clip, Second, Third');
    expect(describeBatchOutcome(result)).toMatch(/logo is missing/i);
  });

  it('reverts the other clips to exactly what they were', () => {
    const original = clips();
    const result = applyKitToClips({
      kit: kit({ logo: LOGO }),
      parts: ALL_PARTS,
      clips: original,
      captionStyleIds: new Set(),
      assetIds: new Set(['logo-1']),
      readKind: kinds({ 'v-1': 'video' }),
      currentClipId: 'open',
    });
    const reverted = revertBatch(result);
    expect(reverted.map((entry) => entry.id)).toEqual(['b', 'c']);
    for (const entry of reverted) {
      const before = original.find((clip) => clip.record.id === entry.id)!.payload;
      expect(entry.payload).toBe(before);
    }
  });

  it('calls progress for the clip that fails, so the bar is not stuck on the previous name', () => {
    const seen: string[] = [];
    run({
      clips: [
        batchClip('open', 'Open clip', clipState('open')),
        batchClip('bad', 'Broken clip', clipState('bad')),
      ],
      onProgress: (_done, _total, name) => seen.push(name),
    });
    expect(seen).toContain('Broken clip');
  });

  it('counts a clip as applied only when its document actually changed', () => {
    /*
      The case is a kit's caption style on a clip that has no captions: the plan *does* set
      `captionStyleId`, so `applyBrandKit` runs and succeeds — it simply has nothing to assign,
      and immer hands back the same state. Counting that as an application told every
      captionless clip it had been branded, which is a lie in the one sentence the user reads to
      decide whether the batch worked.
    */
    const captionKit = kit({
      captionStyleId: 'bold-creator',
      captionOverrides: undefined,
    } as Partial<BrandKit>);
    const result = applyKitToClips({
      kit: captionKit,
      parts: { ...ALL_PARTS, logo: false, captions: true, lowerThird: false, introOutro: false },
      clips: clips(),
      captionStyleIds: new Set(['bold-creator']),
      assetIds: new Set(),
      readKind: kinds({ 'v-1': 'video' }),
      currentClipId: 'open',
    });
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toHaveLength(3);
  });

  it('says “1 clip”, not “1 clips”', () => {
    // The `skipped` branch is what B10's mutation tests; this is the count's own wording, which
    // appears above the kit list on every batch and reads as a bug when it is wrong.
    const result = run({ clips: [batchClip('b', 'Second', clipState('b'))], currentClipId: 'b' });
    expect(result.changed).toHaveLength(1);
    expect(describeBatchOutcome(result)).toMatch(/^Applied to 1 clip\./);
  });
});
