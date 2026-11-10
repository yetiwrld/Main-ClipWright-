/**
 * Applying one brand kit to **several clips** (SPEC 13 §8.2 "Apply kit to: This clip ·
 * Selected clips · All clips", SPEC 08 §8.1 batch apply).
 *
 * Every decision in this file is about *distance*: the other clips are separate composition
 * documents that the open editor does not hold, so anything applied here has to be answered
 * with what the open document can prove and nothing else. That produces three rules worth
 * stating, because each one is where the obvious implementation goes wrong.
 *
 * 1. **A batch costs one undo press.** The open clip's application goes through `timeline.run`
 *    like any other edit, so it is one undo step. The *other* clips have no undo history loaded
 *    in this window — their history belongs to whichever editor opens them next — so the batch
 *    records what it overwrote and offers "Undo batch". Without that the honest option would be
 *    to refuse batch apply entirely, which is not what the spec asks for; silently making the
 *    change with no way back is worse than either.
 *
 * 2. **Another clip's length is projected, never measured.** The engine works out an intro or
 *    outro's placement from the composition's own duration and the footer can shift everything
 *    after it. Computing that for a document we cannot see would need a copy of the placement
 *    maths that could drift from the one the next editor uses. `projectedDurationUs` instead
 *    uses a deliberately conservative over-estimate from the media the items name, so an outro
 *    lands at or after the content rather than on top of it. The next editor re-plans with the
 *    real duration anyway — this figure only has to be good enough to *place* the item, not to
 *    describe the finished clip.
 *
 * 3. **Nothing is written before every clip has been checked.** A batch is prepared completely —
 *    each clip's plan, its projected duration — and a clip that cannot be written makes the
 *    batch refuse and say why. A half-applied batch across five clips is the one outcome a user
 *    cannot unpick by hand.
 */
import {
  planKitApplication,
  type BrandKit,
  type KitApplyParts,
} from '@clipwright/brand-kits';
import type { CompositionRecord } from '@clipwright/project-schema/schemas';
import {
  applyBrandKit,
  insertKitClip,
  type TimelineState,
} from '@clipwright/timeline-engine';

/** What the open editor can answer about the media its clips reference. */
export type MediaKindReader = (assetId: string) => 'video' | 'audio' | 'image' | undefined;

/**
 * How long a clip is, to the nearest the reader can say.
 *
 * An image has no length of its own, so a still is given a second: enough to place a logo at a
 * meaningful instant and short enough that an outro built from it lands immediately after
 * rather than a minute away. An unknown asset is treated as a video of average length for the
 * same reason — the alternative is zero, which would put every kit-inserted clip at the very
 * start of a composition whose content begins later.
 */
export function projectedItemDurationUs(
  kind: 'video' | 'audio' | 'image' | undefined,
  sourceDurationUs: number,
): number {
  if (sourceDurationUs > 0) return sourceDurationUs;
  if (kind === 'image') return 1_000_000;
  return 4_000_000;
}

/**
 * A composition's length as this window can work it out, without the engine.
 *
 * `projectDurationUs` is the ruler's own function and needs the whole document, which this
 * window has — it is used first and is always right for the clip being edited. The estimate
 * only exists for *other* clips, whose state we never hold. It over-estimates rather than
 * under-estimates: an intro's footer shifts everything after it, so a length that is slightly
 * too long puts an outro after the content instead of on top of it.
 */
export function estimateCompositionDurationUs(
  payload: TimelineState,
  readKind: MediaKindReader,
): number {
  const hidden = new Set(
    (payload.tracks ?? []).filter((track) => track.hidden).map((track) => track.id),
  );
  const itemEnds = Object.values(payload.items ?? {})
    .filter((item) => !hidden.has(item.trackId))
    .map(
      (item) =>
        item.startUs +
        (item.durationUs > 0
          ? item.durationUs
          : projectedItemDurationUs(readKind(item.mediaId ?? ''), item.sourceDurationUs ?? 0)),
    );
  return itemEnds.length > 0 ? Math.max(...itemEnds) : 0;
}

/**
 * The same work the panel does for the current clip, for a document this window never loaded.
 *
 * Returns a **discriminated** answer rather than a state-or-null, because a batch has to tell
 * three outcomes apart that a nullable return flattens into one:
 *
 * - `ok` — something was placed.
 * - `skipped` — the plan found nothing to do here. A clip with no captions and no graphics
 *   track is not a broken clip, and aborting a five-clip batch over one is the wrong answer.
 * - `error` — a real refusal: a composition template that cannot be built as a clip yet, or a
 *   document the engine rejects. The batch stops and names the clip, because a half-applied
 *   batch is the one outcome a user cannot unpick by hand.
 */
export type ForeignClipOutcome =
  | { status: 'ok'; payload: TimelineState; report: string[] }
  | { status: 'skipped'; report: string[] }
  | { status: 'error'; message: string };

