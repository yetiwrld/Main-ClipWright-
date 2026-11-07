/**
 * Spec 04 — Ingest, Download, Probing and Proxies (media-core)
 */

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, copyFile, unlink, readFile, writeFile, readdir } from 'node:fs/promises';
import { basename, join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export interface MediaInfo {
  mediaId: string;
  kind: 'video' | 'audio' | 'image';
  container: string;
  durationUs: number;
  sizeBytes: number;
  bitrate: number;
  video?: VideoStreamInfo;
  audio: AudioStreamInfo[];
  metadata: Record<string, string>;
  creationTime?: string;
}

export interface VideoStreamInfo {
  codec: string;
  profile: string;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  sar: number;
  dar: number;
  fps: number;
  fpsMode: 'constant' | 'variable' | 'unknown';
  pixFmt: string;
  colorSpace: string;
  hdr: boolean;
  bitDepth: number;
  hasAlpha: boolean;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  channels: number;
  sampleRate: number;
  language?: string;
  title?: string;
  default: boolean;
}

export interface MediaPreview {
  title: string;
  uploader?: string;
  durationSec: number;
  thumbnailUrl?: string;
  formats: unknown[];
  isLive: boolean;
  webpageUrl?: string;
  estimatedSizeBytes: number;
}

export interface DownloadedFile {
  path: string;
  sizeBytes: number;
  format: string;
}

export interface ProgressEvent {
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSec: number;
  phase: 'video' | 'audio' | 'merging';
}

export interface IngestSource {
  canHandle(url: string): boolean;
  probe(url: string): Promise<MediaPreview>;
  download(url: string, opts: DownloadOptions, onProgress: (p: ProgressEvent) => void, signal: AbortSignal): Promise<DownloadedFile>;
}

export interface DownloadOptions {
  quality: '720p' | '1080p' | 'best';
  outputDir: string;
  jobId: string;
}

export const SUPPORTED_VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', 'mts', 'm2ts', 'ts', '3gp', 'ogv',
] as const;

export const SUPPORTED_AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'opus', 'wma',
] as const;

export const SUPPORTED_IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'tiff',
] as const;

export function isSupportedFile(filePath: string): { supported: boolean; kind: 'video' | 'audio' | 'image' | 'none' } {
  const ext = extname(filePath).toLowerCase().slice(1);
  if (SUPPORTED_VIDEO_EXTENSIONS.includes(ext as any)) return { supported: true, kind: 'video' };
  if (SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any)) return { supported: true, kind: 'audio' };
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext as any)) return { supported: true, kind: 'image' };
  return { supported: false, kind: 'none' };
}

export function getFFmpegPath(): string {
  return resolve(join(process.cwd(), 'resources', 'bin', 'ffmpeg'));
}

export function getFFprobePath(): string {
  return resolve(join(process.cwd(), 'resources', 'bin', 'ffprobe'));
}

export function getYtDlpPath(): string {
  return resolve(join(process.cwd(), 'resources', 'bin', 'yt-dlp'));
}

