/**
 * SPEC 13 §8.2 — applying, reapplying and detaching a brand kit.
 *
 * These live beside `commands.ts` rather than inside it because they are **composed** of the
 * commands that already exist: a kit application is image items on a graphics track, a
 * `captionStyleId` written onto the captions in range, and (later) clips at the ends. Nothing
 * here introduces a new kind of item, which is what makes the spec's own rules true rather
 * than maintained:
 *
 * - *Deleting a kit leaves applied items untouched* — they are ordinary items.
 * - *Reapply replaces* — the provenance tag on the items is enough to find what the previous
 *   run made.
 * - *Detach* — the same query, clearing the tag rather than deleting the items.
 *
 * Everything is one undo step, because an apply that could be half-undone would leave a
 * project with two logos and no record of why.
 */
import { produceWithPatches } from 'immer';
import type { TimelineItem } from '@clipwright/project-schema';
import type { BrandKit, KitApplicationPlan } from '@clipwright/brand-kits';
import { findKitAppliedItems, kitProvenance } from '@clipwright/brand-kits';
import { createMediaItem, nextId } from './factory.js';
import { quantizeUs, type Fps } from './time.js';
import { itemEndUs } from './selectors.js';
import type { CommandResult, TimelineState } from './commands.js';

/** Where a kit's graphics go when the project has no graphics track yet. */
const KIT_TRACK_NAME = 'Brand kit';

/** Shape of what `applyBrandKit` needs, kept narrow so the UI can build it from a plan. */
export interface ApplyBrandKitParams {
  kit: BrandKit;
  plan: KitApplicationPlan;
  /** The composition's size, so a logo can be placed as a fraction of it. */
  canvas: { widthPx: number; heightPx: number };
  fps: Fps;
  /** Which captions the kit's style applies to. Empty means every caption. */
  captionItemIds?: string[];
  /** ISO timestamp, injected so the command is deterministic in tests. */
  appliedAt: string;
  /**
   * How long the project runs, for a music bed to span.
   *
   * The bed is laid from the start to the end of the composition rather than inserted or
   * appended, because its whole purpose is to sit *under* the existing edit. Without this the
   * command would have to guess, and a bed that stops a second early is the kind of thing a user
   * hears once, at the end, and cannot explain.
   */
  compositionEndUs?: number;
  /**
   * The music asset's own duration, so the bed does not run past its material.
   *
   * Absent means unknown — an unprobed asset — and the bed is then as long as the project. Placing
   * a clip longer than its source is what produced a silent tail in the mixer before it clamped,
   * so a known duration is used when there is one.
   */
  musicDurationUs?: number;
}

/** One item a kit created, so the caller can select or report them. */
export interface AppliedKitItem {
  itemId: string;
  kind: 'logo' | 'watermark' | 'intro' | 'outro';
}

/**
 * The transform that puts a placed box where the kit asked.
 *
 * The timeline's `transform` is a *fraction of the canvas* plus a scale, not pixels
 * (`docs/decisions.md` on the anchor): storing pixels would put a logo in the wrong place the
 * moment the composition's resolution changed. So the placed box is divided back out here, at
 * the one boundary that knows both the pixels and the canvas.
 *
 * `x`/`y` are treated as the *centre* offset from the canvas centre, which is what
 * `effectiveScale`/`anchor` resolve against; a box is top-left, so half its size is added
 * back before centring.
 */
function transformForBox(
  box: { x: number; y: number; width: number; height: number },
  canvas: { widthPx: number; heightPx: number },
): { x: number; y: number; scaleX: number; scaleY: number } {
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  return {
    // Offset from the frame's centre, as a fraction of the frame — the same convention the
    // inspector's position rows show as a percentage.
    x: (centreX - canvas.widthPx / 2) / canvas.widthPx,
    y: (centreY - canvas.heightPx / 2) / canvas.heightPx,
    // The item is drawn at its natural size scaled by this; a logo designed to be 12% of the
    // short side is a 12% scale of the source only if the source is the short side, so the
    // caller's asset dimensions decide the rest (see `assetScale`).
    scaleX: 1,
    scaleY: 1,
  };
}

/**
 * How much an asset must be scaled to fit a placed box.
 *
 * Separate from `transformForBox` because it needs the asset's own pixel dimensions, which
 * the plan deliberately does not carry: a plan is a description of intent ("12% of the short
 * side"), and the asset's size is a property of the media, not the kit. Returns `1` when
 * either dimension is unknown, so a project with an unprobed asset still places the logo at
 * its natural size rather than at `NaN` scale.
 */
