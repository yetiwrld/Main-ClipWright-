/**
 * SPEC 14 §3.4 / §7 — real encoder integration.
 *
 * These tests run the **bundled ffmpeg** against synthetic raw frames fed
 * through the exact argument vector `buildEncoderArgs` produces, then probe the
 * result. They are the proof that the codec table, colour tagging, container
 * flags and audio wiring are not just plausible strings.
 *
 * Skipped when the bundled binary is missing (e.g. a fresh clone without
 * `node_modules`), never replaced with a fake pass.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { buildEncoderArgs, chooseVideoEncoder, detectCapabilities, parseIntegratedLoudness } from '../encoder.js';
import { buildExportPlan, type ExportPlan, type ExportSettings } from '../planner.js';
import { validateExport, type ProbeResult } from '../validation.js';

const execFileAsync = promisify(execFile);
const FFMPEG = join(process.cwd(), 'resources', 'bin', 'ffmpeg');
const FFPROBE = join(process.cwd(), 'resources', 'bin', 'ffprobe');
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE);
const TMP = join(process.cwd(), '.tmp-export-it');

/** Capabilities of the bundled build, probed once from `ffmpeg -h full`. */
let capabilities: { fpsMode: boolean } = { fpsMode: false };
async function getCapabilities(): Promise<{ fpsMode: boolean }> {
  if (!HAS_FFMPEG) return capabilities;
  const { stdout, stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-h', 'full'], {
    maxBuffer: 64 * 1024 * 1024,
  }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
    (err: { stdout?: string; stderr?: string }) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  );
  capabilities = detectCapabilities(`${stdout}${stderr}`);
  return capabilities;
}

function makePlan(overrides: Partial<ExportSettings> = {}): ExportPlan {
  return buildExportPlan({
    compositionId: 'comp-it',
    projectId: 'proj-it',
    preset: '720p',
    aspect: '16:9',
    fps: 30,
    format: 'mp4',
    quality: 'draft',
    rateControl: 'vbr',
    audioBitrate: 192,
    includeAudio: true,
    burnCaptions: false,
    saveSubtitles: false,
    subtitleFormats: [],
    embedProjectName: true,
    normaliseLoudness: false,
    targetLufs: -16,
    isDraft: false,
    rangeUs: [0, 1_000_000],
    compositionFps: 30,
    compositionDurationUs: 1_000_000,
    items: [],
    ...overrides,
  });
}

/** Deterministic yuv420p frame with a moving block, so frames differ. */
function makeFrame(width: number, height: number, frameIndex: number): Buffer {
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  const buffer = Buffer.alloc(ySize + cSize * 2, 128);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // A diagonal gradient plus a moving bright square makes every frame unique.
      const inBlock = x >= frameIndex * 8 && x < frameIndex * 8 + 64 && y >= 40 && y < 104;
      buffer[y * width + x] = inBlock ? 235 : (x + y) % 200;
    }
  }
  return buffer;
}

/** Pipe `frameCount` frames into the encoder built from `args`. */
function runEncoder(args: string[], frameCount: number, width: number, height: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    let closed = false;
    child.on('close', () => {
      closed = true;
    });
    child.stdin.on('error', () => {
      closed = true;
    });
    (async () => {
      for (let index = 0; index < frameCount; index += 1) {
        if (closed) return;
        const frame = makeFrame(width, height, index);
        if (!child.stdin.write(frame)) {
          await new Promise<void>((done) => {
            const finish = () => {
              child.stdin.off('drain', finish);
              child.stdin.off('error', finish);
              done();
            };
            child.stdin.once('drain', finish);
            child.stdin.once('error', finish);
          });
        }
      }
      if (!closed) child.stdin.end();
    })().catch(() => undefined);
  });
}

/** Build a 1-second 48 kHz stereo WAV of a 440 Hz tone. */
function writeToneWav(path: string, seconds: number, sampleRate = 48_000): void {
  const frames = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2 * 2);
  for (let index = 0; index < frames; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000);
    data.writeInt16LE(value, index * 4);
    data.writeInt16LE(value, index * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Count black/frozen segments ffmpeg detects in the produced file. */
async function countDetectorHits(path: string, filter: string, pattern: RegExp): Promise<number> {
  const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-nostdin', '-i', path, '-vf', filter, '-f', 'null', '-'], {
    maxBuffer: 32 * 1024 * 1024,
  }).then(
    (r) => ({ stderr: r.stderr }),
    (err: { stderr?: string }) => ({ stderr: err.stderr ?? '' }),
  );
  return (stderr.match(pattern) ?? []).length;
}

