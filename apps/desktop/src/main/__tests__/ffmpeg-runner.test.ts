// @vitest-environment node
/**
 * SPEC 14 §7 — the measuring side of validation.
 *
 * These tests run the real bundled ffmpeg/ffprobe against real files, because
 * the whole point of the validation report is that its numbers come from the
 * file rather than from our assumptions about it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeCheck,
  detectSegments,
  encoderCapabilities,
  ffmpegPath,
  ffprobePath,
  firstErrorLine,
  moovIsAtStart,
  probeHardwareEncoder,
  probeOutputFile,
} from '../export/ffmpeg-runner.js';

const TMP = join(process.cwd(), '.tmp-runner-it');
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Encode a short clip with the bundled ffmpeg using the given extra args. */
function makeClip(name: string, extra: string[], frames = 30): string {
  mkdirSync(TMP, { recursive: true });
  const output = join(TMP, name);
  const raw = join(TMP, `${name}.yuv`);
  const size = 128 * 128 * 3 / 2;
  const buffer = Buffer.alloc(size * frames);
  for (let index = 0; index < frames; index += 1) {
    // Distinct luma per frame so freezedetect has nothing to trip on.
    buffer.fill(index * 4 % 250, index * size, index * size + 128 * 128);
    buffer.fill(128, index * size + 128 * 128, (index + 1) * size);
  }
  writeFileSync(raw, buffer);
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', '128x128', '-framerate', '30', '-i', raw,
      '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast',
      ...extra,
      '-y', output,
    ],
    { stdio: 'ignore' },
  );
  rmSync(raw, { force: true });
  return output;
}

/** Encode `count` copies of one raw frame into an MP4. */
function encodeFrames(name: string, frame: Buffer, count: number): string {
  mkdirSync(TMP, { recursive: true });
  const output = join(TMP, name);
  const raw = join(TMP, `${name}.yuv`);
  writeFileSync(raw, Buffer.concat(Array.from({ length: count }, () => frame)));
  execFileSync(
    ffmpegPath(),
    ['-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '128x128', '-framerate', '30',
      '-i', raw, '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast', '-y', output],
    { stdio: 'ignore' },
  );
  rmSync(raw, { force: true });
  return output;
}

describe.skipIf(!HAS_FFMPEG)('moovIsAtStart', () => {
  it('is true for a faststart MP4', async () => {
    const file = makeClip('faststart.mp4', ['-movflags', '+faststart']);
    expect(await moovIsAtStart(file)).toBe(true);
  });

  it('agrees with the actual box order for an MP4 without faststart', async () => {
    const file = makeClip('plain.mp4', []);
    // Either order is legal; what matters is that our answer matches the bytes.
    const header = readFileSync(file).subarray(0, 64 * 1024).toString('latin1');
    const moovFirst = header.indexOf('moov') < header.indexOf('mdat');
    expect(await moovIsAtStart(file)).toBe(moovFirst);
  });

  it('treats WebM as seekable', async () => {
    const file = makeClip('clip.webm', ['-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-row-mt', '1'], 10);
    expect(await moovIsAtStart(file)).toBe(true);
  });

  it('is false for a file that does not exist', async () => {
    expect(await moovIsAtStart(join(TMP, 'nope.mp4'))).toBe(false);
  });

  it('is false for a truncated header', async () => {
    mkdirSync(TMP, { recursive: true });
    const file = join(TMP, 'tiny.mp4');
    writeFileSync(file, Buffer.from([0, 0, 0, 1]));
    expect(await moovIsAtStart(file)).toBe(false);
  });
});

describe.skipIf(!HAS_FFMPEG)('probeOutputFile', () => {
  it('measures a real MP4 exactly', async () => {
    const file = makeClip('probe.mp4', ['-movflags', '+faststart', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']);
    const probe = await probeOutputFile(file, { countFrames: true });
    expect(probe.exists).toBe(true);
    expect(probe.width).toBe(128);
    expect(probe.height).toBe(128);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.pixelFormat).toBe('yuv420p');
    expect(probe.frameRate).toBe('30/1');
    expect(probe.frameCount).toBe(30);
    expect(probe.moovAtStart).toBe(true);
    expect(probe.colorPrimaries).toBe('bt709');
    expect(probe.colorTransfer).toBe('bt709');
    expect(probe.hasAudioStream).toBe(false);
    expect(probe.durationSeconds).toBeCloseTo(1, 1);
  });

  it('reports a missing file as not existing instead of throwing', async () => {
    const probe = await probeOutputFile(join(TMP, 'absent.mp4'));
    expect(probe.exists).toBe(false);
    expect(probe.sizeBytes).toBe(0);
    expect(probe.hasVideoStream).toBe(false);
  });
});

describe.skipIf(!HAS_FFMPEG)('decodeCheck', () => {
  it('reports zero errors for a good file', async () => {
    const file = makeClip('good.mp4', []);
    expect((await decodeCheck(file)).errors).toBe(0);
  });

  it('reports errors for a truncated file', async () => {
    const file = makeClip('trunc.mp4', []);
    const { readFileSync, truncateSync } = await import('node:fs');
    const size = readFileSync(file).byteLength;
    truncateSync(file, Math.floor(size * 0.6));
    const result = await decodeCheck(file);
    expect(result.errors).toBeGreaterThan(0);
  });

  it('reports an error for a file that is not video', async () => {
    mkdirSync(TMP, { recursive: true });
    const file = join(TMP, 'garbage.mp4');
    writeFileSync(file, 'not a video at all');
    expect((await decodeCheck(file)).errors).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_FFMPEG)('detectSegments', () => {
  it('finds no black segments in a normal clip', async () => {
    const file = makeClip('noblack.mp4', []);
    expect(await detectSegments(file, 'black')).toBe(0);
  });

  it('finds a black segment in an all-black clip', async () => {
    // yuv420p black is luma 16, chroma 128 — exactly what blackdetect expects.
    const frame = Buffer.alloc(128 * 128 * 3 / 2, 128);
    frame.fill(16, 0, 128 * 128);
    const file = encodeFrames('allblack.mp4', frame, 90);
    expect(await detectSegments(file, 'black')).toBeGreaterThan(0);
  });

  it('finds a freeze in a static clip', async () => {
    const frame = Buffer.alloc(128 * 128 * 3 / 2, 128);
    const file = encodeFrames('frozen.mp4', frame, 120);
    expect(await detectSegments(file, 'freeze')).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_FFMPEG)('capabilities and hardware probe', () => {
  it('detects the bundled build capabilities without throwing', async () => {
    const capabilities = await encoderCapabilities();
    expect(typeof capabilities.fpsMode).toBe('boolean');
  });

  it('validates libx264 as usable', async () => {
    const result = await probeHardwareEncoder('libx264');
    expect(result.ok).toBe(true);
  });

  it('rejects an encoder that does not exist', async () => {
    const result = await probeHardwareEncoder('h264_not_a_real_encoder');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('firstErrorLine', () => {
  it('skips ffmpeg progress noise', () => {
    const stderr = 'frame=  10 fps=0.0\nsize=  12kB time=00:00:01\nInvalid NAL unit size\n';
    expect(firstErrorLine(stderr)).toBe('Invalid NAL unit size');
  });

  it('falls back to a plain message when there is nothing to show', () => {
    expect(firstErrorLine('')).toBe('The encoder stopped unexpectedly.');
  });
});
