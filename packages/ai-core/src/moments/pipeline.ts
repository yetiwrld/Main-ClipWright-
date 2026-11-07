/**
 * SPEC 07 §4 — The six-stage detection pipeline.
 *
 * Stages: candidates → features → scoring (LLM or heuristic) → refinement →
 * de-duplication → ranking. Every stage is cancellable and reports progress;
 * results are only handed back once, fully ranked.
 */

import type { Word } from '../transcription/index.js';
import type { ProviderAdapter, ProviderConfig } from '../providers/types.js';
import { indexSentences, prepareCandidates, type SentenceIndexEntry } from './candidates.js';
import { scoreBatchWithLlm, planBatches, buildSystemPrompt } from './llm.js';
import { refineBoundaries, overlapFraction, shingleSimilarity } from './refine.js';
import type { MomentSettings as _MomentSettings } from './types.js';

import {
  applyLengthPenalty,
  blendScores,
  computeConfidence,
  computeFeatures,
  heuristicDimensions,
  weightedScore,
} from './scoring.js';
import {
  DIMENSIONS,
  weightsForContentType,
  type Candidate,
  type ContentType,
  type DetectionInput,
  type DetectionProgress,
  type DetectionResult,
  type DimensionScores,
  type LlmMomentResult,
  type Moment,
  type MomentSettings,
  type ScoringContext,
} from './types.js';

export interface DetectOptions {
  input: DetectionInput;
  /** Present only when an LLM route was resolved. */
  llm?: {
    adapter: ProviderAdapter;
    config: ProviderConfig;
    providerName: string;
    model: string;
    contextWindowTokens?: number;
    platform: 'local' | 'online';
  };
  signal: AbortSignal;
  onProgress?: (progress: DetectionProgress) => void;
  /** Existing ranges to exclude (Find more, SPEC 07 §9.5). */
  excludeRanges?: Array<{ startUs: number; endUs: number }>;
  /** Fixed content type; otherwise 'auto' resolves via a cheap guess. */
  contentType?: ContentType;
  now?: () => Date;
}

interface Scored {
  candidate: Candidate;
  startUs: number;
  endUs: number;
  durationUs: number;
  scores: DimensionScores;
  total: number;
  llm?: LlmMomentResult;
  heuristic: DimensionScores;
  confidence: 'high' | 'medium' | 'low';
  flags: string[];
  needsContext: boolean;
  title: string;
  reason: string;
  groupId?: string;
}

const STAGE_WEIGHTS = { candidates: 10, features: 15, scoring: 60, dedupe: 5, ranking: 10 };

