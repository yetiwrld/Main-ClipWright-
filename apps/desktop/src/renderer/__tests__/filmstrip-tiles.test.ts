import { describe, expect, it, vi } from 'vitest';
import { drawFilmstripTiles, filmstripTileCount } from '../features/editor/use-media-assets.js';

/**
 * The timeline filmstrip (SPEC 09 §19).
 *
 * Its whole job is to show *different* frames across a clip, so what is checked here is
 * that each tile is asked for its own image and that a missing one leaves a gap rather
 * than repeating its neighbour.
 */

const fakeImage = (width = 320) => ({ complete: true, naturalWidth: width }) as HTMLImageElement;

function fakeContext() {
  return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D & { drawImage: ReturnType<typeof vi.fn> };
}

describe('how many tiles a strip holds', () => {
  it('is at least one, however narrow the clip', () => {
    // A one-frame clip still deserves a picture rather than an empty strip.
    expect(filmstripTileCount(10, 24)).toBe(1);
    expect(filmstripTileCount(0, 24)).toBe(1);
  });

  it('counts by the tile aspect, not by an arbitrary tile width', () => {
    // Tile width is height * 16/9 = 48 at height 27, so 200 px holds 200/48 = 4.17 → 5.
    expect(filmstripTileCount(200, 27)).toBe(5);
  });

  it('rounds up, so the last partial tile is drawn', () => {
    // Rounding down would leave a bare gap at the right-hand end of every clip.
    expect(filmstripTileCount(49, 27)).toBe(2);
  });
});

describe('drawing a strip from per-tile images', () => {
  it('asks each tile for its own image', () => {
    /*
      The bug this replaces: one poster repeated across the strip, so every tile showed
      the same frame and the strip could not show where a cut lands.
    */
    const ctx = fakeContext();
    const asked: number[] = [];
    drawFilmstripTiles(
      ctx,
      (tile) => {
        asked.push(tile);
        return fakeImage();
      },
      200,
      27,
    );
    expect(asked).toEqual([0, 1, 2, 3, 4]);
    expect(ctx.drawImage).toHaveBeenCalledTimes(5);
  });

  it('leaves the clip colour showing where a frame has not arrived', () => {
    // Skipping rather than substituting a neighbour: a repeated frame reads as a still
    // clip, which is a worse lie than a gap that fills in.
    const ctx = fakeContext();
    drawFilmstripTiles(ctx, () => null, 200, 27);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('skips an image that has not finished loading', () => {
    const ctx = fakeContext();
    const notLoaded = { complete: false, naturalWidth: 0 } as HTMLImageElement;
    drawFilmstripTiles(ctx, () => notLoaded, 200, 27);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('draws each tile at its own x, in order', () => {
    // The frames are only meaningful if they land under the time they represent.
    const ctx = fakeContext();
    drawFilmstripTiles(ctx, () => fakeImage(), 200, 27);
    const xs = ctx.drawImage.mock.calls.map((call) => call[1]);
    expect(xs).toEqual([0, 48, 96, 144, 192]);
  });

  it('clips the last tile to the strip rather than overhanging it', () => {
    // An overhanging tile would paint over the item's right-hand trim handle.
    const ctx = fakeContext();
    drawFilmstripTiles(ctx, () => fakeImage(), 200, 27);
    const widths = ctx.drawImage.mock.calls.map((call) => call[3]);
    expect(widths).toEqual([48, 48, 48, 48, 8]);
  });

  it('draws nothing at all for a zero-width strip', () => {
    // The first paint of a clip being added is often 0 px wide; five extractions for
    // tiles nobody can see would be wasted work.
    const ctx = fakeContext();
    const asked: number[] = [];
    drawFilmstripTiles(
      ctx,
      (tile) => {
        asked.push(tile);
        return fakeImage();
      },
      0,
      27,
    );
    expect(asked).toEqual([]);
  });
});