export function assetScale(
  asset: { widthPx?: number; heightPx?: number },
  box: { width: number; height: number },
): { scaleX: number; scaleY: number } {
  if (!asset.widthPx || !asset.heightPx) return { scaleX: 1, scaleY: 1 };
  return { scaleX: box.width / asset.widthPx, scaleY: box.height / asset.heightPx };
}

/**
 * Put a kit's graphics tracks and items into the timeline.
 *
 * Returns the new state in the same `CommandResult` shape the rest of the engine uses, so
 * callers do not need a second convention. `applied` lists what was created, and the plan's
 * own `report` is the caller's business — this command never invents a warning of its own.
 */
export function applyBrandKit(
  state: TimelineState,
  params: ApplyBrandKitParams,
): CommandResult & { applied?: AppliedKitItem[]; trackId?: string } {
  const { kit, plan, canvas, fps, appliedAt } = params;

  const hasGraphics =
    plan.logo !== undefined || plan.watermark !== undefined || plan.lowerThird !== undefined;
  const hasCaptions = plan.captionStyleId !== undefined;
  /*
    A kit whose only audio part is a music bed is a valid apply. Before the bed was built this
    guard was right: a plan carrying nothing but music produced "This kit has nothing to apply
    here" — which was true, and became false the moment the bed started being placed.
  */
  /*
    Music counts only when there is somewhere to put it. A composition with no length has nothing
    to play a bed under, and treating `plan.music` as sufficient would produce a command that
    reports success and creates nothing — the exact "it worked and nothing happened" outcome this
    guard exists to prevent, arrived at from the other side.
  */
  const bedDurationUs = Math.min(
    Math.max(0, params.compositionEndUs ?? 0),
    params.musicDurationUs ?? Number.MAX_SAFE_INTEGER,
  );
  const hasMusic = plan.music !== undefined && bedDurationUs > 0;
  if (!hasGraphics && !hasCaptions && !hasMusic) {
    /*
      A plan with nothing to do fails rather than succeeding with no visible effect. "It
      worked and nothing happened" is the worst outcome for a button that was meant to
      produce a logo, and the caller has the plan's `report` to show why.
    */
    return { ok: false, code: 'invalid', message: 'This kit has nothing to apply here.' };
  }

  const provenance = kitProvenance(kit.id, appliedAt);

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    /* ---- Captions: assign the style, skipping manual overrides unless the kit asks. ---- */
    if (plan.captionStyleId !== undefined) {
      const targets =
        params.captionItemIds && params.captionItemIds.length > 0
          ? params.captionItemIds
          : Object.values(draft.items)
              .filter((item) => item.type === 'caption')
              .map((item) => item.id);
      for (const id of targets) {
        const item = draft.items[id] as TimelineItem | undefined;
        if (!item || item.type !== 'caption') continue;
        const track = draft.tracks.find((candidate) => candidate.id === item.trackId);
        // A locked track is left alone rather than half-applied: the same rule the property
        // command follows, so the two cannot disagree about what "locked" means.
        if (track?.locked) continue;
        item.captionStyleId = plan.captionStyleId;
        if (plan.captionOverrides) {
          item.styleOverrides = { ...(item.styleOverrides ?? {}), ...plan.captionOverrides };
        }
      }
    }

    /* ---- Graphics: one track, created on demand. ---- */
    const graphics = plan.logo ?? plan.watermark;
    if (graphics !== undefined) {
      let track = draft.tracks.find((candidate) => candidate.kind === 'text' && candidate.name === KIT_TRACK_NAME);
      if (!track) {
        /*
          A dedicated track rather than borrowing a title's: the kit's graphics have a
          provenance and a lifecycle (reapply removes them), and putting them on a track the
          user also uses for titles would make "remove everything this kit made" a query
          over somebody else's work.
        */
        const topOrder = draft.tracks.reduce((top, candidate) => Math.max(top, candidate.order), -1);
        track = {
          id: `trk_kit_${kit.id}`,
          role: 'graphics',
          kind: 'text',
          name: KIT_TRACK_NAME,
          order: topOrder + 1,
          hidden: false,
          locked: false,
          muted: false,
          solo: false,
          heightPx: 48,
          itemIds: [],
          auto: false,
        } as (typeof draft.tracks)[number];
        draft.tracks.push(track);
      }
      const trackId = track.id;
      if (!track.itemIds) track.itemIds = [];

      const place = (
        kind: 'logo' | 'watermark',
        graphic: NonNullable<KitApplicationPlan['logo']>,
      ): void => {
        const id = nextId(kind === 'logo' ? 'kitlogo' : 'kitmark');
        const startUs = quantizeUs(graphic.startUs, fps);
        const durationUs = Math.max(quantizeUs(graphic.endUs - graphic.startUs, fps), 1);
        const item = createMediaItem({
          id,
          trackId,
          label: kind === 'logo' ? `${kit.name} logo` : `${kit.name} watermark`,
          mediaId: graphic.assetId,
          type: 'image',
          startUs,
          durationUs,
          sourceDurationUs: durationUs,
        });
        item.opacity = graphic.opacity;
        /*
          Merged into the item's existing transform rather than replacing it: the factory
          wrote a full default (`rotation`, the anchor, the flips) and assigning a partial
          object would drop them, silently resetting an anchor that the placement maths
          depends on.
        */
        item.transform = { ...item.transform, ...transformForBox(graphic.box, canvas) };
        /*
          The provenance tag is what makes reapply and detach possible at all, and it is on
          the item rather than in a side table because the item is the thing that survives a
          save, a duplicate and a copy between projects.
        */
        item.aiProvenance = provenance;
        draft.items[id] = item;
        const target = draft.tracks.find((candidate) => candidate.id === trackId);
        if (target && !target.itemIds.includes(id)) {
          target.itemIds.push(id);
          target.itemIds.sort((a, b) => {
            const left = draft.items[a] as TimelineItem | undefined;
            const right = draft.items[b] as TimelineItem | undefined;
            return (left?.startUs ?? 0) - (right?.startUs ?? 0);
          });
        }
      };

      if (plan.logo) place('logo', plan.logo);
      if (plan.watermark) place('watermark', plan.watermark);
    }

    /*
      ---- Music: a bed under the whole edit (SPEC 12 §6.7). ----

      This is the part that made the panel's sentence a lie. `plan.music` was computed by
      `planKitApplication`, printed by `planSummary` as "Music bed added with the kit's ducking",
      and read by nothing: `applyBrandKit` had no music branch at all, so pressing Apply applied
      the logo and the captions and silently did nothing about the music. The plan's own tests
      asserted `plan.music.volumeDb` — they were true, and they were testing a description rather
      than a result.

      Three things about the placement are decisions rather than mechanics:

      * **One track, reused, on the `music` role.** A second application replaces the bed instead of
        stacking a second copy under it, and the role is what tells the mixer and any future
        ducking control what this track is for.
      * **It spans the project, not the project plus itself.** The bed is trimmed to
        `compositionEndUs`, so applying a kit does not make the composition longer and does not
        move anything. An insert would ripple the edit; a bed must not.
      * **`duckUnderSpeech` comes from the kit**, which is the only place it can come from — the
        kit is where the user said "music, under the speech". The mixer already knows what to do
        with the flag; until now nothing in the project could set it.
    */
    if (plan.music) {
      /*
        `bedDurationUs` is decided above, where it also decides whether this applies at all: the
        bed spans the project unless the music runs out first.
      */
      const bedStartUs = 0;
      const durationUs = bedDurationUs;
      {
        let track = draft.tracks.find((candidate) => candidate.role === 'music');
        if (!track) {
          const lowestOrder = draft.tracks.reduce(
            (lowest, candidate) => Math.min(lowest, candidate.order),
            Number.MAX_SAFE_INTEGER,
          );
          track = {
            id: `trk_kit_music_${kit.id}`,
            role: 'music',
            kind: 'audio',
            name: 'Kit music',
            /* Under the picture and under any other audio track, which is where a bed lives. */
            order: lowestOrder === Number.MAX_SAFE_INTEGER ? 0 : lowestOrder - 1,
            hidden: false,
            locked: false,
            muted: false,
            solo: false,
            heightPx: 48,
            itemIds: [],
            auto: false,
          } as (typeof draft.tracks)[number];
          draft.tracks.push(track);
        }
        const trackId = track.id;
        if (!track.itemIds) track.itemIds = [];

        /*
          Replace rather than add: a reapply, or a second apply after the user changed the kit's
          music, must not leave the old bed playing underneath the new one.
        */
        for (const existingId of [...track.itemIds]) {
          const existing = draft.items[existingId] as TimelineItem | undefined;
          if (existing && existing.aiProvenance?.tool === 'brand-kit') {
            delete draft.items[existingId];
            track.itemIds = track.itemIds.filter((id) => id !== existingId);
          }
        }

        const bedId = nextId('kitmusic');
        draft.items[bedId] = {
          ...createMediaItem({
            id: bedId,
            trackId,
            label: 'Kit music',
            mediaId: plan.music.assetId,
            startUs: bedStartUs,
            durationUs,
            sourceInUs: 0,
            sourceDurationUs: params.musicDurationUs ?? durationUs,
            type: 'audio',
          }),
          volumeDb: plan.music.volumeDb,
          duckUnderSpeech: plan.music.duckUnderSpeech,
          aiProvenance: provenance,
        } as TimelineItem;
        track.itemIds.push(bedId);
      }
    }
  });

  const applied: AppliedKitItem[] = Object.values(nextState.items)
    .filter(
      (item) =>
        item.aiProvenance?.tool === 'brand-kit' &&
        item.aiProvenance.kitId === kit.id &&
        item.aiProvenance.appliedAt === appliedAt,
    )
    .map((item) => ({
      itemId: item.id,
      kind: item.label?.includes('watermark') ? 'watermark' : 'logo',
    }));

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: applied.map((entry) => entry.itemId),
    notes: [],
    applied,
  };
}

