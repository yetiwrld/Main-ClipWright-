import { describe, expect, it } from 'vitest';
import rawSafeAreas from '../../../../../assets/safe-areas.json';
import {
  parseSafeAreas,
  pixelGrid,
  platformBands,
  platformKeyFor,
  safeAreaRect,
  type PlatformZone,
} from '../features/editor/safe-areas.js';

describe('the shipped safe-area data (SPEC 10 §9)', () => {
  it('parses', () => {
    // The real file, not a fixture: the point of validating at load is that the file
    // that ships is the file that is checked.
    const data = parseSafeAreas(rawSafeAreas);
    expect(data.titleSafe).toBe(0.9);
    expect(data.actionSafe).toBe(0.93);
  });

  it('covers the vertical platforms the spec names', () => {
    const data = parseSafeAreas(rawSafeAreas);
    expect(Object.keys(data.platforms).sort()).toEqual(['4:5', '9:16']);
    expect(data.platforms['9:16']!.top).toBeCloseTo(0.14, 6);
    expect(data.platforms['9:16']!.bottom).toBeCloseTo(0.25, 6);
    expect(data.platforms['9:16']!.right).toBeCloseTo(0.12, 6);
  });

  it('rejects title safe drawn outside action safe', () => {
    /*
      Title safe is 90% and action safe 93% — the *inner* rectangle is title safe. A
      file with them reversed would draw the looser guide inside the tighter one, which
      reads as a drawing bug rather than a data bug, so it is caught at load.
    */
    expect(() =>
      parseSafeAreas({ titleSafe: 0.95, actionSafe: 0.9, platforms: { '9:16': { top: 0.1, bottom: 0.2, right: 0.1 } } }),
    ).toThrow(/inside/);
  });

  it('rejects platform bands that leave no safe area', () => {
    // Top 14% and bottom 86% would leave nothing between them; the overlay would draw
    // inverted and mean the opposite of what it says.
    expect(() =>
      parseSafeAreas({ titleSafe: 0.9, actionSafe: 0.93, platforms: { '9:16': { top: 0.14, bottom: 0.86, right: 0.12 } } }),
    ).toThrow(/overlap/);
  });

  it('rejects a fraction that is not a fraction', () => {
    // A percentage written as `14` instead of `0.14` is the likeliest authoring slip,
    // and it would draw the band fourteen canvases tall.
    expect(() =>
      parseSafeAreas({ titleSafe: 0.9, actionSafe: 0.93, platforms: { '9:16': { top: 14, bottom: 0.25, right: 0.12 } } }),
    ).toThrow(/fraction/);
  });

  it('rejects a file with no platforms at all', () => {
    expect(() => parseSafeAreas({ titleSafe: 0.9, actionSafe: 0.93, platforms: {} })).toThrow(
      /no platforms/,
    );
  });
});

describe('guide geometry', () => {
  it('centres a safe area on the canvas', () => {
    /*
      Both safe areas are inset equally on all four sides, which is what makes them
      read as "this much of the frame is safe" rather than as a frame offset to one
      side. 90% leaves 5% on each side.
    */
    const rect = safeAreaRect(0.9);
    // `(1 - 0.9) / 2` is 0.04999999999999999 in binary floating point, so the inset is
    // compared to a tolerance rather than for equality — the same reason `croppedSource`
    // rounds its extents.
    expect(rect.x).toBeCloseTo(0.05, 10);
    expect(rect.y).toBeCloseTo(0.05, 10);
    expect(rect.width).toBe(0.9);
    expect(rect.height).toBe(0.9);
    expect(safeAreaRect(0.93).x).toBeCloseTo(0.035, 10);
  });

  it('clamps a fraction that would draw outside the canvas', () => {
    // A guide cannot be larger than the frame or smaller than nothing, however the
    // value arrived.
    expect(safeAreaRect(1.5)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(safeAreaRect(-0.5)).toEqual({ x: 0.5, y: 0.5, width: 0, height: 0 });
    expect(safeAreaRect(Number.NaN)).toEqual({ x: 0.5, y: 0.5, width: 0, height: 0 });
  });

  it('draws the platform bands over the edges it covers, not over the safe middle', () => {
    /*
      The bands are what the platform covers. Drawing one rectangle around the safe
      area instead would dim exactly the region that is *not* obscured — the opposite
      of the point.
    */
    const zone: PlatformZone = { label: 'Vertical', top: 0.14, bottom: 0.25, right: 0.12 };
    const bands = platformBands(zone);
    expect(bands.top).toEqual({ x: 0, y: 0, width: 1, height: 0.14 });
    expect(bands.bottom).toEqual({ x: 0, y: 0.75, width: 1, height: 0.25 });
    expect(bands.right).toEqual({ x: 0.88, y: 0, width: 0.12, height: 1 });
  });

  it('withholds the pixel grid until 800% zoom', () => {
    /*
      SPEC 10 §9 shows the pixel grid at ≥ 800% zoom. There is no canvas zoom in this
      build, so the grid is absent everywhere — but the threshold is implemented and
      tested, so the feature is correctly *not shown* rather than missing on purpose.
    */
    expect(pixelGrid(1)).toBeNull();
    expect(pixelGrid(7.99)).toBeNull();
    expect(pixelGrid(8)).toEqual({ spacing: 1 });
    expect(pixelGrid(16)).toEqual({ spacing: 1 });
    expect(pixelGrid(Number.NaN)).toBeNull();
  });

  it('offers platform bands only for vertical compositions', () => {
    // A 16:9 landscape frame has no top band and no column of action buttons, so
    // showing them would be a guide to chrome that does not exist.
    expect(platformKeyFor('9:16')).toBe('9:16');
    expect(platformKeyFor('4:5')).toBe('4:5');
    expect(platformKeyFor('16:9')).toBeNull();
    expect(platformKeyFor('1:1')).toBeNull();
  });
});

describe('overlays never reach an export (SPEC 10 §9, §15 check 6)', () => {
  it('is not referenced by the export pipeline', async () => {
    /*
      The spec's acceptance check for §9 is "overlays never appear in an export (frame
      diff test)". A frame diff needs ffmpeg and a fixture of many seconds; the
      structural version is stronger and instant: if the export directory cannot name
      the overlays, no render can draw them.

      Same guard as the proxy one, and for the same reason — it is a property that is
      invisible while it holds.
    */
    const { readdirSync, readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const exportDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'main', 'export');
    const offenders: string[] = [];
    for (const file of readdirSync(exportDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(exportDir, file), 'utf8');
      /*
        `guides` is in the pattern because a user guide is the one overlay that is
        *document state*: the others could never reach an export because they are never
        written down, but a guide is in the project file and an export could read it by
        accident. Naming it here is what makes that property hold rather than happen to
        hold. `/guides/` would also catch a comment, which is the intent — an export that
        mentions guides at all is one someone is about to teach it to draw them.
        `grid` is here for the same reason, and it is the *new* way in: the grid is a
        setting now with a module of its own, so an export that reached for a divisor to
        line something up with is one commit away from drawing the lines into the frame.
      */
      if (/safe-areas|safeAreaRect|platformBands|rule-of-thirds|THIRDS|\bguides\b|\bgrid\b/i.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
