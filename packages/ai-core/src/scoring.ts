/**
 * Stage 2/5/6 — heuristic features, transparent weighted scoring,
 * content-type weight adjustments, LLM/heuristic blending, selection.
 */
import type { ContentType, MomentScore, TranscriptWord } from '@clipwright/project-schema';
import type { Candidate } from './candidates.js';

export interface DimScores {
  hook: number; standalone: number; emotion: number; interest: number;
  story: number; value: number; pacing: number; social: number;
}

export type Dimension = keyof DimScores;

export const BASE_WEIGHTS: DimScores = {
  hook: 20, standalone: 20, emotion: 15, interest: 15, story: 10, value: 10, pacing: 5, social: 5,
};

export const CONTENT_TYPE_ADJUSTMENTS: Record<ContentType, Partial<DimScores>> = {
  auto: {},
  other: {},
  podcast: { hook: +5, standalone: +5, pacing: -5, social: -5 },
  'talking-head': { hook: +5, emotion: +5, story: -5, value: -5 },
  tutorial: { value: +10, story: +5, emotion: -10, social: -5 },
  gaming: { emotion: +10, pacing: +5, standalone: -10, value: -5 },
  lecture: { value: +5, story: +5, hook: -5, emotion: -5 },
};

export const weightsFor = (contentType: ContentType, focusBoost: boolean): DimScores => {
  const adj = CONTENT_TYPE_ADJUSTMENTS[contentType] ?? {};
  const w: DimScores = { ...BASE_WEIGHTS };
  for (const k of Object.keys(adj) as Dimension[]) {
    w[k] = w[k] + (adj[k] ?? 0);
  }
  // focus text: +5 audience interest, taken evenly from others
  if (focusBoost) {
    w.interest += 5;
    const others = (Object.keys(w) as Dimension[]).filter((d) => d !== 'interest');
    const take = 5 / others.length;
    for (const d of others) w[d] = Math.max(0, w[d] - take);
  }
  const sum = (Object.values(w) as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) {
    // normalise to exactly 100 (defensive; adjustments are designed to sum to 0)
    for (const d of Object.keys(w) as Dimension[]) w[d] = (w[d] / sum) * 100;
  }
  return w;
};

