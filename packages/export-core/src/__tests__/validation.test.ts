import { describe, expect, it } from 'vitest';
import {
  validateExport,
  parseFrameRate,
  formatValidationSummary,
  formatValidationVerdict,
  failedCheckNames,
  type ProbeResult,
} from '../validation.js';
import { buildExportPlan, type ExportSettings } from '../planner.js';

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
    burnCaptions: false,
    saveSubtitles: false,
    subtitleFormats: [],
    embedProjectName: true,
    normaliseLoudness: false,
    targetLufs: -16,
    isDraft: false,
    rangeUs: [0, 60_000_000],
    compositionFps: 30,
    compositionDurationUs: 60_000_000,
    items: [],
    ...overrides,
  };
}

/** A fully measured, fully passing probe. Every check that can be measured is. */
function makePerfectProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    exists: true,
    sizeBytes: 50_000_000,
    width: 1920,
    height: 1080,
    durationSeconds: 60,
    frameRate: '30/1',
    avgFrameRate: '30/1',
    hasVideoStream: true,
    hasAudioStream: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    profile: 'High',
    audioSampleRate: 48_000,
    audioChannels: 2,
    frameCount: 1800,
    moovAtStart: true,
    containerDurationSeconds: 60,
    decodeErrors: 0,
    videoStartSeconds: 0,
    audioStartSeconds: 0,
    unexpectedBlackSegments: 0,
    unexpectedFreezeSegments: 0,
    integratedLufs: -18,
    truePeakDb: -1.2,
    audioSilent: false,
    videoBitrateBps: 6_000_000,
    colorSpace: 'bt709',
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorRange: 'tv',
    ...overrides,
  };
}

describe('parseFrameRate', () => {
  it('parses "30/1"', () => expect(parseFrameRate('30/1')).toBe(30));
  it('parses "30000/1001"', () => expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97));
  it('parses "25"', () => expect(parseFrameRate('25')).toBe(25));
  it('returns 0 for garbage', () => expect(parseFrameRate('invalid')).toBe(0));
  it('returns 0 for zero denominator', () => expect(parseFrameRate('30/0')).toBe(0));
});

describe('validateExport — verified', () => {
  it('reaches verified only when every measurement is present and passing', () => {
    const plan = buildExportPlan(makeSettings());
    const report = validateExport(plan, makePerfectProbe());
    expect(report.overallStatus).toBe('verified');
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(formatValidationVerdict(report)).toBe('Done ✓ Verified');
  });

  it('emits checks in the spec order', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe());
    const ids = report.checks.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toContain(1);
    expect(ids).toContain(14);
  });
});

describe('validateExport — required failures', () => {
  it('fails when the file does not exist', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ exists: false, sizeBytes: 0 }),
    );
    expect(report.overallStatus).toBe('failed');
    expect(report.checks.find((c) => c.id === 1)!.status).toBe('fail');
  });

  it('fails on the wrong resolution', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ width: 1280, height: 720 }),
    );
    expect(report.overallStatus).toBe('failed');
    expect(report.checks.find((c) => c.id === 3)!.status).toBe('fail');
  });

  it('fails on the wrong aspect ratio', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ width: 1080, height: 1080 }),
    );
    expect(report.checks.find((c) => c.id === 4)!.status).toBe('fail');
  });

  it('fails on the wrong frame rate', () => {
    const report = validateExport(
      buildExportPlan(makeSettings({ fps: 30 })),
      makePerfectProbe({ frameRate: '60/1', avgFrameRate: '60/1' }),
    );
    expect(report.checks.find((c) => c.id === 5)!.status).toBe('fail');
  });

  it('fails when r_frame_rate and avg_frame_rate disagree (variable rate)', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ frameRate: '30/1', avgFrameRate: '2997/100' }),
    );
    expect(report.checks.find((c) => c.id === 5)!.status).toBe('fail');
  });

  it('fails on a wrong frame count', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ frameCount: 1799 }));
    expect(report.checks.find((c) => c.id === 7)!.status).toBe('fail');
  });

  it('fails on a duration more than one frame out', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ durationSeconds: 59 }));
    expect(report.checks.find((c) => c.id === 6)!.status).toBe('fail');
  });

  it('tolerates a duration less than one frame out', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ durationSeconds: 60 + 1 / 60 }),
    );
    expect(report.checks.find((c) => c.id === 6)!.status).toBe('pass');
  });

  it('fails on the wrong codec', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ videoCodec: 'vp9' }));
    expect(report.checks.find((c) => c.id === 14)!.status).toBe('fail');
  });

  it('fails on a non-yuv420p pixel format', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ pixelFormat: 'yuv444p' }));
    expect(report.checks.find((c) => c.id === 14)!.status).toBe('fail');
  });

  it('fails when audio was expected but is missing', () => {
    const report = validateExport(
      buildExportPlan(makeSettings({ includeAudio: true })),
      makePerfectProbe({ hasAudioStream: false }),
    );
    expect(report.checks.find((c) => c.id === 2)!.status).toBe('fail');
  });

  it('fails when audio was excluded but a stream is present', () => {
    const report = validateExport(
      buildExportPlan(makeSettings({ includeAudio: false })),
      makePerfectProbe({ hasAudioStream: true }),
    );
    expect(report.checks.find((c) => c.id === 13)!.status).toBe('fail');
  });

  it('passes an audio-free export with no audio stream', () => {
    const report = validateExport(
      buildExportPlan(makeSettings({ includeAudio: false })),
      makePerfectProbe({ hasAudioStream: false }),
    );
    expect(report.checks.find((c) => c.id === 13)!.status).toBe('pass');
    expect(report.overallStatus).toBe('verified');
  });

  it('fails when the decode pass saw errors', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ decodeErrors: 3, decodeErrorDetail: 'Invalid NAL unit size' }),
    );
    const check = report.checks.find((c) => c.id === 8)!;
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('Invalid NAL unit size');
  });

  it('fails when the stream is the wrong sample rate', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ audioSampleRate: 44_100 }),
    );
    expect(report.checks.find((c) => c.id === 13)!.status).toBe('fail');
  });
});

