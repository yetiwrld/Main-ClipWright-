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

/**
 * SPEC 12 §4.2 — the planner links each item to the transition it leaves through.
 *
 * A transition is stored on the *incoming* item, so the outgoing one carries no
 * record of it. The audio mixer needs both halves to crossfade over one window, and
 * resolving the pair here keeps a single definition of "the next item on this track"
 * rather than a second one inside the mixer.
 */
describe('transition linking', () => {
  const twoClips = (overrides: Record<string, unknown> = {}) => [
    {
      id: 'a', trackId: 'track-main', type: 'video', mediaId: 'media-a',
      startUs: 0, durationUs: 1_000_000, sourceInUs: 0, sourceDurationUs: 2_000_000,
      disabled: false, muted: false, hasAudio: true, trackOrder: 0,
    },
    {
      id: 'b', trackId: 'track-main', type: 'video', mediaId: 'media-b',
      startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 500_000, sourceDurationUs: 2_000_000,
      disabled: false, muted: false, hasAudio: true, trackOrder: 0,
      transitionIn: {
        type: 'crossfade', durationUs: 400_000, alignment: 'center',
        params: {}, easing: 'linear', crossfadeAudio: true,
        ...overrides,
      },
    },
  ];

  it('gives the outgoing clip the transition it is leaving through', () => {
    const plan = buildExportPlan(makeSettings({ items: twoClips() as never }));
    const outgoing = plan.items.find((item) => item.itemId === 'a')!;
    expect(outgoing.transitionOut).toBeDefined();
    expect(outgoing.transitionOut!.type).toBe('crossfade');
    expect(outgoing.transitionOut!.durationUs).toBe(400_000);
  });

  it('leaves the incoming clip without a transitionOut of its own', () => {
    // Nothing follows it, so it is not leaving through anything.
    const plan = buildExportPlan(makeSettings({ items: twoClips() as never }));
    expect(plan.items.find((item) => item.itemId === 'b')!.transitionOut).toBeUndefined();
  });

  it('does not link clips that are not touching', () => {
    // A gap means the two are not joined: the transition belongs to a different cut
    // and the first clip's audio must end where it ends, not fade into nothing.
    const items = twoClips();
    (items[1] as { startUs: number }).startUs = 1_500_000;
    const plan = buildExportPlan(makeSettings({ items: items as never }));
    expect(plan.items.find((item) => item.itemId === 'a')!.transitionOut).toBeUndefined();
  });

  it('carries the crossfadeAudio flag rather than assuming true', () => {
    // The flag is the user's choice to cut the audio while the picture transitions;
    // hard-coding `true` downstream silently discarded it.
    const plan = buildExportPlan(
      makeSettings({ items: twoClips({ crossfadeAudio: false }) as never }),
    );
    expect(plan.items.find((item) => item.itemId === 'b')!.transitionIn!.crossfadeAudio).toBe(
      false,
    );
  });

  it('links across a third clip in a chain', () => {
    // Each clip in the middle of a run leaves through one transition and arrives
    // through another; a mixer that only handled the leading pair would crossfade
    // the first cut and cut the rest.
    const items = twoClips();
    items.push({
      id: 'c', trackId: 'track-main', type: 'video', mediaId: 'media-c',
      startUs: 2_000_000, durationUs: 1_000_000, sourceInUs: 500_000, sourceDurationUs: 2_000_000,
      disabled: false, muted: false, hasAudio: true, trackOrder: 0,
      transitionIn: {
        type: 'crossfade', durationUs: 400_000, alignment: 'center',
        params: {}, easing: 'linear', crossfadeAudio: true,
      },
    } as never);
    const plan = buildExportPlan(makeSettings({ items: items as never }));
    const middle = plan.items.find((item) => item.itemId === 'b')!;
    expect(middle.transitionIn).toBeDefined();
    expect(middle.transitionOut).toBeDefined();
  });
});
