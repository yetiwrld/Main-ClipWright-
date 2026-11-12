import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@clipwright/project-schema';
import {
  autoSelect, blendDims, dedupe, generateCandidates, heuristicScoreCandidate,
  parseLlmResults, segmentSentences, shingleSimilarity, weightsFor, weightedTotal,
} from '../src/index.js';

const words = (texts: string[], gapUs = 100_000, wordDurUs = 250_000): TranscriptWord[] => {
  let t = 0;
  return texts.map((text, i) => {
    const w = { id: `w${i}`, index: i, text, startUs: t, endUs: t + wordDurUs };
    t += wordDurUs + gapUs;
    return w;
  });
};

describe('sentence segmentation', () => {
  it('splits on terminal punctuation', () => {
    const w = words(['Hello', 'world.', 'How', 'are', 'you?', 'Fine.']);
    const s = segmentSentences(w);
    expect(s).toHaveLength(3);
    expect(s[0]!.text).toBe('Hello world.');
    expect(s[1]!.text).toBe('How are you?');
  });
});

describe('candidate generation', () => {
  const longTranscript = [
    ...words(['Welcome', 'everyone', 'to', 'the', 'show.']),
    ...words(['Today', 'we', 'ask', 'why', 'nobody', 'talks', 'about', 'pricing.'], 600_000),
    ...words(['It', 'is', 'the', 'number', 'one', 'reason', 'startups', 'fail.']),
    ...words(['Let', 'me', 'explain', 'how', 'to', 'fix', 'it', 'step', 'by', 'step.']),
    ...words(['First', 'you', 'anchor', 'on', 'value.']),
    ...words(['Then', 'you', 'test', 'ten', 'price', 'points.']),
    ...words(['Finally', 'you', 'grandfather', 'your', 'early', 'customers.']),
    ...words(['That', 'is', 'the', 'whole', 'playbook.']),
  ];

  it('produces bounded candidates with valid ends', () => {
    const cands = generateCandidates(longTranscript, { minUs: 2_000_000, maxUs: 8_000_000, requestedCount: 3 });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.durationUs).toBeGreaterThanOrEqual(Math.round(2_000_000 * 0.8));
      expect(c.durationUs).toBeLessThanOrEqual(Math.round(8_000_000 * 1.2));
      expect(/[.!?]["')\]]?$/.test(c.text.trim())).toBe(true);
    }
  });
});

