/**
 * SPEC 07 §4.2 & §6 — Local features, the heuristic score, blending and confidence.
 *
 * This file is the whole of Basic mode: no network, no model, no randomness.
 * The same numbers feed AI mode as the 20 % damping term.
 */

import type { SentenceIndexEntry } from './candidates.js';
import {
  DIMENSIONS,
  type Candidate,
  type CandidateFeatures,
  type Confidence,
  type Dimension,
  type DimensionScores,
  type MomentSettings,
} from './types.js';

const QUESTION_STARTS = /^(what|why|how|when|who|where|which|do|does|did|can|could|would|should|is|are|was|were|have|has)\b/i;
const STRONG_CLAIM = /\b(never|always|nobody|everyone|the truth|secret|biggest|worst|best|mistake|failed|wrong|actually|proven|guaranteed)\b/i;
const SECOND_PERSON = /\b(you|your|you're|yourself)\b/i;
const CONTRAST = /\b(but|however|instead|yet|although|even though|except)\b/i;
const CURIOSITY = /\b(the reason|what happened|turns out|here's why|the problem is|nobody tells you|most people)\b/i;
const NUMBER = /\b\d+([.,]\d+)?(%| percent| million| billion| thousand| x| times)?\b/i;
const RESOLUTION = /\b(so|therefore|that's why|the point is|in the end|which means|ultimately)\b/i;

export const POSITIVE_LEXICON = new Set([
  'love', 'amazing', 'incredible', 'fantastic', 'great', 'excellent', 'brilliant', 'wonderful',
  'happy', 'excited', 'proud', 'beautiful', 'perfect', 'success', 'win', 'won', 'best',
  'funny', 'hilarious', 'laugh', 'laughing', 'joy', 'hope', 'powerful', 'inspiring', 'remarkable',
]);

export const NEGATIVE_LEXICON = new Set([
  'hate', 'terrible', 'awful', 'horrible', 'worst', 'fail', 'failed', 'failing', 'problem',
  'angry', 'furious', 'scared', 'afraid', 'sad', 'pain', 'hurt', 'crash', 'broke', 'broken',
  'wrong', 'disaster', 'stress', 'stressed', 'argue', 'argument', 'fight', 'lost', 'lose', 'losing',
]);

const DEICTIC_STARTS = /^(this|that|these|those|it|he|she|they|him|her|them|there)\b/i;
const BACK_REFERENCE = /\b(as i said|as we said|earlier|previously|before that|like i mentioned|that thing)\b/i;

/** Ambient speech rate: too slow or too fast both read as poor pacing. */
export function speechRateScore(wordsPerMinute: number): number {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) return 0.5;
  if (wordsPerMinute < 110) return Math.max(0.1, wordsPerMinute / 110 * 0.6);
  if (wordsPerMinute <= 170) return 0.7 + ((wordsPerMinute - 110) / 60) * 0.3;
  if (wordsPerMinute <= 210) return 1 - ((wordsPerMinute - 170) / 40) * 0.25;
  return Math.max(0.25, 0.75 - (wordsPerMinute - 210) / 200);
}

/** Hook strength from text alone (SPEC 07 §4.2 "Hook"). */
export function hookScore(text: string, wordsCount: number): number {
  const firstSentence = text.split(/(?<=[.!?…])\s/)[0] ?? text;
  let score = 0.2;

  if (QUESTION_STARTS.test(firstSentence)) score += 0.2;
  if (NUMBER.test(firstSentence)) score += 0.12;
  if (STRONG_CLAIM.test(firstSentence)) score += 0.18;
  if (SECOND_PERSON.test(firstSentence)) score += 0.12;
  if (CONTRAST.test(firstSentence) || CURIOSITY.test(firstSentence)) score += 0.14;
  if (firstSentence.trim().endsWith('!')) score += 0.05;

  const firstSentenceWords = firstSentence.trim().split(/\s+/).length;
  if (firstSentenceWords <= 18) score += 0.08;
  if (firstSentenceWords > 32) score -= 0.1;

  if (wordsCount < 12) score -= 0.08;

  return clamp01(score);
}

/** Emotion intensity from lexicon magnitude and exclamations. */
export function emotionScore(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return 0;

  let positive = 0;
  let negative = 0;
  for (const word of words) {
    if (POSITIVE_LEXICON.has(word)) positive++;
    if (NEGATIVE_LEXICON.has(word)) negative++;
  }

  const magnitude = (positive + negative) / Math.max(words.length, 20);
  const exclamations = (text.match(/!/g) ?? []).length / Math.max(words.length / 25, 1);
  const laughter = /\b(haha|lol|\[\s*laughter\s*\]|\[laughter\]|applause)\b/i.test(text) ? 0.25 : 0;

  return clamp01(magnitude * 4 + Math.min(exclamations, 1) * 0.25 + laughter);
}

/** Starts at a valid boundary, ends at one, and resolves near the end. */
export function completenessScore(text: string, startsClean: boolean, endsClean: boolean): number {
  let score = 0;
  if (startsClean) score += 0.35;
  if (endsClean) score += 0.35;

  const tail = text.slice(-160);
  if (RESOLUTION.test(tail)) score += 0.2;
  if (/[.!?…]"?\s*$/.test(text.trim())) score += 0.1;

  return clamp01(score);
}

/** Higher means "a new viewer would be lost". */
export function standaloneRiskScore(text: string): number {
  const firstSentence = text.split(/(?<=[.!?…])\s/)[0] ?? text;
  let risk = 0;
  if (DEICTIC_STARTS.test(firstSentence)) risk += 0.4;
  if (BACK_REFERENCE.test(text)) risk += 0.35;
  if (/^(and|but|so|because)\b/i.test(firstSentence)) risk += 0.2;
  return clamp01(risk);
}

/** Mean RMS of the overlapping 250 ms windows, normalised 0–1 later. */
export function energyInRange(
  energyWindows: number[] | undefined,
  startUs: number,
  endUs: number
): number {
  if (!energyWindows || energyWindows.length === 0) return 0;
  const windowUs = 250_000;
  const from = Math.max(0, Math.floor(startUs / windowUs));
  const to = Math.min(energyWindows.length - 1, Math.ceil(endUs / windowUs));
  if (to < from) return 0;
  let sum = 0;
  for (let i = from; i <= to; i++) sum += energyWindows[i] ?? 0;
  return sum / (to - from + 1);
}

export function pauseDensityInRange(
  entries: SentenceIndexEntry[],
  startIndex: number,
  endIndex: number
): number {
  let pauseUs = 0;
  for (let i = startIndex + 1; i <= endIndex; i++) {
    pauseUs += Math.min(entries[i]?.pausesBeforeUs ?? 0, 1_500_000);
  }
  const spanUs = Math.max(1, (entries[endIndex]?.endUs ?? 0) - (entries[startIndex]?.startUs ?? 0));
  return clamp01(pauseUs / spanUs);
}

/**
 * SPEC 07 §4.2 — fills the features for every candidate, normalising energy and
 * rate against the whole video so no candidate is scored on an absolute scale.
 */
export function computeFeatures(
  entries: SentenceIndexEntry[],
  candidates: Candidate[],
  energyWindows?: number[]
): void {
  const energyValues = candidates.map((c) => energyInRange(energyWindows, c.startUs, c.endUs));
  const maxEnergy = Math.max(0.0001, ...energyValues);

  candidates.forEach((candidate, index) => {
    const slice = entries.slice(candidate.sentenceStart, candidate.sentenceEnd + 1);
    const wordCount = slice.reduce((sum, e) => sum + e.words.length, 0);
    const speakingUs = slice.reduce((sum, e) => sum + (e.endUs - e.startUs), 0);
    const minutes = speakingUs / 60_000_000;
    const wordsPerMinute = minutes > 0 ? wordCount / minutes : 0;

    const features: CandidateFeatures = {
      energy: clamp01(energyValues[index] / maxEnergy),
      speechRate: speechRateScore(wordsPerMinute),
      pauseDensity: pauseDensityInRange(entries, candidate.sentenceStart, candidate.sentenceEnd),
      hook: hookScore(candidate.text, wordCount),
      emotion: emotionScore(candidate.text),
      completeness: completenessScore(
        candidate.text,
        candidate.sentenceStart === 0 || (entries[candidate.sentenceStart]?.pausesBeforeUs ?? 0) >= 300_000,
        true
      ),
      standaloneRisk: standaloneRiskScore(candidate.text),
      wordsPerMinute,
      startSentenceIndex: candidate.sentenceStart,
      endSentenceIndex: candidate.sentenceEnd,
    };

    candidate.features = features;
  });
}

/**
 * SPEC 07 §4.2 — the heuristic dimension scores (0–100).
 * Every value is derived from a named feature so the UI can explain it.
 */
export function heuristicDimensions(candidate: Candidate): DimensionScores {
  const f = candidate.features;

  const hook = 100 * f.hook;
  const standalone = 100 * clamp01(0.85 - f.standaloneRisk * 0.7 + f.completeness * 0.15);
  const emotion = 100 * clamp01(f.emotion * 0.7 + f.energy * 0.3);
  const interest = 100 * clamp01(f.hook * 0.45 + f.emotion * 0.35 + f.energy * 0.2);
  const story = 100 * clamp01(f.completeness * 0.75 + (1 - f.pauseDensity) * 0.25);
  const value = 100 * clamp01(f.completeness * 0.4 + f.hook * 0.3 + (1 - f.standaloneRisk) * 0.3);
  const pacing = 100 * clamp01(f.speechRate * 0.7 + (1 - f.pauseDensity) * 0.3);
  const social = 100 * clamp01(f.emotion * 0.4 + f.hook * 0.3 + (1 - f.standaloneRisk) * 0.3);

  return {
    hook: round(hook),
    standalone: round(standalone),
    emotion: round(emotion),
    interest: round(interest),
    story: round(story),
    value: round(value),
    pacing: round(pacing),
    social: round(social),
  };
}

export function weightedScore(scores: DimensionScores, weights: DimensionScores): number {
  let total = 0;
  for (const dim of DIMENSIONS) total += (scores[dim] * weights[dim]) / 100;
  return Math.round(total);
}

/**
 * SPEC 07 §5 — length penalty: −1 point per 1 % outside the target range,
 * taken from pacing and social.
 */
export function applyLengthPenalty(
  scores: DimensionScores,
  durationUs: number,
  settings: MomentSettings
): DimensionScores {
  const durationSec = durationUs / 1_000_000;
  const { targetMinSec, targetMaxSec } = settings;
  if (durationSec >= targetMinSec && durationSec <= targetMaxSec) return scores;

  const outsideSec = durationSec < targetMinSec ? targetMinSec - durationSec : durationSec - targetMaxSec;
  const percentOutside = (outsideSec / Math.max(targetMinSec, 1)) * 100;
  const penalty = Math.min(30, Math.round(percentOutside));

  return {
    ...scores,
    pacing: clampScore(scores.pacing - penalty),
    social: clampScore(scores.social - penalty),
  };
}

/** Convenience used while generating candidates (before weights are known). */
export function scoreCandidateHeuristically(
  candidate: Candidate,
  settings: MomentSettings
): { scores: DimensionScores; total: number } {
  const base = heuristicDimensions(candidate);
  return { scores: base, total: weightedScore(applyLengthPenalty(base, candidate.durationUs, settings), weightsForScoring()) };
}

// Candidate pruning compares candidates against each other, so it uses a single
// fixed weighting regardless of the project's content type.
function weightsForScoring(): DimensionScores {
  return { hook: 20, standalone: 20, emotion: 15, interest: 15, story: 10, value: 10, pacing: 5, social: 5 };
}

/** SPEC 07 §6.3 — 80 % model, 20 % local heuristic where a counterpart exists. */
const BLENDED_DIMENSIONS: Dimension[] = ['hook', 'standalone', 'emotion', 'pacing', 'story'];

export function blendScores(llm: DimensionScores, heuristic: DimensionScores, blendRatio = 0.8): DimensionScores {
  const blended = { ...llm };
  for (const dim of BLENDED_DIMENSIONS) {
    blended[dim] = round(llm[dim] * blendRatio + heuristic[dim] * (1 - blendRatio));
  }
  return blended;
}

export interface ConfidenceInput {
  llmScore?: number;
  heuristicScore?: number;
  neededRepair: boolean;
  averageWordConfidence?: number;
  hasApproximateWords: boolean;
  flags: string[];
}

/** SPEC 07 §6.4 — High until something concrete lowers it. */
export function computeConfidence(input: ConfidenceInput): Confidence {
  let level = 2; // 2 = high

  if (
    typeof input.llmScore === 'number' &&
    typeof input.heuristicScore === 'number' &&
    Math.abs(input.llmScore - input.heuristicScore) > 20
  ) {
    level--;
  }
  if (input.neededRepair) level--;
  if ((input.averageWordConfidence ?? 1) < 0.6 || input.hasApproximateWords) level--;
  if (input.flags.includes('rambling') || input.flags.includes('needs_context')) level--;

  const clamped = Math.max(0, level);
  return clamped >= 2 ? 'high' : clamped === 1 ? 'medium' : 'low';
}

export function round(value: number): number {
  return Math.round(value);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}