export async function detectMoments(options: DetectOptions): Promise<DetectionResult> {
  const { input, signal, onProgress } = options;
  const notes: string[] = [];
  const settings = input.settings;
  const contentType = options.contentType ?? guessContentType(input, settings.contentType);
  const weights = weightsForContentType(contentType);

  const report = (stage: DetectionProgress['stage'], fraction: number, detail?: string, extra: Partial<DetectionProgress> = {}) => {
    onProgress?.({
      stage,
      percent: Math.round(stagePercent(stage, fraction, Boolean(options.llm))),
      detail,
      ...extra,
    });
  };

  // ---- Stage 1: candidates ------------------------------------------------
  report('candidates', 0.1, 'Preparing candidates');
  const entries = indexSentences(input.sentences, input.words);
  if (entries.length === 0) {
    return emptyResult(contentType, options, ['There is no speech to analyse in this video.']);
  }

  const exclude = options.excludeRanges ?? [];
  let candidates = prepareCandidates(entries, settings, input.paragraphStarts, input.energyWindows).filter(
    (candidate) => !exclude.some((range) => overlapFraction(candidate, { ...range, durationUs: range.endUs - range.startUs }) > 0.5)
  );

  if (candidates.length === 0) {
    notes.push('No candidate fitted the requested length. The whole video was treated as one candidate.');
    candidates = [makeWholeRangeCandidate(entries)];
  }

  signal.throwIfAborted();
  // ---- Stage 2: features --------------------------------------------------
  report('features', 0.5, 'Analysing audio and text');
  computeFeatures(entries, candidates, input.energyWindows);
  report('features', 1);

  // ---- Stage 3: scoring ---------------------------------------------------
  const llmResults = new Map<string, LlmMomentResult>();
  let neededRepair = false;
  let scoringMode: 'llm' | 'heuristic' = options.llm ? 'llm' : 'heuristic';

  if (options.llm) {
    const system = buildSystemPrompt(contentType, settings.language, settings.clipFocus);
    const batches = planBatches(candidates, options.llm.contextWindowTokens, system);
    const timeoutMs = options.llm.platform === 'local' ? 120_000 : 60_000;

    for (let i = 0; i < batches.length; i++) {
      signal.throwIfAborted();
      report('scoring', i / batches.length, `Scoring with ${options.llm.model}`, {
        batch: i + 1,
        batchCount: batches.length,
      });

      const outcome = await scoreBatchWithLlm({
        adapter: options.llm.adapter,
        config: options.llm.config,
        candidates: batches[i],
        contentType,
        language: settings.language,
        focus: settings.clipFocus,
        signal,
        timeoutMs,
      });

      if (outcome.neededRepair) neededRepair = true;
      if (outcome.failed) {
        notes.push(
          outcome.error
            ? `The model could not score batch ${i + 1} (${outcome.error}). Those candidates were scored locally instead.`
            : `Batch ${i + 1} was scored locally.`
        );
      }
      for (const [id, result] of outcome.results) llmResults.set(id, result);
    }

    if (llmResults.size === 0) {
      scoringMode = 'heuristic';
      notes.push('The model returned no usable scores, so Basic scoring was used. Install a different model for AI scoring.');
    }
  } else {
    report('scoring', 1, 'Basic scoring — no AI model');
  }

  const context: ScoringContext = {
    mode: scoringMode,
    providerName: options.llm?.providerName,
    model: options.llm?.model,
  };

  // Detect a model that gave every candidate the same numbers (SPEC 07 §12).
  let blendRatio = 0.8;
  if (scoringMode === 'llm' && llmResults.size > 1) {
    const totals = [...llmResults.values()].map((r) => weightedScore(r.scores, weights));
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const variance = totals.reduce((sum, t) => sum + (t - mean) ** 2, 0) / totals.length;
    if (Math.sqrt(variance) < 3) {
      blendRatio = 0.5;
      notes.push('The model scored everything almost identically, so local heuristics were weighted more heavily.');
    }
  }

  // ---- Stage 4: refinement ------------------------------------------------
  const scored: Scored[] = [];
  for (const candidate of candidates) {
    const llm = llmResults.get(candidate.id);
    const heuristic = applyLengthPenalty(heuristicDimensions(candidate), candidate.durationUs, settings);

    let scores: DimensionScores;
    let basis: 'llm' | 'heuristic' = 'heuristic';
    if (llm && scoringMode === 'llm') {
      scores = blendScores(llm.scores, heuristic, blendRatio);
      basis = 'llm';
    } else {
      scores = heuristic;
    }
    scores = applyLengthPenalty(scores, candidate.durationUs, settings);

    const refined = refineBoundaries({
      candidate,
      entries,
      settings,
      trimStartSentence: llm?.trimStartSentence,
      trimEndSentence: llm?.trimEndSentence,
      needsContext: llm?.needsContext,
    });
    if (!refined) continue;

    const total = weightedScore(scores, weights);

    const sliceWords = wordsInRange(input.words, refined.startUs, refined.endUs);
    const averageWordConfidence =
      sliceWords.filter((w) => typeof w.confidence === 'number').reduce((sum, w) => sum + (w.confidence ?? 1), 0) /
      Math.max(1, sliceWords.filter((w) => typeof w.confidence === 'number').length);
    const hasApproximateWords = sliceWords.some((w) => w.approximate);

    const flags = llm?.flags ?? [];
    const confidence = computeConfidence({
      llmScore: llm ? weightedScore(llm.scores, weights) : undefined,
      heuristicScore: weightedScore(heuristic, weights),
      neededRepair,
      averageWordConfidence,
      hasApproximateWords,
      flags,
    });

    scored.push({
      candidate,
      startUs: refined.startUs,
      endUs: refined.endUs,
      durationUs: refined.durationUs,
      scores,
      total,
      llm,
      heuristic,
      confidence,
      flags,
      needsContext: llm?.needsContext ?? candidate.features.standaloneRisk > 0.5,
      title: llm?.title || fallbackTitle(candidate.hookSentence),
      reason: llm?.reason || fallbackReason(candidate),
    });
  }

  if (scored.length === 0) {
    return emptyResult(contentType, options, [...notes, 'Nothing in this video fits the requested clip length.']);
  }

  signal.throwIfAborted();
  // ---- Stage 5: de-duplication -------------------------------------------
  report('dedupe', 0.2, 'Removing duplicates');
  const kept: Scored[] = [];
  const groups = new Map<string, Scored[]>();

  for (const item of [...scored].sort((a, b) => b.total - a.total)) {
    const duplicate = kept.find((other) => {
      const timeOverlap = overlapFraction(other, item) > 0.5;
      const textSimilarity = shingleSimilarity(other.candidate.text, item.candidate.text) > 0.6;
      return timeOverlap || textSimilarity;
    });

    if (!duplicate) {
      kept.push(item);
      continue;
    }

    // SPEC 07 §4.6 — near-equal scores with clearly different lengths become
    // alternates rather than being thrown away.
    const scoreGap = Math.abs(duplicate.total - item.total);
    const lengthRatio =
      Math.max(duplicate.durationUs, item.durationUs) / Math.max(1, Math.min(duplicate.durationUs, item.durationUs));
    const existingGroup = groups.get(duplicate.candidate.id);

    if (scoreGap <= 5 && lengthRatio > 1.3 && (!existingGroup || existingGroup.length < 2)) {
      const groupId = `group_${duplicate.candidate.id}`;
      if (!existingGroup) groups.set(duplicate.candidate.id, [duplicate]);
      groups.get(duplicate.candidate.id)!.push(item);
      void groupId;
    }
  }

  for (const [baseId, members] of groups) {
    const base = kept.find((k) => k.candidate.id === baseId);
    if (!base) continue;
    const groupId = `group_${baseId}`;
    for (const member of members) member.groupId = groupId;
  }

  // ---- Stage 6: ranking ---------------------------------------------------
  report('ranking', 0.2, 'Ranking');
  const withDiversity = applyDiversityPenalty(kept);
  const ranked = withDiversity.sort((a, b) => b.total - a.total);

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const moments = ranked.map((item, index) =>
    toMoment(item, {
      projectId: input.projectId,
      transcriptVersion: input.transcriptVersion,
      weights,
      context,
      index,
      createdAt,
      contentType,
    })
  );

  const selected = selectMoments(moments, settings.requestedCount);
  const selectedIds = new Set(selected.map((m) => m.id));
  const more = moments.filter((m) => !selectedIds.has(m.id) && m.score >= 40).slice(0, Math.max(6, selected.length * 2));

  if (selected.length < Number(settings.requestedCount === 'auto' ? 3 : settings.requestedCount)) {
    notes.push(
      `Only ${selected.length} distinct moment${selected.length === 1 ? '' : 's'} scored well enough for this video.`
    );
  }

  report('ranking', 1, 'Done');

  return {
    moments: selected,
    moreMoments: more,
    context,
    contentType,
    degraded: neededRepair || scoringMode === 'heuristic' && Boolean(options.llm),
    notes,
  };
}

