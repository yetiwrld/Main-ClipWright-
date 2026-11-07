import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '@clipwright/project-schema';
import { JobQueue } from '../job-queue.js';

function createDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_id TEXT,
      media_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 10,
      progress REAL NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority);
  `);
  return db;
}

let queue: JobQueue;

beforeEach(() => {
  queue = new JobQueue(createDb());
});

describe('JobQueue', () => {
  it('enqueues a job as queued with zero progress', () => {
    const job = queue.enqueue({ type: 'probe', projectId: 'p1' });
    expect(job.status).toBe('queued');
    expect(job.progress).toBe(0);
    expect(job.attempt).toBe(0);
    expect(job.id).toBeTruthy();
  });

  it('assigns blocking priority to foreground types and helper to others', () => {
    const probe = queue.enqueue({ type: 'probe', projectId: 'p1' });
    const proxy = queue.enqueue({ type: 'proxy', projectId: 'p1' });
    expect(probe.priority).toBe('blocking');
    expect(proxy.priority).toBe('helper');
  });

  it('keeps an explicit priority', () => {
    const job = queue.enqueue({ type: 'transcribe', projectId: 'p1', priority: 'background' });
    expect(job.priority).toBe('background');
  });

  it('returns every job for a project, newest first is not required but all must appear', () => {
    queue.enqueue({ type: 'probe', projectId: 'p1' });
    queue.enqueue({ type: 'thumbnails', projectId: 'p1' });
    queue.enqueue({ type: 'probe', projectId: 'p2' });

    expect(queue.list('p1')).toHaveLength(2);
    expect(queue.list()).toHaveLength(3);
  });

  it('round-trips params through the database', () => {
    const job = queue.enqueue({ type: 'download', projectId: 'p1', params: { url: 'https://example.com/a.mp4', quality: '1080p' } });
    const reloaded = queue.get(job.id);
    expect(reloaded?.params).toEqual({ url: 'https://example.com/a.mp4', quality: '1080p' });
  });

  it('records progress updates', () => {
    const job = queue.enqueue({ type: 'transcribe', projectId: 'p1' });
    queue.updateProgress(job.id, { percent: 42, phase: 'Running Whisper' });
    expect(queue.get(job.id)?.progress).toBe(42);
  });

  it('marks a job cancelled and keeps it queryable', () => {
    const job = queue.enqueue({ type: 'download', projectId: 'p1' });
    queue.cancel(job.id);
    expect(queue.get(job.id)?.status).toBe('cancelled');
  });

  it('records failures with their error text', () => {
    const job = queue.enqueue({ type: 'download', projectId: 'p1' });
    queue.setStatus(job.id, 'failed', 'Network unreachable');
    const reloaded = queue.get(job.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.error).toBe('Network unreachable');
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = queue.onJobUpdate((j) => seen.push(j.status));

    const job = queue.enqueue({ type: 'probe', projectId: 'p1' });
    queue.setStatus(job.id, 'running');
    unsubscribe();
    queue.setStatus(job.id, 'done');

    expect(seen).toEqual(['queued', 'running']);
  });

  it('reports queue position for waiting jobs', () => {
    const first = queue.enqueue({ type: 'probe', projectId: 'p1' });
    queue.enqueue({ type: 'probe', projectId: 'p1' });

    expect(queue.getQueuePosition(first.id)).toBeGreaterThanOrEqual(0);
  });

  it('clamps concurrency to at least one worker', () => {
    queue.setMaxConcurrency(0);
    expect(queue.getMaxConcurrency()).toBe(1);
    queue.setMaxConcurrency(4);
    expect(queue.getMaxConcurrency()).toBe(4);
  });
});