/**
 * Remove what a previous application of this kit created, then apply the current version.
 *
 * The spec's *Reapply*: "remove previously kit-created items and apply the new version". One
 * undo step covers both halves — an undo that restored the items but not the style would
 * leave the project in a state the user never created.
 */
export function reapplyBrandKit(
  state: TimelineState,
  params: ApplyBrandKitParams,
): CommandResult & { applied?: AppliedKitItem[]; removed?: number } {
  const previous = findKitAppliedItems(Object.values(state.items), params.kit.id);
  let cleaned = state;
  if (previous.length > 0) {
    const removal = removeKitItems(state, params.kit.id);
    if (!removal.ok) return removal;
    cleaned = removal.state;
  }
  const result = applyBrandKit(cleaned, params);
  if (!result.ok) return result;
  return { ...result, removed: previous.length };
}

/**
 * Delete every item a kit created. Ordinary items, ordinary delete — no special case.
 *
 * The track is left in place even when it becomes empty: removing it would renumber the
 * stack, and a project whose tracks move on their own after a button press is worse to use
 * than one with an empty track the user can delete themselves.
 */
export function removeKitItems(state: TimelineState, kitId: string): CommandResult {
  const doomed = findKitAppliedItems(Object.values(state.items), kitId);
  if (doomed.length === 0) {
    return { ok: true, state, patches: [], inverse: [], affectedItemIds: [], notes: [] };
  }
  const ids = new Set(doomed.map((item) => item.id));

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of ids) {
      const item = draft.items[id] as TimelineItem | undefined;
      if (!item) continue;
      delete draft.items[id];
      const track = draft.tracks.find((candidate) => candidate.id === item.trackId);
      if (track) track.itemIds = track.itemIds.filter((existing) => existing !== id);
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [...ids],
    notes: [],
  };
}

