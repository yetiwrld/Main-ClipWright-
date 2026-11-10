// @vitest-environment jsdom
/**
 * The project list's ⋯ menu (SPEC 02 §6, SPEC 03 §10).
 *
 * Rename, Duplicate, Archive and Delete were all implemented in `StorageService` and none of them
 * was reachable from the window: the bridge exposed all four, `api.ts` wrapped only
 * `updateProject`, and the page had no menu. The store's tests passed throughout, because they
 * called the store.
 *
 * These assert the *arguments* as well as the call, because one of the arguments was wrong in a way
 * nothing could see: `deleteProject`'s option was declared `deleteMedia` while the store reads
 * `deleteExclusiveManagedMedia`, so ticking "also delete media" deleted the project and kept the
 * files with no error. A test that only checked "delete was called" would have passed on that too.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectsPage } from '../pages/ProjectsPage.js';

const bridge = vi.hoisted(() => ({
  listProjects: vi.fn(),
  updateProject: vi.fn(async (_projectId: string, _patch: Record<string, unknown>) => ({})),
  duplicateProject: vi.fn(async (_projectId: string) => ({})),
  revealProject: vi.fn(async (_projectId: string) => '/workspace/Projects/prj_1'),
  deleteProject: vi.fn(async (_projectId: string, _opts?: { deleteExclusiveManagedMedia?: boolean }) => ({})),
}));

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    listProjects: bridge.listProjects,
    updateProject: bridge.updateProject,
    duplicateProject: bridge.duplicateProject,
    revealProject: bridge.revealProject,
    /*
      The mapping under test lives in `api.ts`, and this file replaces `api` wholesale — so the mock
      has to perform the same translation, or the test would assert on the mock rather than on the
      page. `api.test.ts` covers the wrapper itself against the real module.
    */
    async deleteProject(projectId: string, opts?: { deleteMedia?: boolean }) {
      return bridge.deleteProject(projectId, { deleteExclusiveManagedMedia: opts?.deleteMedia === true });
    },
    /* The page's own wrappers are under test in `api.test.ts`; here they are the seam. */
    async archiveProject(projectId: string, archived: boolean) {
      return bridge.updateProject(projectId, { archived });
    },
  },
  describeError: (err: unknown) => String(err),
}));

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prj_1',
    name: 'Interview clips',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archived: false,
    stage: 'editor',
    sourceMediaIds: ['med_1'],
    schemaVersion: 2,
    appVersionLastSaved: '1.0.0',
    settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  bridge.listProjects.mockResolvedValue([project()]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openMenu() {
  render(<ProjectsPage onNavigate={() => undefined} />);
  const trigger = await screen.findByRole('button', { name: /actions for interview clips/i });
  fireEvent.click(trigger);
  return trigger;
}

describe('the project menu exists and names its project', () => {
  it('shows the five actions from SPEC 03 §10', async () => {
    await openMenu();
    /* SPEC 03 §10's six, in its order. "Show in folder" was the one that had no IPC channel. */
    for (const label of ['Open', 'Rename', 'Duplicate', 'Archive', 'Show in folder', 'Delete']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
    }
  });

  it('is labelled per project, so several cards have distinguishable menus', async () => {
    /* A screen reader on a grid of ten cards would otherwise hear ten identical "⋯" buttons. */
    bridge.listProjects.mockResolvedValue([project(), project({ id: 'prj_2', name: 'Podcast cut' })]);
    render(<ProjectsPage onNavigate={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Actions for Podcast cut' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Actions for Interview clips' })).toBeTruthy();
  });
});

describe('each action reaches the bridge with the right arguments', () => {
  it('renames through updateProject, with the typed name', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Project name');
    fireEvent.change(field, { target: { value: 'Interview clips (final)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(bridge.updateProject).toHaveBeenCalledWith('prj_1', { name: 'Interview clips (final)' }),
    );
  });

  it('refuses an empty name instead of sending one the schema would reject', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Project name');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await screen.findByRole('alert');
    expect(bridge.updateProject).not.toHaveBeenCalled();
  });

  it('reveals the project folder by id', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in folder' }));
    await waitFor(() => expect(bridge.revealProject).toHaveBeenCalledWith('prj_1'));
    /* The menu closes: leaving it open behind a file manager is a stray click waiting to happen. */
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('duplicates by id', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(bridge.duplicateProject).toHaveBeenCalledWith('prj_1'));
  });

  it('archives by writing the flag', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(bridge.updateProject).toHaveBeenCalledWith('prj_1', { archived: true }));
  });

  it('unarchives an archived project, which is what makes it a value rather than a one-way door', async () => {
    /*
      §8: "hides from Home; read-only until unarchived" — so the same slot has to write `false` for
      an already-archived project. The first version of this test only asserted that the label
      changed, and a mutation that always passed `true` survived it: the label is derived from the
      record, not from the action, so the two could disagree forever.
    */
    bridge.listProjects.mockResolvedValue([project({ archived: true })]);
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }));
    await waitFor(() => expect(bridge.updateProject).toHaveBeenCalledWith('prj_1', { archived: false }));
  });

  it('deletes with the store’s own option name, so the media choice is not dropped', async () => {
    /*
      The bug this test exists for: `deleteProject(projectId, { deleteMedia: true })` type-checked
      and did nothing, because `StorageService` reads `deleteExclusiveManagedMedia`. Asserting the
      call alone would have missed it — the *shape of the argument* is the assertion.
    */
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const checkbox = await screen.findByRole('checkbox');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(bridge.deleteProject).toHaveBeenCalledWith('prj_1', {
        deleteExclusiveManagedMedia: true,
      }),
    );
  });

  it('deletes without the media option when the box is left alone', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(bridge.deleteProject).toHaveBeenCalledWith('prj_1', { deleteExclusiveManagedMedia: false }),
    );
  });

  it('closes the delete dialog on Cancel without touching the project', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.deleteProject).not.toHaveBeenCalled();
  });

  it('reports a failure instead of closing as if it had worked', async () => {
    bridge.duplicateProject.mockRejectedValueOnce(new Error('The workspace is read-only.'));
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect((await screen.findByRole('alert')).textContent).toContain('read-only');
  });
});