function runProcess(cmd: string, args: string[], timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const args = [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    filePath,
  ];
  const result = await runProcess(getFFprobePath(), args, 30000);
  if (result.exitCode !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr || 'unknown error'}`);
  }
  const data = JSON.parse(result.stdout);
  const format = data.format || {};
  const streams: any[] = data.streams || [];
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const imageStreams = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1);

  const kind: MediaInfo['kind'] = videoStreams.length > 0 ? 'video' : audioStreams.length > 0 ? 'audio' : 'image';

  const info: MediaInfo = {
    mediaId: basename(filePath, extname(filePath)),
    kind,
    container: format.format_name || 'unknown',
    durationUs: Math.round((parseFloat(format.duration || '0')) * 1_000_000),
    sizeBytes: parseInt(format.size || '0', 10),
    bitrate: parseInt(format.bit_rate || '0', 10),
    audio: audioStreams.map((s) => ({
      index: s.index,
      codec: s.codec_name || 'unknown',
      channels: s.channels || 2,
      sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : 48000,
      language: s.tags?.language,
      title: s.tags?.title,
      default: s.disposition?.default === 1,
    })),
    metadata: {
      title: format.tags?.title || '',
      artist: format.tags?.artist || '',
      ...Object.entries(format.tags || {}).reduce((acc, [k, v]) => {
        acc[k] = String(v);
        return acc;
      }, {} as Record<string, string>),
    },
    creationTime: format.tags?.creation_time,
  };

  if (videoStreams.length > 0 && !imageStreams.length) {
    const v = videoStreams[0];
    const rotation = parseInt(v.tags?.rotate || (v.side_data_list?.[0]?.rotation) || '0', 10) % 360 as 0 | 90 | 180 | 270;
    const width = v.width || 0;
    const height = v.height || 0;
    const displayWidth = rotation === 90 || rotation === 270 ? height : width;
    const displayHeight = rotation === 90 || rotation === 270 ? width : height;
    const fpsNum = v.avg_frame_rate ? v.avg_frame_rate.split('/').map(Number) : [0, 1];
    const fps = fpsNum[1] > 0 ? fpsNum[0] / fpsNum[1] : 0;
    const rFrameNum = v.r_frame_rate ? v.r_frame_rate.split('/').map(Number) : [0, 1];
    const rFrameFps = rFrameNum[1] > 0 ? rFrameNum[0] / rFrameNum[1] : 0;
    const fpsDiff = Math.abs(fps - rFrameFps) / Math.max(fps, rFrameFps);
    const colorSpace = v.color_space || 'bt709';
    const hdr = v.color_space === 'bt2020-10' || v.color_range === 'tv' && v.pix_fmt.includes('10');

    info.video = {
      codec: v.codec_name || 'unknown',
      profile: v.profile || 'unknown',
      width,
      height,
      displayWidth,
      displayHeight,
      rotation,
      sar: parseFloat(v.sample_aspect_ratio?.split('/')?.[0] || '1') || 1,
      dar: parseFloat(v.display_aspect_ratio?.split('/')?.[0] || '1') || 1,
      fps: Math.round(fps * 100) / 100,
      fpsMode: fpsDiff > 0.01 ? 'variable' : 'constant',
      pixFmt: v.pix_fmt || 'yuv420p',
      colorSpace,
      hdr: !!hdr,
      bitDepth: v.pix_fmt.includes('10') ? 10 : 8,
      hasAlpha: v.pix_fmt.includes('a'),
    };
  }

  return info;
}

export class YtDlpSource implements IngestSource {
  canHandle(url: string): boolean {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    return true;
  }

  async probe(url: string): Promise<MediaPreview> {
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--skip-download',
      '-J',
    ];
    const result = await runProcess(getYtDlpPath(), [...args, url], 20000);
    if (result.exitCode !== 0) {
      const errMsg = result.stderr || '';
      throw mapYtDlpError(errMsg);
    }
    const data = JSON.parse(result.stdout);
    return {
      title: data.title || 'Unknown title',
      uploader: data.uploader || data.channel,
      durationSec: data.duration || 0,
      thumbnailUrl: data.thumbnail,
      formats: data.formats || [],
      isLive: data.is_live === true,
      webpageUrl: data.webpage_url,
      estimatedSizeBytes: parseInt(data.filesize || '0', 10) || estimateSize(data),
    };
  }

  async download(
    url: string,
    opts: DownloadOptions,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadedFile> {
    const cacheDir = join(opts.outputDir, 'Cache', 'downloads', opts.jobId);
    await mkdir(cacheDir, { recursive: true });
    const outputTemplate = join(cacheDir, 'video.%(ext)s');

    const height = opts.quality === '720p' ? 720 : opts.quality === '1080p' ? 1080 : 0;
    const heightArgs = height > 0 ? [`-f`, `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`] : ['-f', 'bestvideo+bestaudio/best'];

    const args = [
      '--continue',
      '-o', outputTemplate,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      ...heightArgs,
      '--newline',
      '--no-warnings',
      url,
    ];

    return new Promise((resolvePromise, reject) => {
      const child = spawn(getYtDlpPath(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let lastProgressTime = Date.now();

      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      };
      signal.addEventListener('abort', onAbort);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        const lines = stdout.split('\n');
        stdout = lines.pop() || '';
        for (const line of lines) {
          const m = parseYtDlpProgressLine(line);
          if (m && Date.now() - lastProgressTime > 100) {
            lastProgressTime = Date.now();
            onProgress(m);
          }
        }
      });

      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(new Error('Download cancelled'));
          return;
        }
        if (code !== 0) {
          const err = mapYtDlpError(stderr || stdout);
          reject(err);
          return;
        }
        readdir(cacheDir).then((files) => {
          const videoFile = files.find((f) => ['mp4', 'mkv', 'webm', 'avi', 'mov'].includes(extname(f).slice(1).toLowerCase()));
          if (!videoFile) {
            reject(new Error('Download completed but no video file found'));
            return;
          }
          const finalPath = join(cacheDir, videoFile);
          const size = statSync(finalPath).size;
          resolvePromise({ path: finalPath, sizeBytes: size, format: extname(videoFile).slice(1) });
        }).catch(reject);
      });

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }
}

export class DirectFileSource implements IngestSource {
  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const ext = extname(parsed.pathname).toLowerCase().slice(1);
      return SUPPORTED_VIDEO_EXTENSIONS.includes(ext as any) || SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any);
    } catch {
      return false;
    }
  }

  async probe(url: string): Promise<MediaPreview> {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      const contentType = resp.headers.get('content-type') || '';
      const contentLength = resp.headers.get('content-length');
      return {
        title: url,
        durationSec: 0,
        formats: [],
        isLive: false,
        estimatedSizeBytes: contentLength ? parseInt(contentLength, 10) : 0,
      };
    } catch (e: any) {
      throw new Error(`Could not check the link: ${e.message}`);
    }
  }

  async download(
    url: string,
    opts: DownloadOptions,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadedFile> {
    const cacheDir = join(opts.outputDir, 'Cache', 'downloads', opts.jobId);
    await mkdir(cacheDir, { recursive: true });
    const outputPath = join(cacheDir, 'direct-download');

    let totalBytes = 0;
    const resp = await fetch(url, { signal, redirect: 'follow' });
    if (!resp.ok) {
      throw new Error(`Download failed with HTTP ${resp.status}`);
    }
    const contentLength = resp.headers.get('content-length');
    if (contentLength) totalBytes = parseInt(contentLength, 10);

    const fileStream = createWriteStream(outputPath);
    const reader = resp.body!.getReader();
    const contentType = resp.headers.get('content-type') || '';
    const ext = extname(new URL(url).pathname).toLowerCase().slice(1) || contentType.split('/')[1]?.split(';')[0] || 'mp4';
    const finalOutputPath = outputPath + '.' + ext;

    let downloadedBytes = 0;
    let lastProgressTime = Date.now();

    return new Promise((resolvePromise, reject) => {
      const onAbort = () => {
        try { reader.cancel(); } catch {}
        try { fileStream.close(); } catch {}
      };
      signal.addEventListener('abort', onAbort);

      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            fileStream.end(() => {
              signal.removeEventListener('abort', onAbort);
              const size = statSync(finalOutputPath).size;
              resolvePromise({ path: finalOutputPath, sizeBytes: size, format: ext });
            });
            return;
          }
          fileStream.write(value);
          downloadedBytes += value.length;
          if (Date.now() - lastProgressTime > 100) {
            lastProgressTime = Date.now();
            onProgress({
              percent: totalBytes > 0 ? downloadedBytes / totalBytes : 0,
              downloadedBytes,
              totalBytes,
              speedBps: 0,
              etaSec: 0,
              phase: 'video',
            });
          }
          pump();
        }).catch((err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      };

      pump();
    });
  }
}

function parseYtDlpProgressLine(line: string): ProgressEvent | null {
  const m = line.match(/(\d+)%\.\.\./);
  if (!m) return null;
  const percent = parseInt(m[1], 10);
  const speedMatch = line.match(/at\s+([\d.]+)\s+(\w+)\/s/);
  const etaMatch = line.match(/ETA\s+(\d+):(\d+)/);
  const sizeMatch = line.match(/of\s+([\d.]+)\s+(\w+)/);
  const downloadedBytes = sizeMatch ? parseFloat(sizeMatch[1]) * (sizeMatch[2] === 'GB' ? 1e9 : sizeMatch[2] === 'MB' ? 1e6 : sizeMatch[2] === 'KB' ? 1e3 : 1) : 0;
  const totalBytes = downloadedBytes / (percent / 100) || 0;
  return {
    percent,
    downloadedBytes,
    totalBytes,
    speedBps: speedMatch ? (speedMatch[2] === 'MB' ? parseFloat(speedMatch[1]) * 1e6 : speedMatch[2] === 'KB' ? parseFloat(speedMatch[1]) * 1e3 : parseFloat(speedMatch[1])) : 0,
    etaSec: etaMatch ? parseInt(etaMatch[1], 10) * 60 + parseInt(etaMatch[2], 10) : 0,
    phase: 'video',
  };
}

function mapYtDlpError(stderr: string): Error {
  const lower = stderr.toLowerCase();
  if (lower.includes('private') || lower.includes('members-only') || lower.includes('sign in')) {
    return new Error('This video is private or needs a login. Clipwright can\'t download it.');
  }
  if (lower.includes('age-restricted')) {
    return new Error('This video needs you to be signed in to confirm your age.');
  }
  if (lower.includes('geo-blocked') || lower.includes('geoblock')) {
    return new Error("This video isn't available in your region.");
  }
  if (lower.includes('drm') || lower.includes('protected')) {
    return new Error('This video is protected (DRM). Clipwright can\'t download protected videos.');
  }
  if (lower.includes('removed') || lower.includes('not found')) {
    return new Error('This video is no longer available.');
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return new Error('The site is limiting requests. Try again in a few minutes.');
  }
  if (lower.includes('unsupported site') || lower.includes('error')) {
    return new Error('This site isn\'t supported. If you have the file, import it instead.');
  }
  if (lower.includes('no internet') || lower.includes('connection') || lower.includes('network')) {
    return new Error('No internet connection.');
  }
  return new Error('Something went wrong while downloading.');
}

function estimateSize(data: any): number {
  const formats = data.formats || [];
  if (formats.length === 0) return 0;
  const best = formats.find((f: any) => f.filesize) || formats[0];
  return parseInt(best.filesize || '0', 10) || 0;
}

export async function extractAudio16k(sourcePath: string, outputDir: string, audioStreamIndex: number = 0): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'audio16k.wav');
  const args = [
    '-i', sourcePath,
    '-map', `0:a:${audioStreamIndex}`,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-hide_banner',
    '-nostdin',
    '-y',
    outputPath,
  ];
  const result = await runProcess(getFFmpegPath(), args, 3600000);
  if (result.exitCode !== 0) {
    throw new Error(`Audio extraction failed: ${result.stderr}`);
  }
  return outputPath;
}

export async function generateProxy(
  sourcePath: string,
  outputDir: string,
  quality: 'low' | 'medium' | 'high' = 'medium',
  targetFps: number = 30
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const height = quality === 'low' ? 360 : quality === 'medium' ? 540 : 720;
  const outputPath = join(outputDir, 'proxy.mp4');
  const args = [
    '-i', sourcePath,
    '-vf', `scale=-2:${height},fps=${targetFps},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-g', '15',
    '-keyint_min', '15',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-movflags', '+faststart',
    '-hide_banner',
    '-nostdin',
    '-y',
    outputPath,
  ];
  const result = await runProcess(getFFmpegPath(), args, 3600000);
  if (result.exitCode !== 0) {
    throw new Error(`Proxy generation failed: ${result.stderr}`);
  }
  return outputPath;
}

