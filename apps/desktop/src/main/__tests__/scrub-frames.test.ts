import { describe, expect, it } from 'vitest';
import {
  SCRUB_CACHE_LIMIT,
  SCRUB_GRID_US,
  pruneScrubFrames,
  scrubCacheHit,
  pruneScrubDir,
  scrubEntriesFromNames,
  scrubFramePath,
  scrubTimeFor,
  type ScrubFrameEntry,
} from '../scrub-frames.js';

/**
 * The scrub-frame cache (SPEC 10 §5, SPEC 09 §6.4).
 *
 * The interesting parts are all about *naming* and *eviction*: two requests for the same
 * frame must resolve to one file, and a scrub that wanders must not grow the directory
 * without bound.
 */

const DIR = '/derived/media_x/scrub';

describe('where a frame is cached', () => {
  it('lands every request inside a grid cell on the same file', () => {
    /*
      The property that makes the cache work at all: a pointer moves by pixels, the grid
      moves by tenths of a second. Two requests a millisecond apart are the same frame and
      must not cost two extractions.
    */
    const a = scrubFramePath(DIR, 1_000_000);
    expect(scrubFramePath(DIR, 1_000_001)).toBe(a);
    expect(scrubFramePath(DIR, 1_099_999)).toBe(a);
    expect(scrubFramePath(DIR, 1_100_000)).not.toBe(a);
  });

  it('thence quantises down rather than to nearest', () => {
    /*
      Down, not nearest: the frame shown is the one at or before the instant asked for.
      Rounding up would show a frame the playhead has not reached yet, which is a visible
      one-frame error at a cut.
    */
    expect(scrubFramePath(DIR, 1_099_999)).toBe(scrubFramePath(DIR, 1_000_000));
    expect(scrubFramePath(DIR, 1_099_999)).not.toBe(scrubFramePath(DIR, 1_100_000));
  });

  it('never names a file before zero', () => {
    // A negative source time is a bug elsewhere, but it must not produce `frame--001000`.
    expect(scrubFramePath(DIR, -5_000)).toBe(scrubFramePath(DIR, 0));
  });

  it('puts the time in the name so an orphan is identifiable', () => {
    expect(scrubFramePath(DIR, 2_500_000)).toMatch(/frame-000002500000\.jpg$/);
  });

  it('carries an extension through, for a format the caller chose', () => {
    // png keeps alpha; the path builder must not hard-code jpeg.
    expect(scrubFramePath(DIR, 0, 'png')).toMatch(/\.png$/);
  });
});

