/**
 * SPEC 07 §4.1 — Stage 1: turn sentences into candidate "thought units".
 *
 * A candidate is a contiguous run of sentences that starts somewhere a viewer
 * could join and ends somewhere a thought finishes. Everything here is pure and
 * deterministic so the same transcript always yields the same candidates.
 */

import type { Sentence, Word } from '../transcription/index.js';
import type { Candidate, MomentSettings, CandidateFeatures, DimensionScores } from './types.js';
import { computeFeatures, scoreCandidateHeuristically } from './scoring.js';

const DANGLING_CONNECTORS = new Set([
  'and', 'but', 'so', 'because', 'which', 'or', 'then', 'also', 'plus', 'however', 'though', 'yet',
]);

const CONTINUING_CLAUSES = /(,\s*$)|(\b(and|but|because|so|which|that|when|while|if)\s*$)/i;

export interface SentenceIndexEntry {
  index: number;
  sentence: Sentence;
  words: Word[];
  text: string;
  startUs: number;
  endUs: number;
  pausesBeforeUs: number;
}

/** Builds the per-sentence view the candidate generator needs. */
export function indexSentences(sentences: Sentence[], words: Word[]): SentenceIndexEntry[] {
  const byId = new Map(words.map((w) => [w.id, w]));
  const entries: SentenceIndexEntry[] = [];

  sentences.forEach((sentence, index) => {
    const sentenceWords = sentence.wordIds
      .map((id) => byId.get(id))
      .filter((w): w is Word => Boolean(w))
      .sort((a, b) => a.startUs - b.startUs);

    if (sentenceWords.length === 0) return;

    const startUs = sentenceWords[0].startUs;
    const endUs = sentenceWords[sentenceWords.length - 1].endUs;
    const previous = entries[entries.length - 1];
    const pausesBeforeUs = previous ? Math.max(0, startUs - previous.endUs) : 0;

    entries.push({
      index: entries.length,
      sentence,
      words: sentenceWords,
      text: sentenceWords.map((w) => w.text).join(' '),
      startUs,
      endUs,
      pausesBeforeUs,
    });
  });

  return entries;
}

export function isFillerWord(text: string): boolean {
  return /^(um|uh|er|ah|hmm|mm|hm|erm|like,|you know,?)$/i.test(text.trim());
}

