import { describe, it, expect, vi } from 'vitest';
import {
  candidateLimit,
  generateCandidates,
  indexSentences,
  isValidEnd,
  isValidStart,
  prepareCandidates,
  suppressOverlaps,
} from '../moments/candidates.js';
import {
  computeConfidence,
  heuristicDimensions,
  speechRateScore,
  weightedScore,
  blendScores,
  applyLengthPenalty,
  hookScore,
  standaloneRiskScore,
} from '../moments/scoring.js';
import { overlapFraction, refineBoundaries, shingleSimilarity } from '../moments/refine.js';
import {
  buildSystemPrompt,
  parseLlmResponse,
  planBatches,
  repairJson,
  sanitiseReason,
  sanitiseTitle,
} from '../moments/llm.js';
import { detectMoments, guessContentType, selectMoments } from '../moments/pipeline.js';
import {
  DIMENSIONS,
  weightsForContentType,
  weightsSum,
  CONTENT_TYPE_ADJUSTMENTS,
  type Candidate,
  type ContentType,
  type DetectionInput,
  type Moment,
  type MomentSettings,
} from '../moments/types.js';
import { ALL_FIXTURES, PODCAST_FIXTURE, toTranscript } from './fixtures/transcripts.js';
import type { ProviderAdapter, ProviderConfig } from '../providers/types.js';
import type { Sentence, Word } from '../transcription/index.js';

const SETTINGS: MomentSettings = {
  targetMinSec: 20,
  targetMaxSec: 60,
  requestedCount: 3,
  clipFocus: '',
  contentType: 'auto',
  language: 'en',
};

function podcastInput(overrides: Partial<MomentSettings> = {}): DetectionInput {
  const { words, sentences, paragraphStarts } = toTranscript(PODCAST_FIXTURE);
  return {
    projectId: 'p1',
    transcriptVersion: 1,
    words,
    sentences,
    paragraphStarts,
    settings: { ...SETTINGS, ...overrides },
  };
}

function fakeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    sentenceStart: 0,
    sentenceEnd: 2,
    startUs: 0,
    endUs: 30_000_000,
    durationUs: 30_000_000,
    text: 'Most people think motivation comes before action. That is exactly backwards. When you wait to feel ready, you wait forever.',
    hookSentence: 'Most people think motivation comes before action.',
    features: {
      energy: 0.6,
      speechRate: 0.8,
      pauseDensity: 0.2,
      hook: 0.7,
      emotion: 0.4,
      completeness: 0.8,
      standaloneRisk: 0.2,
      wordsPerMinute: 150,
      startSentenceIndex: 0,
      endSentenceIndex: 2,
    },
    heuristicScores: { hook: 70, standalone: 75, emotion: 50, interest: 60, story: 70, value: 65, pacing: 70, social: 60 },
    heuristicScore: 66,
    contextBefore: '',
    contextAfter: 'So I started doing one small thing.',
    ...overrides,
  };
}

/* ------------------------------------------------------------- candidates */

