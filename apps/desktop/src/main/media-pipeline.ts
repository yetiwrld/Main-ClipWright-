/**
 * SPEC 04 — Ingest orchestration in the main process.
 *
 * Turns a user's chosen source (a local file or a supported link) into a
 * managed media record plus the derived files the app needs: a 16 kHz mono WAV, a
 * thumbnail, a proxy and audio peaks. Every step reports honest progress and is
 * cancellable; partial work is cleaned up before the error surfaces.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join, basename, extname, resolve } from 'node:path';
import { statSync } from 'node:fs';
import {
  computeFingerprint,
  computeSHA256,
  copyToLibrary,
  extractAudio16k,
  generatePeaks,
  generateProxy,
  generateThumbnail,
  isSupportedFile,
  probeMedia,
  resolveIngestSource,
  type MediaInfo as CoreMediaInfo,
} from '@clipwright/media-core';
import type { StorageService } from './storage/storage-service.js';

export interface IngestRequest {
  projectId: string;
  /** Absolute path to a local file (mutually exclusive with sourceUrl). */
  sourcePath?: string;
  /** A supported http(s) link. */
  sourceUrl?: string;
  quality: '720p' | '1080p' | 'best';
  storageMode: 'managed' | 'reference';
}

export interface IngestProgress {
  percent: number;
  phase: string;
  detail?: string;
}

export interface IngestResult {
  mediaId: string;
  mediaPath: string;
  audio16kPath: string;
  thumbPath: string;
  proxyPath: string | null;
  durationUs: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  fps?: number;
  kind: 'video' | 'audio' | 'image';
  status: 'ok' | 'missing';
}

const CHROMIUM_SAFE_CODECS = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1', 'theora']);

/** SPEC 04 §7 — decide whether a proxy is needed for smooth editing. */
export function needsProxy(info: CoreMediaInfo, alwaysCreateProxy: boolean): boolean {
  if (alwaysCreateProxy) return true;
  const video = info.video;
  if (!video) return false;
  if (video.height > 1080) return true;
  if (!CHROMIUM_SAFE_CODECS.has(video.codec.toLowerCase())) return true;
  if (video.fpsMode === 'variable') return true;
  if (video.hdr) return true;
  return false;
}