describe('validateExport — never passes without a measurement', () => {
  it('reports warnings (not verified) when nothing but the basics was probed', () => {
    const plan = buildExportPlan(makeSettings());
    // The minimum a caller could know: probe succeeded, nothing else measured.
    const bare: ProbeResult = {
      exists: true,
      sizeBytes: 1_000_000,
      width: 1920,
      height: 1080,
      durationSeconds: 60,
      frameRate: '30/1',
      hasVideoStream: true,
      hasAudioStream: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      profile: '',
      audioSampleRate: 48_000,
      audioChannels: 2,
      moovAtStart: true,
    };
    const report = validateExport(plan, bare);
    expect(report.overallStatus).toBe('warnings');
    expect(formatValidationVerdict(report)).toContain('warnings');
    // Frame count, decode, sync, black, freeze, bitrate, colour are unmeasured.
    for (const id of [7, 8, 10, 11, 12, 15, 16]) {
      expect(report.checks.find((c) => c.id === id)!.status, `check ${id}`).toBe('warning');
    }
  });

  it('marks decode as a warning when fullDecode is off', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe(), { fullDecode: false });
    expect(report.checks.find((c) => c.id === 8)!.status).toBe('warning');
    expect(report.overallStatus).toBe('warnings');
  });

  it('marks a quick (sample-based) decode as measured when it ran clean', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe(), {
      fullDecode: true,
      quickVerify: true,
    });
    const check = report.checks.find((c) => c.id === 8)!;
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('Sample-based');
  });

  it('fails when moov is not at the start', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ moovAtStart: false }));
    expect(report.checks.find((c) => c.id === 9)!.status).toBe('fail');
  });
});