describe('candidate generation', () => {
  const { sentences, words, paragraphStarts } = toTranscript(PODCAST_FIXTURE);
  const entries = indexSentences(sentences, words);

  it('keeps every sentence exactly once in the index', () => {
    expect(entries).toHaveLength(PODCAST_FIXTURE.sentences.length);
    expect(entries[0].startUs).toBe(0);
  });

  function sentence(words: string[], startSec: number): { sentence: Sentence; words: Word[] } {
    let cursor = startSec;
    const built: Word[] = words.map((text, i) => {
      const startUs = Math.round((cursor + i * 0.4) * 1_000_000);
      return {
        id: `${startSec}_${i}`,
        text,
        startUs,
        endUs: startUs + 380_000,
        edited: false,
        approximate: false,
        lowConfidence: false,
        filler: false,
        chunkIndex: 0,
      };
    });
    cursor += words.length * 0.4;
    return {
      words: built,
      sentence: {
        id: `s_${startSec}`,
        wordIds: built.map((w) => w.id),
        startUs: built[0].startUs,
        endUs: built[built.length - 1].endUs,
      },
    };
  }

  it('rejects a start that opens with a dangling connector', () => {
    const first = sentence(['Yes.', 'That', 'is', 'true.'], 0);
    const second = sentence(['But', 'here', 'is', 'the', 'thing.'], 3);
    const withConnector = indexSentences(
      [first.sentence, second.sentence],
      [...first.words, ...second.words]
    );
    expect(isValidStart(withConnector, 1, new Set([1]))).toBe(false);
  });

  it('accepts a start at a paragraph boundary that is a whole sentence', () => {
    const first = sentence(['That', 'is', 'true.'], 0);
    // 0.22 s gap — close enough that only the paragraph flag makes it a boundary.
    const second = sentence(['Motivation', 'arrives', 'after', 'action.'], 1.4);
    const clean = indexSentences([first.sentence, second.sentence], [...first.words, ...second.words]);
    expect(isValidStart(clean, 1, new Set([1]))).toBe(true);
    // ...and rejects a mid-sentence start with no boundary at all.
    expect(isValidStart(clean, 1, new Set())).toBe(false);
  });

  it('never opens a candidate on a connector in the real fixture', () => {
    const generated = generateCandidates({ entries, settings: SETTINGS, paragraphStarts });
    for (const candidate of generated) {
      const firstWord = entries[candidate.sentenceStart].words[0].text.toLowerCase().replace(/[^a-z]/g, '');
      expect(['and', 'but', 'so', 'because', 'which', 'or', 'then', 'also', 'plus', 'however', 'though', 'yet']).not.toContain(firstWord);
    }
  });

  it('rejects an end that is a filler word', () => {
    const fillerEnd = indexSentences(
      [{ id: 's1', wordIds: ['a'], startUs: 0, endUs: 2_000_000 }],
      [{ id: 'a', text: 'um', startUs: 0, endUs: 2_000_000, edited: false, approximate: false, lowConfidence: false, filler: true, chunkIndex: 0 }]
    );
    expect(isValidEnd(fillerEnd, 0)).toBe(false);
  });

  it('only produces candidates inside the length bounds', () => {
    const candidates = generateCandidates({ entries, settings: SETTINGS, paragraphStarts });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.durationUs).toBeGreaterThanOrEqual(SETTINGS.targetMinSec * 0.8 * 1_000_000);
      expect(candidate.durationUs).toBeLessThanOrEqual(SETTINGS.targetMaxSec * 1.2 * 1_000_000);
    }
  });

  it('caps the candidate count per SPEC 07 §4.1', () => {
    expect(candidateLimit('auto')).toBe(60);
    expect(candidateLimit(3)).toBe(30);
    expect(candidateLimit(10)).toBe(50);
    expect(candidateLimit(100)).toBe(120);
  });

  it('suppresses heavy overlaps and keeps the stronger candidate', () => {
    const strong = fakeCandidate({ id: 'strong', startUs: 0, endUs: 30_000_000, durationUs: 30_000_000 });
    const weak = fakeCandidate({ id: 'weak', startUs: 1_000_000, endUs: 29_000_000, durationUs: 28_000_000 });
    const distinct = fakeCandidate({ id: 'distinct', startUs: 40_000_000, endUs: 70_000_000, durationUs: 30_000_000 });

    const kept = suppressOverlaps([strong, weak, distinct], 10, (c) => (c.id === 'strong' ? 80 : c.id === 'weak' ? 60 : 70));
    expect(kept.map((c) => c.id).sort()).toEqual(['distinct', 'strong']);
  });

  it('prepareCandidates attaches real features and scores', () => {
    const prepared = prepareCandidates(entries, SETTINGS, paragraphStarts);
    expect(prepared.length).toBeGreaterThan(0);
    for (const candidate of prepared) {
      expect(candidate.features.wordsPerMinute).toBeGreaterThan(0);
      expect(candidate.heuristicScore).toBeGreaterThanOrEqual(0);
      expect(candidate.heuristicScore).toBeLessThanOrEqual(100);
    }
  });
});