const QUESTION = /\?/;
const NUMBER_RE = /\b\d[\d,.]*\b/;
const CLAIM_WORDS = /\b(never|nobody|everyone|always|stop|secret|mistake|wrong|truth|reason why|the problem is|here's why|what nobody)\b/i;
const SECOND_PERSON = /\b(you|your|you're)\b/i;
const CURIOSITY = /\b(why|how|what if|the reason|turns out|surprising|nobody tells|hidden)\b/i;
const CONTRAST = /\b(but|however|instead|rather than|yet)\b/i;
const NEGATION = /\b(no|not|don't|can't|never|won't)\b/i;
const EMOTION_LEX = /\b(love|hate|angry|furious|amazing|incredible|unbelievable|insane|awesome|terrible|awful|hilarious|funny|scary|shocking|beautiful|heart|fear|excited|obsessed|perfect|worst|best)\b/i;
const EXCLAIM = /!/g;
const LAUGHTER = /\b(ha|haha|hehe|lol|lmao|laughter|laughs)\b/i;
const RESOLUTION = /\b(so|that's why|the point is|ultimately|therefore|finally|the lesson|bottom line)\b/i;
const REFERENCE_BACK = /\b(as i (said|mentioned) (earlier|before)|earlier we|like i said|before i mentioned)\b/i;
const OPENING_PRONOUNS = /^\s*(this|that|these|those|he|she|they|it)\b/i;
const FILLER_END = /\b(um|uh|er|erm|like|you know)\s*[.!?]?$/i;

export interface HeuristicFeatures {
  hook: number; standalone: number; emotion: number; interest: number;
  story: number; value: number; pacing: number; social: number;
  speechRateWpm: number; pauseDensity: number;
}

const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Compute 0-100 dimension scores from local features of a candidate. */
export const heuristicScoreCandidate = (
  candidate: Candidate,
  words: TranscriptWord[],
): HeuristicFeatures => {
  const text = candidate.text;
  const wordsInC = words.filter((w) => w.endUs > candidate.startUs && w.startUs < candidate.endUs);
  const durSec = Math.max(0.001, (candidate.endUs - candidate.startUs) / 1_000_000);
  const speechRateWpm = (wordsInC.length / durSec) * 60;

  // pause density: share of time in gaps >= 0.4s inside the range
  let pauseUs = 0;
  for (let i = 1; i < wordsInC.length; i++) {
    const gap = wordsInC[i]!.startUs - wordsInC[i - 1]!.endUs;
    if (gap >= 400_000) pauseUs += gap;
  }
  const pauseDensity = pauseUs / (durSec * 1_000_000);

  // --- hook: first sentence
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const firstWords = firstSentence.split(/\s+/).length;
  let hook = 35;
  if (QUESTION.test(firstSentence)) hook += 18;
  if (NUMBER_RE.test(firstSentence)) hook += 14;
  if (CLAIM_WORDS.test(firstSentence)) hook += 14;
  if (SECOND_PERSON.test(firstSentence)) hook += 8;
  if (CURIOSITY.test(firstSentence)) hook += 12;
  if (CONTRAST.test(firstSentence)) hook += 8;
  if (NEGATION.test(firstSentence)) hook += 6;
  if (firstWords <= 18) hook += 8; else hook -= (firstWords - 18);

  // --- emotion
  let emotion = 30;
  const excl = (text.match(EXCLAIM) ?? []).length;
  emotion += Math.min(25, excl * 8);
  if (EMOTION_LEX.test(text)) emotion += 20;
  if (LAUGHTER.test(text)) emotion += 15;
  if (/\b(shocked|stunning|wait|no way|really\?)\b/i.test(text)) emotion += 10;

  // --- standalone risk
  let standalone = 70;
  if (OPENING_PRONOUNS.test(text)) standalone -= 18;
  if (REFERENCE_BACK.test(text)) standalone -= 35;
  if (/\b(here|this video|watch)\b/i.test(firstSentence)) standalone -= 5;

  // --- completeness / story
  let story = 40;
  if (RESOLUTION.test(text)) story += 25;
  if (/\b(first|then|finally|step|part)\b/i.test(text)) story += 15;
  if (/[.!?]$/.test(text.trim())) story += 10;

  // --- value
  let value = 35;
  if (/\b(how to|you should|here's how|lesson|important|learn|tip|rule|principle)\b/i.test(text)) value += 25;
  if (NUMBER_RE.test(text)) value += 8;
  if (/\b(example|story|case study)\b/i.test(text)) value += 8;

  // --- interest
  let interest = 40;
  if (CURIOSITY.test(text)) interest += 15;
  if (NUMBER_RE.test(text)) interest += 8;
  if (CLAIM_WORDS.test(text)) interest += 14;
  if (CONTRAST.test(text)) interest += 8;

  // --- pacing: penalise very slow / very fast
  let pacing = 70;
  if (speechRateWpm < 90) pacing -= (90 - speechRateWpm) * 0.8;
  if (speechRateWpm > 200) pacing -= (speechRateWpm - 200) * 0.5;
  pacing -= pauseDensity * 90;

  // --- social: standalone + hook + emotion blend
  const social = clamp100(0.45 * clamp100(hook) + 0.3 * clamp100(standalone) + 0.25 * clamp100(emotion));

  if (FILLER_END.test(text)) story -= 6;

  return {
    hook: clamp100(hook),
    standalone: clamp100(standalone),
    emotion: clamp100(emotion),
    interest: clamp100(interest),
    story: clamp100(story),
    value: clamp100(value),
    pacing: clamp100(pacing),
    social,
    speechRateWpm: Math.round(speechRateWpm),
    pauseDensity: Math.round(pauseDensity * 1000) / 1000,
  };
};

/** Weighted total 0-100 from 0-100 dimension scores. */
export const weightedTotal = (dims: DimScores, weights: DimScores): number => {
  let sum = 0;
  for (const d of Object.keys(weights) as Dimension[]) sum += dims[d] * weights[d];
  return Math.round(sum / 100);
};

/** Blend heuristic and LLM dimension scores (0.8 LLM / 0.2 heuristic where both exist). */
export const blendDims = (
  llm: DimScores,
  heuristic: DimScores,
): DimScores => ({
  hook: Math.round(0.8 * llm.hook + 0.2 * heuristic.hook),
  standalone: Math.round(0.8 * llm.standalone + 0.2 * heuristic.standalone),
  emotion: Math.round(0.8 * llm.emotion + 0.2 * heuristic.emotion),
  story: Math.round(0.8 * llm.story + 0.2 * heuristic.story),
  pacing: Math.round(0.8 * llm.pacing + 0.2 * heuristic.pacing),
  interest: llm.interest,
  value: llm.value,
  social: llm.social,
});

/** Overlap ratio of two ranges relative to the shorter. */
export const overlapRatio = (aStart: number, aEnd: number, bStart: number, bEnd: number): number => {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (overlap <= 0) return 0;
  return overlap / Math.min(aEnd - aStart, bEnd - bStart);
};

/** 5-word shingle Jaccard similarity between two texts. */
export const shingleSimilarity = (a: string, b: string): number => {
  const shingles = (t: string): Set<string> => {
    const tokens = t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + 5 <= tokens.length; i++) out.add(tokens.slice(i, i + 5).join(' '));
    return out;
  };
  const sa = shingles(a); const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
};

/** De-duplicate scored moments: time-overlap > 50% of shorter or Jaccard > 0.6 → keep higher score. */
export const dedupe = <T extends { startUs: number; endUs: number; score: number; text?: string }>(
  moments: T[],
  textOf: (m: T) => string,
): T[] => {
  const sorted = [...moments].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const m of sorted) {
    const dup = kept.find((k) =>
      overlapRatio(k.startUs, k.endUs, m.startUs, m.endUs) > 0.5 ||
      shingleSimilarity(textOf(k), textOf(m)) > 0.6,
    );
    if (!dup) kept.push(m);
  }
  // restore chronological order for display convenience of callers that want it
  return kept;
};

/** Auto selection: score >= 65, max 20, min 3. */
export const autoSelect = (sortedByScore: { score: number }[]): number => {
  const eligible = sortedByScore.filter((m) => m.score >= 65).length;
  return Math.max(3, Math.min(20, eligible));
};
