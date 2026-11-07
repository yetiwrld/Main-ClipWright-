import { describe, it, expect } from 'vitest';
import {
  planChunks,
  buildSentencesAndParagraphs,
  buildCaptions,
  exportTranscript,
  isFiller,
  type Word,
  type Transcript,
} from '../index.js';

function word(text: string, startUs: number, endUs: number, overrides: Partial<Word> = {}): Word {
  return {
    id: `w_${startUs}`,
    text,
    startUs,
    endUs,
    edited: false,
    approximate: false,
    lowConfidence: false,
    filler: isFiller(text),
    chunkIndex: 0,
    ...overrides,
  };
}

function words(spec: Array<[string, number, number]>): Word[] {
  return spec.map(([text, start, end]) => word(text, start * 1_000_000, end * 1_000_000));
}

describe('planChunks', () => {
  it('returns no chunks for an empty audio track', () => {
    expect(planChunks(0, 30)).toEqual([]);
  });

  it('covers the whole duration without gaps or overlaps', () => {
    const durationUs = 95 * 1_000_000;
    const chunks = planChunks(durationUs, 30);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].startUs).toBe(0);

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startUs).toBe(chunks[i - 1].endUs);
    }

    const last = chunks[chunks.length - 1];
    expect(last.endUs).toBe(durationUs);
    expect(last.durationUs).toBe(last.endUs - last.startUs);
  });

  it('assigns increasing chunk indexes and carries over prompt text', () => {
    const chunks = planChunks(60 * 1_000_000, 20, 'previous words');
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks[0].carryOverText).toBe('previous words');
  });

  it('handles a duration shorter than one chunk', () => {
    const chunks = planChunks(5 * 1_000_000, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startUs).toBe(0);
    expect(chunks[0].endUs).toBe(5 * 1_000_000);
  });
});

describe('buildSentencesAndParagraphs', () => {
  it('splits sentences on terminal punctuation', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['there.', 0.4, 0.8],
      ['How', 0.9, 1.2],
      ['are', 1.2, 1.4],
      ['you?', 1.4, 1.8],
    ]);
    const { sentences } = buildSentencesAndParagraphs(w);

    expect(sentences).toHaveLength(2);
    expect(sentences[0].wordIds).toHaveLength(2);
    expect(sentences[1].wordIds).toHaveLength(3);
    expect(sentences[0].endUs).toBe(800_000);
  });

  it('does not split on common abbreviations', () => {
    const w = words([
      ['Dr.', 0, 0.3],
      ['Smith', 0.3, 0.6],
      ['arrived', 0.6, 0.9],
      ['early.', 0.9, 1.2],
    ]);
    const { sentences } = buildSentencesAndParagraphs(w);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].wordIds).toHaveLength(4);
  });

  it('groups sentences into paragraphs that keep every sentence', () => {
    const w = words(
      Array.from({ length: 20 }, (_, i) => [`word${i}.`, i, i + 0.5] as [string, number, number])
    );
    const { sentences, paragraphs } = buildSentencesAndParagraphs(w);

    expect(sentences.length).toBe(20);
    const covered = paragraphs.flatMap((p) => p.sentenceIds);
    expect(covered).toHaveLength(sentences.length);
    expect(paragraphs.length).toBeLessThanOrEqual(sentences.length);
    expect(paragraphs[0].startUs).toBe(0);
  });

  it('returns empty structures for no words', () => {
    expect(buildSentencesAndParagraphs([])).toEqual({ sentences: [], paragraphs: [] });
  });
});

describe('buildCaptions', () => {
  const line = [
    ['This', 0, 0.3],
    ['is', 0.3, 0.5],
    ['a', 0.5, 0.6],
    ['short', 0.6, 0.9],
    ['caption', 0.9, 1.3],
  ] as Array<[string, number, number]>;

  it('emits ordered, non-overlapping captions that reference real words', () => {
    const w = words(line);
    const captions = buildCaptions(w, '9:16');

    expect(captions.length).toBeGreaterThan(0);
    for (let i = 1; i < captions.length; i++) {
      expect(captions[i].startUs).toBeGreaterThanOrEqual(captions[i - 1].startUs);
    }
    for (const c of captions) {
      expect(c.wordRefs.length).toBeGreaterThan(0);
      for (const ref of c.wordRefs) {
        expect(w.some((x) => x.id === ref.wordId)).toBe(true);
      }
      expect(c.lines.length).toBeLessThanOrEqual(2);
    }
  });

  it('enforces tighter line width for vertical formats than for widescreen', () => {
    const long =
      'this is a considerably longer spoken sentence that should wrap across several caption lines for testing';
    const w = long.split(' ').map((t, i) => word(t, i * 400_000, (i + 1) * 400_000));

    const vertical = buildCaptions(w, '9:16');
    const wide = buildCaptions(w, '16:9');

    const maxVertical = Math.max(...vertical.flatMap((c) => c.lines.map((l) => l.length)));
    const maxWide = Math.max(...wide.flatMap((c) => c.lines.map((l) => l.length)));

    expect(maxVertical).toBeLessThan(maxWide);
    expect(vertical.length).toBeGreaterThanOrEqual(wide.length);
  });

  it('marks captions as machine-generated, not manually edited', () => {
    const captions = buildCaptions(words(line), '1:1');
    for (const c of captions) {
      expect(c.manualTiming).toBe(false);
      expect(c.manualText).toBe(false);
    }
  });
});

describe('isFiller', () => {
  it('flags filler words and leaves content words alone', () => {
    expect(isFiller('um')).toBe(true);
    expect(isFiller('Uh,')).toBe(true);
    expect(isFiller('like')).toBe(true);
    expect(isFiller('caption')).toBe(false);
    expect(isFiller('')).toBe(false);
  });
});

describe('exportTranscript', () => {
  const w = words([
    ['Hello', 0, 0.5],
    ['world.', 0.5, 1.0],
    ['Second', 1.2, 1.6],
    ['line.', 1.6, 2.0],
  ]);
  const { sentences, paragraphs } = buildSentencesAndParagraphs(w);

  const transcript: Transcript = {
    id: 't1',
    mediaId: 'm1',
    language: 'en',
    languageConfidence: 0.99,
    engine: 'whisper-local',
    model: 'small.en',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    durationUs: 2_000_000,
    words: w,
    sentences,
    paragraphs,
    highlights: [],
  };

  it('writes plain text without timestamps', () => {
    const txt = exportTranscript(transcript, 'txt');
    expect(txt).toContain('Hello world.');
    expect(txt).toContain('Second line.');
    expect(txt).not.toContain('-->');
  });

  it('writes SRT with numbered cues and arrow timings', () => {
    const srt = exportTranscript(transcript, 'srt');
    expect(srt).toMatch(/^1\r?\n/);
    expect(srt).toContain('-->');
    expect(srt).toContain('Hello');
  });

  it('writes WebVTT with the required header', () => {
    const vtt = exportTranscript(transcript, 'vtt');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('-->');
  });

  it('round-trips JSON exports', () => {
    const json = exportTranscript(transcript, 'json');
    const parsed = JSON.parse(json) as Transcript;
    expect(parsed.words).toHaveLength(w.length);
    expect(parsed.id).toBe('t1');
  });

  it('orders timestamps chronologically in SRT output', () => {
    const srt = exportTranscript(transcript, 'srt');
    const times = [...srt.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g)];
    expect(times.length).toBeGreaterThan(0);
    for (const [, start, end] of times) {
      expect(end >= start).toBe(true);
    }
  });
});
