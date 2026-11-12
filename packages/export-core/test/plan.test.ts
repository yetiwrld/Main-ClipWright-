import { describe, expect, it } from 'vitest';
import { buildExportGraph, computeOutputSize, even, presetTable, runValidationChecks, buildExportPlan } from '../src/index.js';
import { CompositionSchema } from '@clipwright/project-schema';

describe('even rounding', () => {
  it('rounds to nearest even integer', () => {
    expect(even(1280)).toBe(1280);
    expect(even(1281)).toBe(1282);
    expect(even(1151.5)).toBe(1152);
    expect(even(4)).toBe(4);
    expect(even(5)).toBe(6); // hmm — nearest even to 4.5/5: Math.round(5)=5 (odd) → n>=r → 6 ✓
  });
});

describe('output size contract (Section 19.2 table)', () => {
  const table = presetTable();
  const expected: Record<string, [number, number]> = {
    '720p/16:9': [1280, 720], '720p/9:16': [720, 1280], '720p/1:1': [720, 720], '720p/4:5': [720, 900], '720p/4:3': [960, 720], '720p/21:9': [1680, 720],
    '1080p/16:9': [1920, 1080], '1080p/9:16': [1080, 1920], '1080p/1:1': [1080, 1080], '1080p/4:5': [1080, 1350], '1080p/4:3': [1440, 1080], '1080p/21:9': [2520, 1080],
    'dci-2k/16:9': [2048, 1152], 'dci-2k/9:16': [1152, 2048], 'dci-2k/1:1': [1152, 1152], 'dci-2k/4:5': [1152, 1440], 'dci-2k/4:3': [1536, 1152], 'dci-2k/21:9': [2688, 1152],
    'qhd-1440p/16:9': [2560, 1440], 'qhd-1440p/9:16': [1440, 2560], 'qhd-1440p/1:1': [1440, 1440], 'qhd-1440p/4:5': [1440, 1800], 'qhd-1440p/4:3': [1920, 1440], 'qhd-1440p/21:9': [3360, 1440],
    '4k-uhd/16:9': [3840, 2160], '4k-uhd/9:16': [2160, 3840], '4k-uhd/1:1': [2160, 2160], '4k-uhd/4:5': [2160, 2700], '4k-uhd/4:3': [2880, 2160], '4k-uhd/21:9': [5040, 2160],
  };
  for (const [key, [w, h]] of Object.entries(expected)) {
    const [preset, aspect] = key.split('/') as [keyof typeof table, string];
    it(`${key} → ${w}×${h}`, () => {
      expect(table[preset][aspect]).toEqual({ width: w, height: h });
    });
  }

  it('preserves aspect for original and never returns odd sizes', () => {
    const size = computeOutputSize(1080, 'original', { width: 1920, height: 1080 });
    expect(size).toEqual({ width: 1920, height: 1080 });
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });
});

describe('buildExportPlan', () => {
  it('builds a summary string with real numbers', () => {
    const plan = buildExportPlan({ fps: 30, durationUs: 62_100_000 }, {
      preset: '1080p', aspect: '9:16', fps: 'match', format: 'mp4', quality: 'standard',
      audioBitrateKbps: 192, loudnessTargetLufs: -16, burnCaptions: true, subtitleSidecar: false, draft: false,
    });
    expect(plan.output).toEqual({ width: 1080, height: 1920 });
    expect(plan.fps).toBe(30);
    expect(plan.durationFrames).toBe(1863);
    expect(plan.summary).toContain('1080×1920');
    expect(plan.estimatedBytes).toBeGreaterThan(0);
  });
});

