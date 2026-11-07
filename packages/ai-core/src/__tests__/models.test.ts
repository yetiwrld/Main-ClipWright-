import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  ChecksumMismatchError,
  DownloadCancelledError,
  ModelManager,
  compatibilityFor,
  describeCompatibility,
  downloadFile,
  hasRoomForDownload,
  whisperCards,
  whisperChecksums,
} from '../models/index.js';
import { ConnectivityService } from '../connectivity.js';

const PAYLOAD = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251));
const DIGEST = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

interface ServerState {
  /** Honoured Range requests when true. */
  honourRange: boolean;
  /** Sends `pauseAfter` bytes then destroys the socket, once. */
  dropAfter: number | null;
  /** Wrong bytes, to exercise the digest check. */
  corrupt: boolean;
  /** Trickles 4 KB every 35 ms so a cancel can land mid-stream. */
  slow: boolean;
  requests: Array<{ range?: string }>;
}

describe('model download engine', () => {
  let server: http.Server;
  let origin = '';
  let state: ServerState;
  let dir: string;

  beforeAll(async () => {
    state = { honourRange: true, dropAfter: null, corrupt: false, slow: false, requests: [] };
    server = http.createServer((req, res) => {
      state.requests.push({ range: req.headers.range });

      if (state.slow) {
        res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
        let offset = 0;
        const timer = setInterval(() => {
          if (offset >= PAYLOAD.length) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(PAYLOAD.subarray(offset, offset + 4096));
          offset += 4096;
        }, 35);
        res.on('close', () => clearInterval(timer));
        return;
      }

      if (state.dropAfter !== null) {
        const limit = state.dropAfter;
        state.dropAfter = null;
        res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
        res.write(PAYLOAD.subarray(0, limit));
        setTimeout(() => res.destroy(), 10);
        return;
      }

      const body = state.corrupt ? Buffer.from(PAYLOAD).fill(0, 0, 16) : PAYLOAD;
      const range = req.headers.range;
      if (state.honourRange && range) {
        const match = /bytes=(\d+)-/.exec(range);
        const start = match ? Number(match[1]) : 0;
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
          'Content-Length': String(body.length - start),
        });
        res.end(body.subarray(start));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-models-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function reset() {
    state.honourRange = true;
    state.dropAfter = null;
    state.corrupt = false;
    state.slow = false;
    state.requests = [];
  }

  it('downloads, verifies and renames atomically', async () => {
    reset();
    const events: number[] = [];
    const outcome = await downloadFile(
      {
        id: 'tiny',
        url: `${origin}/ggml-tiny.bin`,
        destDir: dir,
        fileName: 'ggml-tiny.bin',
        expectedBytes: PAYLOAD.length,
        expectedSha256: DIGEST,
      },
      (event) => {
        if (event.percent !== null) events.push(event.percent);
      }
    );

    expect(outcome.verified).toBe(true);
    expect(outcome.filePath).toBe(path.join(dir, 'ggml-tiny.bin'));
    expect(fs.readFileSync(outcome.filePath).length).toBe(PAYLOAD.length);
    expect(fs.existsSync(`${outcome.filePath}.part`)).toBe(false);
    expect(events.at(-1)).toBe(100);
  });

  it('resumes from the .part file with a Range request', async () => {
    reset();
    const fileName = 'ggml-resume.bin';
    const already = 20_000;
    fs.writeFileSync(path.join(dir, `${fileName}.part`), PAYLOAD.subarray(0, already));

    const outcome = await downloadFile({
      id: 'resume',
      url: `${origin}/${fileName}`,
      destDir: dir,
      fileName,
      expectedBytes: PAYLOAD.length,
      expectedSha256: DIGEST,
    });

    expect(state.requests[0].range).toBe(`bytes=${already}-`);
    expect(outcome.resumed).toBe(true);
    expect(fs.readFileSync(outcome.filePath).equals(PAYLOAD)).toBe(true);
  });

  it('restarts when the server ignores Range instead of corrupting the file', async () => {
    reset();
    state.honourRange = false;
    const fileName = 'ggml-norange.bin';
    fs.writeFileSync(path.join(dir, `${fileName}.part`), Buffer.from('stale bytes'));

    const outcome = await downloadFile({
      id: 'norange',
      url: `${origin}/${fileName}`,
      destDir: dir,
      fileName,
      expectedBytes: PAYLOAD.length,
      expectedSha256: DIGEST,
    });

    expect(fs.readFileSync(outcome.filePath).equals(PAYLOAD)).toBe(true);
  });

  it('deletes a damaged download and says so plainly', async () => {
    reset();
    state.corrupt = true;
    const fileName = 'ggml-damaged.bin';

    await expect(
      downloadFile({
        id: 'damaged',
        url: `${origin}/${fileName}`,
        destDir: dir,
        fileName,
        expectedBytes: PAYLOAD.length,
        expectedSha256: DIGEST,
      })
    ).rejects.toBeInstanceOf(ChecksumMismatchError);

    expect(fs.existsSync(path.join(dir, fileName))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${fileName}.part`))).toBe(false);
  });

  it('keeps the partial file when cancelled so a resume can continue', async () => {
    reset();
    state.slow = true;
    const controller = new AbortController();
    const fileName = 'ggml-cancel.bin';

    const promise = downloadFile(
      {
        id: 'cancel',
        url: `${origin}/${fileName}`,
        destDir: dir,
        fileName,
        expectedBytes: PAYLOAD.length,
        expectedSha256: DIGEST,
        signal: controller.signal,
      },
      (event) => {
        if (event.bytesReceived > 0) controller.abort();
      }
    );

    await expect(promise).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(fs.existsSync(path.join(dir, `${fileName}.part`))).toBe(true);
  });

  it('accepts an unverified file when no digest is pinned', async () => {
    reset();
    const outcome = await downloadFile({
      id: 'nohash',
      url: `${origin}/ggml-nohash.bin`,
      destDir: dir,
      fileName: 'ggml-nohash.bin',
      expectedBytes: PAYLOAD.length,
    });
    expect(outcome.verified).toBeNull();
    expect(fs.existsSync(outcome.filePath)).toBe(true);
  });
});

describe('catalogue cards', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-cards-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const machine = { totalRamGb: 16, freeRamGb: 12, freeDiskGb: 100 };

  it('reports a missing model as not installed and a short file as corrupt', () => {
    const base = whisperCards({ dir, machine });
    expect(base.every((card) => card.status === 'not_installed')).toBe(true);

    const small = base.find((card) => card.id === 'small');
    expect(small).toBeDefined();
    if (!small) return;
    fs.writeFileSync(path.join(dir, small.fileName), Buffer.alloc(1024));
    const after = whisperCards({ dir, machine }).find((card) => card.id === 'small');
    expect(after?.status).toBe('corrupt');

    fs.writeFileSync(path.join(dir, small.fileName), Buffer.alloc(small.expectedBytes));
    const complete = whisperCards({ dir, machine }).find((card) => card.id === 'small');
    expect(complete?.status).toBe('installed');
    expect(complete?.progress).toBe(100);
    // Size alone is not proof: with no pinned digest the file is unverified.
    expect(whisperChecksums().small).toBeUndefined();
    expect(complete?.verified).toBe(false);
    expect(complete?.checksumMissing).toBe(true);
  });

  it('treats an interrupted .part file as paused with real progress', () => {
    const target = whisperCards({ dir, machine }).find((card) => card.id === 'medium');
    expect(target).toBeDefined();
    if (!target) return;
    fs.writeFileSync(path.join(dir, `${target.fileName}.part`), Buffer.alloc(Math.round(target.expectedBytes / 2)));
    const card = whisperCards({ dir, machine }).find((c) => c.id === 'medium');
    expect(card?.status).toBe('paused');
    expect(card?.progress).toBeGreaterThanOrEqual(49);
    expect(card?.progress).toBeLessThanOrEqual(51);
  });

  it('computes compatibility from this machine only', () => {
    expect(compatibilityFor(2, { totalRamGb: 32, freeRamGb: 20, freeDiskGb: 500 })).toBe('good_fit');
    expect(compatibilityFor(6, { totalRamGb: 32, freeRamGb: 8, freeDiskGb: 500 })).toBe('slow');
    expect(compatibilityFor(10, { totalRamGb: 8, freeRamGb: 4, freeDiskGb: 500 })).toBe('may_run_out');
    expect(compatibilityFor(4, { totalRamGb: 0, freeRamGb: 0, freeDiskGb: 0 })).toBe('unknown');
    expect(describeCompatibility('may_run_out')).toBe('May run out of memory');
  });

  it('requires 1.2× the model size in free space', () => {
    const gb = 1024 ** 3;
    expect(hasRoomForDownload(gb, { totalRamGb: 16, freeRamGb: 8, freeDiskGb: 1.1 })).toBe(false);
    expect(hasRoomForDownload(gb, { totalRamGb: 16, freeRamGb: 8, freeDiskGb: 1.3 })).toBe(true);
  });
});

describe('ModelManager queue', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-manager-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses a download when the disk cannot hold it, with a usable message', () => {
    const manager = new ModelManager({
      whisperDir: dir,
      onnxDir: dir,
      machine: { totalRamGb: 16, freeRamGb: 12, freeDiskGb: 0.2 },
    });
    expect(() => manager.queueWhisperDownload('large-v3')).toThrow(/Not enough free space/);
  });

  it('ignores a duplicate request for a model already queued', () => {
    const manager = new ModelManager({
      whisperDir: dir,
      onnxDir: dir,
      machine: { totalRamGb: 16, freeRamGb: 12, freeDiskGb: 500 },
    });
    // No network here: the job fails, but the duplicate check happens first.
    const first = manager.queueWhisperDownload('tiny');
    const second = manager.queueWhisperDownload('tiny');
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    manager.cancel('tiny');
  });

  it('rejects an unknown model instead of guessing a file name', () => {
    const manager = new ModelManager({
      whisperDir: dir,
      onnxDir: dir,
      machine: { totalRamGb: 16, freeRamGb: 12, freeDiskGb: 500 },
    });
    expect(() => manager.queueWhisperDownload('whisper-magic')).toThrow(/Unknown speech model/);
    expect(() => manager.queueOnnxDownload('ghost', 'https://example.com')).toThrow(/Unknown vision model/);
  });
});

describe('ConnectivityService', () => {
  const now = 1_000_000;

  function service(online: boolean, options: { timeout?: boolean } = {}) {
    let clock = now;
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(String(url));
      if (options.timeout) throw new Error('aborted');
      return new Response(null, { status: online ? 204 : 0 });
    }) as unknown as typeof fetch;

    return {
      calls,
      svc: new ConnectivityService({
        fetchFn,
        now: () => clock,
        probeUrls: ['https://probe.one/', 'https://probe.two/'],
        timeoutMs: 50,
      }),
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('reports online and caches the answer for 15 s', async () => {
    const { svc, calls, advance } = service(true);
    expect(await svc.isOnline()).toBe(true);
    expect(await svc.isOnline()).toBe(true);
    expect(calls).toHaveLength(1);

    advance(15_001);
    await svc.isOnline();
    expect(calls.length).toBeGreaterThan(1);
  });

  it('falls through to the second probe when the first fails', async () => {
    let attempt = 0;
    const svc = new ConnectivityService({
      fetchFn: (async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('blocked');
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      probeUrls: ['https://a/', 'https://b/'],
    });
    expect(await svc.isOnline()).toBe(true);
    expect(attempt).toBe(2);
  });

  it('never probes while Offline mode is on', async () => {
    const { svc, calls } = service(true);
    svc.setOfflineMode(true);
    expect(await svc.isOnline()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(svc.peek()?.reason).toBe('offline_mode');
  });

  it('reports a timeout rather than claiming offline instantly', async () => {
    const { svc } = service(true, { timeout: true });
    const state = await svc.check();
    expect(state.online).toBe(false);
  });
});
