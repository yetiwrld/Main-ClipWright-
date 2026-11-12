/**
 * In-process job runner. One user-blocking job and up to two background jobs
 * at a time. Cancellation via AbortController. Progress is persisted to the
 * jobs table and broadcast to the renderer at most 10 times per second.
 */
import type { StorageService } from './storage.js';
import type { Logger } from './logging.js';

export interface JobContext {
  storage: StorageService;
  logger: Logger;
  signal: AbortSignal;
  report: (fraction: number, phase?: string) => void;
}

export type JobHandler = (ctx: JobContext, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

type Broadcast = (channel: string, payload: unknown) => void;

export class JobRunner {
  private storage: StorageService;
  private logger: Logger;
  private broadcast: Broadcast;
  private handlers = new Map<string, JobHandler>();
  private controllers = new Map<string, AbortController>();
  private running = 0;
  private runningBackground = 0;
  private maxForeground = 1;
  private maxBackground = 2;
  private busy = false;

  constructor(storage: StorageService, logger: Logger, broadcast: Broadcast) {
    this.storage = storage;
    this.logger = logger;
    this.broadcast = broadcast;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  cancel(jobId: string): boolean {
    const ctrl = this.controllers.get(jobId);
    if (ctrl) { ctrl.abort(); this.storage.updateJob(jobId, { status: 'cancelling' }); return true; }
    if (this.storage.getJob(jobId)) { this.storage.updateJob(jobId, { status: 'cancelled', finishedAt: Date.now() }); return true; }
    return false;
  }

  /** Kick the queue — call after enqueue and on an interval. */
  async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const jobs = this.storage.listActiveJobs().filter((j) => j['status'] === 'queued');
        const next = jobs.find((j) => (j['priority'] === 'user-blocking' ? this.running < this.maxForeground : this.runningBackground < this.maxBackground));
        if (!next) break;
        this.start(next);
      }
    } finally {
      this.busy = false;
    }
  }

  private start(job: Record<string, unknown>): void {
    const id = String(job['id']);
    const type = String(job['type']);
    const handler = this.handlers.get(type);
    const priority = String(job['priority']);
    if (!handler) {
      this.storage.updateJob(id, { status: 'failed', error: `No handler registered for job type "${type}".`, finishedAt: Date.now() });
      return;
    }
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    if (priority === 'user-blocking') this.running += 1; else this.runningBackground += 1;
    this.storage.updateJob(id, { status: 'running', startedAt: Date.now() });

    let lastSent = 0;
    const report = (fraction: number, phase?: string) => {
      const f = Math.max(0, Math.min(1, fraction));
      this.storage.updateJob(id, { progress: f });
      const t = Date.now();
      if (t - lastSent >= 100) { // ≤10 Hz
        lastSent = t;
        this.broadcast('job:progress', { id, progress: f, phase, type });
      }
    };

    const params = safeParseJson(String(job['params_json'] ?? '{}'));

    void handler({ storage: this.storage, logger: this.logger, signal: ctrl.signal, report }, params)
      .then((result) => {
        this.storage.updateJob(id, { status: 'done', progress: 1, finishedAt: Date.now() });
        this.broadcast('job:done', { id, type, result });
      })
      .catch((err: unknown) => {
        const aborted = ctrl.signal.aborted;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Job ${type} failed`, { jobId: id, error: message });
        this.storage.updateJob(id, {
          status: aborted ? 'cancelled' : 'failed',
          error: aborted ? 'Cancelled by the user.' : message.slice(0, 500),
          errorTechnical: message.slice(0, 2000),
          finishedAt: Date.now(),
        });
        this.broadcast('job:failed', { id, type, error: aborted ? 'Cancelled by the user.' : message });
      })
      .finally(() => {
        this.controllers.delete(id);
        if (priority === 'user-blocking') this.running -= 1; else this.runningBackground -= 1;
        void this.pump();
      });
  }
}

const safeParseJson = (s: string): Record<string, unknown> => {
  try { const v = JSON.parse(s) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : {}; }
  catch { return {}; }
};
