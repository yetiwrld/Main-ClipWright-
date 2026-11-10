// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ExportQueuePanel,
  formatElapsed,
  formatRemaining,
  formatSpeed,
} from '../features/export/ExportQueuePanel.js';
import { describeJob, statusLabel, canCancelJob, toExportSettings } from '../features/export/use-export.js';
import type { ExportJobPayload } from '../global.js';
import { DEFAULT_EXPORT_STATE } from '../features/export/ExportPanel.js';

afterEach(() => cleanup());

function makeJob(overrides: Partial<ExportJobPayload> = {}): ExportJobPayload {
  return {
    id: 'job-1',
    compositionId: 'comp-1',
    projectId: 'proj-1',
    name: 'My clip',
    status: 'encoding',
    percent: 37,
    framesDone: 37,
    totalFrames: 100,
    speedFactor: 2.4,
    etaSec: 42,
    message: 'Encoding frame 37 of 100',
    outputPath: '/exports/clip.mp4',
    settingsSnapshot: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(jobs: ExportJobPayload[], handlers: Partial<Parameters<typeof ExportQueuePanel>[0]> = {}) {
  return render(
    <ExportQueuePanel
      jobs={jobs}
      onCancel={handlers.onCancel ?? (() => undefined)}
      onRetry={handlers.onRetry ?? (() => undefined)}
      onDismiss={handlers.onDismiss ?? (() => undefined)}
      onOpenFolder={handlers.onOpenFolder ?? (() => undefined)}
      onReexport={handlers.onReexport ?? (() => undefined)}
      onShowDetails={handlers.onShowDetails ?? (() => undefined)}
    />,
  );
}

describe('formatRemaining', () => {
  it('says Estimating before there is an ETA', () => {
    expect(formatRemaining(null)).toBe('Estimating…');
  });

  it('formats seconds', () => {
    expect(formatRemaining(42)).toBe('42s left');
  });

  it('formats minutes', () => {
    expect(formatRemaining(125)).toBe('2m 05s left');
  });

  it('formats hours', () => {
    expect(formatRemaining(3_725)).toBe('1h 02m left');
  });

  it('treats nonsense as unknown', () => {
    expect(formatRemaining(Number.NaN)).toBe('Estimating…');
    expect(formatRemaining(-5)).toBe('Estimating…');
  });
});

describe('formatElapsed', () => {
  it('formats under a minute', () => {
    expect(formatElapsed(9_000)).toBe('9s');
  });

  it('formats minutes', () => {
    expect(formatElapsed(95_000)).toBe('1:35');
  });

  it('never goes negative', () => {
    expect(formatElapsed(-100)).toBe('0s');
  });
});

describe('formatSpeed', () => {
  it('shows a real-time multiple once measured', () => {
    expect(formatSpeed(2.4)).toBe('2.4× real time');
  });

  it('shows nothing before measurement', () => {
    expect(formatSpeed(0)).toBeNull();
    expect(formatSpeed(Number.NaN)).toBeNull();
  });
});

describe('ExportQueuePanel', () => {
  it('shows an empty state with no jobs', () => {
    renderPanel([]);
    expect(screen.getByTestId('export-queue-empty')).toBeTruthy();
  });

  it('shows a true progress bar backed by the frame counts', () => {
    renderPanel([makeJob()]);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('37');
    expect(screen.getByText('37/100 frames')).toBeTruthy();
  });

  it('shows measured speed and ETA while encoding', () => {
    renderPanel([makeJob()]);
    const summary = screen.getByTestId('export-job-summary-job-1');
    expect(summary.textContent).toContain('2.4× real time');
    expect(summary.textContent).toContain('42s left');
    expect(summary.textContent).toContain('Encoding');
  });

  it('offers Cancel while the job runs', () => {
    const onCancel = vi.fn();
    renderPanel([makeJob()], { onCancel });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledWith('job-1');
  });

  it('shows the verified verdict and offers file actions when done', () => {
    renderPanel([
      makeJob({ status: 'done', validationStatus: 'verified', verdict: 'Done ✓ Verified', percent: 100 }),
    ]);
    expect(screen.getByText('Done ✓ Verified')).toBeTruthy();
    expect(screen.getByText('Show in folder')).toBeTruthy();
    expect(screen.getByText('Re-export')).toBeTruthy();
    expect(screen.queryByText('Cancel')).toBeNull();
  });

  it('distinguishes "done with warnings" from verified', () => {
    renderPanel([
      makeJob({ status: 'done', validationStatus: 'warnings', verdict: 'Done with warnings (2 not confirmed)' }),
    ]);
    expect(screen.getByText('Done with warnings')).toBeTruthy();
    expect(screen.queryByText('Done ✓ Verified')).toBeNull();
  });

  it('shows the plain-language failure and offers Retry', () => {
    const onRetry = vi.fn();
    renderPanel(
      [makeJob({ status: 'failed', error: 'The video encoder stopped unexpectedly.' })],
      { onRetry },
    );
    expect(screen.getByTestId('export-job-error-job-1').textContent).toContain('encoder stopped');
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith('job-1');
  });

  it('opens the output folder for a finished job', () => {
    const onOpenFolder = vi.fn();
    renderPanel([makeJob({ status: 'done', validationStatus: 'verified' })], { onOpenFolder });
    fireEvent.click(screen.getByText('Show in folder'));
    expect(onOpenFolder).toHaveBeenCalledWith('/exports/clip.mp4');
  });

  it('re-exports a finished job', () => {
    const onReexport = vi.fn();
    renderPanel([makeJob({ status: 'done', validationStatus: 'verified' })], { onReexport });
    fireEvent.click(screen.getByText('Re-export'));
    expect(onReexport).toHaveBeenCalled();
  });

  it('shows Details for a failure', () => {
    const onShowDetails = vi.fn();
    renderPanel([makeJob({ status: 'failed', error: 'x' })], { onShowDetails });
    fireEvent.click(screen.getByText('Details'));
    expect(onShowDetails).toHaveBeenCalled();
  });

  it('shows a queued job without a progress bar', () => {
    renderPanel([makeJob({ status: 'queued', percent: 0 })]);
    // The chip says Queued, and the row offers Cancel without a fake bar.
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Cancel (queued)')).toBeTruthy();
  });

  it('dismisses a finished row', () => {
    const onDismiss = vi.fn();
    renderPanel([makeJob({ status: 'cancelled' })], { onDismiss });
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('job-1');
  });

  it('renders several rows, one per job', () => {
    renderPanel([makeJob({ id: 'a', name: 'First' }), makeJob({ id: 'b', name: 'Second' })]);
    expect(screen.getByTestId('export-job-a')).toBeTruthy();
    expect(screen.getByTestId('export-job-b')).toBeTruthy();
  });
});

describe('status helpers', () => {
  it('labels every status in plain words', () => {
    expect(statusLabel('measuring-loudness')).toBe('Measuring loudness');
    expect(statusLabel('verifying')).toBe('Verifying');
  });

  it('describes a job by its outcome when finished', () => {
    expect(describeJob(makeJob({ status: 'done', verdict: 'Done ✓ Verified' }))).toBe('Done ✓ Verified');
    expect(describeJob(makeJob({ status: 'failed', error: 'Disk full.' }))).toBe('Disk full.');
    expect(describeJob(makeJob({ status: 'cancelled' }))).toBe('Cancelled');
  });

  it('describes an active job by its current step', () => {
    expect(describeJob(makeJob({ status: 'encoding', message: 'Encoding frame 5 of 100' }))).toBe(
      'Encoding frame 5 of 100',
    );
  });

  it('knows which rows can be cancelled', () => {
    expect(canCancelJob(makeJob({ status: 'encoding' }))).toBe(true);
    expect(canCancelJob(makeJob({ status: 'queued' }))).toBe(true);
    expect(canCancelJob(makeJob({ status: 'done' }))).toBe(false);
    expect(canCancelJob(makeJob({ status: 'failed' }))).toBe(false);
  });
});

describe('toExportSettings', () => {
  it('maps panel state onto planner settings', () => {
    const settings = toExportSettings({
      panel: { ...DEFAULT_EXPORT_STATE, preset: '4k-uhd', fps: 60, format: 'webm' },
      projectId: 'proj-1',
      compositionId: 'comp-1',
      rangeUs: [1_000_000, 5_000_000],
      compositionDurationUs: 10_000_000,
      compositionFps: 30,
      items: [],
    });
    expect(settings).toMatchObject({
      projectId: 'proj-1',
      compositionId: 'comp-1',
      preset: '4k-uhd',
      fps: 60,
      format: 'webm',
      rangeUs: [1_000_000, 5_000_000],
      compositionFps: 30,
      isDraft: false,
    });
  });

  it('only requests subtitle files when the user asked for them', () => {
    const base = {
      projectId: 'p',
      compositionId: 'c',
      rangeUs: [0, 1] as [number, number],
      compositionDurationUs: 1,
      compositionFps: 30,
      items: [],
    };
    expect(
      toExportSettings({ ...base, panel: { ...DEFAULT_EXPORT_STATE, saveSubtitles: false } }).subtitleFormats,
    ).toEqual([]);
    expect(
      toExportSettings({ ...base, panel: { ...DEFAULT_EXPORT_STATE, saveSubtitles: true } }).subtitleFormats,
    ).toEqual(['srt']);
  });

  it('writes the subtitle formats the user chose, not a hardcoded SRT', () => {
    /*
      SPEC 14 §4 asks for "SRT / WebVTT"; the export core can render both and the profile counts
      the files it expects. `use-export` hardcoded `['srt']`, so a WebVTT file could not be
      produced by a build that had the code for it — and the panel had no control either, so the
      request and the ability were both present and unreachable from each other.
    */
    const settings = (formats: Array<'srt' | 'vtt'>) =>
      toExportSettings({
        projectId: 'p',
        compositionId: 'c',
        rangeUs: [0, 1] as [number, number],
        compositionDurationUs: 1,
        compositionFps: 30,
        items: [],
        panel: { ...DEFAULT_EXPORT_STATE, saveSubtitles: true, subtitleFormats: formats },
      }).subtitleFormats;

    expect(settings(['vtt'])).toEqual(['vtt']);
    expect(settings(['srt', 'vtt'])).toEqual(['srt', 'vtt']);

    /* The toggle is what decides *whether*; naming formats with it off still writes nothing. */
    expect(
      toExportSettings({
        projectId: 'p',
        compositionId: 'c',
        rangeUs: [0, 1] as [number, number],
        compositionDurationUs: 1,
        compositionFps: 30,
        items: [],
        panel: { ...DEFAULT_EXPORT_STATE, saveSubtitles: false, subtitleFormats: ['srt', 'vtt'] },
      }).subtitleFormats,
    ).toEqual([]);
  });

  it('carries the loudness target through', () => {
    const settings = toExportSettings({
      panel: { ...DEFAULT_EXPORT_STATE, normaliseLoudness: true, targetLufs: -14 },
      projectId: 'p',
      compositionId: 'c',
      rangeUs: [0, 1],
      compositionDurationUs: 1,
      compositionFps: 30,
      items: [],
    });
    expect(settings.normaliseLoudness).toBe(true);
    expect(settings.targetLufs).toBe(-14);
  });
});
