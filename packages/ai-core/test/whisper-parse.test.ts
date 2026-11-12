import { describe, expect, it } from 'vitest';
import { parseWhisperJson, parseSubtitleFile } from '../src/index.js';

const ids = () => { let n = 0; return () => `w${n++}`; };

describe('parseWhisperJson', () => {
  it('parses one-word segments (layout A)', () => {
    const raw = { transcription: [
      { offsets: { from: 0, to: 500 }, text: ' Hello' },
      { offsets: { from: 500, to: 900 }, text: ' world' },
    ] };
    const { words, approximate } = parseWhisperJson(raw, ids());
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world']);
    expect(words[0]!.startUs).toBe(0);
    expect(words[1]!.startUs).toBe(500_000);
    expect(approximate).toBe(false);
  });

  it('parses token-offset layout', () => {
    const raw = { transcription: [
      { offsets: { from: 0, to: 1000 }, text: 'Hi there',
        tokens: [
          { text: '[_BEG_]', offsets: { from: 0, to: 100 } },
          { text: 'Hi', offsets: { from: 100, to: 400 }, p: 0.9 },
          { text: 'there', offsets: { from: 400, to: 1000 }, p: 0.8 },
        ] },
    ] };
    const { words } = parseWhisperJson(raw, ids());
    expect(words.map((w) => w.text)).toEqual(['Hi', 'there']);
    expect(words[0]!.confidence).toBe(0.9);
  });

  it('estimates times for segment-only output and flags approximate', () => {
    const raw = { transcription: [
      { offsets: { from: 1000, to: 3000 }, text: 'one two three' },
    ] };
    const { words, approximate } = parseWhisperJson(raw, ids());
    expect(approximate).toBe(true);
    expect(words).toHaveLength(3);
    expect(words[0]!.startUs).toBe(1_000_000);
    expect(words[2]!.endUs).toBeLessThanOrEqual(3_000_000);
  });

  it('never fabricates words from empty text', () => {
    const raw = { transcription: [{ offsets: { from: 0, to: 100 }, text: '   ' }] };
    expect(parseWhisperJson(raw, ids()).words).toHaveLength(0);
  });
});

describe('parseSubtitleFile', () => {
  it('parses SRT cues into approximate words', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
hello brave new world

2
00:00:04,000 --> 00:00:06,000
goodbye now
`;
    const { words, approximate } = parseSubtitleFile(srt, ids());
    expect(approximate).toBe(true);
    expect(words.map((w) => w.text)).toEqual(['hello', 'brave', 'new', 'world', 'goodbye', 'now']);
    expect(words[0]!.startUs).toBe(1_000_000);
    expect(words[4]!.startUs).toBeGreaterThanOrEqual(4_000_000);
  });
});