const baseComp = () => CompositionSchema.parse({
  id: 'c1', projectId: 'p1', name: 'Clip', fps: 30, width: 1080, height: 1920,
  createdAt: 1, updatedAt: 1,
  tracks: [{ id: 't1', type: 'video', name: 'Video 1', order: 0 }, { id: 't2', type: 'audio', name: 'Audio', order: 1 }],
  items: [
    { id: 'v1', trackId: 't1', kind: 'video', name: 'src', startUs: 0, durationUs: 2_500_000, inUs: 2_000_000, mediaId: 'm1' },
    { id: 'v2', trackId: 't1', kind: 'video', name: 'src', startUs: 2_500_000, durationUs: 2_500_000, inUs: 10_000_000, mediaId: 'm1' },
  ],
});

describe('buildExportGraph', () => {
  const media = new Map([['m1', { path: '/media/src.mp4', durationUs: 60_000_000 }]]);

  it('builds a filter graph for a simple composition', () => {
    const res = buildExportGraph(baseComp(), [
      { text: 'Hello world', startUs: 0, endUs: 2_000_000, style: { family: 'Manrope', sizePx: 60, color: 'white', outlineColor: 'black', outlinePx: 4, yPct: 62, align: 'center', uppercase: true } },
    ], { output: { width: 1080, height: 1920 }, fps: 30, durationSeconds: 5, media, fontFile: '/fonts/Manrope.ttf' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const args = res.args.join(' ');
      expect(args).toContain('filter_complex');
      expect(args).toContain('concat');
      expect(args).toContain('drawtext');
      expect(args).toContain('libx264');
      expect(res.args[res.args.length - 1]).toBe('OUTFILE');
    }
  });

  it('inserts black gap fillers for timeline gaps', () => {
    const comp = baseComp();
    comp.items = [{ ...comp.items[0]!, startUs: 2_000_000 }];
    const res = buildExportGraph(comp, [], { output: { width: 1080, height: 1920 }, fps: 30, durationSeconds: 7, media, fontFile: '/fonts/Manrope.ttf' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.args.join(' ')).toContain('color=c=black');
  });

  it('refuses compositions with unsupported features instead of silently dropping them', () => {
    const comp = baseComp();
    comp.effects = [{ id: 'e1', type: 'blur', enabled: true, params: {} }];
    const res = buildExportGraph(comp, [], { output: { width: 1080, height: 1920 }, fps: 30, durationSeconds: 5, media, fontFile: '/fonts/Manrope.ttf' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unsupported).toContain('effects');
  });
});

describe('runValidationChecks', () => {
  const plan = { width: 1080, height: 1920, fps: 30, durationUs: 5_000_000, audioExpected: true, audioSampleRate: 48000, videoCodec: 'h264' };
  const goodProbe = {
    format: { duration: '5.000', size: '1000000' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1', r_frame_rate: '30/1', nb_frames: '150', sample_aspect_ratio: '1:1', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
  };

  it('passes a correct export', () => {
    const report = runValidationChecks(plan, goodProbe);
    expect(report.requiredFailures).toHaveLength(0);
    expect(report.status).toBe('verified');
  });

  it('detects wrong size and wrong fps', () => {
    const bad = JSON.parse(JSON.stringify(goodProbe));
    bad.streams[0].width = 1920; bad.streams[0].height = 1080;
    bad.streams[0].avg_frame_rate = '25/1'; bad.streams[0].r_frame_rate = '25/1';
    const report = runValidationChecks(plan, bad);
    expect(report.status).toBe('failed');
    const ids = report.requiredFailures.map((c) => c.id);
    expect(ids).toContain(3);
    expect(ids).toContain(5);
  });

  it('detects missing audio', () => {
    const bad = { format: goodProbe.format, streams: [goodProbe.streams[0]] };
    const report = runValidationChecks(plan, bad);
    expect(report.status).toBe('failed');
  });

  it('flags variable frame rate as a failure', () => {
    const bad = JSON.parse(JSON.stringify(goodProbe));
    bad.streams[0].avg_frame_rate = '30000/1001';
    bad.streams[0].r_frame_rate = '60/1';
    expect(runValidationChecks(plan, bad).status).toBe('failed');
  });
});
