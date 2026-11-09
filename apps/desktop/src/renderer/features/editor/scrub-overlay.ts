/**
 * When the preview draws a cached scrub frame instead of the `<video>` (SPEC 10 §5).
 *
 * ## The problem this solves, stated honestly
 *
 * The preview has always shown a scrub by seeking a `<video>` element and letting it paint
 * what it decodes. That is correct and it is slow: assigning `currentTime` starts a seek,
 * and until the decoder answers, the element keeps showing the frame it already had — so
 * during a drag the picture lags the pointer by one seek, and on a long-GOP source one seek
 * is a keyframe hunt.
 *
 * Frames were already extracted to disk for the filmstrip (`derived/scrub/<mediaId>/`,
 * content-addressed on a 1/10 s grid). Reading one is a file read and an image decode,
 * which is *not* bounded by codec seek time. So while a seek is in flight the layer can
 * show that still, and swap back to the element when the element catches up.
 *
 * ## Why this is a policy module rather than an `if`
 *
 * A still is only better in a narrow case and worse in every other one, and the bad cases
 * are visible to a user:
 *
 *   - **While playing**, a still over the video freezes the picture — the element is the
 *     only thing that can show motion, so it must never be covered.
 *   - **Once the seek settles**, the element is showing the frame the still was standing in
 *     for, at full resolution. A 480 px JPEG over a 1080p picture is a visible downgrade,
 *     so the still must disappear rather than linger.
 *   - **When the still is for a different instant than the playhead**, it is not a stand-in
 *     for the frame being waited on, it is the wrong picture. Showing it would put the user's
 *     eye a cell behind where they dragged to, which is worse than showing nothing new.
 *   - **Outside the clip**, the playhead is over some other item (or none), so no frame of
 *     *this* item is the right thing to draw.
 *
 * Each of those is a rule below, named and tested, because every one of them is a bug that
 * looks like "the preview sometimes shows the wrong picture" rather than like a wrong `if`.
 */

/**
 * The frame-cache grid, in microseconds.
 *
 * Deliberately a copy of `SCRUB_GRID_US` from `main/scrub-frames.ts` rather than an import:
 * the repository forbids the renderer from depending on main-process code (`check-repo`
 * fails the build for it), because main imports `node:fs` and `electron`. The two must still
 * agree — a renderer asking for a step main does not store would miss every read — and
 * `scrub-overlay.test.ts` asserts they are equal by importing both, which a test may do.
 */
export const RENDERER_SCRUB_GRID_US = 100_000;

export interface ScrubOverlayInput {
  /** Whether the preview is playing. A still must never cover motion. */
  playing: boolean;
  /** Playhead position on the timeline, in microseconds. */
  playheadUs: number;
  /** The item's own window on the timeline. */
  startUs: number;
  durationUs: number;
  /**
   * Whether this layer's `<video>` has a seek in flight.
   *
   * Read from the element's own `seeking`/`seeked` events rather than from the coalescer,
   * because the question is "is the picture on screen behind the playhead", and the element
   * is the authority on what it is showing.
   */
  seeking: boolean;
}

/** Whether to draw the still instead of letting the element show through. */
export function showScrubStill(input: ScrubOverlayInput): boolean {
  const { playing, playheadUs, startUs, durationUs, seeking } = input;

  // 1. Motion first: nothing here may replace a running picture with a still.
  if (playing) return false;

  // 2. Only while the element is actually behind — otherwise the element's own frame is
  //    both fresher and sharper, and covering it with a 480 px JPEG is a visible downgrade.
  if (!seeking) return false;

  // 3. Only over the clip itself. Half-open, the same window the engine uses everywhere
  //    else: `start + duration` belongs to whatever comes next.
  if (
    !Number.isFinite(playheadUs) ||
    !Number.isFinite(startUs) ||
    !Number.isFinite(durationUs) ||
    playheadUs < startUs ||
    playheadUs >= startUs + durationUs
  ) {
    return false;
  }

  return true;
}

/**
 * Whether the image the layer is *holding* is the one it should be showing.
 *
 * Kept separate from `showScrubStill` because it answers a different question, and folding
 * them together is how a check becomes a tautology: if the URL is built from the playhead
 * then "is the still for this instant" is true by construction and tests nothing. What can
 * actually go wrong is *staleness* — a changed `src` leaves the previous picture painted
 * until the new one decodes, so a seek to a new cell would show the old cell's frame under
 * the pointer. Comparing the URL that finished loading against the one asked for is the
 * observable version of "is this the right picture", and it is the only version that can
 * fail.
 */
export function stillIsCurrent(loadedUrl: string | null, wantedUrl: string | null): boolean {
  return wantedUrl !== null && loadedUrl !== null && loadedUrl === wantedUrl;
}

/** The source instant a playhead maps to, in microseconds. */
export function sourceTimeFor(
  playheadUs: number,
  item: { startUs: number; sourceInUs: number; speed?: number },
): number {
  const speed = Number.isFinite(item.speed) && (item.speed as number) > 0 ? (item.speed as number) : 1;
  return item.sourceInUs + (playheadUs - item.startUs) * speed;
}

/**
 * Which cache cell an instant falls in.
 *
 * Floors, matching `scrubFramePath`: the frame shown is the one at or before the instant
 * asked for, never the one after, so a still can be early by less than a cell and never late.
 */
export function scrubCell(sourceUs: number): number {
  if (!Number.isFinite(sourceUs)) return 0;
  return Math.floor(Math.max(0, sourceUs) / RENDERER_SCRUB_GRID_US);
}

/**
 * The source instant to ask main for, so a requested frame is storeable under one name.
 *
 * Returns `null` for a playhead outside the clip rather than 0: 0 is a real frame, and
 * asking for it by accident would extract a clip's first frame to display under someone
 * else's cut.
 */
export function scrubRequestUs(
  playheadUs: number,
  item: { startUs: number; durationUs: number; sourceInUs: number; speed?: number },
): number | null {
  if (!Number.isFinite(playheadUs) || !Number.isFinite(item.startUs)) return null;
  if (playheadUs < item.startUs || playheadUs >= item.startUs + item.durationUs) return null;
  const sourceUs = sourceTimeFor(playheadUs, item);
  if (!Number.isFinite(sourceUs)) return null;
  return scrubCell(sourceUs) * RENDERER_SCRUB_GRID_US;
}

/**
 * The URL of a cached scrub frame, or `null` when there is nothing to ask for.
 *
 * Built here rather than imported from `main/preview-source.ts` for the same boundary
 * reason as the grid constant, and the shape is pinned by a test that round-trips it through
 * main's own `parseScrubFrameUrl` — so the two cannot drift apart while both look correct
 * in isolation.
 *
 * The time is quantised to the cell before it goes in the URL. Main floors again when it
 * derives the file name, so passing an off-grid instant would still read the right file;
 * quantising here means the *cache key* the renderer compares against is the same number,
 * and a URL that changes per microsecond would defeat the HTTP cache as well.
 */
export function scrubFrameUrl(mediaId: string | undefined, sourceUs: number): string | null {
  if (!mediaId) return null;
  if (!Number.isFinite(sourceUs) || sourceUs < 0) return null;
  /*
    The first path segment of this scheme lands in the URL's *host*, not its path, which is
    why the media URLs read `://media/<id>`; the parser flattens both spellings, and this is
    the one main writes.
  */
  return `clipwright-media://scrub/${encodeURIComponent(mediaId)}/${scrubCell(sourceUs) * RENDERER_SCRUB_GRID_US}`;
}
