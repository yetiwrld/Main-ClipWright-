import { describe, test, expect } from 'vitest';
import { parseFasterWhisperJson } from '../src/faster-whisper-parse.js';

describe('parseFasterWhisperJson', () => {
  test('word timestamps are converted to microseconds and keep probability', () => {
    const raw = {
      language: 'en',
      segments: [
        {
          start: 0, end: 2, text: ' Hello world ',
          words: [
            { word: ' Hello', start: 0.1, end: 0.6, probability: 0.97 },
            { word: ' world', start: 0.7, end: 1.4, probability: 0.88 },
          ],
        },
      ],
    };
    let i = 0;
    const parsed = parseFasterWhisperJson(raw, () => `id-${++i}`);
    expect(parsed.approximate).toBe(false);
    expect(parsed.language).toBe('en');
    expect(parsed.words.map((w) => w.text)).toEqual(['Hello', 'world']);
    expect(parsed.words[0]!.startUs).toBe(100_000);
    expect(parsed.words[0]!.endUs).toBe(600_000);
    expect(parsed.words[0]!.confidence).toBeCloseTo(0.97);
    expect(parsed.words[1]!.startUs).toBe(700_000);
    expect(parsed.words.map((w) => w.index)).toEqual([0, 1]);
  });

  test('segments without word times fall back to proportional estimates flagged approximate', () => {
    const raw = {
      segments: [{ start: 10, end: 12, text: 'one two three', words: [] }],
    };
    let i = 0;
    const parsed = parseFasterWhisperJson(raw, () => `id-${++i}`);
    expect(parsed.approximate).toBe(true);
    expect(parsed.words.map((w) => w.text)).toEqual(['one', 'two', 'three']);
    expect(parsed.words[0]!.startUs).toBe(10_000_000);
    expect(parsed.words[parsed.words.length - 1]!.endUs).toBeLessThanOrEqual(12_000_000);
  });

  test('segments without any timing basis are skipped, never faked', () => {
    const raw = {
      segments: [
        { start: 5, end: 4, text: 'phantom words here' },
        { start: 6, end: 7, text: 'kept', words: [{ word: 'kept', start: 6, end: 7, probability: 0.5 }] },
      ],
    };
    let i = 0;
    const parsed = parseFasterWhisperJson(raw, () => `id-${++i}`);
    expect(parsed.words.map((w) => w.text)).toEqual(['kept']);
    expect(parsed.approximate).toBe(true);
  });

  test('empty speech yields zero words and no error', () => {
    let i = 0;
    const parsed = parseFasterWhisperJson({ segments: [] }, () => `id-${++i}`);
    expect(parsed.words).toEqual([]);
    expect(parsed.approximate).toBe(false);
  });

  test('confidence is clamped into [0, 1]', () => {
    const raw = {
      segments: [{ start: 0, end: 1, text: 'x', words: [{ word: 'x', start: 0, end: 1, probability: 7 }] }],
    };
    let i = 0;
    const parsed = parseFasterWhisperJson(raw, () => `id-${++i}`);
    expect(parsed.words[0]!.confidence).toBe(1);
  });

  test('malformed input throws (no silent garbage)', () => {
    let i = 0;
    expect(() => parseFasterWhisperJson({ nope: true }, () => `id-${++i}`)).toThrow();
  });
});
