// @vitest-environment node
/**
 * SPEC 14 §2/§7/§12 — the export job, end to end, against the real encoder.
 *
 * These tests are the acceptance evidence for the render→encode→validate→publish
 * path: every file asserted on here was produced by the bundled ffmpeg and then
 * opened, decoded and measured before the job was allowed to report success.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  expectedFrameBytes,
  runExportJob,
  solidColourFrameSource,
  validateProducedFile,
  writeSubtitleSidecars,
  type FrameSource,
} from '../export/export-runner.js';
import { ffmpegPath, ffprobePath } from '../export/ffmpeg-runner.js';
import { buildExportPlan, type ExportSettings } from '@clipwright/export-core';

const TMP = join(process.cwd(), '.tmp-export-runner');
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-run',
    projectId: 'proj-run',
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

/** A 1-second stereo 48 kHz tone, as the mixer would hand to the encoder. */
function writeToneWav(path: string, seconds = 1): void {
  const sampleRate = 48_000;
  const frames = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(frames * 4);
  for (let index = 0; index < frames; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 9_000);
    data.writeInt16LE(value, index * 4);
    data.writeInt16LE(value, index * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Frames with a moving bar, so encoder and detectors see real motion. */
function movingBarSource(width: number, height: number): FrameSource {
  const ySize = width * height;
  return {
    label: 'synthetic moving bar',
    async next(index: number) {
      const frame = Buffer.alloc(expectedFrameBytes(width, height), 128);
      const barX = (index * 8) % width;
      for (let y = 0; y < height; y += 1) {
        for (let x = barX; x < Math.min(width, barX + 64); x += 1) {
          frame[y * width + x] = 200;
        }
      }
      frame.fill(90, ySize);
      return frame;
    },
    async close() {
      // Nothing to release.
    },
  };
}

describe.skipIf(!HAS_FFMPEG)('runExportJob', () => {
  it('publishes a verified MP4 and reports the verdict', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'verified.mp4');
    const progress: number[] = [];
    const result = await runExportJob(
      {
        jobId: 'job-1',
        settings: makeSettings(),
        outputPath,
        frameSource: movingBarSource(1280, 720),
        fullDecode: true,
      },
      { onProgress: (p) => progress.push(p.percent) },
    );

    expect(result.status, JSON.stringify(result.validation?.checks, null, 2)).toBe('verified');
    expect(result.verdict).toBe('Done ✓ Verified');
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(result.partialPath)).toBe(false); // renamed away
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.validation?.overallStatus).toBe('verified');

    // The bar is monotonic and ends at 100.
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBeGreaterThanOrEqual(99);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
  }, 120_000);

  it('muxes an audio mix into the file when one is supplied', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'with-audio.mp4');
    const audioPath = join(TMP, 'mix.wav');
    writeToneWav(audioPath, 1);

    const result = await runExportJob({
      jobId: 'job-audio',
      settings: makeSettings({ includeAudio: true }),
      outputPath,
      audioPath,
      frameSource: solidColourFrameSource({ width: 1280, height: 720, luma: 100 }),
      fullDecode: true,
    });

    expect(result.status, JSON.stringify(result.validation?.checks, null, 2)).toBe('verified');
    const checks = result.validation!.checks;
    // Check 2 saw an audio stream, check 13 measured it.
    expect(checks.find((c) => c.id === 2)!.measured).toContain('audio: true');
    expect(checks.find((c) => c.id === 13)!.measured).toContain('48000 Hz, 2 ch');
  }, 120_000);

  it('produces a portrait file for a 9:16 composition', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'portrait.mp4');
    const plan = buildExportPlan(makeSettings({ aspect: '9:16' }));
    const result = await runExportJob({
      jobId: 'job-portrait',
      settings: makeSettings({ aspect: '9:16' }),
      outputPath,
      frameSource: solidColourFrameSource({ width: plan.width, height: plan.height, luma: 60 }),
      fullDecode: true,
    });
    expect(result.status).toBe('verified');
    expect(result.plan.width).toBe(720);
    expect(result.plan.height).toBe(1280);
  }, 120_000);

  it('produces a WebM with VP9 and Opus', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'clip.webm');
    const audioPath = join(TMP, 'webm-mix.wav');
    writeToneWav(audioPath, 1);
    const result = await runExportJob({
      jobId: 'job-webm',
      settings: makeSettings({ format: 'webm', includeAudio: true, rangeUs: [0, 500_000] }),
      outputPath,
      audioPath,
      frameSource: solidColourFrameSource({ width: 1280, height: 720, luma: 80 }),
      fullDecode: true,
    });
    expect(existsSync(outputPath)).toBe(true);
    expect(result.validation!.checks.find((c) => c.id === 14)!.measured).toContain('vp9');
    expect(result.validation!.checks.find((c) => c.id === 2)!.measured).toContain('audio: true');
  }, 180_000);

  it('cleans up the partial file when cancelled mid-render', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'cancelled.mp4');
    const controller = new AbortController();
    let frames = 0;
    const source: FrameSource = {
      label: 'cancelling source',
      async next(index) {
        frames += 1;
        expect(index).toBeGreaterThanOrEqual(0);
        if (frames === 10) controller.abort();
        return Buffer.alloc(expectedFrameBytes(1280, 720), 128);
      },
      async close() {
        // Nothing to release.
      },
    };
    const result = await runExportJob(
      {
        jobId: 'job-cancel',
        settings: makeSettings({ rangeUs: [0, 10_000_000] }), // long enough to cancel
        outputPath,
        frameSource: source,
        fullDecode: false,
      },
      { signal: controller.signal },
    );
    expect(result.status).toBe('cancelled');
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(result.partialPath)).toBe(false);
    // No half file anywhere under the final name.
    expect(existsSync(`${outputPath}.partial.mp4`)).toBe(false);
  }, 60_000);

  it('fails without publishing when the frame source produces the wrong size', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'badframe.mp4');
    const result = await runExportJob({
      jobId: 'job-badframe',
      settings: makeSettings(),
      outputPath,
      frameSource: {
        label: 'wrong size',
        async next() {
          return Buffer.alloc(1024, 128);
        },
        async close() {
          // Nothing to release.
        },
      },
      fullDecode: false,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('expected');
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it('refuses to export audio when the mix file is missing', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'no-mix.mp4');
    const result = await runExportJob({
      jobId: 'job-nomix',
      settings: makeSettings({ includeAudio: true }),
      outputPath,
      audioPath: join(TMP, 'does-not-exist.wav'),
      frameSource: solidColourFrameSource({ width: 1280, height: 720 }),
      fullDecode: false,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('audio mix');
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it('marks a truncated file as failed validation and keeps it for inspection', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'truncated.mp4');
    // A source that stops early: the encoder writes fewer frames than planned,
    // which check 7 (frame count) must catch.
    const plan = buildExportPlan(makeSettings());
    const shortSource: FrameSource = {
      label: 'short',
      async next(index) {
        if (index >= Math.floor(plan.totalFrames / 2)) {
          throw new Error('decoder exhausted');
        }
        return Buffer.alloc(expectedFrameBytes(1280, 720), 128);
      },
      async close() {
        // Nothing to release.
      },
    };
    const result = await runExportJob({
      jobId: 'job-short',
      settings: makeSettings(),
      outputPath,
      frameSource: shortSource,
      fullDecode: false,
    });
    expect(result.status).toBe('failed');
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);
});

describe.skipIf(!HAS_FFMPEG)('validateProducedFile', () => {
  it('measures a real file rather than trusting the encoder exit code', async () => {
    mkdirSync(TMP, { recursive: true });
    const outputPath = join(TMP, 'measure.mp4');
    const settings = makeSettings();
    const plan = buildExportPlan(settings);
    await runExportJob({
      jobId: 'job-measure',
      settings,
      outputPath,
      frameSource: solidColourFrameSource({ width: plan.width, height: plan.height, luma: 40 }),
      fullDecode: true,
    });

    const report = await validateProducedFile({ plan, partialPath: outputPath, fullDecode: true });
    expect(report.overallStatus).toBe('verified');
    // Every check that ran carries a real measurement.
    for (const check of report.checks) {
      expect(check.measured, `check ${check.id} (${check.name})`).not.toBe('');
      expect(check.measured).not.toBe('not measured');
    }
    expect(report.checks.find((c) => c.id === 7)!.measured).toBe(String(plan.totalFrames));
    expect(report.checks.find((c) => c.id === 3)!.measured).toBe(`${plan.width}×${plan.height}`);
  }, 120_000);
});

describe('writeSubtitleSidecars', () => {
  it('writes SRT and VTT files with the caption cues', async () => {
    mkdirSync(TMP, { recursive: true });
    const settings = makeSettings({
      saveSubtitles: true,
      subtitleFormats: ['srt', 'vtt'],
      items: [
        {
          id: 'cap-1',
          trackId: 'track-captions',
          type: 'caption',
          startUs: 0,
          durationUs: 500_000,
          sourceInUs: 0,
          disabled: false,
          muted: false,
          hasAudio: false,
          captionSegment: { text: 'Hello there' },
        } as never,
      ],
    });
    const plan = buildExportPlan(settings);
    const written = await writeSubtitleSidecars(plan, join(TMP, 'subs.mp4'));
    expect(written).toHaveLength(2);
    const srt = written.find((file) => file.format === 'srt')!;
    const vtt = written.find((file) => file.format === 'vtt')!;
    expect(readFileSync(srt.path, 'utf8')).toContain('Hello there');
    expect(readFileSync(vtt.path, 'utf8')).toContain('WEBVTT');
    expect(srt.cueCount).toBe(vtt.cueCount);
  });
});

describe('expectedFrameBytes', () => {
  it('matches yuv420p 4:2:0 sizing', () => {
    expect(expectedFrameBytes(1920, 1080)).toBe(1920 * 1080 + 2 * 960 * 540);
    expect(expectedFrameBytes(1080, 1920)).toBe(1080 * 1920 + 2 * 540 * 960);
  });

  it('handles odd dimensions the way 4:2:0 chroma rounding does', () => {
    expect(expectedFrameBytes(641, 361)).toBe(641 * 361 + 2 * 321 * 181);
  });
});
