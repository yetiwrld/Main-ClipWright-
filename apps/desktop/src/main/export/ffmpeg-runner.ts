/**
 * SPEC 14 — process orchestration around the bundled ffmpeg/ffprobe.
 *
 * This module owns *running* binaries: locating them, probing their
 * capabilities, spawning with cancellation, and turning their output into the
 * plain measurements `ProbeResult` expects. Every number it reports comes from a
 * real process exit or a parsed ffprobe field — nothing is assumed (SPEC 14 §7).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProbeResult } from '@clipwright/export-core';
import { detectCapabilities, type EncoderCapabilities } from '@clipwright/export-core';
import { getFFmpegPath, getFFprobePath } from '@clipwright/media-core';

/** Resolve the bundled binary, falling back to whichever path exists first. */
function resolveBinary(preferred: string, name: string): string {
  const candidates = [
    preferred,
    resolve(join(process.cwd(), 'resources', 'bin', name)),
    resolve(join(dirname(process.execPath), '..', 'resources', 'bin', name)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Nothing bundled: let the OS try PATH so dev machines still work.
  return name;
}

export function ffmpegPath(): string {
  return resolveBinary(getFFmpegPath(), 'ffmpeg');
}

export function ffprobePath(): string {
  return resolveBinary(getFFprobePath(), 'ffprobe');
}

/** Thrown when a child process is cancelled on purpose rather than failing. */
export class CancelledError extends Error {
  constructor(message = 'Export cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Collect stderr so callers can parse measurements out of it. */
  captureStderr?: boolean;
  /** Feed this into the child's stdin, then close it. */
  stdinData?: Buffer | string;
  /** Aborting kills the process and rejects with `CancelledError`. */
  signal?: AbortSignal;
  /** Cap on captured stderr; older bytes are dropped. */
  maxStderrBytes?: number;
  /** Called with each stderr chunk as it arrives (for progress parsing). */
  onStderr?: (chunk: string) => void;
}

/**
 * Run a binary to completion.
 *
 * A non-zero exit is returned (not thrown) so the caller can attach ffmpeg's own
 * words to the error message it shows the user (SPEC 14 §8 keeps raw output out
 * of the UI but keeps it in the job log).
 */
export function run(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Below-normal priority keeps the editor responsive during an export
      // (SPEC 14 §6, §10).
      windowsHide: true,
    });
    if (options.captureStderr !== false) child.stdout.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    const maxStderr = options.maxStderrBytes ?? 256 * 1024;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxStderr) stdout = stdout.slice(-maxStderr);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr);
      options.onStderr?.(chunk);
    });

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });

    child.stdin.on('error', () => undefined);
    if (options.stdinData !== undefined) {
      child.stdin.end(options.stdinData);
    } else {
      child.stdin.end();
    }
  });
}

/** Probe capabilities of the installed ffmpeg build once per app run. */
let capabilitiesCache: EncoderCapabilities | null = null;
export async function encoderCapabilities(): Promise<EncoderCapabilities> {
  if (capabilitiesCache) return capabilitiesCache;
  try {
    const result = await run(ffmpegPath(), ['-hide_banner', '-h', 'full'], {
      maxStderrBytes: 4 * 1024 * 1024,
    });
    capabilitiesCache = detectCapabilities(`${result.stdout}\n${result.stderr}`);
  } catch {
    // If the help call itself failed we do not pretend to know; the legacy
    // spelling is accepted by every release.
    capabilitiesCache = { fpsMode: false };
  }
  return capabilitiesCache;
}