describe('scoring', () => {
  const w = words(['Why', 'do', 'nobody', 'tell', 'you', 'the', 'truth', 'about', 'pricing', 'mistakes?']);
  const cand = { id: 'c', sentenceStart: 0, sentenceEnd: 0, startUs: w[0]!.startUs, endUs: w[w.length - 1]!.endUs, durationUs: w[w.length - 1]!.endUs - w[0]!.startUs, text: w.map(x => x.text).join(' ') };

  it('heuristic produces 0-100 dimensions', () => {
    const f = heuristicScoreCandidate(cand, w);
    for (const k of ['hook', 'standalone', 'emotion', 'interest', 'story', 'value', 'pacing', 'social'] as const) {
      expect(f[k]).toBeGreaterThanOrEqual(0);
      expect(f[k]).toBeLessThanOrEqual(100);
    }
    expect(f.speechRateWpm).toBeGreaterThan(0);
  });

  it('weights always sum to 100, including content-type adjustments', () => {
    for (const ct of ['auto', 'podcast', 'talking-head', 'tutorial', 'gaming', 'lecture', 'other'] as const) {
      const weights = weightsFor(ct, false);
      expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    }
  });

  it('focus boost moves +5 to interest and renormalises to 100', () => {
    const plain = weightsFor('auto', false);
    const boosted = weightsFor('auto', true);
    expect(boosted.interest).toBeGreaterThan(plain.interest);
    expect(Object.values(boosted).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it('weightedTotal respects weights', () => {
    const weights = weightsFor('auto', false);
    const perfect = { hook: 100, standalone: 100, emotion: 100, interest: 100, story: 100, value: 100, pacing: 100, social: 100 };
    expect(weightedTotal(perfect, weights)).toBe(100);
  });

  it('blend uses 0.8 LLM / 0.2 heuristic on twin dimensions', () => {
    const llm = { hook: 80, standalone: 80, emotion: 80, interest: 10, story: 80, value: 10, pacing: 80, social: 10 };
    const heur = { hook: 40, standalone: 40, emotion: 40, interest: 90, story: 40, value: 90, pacing: 40, social: 90 };
    const blended = blendDims(llm, heur);
    expect(blended.hook).toBe(72);   // .8*80 + .2*40
    expect(blended.interest).toBe(10); // LLM only
    expect(blended.value).toBe(10);
  });
});

describe('dedupe & auto-select', () => {
  it('shingle similarity detects near-identical text', () => {
    const a = 'the quick brown fox jumps over the lazy dog and runs away fast today';
    const b = 'the quick brown fox jumps over the lazy dog and runs away fast now';
    expect(shingleSimilarity(a, b)).toBeGreaterThan(0.4);
    expect(shingleSimilarity(a, 'completely different words about cooking pasta tonight for dinner')).toBeLessThan(0.1);
  });

  it('dedupe drops time-overlapping lower-scored moments', () => {
    const moments = [
      { startUs: 0, endUs: 10_000_000, score: 90, text: 'aaaa' },
      { startUs: 1_000_000, endUs: 9_000_000, score: 70, text: 'bbbb' },
      { startUs: 20_000_000, endUs: 30_000_000, score: 60, text: 'cccc' },
    ];
    const kept = dedupe(moments, (m) => m.text);
    expect(kept.map((k) => k.score).sort()).toEqual([60, 90]);
  });

  it('autoSelect applies the 65 threshold with min 3 / max 20', () => {
    expect(autoSelect([{ score: 90 }, { score: 70 }])).toBe(3);
    expect(autoSelect(Array.from({ length: 25 }, () => ({ score: 80 })))).toBe(20);
    expect(autoSelect([...Array.from({ length: 5 }, () => ({ score: 70 })), { score: 10 }])).toBe(5);
  });
});

describe('LLM JSON handling', () => {
  it('parses valid results', () => {
    const raw = JSON.stringify({ results: [{ id: 'c-0-0', scores: { hook: 55, standalone: 60, emotion: 50, interest: 70, story: 40, value: 65, pacing: 75, social: 60 }, title: 'T', reason: 'R', needsContext: false, trimStartSentence: 0, trimEndSentence: 1, flags: [] }] });
    const { results, repaired } = parseLlmResults(raw);
    expect(results).toHaveLength(1);
    expect(repaired).toBe(false);
    expect(results[0]!.scores.hook).toBe(55);
  });

  it('repairs fenced JSON with trailing commas', () => {
    const raw = '```json\n{"results":[{"id":"c-0-0","scores":{"hook":55,"standalone":60,"emotion":50,"interest":70,"story":40,"value":65,"pacing":75,"social":60,},"title":"T","reason":"R","needsContext":false,"trimStartSentence":0,"trimEndSentence":1,"flags":["rambling",],},],}\n```';
    const { results, repaired } = parseLlmResults(raw);
    expect(repaired).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]!.flags).toEqual(['rambling']);
  });

  it('drops malformed entries and clamps out-of-range scores', () => {
    const raw = JSON.stringify({ results: [
      { id: 'ok', scores: { hook: 140, standalone: -5, emotion: 50, interest: 70, story: 40, value: 65, pacing: 75, social: 60 }, title: '', reason: '', needsContext: false, trimStartSentence: 0, trimEndSentence: 0, flags: [] },
      { id: 'bad', scores: { hook: 'lots' } },
    ] });
    const { results } = parseLlmResults(raw);
    expect(results).toHaveLength(1);
    expect(results[0]!.scores.hook).toBe(100);
    expect(results[0]!.scores.standalone).toBe(0);
  });

  it('throws on unrecoverable garbage so callers can fall back', () => {
    expect(() => parseLlmResults('not json at all')).toThrow();
  });
});