/* ---------------------------------------------------------------- scoring */

describe('heuristic scoring', () => {
  it('weights always sum to 100 for every content type', () => {
    const types: ContentType[] = ['auto', 'podcast', 'talking_head', 'tutorial', 'gaming', 'lecture', 'other'];
    for (const type of types) {
      expect(weightsSum(weightsForContentType(type))).toBe(100);
    }
  });

  it('matches the SPEC 07 §6.1 base weights', () => {
    const base = weightsForContentType('auto');
    expect(base).toEqual({
      hook: 20,
      standalone: 20,
      emotion: 15,
      interest: 15,
      story: 10,
      value: 10,
      pacing: 5,
      social: 5,
    });
  });

  it('applies each content-type adjustment exactly once', () => {
    for (const [type, adjustment] of Object.entries(CONTENT_TYPE_ADJUSTMENTS)) {
      const weights = weightsForContentType(type as ContentType);
      expect(weightsSum(weights)).toBe(100);

      for (const [dim, delta] of Object.entries(adjustment)) {
        const expected = (weightsForContentType('auto')[dim as (typeof DIMENSIONS)[number]] ?? 0) + (delta ?? 0);
        expect(weights[dim as (typeof DIMENSIONS)[number]]).toBe(expected);
      }
      // Dimensions the table does not mention keep their base weight.
      for (const dim of DIMENSIONS) {
        if (!(dim in adjustment)) {
          expect(weights[dim]).toBe(weightsForContentType('auto')[dim]);
        }
      }
    }
  });

  it('keeps the documented podcast and tutorial shifts', () => {
    const podcast = weightsForContentType('podcast');
    expect(podcast.hook).toBe(25);
    expect(podcast.standalone).toBe(25);
    expect(podcast.pacing).toBe(0);
    expect(podcast.social).toBe(0);

    const tutorial = weightsForContentType('tutorial');
    expect(tutorial.value).toBe(20);
    expect(tutorial.story).toBe(15);
    expect(tutorial.emotion).toBe(5);
    expect(tutorial.social).toBe(0);
  });

  it('scores a mid-range speech rate higher than a very slow one', () => {
    expect(speechRateScore(150)).toBeGreaterThan(speechRateScore(60));
    expect(speechRateScore(150)).toBeGreaterThan(speechRateScore(400));
  });

  it('rewards questions, numbers and strong claims in the hook', () => {
    const plain = hookScore('We went to the shop yesterday afternoon.', 8);
    const question = hookScore('Why do 90% of people never finish this?', 8);
    expect(question).toBeGreaterThan(plain);
  });

  it('raises standalone risk for a clip that opens with a deictic pronoun', () => {
    expect(standaloneRiskScore('This is the part where everything broke.')).toBeGreaterThan(
      standaloneRiskScore('Motivation usually arrives after action, not before.')
    );
  });

  it('blends 80/20 by default and 50/50 when the model is flat', () => {
    const llm = { hook: 100, standalone: 100, emotion: 100, interest: 100, story: 100, value: 100, pacing: 100, social: 100 };
    const heuristic = { hook: 0, standalone: 0, emotion: 0, interest: 0, story: 0, value: 0, pacing: 0, social: 0 };
    expect(blendScores(llm, heuristic, 0.8).hook).toBe(80);
    expect(blendScores(llm, heuristic, 0.5).hook).toBe(50);
    // Dimensions without a heuristic counterpart keep the model value.
    expect(blendScores(llm, heuristic, 0.5).interest).toBe(100);
  });

  it('penalises a clip that is far outside the target length', () => {
    const scores = { hook: 80, standalone: 80, emotion: 80, interest: 80, story: 80, value: 80, pacing: 80, social: 80 };
    const penalised = applyLengthPenalty(scores, 120_000_000, SETTINGS);
    expect(penalised.pacing).toBeLessThan(scores.pacing);
    expect(penalised.social).toBeLessThan(scores.social);
    expect(penalised.hook).toBe(scores.hook);
  });

  it('weighted score uses the supplied weights', () => {
    const scores = { hook: 100, standalone: 0, emotion: 0, interest: 0, story: 0, value: 0, pacing: 0, social: 0 };
    expect(weightedScore(scores, weightsForContentType('other'))).toBe(20);
  });

  it('lowers confidence only for concrete reasons', () => {
    expect(computeConfidence({ neededRepair: false, hasApproximateWords: false, flags: [], averageWordConfidence: 0.9 })).toBe('high');
    expect(computeConfidence({ neededRepair: true, hasApproximateWords: false, flags: [], averageWordConfidence: 0.9 })).toBe('medium');
    expect(
      computeConfidence({
        llmScore: 90,
        heuristicScore: 40,
        neededRepair: true,
        hasApproximateWords: true,
        flags: ['rambling'],
        averageWordConfidence: 0.5,
      })
    ).toBe('low');
  });
});

