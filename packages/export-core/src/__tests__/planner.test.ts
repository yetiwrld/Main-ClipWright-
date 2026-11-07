import { describe, expect, it } from 'vitest';
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
        durationUs: 30_000_000,
        sourceInUs: 0,
        sourceDurationUs: 30_000_000,
        disabled: false,
        muted: false,
        hasAudio: true,
      },
      {
        id: 'item-b',
        trackId: 'track-1',
        type: 'caption',
        startUs: 30_000_000,
        durationUs: 30_000_000,
        sourceInUs: 0,
        disabled: false,
        muted: false,
        hasAudio: false,
      },
    ],
    ...overrides,
  };
}

describe('buildExportPlan', () => {
  it('builds a plan with correct resolution', () => {
    const plan = buildExportPlan(makeSettings());
    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
  });

  it('computes total frames from duration and fps', () => {
    const plan = buildExportPlan(makeSettings());
    expect(plan.totalFrames).toBe(1800); // 60s × 30fps
  });

  it('includes only active items in the range', () => {
    const plan = buildExportPlan(makeSettings());
    expect(plan.items.length).toBe(2);
    expect(plan.items[0].itemId).toBe('item-a');
    expect(plan.items[1].itemId).toBe('item-b');
  });

  it('excludes disabled items', () => {
    const settings = makeSettings({
      items: [
        {
          id: 'item-a',
          trackId: 'track-1',
          type: 'video',
          mediaId: 'media-1',
          startUs: 0,
          durationUs: 30_000_000,
          sourceInUs: 0,
          sourceDurationUs: 30_000_000,
          disabled: true,
          muted: false,
          hasAudio: true,
        },
      ],
    });
    const plan = buildExportPlan(settings);
    expect(plan.items.length).toBe(0);
  });

  it('sets video codec based on format', () => {
    const mp4Plan = buildExportPlan(makeSettings({ format: 'mp4' }));
    expect(mp4Plan.videoCodec).toBe('h264');

    const webmPlan = buildExportPlan(makeSettings({ format: 'webm' }));
    expect(webmPlan.videoCodec).toBe('vp9');
  });

  it('sets CRF from quality preset', () => {
    const draftPlan = buildExportPlan(makeSettings({ quality: 'draft' }));
    expect(draftPlan.crf).toBe(26);

    const maxPlan = buildExportPlan(makeSettings({ quality: 'maximum' }));
    expect(maxPlan.crf).toBe(16);
  });

  it('handles portrait aspect ratio', () => {
    const plan = buildExportPlan(makeSettings({ aspect: '9:16' }));
    expect(plan.width).toBe(1080);
    expect(plan.height).toBe(1920);
  });

  it('handles 60 fps', () => {
    const plan = buildExportPlan(makeSettings({ fps: 60 }));
    expect(plan.fps).toBe(60);
    expect(plan.totalFrames).toBe(3600); // 60s × 60fps
  });

  it('clips items to the export range', () => {
    const settings = makeSettings({
      rangeUs: [10_000_000, 50_000_000],
    });
    const plan = buildExportPlan(settings);
    // item-a (0-30s) overlaps 10-30s, item-b (30-60s) overlaps 30-50s
    expect(plan.items.length).toBe(2);
    expect(plan.items[0].startUs).toBe(10_000_000);
    expect(plan.items[0].durationUs).toBe(20_000_000);
    expect(plan.items[1].startUs).toBe(30_000_000);
    expect(plan.items[1].durationUs).toBe(20_000_000);
  });

  it('excludes items outside the range', () => {
    const settings = makeSettings({
      rangeUs: [0, 10_000_000],
      items: [
        {
          id: 'item-a',
          trackId: 'track-1',
          type: 'video',
          mediaId: 'media-1',
          startUs: 0,
          durationUs: 30_000_000,
          sourceInUs: 0,
          sourceDurationUs: 30_000_000,
          disabled: false,
          muted: false,
          hasAudio: true,
        },
        {
          id: 'item-b',
          trackId: 'track-1',
          type: 'caption',
          startUs: 50_000_000,
          durationUs: 10_000_000,
          sourceInUs: 0,
          disabled: false,
          muted: false,
          hasAudio: false,
        },
      ],
    });
    const plan = buildExportPlan(settings);
    // item-b starts at 50s which is outside the 0-10s range
    expect(plan.items.length).toBe(1);
    expect(plan.items[0].itemId).toBe('item-a');
  });

  it('sets duration correctly', () => {
    const plan = buildExportPlan(makeSettings());
    expect(plan.durationUs).toBe(60_000_000);
    expect(plan.durationSeconds).toBeCloseTo(60);
  });

  it('is deterministic: same inputs produce identical plans', () => {
    const first = buildExportPlan(makeSettings());
    const second = buildExportPlan(makeSettings());
    expect(second).toEqual(first);
    expect(second.id).toBe(first.id);
  });

  it('produces different plan ids for different settings', () => {
    const base = buildExportPlan(makeSettings());
    const other = buildExportPlan(makeSettings({ quality: 'high' }));
    expect(other.id).not.toBe(base.id);
  });

  it('marks audio-bearing items correctly', () => {
    const plan = buildExportPlan(makeSettings());
    const videoItem = plan.items.find((i) => i.itemId === 'item-a')!;
    const captionItem = plan.items.find((i) => i.itemId === 'item-b')!;
    expect(videoItem.hasAudio).toBe(true);
    expect(captionItem.hasAudio).toBe(false);
  });
});