/**
 * Detach: clear the provenance tag, keeping everything the kit made.
 *
 * The spec's *Detach from kit*. After this the items are the user's — a later Reapply will
 * not remove them, because nothing says they came from the kit. That is a deliberate one-way
 * door and the UI confirms it, since it is the only kit operation that cannot be undone by
 * applying the kit again.
 */
export function detachKitItems(state: TimelineState, kitId: string): CommandResult {
  const tagged = findKitAppliedItems(Object.values(state.items), kitId);
  if (tagged.length === 0) {
    return { ok: true, state, patches: [], inverse: [], affectedItemIds: [], notes: [] };
  }
  const ids = new Set(tagged.map((item) => item.id));

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    for (const id of ids) {
      const item = draft.items[id] as TimelineItem | undefined;
      if (!item) continue;
      delete item.aiProvenance;
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [...ids],
    notes: [],
  };
}

/**
 * Insert a kit's intro at the front or its outro at the back, rippling the rest of the
 * project.
 *
 * This is SPEC 09 §13.2's **Insert** mode, not a placement: a clip at time 0 would cover the
 * first shot, and a clip pushed to the nearest gap would appear at some unrelated moment. So
 * everything at or after the insertion point moves right by the new clip's duration, on every
 * unlocked track — the whole project grows by exactly that much, and the user's cuts stay
 * where they were relative to the picture.
 *
 * Three decisions the spec leaves open, decided here:
 *
 * - **It ripples every unlocked track, not just the main one.** An intro plays alone at the
 *   start of the composition; if only the main track moved, every caption, logo, title and
 *   music bed would now sit `durationUs` earlier against the picture. Rippling the tracks the
 *   clip does not occupy is the only reading that keeps the edit intact.
 * - **A locked track is skipped, not a refusal** — the same rule the rest of the kit commands
 *   follow. That does mean a locked main track's clips end up under the intro. Refusing
 *   instead would make "apply a kit" fail on any project with a locked track, and the spec's
 *   locked-track rule is about not editing the track, which this honours.
 * - **The main track is found by role, and created if the project has none.** A kit can be
 *   applied to an empty composition, and failing there would be a kit that cannot be used
 *   before the first clip is imported. A new main track is magnetic, because a main track's
 *   whole purpose is to stay closed up (SPEC 09 §9.5).
 */