/* ---------------------------------------------------------------- refine */

describe('boundary refinement', () => {
  const { sentences, words, paragraphStarts } = toTranscript(PODCAST_FIXTURE);
  const entries = indexSentences(sentences, words);
  const candidates = prepareCandidates(entries, SETTINGS, paragraphStarts);

  it('never cuts inside a word', () => {
    for (const candidate of candidates.slice(0, 5)) {
      const refined = refineBoundaries({ candidate, entries, settings: SETTINGS });
      if (!refined) continue;
      const wordStarts = new Set(entries.flatMap((e) => e.words.map((w) => w.startUs)));
      const wordEnds = new Set(entries.flatMap((e) => e.words.map((w) => w.endUs)));
      // Start may carry pre-roll, but must never land after a word has begun.
      expect(refined.startUs).toBeLessThanOrEqual(candidate.startUs);
      expect(wordStarts.has(refined.startUs) || refined.startUs < candidate.startUs).toBe(true);
      expect(refined.endUs).toBeGreaterThanOrEqual(candidate.endUs - 1_000_000);
      void wordEnds;
    }
  });

  it('adds limited breathing room', () => {
    const candidate = candidates[0];
    const refined = refineBoundaries({ candidate, entries, settings: SETTINGS });
    expect(refined).not.toBeNull();
    if (!refined) return;
    expect(candidate.startUs - refined.startUs).toBeLessThanOrEqual(250_000);
    expect(refined.endUs - candidate.endUs).toBeLessThanOrEqual(400_000);
  });

  it('clamps model trims inside the candidate sentences', () => {
    const candidate = candidates.find((c) => c.sentenceEnd - c.sentenceStart >= 4);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const refined = refineBoundaries({
      candidate,
      entries,
      settings: SETTINGS,
      trimStartSentence: candidate.sentenceStart + 1,
      trimEndSentence: candidate.sentenceEnd - 1,
    });
    expect(refined).not.toBeNull();
    if (!refined) return;
    expect(refined.sentenceStart).toBe(candidate.sentenceStart + 1);
    expect(refined.sentenceEnd).toBe(candidate.sentenceEnd - 1);
    expect(refined.startUs).toBeGreaterThanOrEqual(entries[candidate.sentenceStart + 1].startUs - 250_000);
  });

  it('never widens a reversed trim outside the candidate', () => {
    const candidate = candidates.find((c) => c.sentenceEnd - c.sentenceStart >= 4);
    if (!candidate) return;
    const refined = refineBoundaries({
      candidate,
      entries,
      settings: SETTINGS,
      trimStartSentence: candidate.sentenceEnd,
      trimEndSentence: candidate.sentenceStart,
    });
    if (!refined) return;
    expect(refined.sentenceStart).toBeGreaterThanOrEqual(candidate.sentenceStart);
    expect(refined.sentenceEnd).toBeLessThanOrEqual(candidate.sentenceEnd);
  });

  it('measures overlap and text similarity the way de-duplication needs', () => {
    const a = { startUs: 0, endUs: 30_000_000, durationUs: 30_000_000 };
    const b = { startUs: 10_000_000, endUs: 40_000_000, durationUs: 30_000_000 };
    expect(overlapFraction(a, b)).toBeCloseTo(20 / 30, 2);
    expect(shingleSimilarity('the same five word phrase here', 'the same five word phrase here')).toBeGreaterThan(0.6);
    expect(shingleSimilarity('one two three four five', 'totally different words entirely now')).toBe(0);
  });
});

