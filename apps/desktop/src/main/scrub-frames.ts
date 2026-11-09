/**
 * The on-disk frame cache the preview scrubs from (SPEC 10 §5, SPEC 09 §6.4).
 *
 * Scrubbing a `<video>` element is bounded by how fast it can *seek*, not by how fast a
 * frame can be decoded: each `currentTime` assignment flushes the decoder and waits for a
 * keyframe. Coalescing the seeks stops the element aborting its own work, but it cannot
 * make the remaining seek faster. What does is having the frame already decoded and
 * sitting on disk — so a scrub is a file read and a `<img>` swap rather than a decoder
 * flush, and the frame under the playhead appears before the pointer has moved again.
 *
 * Three policies live here, apart from Electron so they can be tested directly:
 *
 *   1. **Where a frame's file lives** (`scrubFramePath`). Content-addressed by media and
 *      source time, quantised to a grid so a scrub asks for the same frames repeatedly
 *      instead of once per pixel of pointer travel.
 *   2. **Which time to extract** (`scrubTimeFor`), given a request that may be past the
 *      end of the clip.
 *   3. **What is worth keeping** (`pruneScrubFrames`), because an unbounded per-frame
 *      cache on a long clip is a disk-full bug waiting for a user to scrub a lot.
 *
 * The cache is a *derived* artefact like the proxy and the poster: it is never read by an
 * export, and clearing it costs a re-extract rather than anything the user authored.
 */

/**
 * How finely scrub frames are cached, in microseconds.
 *
 * 1/10 s. Finer than a frame at any sane rate (so a request lands on the frame it names),
 * far coarser than a pointer moves (so a drag reuses files instead of writing one per
 * event). At 30 fps a 10-minute clip needs 6000 frames at the floor of the grid, which the
 * prune below bounds.
 */
export const SCRUB_GRID_US = 100_000;

/** Longest clip edge, in pixels, that a scrub frame is extracted at. */
export const SCRUB_MAX_EDGE_PX = 480;

/**
 * How many frame files to keep per media item.
 *
 * The preview shows one layer per track and a drag touches one clip at a time, so the
 * useful window is small. 240 frames is 24 s of 1/10 s grid — comfortably more than a
 * scrub goes back over between two glances, and a few megabytes on disk.
 */
export const SCRUB_CACHE_LIMIT = 240;

/**
 * The file a frame at `sourceUs` is cached in.
 *
 * Quantised down to the grid rather than rounded: the frame a user drags past is served
 * by the file at or before it, so work is never done twice for two names of the same
 * frame. The name carries the time so the directory is self-describing — a `frame-*.jpg`
 * left behind is an obvious orphan rather than a mystery.
 */
export function scrubFramePath(dir: string, sourceUs: number, extension = 'jpg'): string {
  const index = Math.floor(Math.max(0, sourceUs) / SCRUB_GRID_US);
  return `${dir}/frame-${String(index * SCRUB_GRID_US).padStart(12, '0')}.${extension}`;
}

/**
 * The source time to extract for a request, clamped into the clip.
 *
 * A playhead can land on or just past the last frame of an item — half-open ranges mean
 * `start + duration` is one frame beyond what exists — and asking ffmpeg for that instant
 * yields an empty file rather than an error. Pulling back by one grid step keeps the
 * last frame reachable and, importantly, keeps it *cacheable* under the same name every
 * time it is asked for.
 */
export function scrubTimeFor(playheadUs: number, sourceInUs: number, durationUs: number): number {
  const local = playheadUs - sourceInUs;
  const lastIndex = Math.max(0, Math.ceil(Math.max(0, durationUs) / SCRUB_GRID_US) - 1);
  const index = Math.min(Math.max(0, Math.floor(local / SCRUB_GRID_US)), lastIndex);
  return index * SCRUB_GRID_US;
}

