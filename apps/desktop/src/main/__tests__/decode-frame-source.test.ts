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
/**
 * A completely still source: one picture, repeated for a second.
 *
 * Any difference between two frames decoded from it is geometry and nothing else,
 * which is what makes it the right source for a keyframe test. Built from raw
 * frames because the bundled ffmpeg 4.1 has no `freeze` filter, and a looped
 * one-frame file would re-encode a single frame rather than repeating it.
 */
function makeStillSource(): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, 'still.mp4');
  const rawPath = join(TMP, 'still.yuv');
  const width = 1920;
  const height = 1080;
  const frame = Buffer.alloc((width * height * 3) / 2, 128);
  // A high-contrast block in one corner: a zoom has to move its edge, and a flat
  // grey field would look identical at every scale.
  for (let y = 100; y < 400; y += 1) {
    for (let x = 200; x < 600; x += 1) frame[y * width + x] = 235;
  }
  writeFileSync(rawPath, Buffer.concat(Array.from({ length: 30 }, () => frame)));
  execFileSync(
    ffmpegPath(),
    ['-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', `${width}x${height}`, '-framerate', '30', '-i', rawPath,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', path],
    { stdio: 'ignore' },
  );
  rmSync(rawPath, { force: true });
  return path;
}

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

describe.skipIf(!HAS_FFMPEG)('decode frame source with keyframes', () => {
  /**
   * SPEC 12 §2.2 — a keyframed scale has to change the picture during an export.
   *
   * ffmpeg 4.1 cannot evaluate `scale` per frame, so the item is decoded in
   * segments. The assertion that matters is not "a filter appeared" but "the
   * second half of the file is a different size than the first", which is only
   * true if the segmentation reached the decoder.
   */
  it('renders an animated scale as segments rather than one frozen value', async () => {
    // A still source, so the only thing that can make frame 0 differ from the last
    // frame is the keyframed geometry. With a moving source the frames differ for
    // reasons that have nothing to do with keyframes, and the test passes whether
    // or not the segmentation ran.
    const source = makeStillSource();
    const plan = buildExportPlan(
      makeSettings({
        preset: '1080p',
        aspect: '16:9',
        rangeUs: [0, 1_000_000],
        compositionDurationUs: 1_000_000,
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
            geometry: { transform: {} },
            keyframes: {
              'transform.scaleX': [
                { timeUs: 0, value: 1 },
                { timeUs: 500_000, value: 2 },
              ],
              'transform.scaleY': [
                { timeUs: 0, value: 1 },
                { timeUs: 500_000, value: 2 },
              ],
            },
          },
        ],
      }),
    );

    const frameSource = createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) });
    await frameSource.open?.(plan);
    // The source is a sequential stream (`FrameSource.next(index)` is called in
    // order by the export runner), so jumping straight to the last index returns
    // the *next* frame, not that one. Read them all.
    let first: Buffer | null = null;
    let later: Buffer | null = null;
    for (let index = 0; index < plan.totalFrames; index += 1) {
      const frame = await frameSource.next(index);
      if (index === 0) first = frame;
      if (index === plan.totalFrames - 1) later = frame;
    }
    await frameSource.close();
    expect(first).toBeTruthy();
    expect(later).toBeTruthy();

    expect(first!.length).toBe(expectedFrameBytes(plan.width, plan.height));
    expect(later!.length).toBe(expectedFrameBytes(plan.width, plan.height));
    // Same still source, same instant of it, different geometry: the only
    // explanation for a different frame is that the second segment was baked at a
    // different scale.
    expect(first!.equals(later!)).toBe(false);
    // And the zoom is the *right* one: 2x about the centre moves the bright block
    // from x=200..599 to x=0..239 on a row through it.
    const brightExtent = (frame: Buffer, row: number) => {
      // yuv420p: the luma plane is the first width*height bytes, one byte per pixel.
      const start = row * plan.width;
      const lit: number[] = [];
      for (let x = 0; x < plan.width; x += 1) if (frame[start + x]! > 200) lit.push(x);
      return lit.length === 0 ? null : { from: lit[0], to: lit[lit.length - 1] };
    };
    const before = brightExtent(first!, 200);
    const after = brightExtent(later!, 200);
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    // A 2x centre zoom maps x -> 2x - width/2, so the block's right edge at 599
    // lands at 239 while its left edge at 200 lands at -560 — off the frame. The
    // visible result is a block whose right edge has moved from ~599 to ~239, which
    // is the zoom's signature: each edge moves *outward from the centre* by its own
    // distance, and the left one simply leaves the frame.
    expect(before!.to).toBeGreaterThan(500);
    expect(after!.to).toBeLessThan(300);
    expect(after!.from).toBe(0);
    const warnings = (frameSource as unknown as { warnings: string[] }).warnings;
    expect(warnings.some((warning) => warning.includes('segments'))).toBe(true);
  }, 120_000);

  it('does not segment an item that is not animated', async () => {
    // The common case has to keep its single decode; a warning here would mean
    // every ordinary export started paying for keyframes nobody placed.
    const source = makeMovingSource();
    const plan = planWithVideo(source);
    const frameSource = createDecodeFrameSource({ plan, resolveMediaPath: resolve(source) });
    await frameSource.open?.(plan);
    await frameSource.next(0);
    await frameSource.close();
    const warnings = (frameSource as unknown as { warnings: string[] }).warnings;
    expect(warnings.some((warning) => warning.includes('segments'))).toBe(false);
  }, 120_000);
});

describe.skipIf(!HAS_FFMPEG)('segmented decode arguments', () => {
  it('builds a filter_complex with one trim per segment and a concat', async () => {
    // Asserting on the arguments is what localises a failure: the picture test
    // below can only say "both frames look the same", which is true both when the
    // segmentation is missing and when ffmpeg silently produced nothing.
    const { segmentedDecodeChain, sourceFilterChain } = await import('@clipwright/export-core');
    const chain = segmentedDecodeChain({
      segments: [
        { startUs: 0, endUs: 500_000 },
        { startUs: 500_000, endUs: 1_000_000 },
      ],
      targetFps: 30,
      sourceInUs: 0,
      chainFor: () => sourceFilterChain({ targetFps: 30, outputWidth: 1080, outputHeight: 1920, fit: 'fit' }),
    });
    expect(chain).toContain('split=2');
    expect(chain).toContain('trim=0.000000:0.500000');
    expect(chain).toContain('trim=0.500000:1.000000');
    expect(chain).toContain('concat=n=2:v=1:a=0[out]');
  });
});