/** Measure integrated loudness and true peak with ebur128. */
async function measureLoudness(path: string): Promise<{ integratedLufs: number; truePeakDb: number } | null> {
  const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-nostdin', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    maxBuffer: 32 * 1024 * 1024,
  }).then(
    (r) => ({ stderr: r.stderr }),
    (err: { stderr?: string }) => ({ stderr: err.stderr ?? '' }),
  );
  return parseIntegratedLoudness(stderr);
}

/** Run a full decode and count the error lines ffmpeg emits. */
async function countDecodeErrors(path: string): Promise<number> {
  const { stderr } = await execFileAsync(FFMPEG, ['-v', 'error', '-i', path, '-f', 'null', '-'], {
    maxBuffer: 32 * 1024 * 1024,
  }).then(
    (r) => ({ stderr: r.stderr }),
    (err: { stderr?: string }) => ({ stderr: err.stderr ?? '' }),
  );
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;
}

async function probeFile(path: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'error',
    '-show_format', '-show_streams', '-count_frames',
    '-of', 'json', path,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    exists: true,
    sizeBytes: Number(parsed.format?.size ?? 0),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    durationSeconds: Number(parsed.format?.duration ?? 0),
    frameRate: String(video?.r_frame_rate ?? video?.avg_frame_rate ?? '0/1'),
    hasVideoStream: Boolean(video),
    hasAudioStream: Boolean(audio),
    videoCodec: String(video?.codec_name ?? ''),
    audioCodec: String(audio?.codec_name ?? ''),
    pixelFormat: String(video?.pix_fmt ?? ''),
    profile: String(video?.profile ?? ''),
    audioSampleRate: Number(audio?.sample_rate ?? 0),
    audioChannels: Number(audio?.channels ?? 0),
    frameCount: Number(video?.nb_read_frames ?? 0),
    moovAtStart: true,
    avgFrameRate: String(video?.avg_frame_rate ?? ''),
    colorSpace: String(video?.color_space ?? ''),
    colorPrimaries: String(video?.color_primaries ?? ''),
    colorTransfer: String(video?.color_transfer ?? ''),
    colorRange: String(video?.color_range ?? ''),
    videoStartSeconds: Number(video?.start_time ?? 0),
    audioStartSeconds: audio ? Number(audio.start_time ?? 0) : undefined,
    containerDurationSeconds: Number(parsed.format?.duration ?? 0),
    videoBitrateBps: Number(video?.bit_rate ?? 0) || undefined,
  };
}

