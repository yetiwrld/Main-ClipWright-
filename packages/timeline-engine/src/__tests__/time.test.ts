import { describe, expect, it } from 'vitest';
import {
  formatTimecode,
  frameToUs,
  parseTimecode,
  quantizeDurationUs,
  quantizeUs,
  usToFrame,
} from '../time';

describe('frame grid', () => {
  it('round-trips frame indices at both project rates', () => {
    for (const fps of [30, 60] as const) {
      for (const frame of [0, 1, 29, 30, 59, 60, 1000, 108_000]) {
        expect(usToFrame(frameToUs(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it('quantises to the nearest frame and never goes negative', () => {
    expect(quantizeUs(0, 30)).toBe(0);
    expect(quantizeUs(-5_000, 30)).toBe(0);
    expect(quantizeUs(16_000, 30)).toBe(frameToUs(0, 30));
    expect(quantizeUs(17_000, 30)).toBe(frameToUs(1, 30));
    expect(quantizeUs(1_000_000, 30)).toBe(1_000_000);
  });

  it('rounds durations up to at least one frame', () => {
    expect(quantizeDurationUs(1, 30)).toBe(frameToUs(1, 30));
    expect(quantizeDurationUs(100_000, 30)).toBe(frameToUs(3, 30));
  });
});

describe('timecode', () => {
  it('formats HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(1_000_000, 30)).toBe('00:00:01:00');
    expect(formatTimecode(frameToUs(90 * 30 + 7, 30), 30)).toBe('00:01:30:07');
    expect(formatTimecode(3_600_000_000 + 61_000_000, 30)).toBe('01:01:01:00');
  });

  it('parses every documented entry format', () => {
    expect(parseTimecode('00:00:01:00', 30)?.us).toBe(1_000_000);
    expect(parseTimecode('MM:SS', 30)).toBeNull();
    expect(parseTimecode('1:30', 30)?.us).toBe(90_000_000);
    expect(parseTimecode('90', 30)?.us).toBe(90_000_000);
    expect(parseTimecode('130', 60)?.us).toBe(frameToUs(90, 60));
    expect(parseTimecode('130', 30)?.us).toBe(frameToUs(60, 30));
    expect(parseTimecode('00:01:30:15', 30)?.us).toBe(frameToUs(90 * 30 + 15, 30));
  });

  it('treats +30 and -12 as relative frames and clamps at zero', () => {
    const start = parseTimecode('00:00:02:00', 30)!.us;
    expect(parseTimecode('+30', 30, start)?.us).toBe(start + frameToUs(30, 30));
    expect(parseTimecode('-12', 30, 0)?.us).toBe(0);
    expect(parseTimecode('-12', 30, start)?.relative).toBe(true);
  });

  it('rejects nonsense instead of guessing', () => {
    expect(parseTimecode('abc', 30)).toBeNull();
    expect(parseTimecode('', 30)).toBeNull();
    expect(parseTimecode('00:00:00:99', 30)).toBeNull();
    expect(parseTimecode('00:99:00:00', 30)).toBeNull();
    expect(parseTimecode('1:2:3:4:5', 30)).toBeNull();
  });
});
