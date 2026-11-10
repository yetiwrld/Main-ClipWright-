import { describe, expect, it } from 'vitest';
import { ProjectRecordSchema } from '../schemas.js';
import {
  START_CLIP_LENGTHS,
  concreteAspect,
  startSettings,
  type StartChoices,
} from '../start-settings.js';

/**
 * A project record built the way `StorageService.createProject` builds one, so these tests fail if
 * the settings the start screen sends cannot be stored.
 *
 * `startSettings` is *merged over* the parsed record rather than passed in as its input, and the
 * assertions read that merge. The first version of this helper passed the partial straight to the
 * parser, which let every schema `.default()` fill in whatever the module forgot to send — a
 * mutation that stopped carrying `captionStyleId` survived eleven passing tests, because the
 * default happened to be the value one test asserted. Merging over a parsed default makes an
 * omitted key visible: the assertion reads what the module actually produced.
 */
function recordWith(choices: StartChoices) {
  const sent = startSettings(choices);
  return ProjectRecordSchema.parse({
    id: 'prj_1',
    name: 'Untitled project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    /* Source path first, so a module that started sending a `sourcePath` would overwrite it here —
       and the test below asserts it survives. */
    settings: { ...{ sourcePath: '/videos/interview.mp4' }, ...sent },
  });
}

function choices(overrides: Partial<StartChoices> = {}): StartChoices {
  return {
    aspect: '9:16',
    captionStyleId: 'bold-creator',
    clipLength: 'medium',
    clipCount: 'auto',
    contentType: 'auto',
    language: 'auto',
    processingMode: 'automatic',
    downloadQuality: '1080p',
    storageMode: 'copy',
    clipFocus: '',
    ...overrides,
  };
}

describe('the start screen can create a project', () => {
  /*
    The bug this file exists for. The page sent `storageMode: 'copy'` — its own word for what the
    schema calls `managed` — and the enum rejected it, so `createProject` threw and pressing "Find
    clips" produced nothing at all. Asserting that the whole record parses is the assertion that
    would have failed: every other test in the app checked one side of the boundary.
  */
  it('accepts the default choices end to end', () => {
    const record = recordWith(choices());
    expect(record.settings.storageMode).toBe('managed');
    expect(record.settings.aspect).toBe('9:16');
    expect(record.settings.captionStyleId).toBe('bold-creator');
    expect(record.settings.clipLengthPreset).toBe('medium');
    /* The source path survives untouched — the import stage reads it from this same blob. */
    expect(record.settings.sourcePath).toBe('/videos/interview.mp4');
  });

  it('accepts every aspect tile, including the two that are not named after a ratio', () => {
    for (const aspect of ['9:16', '16:9', '1:1', '4:5', '4:3', '21:9', 'original', 'custom']) {
      expect(recordWith(choices({ aspect })).settings.aspect).toBe(aspect);
    }
  });

  it('accepts every clip-length preset and both storage modes', () => {
    for (const clipLength of ['short', 'medium', 'long', 'extended', 'custom'] as const) {
      expect(recordWith(choices({ clipLength })).settings.clipLengthPreset).toBe(clipLength);
    }
    expect(recordWith(choices({ storageMode: 'copy' })).settings.storageMode).toBe('managed');
    expect(recordWith(choices({ storageMode: 'reference' })).settings.storageMode).toBe('reference');
  });
});