describe('validateExport — optional checks', () => {
  it('warns on unexpected black segments but does not fail the export', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ unexpectedBlackSegments: 2 }),
    );
    expect(report.checks.find((c) => c.id === 11)!.status).toBe('fail');
    expect(report.overallStatus).toBe('warnings');
  });

  it('warns on unexpected frozen segments', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ unexpectedFreezeSegments: 1 }),
    );
    expect(report.overallStatus).toBe('warnings');
  });

  it('fails the sync check when the streams start more than a frame apart', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ videoStartSeconds: 0, audioStartSeconds: 0.5 }),
    );
    const check = report.checks.find((c) => c.id === 10)!;
    expect(check.status).toBe('fail');
    expect(check.required).toBe(false);
  });

  it('checks loudness against the target when normalisation was on', () => {
    const plan = buildExportPlan(makeSettings({ normaliseLoudness: true, targetLufs: -16 }));
    const good = validateExport(plan, makePerfectProbe({ integratedLufs: -16.4 }));
    expect(good.checks.find((c) => c.id === 13.1)!.status).toBe('pass');

    const bad = validateExport(plan, makePerfectProbe({ integratedLufs: -19.5 }));
    expect(bad.checks.find((c) => c.id === 13.1)!.status).toBe('fail');
  });

  it('flags clipping above -0.5 dBTP', () => {
    const report = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ truePeakDb: -0.1 }),
    );
    expect(report.checks.find((c) => c.id === 13.1)!.status).toBe('fail');
  });

  it('flags a silent mix when the plan has audible content', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ audioSilent: true }));
    expect(report.checks.find((c) => c.id === 13.2)!.status).toBe('fail');
  });

  it('checks bitrate against a custom target within 35%', () => {
    const plan = buildExportPlan(makeSettings({ videoBitrate: 8 }));
    const good = validateExport(plan, makePerfectProbe({ videoBitrateBps: 8_200_000 }));
    expect(good.checks.find((c) => c.id === 15)!.status).toBe('pass');

    const bad = validateExport(plan, makePerfectProbe({ videoBitrateBps: 21_000_000 }));
    expect(bad.checks.find((c) => c.id === 15)!.status).toBe('fail');
  });

  it('checks colour tags are actually bt709', () => {
    const untagged = validateExport(
      buildExportPlan(makeSettings()),
      makePerfectProbe({ colorPrimaries: 'unknown', colorTransfer: 'unknown' }),
    );
    expect(untagged.checks.find((c) => c.id === 16)!.status).toBe('fail');
  });
});

describe('validateExport — captions and subtitles', () => {
  it('adds the burn-in check only when captions are burned', () => {
    const on = validateExport(buildExportPlan(makeSettings({ burnCaptions: true })), makePerfectProbe({ captionSsim: 0.99 }));
    expect(on.checks.find((c) => c.id === 17)!.status).toBe('pass');

    const off = validateExport(buildExportPlan(makeSettings({ burnCaptions: false })), makePerfectProbe());
    expect(off.checks.find((c) => c.id === 17)).toBeUndefined();
  });

  it('fails the burn-in check below SSIM 0.97', () => {
    const report = validateExport(
      buildExportPlan(makeSettings({ burnCaptions: true })),
      makePerfectProbe({ captionSsim: 0.94 }),
    );
    expect(report.checks.find((c) => c.id === 17)!.status).toBe('fail');
  });

  it('warns when captions were burned but never sampled', () => {
    const report = validateExport(buildExportPlan(makeSettings({ burnCaptions: true })), makePerfectProbe());
    expect(report.checks.find((c) => c.id === 17)!.status).toBe('warning');
  });

  it('passes subtitle files that match the requested formats', () => {
    const plan = buildExportPlan(makeSettings({ saveSubtitles: true, subtitleFormats: ['srt', 'vtt'] }));
    const report = validateExport(
      plan,
      makePerfectProbe({
        subtitleFiles: [
          { format: 'srt', cueCount: 5 },
          { format: 'vtt', cueCount: 5 },
        ],
        expectedSubtitleCues: 5,
      }),
    );
    expect(report.checks.find((c) => c.id === 18)!.status).toBe('pass');
  });

  it('fails when a requested subtitle format is missing', () => {
    const plan = buildExportPlan(makeSettings({ saveSubtitles: true, subtitleFormats: ['srt', 'vtt'] }));
    const report = validateExport(plan, makePerfectProbe({ subtitleFiles: [{ format: 'srt', cueCount: 5 }] }));
    expect(report.checks.find((c) => c.id === 18)!.status).toBe('fail');
  });

  it('fails when cue counts do not match the captions', () => {
    const plan = buildExportPlan(makeSettings({ saveSubtitles: true, subtitleFormats: ['srt'] }));
    const report = validateExport(
      plan,
      makePerfectProbe({ subtitleFiles: [{ format: 'srt', cueCount: 3 }], expectedSubtitleCues: 5 }),
    );
    expect(report.checks.find((c) => c.id === 18)!.status).toBe('fail');
  });
});

describe('report helpers', () => {
  it('summarises counts and status', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe());
    expect(formatValidationSummary(report)).toContain('passed');
    expect(formatValidationSummary(report)).toContain('verified');
  });

  it('lists the checks that blocked verification', () => {
    const report = validateExport(buildExportPlan(makeSettings()), makePerfectProbe({ width: 1280, height: 720 }));
    expect(failedCheckNames(report)).toContain('Resolution');
  });

  it('carries the plan id so the report can be attached to the job', () => {
    const plan = buildExportPlan(makeSettings());
    expect(validateExport(plan, makePerfectProbe()).planId).toBe(plan.id);
  });
});
