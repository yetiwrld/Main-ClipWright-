/**
 * SPEC 14 §6 — renderer-side export state.
 *
 * Subscribes to real progress events from the main process and reads the queue
 * snapshot, so the panel shows measured progress rather than a simulated bar.
 * Every action goes through IPC; nothing here invents a job.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExportJobPayload, ExportQueuePayload, ExportStartRequestPayload } from '../../global.js';
import { api, isDesktop } from '../../api.js';
import type { ExportPanelState } from './ExportPanel.js';

export interface ExportRequestInput {
  name: string;
  projectId: string;
  compositionId: string;
  /** Timeline range in microseconds. */
  rangeUs: [number, number];
  /** Composition duration, for "whole clip" resolution. */
  compositionDurationUs: number;
  /** Composition fps, so the planner can resample. */
  compositionFps: number;
  /** Timeline items to render. */
  items: unknown[];
  outputDir?: string;
  fileName?: string;
  clashPolicy?: 'auto-number' | 'replace' | 'ask';
  fullDecode?: boolean;
}

/** Convert panel state into the settings payload the main process plans from. */
export function toExportSettings(input: {
  panel: ExportPanelState;
  projectId: string;
  compositionId: string;
  rangeUs: [number, number];
  compositionDurationUs: number;
  compositionFps: number;
  items: unknown[];
}): Record<string, unknown> {
  return {
    compositionId: input.compositionId,
    projectId: input.projectId,
    preset: input.panel.preset,
    aspect: input.panel.aspect,
    fps: input.panel.fps,
    format: input.panel.format,
    quality: input.panel.quality,
    rateControl: 'vbr',
    audioBitrate: input.panel.audioBitrate,
    includeAudio: input.panel.includeAudio,
    burnCaptions: input.panel.burnCaptions,
    saveSubtitles: input.panel.saveSubtitles,
    subtitleFormats: input.panel.saveSubtitles ? ['srt'] : [],
    embedProjectName: true,
    normaliseLoudness: input.panel.normaliseLoudness,
    targetLufs: input.panel.targetLufs,
    isDraft: false,
    rangeUs: input.rangeUs,
    compositionFps: input.compositionFps,
    compositionDurationUs: input.compositionDurationUs,
    items: input.items,
  };
}

/** Human label for a queue row. */
export function describeJob(job: ExportJobPayload): string {
  if (job.status === 'done') return job.verdict || 'Done';
  if (job.status === 'failed') return job.error || 'Failed';
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'queued') return 'Queued';
  return job.message || statusLabel(job.status);
}

export function statusLabel(status: ExportJobPayload['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'rendering':
      return 'Rendering';
    case 'measuring-loudness':
      return 'Measuring loudness';
    case 'encoding':
      return 'Encoding';
    case 'finalising':
      return 'Finalising';
    case 'verifying':
      return 'Verifying';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Exporting';
  }
}

/** True while the row should offer Cancel. */
export function canCancelJob(job: ExportJobPayload): boolean {
  return job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled';
}

export interface ExportApi {
  jobs: ExportJobPayload[];
  running: number;
  maxConcurrent: number;
  /** `null` until the first export on this machine measured a speed. */
  averageSpeed: number | null;
  error: string;
  startExport(input: {
    panel: ExportPanelState;
    name: string;
    projectId: string;
    compositionId: string;
    rangeUs: [number, number];
    compositionDurationUs: number;
    compositionFps: number;
    items: unknown[];
    outputDir?: string;
    fileName?: string;
    clashPolicy?: 'auto-number' | 'replace' | 'ask';
    fullDecode?: boolean;
  }): Promise<{ ok: true; jobId: string } | { ok: false; error: string; action: string }>;
  cancel(jobId: string): Promise<void>;
  retry(jobId: string): Promise<void>;
  dismiss(jobId: string): Promise<void>;
  openFolder(path: string): Promise<void>;
  refresh(): Promise<void>;
}

/**
 * Hook over the export queue.
 *
 * Progress events arrive as pushes; the hook also refetches the queue on mount
 * and after every action so a reload shows the true state.
 */
export function useExport(projectId?: string): ExportApi {
  const [queue, setQueue] = useState<ExportQueuePayload>({ jobs: [], running: 0, maxConcurrent: 1 });
  const [averageSpeed, setAverageSpeed] = useState<number | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const next = await api.getExportQueue();
      if (mounted.current) setQueue(next as ExportQueuePayload);
      const speed = await api.getExportSpeed(projectId);
      if (mounted.current) setAverageSpeed(speed);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not read the export queue.');
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    // Progress events keep the row live without polling.
    const unsubscribe = api.onExportProgress((progress) => {
      setQueue((current) => {
        const index = current.jobs.findIndex((job) => job.id === progress.jobId);
        if (index < 0) return current;
        const jobs = [...current.jobs];
        jobs[index] = {
          ...jobs[index],
          status: progress.status,
          percent: Math.round(progress.percent),
          framesDone: progress.framesDone,
          totalFrames: progress.totalFrames,
          speedFactor: progress.speedFactor,
          etaSec: progress.etaSec,
          message: progress.message,
        };
        return { ...current, jobs };
      });
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refresh]);

  // A finished job changes the queue's running count, so refetch on completion.
  const finishedCount = useMemo(
    () => queue.jobs.filter((job) => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled').length,
    [queue.jobs],
  );
  useEffect(() => {
    void refresh();
  }, [finishedCount, refresh]);

  const startExport: ExportApi['startExport'] = useCallback(async (input) => {
    setError('');
    if (!isDesktop()) {
      return { ok: false, error: 'Exporting needs the Clipwright desktop app.', action: 'none' };
    }
    // Job ids are minted here so the renderer can track the row before the
    // main process has answered; the main process echoes it back.
    const jobId = `export-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const settings = toExportSettings({
      panel: input.panel,
      projectId: input.projectId,
      compositionId: input.compositionId,
      rangeUs: input.rangeUs,
      compositionDurationUs: input.compositionDurationUs,
      compositionFps: input.compositionFps,
      items: input.items,
    });
    try {
      const result = await api.startExport({
        jobId,
        name: input.name,
        settings,
        outputDir: input.outputDir,
        fileName: input.fileName,
        clashPolicy: input.clashPolicy ?? 'auto-number',
        fullDecode: input.fullDecode ?? true,
      });
      if (!result.ok) {
        setError(result.error);
        return { ok: false, error: result.error, action: result.action };
      }
      await refresh();
      return { ok: true, jobId: result.job.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The export could not be started.';
      setError(message);
      return { ok: false, error: message, action: 'retry' };
    }
  }, [refresh]);

  const cancel = useCallback(async (jobId: string) => {
    await api.cancelExport(jobId).catch(() => false);
    await refresh();
  }, [refresh]);

  const retry = useCallback(async (jobId: string) => {
    await api.retryExport(jobId).catch(() => null);
    await refresh();
  }, [refresh]);

  const dismiss = useCallback(async (jobId: string) => {
    await api.dismissExport(jobId).catch(() => false);
    await refresh();
  }, [refresh]);

  const openFolder = useCallback(async (path: string) => {
    await api.openExportFolder(path).catch(() => false);
  }, []);

  return {
    jobs: queue.jobs,
    running: queue.running,
    maxConcurrent: queue.maxConcurrent,
    averageSpeed,
    error,
    startExport,
    cancel,
    retry,
    dismiss,
    openFolder,
    refresh,
  };
}
