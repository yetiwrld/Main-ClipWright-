import { describe, expect, it } from 'vitest';
import {
  ACTIVE_EXPORT_STATUSES,
  FINISHED_EXPORT_STATUSES,
  calculateEta,
  calculateSpeed,
  createExportJob,
  filterJobsByStatus,
  formatEta,
  formatJobSummary,
  isCancellable,
  sortJobs,
  updateJobStatus,
  type ExportJob,
} from '../job-queue.js';

function makeJob(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    ...createExportJob({
      id: 'job-1',
      name: 'Clip 1',
      projectId: 'proj-1',
      compositionId: 'comp-1',
      totalFrames: 300,
      settingsSnapshot: {},
      outputPath: '/exports/clip-1.mp4',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    ...overrides,
  };
}

describe('createExportJob', () => {
  it('starts queued with no progress', () => {
    const job = makeJob();
    expect(job.status).toBe('queued');
    expect(job.percent).toBe(0);
    expect(job.framesDone).toBe(0);
    expect(job.etaSec).toBeNull();
    expect(job.verdict).toBeUndefined();
  });

  it('carries the frames it was given so progress can be expressed in frames', () => {
    expect(makeJob().totalFrames).toBe(300);
  });
});

describe('updateJobStatus', () => {
  it('records a start time the first time work begins', () => {
    const job = updateJobStatus(makeJob(), 'rendering');
    expect(job.status).toBe('rendering');
    expect(job.startedAt).toBeTruthy();
  });

  it('clamps percent into 0..100', () => {
    expect(updateJobStatus(makeJob(), 'encoding', { percent: 140 }).percent).toBe(100);
    expect(updateJobStatus(makeJob(), 'encoding', { percent: -5 }).percent).toBe(0);
  });

  it('forces 100 percent when done', () => {
    expect(updateJobStatus(makeJob(), 'done', { percent: 42 }).percent).toBe(100);
  });

  it('records a finish time for terminal statuses', () => {
    for (const status of FINISHED_EXPORT_STATUSES) {
      const job = updateJobStatus(makeJob(), status);
      expect(job.finishedAt, status).toBeTruthy();
    }
  });

  it('does not mark an in-progress job as finished', () => {
    for (const status of ACTIVE_EXPORT_STATUSES) {
      expect(updateJobStatus(makeJob(), status).finishedAt, status).toBeUndefined();
    }
  });

  it('labels a cancelled job and clears the bar', () => {
    const job = updateJobStatus(makeJob(), 'cancelled', { percent: 60 });
    expect(job.percent).toBe(0);
    expect(job.verdict).toBe('Cancelled');
  });

  it('keeps the failed reason in plain language', () => {
    const job = updateJobStatus(makeJob(), 'failed', { error: 'The video encoder stopped unexpectedly.' });
    expect(job.error).toBe('The video encoder stopped unexpectedly.');
  });
});

describe('sortJobs', () => {
  it('puts active work first, then queued, then finished', () => {
    const done = makeJob({ id: 'done', status: 'done', finishedAt: '2026-01-01T02:00:00.000Z' });
    const queued = makeJob({ id: 'queued', status: 'queued' });
    const running = makeJob({ id: 'running', status: 'encoding' });
    expect(sortJobs([done, queued, running]).map((job) => job.id)).toEqual(['running', 'queued', 'done']);
  });

  it('shows the newest finished job first', () => {
    const older = makeJob({ id: 'older', status: 'done', finishedAt: '2026-01-01T01:00:00.000Z' });
    const newer = makeJob({ id: 'newer', status: 'done', finishedAt: '2026-01-01T03:00:00.000Z' });
    expect(sortJobs([older, newer]).map((job) => job.id)).toEqual(['newer', 'older']);
  });

  it('queues in arrival order', () => {
    const first = makeJob({ id: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
    const second = makeJob({ id: 'second', createdAt: '2026-01-01T00:01:00.000Z' });
    expect(sortJobs([second, first]).map((job) => job.id)).toEqual(['first', 'second']);
  });

  it('does not mutate the input', () => {
    const jobs = [makeJob({ id: 'a', status: 'done' }), makeJob({ id: 'b', status: 'encoding' })];
    const before = jobs.map((job) => job.id);
    sortJobs(jobs);
    expect(jobs.map((job) => job.id)).toEqual(before);
  });
});

describe('filterJobsByStatus', () => {
  it('keeps only the requested statuses', () => {
    const jobs = [makeJob({ id: 'a', status: 'done' }), makeJob({ id: 'b', status: 'encoding' })];
    expect(filterJobsByStatus(jobs, ['done']).map((job) => job.id)).toEqual(['a']);
  });
});

describe('isCancellable', () => {
  it('is true while work is in progress or queued', () => {
    expect(isCancellable(makeJob({ status: 'queued' }))).toBe(true);
    expect(isCancellable(makeJob({ status: 'encoding' }))).toBe(true);
  });

  it('is false once the job has finished', () => {
    for (const status of FINISHED_EXPORT_STATUSES) {
      expect(isCancellable(makeJob({ status })), status).toBe(false);
    }
  });
});

describe('calculateEta', () => {
  it('returns null before any progress ("Estimating…")', () => {
    expect(calculateEta(1_000, 0)).toBeNull();
  });

  it('returns null once complete', () => {
    expect(calculateEta(1_000, 100)).toBeNull();
  });

  it('extrapolates remaining time from the rate so far', () => {
    // 10 s elapsed for 25% → 40 s total → 30 s left.
    expect(calculateEta(10_000, 25)).toBe(30);
  });

  it('never goes negative', () => {
    expect(calculateEta(10_000, 150)).toBeNull();
  });
});

describe('calculateSpeed', () => {
  it('reports output seconds per wall-clock second', () => {
    // 300 frames at 30 fps = 10 s of output in 4 s of work → 2.5×.
    expect(calculateSpeed(300, 30, 4_000)).toBeCloseTo(2.5);
  });

  it('is zero before anything is rendered', () => {
    expect(calculateSpeed(0, 30, 1_000)).toBe(0);
  });

  it('is zero without elapsed time', () => {
    expect(calculateSpeed(10, 30, 0)).toBe(0);
  });
});

describe('formatEta', () => {
  it('formats under a minute', () => {
    expect(formatEta(42)).toBe('0:42');
  });

  it('formats minutes', () => {
    expect(formatEta(125)).toBe('2:05');
  });

  it('formats hours', () => {
    expect(formatEta(3_725)).toBe('1:02:05');
  });

  it('says Estimating for nonsense', () => {
    expect(formatEta(Number.NaN)).toBe('Estimating…');
    expect(formatEta(-1)).toBe('Estimating…');
  });
});

describe('formatJobSummary', () => {
  it('shows speed and remaining time while encoding', () => {
    const job = makeJob({ status: 'encoding', speedFactor: 2.4, etaSec: 42, framesDone: 150 });
    expect(formatJobSummary(job)).toContain('2.4× real time');
    expect(formatJobSummary(job)).toContain('0:42 left');
  });

  it('says Estimating before throughput is stable', () => {
    const job = makeJob({ status: 'encoding', etaSec: null });
    expect(formatJobSummary(job)).toContain('Estimating…');
  });

  it('shows the verdict on a finished job', () => {
    const job = makeJob({ status: 'done', verdict: 'Done ✓ Verified' });
    expect(formatJobSummary(job)).toContain('Done ✓ Verified');
  });

  it('shows waiting for a queued job', () => {
    expect(formatJobSummary(makeJob({ status: 'queued' }))).toContain('Waiting');
  });
});