export function applyKitToForeignClip(
  kit: BrandKit,
  parts: KitApplyParts,
  payload: TimelineState,
  options: {
    captionStyleIds: ReadonlySet<string>;
    assetIds: ReadonlySet<string>;
    readKind: MediaKindReader;
    now?: () => string;
  },
): ForeignClipOutcome {
  const appliedAt = (options.now ?? (() => new Date().toISOString()))();
  /*
    The canvas is the *clip's*, not the open editor's. A kit's logo is stored in percentages —
    which is what makes it portable between aspect ratios — but an inserted intro is sized to a
    canvas, and using this window's would give a portrait clip a landscape intro.
  */
  const canvas = {
    widthPx: payload.canvas?.width ?? 1080,
    heightPx: payload.canvas?.height ?? 1920,
  };
  const plan = planKitApplication(
    kit,
    canvas,
    estimateCompositionDurationUs(payload, options.readKind),
    {
      /*
        Only the ids this window can actually see are offered. A foreign clip's payload names
        media that may not be in this window's list, and claiming an id is present because some
        other project once had it would place a graphic the next editor cannot find — the exact
        failure the plan's report exists to prevent.
      */
      assetIds: options.assetIds,
      captionStyleIds: options.captionStyleIds,
    },
    parts,
  );
  const base = { kit, plan, canvas, fps: payload.fps, appliedAt };

  let current = payload;
  let placed = false;

  const hasGraphics =
    plan.logo !== undefined || plan.watermark !== undefined || plan.lowerThird !== undefined;
  const hasCaptions = plan.captionStyleId !== undefined;
  if (hasGraphics || hasCaptions) {
    const application = applyBrandKit(current, base);
    if (!application.ok) {
      /*
        `invalid` here means exactly one thing — the plan had nothing to place — and that is
        decided above before the call, so reaching it means the plan and the command disagree.
        Either way it is not a reason to stop a batch; anything else is.
      */
      if (application.code !== 'invalid') return { status: 'error', message: application.message };
    } else if (application.state !== current) {
      /*
        Only an actual change counts. A kit with a caption style applied to a clip that has no
        captions produces no edits and an identical state, and reporting that as "applied" would
        put a lie in the batch summary for every captionless clip.
      */
      current = application.state;
      placed = true;
    }
  }

  if (parts.introOutro) {
    for (const kind of ['intro', 'outro'] as const) {
      const clip = plan[kind];
      if (!clip) continue;
      const inserted = insertKitClip(current, {
        kind,
        clip,
        fps: payload.fps,
        appliedAt,
        kit,
        compositionEndUs: estimateCompositionDurationUs(current, options.readKind),
      });
      if (inserted.ok) {
        current = inserted.state;
        placed = true;
      } else {
        /*
          Every refusal here is real, including `invalid`: `insertKitClip` answers it for a
          composition template, which it cannot build yet (SPEC 13 §8.3). Treating that as
          "nothing to do" would leave a clip with no intro while the batch reported success —
          the silent half-application this whole function exists to prevent.
        */
        return { status: 'error', message: inserted.message };
      }
    }
  }

  return placed
    ? { status: 'ok', payload: current, report: plan.report }
    : { status: 'skipped', report: plan.report };
}

/** One clip in a batch, as the panel holds it: a saved record plus its payload. */
export interface BatchClip {
  /**
   * The saved record, as `workspace:getComposition` returns it. `payload` is read out of it
   * separately because the batch replaces the state and must keep the rest of the record —
   * name, version, timestamps — intact when it writes.
   */
  record: Pick<CompositionRecord, 'id' | 'name' | 'version' | 'updatedAt'>;
  payload: TimelineState;
}

export interface ApplyKitToClipsInput {
  kit: BrandKit;
  parts: KitApplyParts;
  clips: readonly BatchClip[];
  captionStyleIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
  readKind: MediaKindReader;
  now?: () => string;
  reapply?: boolean;
  /** Called as each clip is prepared and again once it is saved, for progress. */
  onProgress?: (done: number, total: number, name: string) => void;
}

/**
 * What a batch did, in the terms the panel has to report.
 *
 * `previous` is the whole point: it carries every clip's *old* payload so the batch can be
 * undone even though the other clips never entered this window's undo history.
 */
export interface BatchApplyResult {
  ok: boolean;
  /** Why the batch did not start, when it did not. */
  error: string;
  changed: Array<{ id: string; name: string; payload: TimelineState }>;
  /** Clips the kit had nothing to say to — no captions, no graphics track. */
  skipped: Array<{ id: string; name: string }>;
  /** Clips whose planning produced a sentence (a missing logo, a font with no match). */
  notes: Array<{ name: string; line: string }>;
  previous: Array<{ id: string; name: string; payload: TimelineState }>;
  /**
   * The one clip that is already open in this editor. It is *not* in `previous` and must not
   * be saved here: its own history owns it, and writing it behind `undo`'s back would make the
   * undo stack describe a document that is no longer on disk.
   */
  currentClipId: string;
}

