/**
 * SPEC 07 §7 — Moment data model and scoring vocabulary.
 */

import type { Sentence, Word } from '../transcription/index.js';

export const DIMENSIONS = [
  'hook',
  'standalone',
  'emotion',
  'interest',
  'story',
  'value',
  'pacing',
  'social',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type DimensionScores = Record<Dimension, number>;

export type ContentType =
  | 'auto'
  | 'podcast'
  | 'talking_head'
  | 'tutorial'
  | 'gaming'
  | 'lecture'
  | 'other';

/**
 * The project schema's spelling of the content types, mapped onto this module's.
 *
 * The two vocabularies differ in exactly one member and neither was wrong on its own: a project
 * stores `talking` (§02 §4.7's "Talking head/vlog" tile) and the scoring model is keyed by
 * `talking_head`. `moments-service` passed one into the other behind a cast, so a user who chose
 * the talking-head tile got `CONTENT_TYPE_ADJUSTMENTS['talking']` — `undefined` — and the generic
 * `DEFAULT_WEIGHTS`. Their choice was silently discarded, and the only visible sign was that
 * choosing a content type did less than the panel implied.
 *
 * A translation, not a widened union: the scoring table stays keyed by its own names, so a missing
 * entry is still visible here rather than becoming a silent `undefined` lookup two files away.
 */
export function contentTypeFromProject(value: string): ContentType {
  const translated = value === 'talking' ? 'talking_head' : value;
  return (CONTENT_TYPES as readonly string[]).includes(translated)
    ? (translated as ContentType)
    : 'auto';
}

/** The members of `ContentType`, for callers that have a string and need to check it. */
export const CONTENT_TYPES = [
  'auto',
  'podcast',
  'talking_head',
  'tutorial',
  'gaming',
  'lecture',
  'other',
] as const satisfies readonly ContentType[];

export type Confidence = 'high' | 'medium' | 'low';

export type MomentBasis = 'llm' | 'heuristic';

export type MomentStatus = 'candidate' | 'favourite' | 'rejected' | 'clipped';

export interface CandidateFeatures {
  /** 0–1, normalised against the whole video. */
  energy: number;
  speechRate: number;
  pauseDensity: number;
  hook: number;
  emotion: number;
  completeness: number;
  standaloneRisk: number;
  /** Raw values kept for the UI and for re-scoring. */
  wordsPerMinute: number;
  startSentenceIndex: number;
  endSentenceIndex: number;
}

export interface Candidate {
  id: string;
  sentenceStart: number;
  sentenceEnd: number;
  startUs: number;
  endUs: number;
  durationUs: number;
  text: string;
  hookSentence: string;
  features: CandidateFeatures;
  heuristicScores: DimensionScores;
  heuristicScore: number;
  /** Preceding/following sentence text, context only (never part of the clip). */
  contextBefore: string;
  contextAfter: string;
}

export interface LlmMomentResult {
  id: string;
  scores: DimensionScores;
  title: string;
  reason: string;
  needsContext: boolean;
  trimStartSentence: number;
  trimEndSentence: number;
  flags: string[];
}

export interface Moment {
  id: string;
  projectId: string;
  transcriptVersion: number;
  startUs: number;
  endUs: number;
  durationUs: number;
  title: string;
  reason: string;
  score: number;
  scores: DimensionScores;
  weightsUsed: DimensionScores;
  confidence: Confidence;
  basis: MomentBasis;
  model?: string;
  provider?: string;
  flags: string[];
  needsContext: boolean;
  transcriptPreview: string;
  hookSentence: string;
  groupId?: string;
  status: MomentStatus;
  userEdited: boolean;
  manual: boolean;
  createdAt: string;
  clips: string[];
}

export interface MomentSettings {
  targetMinSec: number;
  targetMaxSec: number;
  requestedCount: number | 'auto';
  clipFocus: string;
  contentType: ContentType;
  language: string;
}

export interface DetectionInput {
  projectId: string;
  transcriptVersion: number;
  words: Word[];
  sentences: Sentence[];
  /** Per-sentence paragraph index, used to prefer paragraph starts. */
  paragraphStarts: Set<number>;
  /** RMS energy windows of 250 ms from the audio, 0–1 each. Optional. */
  energyWindows?: number[];
  settings: MomentSettings;
}

export interface ScoringContext {
  mode: 'llm' | 'heuristic';
  providerName?: string;
  model?: string;
}

export interface DetectionProgress {
  stage: 'candidates' | 'features' | 'scoring' | 'dedupe' | 'ranking';
  percent: number;
  detail?: string;
  batch?: number;
  batchCount?: number;
}

export interface DetectionResult {
  moments: Moment[];
  moreMoments: Moment[];
  context: ScoringContext;
  contentType: ContentType;
  /** True when the LLM output needed a repair or a retry. */
  degraded: boolean;
  notes: string[];
}

/** SPEC 07 §6.1 — default weights, sum exactly 100. */
export const DEFAULT_WEIGHTS: DimensionScores = {
  hook: 20,
  standalone: 20,
  emotion: 15,
  interest: 15,
  story: 10,
  value: 10,
  pacing: 5,
  social: 5,
};

/** SPEC 07 §6.2 — point movements per content type; the total stays 100. */
export const CONTENT_TYPE_ADJUSTMENTS: Record<Exclude<ContentType, 'auto'>, Partial<DimensionScores>> = {
  podcast: { hook: 5, standalone: 5, pacing: -5, social: -5 },
  talking_head: { hook: 5, emotion: 5, story: -5, value: -5 },
  tutorial: { value: 10, story: 5, emotion: -10, social: -5 },
  gaming: { emotion: 10, pacing: 5, standalone: -10, value: -5 },
  lecture: { value: 5, story: 5, hook: -5, emotion: -5 },
  other: {},
};

export function weightsForContentType(contentType: ContentType): DimensionScores {
  const key = contentType === 'auto' ? 'other' : contentType;
  const adjustment = CONTENT_TYPE_ADJUSTMENTS[key] ?? {};
  const weights = { ...DEFAULT_WEIGHTS };
  for (const dim of DIMENSIONS) {
    weights[dim] += adjustment[dim] ?? 0;
  }
  return weights;
}

/** Guard used by tests and by the UI: weights must always total 100. */
export function weightsSum(weights: DimensionScores): number {
  return DIMENSIONS.reduce((sum, dim) => sum + weights[dim], 0);
}
