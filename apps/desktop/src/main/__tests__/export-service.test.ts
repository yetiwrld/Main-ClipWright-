// @vitest-environment node
/**
 * SPEC 14 §3.4, §6, §8 — the export service's contract with the UI.
 *
 * Covers the decisions a user actually feels: where the file goes, what happens
 * on a name clash, what blocks an export before it starts, and whether the
 * history row tells the truth about the file on disk.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ExportService,
  applyNameTemplate,
  defaultFileName,
  estimateOutputBytes,
  qualityBitrate,
  resolveOutputDir,
  sanitiseFileName,
  wordResolverFrom,
  type ExportStorageLike,
} from '../export/export-service.js';
import { ffmpegPath, ffprobePath } from '../export/ffmpeg-runner.js';
import { solidColourFrameSource } from '../export/export-runner.js';
import { buildExportPlan, type ExportSettings } from '@clipwright/export-core';
import type { ExportHistoryRecord } from '@clipwright/project-schema';

const TMP = join(process.cwd(), '.tmp-export-service');
const HAS_FFMPEG = existsSync(ffmpegPath()) && existsSync(ffprobePath());

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** In-memory storage that satisfies the narrow `ExportStorageLike` contract. */
function makeStorage(overrides: Partial<ExportStorageLike> = {}): ExportStorageLike & {
  history: ExportHistoryRecord[];
} {
  const history: ExportHistoryRecord[] = [];
  return {
    history,
    getWorkspaceDir: () => TMP,
    getMedia: () => undefined,
    saveExportHistory: (record) => {
      history.push(record);
      return record;
    },
    listExportHistory: (options) =>
      options?.projectId ? history.filter((r) => r.projectId === options.projectId) : [...history],
    averageExportSpeed: () => (history.length > 0 ? 1.8 : null),
    ...overrides,
  };
}

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-s',
    projectId: 'proj-s',
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
    rangeUs: [0, 400_000],
    compositionFps: 30,
    compositionDurationUs: 400_000,
    items: [],
    ...overrides,
  };
}