/**
 * Apply a kit to the current clip and every other clip, in one pass.
 *
 * `currentClipId` names the open document. It is applied here rather than in the editor's own
 * `run` because a batch has to be all-or-nothing: running the open clip first and then finding
 * that another clip cannot be written would leave a batch that is half done.
 */
export function applyKitToClips(
  input: ApplyKitToClipsInput & { currentClipId: string },
): BatchApplyResult {
  const empty: BatchApplyResult = {
    ok: false,
    error: '',
    changed: [],
    skipped: [],
    notes: [],
    previous: [],
    currentClipId: input.currentClipId,
  };

  /*
    Every clip is planned and applied *before* the caller writes anything. This function does no
    I/O, so "nothing is written until it returns `ok`" is a property of its shape rather than a
    promise in a comment.
  */
  const changed: BatchApplyResult['changed'] = [];
  const skipped: BatchApplyResult['skipped'] = [];
  /** Report lines folded across clips, with the clips each one concerns. */
  const notesByLine = new Map<string, string[]>();
  const previous: BatchApplyResult['previous'] = [];
  let failure = '';

  for (const [index, clip] of input.clips.entries()) {
    const outcome = applyKitToForeignClip(input.kit, input.parts, clip.payload, {
      captionStyleIds: input.captionStyleIds,
      assetIds: input.assetIds,
      readKind: input.readKind,
      ...(input.now ? { now: input.now } : {}),
    });
    /*
      Progress is reported for the clip *just finished*, including one that failed — a bar stuck
      on the previous clip's name is how a batch looks hung.
    */
    input.onProgress?.(index + 1, input.clips.length, clip.record.name);

    if (outcome.status === 'error') {
      failure = `${clip.record.name}: ${outcome.message}`;
      break;
    }
    if (outcome.status === 'skipped') {
      skipped.push({ id: clip.record.id, name: clip.record.name });
    } else {
      changed.push({ id: clip.record.id, name: clip.record.name, payload: outcome.payload });
      /*
        The open clip is left out of `previous` on purpose: its application is already one undo
        step in the history the user is looking at, and restoring it from here as well would
        make "Undo batch" and Ctrl+Z each undo half of one thing.
      */
      if (clip.record.id !== input.currentClipId) {
        previous.push({ id: clip.record.id, name: clip.record.name, payload: clip.payload });
      }
    }
    /*
      The sentences are folded by text, not repeated per clip. A kit whose logo is missing is
      missing on all five clips, and five identical banners is the noise that teaches users to
      scroll past the one that matters — the same rule the font warnings follow.
    */
    for (const line of outcome.report) {
      const names = notesByLine.get(line) ?? [];
      names.push(clip.record.name);
      notesByLine.set(line, names);
    }
  }

  const notes = [...notesByLine.entries()].map(([line, names]) => ({
    line,
    name: names.join(', '),
  }));
  if (failure) return { ...empty, error: failure };
  /*
    The reports are kept even when nothing was applied: "nothing to do" is exactly the case
    where the user needs the sentence explaining it, and returning bare `skipped` names would
    leave them to guess.
  */
  if (changed.length === 0) return { ...empty, skipped, notes };
  return {
    ok: true,
    error: '',
    changed,
    skipped,
    notes,
    previous,
    currentClipId: input.currentClipId,
  };
}

/** The sentence the panel shows when a batch finishes. */
export function describeBatchOutcome(result: BatchApplyResult): string {
  if (!result.ok) {
    if (result.error) return `Could not apply the kit: ${result.error}`;
    /*
      "Nothing to apply" on its own is the least useful sentence this panel can show: the plan
      usually said *why* — a logo missing from the media library, a caption style that is not
      installed — and that explanation is the only thing the user can act on.
    */
    const why = result.notes.length > 0 ? ` ${result.notes.map((note) => note.line).join(' ')}` : '';
    return `The kit had nothing to apply to ${result.skipped.length === 1 ? 'this clip' : 'these clips'}.${why}`;
  }
  const files = result.changed.length === 1 ? 'clip' : 'clips';
  const head =
    result.skipped.length === 0
      ? `Applied to ${result.changed.length} ${files}.`
      : /*
          Named, not counted. "3 clips skipped" leaves the user to work out which three, and
          the likely answer — the ones with no captions yet — is exactly what they would fix
          next.
        */
        `Applied to ${result.changed.length} ${files}; skipped ${result.skipped
          .map((entry) => entry.name)
          .join(', ')}.`;
  if (result.notes.length === 0) return head;
  return `${head} ${result.notes
    .map((note) => `${note.line} (${note.name})`)
    .join(' ')}`;
}

/**
 * Put every other clip back the way it was before a batch.
 *
 * The open clip is not restored here: the user's own `Ctrl+Z` undoes that one, and doing it in
 * two places would make one press undo the batch and the next press redo it. Returns the
 * records to save, so the caller owns the writing.
 */
export function revertBatch(result: BatchApplyResult): Array<{ id: string; payload: TimelineState }> {
  return result.previous.map((entry) => ({ id: entry.id, payload: entry.payload }));
}