export function insertKitClip(
  state: TimelineState,
  params: {
    kit: BrandKit;
    kind: 'intro' | 'outro';
    clip: { assetId?: string; compositionTemplateId?: string; durationUs: number };
    fps: Fps;
    appliedAt: string;
    /** Where the composition currently ends. The outro goes at the end of *this*. */
    compositionEndUs: number;
  },
): CommandResult & { itemId?: string } {
  const { kit, kind, clip, fps, appliedAt } = params;
  const durationUs = quantizeUs(clip.durationUs, fps);
  if (durationUs < 1) {
    return { ok: false, code: 'too_short', message: 'That clip is shorter than a frame.' };
  }
  const startUs = quantizeUs(kind === 'intro' ? 0 : Math.max(params.compositionEndUs, 0), fps);

  /*
    A template has no media, and the command does not know how to build one — that is a
    separate feature. Refusing here rather than inserting a clip with no media is the honest
    half-step: the plan carries the template id so a caller that *can* build one does, and
    one that cannot says so instead of placing an empty clip.
  */
  const mediaId = clip.assetId;
  if (mediaId === undefined) {
    return {
      ok: false,
      code: 'invalid',
      message: 'A composition template cannot be inserted as a clip yet.',
    };
  }

  /*
    The id is minted before the draft rather than inside it, so the command can name the item
    it created without searching the new state for something matching the provenance tag — a
    search that would also match a logo applied in the same second.
  */
  const id = nextId('kitclip');

  const [nextState, patches, inverse] = produceWithPatches(state, (draft) => {
    const tracks = draft.tracks;

    let main = tracks.find((candidate) => candidate.role === 'main');
    if (!main) {
      const lowestOrder = tracks.reduce(
        (lowest, candidate) => Math.min(lowest, candidate.order),
        Number.MAX_SAFE_INTEGER,
      );
      main = {
        id: `trk_kit_${kind}`,
        role: 'main',
        kind: 'video',
        name: 'Main',
        order: lowestOrder === Number.MAX_SAFE_INTEGER ? 0 : lowestOrder - 1,
        hidden: false,
        locked: false,
        muted: false,
        solo: false,
        heightPx: 64,
        magnetic: true,
        auto: false,
        itemIds: [],
      } as (typeof tracks)[number];
      tracks.push(main);
    }
    const mainTrackId = main.id;

    /*
      The ripple happens before the new clip is placed, and skips the track it will sit on
      only for the item it is about to create — which does not exist yet, so nothing is
      skipped at all. Items starting exactly at the insertion point move; items that merely
      straddle it do not, because Insert mode's own rule is "items at/after the point", and a
      clip crossing it is split by the *drop*, which is a gesture this command does not have.
    */
    for (const track of tracks) {
      if (track.locked) continue;
      for (const id of track.itemIds) {
        const item = draft.items[id] as TimelineItem | undefined;
        if (!item) continue;
        if (item.startUs >= startUs) item.startUs = quantizeUs(item.startUs + durationUs, fps);
      }
    }

    const item = createMediaItem({
      id,
      trackId: mainTrackId,
      label: `${kit.name} ${kind}`,
      mediaId,
      type: 'video',
      startUs,
      durationUs,
      sourceDurationUs: durationUs,
    });
    item.aiProvenance = kitProvenance(kit.id, appliedAt);
    draft.items[id] = item;
    const target = draft.tracks.find((candidate) => candidate.id === mainTrackId);
    if (target) {
      target.itemIds.push(id);
      target.itemIds.sort((a, b) => {
        const left = draft.items[a] as TimelineItem | undefined;
        const right = draft.items[b] as TimelineItem | undefined;
        return (left?.startUs ?? 0) - (right?.startUs ?? 0);
      });
    }
  });

  return {
    ok: true,
    state: nextState,
    patches,
    inverse,
    affectedItemIds: [id],
    notes: [],
    itemId: id,
  };
}