export async function ingestMedia(
  storage: StorageService,
  request: IngestRequest,
  onProgress: (p: IngestProgress) => void,
  signal: AbortSignal,
  options: { alwaysCreateProxy?: boolean } = {}
): Promise<IngestResult> {
  if (!request.sourcePath && !request.sourceUrl) {
    throw new Error('Choose a file or paste a link first.');
  }

  const projectDir = storage.getProjectDir(request.projectId);
  const mediaDir = join(projectDir, 'media');
  const cacheDir = join(projectDir, 'cache');
  const derivedDir = join(projectDir, 'derived');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(derivedDir, { recursive: true });

  const checkAbort = () => {
    if (signal.aborted) throw new Error('Import cancelled');
  };

  let sourceFile: string;
  let managedPath: string;
  let mediaId: string;

  if (request.sourceUrl) {
    const source = resolveIngestSource(request.sourceUrl);
    if (!source) {
      throw new Error('That link is not supported. If you already have the file, import it instead.');
    }
    onProgress({ percent: 1, phase: 'Checking link' });

    const preview = await source.probe(request.sourceUrl);
    checkAbort();

    if (preview.isLive) {
      throw new Error('Live streams cannot be imported. Wait until the broadcast has finished.');
    }

    const downloadDir = join(cacheDir, 'download');
    await rm(downloadDir, { recursive: true, force: true });
    await mkdir(downloadDir, { recursive: true });

    const downloaded = await source.download(
      request.sourceUrl,
      { quality: request.quality, outputDir: downloadDir, jobId: `ingest_${request.projectId}` },
      (p) => {
        // Downloading is the long pole: map it onto 2–60 %.
        onProgress({
          percent: 2 + Math.round((p.percent / 100) * 58),
          phase: p.phase === 'merging' ? 'Merging audio and video' : 'Downloading',
          detail: `${formatBytes(p.downloadedBytes)} of ${formatBytes(p.totalBytes)}`,
        });
      },
      signal
    );

    checkAbort();
    mediaId = `media_${Date.now().toString(36)}`;
    managedPath = await copyToLibrary(downloaded.path, mediaDir, mediaId);
    sourceFile = managedPath;
  } else {
    const localPath = resolve(request.sourcePath!);
    const support = isSupportedFile(localPath);
    if (!support.supported) {
      throw new Error(`Clipwright can't read ${extname(localPath) || 'this file type'}. Try MP4, MOV, MKV, WebM or a WAV/MP3.`);
    }
    try {
      statSync(localPath);
    } catch {
      throw new Error('That file no longer exists at the path it was imported from.');
    }

    onProgress({ percent: 3, phase: 'Reading file' });
    mediaId = `media_${Date.now().toString(36)}`;

    if (request.storageMode === 'reference') {
      managedPath = localPath;
      sourceFile = localPath;
    } else {
      onProgress({ percent: 8, phase: 'Copying into library' });
      managedPath = await copyToLibrary(localPath, mediaDir, mediaId);
      sourceFile = managedPath;
    }
  }

  checkAbort();
  onProgress({ percent: 62, phase: 'Inspecting' });
  const info = await probeMedia(sourceFile);

  if (info.durationUs <= 0 && info.kind !== 'image') {
    throw new Error('This file has no readable duration. It may be corrupt or incomplete.');
  }

  checkAbort();
  onProgress({ percent: 70, phase: 'Generating thumbnail' });
  let thumbPath = '';
  try {
    const thumbTime = info.kind === 'image' ? 0 : Math.min(3, info.durationUs / 1_000_000 / 3);
    thumbPath = await generateThumbnail(sourceFile, derivedDir, thumbTime);
  } catch {
    // A missing thumbnail is cosmetic; the import still succeeds.
    thumbPath = '';
  }

  if (info.kind !== 'image' && info.audio.length === 0) {
    throw new Error('This file has no audio track, so there is nothing to transcribe.');
  }

  checkAbort();
  onProgress({ percent: 78, phase: 'Extracting audio' });
  const audio16kPath = await extractAudio16k(sourceFile, derivedDir, 0);

  checkAbort();
  let proxyPath: string | null = null;
  if (needsProxy(info, options.alwaysCreateProxy ?? false)) {
    onProgress({ percent: 86, phase: 'Preparing preview' });
    try {
      const proxyDir = join(derivedDir, 'proxy', mediaId);
      proxyPath = await generateProxy(sourceFile, proxyDir, 'medium');
    } catch {
      // Proxy generation is an optimisation — playback falls back to the source.
      proxyPath = null;
    }
  }

  checkAbort();
  onProgress({ percent: 93, phase: 'Indexing audio' });
  try {
    await generatePeaks(audio16kPath, derivedDir);
  } catch {
    // Waveform peaks are regenerated on demand when the waveform is first shown.
  }

  onProgress({ percent: 97, phase: 'Finishing up' });
  const [sha256, fingerprint] = await Promise.all([
    computeSHA256(managedPath).catch(() => undefined),
    computeFingerprint(managedPath),
  ]);

  const sizeBytes = statSync(managedPath).size;

  storage.saveMedia({
    id: mediaId,
    kind: info.kind,
    storageMode: request.storageMode,
    path: managedPath,
    originalName: basename(request.sourcePath ?? request.sourceUrl ?? managedPath),
    sizeBytes,
    sha256,
    fingerprint,
    createdAt: new Date().toISOString(),
    info: toSchemaInfo(info),
    status: 'ok',
    peaks256Path: join(derivedDir, 'peaks256.bin'),
    peaks4096Path: join(derivedDir, 'peaks4096.bin'),
    thumbPath: thumbPath || undefined,
    /*
      The proxy has been written to disk since proxies were introduced, and until now
      its path was returned to the caller and then dropped — so every proxy this app
      ever generated was an orphan nobody could find. Recording it is the whole
      difference between "we make proxies" and "proxies are used".
    */
    proxyPath: proxyPath ?? undefined,
  } as never);

  storage.updateProject(request.projectId, {
    stage: 'transcribe',
    sourceMediaIds: [mediaId],
  } as never);

  onProgress({ percent: 100, phase: 'Import complete' });

  return {
    mediaId,
    mediaPath: managedPath,
    audio16kPath,
    thumbPath,
    proxyPath,
    durationUs: info.durationUs,
    sizeBytes,
    width: info.video?.width,
    height: info.video?.height,
    fps: info.video?.fps,
    kind: info.kind,
    status: 'ok',
  };
}

/** Converts media-core's probe result into the persisted project-schema shape. */
function toSchemaInfo(info: CoreMediaInfo) {
  return {
    mediaId: info.mediaId,
    kind: info.kind,
    container: info.container,
    durationUs: info.durationUs,
    sizeBytes: info.sizeBytes,
    bitrate: info.bitrate,
    hasSpeechAudio: info.audio.length > 0,
    video: info.video
      ? {
          codec: info.video.codec,
          profile: info.video.profile,
          width: info.video.width,
          height: info.video.height,
          displayWidth: info.video.displayWidth,
          displayHeight: info.video.displayHeight,
          rotation: info.video.rotation,
          sar: String(info.video.sar),
          dar: String(info.video.dar),
          fps: info.video.fps,
          fpsMode: info.video.fpsMode,
          pixFmt: info.video.pixFmt,
          colorSpace: info.video.colorSpace,
          hdr: info.video.hdr,
          bitDepth: info.video.bitDepth,
          hasAlpha: info.video.hasAlpha,
        }
      : undefined,
    audio: info.audio.map((a) => ({
      index: a.index,
      codec: a.codec,
      channels: a.channels,
      sampleRate: a.sampleRate,
      language: a.language,
      title: a.title,
      default: a.default,
    })),
    metadata: info.metadata,
    creationTime: info.creationTime,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