function stagePercent(stage: DetectionProgress['stage'], fraction: number, hasLlm: boolean): number {
  const weights = hasLlm
    ? STAGE_WEIGHTS
    : { candidates: 10, features: 70, scoring: 0, dedupe: 10, ranking: 10 };

  const order: Array<DetectionProgress['stage']> = ['candidates', 'features', 'scoring', 'dedupe', 'ranking'];
  let percent = 0;
  for (const key of order) {
    if (key === stage) {
      percent += weights[key] * Math.max(0, Math.min(1, fraction));
      return percent;
    }
    percent += weights[key];
  }
  return percent;
}

function wordsInRange(words: Word[], startUs: number, endUs: number): Word[] {
  return words.filter((w) => w.endUs > startUs && w.startUs < endUs);
}

function fallbackTitle(hook: string): string {
  const words = hook.replace(/[.!?…]+$/g, '').split(/\s+/).slice(0, 8);
  const title = words.join(' ').trim();
  return title.length > 0 ? title.charAt(0).toUpperCase() + title.slice(1) : 'Untitled moment';
}

function fallbackReason(candidate: Candidate): string {
  const f = candidate.features;
  if (f.hook > 0.6) return 'Opens with a strong line that makes a viewer want the answer.';
  if (f.completeness > 0.7) return 'A complete thought with a clear beginning and ending.';
  if (f.standaloneRisk > 0.5) return 'Interesting content, but it leans on things said earlier.';
  return 'Solid but unremarkable stretch of speech with an even pace.';
}

function makeWholeRangeCandidate(entries: SentenceIndexEntry[]): Candidate {
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    id: 'cand_whole',
    sentenceStart: 0,
    sentenceEnd: entries.length - 1,
    startUs: first.startUs,
    endUs: last.endUs,
    durationUs: last.endUs - first.startUs,
    text: entries.map((e) => e.text).join(' '),
    hookSentence: first.text,
    features: {
      energy: 0,
      speechRate: 0,
      pauseDensity: 0,
      hook: 0,
      emotion: 0,
      completeness: 1,
      standaloneRisk: 0,
      wordsPerMinute: 0,
      startSentenceIndex: 0,
      endSentenceIndex: entries.length - 1,
    },
    heuristicScores: { hook: 0, standalone: 0, emotion: 0, interest: 0, story: 0, value: 0, pacing: 0, social: 0 },
    heuristicScore: 0,
    contextBefore: '',
    contextAfter: '',
  } as Candidate;
}