/** Which encoders this build actually contains (used for the dialog's options). */
export async function listEncoders(): Promise<Set<string>> {
  try {
    const { stdout } = await run(ffmpegPath(), ['-hide_banner', '-encoders']);
    const names = new Set<string>();
    for (const line of stdout.split('\n')) {
      const match = /^\s*[VAS][\w.]*\s+(\S+)/.exec(line);
      if (match) names.add(match[1]);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Validate a hardware encoder by running a 1-second test encode of synthetic
 * frames (SPEC 14 §3.4: "show only validated options").
 *
 * This is the only thing that may switch the dialog to a hardware encoder: a
 * `-encoders` listing is not proof the device works.
 */
export async function probeHardwareEncoder(
  encoder: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string }> {
  const width = 640;
  const height = 360;
  const frameCount = 30;
  const frame = Buffer.alloc(width * height * 3 / 2, 128);
  const frames = Buffer.concat(Array.from({ length: 30 }, () => frame));
  try {
    const result = await run(
      ffmpegPath(),
      [
        '-hide_banner', '-nostdin',
        '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
        '-s', `${width}x${height}`, '-framerate', '30', '-i', 'pipe:0',
        '-c:v', encoder, '-frames:v', String(frameCount),
        '-f', 'null', '-',
      ],
      { stdinData: frames, signal, maxStderrBytes: 32 * 1024 },
    );
    return result.code === 0 ? { ok: true } : { ok: false, reason: firstErrorLine(result.stderr) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** First meaningful ffmpeg error line, for logs and readable messages. */
export function firstErrorLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('frame=') && !line.startsWith('size='));
  return lines[0] ?? 'The encoder stopped unexpectedly.';
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_read_frames?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  start_time?: string;
  duration?: string;
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_range?: string;
}

interface FfprobeFormat {
  size?: string;
  duration?: string;
}

/**
 * Measure a produced file with ffprobe and fill a `ProbeResult`.
 *
 * `moovAtStart` is decided by looking for the `moov` atom's byte offset in the
 * MP4 header rather than by trusting the encoder flags we passed (SPEC 14 §7
 * check 9 is about the file, not about our intentions).
 */
export async function probeOutputFile(
  filePath: string,
  options: { countFrames?: boolean; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const args = [
    '-v', 'error',
    '-show_format', '-show_streams',
    ...(options.countFrames ? ['-count_frames'] : []),
    '-of', 'json',
    filePath,
  ];
  const { stdout, code, stderr } = await run(ffprobePath(), args, {
    signal: options.signal,
    maxStderrBytes: 64 * 1024,
  });
  if (code !== 0) {
    return emptyProbe(filePath);
  }
  let parsed: { streams?: FfprobeStream[]; format?: FfprobeFormat };
  try {
    parsed = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: FfprobeFormat };
  } catch {
    return emptyProbe(filePath, stderr);
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const sizeBytes = Number(parsed.format?.size ?? 0);
  const countFrames = options.countFrames && video?.nb_read_frames !== undefined
    ? Number(video.nb_read_frames)
    : undefined;

  return {
    exists: true,
    sizeBytes,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    durationSeconds: Number(parsed.format?.duration ?? video?.duration ?? 0),
    frameRate: String(video?.r_frame_rate ?? '0/1'),
    avgFrameRate: String(video?.avg_frame_rate ?? video?.r_frame_rate ?? '0/1'),
    hasVideoStream: Boolean(video),
    hasAudioStream: Boolean(audio),
    videoCodec: String(video?.codec_name ?? ''),
    audioCodec: String(audio?.codec_name ?? ''),
    pixelFormat: String(video?.pix_fmt ?? ''),
    profile: String(video?.profile ?? ''),
    audioSampleRate: Number(audio?.sample_rate ?? 0),
    audioChannels: Number(audio?.channels ?? 0),
    frameCount: countFrames,
    moovAtStart: await moovIsAtStart(filePath),
    containerDurationSeconds: Number(parsed.format?.duration ?? 0),
    videoStartSeconds: video ? Number(video.start_time ?? 0) : undefined,
    audioStartSeconds: audio ? Number(audio.start_time ?? 0) : undefined,
    videoBitrateBps: video?.bit_rate ? Number(video.bit_rate) : undefined,
    colorSpace: video?.color_space,
    colorPrimaries: video?.color_primaries,
    colorTransfer: video?.color_transfer,
    colorRange: video?.color_range,
  };
}

function emptyProbe(filePath: string, _detail = ''): ProbeResult {
  return {
    exists: existsSync(filePath),
    sizeBytes: 0,
    width: 0,
    height: 0,
    durationSeconds: 0,
    frameRate: '0/1',
    hasVideoStream: false,
    hasAudioStream: false,
    videoCodec: '',
    audioCodec: '',
    pixelFormat: '',
    profile: '',
    audioSampleRate: 0,
    audioChannels: 0,
    moovAtStart: false,
  };
}

/**
 * Is the `moov` atom ahead of `mdat`?
 *
 * ffprobe does not expose this, so we walk the top-level MP4 boxes directly.
 * A streamed MP4 with faststart has `moov` first; an unfaststarted one has
 * `mdat` first and cannot start playing until it is fully downloaded.
 */
export async function moovIsAtStart(filePath: string): Promise<boolean> {
  const { open } = await import('node:fs/promises');
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, 64, 0);
    if (bytesRead < 16) return false;
    // WebM/Matroska: seekable by design, treat as fine.
    if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return true;
    let offset = 0;
    for (let box = 0; box < 8 && offset + 8 <= bytesRead; box += 1) {
      const size = header.readUInt32BE(offset);
      const type = header.toString('ascii', offset + 4, offset + 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (size < 8) return false;
      if (offset + size >= bytesRead) {
        // Box extends past the header window; read its type at the new offset.
        const next = Buffer.alloc(16);
        const read = await handle.read(next, 0, 16, offset + size);
        if (read.bytesRead < 8) return false;
        const nextType = next.toString('ascii', 4, 8);
        if (nextType === 'moov') return true;
        if (nextType === 'mdat') return false;
        const nextSize = next.readUInt32BE(0);
        if (nextSize < 8) return false;
        offset += size;
        continue;
      }
      offset += size;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Full decode pass: `ffmpeg -v error -i file -f null -`.
 *
 * Returns the number of error lines plus the first one, which is exactly what
 * check 8 needs. Cancellable so a user can stop a long verify.
 */
export async function decodeCheck(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ errors: number; detail?: string }> {
  try {
    const { stderr, code } = await run(
      ffmpegPath(),
      ['-v', 'error', '-nostdin', '-i', filePath, '-f', 'null', '-'],
      { signal, maxStderrBytes: 128 * 1024 },
    );
    const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
    if (code !== 0 && lines.length === 0) {
      return { errors: 1, detail: `Decode exited with code ${code}.` };
    }
    return { errors: lines.length, detail: lines[0] };
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    return { errors: 1, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Count `blackdetect`/`freezedetect` segments, so check 11/12 measure the file. */
export async function detectSegments(
  filePath: string,
  filter: 'black' | 'freeze',
  signal?: AbortSignal,
): Promise<number> {
  const filterSpec = filter === 'black' ? 'blackdetect=d=0.5:pic_th=0.98' : 'freezedetect=n=-60dB:d=2';
  const pattern = filter === 'black' ? /black_start:/g : /freeze_start:/g;
  try {
    const { stderr } = await run(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-i', filePath, '-vf', filterSpec, '-f', 'null', '-'],
      { signal, maxStderrBytes: 256 * 1024 },
    );
    return (stderr.match(pattern) ?? []).length;
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    return 0;
  }
}

/** Decode-to-PCM args: 48 kHz stereo float, used to build the mix (SPEC 14 §5.1). */
export function audioDecodeArgs(sourcePath: string, inUs: number, durationUs: number): string[] {
  return [
    '-hide_banner', '-nostdin',
    '-ss', (inUs / 1_000_000).toFixed(6),
    '-i', sourcePath,
    '-t', (durationUs / 1_000_000).toFixed(6),
    '-vn',
    '-ac', '2', '-ar', '48000',
    '-f', 'f32le',
    '-',
  ];
}
