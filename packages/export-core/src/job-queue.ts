/**
 * SPEC 14 §6 — Export job queue model.
 *
 * Pure data and small helpers: no timers, no I/O. The orchestrator lives in
 * `apps/desktop/src/main/export/export-queue.ts`; this module is what both the
 * main process and the renderer can share without pulling in Electron.
 *
 * Progress is expressed both as a 0–100 percentage (what the row shows) and as
 * raw frame counts (what the percentage is derived from), because SPEC 14 §7
 * forbids showing progress that is not backed by work actually done.
 */

export type ExportJobStatus =
  | 'queued'
  | 'rendering'
  | 'measuring-loudness'
  | 'encoding'
  | 'finalising'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Statuses where work is actively happening (and therefore cancellable). */
export const ACTIVE_EXPORT_STATUSES: readonly ExportJobStatus[] = [
  'rendering',
  'measuring-loudness',
  'encoding',
  'finalising',
  'verifying',
];

/** Statuses that will never change again. */
export const FINISHED_EXPORT_STATUSES: readonly ExportJobStatus[] = ['done', 'failed', 'cancelled'];

export interface ExportJob {
  id: string;
  /** Composition this export renders. */
  compositionId: string;
  projectId: string;
  /** Row name, e.g. "Podcast clip 2 — 1080×1920". */
  name: string;
  status: ExportJobStatus;
  /** Overall completion 0–100, weighted across stages. */
  percent: number;
  framesDone: number;
  totalFrames: number;
  /** Measured output speed as a multiple of real time. */
  speedFactor: number;
  /** Seconds remaining; `null` until throughput is stable ("Estimating…"). */
  etaSec: number | null;
  /** Human-readable current step. */
  message: string;
  /** Result of validation, once it ran. */
  validationStatus?: 'verified' | 'warnings' | 'failed';
  /** Precomputed row verdict, e.g. "Done ✓ Verified". */
  verdict?: string;
  /** Plain-language failure cause (SPEC 14 §8: never raw ffmpeg output). */
  error?: string;
  /** Final file path. */
  outputPath: string;
  /** Immutable settings snapshot, so Re-export repeats exactly this output. */
  settingsSnapshot: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ExportQueueState {
  jobs: ExportJob[];
  /** How many jobs are running right now. */
  running: number;
  /** Maximum concurrent exports (§6: 1 by default, 2 for CPU-only encodes). */
  maxConcurrent: number;
}

export function createExportJob(options: {
  id: string;
  name: string;
  projectId: string;
  compositionId: string;
  totalFrames: number;
  settingsSnapshot: Record<string, unknown>;
  outputPath: string;
  createdAt?: string;
}): ExportJob {
  return {
    id: options.id,
    compositionId: options.compositionId,
    projectId: options.projectId,
    name: options.name,
    status: 'queued',
    percent: 0,
    framesDone: 0,
    totalFrames: options.totalFrames,
    speedFactor: 0,
    etaSec: null,
    message: 'Queued',
    outputPath: options.outputPath,
    settingsSnapshot: options.settingsSnapshot,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

/** Apply a status change, keeping the derived fields consistent. */
export function updateJobStatus(
  job: ExportJob,
  status: ExportJobStatus,
  patch: Partial<Omit<ExportJob, 'id' | 'status'>> = {},
): ExportJob {
  const next: ExportJob = {
    ...job,
    ...patch,
    status,
    percent: patch.percent !== undefined ? Math.min(100, Math.max(0, patch.percent)) : job.percent,
  };
  if (status === 'done') next.percent = 100;
  if (status === 'cancelled') {
    next.percent = 0;
    next.verdict = 'Cancelled';
  }
  if (FINISHED_EXPORT_STATUSES.includes(status)) {
    next.finishedAt = patch.finishedAt ?? new Date().toISOString();
  }
  if (status === 'rendering' && !next.startedAt) {
    next.startedAt = new Date().toISOString();
  }
  return next;
}

/** Row order: active work first, then queued, then finished (newest first). */
export function sortJobs(jobs: ExportJob[]): ExportJob[] {
  const rank = (job: ExportJob): number => {
    if (ACTIVE_EXPORT_STATUSES.includes(job.status)) return 0;
    if (job.status === 'queued') return 1;
    return 2;
  };
  return [...jobs].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) === 2) {
      // Finished: newest first, which is what a user expects after an export.
      return (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt);
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function filterJobsByStatus(jobs: ExportJob[], statuses: ExportJobStatus[]): ExportJob[] {
  return jobs.filter((job) => statuses.includes(job.status));
}

/** True when the row should show a Cancel button. */
export function isCancellable(job: ExportJob): boolean {
  return job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled';
}

/** ETA in seconds from elapsed time and completion percentage. */
export function calculateEta(elapsedMs: number, percent: number): number | null {
  if (percent <= 0 || percent >= 100) return null;
  const totalMs = (elapsedMs / percent) * 100;
  return Math.max(0, Math.round((totalMs - elapsedMs) / 1000));
}

/**
 * Output speed as a multiple of real time.
 *
 * `framesDone` frames of a `fps` timeline is `framesDone / fps` seconds of
 * output; dividing by the wall-clock seconds gives "2.4× real time".
 */
export function calculateSpeed(framesDone: number, fps: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || fps <= 0 || framesDone <= 0) return 0;
  const outputSeconds = framesDone / fps;
  return outputSeconds / (elapsedMs / 1000);
}

/** One-line row summary, as shown in the queue ("2.4× real time · 0:42 left"). */
export function formatJobSummary(job: ExportJob): string {
  const parts: string[] = [];
  if (ACTIVE_EXPORT_STATUSES.includes(job.status)) {
    if (job.speedFactor > 0) parts.push(`${job.speedFactor.toFixed(1)}× real time`);
    parts.push(job.etaSec === null ? 'Estimating…' : `${formatEta(job.etaSec)} left`);
  }
  if (job.status === 'queued') parts.push('Waiting');
  if (job.verdict) parts.push(job.verdict);
  if (job.totalFrames > 0) parts.push(`${job.framesDone}/${job.totalFrames} frames`);
  return parts.join(' · ');
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Estimating…';
  if (seconds < 60) return `0:${String(Math.round(seconds)).padStart(2, '0')}`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