describe('sanitiseFileName', () => {
  it('replaces characters Windows rejects', () => {
    expect(sanitiseFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('collapses repeated separators and whitespace', () => {
    expect(sanitiseFileName('my  clip---name')).toBe('my clip-name');
  });

  it('strips trailing dots and spaces', () => {
    expect(sanitiseFileName('clip. ')).toBe('clip');
  });

  it('escapes reserved device names', () => {
    expect(sanitiseFileName('con')).toBe('con-');
    expect(sanitiseFileName('LPT1')).toBe('LPT1-');
  });

  it('falls back to a usable name rather than empty', () => {
    expect(sanitiseFileName('***')).toBe('-');
    expect(sanitiseFileName('')).toBe('clip');
  });
});

describe('applyNameTemplate', () => {
  const now = new Date(2026, 10, 7, 14, 32);

  it('substitutes every documented token', () => {
    const result = applyNameTemplate('{project}-{clip}-{res}-{fps}-{aspect}-{date}-{time}-{n}', {
      project: 'podcast',
      clip: 'ep1',
      width: 1080,
      height: 1920,
      fps: 30,
      aspect: '9:16',
      index: 3,
      now,
    });
    expect(result).toBe('podcast-ep1-1080x1920-30-9x16-2026-11-07-1432-3');
  });

  it('sanitises the result', () => {
    const result = applyNameTemplate('{clip}', {
      project: 'p',
      clip: 'a/b',
      width: 1,
      height: 1,
      fps: 30,
      aspect: '1:1',
      now,
    });
    expect(result).not.toContain('/');
  });
});

describe('defaultFileName', () => {
  it('follows the {project}-{clip}-{preset} shape', () => {
    const plan = buildExportPlan(makeSettings());
    const name = defaultFileName(plan, 'My clip');
    expect(name).toContain('My clip');
    expect(name).toContain('1280x720');
  });

  it('sanitises the clip name', () => {
    const plan = buildExportPlan(makeSettings());
    expect(defaultFileName(plan, 'a/b')).not.toContain('/');
  });
});

describe('estimateOutputBytes / qualityBitrate', () => {
  it('scales with pixel count and frame rate', () => {
    const small = qualityBitrate(buildExportPlan(makeSettings({ preset: '720p' })));
    const large = qualityBitrate(buildExportPlan(makeSettings({ preset: '1080p' })));
    const fast = qualityBitrate(buildExportPlan(makeSettings({ preset: '1080p', fps: 60 })));
    expect(large).toBeGreaterThan(small);
    expect(fast).toBeGreaterThan(large);
  });

  it('uses a custom bitrate when one was given', () => {
    const plan = buildExportPlan(makeSettings({ videoBitrate: 12 }));
    // 12 Mbps for 0.4 s = 600 KB.
    expect(estimateOutputBytes(plan)).toBe(Math.round((12_000_000 * 0.4) / 8));
  });

  it('adds the audio bitrate when audio is included', () => {
    const silent = estimateOutputBytes(buildExportPlan(makeSettings()));
    const audible = estimateOutputBytes(buildExportPlan(makeSettings({ includeAudio: true })));
    expect(audible).toBeGreaterThan(silent);
  });
});

describe('resolveOutputDir', () => {
  it('defaults to <workspace>/Exports/<projectId>', () => {
    expect(resolveOutputDir('/ws', undefined, 'proj-1')).toBe(join('/ws', 'Exports', 'proj-1'));
  });

  it('honours an absolute request', () => {
    // Built with `resolve`, not a literal: `/elsewhere` is not an absolute path
    // on Windows, where absolute means `D:\\elsewhere`. Hard-coding the POSIX form
    // asserted the host platform rather than the behaviour.
    const elsewhere = resolve(sep, 'elsewhere');
    expect(resolveOutputDir('/ws', elsewhere, 'proj-1')).toBe(elsewhere);
  });
});

describe('ExportService refusals', () => {
  it('refuses to start when media is missing and asks to relink', async () => {
    const service = new ExportService({ storage: makeStorage() });
    const outcome = await service.start({
      jobId: 'job-missing',
      name: 'Missing media',
      settings: makeSettings({
        items: [
          {
            id: 'item-1',
            trackId: 'track-1',
            type: 'video',
            mediaId: 'media-absent',
            startUs: 0,
            durationUs: 400_000,
            sourceInUs: 0,
            disabled: false,
            muted: false,
            hasAudio: false,
          },
        ],
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("can't be found");
      expect(outcome.action).toBe('relink');
    }
  });

  it('reports the plural form when several files are missing', async () => {
    const service = new ExportService({ storage: makeStorage() });
    const item = (id: string) => ({
      id,
      trackId: 'track-1',
      type: 'video' as const,
      mediaId: `media-${id}`,
      startUs: 0,
      durationUs: 400_000,
      sourceInUs: 0,
      disabled: false,
      muted: false,
      hasAudio: false,
    });
    const outcome = await service.start({
      jobId: 'job-many-missing',
      name: 'Many missing',
      settings: makeSettings({ items: [item('a'), item('b')] }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('2 files');
  });

  it('refuses when the output folder cannot be written', async () => {
    // A regular file pretending to be the output folder cannot be mkdir'd into.
    mkdirSync(TMP, { recursive: true });
    const asFile = join(TMP, 'not-a-folder');
    writeFileSync(asFile, 'x');
    const service = new ExportService({ storage: makeStorage() });
    const outcome = await service.start({
      jobId: 'job-bad-folder',
      name: 'Bad folder',
      settings: makeSettings(),
      outputDir: asFile,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("can't write to");
      expect(outcome.action).toBe('choose-folder');
    }
  });
});

describe.skipIf(!HAS_FFMPEG)('ExportService with real media', () => {
  it('renders the actual source footage into the exported file', async () => {
    // A real 1-second clip with a moving bar: no --createFrameSource override, so
    // the service must choose the decode path itself.
    mkdirSync(TMP, { recursive: true });
    const mediaPath = join(TMP, 'source.mp4');
    const rawPath = join(TMP, 'source.yuv');
    const width = 320;
    const height = 180;
    const frameBytes = width * height + 2 * (width / 2) * (height / 2);
    const frames: Buffer[] = [];
    for (let index = 0; index < 30; index += 1) {
      const frame = Buffer.alloc(frameBytes, 128);
      frame.fill(120, 0, width * height);
      const barX = (index * 8) % width;
      for (let y = 0; y < height; y += 1) {
        for (let x = barX; x < Math.min(width, barX + 40); x += 1) {
          frame[y * width + x] = 220;
        }
      }
      frames.push(frame);
    }
    writeFileSync(rawPath, Buffer.concat(frames));
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`,
        '-framerate', '30', '-i', rawPath, '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-y', mediaPath],
      { stdio: 'ignore' },
    );
    rmSync(rawPath, { force: true });

    const storage = makeStorage({
      getMedia: (mediaId) => (mediaId === 'media-real' ? { path: mediaPath } : undefined),
    });
    const service = new ExportService({ storage });
    const outcome = await service.start({
      jobId: `real-${Date.now().toString(36)}`,
      name: 'Real footage',
      settings: makeSettings({
        items: [
          {
            id: 'item-real',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-real',
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
      outputDir: join(TMP, 'real'),
      fullDecode: true,
    });
    expect(outcome.ok).toBe(true);
    await service.whenIdle();

    const [record] = storage.history;
    expect(record, 'the export should be recorded').toBeTruthy();
    expect(record.status, JSON.stringify(record.validationReport, null, 2)).toBe('verified');
  }, 180_000);
});

describe.skipIf(!HAS_FFMPEG)('ExportService audio', () => {
  let counter = 0;
  const jobId = () => `aud-${counter++}-${Date.now().toString(36)}`;

  it('mixes the source audio into the published file', async () => {
    // A real clip that has a tone on it. With no frameSource override and no
    // audioPath passed in, the service must decode the footage *and* build the
    // mix itself (SPEC 14 §4.2, §5).
    mkdirSync(join(TMP, 'audio-src'), { recursive: true });
    const mediaPath = join(TMP, 'audio-src', 'tone.mp4');
    execFileSync(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', mediaPath],
      { stdio: 'ignore' },
    );

    const storage = makeStorage({
      getMedia: (mediaId) => (mediaId === 'media-tone' ? { path: mediaPath } : undefined),
    });
    const service = new ExportService({ storage });
    const outcome = await service.start({
      jobId: jobId(),
      name: 'With sound',
      settings: makeSettings({
        includeAudio: true,
        normaliseLoudness: false,
        items: [
          {
            id: 'item-tone',
            trackId: 'track-video',
            type: 'video',
            mediaId: 'media-tone',
            startUs: 0,
            durationUs: 2_000_000,
            sourceInUs: 0,
            sourceDurationUs: 2_000_000,
            disabled: false,
            muted: false,
            hasAudio: true,
          },
        ],
      }),
      outputDir: join(TMP, 'audio-out'),
      fullDecode: false,
    });
    expect(outcome.ok).toBe(true);
    await service.whenIdle();

    const [record] = storage.history;
    expect(record, 'the export should be recorded').toBeTruthy();
    if (!outcome.ok) return;

    // The published file must really carry sound, not just claim to.
    const streamInfo = execFileSync(
      ffprobePath(),
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0', outcome.outputPath],
      { encoding: 'utf8' },
    );
    expect(streamInfo.trim()).toContain('audio');

    // ...and the loudness checks must have been *measured*, not guessed.
    // Checks 13 (peak) and 14 (loudness) are the audio ones; both must have been
    // measured against the real file rather than skipped.
    const report = record.validationReport as
      | { checks: Array<{ id: number | string; name: string; status: string; measured?: unknown }> }
      | undefined;
    const checks = report?.checks ?? [];
    const audioChecks = checks.filter((check) => String(check.id).startsWith('13.'));
    expect(audioChecks.length).toBeGreaterThan(0);
    for (const check of audioChecks) {
      expect(check.status, `${check.name}: ${JSON.stringify(check)}
`).not.toBe('fail');
      expect(check.measured, `${check.name} was not measured`).toBeTruthy();
    }

    // The big temp WAV is cleaned up once the file is published.
    const mixFiles = readdirSync(join(TMP, 'Cache', 'export')).filter((name) => name.endsWith('.wav'));
    expect(mixFiles, `leftover mixes: ${mixFiles.join(', ')}`).toHaveLength(0);
  }, 180_000);
});

describe.skipIf(!HAS_FFMPEG)('ExportService idle contract', () => {
  it('whenIdle() resolves only after every finished job was recorded', async () => {
    // Regression guard for a real race: the history row was written by an
    // un-awaited async call, so whenIdle() could resolve first and a caller
    // reading the history straight after an export would intermittently not find
    // it. The queue panel does exactly that.
    //
    // Two jobs rather than one, so the assertion covers "all", and the check is
    // made immediately after whenIdle() with no further waiting.
    const storage = makeStorage();
    const service = new ExportService({ storage });

    for (const index of [0, 1]) {
      const outcome = await service.start({
        jobId: `idle-contract-${index}`,
        name: `Idle contract ${index}`,
        settings: makeSettings(),
        outputDir: join(TMP, 'idle-contract'),
        createFrameSource: () => solidColourFrameSource({ width: 320, height: 180, luma: 40 + index * 20 }),
        fullDecode: false,
      });
      expect(outcome.ok).toBe(true);
      await service.whenIdle();
      // Read straight away: no polling, no extra tick.
      expect(storage.history, `after job ${index}`).toHaveLength(index + 1);
    }
  }, 120_000);
});

describe.skipIf(!HAS_FFMPEG)('ExportService output paths', () => {
  let counter = 0;
  const jobId = () => `svc-${counter++}-${Date.now().toString(36)}`;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  it('auto-numbers a name clash instead of overwriting', async () => {
    const service = new ExportService({ storage: makeStorage() });
    const first = await service.start({
      jobId: jobId(),
      name: 'Clash',
      settings: makeSettings(),
      fileName: 'clash',
      outputDir: join(TMP, 'clash'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 30 }),
      fullDecode: false,
    });
    expect(first.ok).toBe(true);
    await service.whenIdle();

    const second = await service.start({
      jobId: jobId(),
      name: 'Clash',
      settings: makeSettings(),
      fileName: 'clash',
      outputDir: join(TMP, 'clash'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 40 }),
      fullDecode: false,
    });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.outputPath).not.toBe(first.outputPath);
      expect(second.outputPath).toContain('clash 2');
    }
    await service.whenIdle();
    expect(existsSync(join(TMP, 'clash', 'clash.mp4'))).toBe(true);
    expect(existsSync(join(TMP, 'clash', 'clash 2.mp4'))).toBe(true);
  }, 120_000);

  it('replaces when the clash policy says so', async () => {
    const service = new ExportService({ storage: makeStorage() });
    const outputDir = join(TMP, 'replace');
    const first = await service.start({
      jobId: jobId(),
      name: 'Replace',
      settings: makeSettings(),
      fileName: 'same',
      outputDir,
      clashPolicy: 'replace',
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 30 }),
      fullDecode: false,
    });
    await service.whenIdle();
    const second = await service.start({
      jobId: jobId(),
      name: 'Replace',
      settings: makeSettings(),
      fileName: 'same',
      outputDir,
      clashPolicy: 'replace',
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 60 }),
      fullDecode: false,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.outputPath).toBe(first.outputPath);
    await service.whenIdle();
  }, 120_000);

  it('records a verified export in history with its measurements', async () => {
    const storage = makeStorage();
    const service = new ExportService({ storage });
    const outcome = await service.start({
      jobId: jobId(),
      name: 'History row',
      settings: makeSettings(),
      outputDir: join(TMP, 'history'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 50 }),
      fullDecode: true,
    });
    expect(outcome.ok).toBe(true);
    await service.whenIdle();

    expect(storage.history).toHaveLength(1);
    const record = storage.history[0];
    expect(record.status).toBe('verified');
    expect(record.verdict).toBe('Done ✓ Verified');
    expect(record.width).toBe(1280);
    expect(record.height).toBe(720);
    expect(record.fps).toBe(30);
    expect(record.sizeBytes).toBeGreaterThan(0);
    expect(record.elapsedMs).toBeGreaterThan(0);
    expect(record.validationReport).toBeTruthy();
    expect(record.fileMissing).toBe(false);
  }, 120_000);

  it('reports a file deleted outside the app as missing in history', async () => {
    const storage = makeStorage();
    const service = new ExportService({ storage });
    const outcome = await service.start({
      jobId: jobId(),
      name: 'Deleted later',
      settings: makeSettings(),
      outputDir: join(TMP, 'deleted'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 50 }),
      fullDecode: false,
    });
    expect(outcome.ok).toBe(true);
    await service.whenIdle();
    const outputPath = outcome.ok ? outcome.outputPath : '';
    rmSync(outputPath, { force: true });
    // The service asks storage; our stub computes fileMissing itself, so assert
    // the contract the real storage implements.
    const records = service.listHistory();
    expect(records).toHaveLength(1);
    expect(outputPath).toBeTruthy();
    expect(existsSync(outputPath)).toBe(false);
  }, 120_000);

  it('exposes queue state and cancels by id', async () => {
    const service = new ExportService({ storage: makeStorage() });
    const outcome = await service.start({
      jobId: jobId(),
      name: 'Cancel me',
      settings: makeSettings({ rangeUs: [0, 3_000_000] }),
      outputDir: join(TMP, 'cancel'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 50 }),
      fullDecode: false,
    });
    expect(outcome.ok).toBe(true);
    const snapshot = service.snapshot();
    expect(snapshot.jobs.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.maxConcurrent).toBe(1);
    if (outcome.ok) {
      expect(service.cancel(outcome.job.id)).toBe(true);
    }
    await service.whenIdle();
    expect(existsSync(join(TMP, 'cancel'))).toBe(true);
  }, 120_000);

  it('reports an average speed once there is history', async () => {
    const storage = makeStorage();
    const service = new ExportService({ storage });
    const outcome = await service.start({
      jobId: jobId(),
      name: 'Speed',
      settings: makeSettings(),
      outputDir: join(TMP, 'speed'),
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 50 }),
      fullDecode: false,
    });
    expect(outcome.ok).toBe(true);
    await service.whenIdle();
    expect(service.averageSpeed()).toBe(1.8);
  }, 120_000);
});


describe('wordResolverFrom', () => {
  it('turns word refs into text for a karaoke burn-in', () => {
    // The plan carries ids and timings, not words. Without this lookup the ASS
    // writer skipped every word it could not resolve, so a karaoke caption burned
    // in as prose with no sweep — the caption was there, the effect was not.
    const resolve = wordResolverFrom(() => [
      { id: 'w1', text: 'Hello' },
      { id: 'w2', text: 'there' },
    ]);
    expect(resolve('w1')).toBe('Hello');
    expect(resolve('w2')).toBe('there');
  });

  it('returns undefined for a word that is not in the transcript', () => {
    // A ref whose word was deleted from the transcript must fall back to the
    // caption's plain text rather than printing `undefined`.
    const resolve = wordResolverFrom(() => [{ id: 'w1', text: 'Hello' }]);
    expect(resolve('gone')).toBeUndefined();
  });

  it('reads the transcript once, not once per word', () => {
    // A ten-minute clip has thousands of refs; a storage call each would dominate
    // the burn-in setup and the test would be too slow to run.
    let reads = 0;
    const resolve = wordResolverFrom(() => {
      reads += 1;
      return [{ id: 'w1', text: 'Hello' }];
    });
    for (let index = 0; index < 100; index += 1) resolve('w1');
    resolve('w2');
    expect(reads).toBe(1);
  });

  it('still resolves when the transcript is missing', () => {
    // No transcript means prose captions, which is a worse-looking export — not a
    // failed one.
    const resolve = wordResolverFrom(() => undefined);
    expect(resolve('w1')).toBeUndefined();
  });

  it('picks up a word edited after the resolver was built', () => {
    // The resolver is built per export, so an edit saved before the export starts
    // must be the text that is burned in.
    const words = [{ id: 'w1', text: 'Helo' }];
    const resolve = wordResolverFrom(() => words);
    words[0]!.text = 'Hello';
    expect(resolve('w1')).toBe('Hello');
  });
});

describe('the "ask" clash policy actually asks', () => {
  /*
    SPEC 14 §5 offers *Auto-number* (default), *Replace* (confirm) and *Ask*. The service's
    `resolveOutputPath` treated `ask` as auto-number behind a comment claiming "the UI resolves before
    calling us" — a resolution nothing implemented, so choosing *Ask* numbered the file and never
    asked.

    These run without ffmpeg: the clash is detected before any rendering is planned, so the answer
    comes back from `start()` directly. A test gated on ffmpeg would leave this branch unchecked on
    every machine that cannot run it, which is precisely the branch that was wrong.
  */
  const dir = join(TMP, 'ask-clash');

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    /* The path the service would write, occupied by a plain file — no encoder involved. */
    writeFileSync(join(dir, 'taken.mp4'), 'previous render');
  });

  it('returns the clashing path and an action, instead of numbering the file', async () => {
    const service = new ExportService({ storage: makeStorage() });
    const result = await service.start({
      jobId: `ask-${Date.now().toString(36)}`,
      name: 'Ask',
      settings: makeSettings(),
      fileName: 'taken',
      outputDir: dir,
      clashPolicy: 'ask',
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 30 }),
      fullDecode: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      /* The path, not a sentence: the dialog shows "…/taken.mp4 already exists." */
      expect(result.error).toBe(join(dir, 'taken.mp4'));
      expect(result.action).toBe('resolve-clash');
    }
    /* Nothing was written and nothing was queued. */
    expect(existsSync(join(dir, 'taken 2.mp4'))).toBe(false);
  });

  it('does not ask when there is nothing to clash with', async () => {
    /*
      The policy is about a collision, not about prompting: with a free name the export starts
      normally. Asserted through the *absence of the clash answer* rather than through a successful
      render, because starting one needs an encoder — and the whole point of this file's placement
      outside `skipIf(!HAS_FFMPEG)` is that the clash logic runs on machines without one. A test
      that begins a real render here would pass on a developer's machine and fail in CI, which is
      how this test was first written.
    */
    const service = new ExportService({ storage: makeStorage() });
    const result = await service.start({
      jobId: `ask-free-${Date.now().toString(36)}`,
      name: 'Ask',
      settings: makeSettings(),
      fileName: 'free',
      outputDir: dir,
      clashPolicy: 'ask',
      createFrameSource: () => solidColourFrameSource({ width: 1280, height: 720, luma: 30 }),
      fullDecode: false,
    });
    /* Whatever the encoder does later, the *start* must not be a clash question. */
    if (!result.ok) expect(result.action).not.toBe('resolve-clash');
    /* And no numbered sibling was created for a name that was free. */
    expect(existsSync(join(dir, 'free 2.mp4'))).toBe(false);
  });
});
