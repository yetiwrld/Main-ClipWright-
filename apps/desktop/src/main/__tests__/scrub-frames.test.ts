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
  it('measures from the item, not the timeline', () => {
    /*
      A clip 10 s into the timeline has its own source in-point. Extracting the timeline
      time would pull a frame 10 s into a file that may be shorter than that — the classic
      "scrub shows the wrong part of the clip" bug.
    */
    expect(scrubTimeFor(12_000_000, 10_000_000, 5_000_000)).toBe(2_000_000);
  });

  it('serves the last frame when the playhead sits one past the end', () => {
    /*
      Ranges are half-open, so `start + duration` is not inside the clip, and asking
      ffmpeg for that instant writes an empty file rather than failing. The last grid
      step before the end is the last frame that exists.
    */
    const time = scrubTimeFor(15_000_000, 10_000_000, 5_000_000);
    expect(time).toBe(4_900_000);
    expect(time).toBeLessThan(5_000_000);
  });

  it('clamps a playhead before the item to the first frame', () => {
    // Reachable by a rounding error at the cut, and by a drag that started elsewhere.
    expect(scrubTimeFor(9_900_000, 10_000_000, 5_000_000)).toBe(0);
  });

  it('never asks for a negative time', () => {
    expect(scrubTimeFor(0, 1_000_000, 5_000_000)).toBe(0);
  });

  it('answers for a zero-length item without dividing by it', () => {
    // A still image or a degenerate item; the answer must be a number, not NaN.
    expect(Number.isFinite(scrubTimeFor(5_000_000, 5_000_000, 0))).toBe(true);
  });

  it('always lands on the grid, so the time and the name agree', () => {
    /*
      The two functions must not disagree: if `scrubTimeFor` returned an off-grid time,
      `scrubFramePath` would quantise it somewhere else and every read would miss.
    */
    for (const [playhead, inUs, duration] of [
      [11_234_567, 10_000_000, 5_000_000],
      [10_050_000, 10_000_000, 5_000_000],
      [14_999_999, 10_000_000, 5_000_000],
    ] as const) {
      const time = scrubTimeFor(playhead, inUs, duration);
      expect(time % SCRUB_GRID_US).toBe(0);
      expect(scrubFramePath(DIR, time)).toBe(scrubFramePath(DIR, time + 1));
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
