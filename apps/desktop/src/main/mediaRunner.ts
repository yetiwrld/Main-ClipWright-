/**
 * Media job handlers: probe, managed copy, audio extraction, thumbnails,
 * proxy creation. Stream-based (never whole-file into memory).
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { resolveBinaries, parseFfprobeJson, probeInput, runProcess, buildExtractAudioArgs, buildThumbnailArgs, MissingBinaryError, parseProgressLine } from '@clipwright/media-core';
import { newId, type MediaInfo } from '@clipwright/project-schema';
import { mediaFolder } from './workspace.js';
import type { JobContext } from './jobs.js';

export const probeMedia = async (ctx: JobContext, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const path = String(params['path'] ?? '');
  const mediaId = String(params['mediaId'] ?? '');
  if (!path || !existsSync(path)) throw new Error('The file could not be found. It may have been moved or deleted.');
  const bins = resolveBinaries();
  ctx.report(0.1, 'Reading video details');
  const { probe, warnings } = await probeInput(bins, path, undefined, 30_000);
  for (const w of warnings) ctx.logger.warn('Probe warning', { detail: w });
  const info = parseFfprobeJson(probe, mediaId);
  if (!info.video && info.audio.length === 0) throw new Error('This file has no audio or video streams that Clipwright can read.');
  if (info.durationUs <= 0) throw new Error('This file reports a zero duration. It may be corrupt or still downloading.');
  ctx.storage.updateMedia(mediaId, { info, sizeBytes: info.sizeBytes });
  ctx.report(1, 'Done');
  return { durationUs: info.durationUs, kind: info.kind };
};

export const copyManaged = async (ctx: JobContext, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const src = String(params['path'] ?? '');
  const mediaId = String(params['mediaId'] ?? '');
  const workspaceRoot = String(params['workspaceRoot'] ?? '');
  if (!existsSync(src)) throw new Error('The source file no longer exists.');
  const size = statSync(src).size;
  const dir = mediaFolder(workspaceRoot, mediaId);
  mkdirSync(dir, { recursive: true });
  const ext = extname(src) || '.bin';
  const dst = join(dir, `original${ext.toLowerCase()}`);
  const tmp = dst + '.partial';
  ctx.logger.info('Copying media into library', { originalName: basename(src), sizeBytes: size });

  // streaming copy with byte progress
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(tmp);
    let copied = 0;
    let lastReport = 0;
    rs.on('data', (chunk: string | Buffer) => {
      copied += typeof chunk === 'string' ? chunk.length : chunk.length;
      const t = Date.now();
      if (t - lastReport > 100) { lastReport = t; ctx.report(copied / size, 'Copying file'); }
      if (ctx.signal.aborted) { rs.destroy(new Error('Cancelled')); }
    });
    rs.pipe(ws);
    ws.on('finish', () => resolve());
    rs.on('error', reject);
    ws.on('error', reject);
  });
  if (ctx.signal.aborted) { try { unlinkSync(tmp); } catch { /* keep */ } throw new Error('Cancelled by the user.'); }

  // verify size matches, then atomic rename
  const copiedSize = statSync(tmp).size;
  if (copiedSize !== size) { unlinkSync(tmp); throw new Error(`The copy is incomplete (${copiedSize} of ${size} bytes). Check free disk space.`); }
  renameSync(tmp, dst);

  // sha256 in the background of the job (still inside the job so it's tracked)
  ctx.report(0.95, 'Verifying file');
  const hash = await sha256Stream(dst, ctx);
  ctx.storage.updateMedia(mediaId, { path: dst, sizeBytes: size, sha256: hash, status: 'ok' });
  ctx.report(1, 'Done');
  return { path: dst, sha256: hash };
};

const sha256Stream = (path: string, ctx: JobContext): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(path);
    rs.on('data', (d) => hash.update(d));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });

export const extractAudio = async (ctx: JobContext, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const mediaId = String(params['mediaId'] ?? '');
  const workspaceRoot = String(params['workspaceRoot'] ?? '');
  const media = ctx.storage.getMedia(mediaId);
  if (!media) throw new Error('The media record is missing.');
  const bins = resolveBinaries();
  if (!bins.ffmpeg) throw new MissingBinaryError('ffmpeg');
  const dir = mediaFolder(workspaceRoot, mediaId);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, 'audio16k.wav');
  const audioStream = Number(params['audioStreamIndex'] ?? 0);
  const info = media.info;
  const totalUs = info?.durationUs ?? 0;
  ctx.report(0, 'Extracting audio');
  const args = [...buildExtractAudioArgs(media.path, dst, audioStream), '-progress', 'pipe:1'];
  const res = await runProcess(bins.ffmpeg, args, {
    timeoutMs: 30 * 60 * 1000,
    signal: ctx.signal,
    onProgressLine: (line) => {
      const kv = parseProgressLine(line);
      if (kv && kv['out_time_us'] && totalUs > 0) {
        const t = Number(kv['out_time_us']);
        if (Number.isFinite(t)) ctx.report(Math.min(0.99, t / totalUs), 'Extracting audio');
      }
    },
  });
  if (res.code !== 0) throw new Error(`ffmpeg could not extract the audio (exit ${res.code}). ${res.stderrTail.split('\n').pop() ?? ''}`);
  ctx.storage.registerDerived(mediaId, 'audio16k', dst);
  ctx.report(1, 'Done');
  return { path: dst };
};

export const makeThumbnail = async (ctx: JobContext, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const mediaId = String(params['mediaId'] ?? '');
  const workspaceRoot = String(params['workspaceRoot'] ?? '');
  const media = ctx.storage.getMedia(mediaId);
  if (!media) throw new Error('The media record is missing.');
  const bins = resolveBinaries();
  if (!bins.ffmpeg) throw new MissingBinaryError('ffmpeg');
  const dir = mediaFolder(workspaceRoot, mediaId);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, 'thumb.jpg');
  const dur = (media.info?.durationUs ?? 10_000_000) / 1_000_000;
  const at = Math.min(Math.max(0.5, dur * 0.1), dur - 0.5);
  const args = buildThumbnailArgs(media.path, dst, at);
  ctx.report(0.2, 'Making thumbnail');
  const res = await runProcess(bins.ffmpeg, args, { timeoutMs: 60_000, signal: ctx.signal });
  if (res.code !== 0 || !existsSync(dst)) throw new Error('Could not create a thumbnail from this file.');
  ctx.storage.registerDerived(mediaId, 'thumbnail', dst);
  ctx.report(1, 'Done');
  return { path: dst };
};

export const makeProxy = async (ctx: JobContext, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const mediaId = String(params['mediaId'] ?? '');
  const workspaceRoot = String(params['workspaceRoot'] ?? '');
  const height = (Number(params['height'] ?? 540) || 540) as 360 | 540 | 720;
  const media = ctx.storage.getMedia(mediaId);
  if (!media) throw new Error('The media record is missing.');
  const bins = resolveBinaries();
  if (!bins.ffmpeg) throw new MissingBinaryError('ffmpeg');
  const info: MediaInfo | undefined = media.info;
  const dir = mediaFolder(workspaceRoot, mediaId);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `proxy-${height}p.mp4`);
  const fps = Math.round(info?.video?.fps ?? 30);
  const totalUs = info?.durationUs ?? 0;
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', media.path,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', `scale=-2:${height},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    dst,
  ];
  ctx.report(0, 'Preparing preview');
  const res = await runProcess(bins.ffmpeg, args, {
    timeoutMs: 6 * 60 * 60 * 1000,
    signal: ctx.signal,
    onProgressLine: (line) => {
      const kv = parseProgressLine(line);
      if (kv && kv['out_time_us'] && totalUs > 0) {
        const t = Number(kv['out_time_us']);
        if (Number.isFinite(t)) ctx.report(Math.min(0.99, t / totalUs), 'Preparing preview');
      }
    },
  });
  if (res.code !== 0) throw new Error(`Could not create the preview proxy (exit ${res.code}).`);
  ctx.storage.registerDerived(mediaId, `proxy-${height}p`, dst, { height });
  ctx.report(1, 'Done');
  return { path: dst };
};
