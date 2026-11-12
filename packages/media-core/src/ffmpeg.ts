/**
 * FFmpeg/ffprobe resolution, command building (pure) and running.
 * Binaries resolve from: packaged <resourcesPath>/bin, env CLIPWRIGHT_FFMPEG/CLIPWRIGHT_FFPROBE,
 * ffmpeg-static/ffprobe-static packages, then PATH.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

export interface BinaryPaths { ffmpeg: string | null; ffprobe: string | null; }

const nodeRequire = createRequire(import.meta.url);

const tryRequire = (name: string): string | null => {
  try {
    const mod = nodeRequire(name) as string | { path?: string } | undefined;
    if (typeof mod === 'string' && existsSync(mod)) return mod;
    if (mod && typeof mod === 'object' && mod.path && existsSync(mod.path)) return mod.path;
    return null;
  } catch {
    return null;
  }
};

export const resolveBinaries = (): BinaryPaths => {
  const fromEnv = (v?: string) => (v && existsSync(v) ? v : null);
  // Packaged app: extraResources places ffmpeg.exe/ffprobe.exe in <resourcesPath>/bin.
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = (name: string) => {
    if (!resources) return null;
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const p = `${resources}/bin/${exe}`;
    return existsSync(p) ? p : null;
  };
  const onPath = (name: string) => {
    const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    for (const d of dirs) {
      const p = `${d}/${exe}`;
      if (existsSync(p)) return p;
    }
    return null;
  };
  return {
    ffmpeg: fromEnv(process.env.CLIPWRIGHT_FFMPEG) ?? packaged('ffmpeg') ?? tryRequire('ffmpeg-static') ?? onPath('ffmpeg'),
    ffprobe: fromEnv(process.env.CLIPWRIGHT_FFPROBE) ?? packaged('ffprobe') ?? tryRequire('ffprobe-static') ?? onPath('ffprobe'),
  };
};

export class MissingBinaryError extends Error {
  constructor(which: 'ffmpeg' | 'ffprobe') {
    super(`${which} was not found. Reinstall Clipwright Studio or set the CLIPWRIGHT_${which.toUpperCase()} environment variable.`);
    this.name = 'MissingBinaryError';
  }
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgressLine?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface RunResult { code: number | null; stdout: string; stderrTail: string; }

/** Run a child process to completion. Never rejects for non-zero exit — inspect code. */
export const runProcess = (bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const stderrTail: string[] = [];
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });

    let lineBuf = '';
    child.stdout!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      if (opts.onProgressLine) {
        lineBuf += s;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const l of lines) opts.onProgressLine(l);
      }
    });
    let errBuf = '';
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      errBuf += s;
      const lines = errBuf.split('\n');
      errBuf = lines.pop() ?? '';
      for (const l of lines) {
        stderrTail.push(l);
        if (stderrTail.length > 40) stderrTail.shift();
        opts.onStderr?.(l);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderrTail: stderrTail.join('\n') });
    });
  });

export const ffprobeJsonArgs = (input: string): string[] => [
  '-v', 'error',
  '-show_format', '-show_streams',
  '-of', 'json',
  input,
];

export const ffprobeRaw = async (ffprobe: string, input: string, timeoutMs = 30_000): Promise<unknown> => {
  const res = await runProcess(ffprobe, ffprobeJsonArgs(input), { timeoutMs });
  if (res.code !== 0) {
    throw new Error(`ffprobe failed (exit ${res.code}): ${res.stderrTail.split('\n').slice(-3).join(' | ')}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error('ffprobe returned unreadable output.');
  }
};


/**
 * Probe an input, preferring ffprobe; degrades to parsing `ffmpeg -i` stderr
 * when only ffmpeg is available. Returns the normalized probe object and any
 * warnings (fallback output is approximate).
 */
export const probeInput = async (
  bins: BinaryPaths,
  input: string,
  fileSizeBytes?: number,
  timeoutMs = 30_000,
): Promise<{ probe: unknown; warnings: string[] }> => {
  if (bins.ffprobe) {
    return { probe: await ffprobeRaw(bins.ffprobe, input, timeoutMs), warnings: [] };
  }
  if (!bins.ffmpeg) throw new MissingBinaryError('ffmpeg');
  const res = await runProcess(bins.ffmpeg, ['-hide_banner', '-nostdin', '-i', input], { timeoutMs });
  // ffmpeg exits 1 when no output is specified — output goes to stderr
  const text = res.stderrTail + '\n' + res.stdout;
  const { parseFfprobeStderr } = await import('./ffmpeg-fallback.js');
  const parsed = parseFfprobeStderr(text, fileSizeBytes);
  return { probe: { format: parsed.format, streams: parsed.streams }, warnings: parsed.warnings };
};

/* -------------------------------------------------- command builders */
export const buildExtractAudioArgs = (src: string, dst: string, streamIndex = 0): string[] => [
  '-hide_banner', '-nostdin', '-y',
  '-i', src,
  '-map', `0:a:${streamIndex}`,
  '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
  dst,
];

export const buildProxyArgs = (src: string, dst: string, height: 360 | 540 | 720, fps: number): string[] => [
  '-hide_banner', '-nostdin', '-y',
  '-i', src,
  '-map', '0:v:0', '-map', '0:a?',
  '-vf', `scale=-2:${height},fps=${fps},format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
  '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
  '-movflags', '+faststart',
  dst,
];

export const buildThumbnailArgs = (src: string, dst: string, atSeconds: number): string[] => [
  '-hide_banner', '-nostdin', '-y',
  '-ss', atSeconds.toFixed(3),
  '-i', src,
  '-frames:v', '1',
  '-vf', 'scale=320:-2',
  '-q:v', '4',
  dst,
];

export const buildPeaksArgs = (audio16k: string, dstBin: string): string[] => [
  // peaks generation is done in-process by audio-core; this exists only for reference
  '-hide_banner', '-nostdin', '-y', '-i', audio16k, '-f', 'data', '-acodec', 'pcm_s16le', dstBin,
];

/** Parse `-progress pipe:1` key=value lines into a typed event. */
export const parseProgressLine = (line: string): Record<string, string> | null => {
  const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
  if (!m) return null;
  return { [m[1]!]: m[2]! };
};

/** Progress percentage from out_time_us vs total µs. */
export const progressFromOutTime = (outTimeUs: number, totalUs: number): number =>
  totalUs <= 0 ? 0 : Math.min(1, Math.max(0, outTimeUs / totalUs));

/* ---------------------------------------------------- file fingerprints */
export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (d) => hash.update(d as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

/** Cheap reference-mode fingerprint: sha256 of first and last 1 MiB + size. */
export const fastFingerprint = async (path: string, sizeBytes: number): Promise<string> => {
  const CHUNK = 1024 * 1024;
  const hash = createHash('sha256');
  hash.update(String(sizeBytes));
  const fd = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, sizeBytes));
    await fd.read(head, 0, head.length, 0);
    hash.update(head);
    if (sizeBytes > CHUNK) {
      const tail = Buffer.alloc(CHUNK);
      await fd.read(tail, 0, CHUNK, sizeBytes - CHUNK);
      hash.update(tail);
    }
  } finally {
    await fd.close();
  }
  return hash.digest('hex').slice(0, 32);
};