/** SPEC 07 §4.6 — −3 when a moment sits within 20 s of a higher-ranked one. */
function applyDiversityPenalty<T extends { startUs: number; total: number }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => b.total - a.total);
  const accepted: T[] = [];

  for (const item of sorted) {
    // Penalise a moment that starts within 20 s of a higher-ranked one so a
    // single stretch of the video cannot fill the list.
    const nearby = accepted.some((other) => Math.abs(other.startUs - item.startUs) < 20_000_000);
    accepted.push(nearby ? { ...item, total: Math.max(0, item.total - 3) } : item);
  }

  return accepted;
}

/** SPEC 07 §4.7 — Auto keeps everything ≥ 65 (max 20, min 3). */
export function selectMoments(moments: Moment[], requestedCount: number | 'auto'): Moment[] {
  const sorted = [...moments].sort((a, b) => b.score - a.score);

  if (requestedCount === 'auto') {
    const good = sorted.filter((m) => m.score >= 65).slice(0, 20);
    if (good.length >= 3) return good;
    return sorted.slice(0, 3);
  }

  return sorted.slice(0, Math.max(1, requestedCount));
}

interface ToMomentContext {
  projectId: string;
  transcriptVersion: number;
  weights: DimensionScores;
  context: ScoringContext;
  index: number;
  createdAt: string;
  contentType: ContentType;
}

function toMoment(item: Scored, ctx: ToMomentContext): Moment {
  const candidate: Candidate = item.candidate;
  return {
    id: `moment_${ctx.transcriptVersion}_${ctx.index}_${Math.round(item.startUs / 1000)}`,
    projectId: ctx.projectId,
    transcriptVersion: ctx.transcriptVersion,
    startUs: item.startUs,
    endUs: item.endUs,
    durationUs: item.durationUs,
    title: item.title,
    reason: item.reason,
    score: Math.max(0, Math.min(100, Math.round(item.total))),
    scores: normalizeScores(item.scores),
    weightsUsed: ctx.weights,
    confidence: item.confidence,
    basis: item.llm ? 'llm' : 'heuristic',
    model: item.llm ? ctx.context.model : undefined,
    provider: item.llm ? ctx.context.providerName : undefined,
    flags: item.flags,
    needsContext: item.needsContext,
    transcriptPreview: candidate.text.slice(0, 400),
    hookSentence: candidate.hookSentence,
    groupId: item.groupId,
    status: 'candidate',
    userEdited: false,
    manual: false,
    createdAt: ctx.createdAt,
    clips: [],
  };
}

function normalizeScores(scores: DimensionScores): DimensionScores {
  const out = {} as DimensionScores;
  for (const dim of DIMENSIONS) out[dim] = Math.max(0, Math.min(100, Math.round(scores[dim])));
  return out;
}

function emptyResult(contentType: ContentType, options: DetectOptions, notes: string[]): DetectionResult {
  return {
    moments: [],
    moreMoments: [],
    context: {
      mode: options.llm ? 'llm' : 'heuristic',
      providerName: options.llm?.providerName,
      model: options.llm?.model,
    },
    contentType,
    degraded: notes.length > 0,
    notes,
  };
}

/**
 * SPEC 07 §6.2 — guess the content type from cheap signals when set to Auto.
 * It is always shown as an editable chip, never as a fact.
 */
export function guessContentType(input: DetectionInput, configured: ContentType): ContentType {
  if (configured !== 'auto') return configured;

  const text = input.words.map((w) => w.text).join(' ').toLowerCase();
  if (text.length === 0) return 'other';

  const questions = (text.match(/\?/g) ?? []).length;
  const sentences = Math.max(1, input.sentences.length);
  const questionRatio = questions / sentences;

  const tutorialWords = (text.match(/\b(step|first|then|next|how to|you need|let me show|tutorial|example)\b/g) ?? []).length;
  const gamingWords = (text.match(/\b(game|level|boss|player|lobby|team|score|round|stream)\b/g) ?? []).length;
  const lectureWords = (text.match(/\b(theory|research|study|lecture|chapter|definition|concept)\b/g) ?? []).length;
  const vlogWords = (text.match(/\b(today|guys|vlog|camera|morning|subscribe|channel)\b/g) ?? []).length;

  const scores: Array<[ContentType, number]> = [
    ['tutorial', tutorialWords * 2],
    ['gaming', gamingWords * 2],
    ['lecture', lectureWords * 2],
    ['talking_head', vlogWords * 2],
    ['podcast', questionRatio * 10],
  ];

  const best = scores.sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'other';
}