/** SPEC 07 §4.1 step 3 — a valid start. */
export function isValidStart(
  entries: SentenceIndexEntry[],
  index: number,
  paragraphStarts: Set<number>
): boolean {
  const entry = entries[index];
  if (!entry) return false;

  const firstWord = entry.words[0]?.text.toLowerCase().replace(/[^a-z']/g, '') ?? '';
  const startsAtBoundary = index === 0 || paragraphStarts.has(index) || entry.pausesBeforeUs >= 500_000;

  if (DANGLING_CONNECTORS.has(firstWord)) {
    // Only acceptable when the previous sentence is included as well.
    return false;
  }

  return startsAtBoundary || index === 0;
}

/** SPEC 07 §4.1 step 3 — a valid end. */
export function isValidEnd(entries: SentenceIndexEntry[], index: number): boolean {
  const entry = entries[index];
  if (!entry) return false;

  const text = entry.text.trim();
  if (!text) return false;

  const lastWord = entry.words[entry.words.length - 1]?.text ?? '';
  if (isFillerWord(lastWord)) return false;

  if (CONTINUING_CLAUSES.test(text)) return false;

  if (!/[.!?…]"?$/.test(lastWord) && !/[.!?…]"?$/.test(text)) return false;

  const next = entries[index + 1];
  if (next && next.words[0]) {
    const gapUs = next.startUs - entry.endUs;
    const nextWord = next.words[0].text.toLowerCase();
    if (gapUs < 300_000 && /^(and|but|so|because|which|when|that|then)\b/.test(nextWord)) return false;
  }

  return true;
}

export interface GenerateCandidatesOptions {
  entries: SentenceIndexEntry[];
  settings: MomentSettings;
  paragraphStarts: Set<number>;
  maxCandidates?: number;
}

/**
 * Slides over valid starts, extending while under the maximum length, and keeps
 * runs that land on a valid end.
 */
export function generateCandidates(options: GenerateCandidatesOptions): Candidate[] {
  const { entries, settings, paragraphStarts } = options;
  const targetMinUs = settings.targetMinSec * 1_000_000;
  const targetMaxUs = settings.targetMaxSec * 1_000_000;
  const minUs = Math.max(2_000_000, targetMinUs * 0.8);
  const maxUs = targetMaxUs * 1.2;

  const candidates: Candidate[] = [];

  for (let start = 0; start < entries.length; start++) {
    if (!isValidStart(entries, start, paragraphStarts)) continue;

    const candidateStartUs = entries[start].startUs;

    for (let end = start; end < entries.length; end++) {
      const durationUs = entries[end].endUs - candidateStartUs;
      if (durationUs > maxUs) break;
      if (durationUs < minUs) continue;
      if (!isValidEnd(entries, end)) continue;

      const slice = entries.slice(start, end + 1);
      const text = slice.map((e) => e.text).join(' ');
      const hookSentence = slice[0].text;

      candidates.push({
        id: `cand_${start}_${end}`,
        sentenceStart: start,
        sentenceEnd: end,
        startUs: candidateStartUs,
        endUs: entries[end].endUs,
        durationUs,
        text,
        hookSentence,
        features: emptyFeatures(start, end),
        heuristicScores: zeroScores(),
        heuristicScore: 0,
        contextBefore: entries[start - 1]?.text ?? '',
        contextAfter: entries[end + 1]?.text ?? '',
      });
    }
  }

  return candidates;
}

function emptyFeatures(start: number, end: number): CandidateFeatures {
  return {
    energy: 0,
    speechRate: 0,
    pauseDensity: 0,
    hook: 0,
    emotion: 0,
    completeness: 0,
    standaloneRisk: 0,
    wordsPerMinute: 0,
    startSentenceIndex: start,
    endSentenceIndex: end,
  };
}

function zeroScores(): DimensionScores {
  return { hook: 0, standalone: 0, emotion: 0, interest: 0, story: 0, value: 0, pacing: 0, social: 0 };
}

/**
 * SPEC 07 §4.1 step 4 — non-maximum suppression so the pipeline never scores
 * dozens of near-identical windows.
 */
export function suppressOverlaps(
  candidates: Candidate[],
  limit: number,
  scoreOf: (candidate: Candidate) => number
): Candidate[] {
  const ranked = [...candidates].sort((a, b) => scoreOf(b) - scoreOf(a));
  const kept: Candidate[] = [];

  for (const candidate of ranked) {
    if (kept.length >= limit) break;
    const overlaps = kept.some((other) => {
      const overlapUs = Math.min(other.endUs, candidate.endUs) - Math.max(other.startUs, candidate.startUs);
      if (overlapUs <= 0) return false;
      const shorter = Math.min(other.durationUs, candidate.durationUs);
      return overlapUs / shorter > 0.5;
    });
    if (!overlaps) kept.push(candidate);
  }

  return kept.sort((a, b) => a.startUs - b.startUs);
}

/** Candidate cap from SPEC 07 §4.1 step 4. */
export function candidateLimit(requestedCount: number | 'auto'): number {
  if (requestedCount === 'auto') return 60;
  return Math.min(120, Math.max(30, Math.round(5 * requestedCount)));
}

/**
 * Convenience: generate, measure features, score cheaply, then suppress.
 * Features must exist before scoring — they are what the score is made of.
 */
export function prepareCandidates(
  entries: SentenceIndexEntry[],
  settings: MomentSettings,
  paragraphStarts: Set<number>,
  energyWindows?: number[]
): Candidate[] {
  const raw = generateCandidates({ entries, settings, paragraphStarts });
  computeFeatures(entries, raw, energyWindows);

  for (const candidate of raw) {
    const { scores, total } = scoreCandidateHeuristically(candidate, settings);
    candidate.heuristicScores = scores;
    candidate.heuristicScore = total;
  }

  return suppressOverlaps(raw, candidateLimit(settings.requestedCount), (c) => c.heuristicScore);
}
