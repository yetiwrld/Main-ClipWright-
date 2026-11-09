/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { SCRUB_GRID_US as MAIN_SCRUB_GRID_US } from '../../../../main/scrub-frames.js';
import {
  RENDERER_SCRUB_GRID_US,
  scrubCell,
  scrubFrameUrl,
  scrubRequestUs,
  showScrubStill,
  stillIsCurrent,
  sourceTimeFor,
} from '../scrub-overlay.js';

/** A 5 s clip placed at 10 s on the timeline, in-point 2 s, 1×. */
const ITEM = { startUs: 10_000_000, durationUs: 5_000_000, sourceInUs: 2_000_000 };

function input(overrides: Partial<Parameters<typeof showScrubStill>[0]> = {}) {
  return {
    playing: false,
    playheadUs: 12_000_000,
    seeking: true,
    ...ITEM,
    ...overrides,
  };
}

describe('the renderer grid agrees with the cache it reads', () => {
  it('uses the same step as the main process, or every read would miss', () => {
    /*
      The renderer may not import main-process code, so this constant is a copy. A test may
      import both, and this is the assertion that keeps the copy honest: a divergence would
      not fail a typecheck or a lint, it would make every still silently unavailable.
    */
    expect(RENDERER_SCRUB_GRID_US).toBe(MAIN_SCRUB_GRID_US);
  });
});

describe('when to draw a still over the video', () => {
  it('draws one while a seek is in flight and the still is the frame being waited on', () => {
    expect(showScrubStill(input())).toBe(true);
  });

  it('never draws one while playing, because a still cannot show motion', () => {
    expect(showScrubStill(input({ playing: true }))).toBe(false);
  });

  it('never draws one once the seek has settled, because the element is sharper', () => {
    /*
      This is the rule that makes the feature a win rather than a downgrade: the still is
      480 px and the element is the source's own resolution, so as soon as the decoder
      answers, covering it with the JPEG is a visible loss of detail.
    */
    expect(showScrubStill(input({ seeking: false }))).toBe(false);
  });

  it('draws nothing outside the clip, on either side', () => {
    const before = input({ playheadUs: 9_999_999 });
    const after = input({ playheadUs: 15_000_000 });
    expect(showScrubStill(before)).toBe(false);
    // Half-open: the item's end instant belongs to whatever comes next, not to it.
    expect(showScrubStill(after)).toBe(false);
    // …and just inside the end is still the clip's.
    expect(showScrubStill(input({ playheadUs: 14_999_999 }))).toBe(true);
  });

  it('survives nonsense rather than covering the picture with a wrong frame', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(showScrubStill(input({ playheadUs: value }))).toBe(false);
    }
  });

  it('accounts for speed when naming the instant, so a 2× clip does not ask half as far in', () => {
    // 1 s of timeline on a 2× clip is 2 s of source, so the frame is at 4 s, not 3 s.
    expect(sourceTimeFor(11_000_000, { ...ITEM, speed: 2 })).toBe(4_000_000);
    expect(scrubRequestUs(11_000_000, { ...ITEM, speed: 2 })).toBe(4_000_000);
    // The 1× answer for the same playhead is a different frame.
    expect(scrubRequestUs(11_000_000, ITEM)).toBe(3_000_000);
  });
});

describe('whether the still being held is the one to show', () => {
  /*
    This is the check with teeth. The URL is built from the playhead, so "is the still for
    this instant" would be true by construction; what can actually go wrong is staleness —
    a changed `src` keeps the previous picture until the new one decodes, so a seek into a
    new cell would leave the old cell's frame painted under the pointer.
  */
  it('shows only the URL that finished loading and is still the one wanted', () => {
    expect(stillIsCurrent('u:1', 'u:1')).toBe(true);
  });

  it('hides a picture that belongs to an earlier instant', () => {
    // The new URL is wanted but the old one finished loading: drawing it would put the
    // picture a cell behind where the pointer is.
    expect(stillIsCurrent('u:1', 'u:2')).toBe(false);
  });

  it('shows nothing when the wanted picture has not loaded yet', () => {
    expect(stillIsCurrent(null, 'u:2')).toBe(false);
    // …including when there is no wanted picture at all.
    expect(stillIsCurrent('u:1', null)).toBe(false);
    expect(stillIsCurrent(null, null)).toBe(false);
  });
});

