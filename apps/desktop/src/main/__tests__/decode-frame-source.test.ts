// @vitest-environment node
/**
 * SPEC 14 §4.2 — decoding real footage into export frames.
 *
 * These tests build a synthetic source clip with a known pattern, decode it back
 * through the production `createDecodeFrameSource`, and assert on the *pixels*:
 * a wrong resolution, a wrong colour range, a black canvas where there should be
 * footage, or a frame-count drift would all be caught here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDecodeFrameSource, blankFrame } from '../export/decode-frame-source.js';
import { expectedFrameBytes, runExportJob } from '../export/export-runner.js';
import { ffmpegPath, ffprobePath, probeOutputFile } from '../export/ffmpeg-runner.js';
import { buildExportPlan, type ExportPlan, type ExportSettings } from '@clipwright/export-core';

const TMP = join(process.cwd(), '.tmp-decode-source');
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const SOURCE_W = 320;
const SOURCE_H = 180;

/**
 * Build a white-on-black source clip.
 *
 * Frame 0 is fully white; later frames are black. That makes "did the decoder
 * deliver frame 0" answerable by looking at one luma byte.
 */
function makeWhiteFirstSource(): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, 'white-first.mp4');
  const rawPath = join(TMP, 'white-first.yuv');
  const frameBytes = expectedFrameBytes(SOURCE_W, SOURCE_H);
  const ySize = SOURCE_W * SOURCE_H;
  const frames: Buffer[] = [];
  for (let index = 0; index < 30; index += 1) {
    const frame = Buffer.alloc(frameBytes, 128);
    frame.fill(index === 0 ? 235 : 16, 0, ySize);
    frames.push(frame);
  }
  writeFileSync(rawPath, Buffer.concat(frames));
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', `${SOURCE_W}x${SOURCE_H}`, '-framerate', '30', '-i', rawPath,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-y', path,
    ],
    { stdio: 'ignore' },
  );
  rmSync(rawPath, { force: true });
  return path;
}

/**
 * A source whose first frame is white and the rest contain a moving bright bar
 * on a mid-grey field — bright enough that `blackdetect` finds nothing, so the
 * validation report can legitimately reach "verified".
 */
function makeMovingSource(): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, 'moving.mp4');
  const rawPath = join(TMP, 'moving.yuv');
  const frameBytes = expectedFrameBytes(SOURCE_W, SOURCE_H);
  const ySize = SOURCE_W * SOURCE_H;
  const frames: Buffer[] = [];
  for (let index = 0; index < 30; index += 1) {
    const frame = Buffer.alloc(frameBytes, 128);
    frame.fill(index === 0 ? 235 : 120, 0, ySize);
    const barX = (index * 8) % SOURCE_W;
    for (let y = 0; y < SOURCE_H; y += 1) {
      for (let x = barX; x < Math.min(SOURCE_W, barX + 40); x += 1) {
        frame[y * SOURCE_W + x] = 220;
      }
    }
    frames.push(frame);
  }
  writeFileSync(rawPath, Buffer.concat(frames));
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', `${SOURCE_W}x${SOURCE_H}`, '-framerate', '30', '-i', rawPath,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-y', path,
    ],
    { stdio: 'ignore' },
  );
  rmSync(rawPath, { force: true });
  return path;
}

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-d',
    projectId: 'proj-d',
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
    rangeUs: [0, 1_000_000],
    compositionFps: 30,
    compositionDurationUs: 1_000_000,
    items: [],
    ...overrides,
  };
}

function planWithVideo(mediaPath: string | undefined): ExportPlan {
  return buildExportPlan(
    makeSettings({
      items: [
        {
          id: 'item-video',
          trackId: 'track-video',
          type: 'video',
          mediaId: 'media-1',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          sourceDurationUs: 1_000_000,
          disabled: false,
          muted: false,
          hasAudio: false,
        },
      ],
    }),
  );
}

const resolve = (path: string | undefined) => (mediaId: string) =>
  mediaId === 'media-1' ? path : undefined;

describe('blankFrame', () => {
  it('is the right size for yuv420p', () => {
    expect(blankFrame(1280, 720).length).toBe(expectedFrameBytes(1280, 720));
  });

  it('is black, not mid-grey, in the luma plane', () => {
    const frame = blankFrame(64, 64);
    expect(frame[0]).toBe(16);
    expect(frame[64 * 64]).toBe(128); // neutral chroma
  });
});