describe('the choices are the ones the analysis actually reads', () => {
  /*
    The other half of the same bug: `aspectRatio`, `captionStyle` and `clipLength` were passed
    through by the schema's passthrough and read by nothing, so a user who chose 4:3 got 9:16 with
    no warning. These assert the schema's keys, which are the ones `moments-service` reads.
  */
  it('writes the preset seconds, not only the preset name', () => {
    /*
      `clipLengthPreset` is read by nothing — the analyser reads `clipLengthRangeSec`. Writing only
      the name would leave "Short 15–30s" as decorative as the three keys it replaced.
    */
    expect(recordWith(choices({ clipLength: 'short' })).settings.clipLengthRangeSec).toEqual([15, 30]);
    expect(recordWith(choices({ clipLength: 'extended' })).settings.clipLengthRangeSec).toEqual([90, 180]);
    expect(Object.keys(START_CLIP_LENGTHS)).toEqual(['short', 'medium', 'long', 'extended']);
  });

  it('writes an explicit custom range as given', () => {
    expect(
      recordWith(choices({ clipLength: 'custom', clipLengthRangeSec: [12, 95] })).settings.clipLengthRangeSec,
    ).toEqual([12, 95]);
  });

  it('orders a reversed custom range instead of storing a backwards one', () => {
    /* Two handles can cross while dragging; a backwards range would make every target comparison
       false, which reads as "no clips found" rather than as a malformed setting. */
    expect(
      recordWith(choices({ clipLength: 'custom', clipLengthRangeSec: [95, 12] })).settings.clipLengthRangeSec,
    ).toEqual([12, 95]);
  });

  it('clamps a custom range to the schema bounds rather than failing the creation', () => {
    /* The slider cannot leave 10–600, so a value outside it is a bug, not a user choice. A project
       that opens with a clamped range is a better outcome than a button that does nothing. */
    const settings = recordWith(choices({ clipLength: 'custom', clipLengthRangeSec: [1, 9000] })).settings;
    expect(settings.clipLengthRangeSec).toEqual([5, 600]);
  });

  it('carries the custom aspect pair, clamped to 1–32', () => {
    expect(
      recordWith(choices({ aspect: 'custom', customAspect: { width: 4, height: 5 } })).settings.customAspect,
    ).toEqual({ width: 4, height: 5 });
    expect(
      recordWith(choices({ aspect: 'custom', customAspect: { width: 0, height: 99 } })).settings.customAspect,
    ).toEqual({ width: 1, height: 32 });
  });

  it('does not invent a custom aspect when the tile is not Custom', () => {
    /* A pair left over from an earlier Custom choice must not ride along on a 16:9 project, where
       it would be read by whatever resolves `custom` first. */
    const settings = recordWith(choices({ aspect: '16:9', customAspect: { width: 4, height: 5 } })).settings;
    expect(settings.customAspect).toBeUndefined();
  });

  it('carries the advanced fields by their schema names', () => {
    const settings = recordWith(
      choices({
        contentType: 'podcast',
        language: 'es',
        clipFocus: 'funny moments',
        processingMode: 'offline',
        downloadQuality: '720p',
      }),
    ).settings;
    expect(settings.contentType).toBe('podcast');
    expect(settings.language).toBe('es');
    expect(settings.clipFocus).toBe('funny moments');
    expect(settings.processingMode).toBe('offline');
    expect(settings.downloadQuality).toBe('720p');
  });

  it('sends the choice, not the default, for every field that has one', () => {
    /*
      The first version of the suite asserted the fields at their defaults — `bold-creator`, `auto`,
      `1080p` — so a module that stopped carrying a field still passed, because the schema's default
      happened to equal the value asserted. Two mutations (caption style and clip count) survived
      eleven green tests for exactly that reason. Each field is now set to something the default is
      not, so "we sent it" and "the parser filled it in" are distinguishable.
    */
    const settings = recordWith(
      choices({
        aspect: '4:3',
        captionStyleId: 'karaoke',
        clipLength: 'short',
        clipCount: 5,
        contentType: 'podcast',
        language: 'es',
        processingMode: 'offline',
        downloadQuality: '720p',
        storageMode: 'reference',
      }),
    ).settings;
    expect(settings.aspect).toBe('4:3');
    expect(settings.captionStyleId).toBe('karaoke');
    expect(settings.clipLengthPreset).toBe('short');
    expect(settings.clipCount).toBe(5);
    expect(settings.contentType).toBe('podcast');
    expect(settings.language).toBe('es');
    expect(settings.processingMode).toBe('offline');
    expect(settings.downloadQuality).toBe('720p');
    expect(settings.storageMode).toBe('reference');
  });

  it('sends every setting rather than relying on a schema default', () => {
    /*
      Each of these has a schema default, so a module that stopped sending one would still produce
      a valid project — with a default the user did not choose. This is the assertion that makes
      "we sent it" distinguishable from "the parser filled it in", and it is why the helper merges
      the sent object over a parsed record instead of handing the partial to the parser.
    */
    const sent = startSettings(choices());
    expect(Object.keys(sent).sort()).toEqual(
      [
        'aspect',
        'captionStyleId',
        'clipCount',
        'clipFocus',
        'clipLengthPreset',
        'clipLengthRangeSec',
        'contentType',
        'downloadQuality',
        'language',
        'processingMode',
        'storageMode',
      ].sort(),
    );
  });
});

describe('concreteAspect', () => {
  it('passes real ratios through and sends the rest to 9:16', () => {
    for (const aspect of ['16:9', '21:9', '1:1', '4:5', '4:3']) {
      expect(concreteAspect(aspect)).toBe(aspect);
    }
    /* `original` needs the source; `custom` needs a pair nothing builds a canvas from yet. Both
       resolve the way the composition builder already resolves them, so there is one answer. */
    expect(concreteAspect('original')).toBe('9:16');
    expect(concreteAspect('custom')).toBe('9:16');
    expect(concreteAspect('nonsense')).toBe('9:16');
  });
});