describe('which time to extract', () => {
  /*
    Three spaces meet in this function and the first version conflated two of them: the
    *timeline* position of the playhead, the *timeline* position of the item's start, and
    the *source* time it maps to. It subtracted the source in-point from the playhead, which
    is right only when all three numbers happen to be equal — a single clip at 0 with a
    0 in-point, which is most projects and none of the interesting ones.

    Every expectation below is derived from `sourceInUs + (playhead − startUs) × speed`
    rather than read off a run.
  */
  const clip = (startUs: number, sourceInUs: number, durationUs: number, speed?: number) => ({
    startUs,
    sourceInUs,
    durationUs,
    speed,
  });

  it('answers in source time, so ffmpeg is asked for the right part of the file', () => {
    /*
      The bug this replaced: a clip starting at 10 s with a 2 s in-point, playhead at 12 s,
      should show source 4 s. The old function answered 10 s — it subtracted the in-point
      (2 s) from the playhead (12 s) and ignored the clip's start entirely, so a trimmed
      clip scrubbed to an unrelated part of the file.
    */
    expect(scrubTimeFor(12_000_000, clip(10_000_000, 2_000_000, 5_000_000))).toBe(4_000_000);
  });

  it('adds the in-point, because the timeline elapsed and the source offset are different', () => {
    // 2 s into a clip whose source starts at 10 s is source 12 s, not 2 s and not 10 s.
    expect(scrubTimeFor(12_000_000, clip(10_000_000, 10_000_000, 5_000_000))).toBe(12_000_000);
  });

  it('scales by speed, so a 2× clip asks for twice the source time', () => {
    // A clip played at 2× consumes two seconds of source per second of timeline.
    expect(scrubTimeFor(11_000_000, clip(10_000_000, 0, 5_000_000, 2))).toBe(2_000_000);
    // And a 0.5× clip consumes half as much.
    expect(scrubTimeFor(12_000_000, clip(10_000_000, 0, 5_000_000, 0.5))).toBe(1_000_000);
  });

  it('serves the last frame when the playhead sits one past the end', () => {
    /*
      Ranges are half-open, so `start + duration` is not inside the clip, and asking ffmpeg
      for that instant writes an empty file rather than failing. The last grid step before
      the end is the last frame that exists.
    */
    const time = scrubTimeFor(15_000_000, clip(10_000_000, 10_000_000, 5_000_000));
    expect(time).toBe(14_900_000);
    // And it is inside the clip: the in-point plus one grid step less than the duration.
    expect(time - 10_000_000).toBeLessThan(5_000_000);
  });

  it('clamps a playhead before the item to its first frame', () => {
    // Reachable by a rounding error at the cut, and by a drag that started elsewhere.
    expect(scrubTimeFor(9_900_000, clip(10_000_000, 10_000_000, 5_000_000))).toBe(10_000_000);
  });

  it('never asks for a negative time', () => {
    expect(scrubTimeFor(0, clip(1_000_000, 0, 5_000_000))).toBe(0);
    // A negative in-point is not a thing the schema allows, but it must not produce one.
    expect(scrubTimeFor(2_000_000, clip(1_000_000, -1_000_000, 5_000_000))).toBeGreaterThanOrEqual(0);
  });

  it('answers for a zero-length item without dividing by it', () => {
    // A still image or a degenerate item; the answer must be a number, not NaN.
    expect(Number.isFinite(scrubTimeFor(5_000_000, clip(5_000_000, 0, 0)))).toBe(true);
  });

  it('grids the absolute source time, so the answer names its own file', () => {
    /*
      The grid step here must be the same one `scrubFramePath` floors by, or the returned
      time and the file it is stored under are different numbers and every read misses.

      Grinding the *item-local* offset instead is the tempting version — it reads as "one
      source frame is one file" — and it is wrong for any in-point not on the grid, which is
      most real trims (91 frames at 30 fps is 3.0333 s). It returns an off-grid time while
      `scrubFramePath` floors it to a cell, so two clips trimmed to 3.0333 s and 3.05 s get
      two different extraction times and one shared file name: the second extraction
      overwrites the first and one clip shows the other's frame.
    */
    const nonAligned = 3_033_333;
    const time = scrubTimeFor(10_000_000, clip(10_000_000, nonAligned, 5_000_000));
    expect(time % SCRUB_GRID_US).toBe(0);
    // And the identity that actually matters: the time *is* its own file.
    expect(scrubFramePath(DIR, time)).toBe(
      scrubFramePath(DIR, Math.floor(nonAligned / SCRUB_GRID_US) * SCRUB_GRID_US),
    );
  });

  it('gives two in-points one answer when they share a cell, not two answers one file', () => {
    /*
      The collision, stated as the invariant it violates. 3.0333 s and 3.05 s fall in the
      same 1/10 s cell, so they must extract the same instant — the cell boundary — rather
      than each insisting on its own exact in-point under a name that admits only one.
    */
    const a = scrubTimeFor(10_000_000, clip(10_000_000, 3_033_333, 5_000_000));
    const b = scrubTimeFor(10_000_000, clip(10_000_000, 3_050_000, 5_000_000));
    expect(a).toBe(b);
    expect(a).toBe(3_000_000);
    // Different cells must still differ, or the cache would serve one frame for a whole clip.
    const later = scrubTimeFor(10_000_000, clip(10_000_000, 3_150_000, 5_000_000));
    expect(later).not.toBe(a);
  });

  it('never shows a frame before the in-point, whatever the in-point is', () => {
    /*
      The clamp belongs in item space. Floored to a cell, an in-point at 3.0333 s yields the
      3.0 s boundary — at or *before* the in-point, by up to one grid step. That is the safe
      direction: a frame early never reveals what the trim was meant to cut off, whereas a
      frame late shows past the cut. Asserted as a bound rather than an equality so the
      floors stay free to land anywhere inside the cell.
    */
    const inPoint = 3_033_333;
    for (const playhead of [10_000_000, 10_500_000, 14_999_999]) {
      const time = scrubTimeFor(playhead, clip(10_000_000, inPoint, 5_000_000));
      /*
        One grid step either side is the whole tolerance: floored into a cell, the answer is
        at worst one step before the in-point, and the clamp keeps it inside the item's span.
        Anything further out would mean the clamp or the grid had moved between spaces.
      */
      expect(time).toBeGreaterThanOrEqual(inPoint - SCRUB_GRID_US);
      expect(time).toBeLessThanOrEqual(inPoint + 5_000_000);
    }
  });

  it('treats a nonsense speed as 1 rather than producing NaN', () => {
    /*
      The same guard as everywhere else: `NaN` defeats every comparison, so a `speed` that
      slipped past validation would make the whole answer `NaN`, and an extraction at `NaN`
      writes nothing at all.
    */
    for (const speed of [Number.NaN, 0, -1]) {
      expect(scrubTimeFor(12_000_000, clip(10_000_000, 0, 5_000_000, speed))).toBe(2_000_000);
    }
  });
});