/** One cached frame, as the pruner sees it. */
export interface ScrubFrameEntry {
  /** The file's own path, for deletion. */
  path: string;
  /** Grid index this frame sits on, i.e. `round(sourceUs / SCRUB_GRID_US)`. */
  index: number;
  /** When it was written, for evicting the frames a scrub has moved away from. */
  writtenAt: number;
}

/**
 * Which files to delete to keep the cache near a playhead.
 *
 * Keeps the `limit` frames *closest to the playhead* rather than the most recently
 * written, because a scrub revisits where it has been: the user goes back and forth over
 * one cut, and evicting the frames just behind the playhead to make room for the ones just
 * ahead would throw away exactly the ones about to be asked for again. Ties break on the
 * more recent write, so a frame that has been re-extracted after a cache clear survives.
 *
 * Returns the entries to delete, newest-first-safe order irrelevant to callers.
 */
export function pruneScrubFrames(
  entries: readonly ScrubFrameEntry[],
  playheadIndex: number,
  limit = SCRUB_CACHE_LIMIT,
): ScrubFrameEntry[] {
  if (entries.length <= Math.max(0, limit)) return [];
  const ranked = [...entries].sort((a, b) => {
    const distance = Math.abs(a.index - playheadIndex) - Math.abs(b.index - playheadIndex);
    if (distance !== 0) return distance;
    return b.writtenAt - a.writtenAt;
  });
  return ranked.slice(Math.max(0, limit));
}

/**
 * Reads a scrub directory's file names back into entries.
 *
 * The names carry the grid index, so no filesystem metadata beyond the write time is
 * needed to rank them — and a file that does not match the pattern is not ours and is
 * left alone. A missing `stat` (a file deleted between listing and reading) drops the
 * entry rather than failing the whole prune.
 */
export async function scrubEntriesFromNames(
  dir: string,
  names: readonly string[],
  stat: (path: string) => Promise<{ mtimeMs: number }>,
  joinPath: (dir: string, name: string) => string = (d, n) => `${d}/${n}`,
): Promise<ScrubFrameEntry[]> {
  const parsed = await Promise.all(
    names.map(async (name) => {
      const match = /^frame-(\d{12})\.jpg$/.exec(name);
      if (!match) return null;
      const path = joinPath(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) return null;
      return {
        path,
        index: Math.round(Number(match[1]) / SCRUB_GRID_US),
        writtenAt: info.mtimeMs,
      };
    }),
  );
  return parsed.filter((entry): entry is ScrubFrameEntry => entry !== null);
}

/**
 * Trims a media item's scrub directory towards its cap, best-effort (SPEC 10 §5).
 *
 * Fire-and-forget from the request that triggered it: the frame the caller asked for is
 * already written, and a housekeeping failure costs disk rather than correctness. Files
 * are passed in rather than imported so this runs against a fake in tests.
 */
export async function pruneScrubDir(
  dir: string,
  playheadUs: number,
  fs: {
    readdir: (path: string) => Promise<string[]>;
    stat: (path: string) => Promise<{ mtimeMs: number }>;
  },
  unlink: (path: string) => Promise<void>,
  limit = SCRUB_CACHE_LIMIT,
): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    const entries = await scrubEntriesFromNames(dir, names, fs.stat);
    const doomed = pruneScrubFrames(entries, Math.round(Math.max(0, playheadUs) / SCRUB_GRID_US), limit);
    await Promise.all(doomed.map((entry) => unlink(entry.path).catch(() => undefined)));
  } catch {
    // Housekeeping only: the frame that prompted this is already on disk.
  }
}

/**
 * Whether a request can be answered from the cache without extracting anything.
 *
 * The whole point of the module: a hit is a read, a miss is an ffmpeg run. A corrupt or
 * half-written file is not a hit — it would show a grey frame where the picture should
 * be — so the caller checks the file, not just the name.
 */
export function scrubCacheHit(
  existing: ReadonlySet<string>,
  dir: string,
  sourceUs: number,
): string | null {
  const path = scrubFramePath(dir, sourceUs);
  return existing.has(path) ? path : null;
}
