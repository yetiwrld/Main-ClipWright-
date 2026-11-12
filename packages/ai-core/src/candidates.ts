/**
 * Stage 1 — thought-unit candidate generation with valid start/end rules
 * and non-maximum suppression.
 */
import type { TranscriptWord, ContentType } from '@clipwright/project-schema';
import { segmentSentences, type Sentence } from './sentences.js';

export interface Candidate {
  id: string;
  sentenceStart: number;
  sentenceEnd: number;  // inclusive
  startUs: number;
  endUs: number;
  durationUs: number;
  text: string;
  targetWpmHint?: number;
}

const DANGLING_STARTERS = new Set(['and', 'but', 'so', 'because', 'which', 'or']);

export const candidateCap = (requestedCount: number | 'auto'): number => {
  if (requestedCount === 'auto') return 60;
  return Math.min(120, Math.max(30, 5 * requestedCount));
};

export const generateCandidates = (
  words: TranscriptWord[],
  opts: { minUs: number; maxUs: number; requestedCount: number | 'auto' },
): Candidate[] => {
  if (words.length === 0) return [];
  const sentences = segmentSentences(words);
  if (sentences.length === 0) return [];

  const minUs = opts.minUs;
  const maxUs = opts.maxUs;
  const lower = Math.round(opts.minUs * 0.8);
  const upper = Math.round(opts.maxUs * 1.2);

  const validStart = (si: number): boolean => {
    if (si === 0) return true;
    const sent = sentences[si]!;
    const prev = sentences[si - 1]!;
    // valid after a pause >= 0.5s, or at paragraph boundaries (we treat 1.2s as a paragraph break)
    if (sent.startUs - prev.endUs >= 500_000) return true;
    const firstWord = words[sent.wordIndexes[0]]!.text.toLowerCase().replace(/[^a-z]/g, '');
    if (DANGLING_STARTERS.has(firstWord)) return false;
    return true;
  };

  const validEnd = (si: number): boolean => {
    const text = sentences[si]!.text.trim();
    if (!/[.!?]["')\]]?$/.test(text)) return false;
    // not followed within 0.3s by a continuing clause
    const next = sentences[si + 1];
    if (next && next.startUs - sentences[si]!.endUs < 300_000) {
      const nextFirst = words[next.wordIndexes[0]]!.text.toLowerCase().replace(/[^a-z]/g, '');
      if (['and', 'but', 'so', 'because', 'which', 'or'].includes(nextFirst)) return false;
    }
    return true;
  };

  const candidates: Candidate[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (!validStart(i)) continue;
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j]!.endUs - sentences[i]!.startUs;
      if (dur > upper) break;
      if (dur >= lower && validEnd(j)) {
        candidates.push({
          id: `c-${i}-${j}`,
          sentenceStart: i,
          sentenceEnd: j,
          startUs: sentences[i]!.startUs,
          endUs: sentences[j]!.endUs,
          durationUs: dur,
          text: sentences.slice(i, j + 1).map((s) => s.text).join(' '),
        });
      }
    }
  }

  // If the count explodes, cap by cheap pre-score using heuristic hook/length only —
  // the full scorer runs later. NMS is applied here to avoid near-duplicates.
  const cap = candidateCap(opts.requestedCount);
  if (candidates.length <= cap) return candidates;

  // cheap pre-filter: prefer mid-length candidates with a question or number early
  const quickScore = (c: Candidate): number => {
    const first = c.text.split(/[.!?]/)[0] ?? '';
    let s = 0;
    if (/\d/.test(first)) s += 2;
    if (/\?/.test(first)) s += 2;
    if (first.split(/\s+/).length <= 18) s += 1;
    const targetMid = (minUs + maxUs) / 2;
    s -= Math.abs(c.durationUs - targetMid) / maxUs;
    return s;
  };
  candidates.sort((a, b) => quickScore(b) - quickScore(a));
  const kept: Candidate[] = [];
  for (const c of candidates) {
    if (kept.length >= cap) break;
    const overlapping = kept.some((k) => {
      const overlap = Math.min(k.endUs, c.endUs) - Math.max(k.startUs, c.startUs);
      if (overlap <= 0) return false;
      const shorter = Math.min(k.durationUs, c.durationUs);
      return overlap / shorter > 0.5;
    });
    if (!overlapping) kept.push(c);
  }
  return kept;
};

export const nonzeroStats = (nums: number[]): { mean: number; stdev: number } => {
  if (nums.length === 0) return { mean: 0, stdev: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return { mean, stdev: Math.sqrt(variance) };
};
