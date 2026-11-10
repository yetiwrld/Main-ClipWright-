/**
 * The start screen's payload, through the real store.
 *
 * Every test in this file crosses the boundary that had no test: what `StartPage` builds in the
 * renderer, handed to `StorageService.createProject` in main. That boundary is where the app was
 * broken — the page sent `storageMode: 'copy'`, which is not in the schema's enum, so
 * `ProjectRecordSchema.parse` threw before the insert and **pressing "Find clips" created no
 * project at all**. Neither side's tests could have caught it: the page had no test, and the schema
 * tests never saw a payload shaped like the page's.
 *
 * The fixtures below are deliberately written as the *page's* vocabulary (`copy`, `short`,
 * `'bold-creator'`), not the schema's, because a test written in the schema's own words would pass
 * against the broken code too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSettings, type StartChoices } from '@clipwright/project-schema';
import { StorageService } from '../storage/storage-service.js';

let dir: string;
let storage: StorageService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-start-'));
  storage = new StorageService(path.join(dir, 'workspace'), path.join(dir, 'appdata'));
});

afterEach(() => {
  storage.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The start screen with nothing touched, spelled exactly as `StartPage`'s state holds it. */
const DEFAULTS: StartChoices = {
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
};

function create(overrides: Partial<StartChoices> = {}) {
  return storage.createProject({
    name: 'Untitled project',
    settings: { ...startSettings({ ...DEFAULTS, ...overrides }), sourcePath: '/videos/interview.mp4' },
  });
}

describe('a project is actually created from the start screen', () => {
  it('creates one with the default choices and reads it back', () => {
    /* The exact action the broken build could not perform. */
    const created = create();
    expect(created.id).toBeTruthy();

    const readBack = storage.getProject(created.id);
    expect(readBack).toBeDefined();
    expect(readBack!.name).toBe('Untitled project');
    expect(readBack!.stage).toBe('import');
    expect(readBack!.settings.storageMode).toBe('managed');
  });

  it('keeps the choices the user made instead of the schema defaults', () => {
    /*
      The second half of the bug, which would have survived a fix that only stopped the throw:
      the page's `aspectRatio`, `captionStyle` and `clipLength` were unknown keys that the schema
      passed through and nothing read, so the stored project said 9:16 / bold-creator / 30–60 s no
      matter what was chosen. Each of these differs from the schema's default.
    */
    const created = create({
      aspect: '4:3',
      captionStyleId: 'karaoke',
      clipLength: 'short',
      clipCount: 5,
      contentType: 'podcast',
      language: 'es',
      processingMode: 'offline',
      downloadQuality: '720p',
      clipFocus: 'funny moments',
      storageMode: 'reference',
    });
    const settings = storage.getProject(created.id)!.settings;

    expect(settings.aspect).toBe('4:3');
    expect(settings.captionStyleId).toBe('karaoke');
    expect(settings.clipLengthPreset).toBe('short');
    expect(settings.clipCount).toBe(5);
    expect(settings.contentType).toBe('podcast');
    expect(settings.language).toBe('es');
    expect(settings.processingMode).toBe('offline');
    expect(settings.downloadQuality).toBe('720p');
    expect(settings.clipFocus).toBe('funny moments');
    expect(settings.storageMode).toBe('reference');
  });

  it('stores the clip length the analysis will use', () => {
    /* `moments-service` reads `clipLengthRangeSec`, so that is the value that has to be right —
       storing only the preset's name would leave the control decorative. */
    const short = storage.getProject(create({ clipLength: 'short' }).id)!.settings;
    expect(short.clipLengthRangeSec).toEqual([15, 30]);

    const extended = storage.getProject(create({ clipLength: 'extended' }).id)!.settings;
    expect(extended.clipLengthRangeSec).toEqual([90, 180]);
  });

  it('survives a custom range and a custom aspect', () => {
    const created = create({
      aspect: 'custom',
      customAspect: { width: 4, height: 5 },
      clipLength: 'custom',
      clipLengthRangeSec: [20, 45],
    });
    const settings = storage.getProject(created.id)!.settings;
    expect(settings.aspect).toBe('custom');
    expect(settings.customAspect).toEqual({ width: 4, height: 5 });
    expect(settings.clipLengthRangeSec).toEqual([20, 45]);
  });

  it('shows up in the project list, which is what the home screen reads', () => {
    const created = create();
    expect(storage.listProjects(true).projects.map((project) => project.id)).toContain(created.id);
  });
});

describe('the old payload is the failure being fixed', () => {
  it('is rejected by the schema, so this file would have failed before the fix', () => {
    /*
      Guards the test above from becoming vacuous: if the store ever started accepting arbitrary
      keys, the "creates a project" tests would still pass while the real page went back to
      sending `copy`. This asserts the old payload is *still* refused, which is what makes the
      conversion the load-bearing part rather than a formality.
    */
    expect(() =>
      storage.createProject({
        name: 'Untitled project',
        settings: { aspecRatio: '9:16', storageMode: 'copy' } as never,
      }),
    ).toThrow(/storageMode/);
  });
});
