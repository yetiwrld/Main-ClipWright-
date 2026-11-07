import { describe, it, expect } from 'vitest';
import { needsProxy } from '../media-pipeline.js';
import type { MediaInfo, VideoStreamInfo } from '@clipwright/media-core';

function videoStream(overrides: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    codec: 'h264',
    profile: 'High',
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    rotation: 0,
    sar: 1,
    dar: 1.7777,
    fps: 30,
    fpsMode: 'constant',
    pixFmt: 'yuv420p',
    colorSpace: 'bt709',
    hdr: false,
    bitDepth: 8,
    hasAlpha: false,
    ...overrides,
  };
}

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    mediaId: 'm1',
    kind: 'video',
    container: 'mov,mp4',
    durationUs: 60_000_000,
    sizeBytes: 100_000_000,
    bitrate: 8_000_000,
    video: videoStream(),
    audio: [{ index: 1, codec: 'aac', channels: 2, sampleRate: 48000, default: true }],
    metadata: {},
    ...overrides,
  };
}

describe('needsProxy', () => {
  it('skips a proxy for a 1080p H.264 constant-frame-rate source', () => {
    expect(needsProxy(media(), false)).toBe(false);
  });

  it('always creates a proxy when the setting is on', () => {
    expect(needsProxy(media(), true)).toBe(true);
  });

  it('creates a proxy above 1080p', () => {
    const hiRes = media({ video: videoStream({ width: 3840, height: 2160 }) });
    expect(needsProxy(hiRes, false)).toBe(true);
  });

  it('creates a proxy for codecs Chromium cannot decode reliably', () => {
    const proRes = media({ video: videoStream({ codec: 'prores' }) });
    expect(needsProxy(proRes, false)).toBe(true);

    const hevc = media({ video: videoStream({ codec: 'hevc' }) });
    expect(needsProxy(hevc, false)).toBe(true);
  });

  it('keeps VP9 and AV1 sources without a proxy', () => {
    expect(needsProxy(media({ video: videoStream({ codec: 'vp9' }) }), false)).toBe(false);
    expect(needsProxy(media({ video: videoStream({ codec: 'av1' }) }), false)).toBe(false);
  });

  it('creates a proxy for variable frame rate and HDR sources', () => {
    expect(needsProxy(media({ video: videoStream({ fpsMode: 'variable' }) }), false)).toBe(true);
    expect(needsProxy(media({ video: videoStream({ hdr: true }) }), false)).toBe(true);
  });

  it('returns false for audio-only media', () => {
    const audioOnly = media({ kind: 'audio', video: undefined });
    expect(needsProxy(audioOnly, false)).toBe(false);
  });
});
