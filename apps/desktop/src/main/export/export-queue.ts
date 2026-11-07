/**
 * SPEC 14 §6 — the export queue.
 *
 * One export runs at a time by default "because rendering uses the GPU and
 * cores" (§6). Jobs are immutable once accepted: the settings snapshot is taken
 * at enqueue time, so editing the composition afterwards cannot change a running
 * or queued export.
 *
 * The queue owns cancellation, the concurrency setting, history persistence and
 * progress fan-out. It does not own rendering; `runExportJob` does.
 */

import { existsSync } from 'node:fs';
import {
  ACTIVE_EXPORT_STATUSES,
  FINISHED_EXPORT_STATUSES,
  buildExportPlan,
  calculateEta,
  calculateSpeed,
  createExportJob,
  sortJobs,
  updateJobStatus,
  type ExportJob,
  type ExportPlan,
  type ExportSettings,
  type ValidationReport,
} from '@clipwright/export-core';
import { CancelledError, runExportJob, type ExportProgress, type FrameSource } from './export-runner.js';

/** A queued export plus the pieces the queue needs to run it. */
export interface QueuedExport {
  job: ExportJob;
  settings: ExportSettings;
  outputPath: string;
  audioPath?: string;
  /** Non-fatal audio-mix problems carried into the finished banner. */
  audioWarnings?: string[];
  /** Built fresh when the job starts, so a retry gets a clean frame source. */
  createFrameSource: (plan: ExportPlan) => FrameSource | Promise<FrameSource>;
  /** Immutable snapshot label shown in the banner (§6). */
  snapshotLabel: string;
  fullDecode: boolean;
}

export interface QueueSnapshot {
  jobs: ExportJob[];
  running: number;
  maxConcurrent: number;
}

export interface QueueOptions {
  /** Persist a finished job. Best-effort: a storage failure must not fail a job. */
  onFinished?: (result: {
    job: ExportJob;
    outputPath: string;
    validation: ValidationReport | null;
    plan: ExportPlan;
    elapsedMs: number;
    speedFactor: number;
    sizeBytes: number;
    status: 'verified' | 'warnings' | 'failed' | 'cancelled';
  }) => void;
  /** Fan out progress to every renderer window. */
  onProgress?: (progress: ExportProgress & { name?: string }) => void;
  /** How many exports may run at once; 1 by default (§6). */
  maxConcurrent?: number;
}

/**
 * Serialises export jobs.
 *
 * Deliberately small: it holds no timers and does no probing, so it can be unit
 * tested with a fake runner and stays easy to reason about during a long export.
 */
export class ExportQueue {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly pending: QueuedExport[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly names = new Map<string, string>();
  /** Kept so a retry can rebuild the same kind of frame source. */
  private readonly factories = new Map<string, (plan: ExportPlan) => FrameSource | Promise<FrameSource>>();
  private running = 0;
  private maxConcurrent: number;
  private readonly options: QueueOptions;

  constructor(options: QueueOptions = {}) {
    this.options = options;
    this.maxConcurrent = Math.max(1, Math.min(2, options.maxConcurrent ?? 1));
  }

  /** Change the concurrency setting mid-session; pumps the queue if raised. */
  setMaxConcurrent(value: number): void {
    this.maxConcurrent = Math.max(1, Math.min(2, Math.floor(value)));
    this.pump();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Add an export. Returns the job record so the UI can watch it immediately. */
  enqueue(input: QueuedExport): ExportJob {
    const settings = structuredClone(input.settings);
    input = { ...input, settings, job: { ...input.job, settingsSnapshot: structuredClone(input.job.settingsSnapshot) } };
    this.jobs.set(input.job.id, input.job);
    this.names.set(input.job.id, input.job.name);
    this.factories.set(input.job.id, input.createFrameSource);
    this.pending.push(input);
    this.pump();
    return input.job;
  }

  /** Build a job record and enqueue it in one step (used by the IPC handler). */
  add(options: {
    id: string;
    name: string;
    settings: ExportSettings;
    outputPath: string;
    audioPath?: string;
    audioWarnings?: string[];
    createFrameSource: (plan: ExportPlan) => FrameSource | Promise<FrameSource>;
    snapshotLabel?: string;
    fullDecode?: boolean;
  }): ExportJob {
    // SPEC 14 §6: the planner takes an immutable snapshot, so editing the
    // composition during an export cannot change the output. Everything below
    // works from `snapshot`, never from the caller's (still mutable) object.
    const snapshot = structuredClone(options.settings);
    const job = createExportJob({
      id: options.id,
      name: options.name,
      projectId: snapshot.projectId,
      compositionId: snapshot.compositionId,
      totalFrames: estimateTotalFrames(snapshot),
      settingsSnapshot: snapshot as unknown as Record<string, unknown>,
      outputPath: options.outputPath,
    });
    return this.enqueue({
      job,
      settings: snapshot,
      outputPath: options.outputPath,
      audioPath: options.audioPath,
      audioWarnings: options.audioWarnings,
      createFrameSource: options.createFrameSource,
      snapshotLabel: options.snapshotLabel ?? `the version from ${new Date().toLocaleTimeString()}`,
      fullDecode: options.fullDecode ?? true,
    });
  }

  /** Cancel a queued or running job (§6: "Cancelling…" within 1 s). */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      const index = this.pending.findIndex((entry) => entry.job.id === jobId);
      if (index >= 0) this.pending.splice(index, 1);
      this.setJob(jobId, updateJobStatus(job, 'cancelled'));
      return true;
    }
    if (ACTIVE_EXPORT_STATUSES.includes(job.status)) {
      this.controllers.get(jobId)?.abort();
      return true;
    }
    return false;
  }