describe('which instant to ask for', () => {
  it('names the cell boundary, which is the only name the cache can store', () => {
    expect(scrubRequestUs(12_000_000, ITEM)).toBe(4_000_000);
    expect(scrubRequestUs(12_050_000, ITEM)).toBe(4_000_000);
    expect(scrubRequestUs(12_150_000, ITEM)).toBe(4_100_000);
  });

  it('floors, so a still is never ahead of the playhead', () => {
    // A frame after the playhead would show something not yet reached — a visible error at
    // a cut. The cell boundary at or before is always the safe one.
    const request = scrubRequestUs(12_099_999, ITEM);
    expect(request).not.toBeNull();
    expect(request as number).toBeLessThanOrEqual(sourceTimeFor(12_099_999, ITEM));
  });

  it('returns null outside the clip rather than 0', () => {
    // 0 is a real frame; asking for it by mistake would show the clip's first frame under
    // another clip's cut.
    expect(scrubRequestUs(9_999_999, ITEM)).toBeNull();
    expect(scrubRequestUs(15_000_000, ITEM)).toBeNull();
  });

  it('returns null for a nonsense playhead', () => {
    expect(scrubRequestUs(Number.NaN, ITEM)).toBeNull();
  });
});

describe('the cache cell arithmetic', () => {
  it('floors, and never names a negative cell', () => {
    expect(scrubCell(4_099_999)).toBe(40);
    expect(scrubCell(4_100_000)).toBe(41);
    expect(scrubCell(-5_000)).toBe(0);
  });

  it('puts a cell boundary and the instant just before it in different cells', () => {
    expect(scrubCell(4_100_000)).not.toBe(scrubCell(4_099_999));
  });
});

describe('the URL the renderer builds is the one main parses', () => {
  /*
    The builder lives in the renderer and the parser lives in main, because the renderer may
    not import main-process code. Round-tripping through the real parser is what keeps the
    two honest: both can be self-consistent and still disagree, and the failure would be a
    404 on every read — a still that never appears rather than a test that fails.
  */
  it('round-trips through main', async () => {
    const { parseScrubFrameUrl } = await import('../../../../main/preview-source.js');
    const url = scrubFrameUrl('media-1', 4_000_000);
    expect(parseScrubFrameUrl(url as string)).toStrictEqual({
      mediaId: 'media-1',
      timeUs: 4_000_000,
    });
  });

  it('survives an id that needs escaping', async () => {
    const { parseScrubFrameUrl } = await import('../../../../main/preview-source.js');
    const url = scrubFrameUrl('a/b c', 1_200_000);
    expect(parseScrubFrameUrl(url as string)).toStrictEqual({
      mediaId: 'a/b c',
      timeUs: 1_200_000,
    });
  });

  it('quantises the time into the cell, so the key is stable', () => {
    expect(scrubFrameUrl('m', 4_099_999)).toBe(scrubFrameUrl('m', 4_000_000));
    expect(scrubFrameUrl('m', 4_100_000)).not.toBe(scrubFrameUrl('m', 4_099_999));
  });

  it('has nothing to build without an id, or for a nonsense time', () => {
    expect(scrubFrameUrl(undefined, 0)).toBeNull();
    expect(scrubFrameUrl('', 0)).toBeNull();
    expect(scrubFrameUrl('m', -1)).toBeNull();
    expect(scrubFrameUrl('m', Number.NaN)).toBeNull();
  });
});