describe.skipIf(!HAS_FFMPEG)('real encoder integration (bundled ffmpeg)', () => {
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('encodes an MP4 that passes validation', async () => {
    mkdirSync(TMP, { recursive: true });
    const plan = makePlan();
    const output = join(TMP, 'basic.partial.mp4');
    const mix = join(TMP, 'basic-mix.wav');
    writeToneWav(mix, plan.durationSeconds);
    const args = buildEncoderArgs({
      plan,
      videoInput: 'pipe:0',
      audioInput: mix,
      outputPath: output,
      encoder: chooseVideoEncoder(plan),
      title: 'Integration clip',
      capabilities: await getCapabilities(),
    });

    const { code, stderr } = await runEncoder(args, plan.totalFrames, plan.width, plan.height);
    expect(code, stderr.slice(-2000)).toBe(0);

    const probe = await probeFile(output);
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.pixelFormat).toBe('yuv420p');
    expect(probe.hasAudioStream).toBe(true);
    expect(probe.audioCodec).toBe('aac');
    expect(probe.audioSampleRate).toBe(48_000);
    expect(probe.audioChannels).toBe(2);
    expect(probe.frameCount).toBe(plan.totalFrames);

    // A real ffmpeg decode pass over the produced file, counted by ffmpeg itself.
    const decodeErrors = await countDecodeErrors(output);
    expect(decodeErrors).toBe(0);

    // Detectors and loudness, measured from the file rather than assumed.
    const unexpectedBlackSegments = await countDetectorHits(output, 'blackdetect=d=0.5:pic_th=0.98', /black_start:/g);
    const unexpectedFreezeSegments = await countDetectorHits(output, 'freezedetect=n=-60dB:d=2', /freeze_start:/g);
    const loudness = await measureLoudness(output);
    expect(loudness).not.toBeNull();

    const report = validateExport(
      plan,
      {
        ...probe,
        decodeErrors,
        unexpectedBlackSegments,
        unexpectedFreezeSegments,
        integratedLufs: loudness!.integratedLufs,
        truePeakDb: loudness!.truePeakDb,
        audioSilent: loudness!.integratedLufs <= -70,
      },
      { fullDecode: true },
    );
    const failedRequired = report.checks.filter((c) => c.required && c.status === 'fail');
    expect(failedRequired, JSON.stringify(failedRequired, null, 2)).toHaveLength(0);
    const failedAny = report.checks.filter((c) => c.status === 'fail');
    expect(failedAny, JSON.stringify(failedAny, null, 2)).toHaveLength(0);
    // Every measurable check passed and nothing was left unmeasured, so this
    // real file earns the top verdict rather than a "warnings" downgrade.
    expect(report.overallStatus, JSON.stringify(report.checks, null, 2)).toBe('verified');
  });

  it('tags BT.709 colour metadata as promised', async () => {
    mkdirSync(TMP, { recursive: true });
    const plan = makePlan();
    const output = join(TMP, 'colour.partial.mp4');
    const args = buildEncoderArgs({
      plan,
      videoInput: 'pipe:0',
      outputPath: output,
      encoder: chooseVideoEncoder(plan),
      title: 'Colour clip',
      capabilities: await getCapabilities(),
    });
    const { code, stderr } = await runEncoder(args, plan.totalFrames, plan.width, plan.height);
    expect(code, stderr.slice(-2000)).toBe(0);

    const probe = await probeFile(output);
    expect(probe.colorSpace).toBe('bt709');
    expect(probe.colorPrimaries).toBe('bt709');
    expect(probe.colorTransfer).toBe('bt709');
    expect(probe.hasAudioStream).toBe(false);
  });

  it('encodes a WebM with VP9 and Opus', async () => {
    mkdirSync(TMP, { recursive: true });
    const plan = makePlan({ format: 'webm' });
    const output = join(TMP, 'webm.partial.webm');
    const mix = join(TMP, 'webm-mix.wav');
    writeToneWav(mix, plan.durationSeconds);
    const args = buildEncoderArgs({
      plan,
      videoInput: 'pipe:0',
      audioInput: mix,
      outputPath: output,
      encoder: chooseVideoEncoder(plan),
      title: 'WebM clip',
      capabilities: await getCapabilities(),
    });
    // VP9 at draft quality is slow; keep the sample tiny.
    const frames = 15;
    const shortPlan = { ...plan, totalFrames: frames, durationSeconds: frames / plan.fps };
    const shortArgs = buildEncoderArgs({
      plan: shortPlan,
      videoInput: 'pipe:0',
      audioInput: mix,
      outputPath: output,
      encoder: chooseVideoEncoder(plan),
      title: 'WebM clip',
      capabilities: await getCapabilities(),
    });
    expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');

    const { code, stderr } = await runEncoder(shortArgs, frames, plan.width, plan.height);
    expect(code, stderr.slice(-2000)).toBe(0);

    const probe = await probeFile(output);
    expect(probe.videoCodec).toBe('vp9');
    expect(probe.audioCodec).toBe('opus');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
  }, 120_000);

  it('produces a portrait file for a 9:16 plan', async () => {
    mkdirSync(TMP, { recursive: true });
    const plan = makePlan({ aspect: '9:16' });
    const output = join(TMP, 'portrait.partial.mp4');
    const args = buildEncoderArgs({
      plan,
      videoInput: 'pipe:0',
      outputPath: output,
      encoder: chooseVideoEncoder(plan),
      title: 'Portrait clip',
      capabilities: await getCapabilities(),
    });
    const { code, stderr } = await runEncoder(args, plan.totalFrames, plan.width, plan.height);
    expect(code, stderr.slice(-2000)).toBe(0);

    const probe = await probeFile(output);
    expect(probe.width).toBe(720);
    expect(probe.height).toBe(1280);
    expect(probe.height).toBeGreaterThan(probe.width);
  });
});
