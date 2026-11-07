/**
 * Spec 04 §9 — Persistent job queue.
 *
 * Backed by the `jobs` table created in the workspace migrations:
 *   jobs(id, type, project_id, media_id, status, priority INTEGER, progress,
 *        attempt, error, started_at, finished_at, payload_json)
 *
 * The integer `priority` column drives ordering (lower runs first); the full
 * record — including the human-readable priority name and job params — is kept
 * in payload_json so a queue row can be reconstructed without guessing.
 */

import type { SqliteDatabase } from '@clipwright/project-schema';

export type JobType =
  | 'probe' | 'copy' | 'download' | 'extract_audio'
  | 'thumbnails' | 'proxy' | 'peaks'
  | 'transcribe' | 'analyse' | 'audio_enhance' | 'auto_reframe' | 'export';

export type JobStatus =
  | 'queued' | 'running' | 'paused' | 'cancelling'
  | 'cancelled' | 'failed' | 'done';

export type PriorityLevel = 'blocking' | 'helper' | 'background';

export interface JobRecord {
  id: string;
  type: JobType;
  projectId: string;
  mediaId?: string;
  params: Record<string, unknown>;
  status: JobStatus;
  priority: PriorityLevel;
  progress: number;
  attempt: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface JobProgress {
  percent: number;
  phase?: string;
  message?: string;
  subSteps?: Array<{ label: string; status: 'pending' | 'running' | 'done' | 'failed' }>;
}

const PRIORITY_WEIGHT: Record<PriorityLevel, number> = {
  blocking: 0,
  helper: 10,
  background: 20,
};

const BLOCKING_TYPES: JobType[] = ['probe', 'copy', 'download', 'extract_audio', 'transcribe', 'export'];

function weightFor(priority: PriorityLevel): number {
  return PRIORITY_WEIGHT[priority] ?? PRIORITY_WEIGHT.helper;
}

export class JobQueue {
  private db: SqliteDatabase;
  private listeners: Array<(job: JobRecord) => void> = [];
  private maxConcurrency = 3;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  onJobUpdate(listener: (job: JobRecord) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(job: JobRecord) {
    for (const listener of this.listeners) listener(job);
  }

  enqueue(job: {
    type: JobType;
    projectId: string;
    mediaId?: string;
    params?: Record<string, unknown>;
    priority?: PriorityLevel;
    id?: string;
  }): JobRecord {
    const record: JobRecord = {
      id: job.id ?? `job_${crypto.randomUUID()}`,
      type: job.type,
      projectId: job.projectId,
      mediaId: job.mediaId,
      params: job.params ?? {},
      status: 'queued',
      priority: job.priority ?? (this.isBlockingType(job.type) ? 'blocking' : 'helper'),
      progress: 0,
      attempt: 0,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO jobs (id, type, project_id, media_id, status, priority, progress, attempt, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.type,
        record.projectId,
        record.mediaId ?? null,
        record.status,
        weightFor(record.priority),
        record.progress,
        record.attempt,
        JSON.stringify(record)
      );

    this.emit(record);
    return record;
  }

  private isBlockingType(type: JobType): boolean {
    return BLOCKING_TYPES.includes(type);
  }

  updateProgress(jobId: string, progress: JobProgress): void {
    const percent = Math.max(0, Math.min(100, progress.percent));
    this.db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(percent, jobId);

    const current = this.get(jobId);
    if (!current) return;

    const next: JobRecord = { ...current, progress: percent };
    this.db
      .prepare('UPDATE jobs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...next, ...(progress.phase ? { phase: progress.phase } : {}) }), jobId);

    this.emit(next);
  }

  setStatus(jobId: string, status: JobStatus, error?: string): void {
    const now = new Date().toISOString();

    if (status === 'running') {
      this.db
        .prepare('UPDATE jobs SET status = ?, started_at = ?, attempt = attempt + 1 WHERE id = ?')
        .run(status, now, jobId);
    } else if (status === 'done' || status === 'cancelled' || status === 'failed') {
      this.db
        .prepare('UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?')
        .run(status, now, error ?? null, jobId);
    } else {
      this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
    }

    const job = this.get(jobId);
    if (!job) return;

    if (status === 'running') {
      this.db
        .prepare('UPDATE jobs SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...job, startedAt: job.startedAt ?? now }), jobId);
    }

    this.emit(job);
  }

  get(jobId: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get<Record<string, unknown>>(jobId);
    return row ? this.rowToJob(row) : undefined;
  }

  private rowToJob(row: Record<string, unknown>): JobRecord {
    let payload: Partial<JobRecord> = {};
    try {
      payload = JSON.parse(String(row.payload_json ?? '{}')) as Partial<JobRecord>;
    } catch {
      payload = {};
    }

    const weight = Number(row.priority ?? PRIORITY_WEIGHT.helper);
    const priority: PriorityLevel =
      payload.priority ??
      (weight <= PRIORITY_WEIGHT.blocking ? 'blocking' : weight >= PRIORITY_WEIGHT.background ? 'background' : 'helper');

    return {
      id: String(row.id),
      type: String(row.type) as JobType,
      projectId: String(payload.projectId ?? row.project_id ?? ''),
      mediaId: (payload.mediaId ?? row.media_id ?? undefined) as string | undefined,
      params: payload.params ?? {},
      status: String(row.status) as JobStatus,
      priority,
      progress: Number(row.progress ?? 0),
      attempt: Number(row.attempt ?? 0),
      error: (row.error ?? undefined) as string | undefined,
      startedAt: (row.started_at ?? undefined) as string | undefined,
      finishedAt: (row.finished_at ?? undefined) as string | undefined,
      createdAt: payload.createdAt ?? new Date().toISOString(),
    };
  }

  /** Jobs for one project, or every job when no project is given. */
  list(projectId?: string): JobRecord[] {
    const rows = projectId
      ? this.db
          .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY priority ASC, started_at ASC')
          .all<Record<string, unknown>>(projectId)
      : this.db.prepare('SELECT * FROM jobs ORDER BY priority ASC, started_at ASC').all<Record<string, unknown>>();

    return rows.map((r) => this.rowToJob(r));
  }

  /** Jobs that should run next, highest priority first. */
  nextQueued(limit = 1): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority ASC, started_at ASC LIMIT ?")
      .all<Record<string, unknown>>(limit);
    return rows.map((r) => this.rowToJob(r));
  }

  /**
   * Cancels a job. A queued job stops immediately; a running job is marked
   * `cancelling` and the worker flips it to `cancelled` once it unwinds.
   */
  cancel(jobId: string): void {
    const job = this.get(jobId);
    if (!job) return;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return;
    this.setStatus(jobId, job.status === 'queued' || job.status === 'paused' ? 'cancelled' : 'cancelling');
  }

  getQueuePosition(jobId: string): number {
    const job = this.get(jobId);
    if (!job) return 0;
    const queued = this.list().filter((j) => j.status === 'queued' && j.priority === job.priority);
    const index = queued.findIndex((j) => j.id === jobId);
    return index + 1;
  }

  /** Re-queues jobs left running by a crash so they retry on next launch. */
  async onLaunchRecover(): Promise<void> {
    this.db.prepare("UPDATE jobs SET status = 'queued' WHERE status IN ('running', 'cancelling')").run();
  }

  setMaxConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, Math.floor(n));
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }
}
