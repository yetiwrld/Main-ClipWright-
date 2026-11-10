// @vitest-environment jsdom
/**
 * The Moments screen's content-type control (SPEC 07 §6.2).
 *
 * Two bugs lived in six lines here, and neither had a test:
 *
 * 1. The toast said "Content type saved" and the handler wrote nothing. The value went into React
 *    state and out again on the next mount, so the dropdown silently reverted.
 * 2. The dropdown offered `talking_head` — ai-core's spelling. The project schema stores `talking`,
 *    so the value it "saved" would have been rejected by `ProjectRecordSchema` had anything tried
 *    to save it.
 *
 * Both are invisible from the screen: the select shows the value you picked until the page reloads,
 * and a failed write shows a toast nobody reads after the first frame.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MomentsPage } from '../pages/MomentsPage.js';

const bridge = vi.hoisted(() => ({
  getProject: vi.fn(),
  getTranscript: vi.fn(),
  listMoments: vi.fn(),
  listMedia: vi.fn(),
  onMomentsProgress: vi.fn(() => () => undefined),
  updateProject: vi.fn(),
}));

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    getProject: bridge.getProject,
    getTranscript: bridge.getTranscript,
    listMoments: bridge.listMoments,
    listMedia: bridge.listMedia,
    onMomentsProgress: bridge.onMomentsProgress,
    updateProject: bridge.updateProject,
    analyzeMoments: vi.fn(),
    createClips: vi.fn(),
    rescoreMoment: vi.fn(),
    updateMoment: vi.fn(),
    addManualMoment: vi.fn(),
  },
  describeError: (err: unknown) => String(err),
}));

function project(settings: Record<string, unknown> = {}) {
  return {
    id: 'prj_1',
    name: 'Interview clips',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archived: false,
    stage: 'moments',
    sourceMediaIds: ['med_1'],
    schemaVersion: 2,
    appVersionLastSaved: '1.0.0',
    settings: { aspect: '9:16', captionStyleId: 'karaoke', contentType: 'auto', ...settings },
  };
}

beforeEach(() => {
  bridge.getProject.mockResolvedValue(project());
  bridge.getTranscript.mockResolvedValue(null);
  bridge.listMoments.mockResolvedValue([]);
  bridge.listMedia.mockResolvedValue([{ id: 'med_1' }]);
  bridge.updateProject.mockImplementation(async (_id: string, patch: { settings?: Record<string, unknown> }) => ({
    ...project(),
    settings: { ...project().settings, ...(patch.settings ?? {}) },
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * `Select` is the design system's listbox, not a native `<select>`: a button that opens a
 * `role="listbox"` of `role="option"` buttons. Driving it through `fireEvent.change` — which is what
 * a native select would want — silently does nothing, and a test that did that would pass on a page
 * that never saved anything.
 */
async function chooseContentType(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Content type' }));
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

/** The trigger's visible text, which is the label of the selected option. */
async function selectedLabel() {
  return (await screen.findByRole('button', { name: 'Content type' })).textContent;
}

describe('the content type is a project setting, and is saved as one', () => {
  it('writes the choice to the project instead of only to local state', async () => {
    render(<MomentsPage projectId="prj_1" onNavigate={() => undefined} />);
    await chooseContentType('Tutorial');

    await waitFor(() =>
      expect(bridge.updateProject).toHaveBeenCalledWith('prj_1', { settings: { contentType: 'tutorial' } }),
    );
  });

  it('sends one setting, relying on the store to merge the rest', async () => {
    /*
      The assertion above pins the shape. This one pins the *reason*: the call must not carry the
      whole settings object, because a caller that spread it would write back a stale copy — and
      the store's merge would never be exercised, so a regression there would go unnoticed until a
      user's aspect ratio changed on its own.
    */
    render(<MomentsPage projectId="prj_1" onNavigate={() => undefined} />);
    await chooseContentType('Gaming');
    await waitFor(() => expect(bridge.updateProject).toHaveBeenCalled());
    const patch = bridge.updateProject.mock.calls[0]![1] as { settings: Record<string, unknown> };
    expect(Object.keys(patch.settings)).toEqual(['contentType']);
  });

  it('offers the schema’s spelling of talking head, not the analyser’s', async () => {
    /*
      The option the project schema accepts is `talking`. `talking_head` is ai-core's name for the
      same profile and the analyser translates it at its own boundary; a value that only one of the
      two understands must not be written into a project file.
    */
    render(<MomentsPage projectId="prj_1" onNavigate={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Content type' }));
    const labels = (await screen.findAllByRole('option')).map((option) => option.textContent);
    /*
      The option is labelled "Talking head" in both vocabularies, so the *label* cannot tell them
      apart — the value can. Reading it off the DOM is the only way from here, and the assertion is
      about which value a click would send.
    */
    expect(labels).toContain('Talking head');
    fireEvent.click(screen.getByRole('option', { name: 'Talking head' }));
    await waitFor(() =>
      expect(bridge.updateProject).toHaveBeenCalledWith('prj_1', { settings: { contentType: 'talking' } }),
    );
  });

  it('puts the control back when the write fails', async () => {
    /*
      A dropdown that keeps a value the project does not hold is the same lie the toast was. The
      project here starts on `auto`; a failed write must leave it showing `auto`.
    */
    bridge.updateProject.mockRejectedValueOnce(new Error('disk full'));
    render(<MomentsPage projectId="prj_1" onNavigate={() => undefined} />);
    expect(await selectedLabel()).toBe('Auto');
    await chooseContentType('Lecture');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Content type' }).textContent).toBe('Auto'));
  });
});