const entry = (index: number, writtenAt = 0): ScrubFrameEntry => ({
  path: `${DIR}/frame-${index}.jpg`,
  index,
  writtenAt,
});

describe('what to keep', () => {
  it('keeps everything below the limit', () => {
    const entries = [entry(0), entry(1), entry(2)];
    expect(pruneScrubFrames(entries, 1, 10)).toEqual([]);
  });

  it('deletes down to the limit', () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(index));
    expect(pruneScrubFrames(entries, 5, 4)).toHaveLength(6);
  });

  it('keeps the frames nearest the playhead rather than the newest', () => {
    /*
      A scrub goes back and forth over one cut. Evicting the frames just behind the
      playhead to keep the ones just written would throw away exactly what is about to be
      asked for again — the cache would thrash at the moment it is most needed.
    */
    const near = [entry(9), entry(10), entry(11)];
    const far = [entry(0), entry(1), entry(2), entry(3)];
    const kept = [...near, ...far].filter(
      (candidate) => !pruneScrubFrames([...near, ...far], 10, 3).includes(candidate),
    );
    expect(kept.map((item) => item.index).sort((a, b) => a - b)).toEqual([9, 10, 11]);
  });

  it('breaks a tie on the more recently written frame', () => {
    // Two frames equidistant from the playhead: the one already re-extracted is worth
    // more than the one that has only ever been written once.
    const older = entry(4, 100);
    const newer = entry(6, 200);
    expect(pruneScrubFrames([older, newer], 5, 1)).toEqual([older]);
  });

  it('deletes everything above a zero limit', () => {
    // The degenerate limit must not be "keep nothing forever" or "keep everything".
    expect(pruneScrubFrames([entry(0), entry(1)], 0, 0)).toHaveLength(2);
  });

  it('has a limit that is a sane number of frames', () => {
    // Guards against a typo turning the cap into 2400 or 24.
    expect(SCRUB_CACHE_LIMIT).toBeGreaterThanOrEqual(60);
    expect(SCRUB_CACHE_LIMIT).toBeLessThanOrEqual(1000);
  });
});

