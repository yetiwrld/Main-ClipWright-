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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * SPEC 10 §2/§6 — layering has to change the exported pixels.
 *
 * The frame source used to return the topmost visible item and throw the rest
 * away, so an overlay clip's opacity, blend mode and even its *existence* were
 * invisible in the file. These tests decode the produced file and measure it: a
 * solid-colour layer over a solid-colour base makes the expected result a number,
 * and a compositor that quietly does nothing gives a different number.
 */
describe.skipIf(!HAS_FFMPEG)('layering during export', () => {
  /** A one-second solid-colour video at the export's own resolution. */
  function makeSolidSource(name: string, rgb: [number, number, number], width = 1280, height = 720): string {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, name);
    const rawPath = join(TMP, `${name}.rgb`);
    const frame = Buffer.alloc(width * height * 3);
    for (let index = 0; index < frame.length; index += 3) {
      frame[index] = rgb[0];
      frame[index + 1] = rgb[1];
      frame[index + 2] = rgb[2];
    }
    writeFileSync(rawPath, Buffer.concat(Array.from({ length: 30 }, () => frame)));
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', `${width}x${height}`, '-framerate', '30', '-i', rawPath,
        // Force BT.709 through RGB so the source is tagged and converted the same
        // way the compositor decodes it; swscale would otherwise pick BT.601.
        '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
        '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709', '-color_range', 'tv', '-y', path],
      { stdio: 'ignore' },
    );
    rmSync(rawPath, { force: true });
    return path;
  }

  /**
   * A red field with a white box in the middle, for measuring scale.
   *
   * A uniform colour cannot show a zoom: scaling a solid fill looks identical. The
   * box gives a region whose *area* grows when the picture is scaled up, which is
   * what the zoom test counts.
   */
  function makeBoxedSource(name: string, width = 1280, height = 720): string {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, name);
    const rawPath = join(TMP, `${name}.rgb`);
    const frame = Buffer.alloc(width * height * 3);
    for (let index = 0; index < frame.length; index += 3) {
      frame[index] = 200;
      frame[index + 1] = 40;
      frame[index + 2] = 40;
    }
    // A box a sixth of the frame across, centred: 1/36 of the area, which is
    // small enough that scaling it visibly enlarges it without hitting the edges.
    const boxW = Math.round(width / 6);
    const boxH = Math.round(height / 6);
    const x0 = Math.round((width - boxW) / 2);
    const y0 = Math.round((height - boxH) / 2);
    for (let y = y0; y < y0 + boxH; y += 1) {
      for (let x = x0; x < x0 + boxW; x += 1) {
        const index = (y * width + x) * 3;
        frame[index] = 250;
        frame[index + 1] = 250;
        frame[index + 2] = 250;
      }
    }
    writeFileSync(rawPath, Buffer.concat(Array.from({ length: 30 }, () => frame)));
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', `${width}x${height}`, '-framerate', '30', '-i', rawPath,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast',
        '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709', '-color_range', 'tv', '-y', path],
      { stdio: 'ignore' },
    );
    rmSync(rawPath, { force: true });
    return path;
  }

  /**
   * A field of a base colour with one bright block near its left edge.
   *
   * A flat colour cannot show whether a clip moved: every pixel it covers is the
   * same pixel, so sliding it changes nothing measurable. A *periodic* pattern does
   * not help either — a shift of a whole number of periods is invisible to any
   * phase measurement, and a half-frame slide is many periods — so the mark has to
   * be unique. One block gives an unambiguous centroid under any shift.
   *
   * The block's placement is a parameter because where it can be seen depends on
   * the slide's mode. A `cover` leaves the outgoing clip exactly where it started
   * and slides the incoming one over it, so only the left end of the outgoing clip
   * is reliably on screen throughout; a `reveal` uncovers the incoming clip from
   * the right, so only its right end is. Putting the mark in the wrong half makes
   * the test fail for a reason that has nothing to do with motion.
   */
  function makeMarkedSource(
    name: string,
    base: [number, number, number],
    mark: [number, number, number],
    where: 'left' | 'right' = 'left',
    width = 1280,
    height = 720,
  ): string {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, name);
    const rawPath = join(TMP, `${name}.rgb`);
    const frame = Buffer.alloc(width * height * 3);
    const markFrom = Math.round(width * (where === 'left' ? 0.04 : 0.85));
    const markTo = Math.round(width * (where === 'left' ? 0.12 : 0.93));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inMark = x >= markFrom && x < markTo;
        const index = (y * width + x) * 3;
        frame[index] = inMark ? mark[0] : base[0];
        frame[index + 1] = inMark ? mark[1] : base[1];
        frame[index + 2] = inMark ? mark[2] : base[2];
      }
    }
    writeFileSync(rawPath, Buffer.concat(Array.from({ length: 30 }, () => frame)));
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', `${width}x${height}`, '-framerate', '30', '-i', rawPath,
        '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
        '-c:v', 'libx264', '-crf', '4', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709', '-color_range', 'tv', '-y', path],
      { stdio: 'ignore' },
    );
    rmSync(rawPath, { force: true });
    return path;
  }

  /**
   * Horizontal centroid of a marked block along one scanline, as a fraction of the
   * frame width, or `null` when that colour is not on screen.
   *
   * A centroid is unambiguous: unlike a periodic pattern's phase, it cannot alias
   * when the picture shifts by many periods, which is exactly what a slide does.
   * Measuring a single scanline rather than the whole frame keeps 4:2:0 chroma
   * bleed from dragging the answer around.
   */
  function markCentroid(
    raw: Buffer,
    width: number,
    height: number,
    matches: (r: number, g: number, b: number) => boolean,
  ): number | null {
    const row = Math.floor(height / 2);
    let sum = 0;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const index = (row * width + x) * 3;
      const r = raw[index]!;
      const g = raw[index + 1]!;
      const b = raw[index + 2]!;
      if (!matches(r, g, b)) continue;
      sum += x;
      count += 1;
    }
    // A block narrower than this is a compression artefact rather than the mark.
    if (count < width * 0.01) return null;
    return sum / count / width;
  }

  /** One RGB frame from `outputPath` at `seconds`, as raw bytes. */
  function readFrameAt(
    outputPath: string,
    plan: { width: number; height: number },
    seconds: number,
  ): Buffer {
    const rgbPath = join(TMP, 'mode-probe.rgb');
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', String(seconds), '-i', outputPath, '-frames:v', '1',
        // Force the matrix the compositor used, or the probe measures a different
        // colour space from the one the clips were written in.
        '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
      { stdio: 'ignore' },
    );
    const raw = readFileSync(rgbPath);
    rmSync(rgbPath, { force: true });
    expect(raw.length, 'the probe frame has the planned size').toBe(plan.width * plan.height * 3);
    return raw;
  }

  /**
   * Fractions of a frame that are red, blue, or neither.
   *
   * The two sources are (220, 30, 30) and (30, 30, 220). Four rounds of 4:2:0
   * subsampling pull them a little toward each other without ever crossing the
   * middle, so a generous hue test separates them while the canvas background —
   * whichever colour it is — lands in `dark`. That is the point: this measures
   * *which clip is where*, and treats everything else as not-a-clip.
   */
  function classify(raw: Buffer): { red: number; blue: number; mixed: number } {
    let red = 0;
    let blue = 0;
    let mixed = 0;
    const total = raw.length / 3;
    for (let index = 0; index < raw.length; index += 3) {
      const r = raw[index]!;
      const b = raw[index + 2]!;
      if (r > 110 && b < 100) red += 1;
      else if (b > 110 && r < 100) blue += 1;
      else mixed += 1;
    }
    return { red: red / total, blue: blue / total, mixed: mixed / total };
  }

  /** Decode the last frame of a file straight to RGB and average each channel. */
  function decodedChannelMeans(path: string): [number, number, number] {
    const rgbPath = join(TMP, 'probe.rgb');
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-sseof', '-0.1', '-i', path,
        '-frames:v', '1',
        '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
      { stdio: 'ignore' },
    );
    const raw = readFileSync(rgbPath);
    rmSync(rgbPath, { force: true });
    const sums = [0, 0, 0];
    for (let index = 0; index < raw.length; index += 3) {
      sums[0] += raw[index]!;
      sums[1] += raw[index + 1]!;
      sums[2] += raw[index + 2]!;
    }
    const pixels = raw.length / 3;
    return [sums[0]! / pixels, sums[1]! / pixels, sums[2]! / pixels];
  }

  /** Plan + settings for a base clip plus one overlay on a higher track. */
  function twoLayerJob(options: {
    base: string;
    overlay: string;
    opacity?: number;
    blendMode?: string;
    overlayOrder?: number;
  }) {
    const resolvePath = (mediaId: string) =>
      mediaId === 'media-base' ? options.base : options.overlay;
    const items = [
      {
        id: 'item-base',
        trackId: 'track-main',
        type: 'video',
        mediaId: 'media-base',
        startUs: 0,
        durationUs: 1_000_000,
        sourceInUs: 0,
        sourceDurationUs: 1_000_000,
        disabled: false,
        muted: false,
        hasAudio: false,
        trackOrder: 0,
      },
      {
        id: 'item-overlay',
        trackId: 'track-overlay',
        type: 'video',
        mediaId: 'media-overlay',
        startUs: 0,
        durationUs: 1_000_000,
        sourceInUs: 0,
        sourceDurationUs: 1_000_000,
        disabled: false,
        muted: false,
        hasAudio: false,
        opacity: options.opacity,
        blendMode: options.blendMode,
        trackOrder: options.overlayOrder ?? 10,
      },
    ];
    const settings = makeSettings({ items: items as never, rangeUs: [0, 500_000] });
    const plan = buildExportPlan(settings);
    return { plan, settings, resolveMediaPath: resolvePath };
  }

  it('blends an overlay onto the video underneath instead of replacing it', async () => {
    // Base light grey, overlay mid grey at 50 %: the result must be between them.
    // "Topmost wins" would give exactly the overlay's own colour.
    const base = makeSolidSource('layer-base.mp4', [200, 200, 200]);
    const overlay = makeSolidSource('layer-overlay.mp4', [100, 100, 100]);
    const job = twoLayerJob({ base, overlay, opacity: 0.5 });
    const outputPath = join(TMP, 'layer-blend.mp4');

    const result = await runExportJob({
      jobId: 'job-layer-blend',
      settings: job.settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan: job.plan, resolveMediaPath: job.resolveMediaPath }),
      fullDecode: true,
    });
    expect(result.status, JSON.stringify(result.validation?.checks, null, 2)).toBe('verified');

    const [red, green, blue] = decodedChannelMeans(outputPath);
    // 0.5·100 + 0.5·200 = 150. Allow a wide-ish window for two rounds of 4:2:0
    // chroma subsampling and x264, but nothing near the 100 or 200 endpoints —
    // either of those means the layer was not composited at all.
    for (const channel of [red, green, blue]) {
      expect(channel).toBeGreaterThan(135);
      expect(channel).toBeLessThan(165);
    }
  }, 120_000);

  it('multiplies rather than covering when the layer asks for it', async () => {
    // 200 × 0.5 ≈ 100 for the grey means multiply is a real darkening, not a fade.
    const base = makeSolidSource('mul-base.mp4', [200, 200, 200]);
    const overlay = makeSolidSource('mul-overlay.mp4', [128, 128, 128]);
    const job = twoLayerJob({ base, overlay, opacity: 1, blendMode: 'multiply' });
    const outputPath = join(TMP, 'layer-multiply.mp4');

    const result = await runExportJob({
      jobId: 'job-layer-multiply',
      settings: job.settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan: job.plan, resolveMediaPath: job.resolveMediaPath }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const [red] = decodedChannelMeans(outputPath);
    // 200/255 × 128/255 × 255 ≈ 100. `normal` would leave 128.
    expect(red).toBeGreaterThan(85);
    expect(red).toBeLessThan(115);
  }, 120_000);

  it('honours track order, not plan order, when deciding what is on top', async () => {
    // Two opaque, full-opacity layers: whichever is composited last wins. The plan
    // lists them in id order (`item-base` before `item-overlay`), and the base sits
    // on the lower track — so a compositor that trusted plan order would paint the
    // overlay and then cover it with the base. Swapping the two items' *ids* while
    // keeping their tracks makes the two orderings disagree, which is what makes
    // this test able to fail.
    const base = makeSolidSource('ord-base.mp4', [200, 200, 200]);
    const overlay = makeSolidSource('ord-overlay.mp4', [40, 40, 40]);
    const resolvePath = (mediaId: string) =>
      mediaId === 'media-base' ? base : overlay;
    // `a-item` sorts before `z-item`, but `z-item` is the one on the lower track.
    const settings = makeSettings({
      items: [
        {
          id: 'a-overlay', trackId: 'track-overlay', type: 'video', mediaId: 'media-overlay',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 10,
        },
        {
          id: 'z-base', trackId: 'track-main', type: 'video', mediaId: 'media-base',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
      ] as never,
      rangeUs: [0, 500_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'layer-order.mp4');

    const result = await runExportJob({
      jobId: 'job-layer-order',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan, resolveMediaPath: resolvePath }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const [red] = decodedChannelMeans(outputPath);
    // Overlay (40) is on top of base (200), so the frame must be dark.
    expect(red).toBeLessThan(70);
  }, 120_000);
  it('fades a lone layer toward the canvas colour, not toward black', async () => {
    // The bug this pins: compositing a 50 % bottom layer "over black" happens to be
    // right for the default black canvas, so the mistake hides until someone sets a
    // white one — and then every export is too dark by half.
    const base = makeSolidSource('canvas-base.mp4', [200, 200, 200]);
    const settings = makeSettings({
      items: [
        {
          id: 'only', trackId: 'track-main', type: 'video', mediaId: 'media-base',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, opacity: 0.5, trackOrder: 0,
        },
      ] as never,
      backgroundColor: '#ffffff',
      rangeUs: [0, 500_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'layer-canvas.mp4');

    const result = await runExportJob({
      jobId: 'job-layer-canvas',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => base }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const [red] = decodedChannelMeans(outputPath);
    // 0.5·200 + 0.5·255 ≈ 228 over white; over black it would be 100.
    expect(red).toBeGreaterThan(200);
    expect(red).toBeLessThan(250);
  }, 120_000);
  it('crossfades two clips in the exported file', async () => {
    // The test that matters for transitions: sample the produced file at three
    // instants and check the picture moves from one clip to the other through an
    // intermediate value. A hard cut gives the two endpoints and nothing between.
    const first = makeSolidSource('xf-first.mp4', [220, 30, 30]); // red
    const second = makeSolidSource('xf-second.mp4', [30, 30, 220]); // blue
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'media-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'media-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'crossfade', durationUs: 400_000, alignment: 'center',
            params: {}, easing: 'linear', crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-crossfade.mp4');

    const result = await runExportJob({
      jobId: 'job-transition',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'media-a' ? first : second),
      }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    // Mean red/blue at a given time in the output.
    const sample = (seconds: number): [number, number] => {
      const rgbPath = join(TMP, 'xf-probe.rgb');
      execFileSync(
        ffmpegPath(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', String(seconds), '-i', outputPath, '-frames:v', '1',
          '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
          '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
        { stdio: 'ignore' },
      );
      const raw = readFileSync(rgbPath);
      rmSync(rgbPath, { force: true });
      let red = 0;
      let blue = 0;
      for (let index = 0; index < raw.length; index += 3) {
        red += raw[index]!;
        blue += raw[index + 2]!;
      }
      const pixels = raw.length / 3;
      return [red / pixels, blue / pixels];
    };

    const [startRed, startBlue] = sample(0.2);
    const [endRed, endBlue] = sample(1.5);

    // Before the cut the frame is the first clip; after it, the second.
    expect(startRed).toBeGreaterThan(150);
    expect(startBlue).toBeLessThan(90);
    expect(endBlue).toBeGreaterThan(150);
    expect(endRed).toBeLessThan(90);

    /*
      The decisive measurement: the *proportion* of the two clips at the cut.

      Sampling mid-transition and asking "is it somewhere in between" is not enough
      — an un-faded stack of the two clips also lands in between, just with the
      wrong ratio (the top clip wins wherever it is opaque). So the transition's
      opacity is measured directly by taking the ratio of the two colour channels
      and comparing it with the progress the transition should have.

      At 1.0 s the centred window [0.8 s, 1.2 s) is exactly half done, so the two
      clips contribute equally and the blue:red ratio must be ≈ 1.
    */
    const ratioAtCut = (() => {
      const rgbPath = join(TMP, 'xf-cut.rgb');
      execFileSync(
        ffmpegPath(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin',
          // `-ss` *after* `-i` seeks by decoding, so the frame is the one at 1.0 s
          // rather than the nearest keyframe before it. Before `-i` ffmpeg jumps to
          // a keyframe and then discards nothing, which landed 200 ms late here.
          '-i', outputPath, '-ss', '1.0', '-frames:v', '1',
          '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
          '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
        { stdio: 'ignore' },
      );
      const raw = readFileSync(rgbPath);
      rmSync(rgbPath, { force: true });
      let red = 0;
      let blue = 0;
      for (let index = 0; index < raw.length; index += 3) {
        red += raw[index]!;
        blue += raw[index + 2]!;
      }
      return blue / Math.max(1, red);
    })();
    // Even mix: blue ≈ red, so the ratio sits near 1. The window is deliberately
    // asymmetric — red is the clip being *covered*, and 4:2:0 chroma rounding
    // favours the top layer slightly — but it excludes the 4:1 and 8:1 ratios an
    // un-faded stack produced, which is the failure this guards.
    expect(ratioAtCut).toBeGreaterThan(0.6);
    expect(ratioAtCut).toBeLessThan(2.5);
  }, 180_000);
  it('applies an effect chain to the exported pixels', async () => {
    // Effects could be added, listed, toggled and removed and were applied by
    // nothing. A grey source through a saturation-0 chain must come out grey — and
    // it already is grey — so the discriminating case is a *coloured* source whose
    // channels must converge.
    const source = makeSolidSource('fx-grey.mp4', [200, 60, 40]);
    const settings = makeSettings({
      items: [
        {
          id: 'graded', trackId: 'track-main', type: 'video', mediaId: 'media-graded',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          effects: [{ id: 'fx1', effectId: 'saturation', enabled: true, params: { amount: 0 } }],
        },
      ] as never,
      rangeUs: [0, 500_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'effect-saturation.mp4');

    const result = await runExportJob({
      jobId: 'job-effect',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => source }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const [red, green, blue] = decodedChannelMeans(outputPath);
    // Saturation 0 is Rec.709 luma of (200,60,40) ≈ 88 in sRGB terms; whatever the
    // exact level, the three channels must be equal within rounding, which they are
    // not in the source (200/60/40).
    expect(Math.abs(red - green)).toBeLessThan(6);
    expect(Math.abs(green - blue)).toBeLessThan(6);
  }, 120_000);

  it('applies an effect even when the clip is the only layer', async () => {
    // The fast path for a single opaque layer returns the decoded bytes untouched.
    // Effects have to disable that path, or a graded clip exports ungraded whenever
    // it happens to be alone on its track — which is most of the time.
    const source = makeSolidSource('fx-only.mp4', [128, 128, 128]);
    const settings = makeSettings({
      items: [
        {
          id: 'only', trackId: 'track-main', type: 'video', mediaId: 'media-only',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          effects: [{ id: 'fx1', effectId: 'exposure', enabled: true, params: { stops: 1 } }],
        },
      ] as never,
      rangeUs: [0, 500_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'effect-single-layer.mp4');

    const result = await runExportJob({
      jobId: 'job-effect-single',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => source }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const [red] = decodedChannelMeans(outputPath);
    // +1 stop on 128 sRGB: 0.216 linear doubled is 0.432, which re-encodes to ~173.
    expect(red).toBeGreaterThan(160);
    expect(red).toBeLessThan(190);
  }, 120_000);

  it('leaves the picture alone when the effect is disabled', async () => {
    const source = makeSolidSource('fx-off.mp4', [128, 128, 128]);
    const settings = makeSettings({
      items: [
        {
          id: 'off', trackId: 'track-main', type: 'video', mediaId: 'media-off',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          effects: [{ id: 'fx1', effectId: 'exposure', enabled: false, params: { stops: 1 } }],
        },
      ] as never,
      rangeUs: [0, 500_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'effect-disabled.mp4');

    const result = await runExportJob({
      jobId: 'job-effect-off',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => source }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const [red] = decodedChannelMeans(outputPath);
    expect(red).toBeGreaterThan(118);
    expect(red).toBeLessThan(138);
  }, 120_000);
  /**
   * SPEC 12 §3.1 — an adjustment layer grades the tracks below it.
   *
   * The module's unit tests prove the *resolution* rules; these prove the pixels,
   * because a chain that resolves correctly and is then applied to nothing looks
   * exactly like a feature that works.
   */
  describe('adjustment layers during export', () => {
    /**
     * A clip on the main track with an adjustment layer above it must come out
     * graded. Saturation 0 is the discriminating case: the source is strongly
     * coloured and the output's channels must converge.
     */
    it('grades a clip below it', async () => {
      const source = makeSolidSource('adj-source.mp4', [200, 60, 40]);
      const settings = makeSettings({
        items: [
          {
            id: 'graded', trackId: 'track-main', type: 'video', mediaId: 'media-adj',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
            disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          },
          {
            id: 'adj', trackId: 'track-adjustment', type: 'adjustment',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
            disabled: false, muted: false, hasAudio: false, trackOrder: 10,
            effects: [{ id: 'fx1', effectId: 'saturation', enabled: true, params: { amount: 0 } }],
          },
        ] as never,
        rangeUs: [0, 500_000],
      });
      const plan = buildExportPlan(settings);
      const outputPath = join(TMP, 'adj-graded.mp4');

      const result = await runExportJob({
        jobId: 'job-adj',
        settings,
        outputPath,
        frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => source }),
        fullDecode: true,
      });
      expect(result.status).toBe('verified');

      const [red, green, blue] = decodedChannelMeans(outputPath);
      // Ungraded this source is (200, 60, 40) — a spread of 160.
      expect(Math.abs(red - green)).toBeLessThan(8);
      expect(Math.abs(green - blue)).toBeLessThan(8);
    }, 120_000);

    /**
     * The other half of "only the tracks below": an adjustment layer under the clip
     * must leave it alone. Getting this wrong grades everything unconditionally,
     * which is a global filter wearing an adjustment layer's name.
     */
    it('leaves a clip above it ungraded', async () => {
      const source = makeSolidSource('adj-above.mp4', [200, 60, 40]);
      const settings = makeSettings({
        items: [
          {
            id: 'adj', trackId: 'track-adjustment', type: 'adjustment',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
            disabled: false, muted: false, hasAudio: false, trackOrder: 0,
            effects: [{ id: 'fx1', effectId: 'saturation', enabled: true, params: { amount: 0 } }],
          },
          {
            id: 'above', trackId: 'track-main', type: 'video', mediaId: 'media-above',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
            disabled: false, muted: false, hasAudio: false, trackOrder: 10,
          },
        ] as never,
        rangeUs: [0, 500_000],
      });
      const plan = buildExportPlan(settings);
      const outputPath = join(TMP, 'adj-ungraded.mp4');

      await runExportJob({
        jobId: 'job-adj-above',
        settings,
        outputPath,
        frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => source }),
        fullDecode: true,
      });

      const [red, green] = decodedChannelMeans(outputPath);
      expect(red - green).toBeGreaterThan(100);
    }, 120_000);

    /**
     * An adjustment layer grades the *composite*, not each layer separately.
     *
     * This uses exposure rather than saturation deliberately: desaturating an
     * already-desaturated picture changes nothing, so a double-grade is invisible
     * and the test would pass against a broken implementation. Exposure doubles
     * linear values, so grading twice squares the gain and the two answers separate.
     *
     * A red (220,40,40) clip at 50 % over a blue canvas composites to (110,20,147).
     * One +1 stop gives (152,31,201); grading each layer and then the frame again
     * gives (176,43,213). Grading the composite also has to leave the blue canvas
     * *raised*, which per-layer grading leaves untouched.
     */
    it('grades the composite rather than each layer', async () => {
      const source = makeSolidSource('adj-composite.mp4', [220, 40, 40]);
      const settings = makeSettings({
        backgroundColor: '#0000FF',
        items: [
          {
            id: 'red', trackId: 'track-main', type: 'video', mediaId: 'media-composite',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
            disabled: false, muted: false, hasAudio: false, trackOrder: 0,
            opacity: 0.5,
          },
          {
            id: 'adj', trackId: 'track-adjustment', type: 'adjustment',
            startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
            disabled: false, muted: false, hasAudio: false, trackOrder: 10,
            effects: [{ id: 'fx1', effectId: 'exposure', enabled: true, params: { stops: 1 } }],
          },
        ] as never,
        rangeUs: [0, 500_000],
      });
      const plan = buildExportPlan(settings);
      const outputPath = join(TMP, 'adj-composite.mp4');

      await runExportJob({
        jobId: 'job-adj-composite',
        settings,
        outputPath,
        frameSource: createDecodeFrameSource({ plan, resolveMediaPath: () => source }),
        fullDecode: true,
      });

      const [red, green, blue] = decodedChannelMeans(outputPath);
      // Blue was 255 in the canvas and is clipped at 255 either way, so the
      // discriminator is red: 152 when the composite is graded once, 176 when the
      // layer is graded and the result graded again.
      expect(red).toBeGreaterThan(140);
      expect(red).toBeLessThan(165);
      expect(green).toBeLessThan(40);
    }, 120_000);
  });
  /**
   * SPEC 12 §4.2 — `wipe`: "linear reveal along a direction with soft edge".
   *
   * The discriminating measurement is *spatial*. A mean would not do: an
   * un-clipped stack and a correct wipe both average to a mix of the two clips at
   * mid-transition, so a mean test passes against the broken renderer, which drew
   * the incoming clip over the outgoing one. Instead the frame is split into its
   * left and right halves and each half is checked on its own: at half progress the
   * left must be the incoming clip and the right the outgoing one.
   */
  it('wipes between two clips left to right in the exported file', async () => {
    const first = makeSolidSource('wipe-first.mp4', [220, 30, 30]); // red, outgoing
    const second = makeSolidSource('wipe-second.mp4', [30, 30, 220]); // blue, incoming
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'wipe-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'wipe-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'wipe', durationUs: 400_000, alignment: 'center',
            params: { direction: 'left', softness: 0 }, easing: 'linear',
            crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-wipe.mp4');

    const result = await runExportJob({
      jobId: 'job-wipe',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'wipe-a' ? first : second),
      }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    /**
     * Mean red/blue in the left or right quarter of the frame at a given time.
     *
     * The quarters, not halves: the edge sits at the midpoint at half progress, so
     * sampling right up to it mixes the two clips in a fairly wide band; a quarter
     * in is unambiguously on one side.
     */
    const quarter = (seconds: number, side: 'left' | 'right'): [number, number] => {
      const rgbPath = join(TMP, 'wipe-probe.rgb');
      // Crop to the quarter *before* decoding to RGB so the 4:2:0 chroma is
      // resampled within the region rather than across the wipe's edge.
      const crop = side === 'left' ? 'crop=iw/4:ih:0:0' : 'crop=iw/4:ih:iw*3/4:0';
      execFileSync(
        ffmpegPath(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', String(seconds), '-i', outputPath, '-frames:v', '1',
          '-vf', `${crop},scale=in_color_matrix=bt709:out_color_matrix=bt709`,
          '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
        { stdio: 'ignore' },
      );
      const raw = readFileSync(rgbPath);
      rmSync(rgbPath, { force: true });
      let red = 0;
      let blue = 0;
      for (let index = 0; index < raw.length; index += 3) {
        red += raw[index]!;
        blue += raw[index + 2]!;
      }
      const pixels = Math.max(1, raw.length / 3);
      return [red / pixels, blue / pixels];
    };

    // Half way through the centred window [0.8 s, 1.2 s), which is 1.0 s.
    const [leftRed, leftBlue] = quarter(1.0, 'left');
    const [rightRed, rightBlue] = quarter(1.0, 'right');

    // The revealed side is the incoming blue clip...
    expect(leftBlue, 'left quarter should be the incoming clip').toBeGreaterThan(150);
    expect(leftRed, 'left quarter should not still be the outgoing clip').toBeLessThan(90);
    // ...and the side the edge has not reached is still the outgoing red clip.
    expect(rightRed, 'right quarter should still be the outgoing clip').toBeGreaterThan(150);
    expect(rightBlue, 'right quarter should not yet be the incoming clip').toBeLessThan(90);
  }, 180_000);
  /**
   * SPEC 12 §4.2 — `dissolve`: a noise-thresholded mix, not a fade.
   *
   * The measurement is per-pixel *bimodality*: at mid-transition a dissolve shows
   * most pixels as pure outgoing or pure incoming with almost none blended, whereas
   * the fade it used to be shows almost every pixel blended. A mean cannot tell
   * them apart — both average to the same mix — which is why this counts pixels
   * rather than averaging.
   */
  it('dissolves between two clips through a noise field in the exported file', async () => {
    const first = makeSolidSource('dis-first.mp4', [220, 30, 30]); // red, outgoing
    const second = makeSolidSource('dis-second.mp4', [30, 30, 220]); // blue, incoming
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'dis-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'dis-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'dissolve', durationUs: 400_000, alignment: 'center',
            params: { grain: 0.05 }, easing: 'linear', crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-dissolve.mp4');

    const result = await runExportJob({
      jobId: 'job-dissolve',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'dis-a' ? first : second),
      }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');

    const rgbPath = join(TMP, 'dis-probe.rgb');
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', '1.0', '-i', outputPath, '-frames:v', '1',
        '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
      { stdio: 'ignore' },
    );
    const raw = readFileSync(rgbPath);
    rmSync(rgbPath, { force: true });

    /*
      Classify each pixel by hue. The pure clips are (220,30,30) and (30,30,220);
      4:2:0 chroma subsampling pulls them toward each other a little, so "pure"
      is generous — but the blended middle is a wide band, and a fade at 50 % puts
      *every* pixel near (125,30,125), which no generous threshold can call pure.
    */
    let red = 0;
    let blue = 0;
    let mixed = 0;
    let total = 0;
    for (let index = 0; index < raw.length; index += 3) {
      const r = raw[index]!;
      const b = raw[index + 2]!;
      total += 1;
      if (r > 120 && b < 110) red += 1;
      else if (b > 120 && r < 110) blue += 1;
      else mixed += 1;
    }

    // Both clips must be present — a hard cut would show only one.
    expect(red / total, 'outgoing clip visible').toBeGreaterThan(0.15);
    expect(blue / total, 'incoming clip visible').toBeGreaterThan(0.15);
    // ...and most pixels must belong cleanly to one side. A fade at this point
    // would put nearly every pixel in `mixed`.
    expect(mixed / total, 'pixels blended between the clips').toBeLessThan(0.25);
  }, 180_000);
  /**
   * SPEC 12 §4.2 — `slide`: "B pushes A". Both pictures travel together across the
   * frame, so mid-transition the file must show *both* clips side by side.
   *
   * The export composites each layer whole: the item's geometry moves a layer, but a
   * transition's offset has nowhere to go, so a slide arrived in the file as the
   * incoming clip painted over the outgoing one — a cut with extra steps.
   */
  it('slides two clips across the frame in the exported file', async () => {
    const first = makeSolidSource('slide-first.mp4', [220, 30, 30]); // red, outgoing
    const second = makeSolidSource('slide-second.mp4', [30, 30, 220]); // blue, incoming
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'slide-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'slide-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'slide', durationUs: 400_000, alignment: 'center',
            params: { direction: 'left' }, easing: 'linear', crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-slide.mp4');

    await runExportJob({
      jobId: 'job-slide',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'slide-a' ? first : second),
      }),
      fullDecode: true,
    });

    const rgbPath = join(TMP, 'slide-probe.rgb');
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', '1.0', '-i', outputPath, '-frames:v', '1',
        '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
      { stdio: 'ignore' },
    );
    const raw = readFileSync(rgbPath);
    rmSync(rgbPath, { force: true });

    // At half progress each clip covers half the width: the leading band is the
    // outgoing clip, the trailing band the incoming one. A cut shows one colour.
    const bandMeans = (fromFraction: number, toFraction: number) => {
      const width = plan.width;
      const x0 = Math.floor(width * fromFraction);
      const x1 = Math.floor(width * toFraction);
      let red = 0;
      let blue = 0;
      let count = 0;
      for (let y = 0; y < plan.height; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const index = (y * width + x) * 3;
          red += raw[index]!;
          blue += raw[index + 2]!;
          count += 1;
        }
      }
      return [red / count, blue / count];
    };

    const [leftRed, leftBlue] = bandMeans(0.05, 0.2);
    const [rightRed, rightBlue] = bandMeans(0.8, 0.95);
    // The incoming clip slides in from the right, so the right band is blue and
    // the left band is still red.
    expect(leftRed, 'left band is the outgoing clip').toBeGreaterThan(120);
    expect(leftBlue, 'left band is not yet the incoming clip').toBeLessThan(110);
    expect(rightBlue, 'right band is the incoming clip').toBeGreaterThan(120);
    expect(rightRed, 'right band is not still the outgoing clip').toBeLessThan(110);
  }, 180_000);
  /**
   * SPEC 12 §4.2 — a slide's `mode`, measured in the produced file.
   *
   * The three modes are `push` (both pictures move), `cover` (the incoming one
   * slides over a still outgoing one) and `reveal` (the outgoing one slides away
   * from a still incoming one). Their reported *state* differs only in which side
   * carries a zero offset, which the compositor's own tests pin.
   *
   * Proving the difference reaches the file needs a measurement that a single
   * frame cannot make. At any one progress the three produce the same picture:
   * the area the outgoing clip vacates is exactly the area the incoming one
   * enters, and the incoming clip is painted on top, so with opaque clips the
   * frame is identical — verified by forcing the mode to `push` and watching this
   * file's early version still pass.
   *
   * What actually differs is *what stays still*, so these tests measure motion
   * rather than a still: each clip carries a bar pattern, and the pattern's phase
   * along one scanline says whether that clip is travelling. A flat colour could
   * not show this at all — sliding a uniform field changes no pixel.
   */
  it('leaves the outgoing clip stationary in cover mode', async () => {
    // Each clip's mark is a colour neither field has, so the centroid of a mark
    // cannot be confused with the *area* the clip covers — which moves as the seam
    // does — nor with the other clip's mark.
    const first = makeMarkedSource('cover-first.mp4', [200, 40, 40], [40, 220, 40]);
    const second = makeMarkedSource('cover-second.mp4', [40, 40, 200], [230, 220, 40]);
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'cover-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'cover-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'slide', durationUs: 400_000, alignment: 'center',
            params: { direction: 'left', mode: 'cover' }, easing: 'linear', crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-cover.mp4');

    await runExportJob({
      jobId: 'job-cover',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'cover-a' ? first : second),
      }),
      fullDecode: true,
    });

    /** Where the outgoing clip's mark sits, as a fraction of the frame width. */
    const outgoingMark = (seconds: number): number | null => {
      const raw = readFrameAt(outputPath, plan, seconds);
      // The outgoing clip's mark is green; its field is red and the incoming clip's
      // mark is yellow, so green appears nowhere else in the frame.
      return markCentroid(raw, plan.width, plan.height, (r, g, b) => g - r > 60 && g - b > 60);
    };

    /*
      In `cover` the outgoing clip never moves, so its mark must hold exactly the
      same position across the window. Under `push` the same clip travels a frame
      width a second, and its mark — which starts in the first eighth of the frame —
      has left the picture entirely by a quarter of the way through. Either way the
      measurement separates the modes, and it cannot alias: a centroid has no period.
    */
    const early = outgoingMark(0.9);
    const late = outgoingMark(1.1);
    expect(early, 'the outgoing clip is still on screen early in the window').not.toBeNull();
    expect(late, 'the outgoing clip is still on screen late in the window').not.toBeNull();
    const drift = Math.abs(late! - early!);
    expect(drift, `the outgoing clip's mark moved ${(drift * 100).toFixed(1)}% of the frame`)
      .toBeLessThan(0.01);
  }, 180_000);

  it('leaves the incoming clip stationary in reveal mode', async () => {
    const first = makeMarkedSource('reveal-first.mp4', [200, 40, 40], [40, 220, 40], 'left');
    // The incoming clip is uncovered from the right, so its mark lives there.
    const second = makeMarkedSource('reveal-second.mp4', [40, 40, 200], [230, 220, 40], 'right');
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'reveal-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'reveal-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'slide', durationUs: 400_000, alignment: 'center',
            params: { direction: 'left', mode: 'reveal' }, easing: 'linear', crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-reveal.mp4');

    await runExportJob({
      jobId: 'job-reveal',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'reveal-a' ? first : second),
      }),
      fullDecode: true,
    });

    /** Where the incoming clip's mark sits, as a fraction of the frame width. */
    const incomingMark = (seconds: number): number | null => {
      const raw = readFrameAt(outputPath, plan, seconds);
      // The incoming clip's mark is yellow, which neither field nor the outgoing
      // clip's green mark can be mistaken for.
      return markCentroid(raw, plan.width, plan.height, (r, g, b) => r > 140 && g > 140 && b < 110);
    };

    /*
      A `reveal` leaves the incoming clip where it started and slides the outgoing
      one off it, so the incoming clip's mark must hold its position across the
      window. Under `push` both pictures travel, and the incoming clip's mark — which
      enters from off-frame — is somewhere else entirely at each instant.

      Sampling two times rather than asserting on one frame is what makes this able
      to fail: at any single progress a renderer that ignored `mode` draws the same
      picture, and only the motion tells them apart.
    */
    const early = incomingMark(0.9);
    const late = incomingMark(1.1);
    expect(early, 'the incoming clip is already partly uncovered early in the window').not.toBeNull();
    expect(late, 'the incoming clip is on screen late in the window').not.toBeNull();
    const drift = Math.abs(late! - early!);
    expect(drift, `the incoming clip's mark moved ${(drift * 100).toFixed(1)}% of the frame`)
      .toBeLessThan(0.01);
  }, 180_000);

  /**
   * SPEC 12 §4.2 — `zoom`: "A zooms in/out while crossfading into B".
   *
   * The transition produced from/to scales and nothing read them, so a zoom reached
   * the file as a plain crossfade at constant size. The measurement is spatial: a
   * clip scaled up past the frame covers *more* of it, so a test pattern with
   * distinct edges tells a zoom from a crossfade where both pictures happen to be
   * present. Here the outgoing clip is a red field with a bright white box in the
   * middle and the incoming clip is flat blue: as the red clip scales up, the white
   * box grows, so the count of white-ish pixels rises even as the clip fades.
   */
  it('zooms the outgoing clip while crossfading in the exported file', async () => {
    const first = makeBoxedSource('zoom-boxed.mp4');
    const second = makeSolidSource('zoom-flat.mp4', [30, 30, 220]);
    const settings = makeSettings({
      items: [
        {
          id: 'a', trackId: 'track-main', type: 'video', mediaId: 'zoom-a',
          startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
        },
        {
          id: 'b', trackId: 'track-main', type: 'video', mediaId: 'zoom-b',
          startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 1_000_000,
          disabled: false, muted: false, hasAudio: false, trackOrder: 0,
          transitionIn: {
            id: 'tr', type: 'zoom', durationUs: 400_000, alignment: 'center',
            params: { amount: 0.6 }, easing: 'linear', crossfadeAudio: true,
          },
        },
      ] as never,
      rangeUs: [0, 1_600_000],
    });
    const plan = buildExportPlan(settings);
    const outputPath = join(TMP, 'transition-zoom.mp4');

    await runExportJob({
      jobId: 'job-zoom',
      settings,
      outputPath,
      frameSource: createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => (mediaId === 'zoom-a' ? first : second),
      }),
      fullDecode: true,
    });

    /**
     * The box's width in pixels, measured along its centre row.
     *
     * Counting the box's *area* does not work: 4:2:0 chroma is subsampled, so the
     * boundary smears over several pixels and a large faint halo swamps the real
     * change. A single scanline through the middle has the same problem at the two
     * edges only, so it measures the run between them and is insensitive to how
     * wide the smear is.
     */
    const boxWidthAt = (seconds: number): number => {
      const rgbPath = join(TMP, 'zoom-probe.rgb');
      execFileSync(
        ffmpegPath(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', String(seconds), '-i', outputPath, '-frames:v', '1',
          '-vf', 'scale=in_color_matrix=bt709:out_color_matrix=bt709',
          '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rgbPath],
        { stdio: 'ignore' },
      );
      const raw = readFileSync(rgbPath);
      rmSync(rgbPath, { force: true });
      const row = Math.floor(plan.height / 2);
      let first = -1;
      let last = -1;
      for (let x = 0; x < plan.width; x += 1) {
        /*
          The box is detected by its *neutrality*, not by an absolute level. Both
          sources are overlaid by the same incoming clip during the transition, so
          any fixed brightness threshold is only valid at one progress: the box's
          green is 250 before the transition and 76 half way through, while the
          field's is 55 and 28. `green − red` is 0 in the box and −158 in the field
          before the transition, and 2 against −38 half way through — a fade of any
          strength leaves that difference where it was.
        */
        const green = raw[(row * plan.width + x) * 3 + 1]!;
        const red = raw[(row * plan.width + x) * 3]!;
        if (green - red > -10) {
          if (first < 0) first = x;
          last = x;
        }
      }
      return first < 0 ? 0 : last - first + 1;
    };

    // Before the transition the box is at its natural size; at 1.0 s the centred
    // window [0.8 s, 1.2 s) is half done, so the outgoing clip is scaled by
    // 1 + 0.6 × 0.5 = 1.3.
    const natural = boxWidthAt(0.5);
    const zoomed = boxWidthAt(1.0);
    expect(natural, 'the source pattern has a detectable box').toBeGreaterThan(100);
    // A crossfade leaves the box exactly the same width while dimming it; only a
    // scale changes how much of the row it covers.
    expect(zoomed, 'the outgoing clip should be scaled up mid-transition').toBeGreaterThan(
      natural * 1.15,
    );
  }, 180_000);
});
