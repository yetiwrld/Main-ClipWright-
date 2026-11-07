/// <reference types="node" />
/**
 * SPEC 06 §7.2 — the download engine.
 *
 * Rules implemented here:
 *  • HTTP Range resume into `<file>.part`, so pausing or a dropped connection
 *    never throws away the bytes already on disk.
 *  • Size check, then SHA-256 against the pinned digest, then an atomic rename.
 *  • A digest mismatch deletes the file and reports "damaged", rather than
 *    handing a truncated model to whisper.cpp.
 *  • One download at a time; the queue lives in `manager.ts`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DownloadOutcome, DownloadProgressEvent, DownloadRequest } from './types.js';

const GB = 1024 ** 3;
const PROGRESS_THROTTLE_MS = 150;

/** Raised when the digest does not match; the file has already been removed. */
export class ChecksumMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string
  ) {
    super('The download was damaged and has been removed. Try again.');
    this.name = 'ChecksumMismatchError';
  }
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function freeDiskGb(dir: string): Promise<number> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const stat = await fsp.statfs(dir);
    return (stat.bavail * stat.bsize) / GB;
  } catch {
    return 0;
  }
}

/**
 * Downloads `request.url` into `request.destDir/request.fileName`.
 *
 * Resolves with the final path. Throws `ChecksumMismatchError` when the digest
 * does not match (file removed), `DownloadCancelledError` when aborted (partial
 * file kept so a resume can continue), or a plain `Error` for network problems.
 */
export async function downloadFile(
  request: DownloadRequest,
  onProgress?: (event: DownloadProgressEvent) => void
): Promise<DownloadOutcome> {
  const { id, url, destDir, fileName, expectedBytes, expectedSha256, signal } = request;

  await fsp.mkdir(destDir, { recursive: true });
  const finalPath = path.join(destDir, fileName);
  const partPath = `${finalPath}.part`;

  let existing = 0;
  try {
    existing = (await fsp.stat(partPath)).size;
  } catch {
    existing = 0;
  }

  // Already complete and correctly sized: verify and finish without a request.
  if (expectedBytes && existing === expectedBytes) {
    const verified = await finalise(id, partPath, finalPath, expectedSha256, onProgress);
    return { id, filePath: finalPath, bytes: expectedBytes, verified, resumed: true, cancelled: false };
  }

  const headers: Record<string, string> = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  const response = await fetch(url, { headers, signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}).`);
  }

  let resumed = false;
  let startOffset = 0;
  if (response.status === 206) {
    const range = response.headers.get('content-range');
    const match = range ? /bytes\s+(\d+)-/i.exec(range) : null;
    startOffset = match ? Number(match[1]) : existing;
    resumed = startOffset > 0;
  } else if (existing > 0) {
    // The server ignored our Range header: start from scratch.
    startOffset = 0;
    await fsp.rm(partPath, { force: true });
  }

  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? startOffset + contentLength : (expectedBytes ?? null);

  const out = fs.createWriteStream(partPath, { flags: startOffset > 0 ? 'r+' : 'w', start: startOffset > 0 ? startOffset : 0 });
  let received = startOffset;
  const startedAt = Date.now();
  let lastReport = 0;
  let bytesPerSecond: number | null = null;
  let etaSeconds: number | null = null;

  const report = (status: DownloadProgressEvent['status'], error?: string) => {
    const percent = totalBytes ? Math.min(99, Math.round((received / totalBytes) * 100)) : null;
    onProgress?.({
      id,
      bytesReceived: received,
      totalBytes,
      percent,
      bytesPerSecond,
      etaSeconds,
      status,
      resumed,
      verified: null,
      error,
    });
  };

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw new DownloadCancelledError();
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (!out.write(buffer)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }

      const now = Date.now();
      if (now - lastReport >= PROGRESS_THROTTLE_MS) {
        lastReport = now;
        const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
        bytesPerSecond = Math.round((received - startOffset) / elapsedSec);
        etaSeconds =
          totalBytes && bytesPerSecond > 0 ? Math.max(0, Math.round((totalBytes - received) / bytesPerSecond)) : null;
        report('downloading');
      }
    }

    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    if (expectedBytes && received !== expectedBytes) {
      await fsp.rm(partPath, { force: true });
      throw new Error(
        `The download was incomplete (${received.toLocaleString()} of ${expectedBytes.toLocaleString()} bytes) and has been removed. Try again.`
      );
    }

    onProgress?.({
      id,
      bytesReceived: received,
      totalBytes,
      percent: 100,
      bytesPerSecond,
      etaSeconds: 0,
      status: 'verifying',
      resumed,
      verified: null,
    });

    const verified = await finalise(id, partPath, finalPath, expectedSha256, onProgress);
    return { id, filePath: finalPath, bytes: received, verified, resumed, cancelled: false };
  } catch (error) {
    // Flush what we already wrote before closing: the bytes on disk are the
    // resume point, so throwing them away would waste the user's bandwidth.
    await new Promise<void>((resolve) => {
      if (out.destroyed || out.writableEnded) return resolve();
      out.end(() => resolve());
      out.once('error', () => resolve());
    });
    if (error instanceof DownloadCancelledError || (error as Error)?.name === 'AbortError') {
      // Keep the .part file: a resume picks up where this stopped.
      report('paused');
      throw new DownloadCancelledError();
    }
    // Network failure: keep the partial file too, so Retry resumes.
    report('paused', (error as Error)?.message);
    throw error;
  }
}

async function finalise(
  id: string,
  partPath: string,
  finalPath: string,
  expectedSha256: string | undefined,
  onProgress?: (event: DownloadProgressEvent) => void
): Promise<boolean | null> {
  let verified: boolean | null = null;

  if (expectedSha256) {
    const actual = await sha256OfFile(partPath);
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      await fsp.rm(partPath, { force: true });
      onProgress?.({
        id,
        bytesReceived: 0,
        totalBytes: null,
        percent: null,
        bytesPerSecond: null,
        etaSeconds: null,
        status: 'not_installed',
        resumed: false,
        verified: false,
      });
      throw new ChecksumMismatchError(expectedSha256, actual);
    }
    verified = true;
  }

  await fsp.rename(partPath, finalPath);
  return verified;
}

/** Removes both the model file and any interrupted `.part` download. */
export async function removeModelFile(dir: string, fileName: string): Promise<void> {
  await fsp.rm(path.join(dir, fileName), { force: true });
  await fsp.rm(path.join(dir, `${fileName}.part`), { force: true });
}

/** Bytes already downloaded for a file, or 0. */
export async function partialBytes(dir: string, fileName: string): Promise<number> {
  try {
    return (await fsp.stat(path.join(dir, `${fileName}.part`))).size;
  } catch {
    return 0;
  }
}
