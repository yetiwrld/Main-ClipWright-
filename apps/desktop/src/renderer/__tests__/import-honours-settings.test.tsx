// @vitest-environment jsdom
/**
 * The import uses the choices the start screen recorded (SPEC 02 §4.5, §4.6).
 *
 * `ImportStage` sent `quality: '1080p'` and `storageMode: 'managed'` as literals while the start
 * screen had been saving the user's `downloadQuality` and `storageMode` into the project all along.
 *
 * The storage mode is the one with teeth: `media-pipeline` branches on it at `:152` — `reference`
 * leaves the file where it is, `managed` copies it into the library. So a user who chose "keep files
 * where they are" had their video copied, and the import screen said nothing about it. For a large
 * screen recording that is gigabytes the app was told not to take.
 *
 * `quality` is the ceiling for URL downloads (SPEC 02 §4.6); a user who chose 4K got 1080p.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectRoutes } from '../pages/ProjectRoutes.js';

const bridge = vi.hoisted(() => ({
  getProject: vi.fn(),
  startIngest: vi.fn(async (_jobId: string, _request: unknown) => ({ mediaId: 'med_1' })),
  onJobProgress: vi.fn(() => () => undefined),
  cancelJob: vi.fn(async (_jobId: string) => undefined),
  listMedia: vi.fn(async () => []),
  getTranscript: vi.fn(async () => null),
}));

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    getProject: bridge.getProject,
    startIngest: bridge.startIngest,
    onJobProgress: bridge.onJobProgress,
    cancelJob: bridge.cancelJob,
    listMedia: bridge.listMedia,
    getTranscript: bridge.getTranscript,
  },
  describeError: (err: unknown) => String(err),
}));

function project(settings: Record<string, unknown>) {
  return {
    id: 'prj_1',
    name: 'Screen recording',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archived: false,
    stage: 'import',
    sourceMediaIds: [],
    schemaVersion: 2,
    appVersionLastSaved: '1.0.0',
    settings,
  };
}

beforeEach(() => {
  bridge.startIngest.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function startImport(settings: Record<string, unknown>) {
  bridge.getProject.mockResolvedValue(project(settings));
  render(<ProjectRoutes projectId="prj_1" stage="import" onNavigate={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Import video' }));
  await waitFor(() => expect(bridge.startIngest).toHaveBeenCalled());
  return bridge.startIngest.mock.calls[0]![1] as { quality: string; storageMode: string };
}

describe('the import carries the project’s own choices', () => {
  it('keeps a file where it is when the project asked for reference storage', async () => {
    /*
      The setting the start screen offers as "keep files where they are". `startSettings` has
      already translated the page's `copy` into `managed`, so the stored value is the ingest
      vocabulary and nothing here needs translating.
    */
    const request = await startImport({
      sourcePath: '/videos/lecture.mp4',
      storageMode: 'reference',
      downloadQuality: '1080p',
    });
    expect(request.storageMode).toBe('reference');
  });

  it('copies into the library when the project asked for managed storage', async () => {
    const request = await startImport({
      sourcePath: '/videos/lecture.mp4',
      storageMode: 'managed',
      downloadQuality: '1080p',
    });
    expect(request.storageMode).toBe('managed');
  });

  it('downloads at the quality the start screen recorded', async () => {
    const request = await startImport({
      sourcePath: 'https://example.com/talk',
      storageMode: 'managed',
      downloadQuality: '720p',
    });
    expect(request.quality).toBe('720p');
  });

  it('falls back to the old literals for a project that predates the settings', async () => {
    /*
      Projects created before the start screen wrote these keys have no value, and the import must
      still run. `managed` and `1080p` are what the literals were, so an old project behaves as it
      always did — a migration, not a change of behaviour.
    */
    const request = await startImport({ sourcePath: '/videos/lecture.mp4' });
    expect(request).toMatchObject({ storageMode: 'managed', quality: '1080p' });
  });

  it('ignores a stored quality the ingest API does not accept', async () => {
    /* A hand-edited project must not reach the pipeline with a value it cannot handle. */
    const request = await startImport({
      sourcePath: 'https://example.com/talk',
      storageMode: 'managed',
      downloadQuality: '8K',
    });
    expect(request.quality).toBe('1080p');
  });
});