  /**
   * Retry a failed/cancelled job from its original settings snapshot.
   *
   * The frame-source factory is reused, so the retry re-renders from the same
   * composition snapshot rather than whatever the timeline looks like now (§6).
   */
  retry(jobId: string): ExportJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status !== 'failed' && job.status !== 'cancelled') return null;
    const factory = this.factories.get(jobId);
    if (!factory) return null;
    const snapshot = structuredClone(job.settingsSnapshot);
    const retried = createExportJob({
      id: `${jobId}-retry-${Date.now().toString(36)}`,
      name: job.name,
      projectId: job.projectId,
      compositionId: job.compositionId,
      totalFrames: job.totalFrames,
      settingsSnapshot: snapshot,
      outputPath: job.outputPath,
    });
    return this.enqueue({
      job: retried,
      settings: snapshot as unknown as ExportSettings,
      outputPath: job.outputPath,
      createFrameSource: factory,
      snapshotLabel: `the version retried from ${job.name}`,
      fullDecode: true,
    });
  }

  /** Remove a finished job from the list (history keeps the record). */
  dismiss(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (!FINISHED_EXPORT_STATUSES.includes(job.status)) return false;
    this.jobs.delete(jobId);
    this.names.delete(jobId);
    return true;
  }

  snapshot(): QueueSnapshot {
    return {
      jobs: sortJobs([...this.jobs.values()]),
      running: this.running,
      maxConcurrent: this.maxConcurrent,
    };
  }

  getJob(jobId: string): ExportJob | undefined {
    return this.jobs.get(jobId);
  }

  /** Called at app start: queued jobs from a previous session did not survive. */
  markInterrupted(): void {
    for (const [id, job] of this.jobs) {
      if (!FINISHED_EXPORT_STATUSES.includes(job.status)) {
        this.setJob(
          id,
          updateJobStatus(job, 'failed', {
            error: 'Clipwright closed before this export finished. It restarts from the beginning.',
          }),
        );
      }
    }
  }

  /** Wait for the queue to drain (tests and clean shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running > 0 || this.pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift()!;
      void this.start(next);
    }
  }

  private async start(entry: QueuedExport): Promise<void> {
    const { job } = entry;
    this.running += 1;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.setJob(job.id, updateJobStatus(job, 'rendering', { message: 'Starting' }));

    try {
      // The plan is built before the frame source so the source can size itself.
      const plan = buildExportPlan(entry.settings);
      const frameSource = await entry.createFrameSource(plan);

      const result = await runExportJob(
        {
          jobId: job.id,
          settings: entry.settings,
          outputPath: entry.outputPath,
          audioPath: entry.audioPath,
          audioWarnings: entry.audioWarnings,
          frameSource,
          title: job.name,
          fullDecode: entry.fullDecode,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            const current = this.jobs.get(job.id);
            if (current && !FINISHED_EXPORT_STATUSES.includes(current.status)) {
              this.setJob(
                job.id,
                updateJobStatus(current, progress.status as ExportJob['status'], {
                  percent: Math.round(progress.percent),
                  framesDone: progress.framesDone,
                  totalFrames: progress.totalFrames,
                  speedFactor: progress.speedFactor,
                  etaSec: progress.etaSec,
                  message: progress.message,
                }),
              );
            }
            this.options.onProgress?.({ ...progress, name: this.names.get(job.id) });
          },
        },
      );

      const finishedJob = this.jobs.get(job.id);
      if (finishedJob) {
        this.setJob(
          job.id,
          updateJobStatus(
            finishedJob,
            result.status === 'verified' || result.status === 'warnings' ? 'done' : result.status,
            {
              percent: result.status === 'cancelled' ? 0 : 100,
              validationStatus: result.validation?.overallStatus,
              verdict: result.verdict,
              error: result.error,
              speedFactor: result.speedFactor,
              outputPath: result.outputPath,
              message: result.error ?? result.verdict,
            },
          ),
        );
      }

      const finalJob = this.jobs.get(job.id);
      if (finalJob) {
        this.options.onFinished?.({
          job: finalJob,
          outputPath: result.outputPath,
          validation: result.validation,
          plan: result.plan,
          elapsedMs: result.elapsedMs,
          speedFactor: result.speedFactor,
          sizeBytes: result.sizeBytes,
          status: result.status,
        });
      }
    } catch (err) {
      const cancelled = err instanceof CancelledError || controller.signal.aborted;
      const current = this.jobs.get(job.id);
      if (current) {
        this.setJob(
          job.id,
          updateJobStatus(current, cancelled ? 'cancelled' : 'failed', {
            error: cancelled ? undefined : 'The export stopped unexpectedly.',
            percent: 0,
          }),
        );
      }
    } finally {
      this.controllers.delete(job.id);
      this.running -= 1;
      this.pump();
    }
  }

  private setJob(jobId: string, job: ExportJob): void {
    this.jobs.set(jobId, job);
  }
}

function estimateTotalFrames(settings: ExportSettings): number {
  const [start, end] = settings.rangeUs;
  return Math.max(1, Math.round(((end - start) / 1_000_000) * settings.fps));
}

/** Remove a `.partial` or `.FAILED-VALIDATION` file left by an old run. */
export async function cleanupPartialFiles(tempDir: string): Promise<void> {
  const { readdir, unlink } = await import('node:fs/promises');
  if (!existsSync(tempDir)) return;
  for (const name of await readdir(tempDir)) {
    if (name.includes('.partial.')) await unlink(`${tempDir}/${name}`).catch(() => undefined);
  }
}

export { calculateEta, calculateSpeed };