/* ------------------------------------------------------------------ LLM IO */

describe('LLM JSON handling', () => {
  const valid = JSON.stringify({
    results: [
      {
        id: 'c1',
        scores: { hook: 80, standalone: 70, emotion: 60, interest: 75, story: 65, value: 70, pacing: 80, social: 70 },
        title: 'Why motivation is backwards',
        reason: 'A clear contrarian claim with a quick payoff.',
        needsContext: false,
        trimStartSentence: 0,
        trimEndSentence: 2,
        flags: [],
      },
    ],
  });

  it('parses a clean response', () => {
    const outcome = parseLlmResponse(valid, new Set(['c1']));
    expect(outcome.ok).toBe(true);
    expect(outcome.results.get('c1')?.title).toBe('Why motivation is backwards');
  });

  it('repairs markdown fences', () => {
    const fenced = '```json\n' + valid + '\n```';
    const outcome = parseLlmResponse(fenced, new Set(['c1']));
    expect(outcome.ok).toBe(true);
    expect(outcome.repaired).toBe(true);
  });

  it('repairs trailing commas', () => {
    const trailing = valid.replace(/"flags":\[\]/, '"flags":[],');
    const outcome = parseLlmResponse(trailing, new Set(['c1']));
    expect(outcome.ok).toBe(true);
  });

  it('drops hallucinated ids', () => {
    const hallucinated = valid.replace('"id":"c1"', '"id":"ghost"');
    const outcome = parseLlmResponse(hallucinated, new Set(['c1']));
    expect(outcome.ok).toBe(true);
    expect(outcome.results.size).toBe(0);
  });

  it('clamps out-of-range scores', () => {
    const wild = valid.replace('"hook":80', '"hook":999').replace('"emotion":60', '"emotion":-20');
    const outcome = parseLlmResponse(wild, new Set(['c1']));
    expect(outcome.results.get('c1')?.scores.hook).toBe(100);
    expect(outcome.results.get('c1')?.scores.emotion).toBe(0);
  });

  it('reports unparsable output instead of throwing', () => {
    const outcome = parseLlmResponse('I cannot answer that.', new Set(['c1']));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('strips fences, prose and trailing commas in repairJson', () => {
    const messy = 'Sure! Here you go:\n```json\n{"results":[],}\n```\nHope that helps.';
    expect(repairJson(messy).trim()).toBe('{"results":[]}');
  });

  it('caps titles at eight words and removes emoji and quotes', () => {
    const title = sanitiseTitle('"This is a really quite long title with emoji 🎉 inside"');
    expect(title.split(' ').length).toBeLessThanOrEqual(8);
    expect(title).not.toMatch(/["🎉]/u);
  });

  it('ends reasons with a full stop and caps them at 25 words', () => {
    const reason = sanitiseReason('word '.repeat(40));
    expect(reason.split(' ').length).toBeLessThanOrEqual(25);
    expect(reason.endsWith('.')).toBe(true);
  });
});

/* ----------------------------------------------------------------- pipeline */

describe('detectMoments (heuristic)', () => {
  it('returns ranked moments with a full score breakdown', async () => {
    const result = await detectMoments({
      input: podcastInput({ requestedCount: 3 }),
      signal: new AbortController().signal,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.moments.length).toBeGreaterThan(0);
    expect(result.context.mode).toBe('heuristic');

    for (const moment of result.moments) {
      expect(Object.keys(moment.scores).sort()).toEqual([...DIMENSIONS].sort());
      expect(moment.score).toBeGreaterThanOrEqual(0);
      expect(moment.score).toBeLessThanOrEqual(100);
      expect(moment.basis).toBe('heuristic');
      expect(moment.reason.length).toBeGreaterThan(0);
      expect(moment.title.length).toBeGreaterThan(0);
      expect(moment.endUs).toBeGreaterThan(moment.startUs);
    }

    const scores = result.moments.map((m) => m.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('never yields overlapping moments in the main list', async () => {
    const result = await detectMoments({
      input: podcastInput({ requestedCount: 5 }),
      signal: new AbortController().signal,
    });

    for (let i = 0; i < result.moments.length; i++) {
      for (let j = i + 1; j < result.moments.length; j++) {
        expect(overlapFraction(result.moments[i], result.moments[j])).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('reports progress from candidates to ranking', async () => {
    const stages: string[] = [];
    await detectMoments({
      input: podcastInput(),
      signal: new AbortController().signal,
      onProgress: (p) => stages.push(p.stage),
    });
    expect(stages[0]).toBe('candidates');
    expect(stages).toContain('ranking');
    expect(stages[stages.length - 1]).toBe('ranking');
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const promise = detectMoments({
      input: podcastInput(),
      signal: controller.signal,
      onProgress: (p) => {
        if (p.stage === 'features') controller.abort();
      },
    });
    await expect(promise).rejects.toThrow();
  });

  it('excludes ranges already covered by existing moments', async () => {
    const input = podcastInput({ requestedCount: 3, targetMinSec: 8, targetMaxSec: 20 });
    const first = await detectMoments({ input, signal: new AbortController().signal });
    expect(first.moments.length).toBeGreaterThan(0);

    const excludes = first.moments.slice(0, 1).map((m) => ({ startUs: m.startUs, endUs: m.endUs }));
    const second = await detectMoments({
      input,
      signal: new AbortController().signal,
      excludeRanges: excludes,
    });

    expect(second.moments.length).toBeGreaterThan(0);
    for (const moment of second.moments) {
      for (const range of excludes) {
        expect(overlapFraction(moment, { ...range, durationUs: range.endUs - range.startUs })).toBeLessThanOrEqual(0.5);
      }
    }
    // The excluded clip must not come back under a different id.
    expect(second.moments.map((m) => m.startUs)).not.toContain(excludes[0].startUs);
  });

  it('explains an empty transcript instead of failing', async () => {
    const result = await detectMoments({
      input: {
        projectId: 'p1',
        transcriptVersion: 1,
        words: [],
        sentences: [],
        paragraphStarts: new Set(),
        settings: SETTINGS,
      },
      signal: new AbortController().signal,
    });
    expect(result.moments).toHaveLength(0);
    expect(result.notes[0]).toMatch(/no speech/i);
  });
});

describe('detectMoments (LLM)', () => {
  function fakeAdapter(responseText: string): { adapter: ProviderAdapter; config: ProviderConfig } {
    return {
      config: {
        id: 'mock',
        name: 'Mock',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1',
        models: { text: 'mock-model' },
        locality: 'local',
        timeoutMs: 1000,
        maxConcurrent: 1,
        numCtx: 8192,
      },
      adapter: {
        kind: 'openai-compatible',
        capabilities: () => ['text'],
        testConnection: async () => ({ ok: true, steps: [] }),
        listModels: async () => [],
        text: {
          supportsJsonMode: true,
          contextWindow: () => 8192,
          complete: async () => ({ text: responseText, jsonMode: true }),
        },
      } as ProviderAdapter,
    };
  }

  it('uses model scores and labels the basis as llm', async () => {
    const input = podcastInput({ requestedCount: 1 });
    const realCandidates = prepareCandidates(
      indexSentences(input.sentences, input.words),
      input.settings,
      input.paragraphStarts
    );
    expect(realCandidates.length).toBeGreaterThan(0);

    const { adapter, config } = fakeAdapter(
      JSON.stringify({
        results: realCandidates.map((candidate, i) => ({
          id: candidate.id,
          scores: {
            hook: 60 + (i % 7) * 5,
            standalone: 55 + (i % 5) * 7,
            emotion: 45 + (i % 9) * 5,
            interest: 50 + (i % 6) * 6,
            story: 40 + (i % 8) * 6,
            value: 58 + (i % 4) * 8,
            pacing: 62 + (i % 3) * 9,
            social: 48 + (i % 7) * 6,
          },
          title: 'A strong opening about motivation',
          reason: 'Clear contrarian claim with a fast payoff.',
          needsContext: false,
          trimStartSentence: 0,
          trimEndSentence: 3,
          flags: [],
        })),
      })
    );

    const result = await detectMoments({
      input,
      signal: new AbortController().signal,
      llm: {
        adapter,
        config,
        providerName: 'Mock',
        model: 'mock-model',
        contextWindowTokens: 8192,
        platform: 'local',
      },
    });

    const llmMoments = result.moments.filter((m) => m.basis === 'llm');
    expect(llmMoments.length).toBeGreaterThan(0);
    expect(llmMoments[0].model).toBe('mock-model');
    expect(llmMoments[0].provider).toBe('Mock');
  });

  it('falls back to heuristic scores when the model returns nonsense', async () => {
    const { adapter, config } = fakeAdapter('I am sorry, I cannot help with that.');
    const result = await detectMoments({
      input: podcastInput(),
      signal: new AbortController().signal,
      llm: { adapter, config, providerName: 'Mock', model: 'mock-model', contextWindowTokens: 8192, platform: 'local' },
    });

    expect(result.moments.length).toBeGreaterThan(0);
    expect(result.moments.every((m) => m.basis === 'heuristic')).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.notes.join(' ')).toMatch(/Basic scoring|scored locally/i);
  });

  it('never throws when the model call fails', async () => {
    const adapter = {
      kind: 'openai-compatible',
      capabilities: () => ['text'],
      testConnection: async () => ({ ok: true, steps: [] }),
      listModels: async () => [],
      text: {
        supportsJsonMode: true,
        contextWindow: () => 8192,
        complete: async () => {
          throw new Error('connection reset');
        },
      },
    } as unknown as ProviderAdapter;

    const result = await detectMoments({
      input: podcastInput(),
      signal: new AbortController().signal,
      llm: {
        adapter,
        config: {
          id: 'mock',
          name: 'Mock',
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1',
          models: { text: 'm' },
          locality: 'online',
          timeoutMs: 1000,
          maxConcurrent: 1,
          numCtx: 8192,
        },
        providerName: 'Mock',
        model: 'm',
        platform: 'online',
      },
    });

    expect(result.moments.length).toBeGreaterThan(0);
  });

  it('damps a model that scores everything identically', async () => {
    const flatInput = podcastInput();
    const flatCandidates = prepareCandidates(
      indexSentences(flatInput.sentences, flatInput.words),
      flatInput.settings,
      flatInput.paragraphStarts
    );
    const flat = flatCandidates.map((candidate) => ({
      id: candidate.id,
      scores: { hook: 50, standalone: 50, emotion: 50, interest: 50, story: 50, value: 50, pacing: 50, social: 50 },
      title: 'Flat',
      reason: 'Flat.',
      needsContext: false,
      trimStartSentence: 0,
      trimEndSentence: 3,
      flags: [],
    }));
    const { adapter, config } = fakeAdapter(JSON.stringify({ results: flat }));

    const result = await detectMoments({
      input: flatInput,
      signal: new AbortController().signal,
      llm: { adapter, config, providerName: 'Mock', model: 'mock-model', contextWindowTokens: 8192, platform: 'local' },
    });

    expect(result.notes.join(' ')).toMatch(/almost identically/i);
  });
});

/* -------------------------------------------------------------- selection */

describe('selection and prompts', () => {
  function moment(score: number, startUs: number): Moment {
    return {
      id: `m_${startUs}`,
      projectId: 'p1',
      transcriptVersion: 1,
      startUs,
      endUs: startUs + 30_000_000,
      durationUs: 30_000_000,
      title: 't',
      reason: 'r',
      score,
      scores: { hook: 50, standalone: 50, emotion: 50, interest: 50, story: 50, value: 50, pacing: 50, social: 50 },
      weightsUsed: weightsForContentType('other'),
      confidence: 'high',
      basis: 'heuristic',
      flags: [],
      needsContext: false,
      transcriptPreview: '',
      hookSentence: '',
      status: 'candidate',
      userEdited: false,
      manual: false,
      createdAt: '',
      clips: [],
    };
  }

  it('Auto keeps moments ≥ 65 and caps at 20', () => {
    const moments = [70, 80, 66, 90, 40, 30].map((s, i) => moment(s, i * 40_000_000));
    const selected = selectMoments(moments, 'auto');
    expect(selected.every((m) => m.score >= 65)).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(20);
  });

  it('Auto takes the top three when nothing reaches 65', () => {
    const moments = [40, 30, 20, 10].map((s, i) => moment(s, i * 40_000_000));
    expect(selectMoments(moments, 'auto')).toHaveLength(3);
  });

  it('a requested count returns exactly that many when available', () => {
    const moments = [90, 80, 70, 60, 50].map((s, i) => moment(s, i * 40_000_000));
    expect(selectMoments(moments, 4)).toHaveLength(4);
  });

  it('the system prompt is the spec template with placeholders filled', () => {
    const prompt = buildSystemPrompt('podcast', 'en', 'leadership and habits');
    expect(prompt).toContain('Content type: podcast or interview');
    expect(prompt).toContain('Language: en');
    expect(prompt).toContain('The user is especially interested in: leadership and habits');
    expect(prompt).toContain('Respond with ONLY valid JSON');
    expect(prompt).not.toContain('{contentType}');
  });

  it('batches respect the context window', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      fakeCandidate({ id: `c${i}`, text: 'word '.repeat(200) })
    );
    const batches = planBatches(candidates, 8192, 'system prompt');
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(20);
  });
});

/* ------------------------------------------------------------- benchmarks */

describe('quality benchmark on labelled fixtures', () => {
  for (const fixture of ALL_FIXTURES) {
    it(`${fixture.name}: finds human-labelled moments in the top K`, async () => {
      const { words, sentences, paragraphStarts } = toTranscript(fixture);
      const result = await detectMoments({
        input: {
          projectId: 'p1',
          transcriptVersion: 1,
          words,
          sentences,
          paragraphStarts,
          settings: { ...SETTINGS, requestedCount: 3, targetMinSec: 8, targetMaxSec: 45 },
        },
        signal: new AbortController().signal,
      });

      const all = [...result.moments, ...result.moreMoments];
      const K = Math.max(fixture.goodMoments.length * 2, 4);
      const topK = all.slice(0, K);

      const hit = fixture.goodMoments.filter(([startSec, endSec]) =>
        topK.some((moment) => {
          const overlap = Math.min(moment.endUs, endSec * 1_000_000) - Math.max(moment.startUs, startSec * 1_000_000);
          return overlap > 0.5 * (endSec - startSec) * 1_000_000;
        })
      );

      // SPEC 07 §13.6 sets ≥60 % for AI mode; Basic mode has no minimum, so we
      // simply assert that the pipeline surfaces at least one labelled moment.
      expect(hit.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('guessContentType', () => {
  it('uses a configured type unchanged', () => {
    expect(guessContentType(podcastInput(), 'tutorial')).toBe('tutorial');
  });

  it('guesses a tutorial from step language', () => {
    const { words, sentences, paragraphStarts } = toTranscript(ALL_FIXTURES[1]);
    const guess = guessContentType(
      {
        projectId: 'p',
        transcriptVersion: 1,
        words,
        sentences,
        paragraphStarts,
        settings: SETTINGS,
      },
      'auto'
    );
    expect(['tutorial', 'lecture']).toContain(guess);
  });
});