describe.skipIf(!HAS_FFMPEG)('createDecodeFrameSource', () => {
  it('delivers real decoded frames at the export resolution', async () => {
    const source = makeWhiteFirstSource();
    const plan = planWithVideo(source);
    const frames = createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) });
    await frames.open?.(plan);

    const first = await frames.next(0);
    expect(first.length).toBe(expectedFrameBytes(plan.width, plan.height));
    // The source's frame 0 was pure white; the exported frame must be bright.
    const ySize = plan.width * plan.height;
    const averageLuma = average(first.subarray(0, ySize));
    expect(averageLuma, 'first frame should carry the white frame').toBeGreaterThan(180);

    const later = await frames.next(10);
    const laterLuma = average(later.subarray(0, ySize));
    expect(laterLuma, 'later frames should be black').toBeLessThan(40);

    await frames.close();
  }, 60_000);

  it('letterboxes a 16:9 source into a 9:16 canvas without cropping', async () => {
    const source = makeWhiteFirstSource();
    const plan = buildExportPlan(
      makeSettings({
        aspect: '9:16',
        items: [
          {
            id: 'item-video',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-1',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            durationUsFallback: undefined,
            disabled: false,
            muted: false,
            hasAudio: false,
          } as never,
        ],
      }),
    );
    const frames = createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) });
    await frames.open?.(plan);
    const frame = await frames.next(0);
    const ySize = plan.width * plan.height;
    const middleRow = plan.height / 2;
    // The picture is in the middle band; the top and bottom are padded black.
    const topLuma = average(frame.subarray(0, plan.width * 20));
    const middleLuma = average(frame.subarray(plan.width * (middleRow - 10), plan.width * (middleRow + 10)));
    expect(topLuma).toBeLessThan(40);
    expect(middleLuma).toBeGreaterThan(120);
    expect(frame.length).toBe(expectedFrameBytes(plan.width, plan.height));
    void ySize;
    await frames.close();
  }, 60_000);

  it('returns the canvas colour where the timeline is empty', async () => {
    const source = makeWhiteFirstSource();
    // Two seconds of range, but the video item only covers the first second, so
    // every frame from 30 onward has nothing on the timeline.
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 2_000_000],
        compositionDurationUs: 2_000_000,
        items: [
          {
            id: 'item-video',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-1',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: false,
          },
        ],
      }),
    );
    const frames = createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) });
    await frames.open?.(plan);
    const empty = await frames.next(plan.totalFrames - 1);
    const ySize = plan.width * plan.height;
    expect(average(empty.subarray(0, ySize))).toBeLessThan(40);
    await frames.close();
  }, 60_000);

  it('refuses to start when the source file is missing', async () => {
    const plan = planWithVideo(join(TMP, 'gone.mp4'));
    const frames = createDecodeFrameSource({ plan, resolveMediaPath: resolve(join(TMP, 'gone.mp4')) });
    await expect(frames.open?.(plan)).rejects.toThrow(/can't be found/);
    await frames.close();
  });

  it('ends the export cleanly when the source is shorter than the item', async () => {
    const source = makeWhiteFirstSource();
    // Ask for 3 seconds from a 1-second file.
    const plan = buildExportPlan(
      makeSettings({
        rangeUs: [0, 3_000_000],
        compositionDurationUs: 3_000_000,
        items: [
          {
            id: 'item-video',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-1',
            startUs: 0,
            durationUs: 3_000_000,
            sourceInUs: 0,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: false,
          },
        ],
      }),
    );
    const frames = createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) });
    await frames.open?.(plan);
    // Every frame must still be produced (the last good frame repeats, then the
    // canvas colour) — never a short read or a hang.
    for (let index = 0; index < plan.totalFrames; index += 1) {
      const frame = await frames.next(index);
      expect(frame.length).toBe(expectedFrameBytes(plan.width, plan.height));
    }
    await frames.close();
  }, 90_000);
});

describe.skipIf(!HAS_FFMPEG)('exporting decoded footage', () => {
  it('produces a file containing the source frame, not a solid colour', async () => {
    const source = makeMovingSource();
    const plan = planWithVideo(source);
    const outputPath = join(TMP, 'decoded-export.mp4');
    const result = await runExportJob({
      jobId: 'job-decoded',
      settings: makeSettings({
        items: [
          {
            id: 'item-video',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-1',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            sourceDurationUs: 1_000_000,
            disabled: false,
            muted: false,
            hasAudio: false,
          },
        ],
      }),
      outputPath,
      frameSource: createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) }),
      fullDecode: true,
    });

    expect(existsSync(outputPath)).toBe(true);
    expect(result.status, JSON.stringify(result.validation?.checks, null, 2)).toBe('verified');

    const probe = await probeOutputFile(outputPath, { countFrames: true });
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.frameCount).toBe(plan.totalFrames);
  }, 120_000);
});

/** Mean of a buffer's bytes. */
function average(buffer: Buffer): number {
  let sum = 0;
  for (const byte of buffer) sum += byte;
  return sum / Math.max(1, buffer.length);
}
