import { describe, expect, it } from 'vitest';
import {
  AppSettingsSchema, CompositionSchema, MediaInfoSchema, ProjectSettingsSnapshotSchema,
  compositionDurationUs, defaultAppSettings, formatTimecode, frameFromUs, usFromFrame, newId,
} from '../src/index.js';

describe('time helpers', () => {
  it('converts frames and us both ways', () => {
    expect(usFromFrame(30, 30)).toBe(1_000_000);
    expect(frameFromUs(1_000_000, 30)).toBe(30);
    expect(formatTimecode(65_500_000, 30)).toBe('00:01:05:15');
  });
});

describe('ids', () => {
  it('creates unique uuidv7-shaped ids', () => {
    const a = newId(); const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('schemas', () => {
  it('parses default app settings', () => {
    const s = defaultAppSettings();
    expect(s.processingMode).toBe('automatic');
    expect(s.autoSaveSeconds).toBe(30);
  });

  it('keeps unknown fields on composition (forward compat)', () => {
    const comp = CompositionSchema.parse({
      id: 'c1', projectId: 'p1', name: 'Clip', createdAt: 1, updatedAt: 1,
      futureField: { nested: true },
    });
    expect((comp as Record<string, unknown>).futureField).toEqual({ nested: true });
  });

  it('parses media info with minimal input', () => {
    const info = MediaInfoSchema.parse({
      mediaId: 'm1', kind: 'video', durationUs: 10_000_000, sizeBytes: 123,
      video: { codec: 'h264', width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, fps: 29.97 },
    });
    expect(info.video?.rotation).toBe(0);
    expect(info.audio).toEqual([]);
  });

  it('computes composition duration from items', () => {
    const comp = CompositionSchema.parse({
      id: 'c1', projectId: 'p1', name: 'Clip', createdAt: 1, updatedAt: 1,
      items: [
        { id: 'i1', trackId: 't1', kind: 'video', startUs: 0, durationUs: 5_000_000 },
        { id: 'i2', trackId: 't1', kind: 'video', startUs: 5_000_000, durationUs: 2_500_000 },
      ],
    });
    expect(compositionDurationUs(comp)).toBe(7_500_000);
  });

  it('rejects invalid settings values', () => {
    expect(() => AppSettingsSchema.parse({ autoSaveSeconds: 2 })).toThrow();
    expect(ProjectSettingsSnapshotSchema.parse({}).captionStyleId).toBe('bold-creator');
  });
});
