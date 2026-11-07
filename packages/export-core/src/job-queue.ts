/**
 * SPEC 14 §6 — Export job queue.
 *
 * Tracks export jobs and their status. Jobs run one at a time by default
 * (GPU rendering). The queue persists across restarts for resume.
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

export interface ExportJob {
  id: string;
  planId: string;
  compositionId: string;
  projectId: string;
  name: string;
  status: ExportJobStatus;
  progress: number;
  /** Elapsed time in milliseconds. */
  elapsedMs: number;
  /** Estimated remaining time in milliseconds. */
  etaMs: number;
  /** Current render speed as a multiplier of real time. */
  speed: number;
  /** Error message if failed. */
  error?: string;
  /** Output file path. */
  outputPath?: string;
  /** Validation report ID. */
  validationReportId?: string;
  /** Whether the job was restarted after a restart. */
  restarted: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExportQueueState {
  jobs: ExportJob[];
  /** Whether the queue is currently running a job. */
  running: boolean;
  /** Maximum concurrent exports (1 for GPU, 2 for CPU-only). */
  maxConcurrent: number;
}

/** Create a new export job. */
export function createExportJob(
  planId: string,
  compositionId: string,
  projectId: string,
  name: string,
): ExportJob {
  return {
    id: `export-${planId}-${Date.now()}`,
    planId,
    compositionId,
    projectId,
    name,
    status: 'queued',
    progress: 0,
    elapsedMs: 0,
    etaMs: 0,
    speed: 0,
    restarted: false,
    createdAt: new Date().toISOString(),
  };
}

/** Update a job's status and progress. */
export function updateJobStatus(
  job: ExportJob,
  status: ExportJobStatus,
  progress: number,
): ExportJob {
  return {
    ...job,
    status,
    progress: Math.max(0, Math.min(1, progress)),
  };
}

/** Sort jobs: running first, then queued, then completed/failed. */
export function sortJobs(jobs: ExportJob[]): ExportJob[] {
  const statusOrder: Record<ExportJobStatus, number> = {
    'rendering': 0,
    'measuring-loudness': 0,
    'encoding': 0,
    'finalising': 0,
    'verifying': 0,
    'queued': 1,
    'done': 2,
    'failed': 2,
    'cancelled': 2,
  };
  return [...jobs].sort((a, b) => {
    const order = statusOrder[a.status] - statusOrder[b.status];
    if (order !== 0) return order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Filter jobs by status. */
export function filterJobsByStatus(
  jobs: ExportJob[],
  statuses: ExportJobStatus[],
): ExportJob[] {
  return jobs.filter((job) => statuses.includes(job.status));
}

/** Calculate ETA from elapsed time and progress. */
export function calculateEta(elapsedMs: number, progress: number): number {
  if (progress <= 0) return 0;
  const remaining = elapsedMs / progress - elapsedMs;
  return Math.max(0, Math.round(remaining));
}

/** Calculate render speed from frames rendered and elapsed time. */
export function calculateSpeed(
  framesRendered: number,
  totalFrames: number,
  elapsedMs: number,
): number {
  if (elapsedMs <= 0) return 0;
  const durationSeconds = (framesRendered / totalFrames) * (elapsedMs / 1000);
  if (durationSeconds <= 0) return 0;
  return elapsedMs / 1000 / durationSeconds;
}
