import { describe, expect, it } from 'vitest';
import { validateExport, parseFrameRate, formatValidationSummary } from '../validation.js';
import type { ProbeResult } from '../validation.js';
import { buildExportPlan } from '../planner.js';
import type { ExportSettings } from '../planner.js';

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-1',
    projectId: 'proj-1',
    preset: '1080p',
    aspect: '16:9',
    fps: 30,
    format: 'mp4',
    quality: 'standard',
    rateControl: 'vbr',
    audioBitrate: 192,
    includeAudio: true,
    burnCaptions: true,
    saveSubtitles: false,
    subtitleFormats: [],
    embedProjectName: true,
    normaliseLoudness: false,
    targetLufs: -16,
    isDraft: false,
    rangeUs: [0, 60_000_000],
    compositionFps: 30,
    compositionDurationUs: 60_000_000,
    items: [
      {
        id: 'item-a',
        trackId: 'track-1',
        type: 'video',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 60_000_000,
        sourceInUs: 0,
        sourceDurationUs: 60_000_000,
        disabled: false,
        muted: false,
        hasAudio: true,
      },
    ],
    ...overrides,
  };
}

function makeProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    exists: true,
    sizeBytes: 50_000_000,
    width: 1920,
    height: 1080,
    durationSeconds: 60,
    frameRate: '30/1',
    hasVideoStream: true,
    hasAudioStream: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    profile: 'High',
    audioSampleRate: 48000,
    audioChannels: 2,
    frameCount: 1800,
    moovAtStart: true,
    ...overrides,
  };
}

describe('parseFrameRate', () => {
  it('parses "30/1"', () => {
    expect(parseFrameRate('30/1')).toBe(30);
  });

  it('parses "30000/1001"', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97);
  });

  it('parses "25"', () => {
    expect(parseFrameRate('25')).toBe(25);
  });

  it('returns 0 for invalid input', () => {
    expect(parseFrameRate('invalid')).toBe(0);
  });
});

describe('validateExport', () => {
  it('passes all checks for a valid export', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe());
    expect(report.overallStatus).toBe('verified');
    const requiredChecks = report.checks.filter((c) => c.required);
    expect(requiredChecks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails when file does not exist', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe({ exists: false, sizeBytes: 0 }));
    expect(report.overallStatus).toBe('failed');
    const check1 = report.checks.find((c) => c.id === 1)!;
    expect(check1.status).toBe('fail');
  });

  it('fails when resolution is wrong', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe({ width: 1280, height: 720 }));
    expect(report.overallStatus).toBe('failed');
    const check3 = report.checks.find((c) => c.id === 3)!;
    expect(check3.status).toBe('fail');
  });

  it('fails when frame rate is wrong', () => {
    const plan = buildExportPlan(makeSettings({ fps: 30 }));
    const report = validateExport(plan, makeProbe({ frameRate: '60/1' }));
    expect(report.overallStatus).toBe('failed');
    const check5 = report.checks.find((c) => c.id === 5)!;
    expect(check5.status).toBe('fail');
  });

  it('fails when frame count is wrong', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe({ frameCount: 1799 }));
    expect(report.overallStatus).toBe('failed');
    const check7 = report.checks.find((c) => c.id === 7)!;
    expect(check7.status).toBe('fail');
  });

  it('fails when duration is wrong', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe({ durationSeconds: 59 }));
    expect(report.overallStatus).toBe('failed');
    const check6 = report.checks.find((c) => c.id === 6)!;
    expect(check6.status).toBe('fail');
  });

  it('fails when codec is wrong', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe({ videoCodec: 'vp9' }));
    expect(report.overallStatus).toBe('failed');
    const check14 = report.checks.find((c) => c.id === 14)!;
    expect(check14.status).toBe('fail');
  });

  it('passes when audio is excluded and no audio stream', () => {
    const plan = buildExportPlan(makeSettings({ includeAudio: false }));
    const report = validateExport(plan, makeProbe({ hasAudioStream: false }));
    expect(report.overallStatus).toBe('verified');
  });

  it('fails when audio expected but missing', () => {
    const plan = buildExportPlan(makeSettings({ includeAudio: true }));
    const report = validateExport(plan, makeProbe({ hasAudioStream: false }));
    expect(report.overallStatus).toBe('failed');
    const check2 = report.checks.find((c) => c.id === 2)!;
    expect(check2.status).toBe('fail');
  });

  it('skips decode check for quick verify', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe(), { fullDecode: false });
    const check8 = report.checks.find((c) => c.id === 8);
    expect(check8).toBeUndefined();
  });

  it('includes caption burn-in check when burnCaptions is true', () => {
    const plan = buildExportPlan(makeSettings({ burnCaptions: true }));
    const report = validateExport(plan, makeProbe());
    const check17 = report.checks.find((c) => c.id === 17);
    expect(check17).toBeTruthy();
    expect(check17!.status).toBe('pass');
  });

  it('includes subtitle check when saveSubtitles is true', () => {
    const plan = buildExportPlan(makeSettings({ saveSubtitles: true, subtitleFormats: ['srt'] }));
    const report = validateExport(plan, makeProbe());
    const check18 = report.checks.find((c) => c.id === 18);
    expect(check18).toBeTruthy();
    expect(check18!.status).toBe('pass');
  });

  it('formatValidationSummary returns a summary string', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makeProbe());
    const summary = formatValidationSummary(report);
    expect(summary).toContain('passed');
    expect(summary).toContain('verified');
  });
});


import { generateSrt, generateVtt, generateSubtitles, extractCuesFromItems, formatSrtTimestamp, formatVttTimestamp } from '../subtitles.js';

describe('Subtitle generation', () => {
  it('generates SRT with correct format', () => {
    const srt = generateSrt([
      { startUs: 0, endUs: 2_000_000, text: 'Hello world' },
      { startUs: 2_000_000, endUs: 4_000_000, text: 'Second cue' },
    ]);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,000\nHello world');
    expect(srt).toContain('2\n00:00:02,000 --> 00:00:04,000\nSecond cue');
  });

  it('generates VTT with correct format', () => {
    const vtt = generateVtt([
      { startUs: 0, endUs: 2_000_000, text: 'Hello world' },
    ]);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.000\nHello world');
  });

  it('generateSubtitles dispatches to correct format', () => {
    const cues = [{ startUs: 0, endUs: 1_000_000, text: 'Test' }];
    expect(generateSubtitles(cues, 'srt')).toContain('00:00:00,000');
    expect(generateSubtitles(cues, 'vtt')).toContain('WEBVTT');
  });

  it('extractCuesFromItems filters caption items', () => {
    const cues = extractCuesFromItems([
      { id: 'a', type: 'caption', startUs: 0, durationUs: 2_000_000, captionSegment: { text: 'Hello' } },
      { id: 'b', type: 'video', startUs: 0, durationUs: 2_000_000 },
      { id: 'c', type: 'caption', startUs: 2_000_000, durationUs: 1_000_000, captionSegment: { text: 'World' } },
    ]);
    expect(cues.length).toBe(2);
    expect(cues[0].text).toBe('Hello');
    expect(cues[1].text).toBe('World');
  });

  it('formats SRT timestamp correctly', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
    expect(formatSrtTimestamp(2_000_000)).toBe('00:00:02,000');
    expect(formatSrtTimestamp(3_600_000_000)).toBe('01:00:00,000');
  });

  it('formats VTT timestamp correctly', () => {
    expect(formatVttTimestamp(0)).toBe('00:00:00.000');
    expect(formatVttTimestamp(2_000_000)).toBe('00:00:02.000');
  });
});