export async function generateThumbnail(sourcePath: string, outputDir: string, timeSec: number = 0): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'poster.jpg');
  const args = [
    '-i', sourcePath,
    '-ss', String(timeSec),
    '-frames:v', '1',
    '-q:v', '2',
    '-hide_banner',
    '-nostdin',
    '-y',
    outputPath,
  ];
  const result = await runProcess(getFFmpegPath(), args, 60000);
  if (result.exitCode !== 0) {
    throw new Error(`Thumbnail generation failed: ${result.stderr}`);
  }
  return outputPath;
}

export async function generatePeaks(audio16kPath: string, outputDir: string): Promise<{ peaks256: string; peaks4096: string }> {
  await mkdir(outputDir, { recursive: true });
  const peaks256Path = join(outputDir, 'peaks256.bin');
  const peaks4096Path = join(outputDir, 'peaks4096.bin');

  const args = [
    '-i', audio16kPath,
    '-af', 'astats=metadata=1:reset=256,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
    '-hide_banner',
    '-nostdin',
  ];

  // Generate peaks at two resolutions
  for (const [resolution, output] of [[256, peaks256Path], [4096, peaks4096Path]] as const) {
    const result = await runProcess(getFFmpegPath(), [
      '-i', audio16kPath,
      '-af', `asetnsamples=n=${resolution},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
      '-f', 'null', '-',
      '-hide_banner',
      '-nostdin',
    ], 600000);

    if (result.exitCode !== 0) {
      // Fallback: write empty peaks file
      await writeFile(output, new Uint8Array(0));
      continue;
    }

    const peaks = parsePeaksFromOutput(result.stdout, resolution);
    await writeFile(output, peaks);
  }

  return { peaks256: peaks256Path, peaks4096: peaks4096Path };
}

function parsePeaksFromOutput(output: string, resolution: number): Buffer {
  const lines = output.split('\n');
  const peaks: number[] = [];
  for (const line of lines) {
    const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/);
    if (m) {
      peaks.push(parseFloat(m[1]));
    }
  }
  const buf = Buffer.alloc(peaks.length * 4);
  peaks.forEach((p, i) => {
    buf.writeFloatLE(p, i * 4);
  });
  return buf;
}

export async function copyToLibrary(sourcePath: string, outputDir: string, mediaId: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const ext = extname(sourcePath);
  const outputPath = join(outputDir, 'original' + ext);
  await copyFile(sourcePath, outputPath);
  return outputPath;
}

export async function computeSHA256(filePath: string, chunkSize: number = 65536): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: chunkSize });
    stream.on('data', (chunk) => { hash.update(chunk); });
    stream.on('end', () => resolvePromise(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function computeFingerprint(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const size = statSync(filePath).size;
  if (size > 0) {
    hash.update(readFileSync(filePath, { encoding: null, flag: 'r' }).subarray(0, Math.min(size, 1024 * 1024)));
  }
  if (size > 1024 * 1024) {
    const end = statSync(filePath).size - 1024 * 1024;
    const stream = createReadStream(filePath, { start: end });
    stream.on('data', (d) => hash.update(d));
    await new Promise<void>((r) => stream.on('end', () => r()));
  }
  return hash.digest('hex');
}

export function getFreeDiskSpace(dir: string): Promise<number> {
  return new Promise((resolvePromise) => {
    import('node:fs').then(({ statfs }) => {
      statfs(dir, (err, stats) => {
        if (err) resolvePromise(0);
        else resolvePromise(stats.bavail * stats.bsize);
      });
    });
  });
}

export const ingestSources: IngestSource[] = [
  new YtDlpSource(),
  new DirectFileSource(),
];

export function resolveIngestSource(url: string): IngestSource | null {
  for (const src of ingestSources) {
    if (src.canHandle(url)) return src;
  }
  return null;
}
