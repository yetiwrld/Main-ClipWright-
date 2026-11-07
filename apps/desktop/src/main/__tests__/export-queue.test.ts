// @vitest-environment node
/**
 * SPEC 14 §6 — queue behaviour against the real encoder.
 *
 * The point of these tests is the *sequencing*: one export at a time, cancelling
 * one does not disturb the others, a failed job does not stop the queue, and no
 * partial files survive.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExportQueue, cleanupPartialFiles } from '../export/export-queue.js';
import { expectedFrameBytes, solidColourFrameSource } from '../export/export-runner.js';
import { ffmpegPath, ffprobePath } from '../export/ffmpeg-runner.js';
import type { ExportSettings } from '@clipwright/export-core';

const TMP = join(process.cwd(), '.tmp-export-queue');
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-q',
    projectId: 'proj-q',
    preset: '720p',
    aspect: '16:9',
    fps: 30,
    format: 'mp4',
    quality: 'draft',
    rateControl: 'vbr',
    audioBitrate: 192,
    includeAudio: false,
    burnCaptions: false,
    saveSubtitles: false,
    subtitleFormats: [],
    embedProjectName: true,
    normaliseLoudness: false,
    targetLufs: -16,
    isDraft: false,
    rangeUs: [0, 500_000],
    compositionFps: 30,
    compositionDurationUs: 500_000,
    items: [],
    ...overrides,
  };
}

describe.skipIf(!HAS_FFMPEG)('ExportQueue', () => {
  it('runs one export at a time by default', async () => {
    mkdirSync(TMP, { recursive: true });
    let concurrent = 0;
    let peakConcurrent = 0;

    const queue = new ExportQueue();
    for (const index of [0, 1, 2]) {
      queue.add({
        id: `serial-${index}`,
        name: `Serial ${index}`,
        settings: makeSettings(),
        outputPath: join(TMP, `serial-${index}.mp4`),
        createFrameSource: async () => {
          const inner = solidColourFrameSource({ width: 1280, height: 720, luma: 40 + index * 20 });
          return {
            label: `concurrency probe ${index}`,
            async open() {
              concurrent += 1;
              peakConcurrent = Math.max(peakConcurrent, concurrent);
              await inner.open?.({} as never);
            },
            next: (frameIndex) => inner.next(frameIndex),
            async close() {
              concurrent -= 1;
              await inner.close();
            },
          };
        },
        fullDecode: false,
      });
    }

    await queue.whenIdle();
    expect(peakConcurrent).toBe(1);
    const jobs = queue.snapshot().jobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.status === 'done')).toBe(true);
    for (const index of [0, 1, 2]) {
      expect(existsSync(join(TMP, `serial-${index}.mp4`))).toBe(true);
    }
  }, 180_000);

  it('cancels a queued job without ever starting it', async () => {
    mkdirSync(TMP, { recursive: true });
    const queue = new ExportQueue();
    let started = 0;
    const first = queue.add({
      id: 'cancel-first',
      name: 'First',
      settings: makeSettings({ rangeUs: [0, 2_000_000] }),
      outputPath: join(TMP, 'cancel-first.mp4'),
      createFrameSource: async () => {
        started += 1;
        return solidColourFrameSource({ width: 1280, height: 720 });
      },
      fullDecode: false,
    });
    const second = queue.add({
      id: 'cancel-second',
      name: 'Second',
      settings: makeSettings(),
      outputPath: join(TMP, 'cancel-second.mp4'),
      createFrameSource: async () => {
        started += 1;
        return solidColourFrameSource({ width: 1280, height: 720 });
      },
      fullDecode: false,
    });

    // The second job is still queued; cancelling it must prevent it starting.
    expect(queue.cancel(second.id)).toBe(true);
    await queue.whenIdle();

    expect(started).toBe(1);
    expect(queue.getJob(second.id)!.status).toBe('cancelled');
    expect(queue.getJob(first.id)!.status).toBe('done');
    expect(existsSync(join(TMP, 'cancel-second.mp4'))).toBe(false);
  }, 180_000);

  it('keeps going after a job fails', async () => {
    mkdirSync(TMP, { recursive: true });
    const queue = new ExportQueue();
    queue.add({
      id: 'failing',
      name: 'Failing',
      settings: makeSettings(),
      outputPath: join(TMP, 'failing.mp4'),
      createFrameSource: () => ({
        label: 'broken',
        async next() {
          return Buffer.alloc(16, 0); // deliberately wrong size
        },
        async close() {
          // Nothing to release.
        },
      }),
      fullDecode: false,
    });
    queue.add({
      id: 'after-failure',
      name: 'After failure',
      settings: makeSettings(),
      outputPath: join(TMP, 'after-failure.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 70 }),
      fullDecode: false,
    });

    await queue.whenIdle();
    expect(queue.getJob('failing')!.status).toBe('failed');
    expect(queue.getJob('after-failure')!.status).toBe('done');
    expect(existsSync(join(TMP, 'after-failure.mp4'))).toBe(true);
  }, 180_000);

  it('records finished jobs through onFinished for history', async () => {
    mkdirSync(TMP, { recursive: true });
    const finished: Array<{ id: string; status: string; verdict: string; notPassed?: string[] }> = [];
    const queue = new ExportQueue({
      onFinished: (result) => {
        finished.push({
          id: result.job.id,
          status: result.status,
          verdict: result.job.verdict ?? '',
          notPassed: result.validation?.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}:${c.name}:${c.measured}`),
        });
      },
    });
    queue.add({
      id: 'history-1',
      name: 'History',
      settings: makeSettings(),
      outputPath: join(TMP, 'history.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 55 }),
      // Full verification: this is the path that is allowed to say "Verified".
      fullDecode: true,
    });
    await queue.whenIdle();
    expect(finished).toHaveLength(1);
    expect(finished[0].notPassed ?? []).toEqual([]);
    expect(finished[0].status).toBe('verified');
    expect(finished[0].verdict).toBe('Done ✓ Verified');
  }, 180_000);

  it('downgrades to warnings when the decode check was skipped', async () => {
    mkdirSync(TMP, { recursive: true });
    const finished: Array<{ id: string; status: string; verdict: string; notPassed?: string[] }> = [];
    const queue = new ExportQueue({
      onFinished: (result) => {
        finished.push({
          id: result.job.id,
          status: result.status,
          verdict: result.job.verdict ?? '',
          notPassed: result.validation?.checks
            .filter((check) => check.status !== 'pass')
            .map((check) => `${check.id}:${check.name}`),
        });
      },
    });
    queue.add({
      id: 'quick-verify',
      name: 'Quick verify',
      settings: makeSettings(),
      outputPath: join(TMP, 'quick.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 55 }),
      fullDecode: false,
    });
    await queue.whenIdle();
    // An unrun check must never masquerade as success (SPEC 14 §7).
    expect(finished[0].status).toBe('warnings');
    expect(finished[0].verdict).toContain('warnings');
    expect(finished[0].notPassed).toEqual(['8:Full decode']);
  }, 180_000);

  it('does not let editing the timeline change a queued export', async () => {
    mkdirSync(TMP, { recursive: true });
    const queue = new ExportQueue();
    const settings = makeSettings();
    const job = queue.add({
      id: 'snapshot',
      name: 'Snapshot',
      settings,
      outputPath: join(TMP, 'snapshot.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 65 }),
      fullDecode: false,
    });

    // Mutate the caller's object after enqueueing: the job must keep the snapshot.
    settings.preset = '4k-uhd';
    settings.fps = 60;

    await queue.whenIdle();
    expect(job.settingsSnapshot).toMatchObject({ preset: '720p', fps: 30 });
    expect(queue.getJob(job.id)!.settingsSnapshot).toMatchObject({ preset: '720p', fps: 30 });
  }, 180_000);

  it('marks jobs from a previous session as interrupted', () => {
    const queue = new ExportQueue();
    const job = queue.add({
      id: 'interrupted',
      name: 'Interrupted',
      settings: makeSettings({ rangeUs: [0, 0] }),
      outputPath: join(TMP, 'never.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720 }),
      fullDecode: false,
    });
    queue.markInterrupted();
    const after = queue.getJob(job.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('restarts from the beginning');
  });

  it('retries a failed job with its original settings', async () => {
    mkdirSync(TMP, { recursive: true });
    const queue = new ExportQueue();
    let attempt = 0;
    const job = queue.add({
      id: 'retry-me',
      name: 'Retry me',
      settings: makeSettings(),
      outputPath: join(TMP, 'retry.mp4'),
      createFrameSource: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            label: 'fails once',
            async next() {
              return Buffer.alloc(16, 0);
            },
            async close() {
              // Nothing to release.
            },
          };
        }
        return solidColourFrameSource({ width: 1280, height: 720, luma: 75 });
      },
      fullDecode: false,
    });

    await queue.whenIdle();
    expect(queue.getJob(job.id)!.status).toBe('failed');

    const retried = queue.retry(job.id);
    expect(retried).not.toBeNull();
    expect(retried!.id).not.toBe(job.id);
    await queue.whenIdle();
    expect(queue.getJob(retried!.id)!.status).toBe('done');
  }, 180_000);

  it('refuses to retry a job that is not finished', () => {
    const queue = new ExportQueue();
    queue.add({
      id: 'running-job',
      name: 'Running',
      settings: makeSettings({ rangeUs: [0, 5_000_000] }),
      outputPath: join(TMP, 'running.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720 }),
      fullDecode: false,
    });
    expect(queue.retry('running-job')).toBeNull();
  });

  it('dismisses finished jobs but not running ones', async () => {
    mkdirSync(TMP, { recursive: true });
    const queue = new ExportQueue();
    const job = queue.add({
      id: 'dismiss-me',
      name: 'Dismiss',
      settings: makeSettings(),
      outputPath: join(TMP, 'dismiss.mp4'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 45 }),
      fullDecode: false,
    });
    await queue.whenIdle();
    expect(queue.dismiss(job.id)).toBe(true);
    expect(queue.getJob(job.id)).toBeUndefined();
  }, 180_000);
});

describe('cleanupPartialFiles', () => {
  it('removes partial files and leaves finished ones alone', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, 'keep.mp4'), 'done');
    writeFileSync(join(TMP, 'stale.partial.mp4'), 'half');
    await cleanupPartialFiles(TMP);
    expect(existsSync(join(TMP, 'keep.mp4'))).toBe(true);
    expect(existsSync(join(TMP, 'stale.partial.mp4'))).toBe(false);
  });

  it('does nothing when the directory is missing', async () => {
    await expect(cleanupPartialFiles(join(TMP, 'nope'))).resolves.toBeUndefined();
  });
});

describe('expectedFrameBytes in queue context', () => {
  it('is what the frame sources allocate', () => {
    expect(expectedFrameBytes(1280, 720)).toBe(1280 * 720 + 2 * 640 * 360);
  });
});
