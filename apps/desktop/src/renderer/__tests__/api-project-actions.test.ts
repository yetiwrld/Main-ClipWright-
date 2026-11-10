/**
 * The `api.ts` wrappers for the project actions (SPEC 03 §10).
 *
 * Against the **real module**, with a fake bridge on `window.clipwright` — not a `vi.mock` of
 * `api`, which is how the page tests see it. The distinction matters here because the bug being
 * fixed was in the wrapper: `deleteProject`'s option was declared `deleteMedia` and the store reads
 * `deleteExclusiveManagedMedia`, so the two sides used different words for the same thing and
 * nothing compared them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, DesktopRequiredError } from '../api.js';

const bridge = {
  listProjects: vi.fn(async () => []),
  updateProject: vi.fn(async () => ({})),
  duplicateProject: vi.fn(async () => ({ id: 'prj_2' })),
  revealProject: vi.fn(async (_projectId: string) => '/workspace/Projects/prj_1'),
  deleteProject: vi.fn(async (_projectId: string, _opts?: { deleteExclusiveManagedMedia?: boolean }) => ({
    deletedProjectId: 'prj_1',
    deletedMediaIds: [],
  })),
};

function installBridge() {
  /* No DOM in this file — `api.ts` only asks whether `window` exists and what is on it, so a plain
     object answers every question it has without pulling in jsdom. */
  (globalThis as unknown as { window: { clipwright: unknown } }).window = { clipwright: bridge };
}

function removeBridge() {
  delete (globalThis as unknown as { window?: { clipwright?: unknown } }).window?.clipwright;
}

afterEach(() => {
  removeBridge();
  vi.clearAllMocks();
});

describe('deleteProject translates the caller’s word into the store’s', () => {
  it('sends deleteExclusiveManagedMedia when the caller asks to delete media', async () => {
    /*
      The bug: this used to send `{ deleteMedia: true }`, which `StorageService.deleteProject` does
      not read. The project was deleted, the managed files stayed, the box was ticked, and no error
      was raised — a silent data-leak in the direction the user least expects.
    */
    installBridge();
    await api.deleteProject('prj_1', { deleteMedia: true });
    expect(bridge.deleteProject).toHaveBeenCalledWith('prj_1', { deleteExclusiveManagedMedia: true });
    expect(bridge.deleteProject.mock.calls[0]![1]).not.toHaveProperty('deleteMedia');
  });

  it('sends false rather than undefined, so "keep the files" is explicit', async () => {
    installBridge();
    await api.deleteProject('prj_1', { deleteMedia: false });
    expect(bridge.deleteProject).toHaveBeenCalledWith('prj_1', { deleteExclusiveManagedMedia: false });
  });

  it('defaults to keeping the media when no option is passed', async () => {
    /* §8: deleting a project never deletes referenced originals, and copied media only on request. */
    installBridge();
    await api.deleteProject('prj_1');
    expect(bridge.deleteProject).toHaveBeenCalledWith('prj_1', { deleteExclusiveManagedMedia: false });
  });
});

describe('the other project actions', () => {
  it('duplicates by id', async () => {
    installBridge();
    await expect(api.duplicateProject('prj_1')).resolves.toEqual({ id: 'prj_2' });
    expect(bridge.duplicateProject).toHaveBeenCalledWith('prj_1');
  });

  it('archives by writing the flag through updateProject', async () => {
    /* Archive is a value on the record, not a store method; §8's "read-only until unarchived" is
       that flag's other half, so the wrapper must write it rather than call something else. */
    installBridge();
    await api.archiveProject('prj_1', true);
    expect(bridge.updateProject).toHaveBeenCalledWith('prj_1', { archived: true });
    await api.archiveProject('prj_1', false);
    expect(bridge.updateProject).toHaveBeenLastCalledWith('prj_1', { archived: false });
  });
});

describe('without the desktop app', () => {
  it('throws a named error rather than pretending the action happened', async () => {
    /* The renderer runs in a browser during UI development; a fake success would let a developer
       believe a project was deleted. */
    removeBridge();
    await expect(api.deleteProject('prj_1')).rejects.toBeInstanceOf(DesktopRequiredError);
  });
});

describe('revealProject', () => {
  it('asks main for the project’s own folder, not a path built here', async () => {
    /*
      SPEC 03 §10's "Show in folder" was the one action with no IPC channel, and it shipped absent
      from the menu for that reason. The renderer must not assemble the path: `StorageService
      .getProjectDir` is what the store uses to create and delete the same directory, so a layout
      change has one place to land.
    */
    installBridge();
    await expect(api.revealProject('prj_1')).resolves.toBe('/workspace/Projects/prj_1');
    expect(bridge.revealProject).toHaveBeenCalledWith('prj_1');
  });
});