describe('reading from the cache', () => {
  it('returns the path when the file is there', () => {
    const path = scrubFramePath(DIR, 3_000_000);
    expect(scrubCacheHit(new Set([path]), DIR, 3_000_000)).toBe(path);
  });

  it('returns null when it is not, rather than a path to nothing', () => {
    // The difference between the two is an `<img>` that shows the frame and one that
    // shows a broken-image glyph over the whole canvas.
    expect(scrubCacheHit(new Set(), DIR, 3_000_000)).toBeNull();
  });
});

describe('reading a scrub directory back', () => {
  it('recovers the grid index from the file name', async () => {
    /*
      The names are the index; nothing else records where a frame sits. If the parse
      were off by the grid the pruner would rank every frame as equally distant and
      evict essentially at random.
    */
    // 500 000 µs at a 100 000 µs grid is index 5.
    const entries = await scrubEntriesFromNames(DIR, ['frame-000000500000.jpg'], async () => ({ mtimeMs: 5 }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.index).toBe(5);
  });

  it('ignores files that are not ours', async () => {
    // A stray `.DS_Store` or a hand-placed image in the directory must not be deleted.
    const entries = await scrubEntriesFromNames(
      DIR,
      ['frame-000000000100.jpg', '.DS_Store', 'notes.txt', 'frame-bad.jpg'],
      async () => ({ mtimeMs: 1 }),
    );
    expect(entries.map((entry) => entry.path)).toEqual([`${DIR}/frame-000000000100.jpg`]);
  });

  it('drops a file that vanished between listing and stating', async () => {
    // Not a reason to fail the prune; there is nothing left to evict.
    const entries = await scrubEntriesFromNames(DIR, ['frame-000000000100.jpg'], async () => {
      throw new Error('ENOENT');
    });
    expect(entries).toEqual([]);
  });
});

describe('pruning a scrub directory', () => {
  const names = Array.from({ length: 6 }, (_, index) => `frame-${String(index * 100_000).padStart(12, '0')}.jpg`);
  const fs = {
    readdir: async () => names,
    stat: async () => ({ mtimeMs: 1 }),
  };

  it('deletes the frames furthest from the playhead', async () => {
    const deleted: string[] = [];
    // Playhead index 3 of 0..5, keeping two: the nearest pair is 3 and then 2 or 4.
    await pruneScrubDir('/d', 300_000, fs, async (path) => void deleted.push(path), 2);
    expect(deleted.sort()).toEqual([
      '/d/frame-000000000000.jpg',
      '/d/frame-000000100000.jpg',
      '/d/frame-000000400000.jpg',
      '/d/frame-000000500000.jpg',
    ]);
  });

  it('deletes nothing when the directory is under its cap', async () => {
    const deleted: string[] = [];
    await pruneScrubDir('/d', 0, fs, async (path) => void deleted.push(path), 100);
    expect(deleted).toEqual([]);
  });

  it('survives a directory it cannot read', async () => {
    /*
      Called without awaiting from the request path. A rejected promise there would be an
      unhandled rejection — a crash in Electron — for a cache that is purely an
      optimisation.
    */
    await expect(
      pruneScrubDir(
        '/missing',
        0,
        {
          readdir: async () => {
            throw new Error('ENOENT');
          },
          stat: async () => ({ mtimeMs: 1 }),
        },
        async () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps going when one deletion fails', async () => {
    /*
      A file locked by another read must not stop the rest being evicted. The failure is
      thrown on a file that *is* being evicted — index 0 is the one kept at playhead 0,
      and throwing on it would test nothing, which is how the first version of this test
      passed while the code it was checking was wrong.
    */
    const attempted: string[] = [];
    await pruneScrubDir(
      '/d',
      0,
      fs,
      async (path) => {
        attempted.push(path);
        if (path.endsWith('000000100000.jpg')) throw new Error('EBUSY');
      },
      1,
    );
    expect(attempted).toHaveLength(5);
  });
});
