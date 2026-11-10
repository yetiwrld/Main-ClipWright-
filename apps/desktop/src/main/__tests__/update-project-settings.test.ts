/**
 * Writing one project setting must not reset the others.
 *
 * `updateProject` merged the record with `{...existing, ...patch}`, and `AppSettingsSchema` gives
 * every field a default. So `{ settings: { contentType } }` replaced the whole settings object and
 * every field the caller did not mention came back as its default: the aspect ratio a 9:16 project
 * was built around, the caption style chosen on the start screen, the clip length range. Nothing
 * threw, nothing logged, and the loss only showed up as a picture that was suddenly the wrong shape.
 *
 * The settings this page writes are not decorative — they are the ones that decide what the clip
 * *is* — so this file asserts the fields around the one being written, not the one being written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../storage/storage-service.js';

let dir: string;
let storage: StorageService;
let projectId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-settings-'));
  storage = new StorageService(path.join(dir, 'workspace'), path.join(dir, 'appdata'));
  projectId = storage.createProject({ name: 'Portrait film' }).id;
  /* Deliberately not the defaults: a test that seeds defaults cannot tell a reset from a merge. */
  storage.updateProject(projectId, {
    settings: {
      aspect: '9:16',
      captionStyleId: 'karaoke',
      clipLengthRangeSec: [12, 31],
      contentType: 'auto',
    },
  });
});

afterEach(() => {
  storage.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('updateProject merges settings field by field', () => {
  it('leaves every other setting where it was when one is written', () => {
    /*
      The exact call the Moments page makes: a single field, no spread. Before the merge moved into
      the store this reset `aspect` to 16:9 and `captionStyleId` to its default.
    */
    const updated = storage.updateProject(projectId, { settings: { contentType: 'tutorial' } });

    expect(updated.settings.contentType).toBe('tutorial');
    expect(updated.settings.aspect).toBe('9:16');
    expect(updated.settings.captionStyleId).toBe('karaoke');
    expect(updated.settings.clipLengthRangeSec).toEqual([12, 31]);
  });

  it('holds the merge on the way back out of the store', () => {
    /* A returned object that differs from the persisted one is the same bug one layer later. */
    storage.updateProject(projectId, { settings: { contentType: 'podcast' } });
    const reread = storage.getProject(projectId);
    expect(reread?.settings.aspect).toBe('9:16');
    expect(reread?.settings.contentType).toBe('podcast');
  });

  it('still replaces fields the caller does set, including falsy ones', () => {
    /*
      A merge that ignored `0`, `false` or `''` would be worse than a replace: the setting could
      never be turned off. `saveSubtitles: false` is a real choice on the export panel.
    */
    storage.updateProject(projectId, { settings: { saveSubtitles: false, targetLufs: -9 } });
    const settings = storage.getProject(projectId)!.settings;
    expect(settings.saveSubtitles).toBe(false);
    expect(settings.targetLufs).toBe(-9);
    /* And the field written by the previous test is still there. */
    expect(settings.aspect).toBe('9:16');
  });

  it('replaces the record around settings, so a patch with no settings keeps them', () => {
    /* Renaming is the common case, and it passes no `settings` at all. */
    const renamed = storage.updateProject(projectId, { name: 'Portrait film (v2)' });
    expect(renamed.name).toBe('Portrait film (v2)');
    expect(renamed.settings.aspect).toBe('9:16');
    expect(renamed.settings.captionStyleId).toBe('karaoke');
  });

  it('rejects a setting the schema does not know, rather than dropping it', () => {
    /*
      The Moments page used to offer `talking_head`, which is ai-core's spelling, not the schema's.
      The schema rejects it — the write must fail loudly here rather than be coerced, because a
      silently-ignored write is indistinguishable from a saved one at the call site.
    */
    expect(() =>
      storage.updateProject(projectId, { settings: { contentType: 'talking_head' } as never }),
    ).toThrow();
  });
});
