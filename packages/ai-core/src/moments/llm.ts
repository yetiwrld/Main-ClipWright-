/**
 * SPEC 07 §4.4 — LLM evaluation of candidates.
 *
 * The prompt is the spec's verbatim template. Output is validated with zod;
 * malformed JSON gets one repair pass and one stricter retry, then those
 * candidates quietly fall back to heuristic scores. This stage never throws.
 */

import { z } from 'zod';
import { estimateTokens, type ProviderConfig, type ProviderAdapter } from '../providers/types.js';
import { DIMENSIONS, type Candidate, type ContentType, type DimensionScores, type LlmMomentResult } from './types.js';

const MomentResultSchema = z.object({
  id: z.string(),
  scores: z.object({
    hook: z.number(),
    standalone: z.number(),
    emotion: z.number(),
    interest: z.number(),
    story: z.number(),
    value: z.number(),
    pacing: z.number(),
    social: z.number(),
  }),
  title: z.string().default(''),
  reason: z.string().default(''),
  needsContext: z.boolean().default(false),
  trimStartSentence: z.number().default(0),
  trimEndSentence: z.number().default(0),
  flags: z.array(z.string()).default([]),
});

const ResultsSchema = z.object({ results: z.array(MomentResultSchema) });

export const SYSTEM_PROMPT = `You are an expert short-form video editor who finds the best standalone clips in long videos.
You will receive candidate clips taken from a transcript. For EACH candidate, judge how well it
would work as a standalone short video for social media (TikTok, Reels, YouTube Shorts).

Content type: {contentType}. Language: {language}. {focusLine}

Score each dimension as an integer from 0 to 100 using these anchors:
  0-30 = weak, 31-55 = average, 56-75 = good, 76-90 = very good, 91-100 = exceptional (rare).
Dimensions:
  hook: does the first 3 seconds grab attention?
  standalone: can a new viewer understand it with no other context?
  emotion: does it create laughter, surprise, anger, inspiration or curiosity?
  interest: is the topic/insight novel, useful, or discussion-provoking for a general audience?
  story: does it have a clear beginning, development and ending?
  value: does it teach something or entertain in a satisfying way?
  pacing: is it tight, without long rambling or dead air?
  social: is it suitable and engaging as a short social video?

Also return:
  title: a clear, specific title of at most 8 words (no clickbait, no quotes, no emoji).
  reason: ONE sentence (max 25 words) explaining the main reason it works or does not.
  needsContext: true if a viewer would be confused without earlier material.
  trimStartSentence / trimEndSentence: the sentence indices (from the candidate) where the clip
    should best begin and end; they must stay inside the candidate.
  flags: array of any of ["rambling","weak_ending","profanity","sensitive_topic","off_topic","needs_context"].

Be strict and honest: most candidates are average. Do not give all candidates high scores.
Respond with ONLY valid JSON, no markdown, matching exactly:
{"results":[{"id":string,"scores":{"hook":int,"standalone":int,"emotion":int,"interest":int,"story":int,"value":int,"pacing":int,"social":int},"title":string,"reason":string,"needsContext":boolean,"trimStartSentence":int,"trimEndSentence":int,"flags":[string]}]}`;

const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  auto: 'general',
  podcast: 'podcast or interview',
  talking_head: 'talking head or vlog',
  tutorial: 'tutorial or educational',
  gaming: 'gaming or stream',
  lecture: 'lecture or talk',
  other: 'general',
};

export function buildSystemPrompt(contentType: ContentType, language: string, focus: string): string {
  const focusLine = focus.trim()
    ? `The user is especially interested in: ${focus.trim()}`
    : 'The user has not stated a specific interest.';
  return SYSTEM_PROMPT.replace('{contentType}', CONTENT_TYPE_LABEL[contentType] ?? 'general')
    .replace('{language}', language || 'unknown')
    .replace('{focusLine}', focusLine);
}

function seconds(us: number): string {
  const total = Math.round(us / 1_000_000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Renders a batch of candidates for the model, including 1 sentence of context each side. */
export function buildUserPrompt(candidates: Candidate[]): string {
  const blocks = candidates.map((candidate) => {
    const lines: string[] = [];
    lines.push(`CANDIDATE ${candidate.id}`);
    lines.push(`start ${seconds(candidate.startUs)} · end ${seconds(candidate.endUs)} · duration ${Math.round(candidate.durationUs / 1_000_000)}s`);
    lines.push(`sentences ${candidate.sentenceStart}–${candidate.sentenceEnd}`);
    lines.push(`speech rate ${Math.round(candidate.features.wordsPerMinute)} words/min · energy rank ${(candidate.features.energy * 100).toFixed(0)}/100`);
    if (candidate.contextBefore) lines.push(`[context before, not in clip] ${candidate.contextBefore}`);
    lines.push(`[clip] ${candidate.text}`);
    if (candidate.contextAfter) lines.push(`[context after, not in clip] ${candidate.contextAfter}`);
    return lines.join('\n');
  });

  return `Here are ${candidates.length} candidates.\n\n${blocks.join('\n\n')}\n\nReturn JSON only.`;
}

/** SPEC 07 §4.4 — batches sized from the context window, with 30 % headroom. */
export function planBatches(
  candidates: Candidate[],
  contextWindowTokens: number | undefined,
  systemPrompt: string
): Candidate[][] {
  const window = contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : 8192;
  const budget = Math.floor(window * 0.7) - estimateTokens(systemPrompt);
  const perBatchBudget = Math.max(600, budget);

  const batches: Candidate[][] = [];
  let current: Candidate[] = [];
  let used = 0;

  for (const candidate of candidates) {
    const cost = estimateTokens(candidate.text) + 90;
    if (current.length > 0 && used + cost > perBatchBudget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(candidate);
    used += cost;
  }
  if (current.length > 0) batches.push(current);

  return batches.length > 0 ? batches : [[]];
}

/** Strips code fences, trailing commas and prose around the JSON object. */
export function repairJson(raw: string): string {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  text = text.replace(/,\s*([}\]])/g, '$1');

  return text;
}

export interface ParseOutcome {
  results: Map<string, LlmMomentResult>;
  ok: boolean;
  repaired: boolean;
  error?: string;
}

export function parseLlmResponse(raw: string, validIds: Set<string>): ParseOutcome {
  const results = new Map<string, LlmMomentResult>();

  const attempt = (text: string): ParseOutcome | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    const validated = ResultsSchema.safeParse(parsed);
    if (!validated.success) return null;

    for (const item of validated.data.results) {
      if (!validIds.has(item.id)) continue; // drop hallucinated ids
      results.set(item.id, {
        id: item.id,
        scores: clampScores(item.scores),
        title: sanitiseTitle(item.title),
        reason: sanitiseReason(item.reason),
        needsContext: item.needsContext,
        trimStartSentence: item.trimStartSentence,
        trimEndSentence: item.trimEndSentence,
        flags: item.flags.filter((f) => typeof f === 'string').slice(0, 8),
      });
    }

    return { results, ok: true, repaired: text !== raw.trim() };
  };

  const direct = attempt(raw.trim());
  if (direct) return direct;

  const repaired = attempt(repairJson(raw));
  if (repaired) return repaired;

  return { results, ok: false, repaired: false, error: 'The model did not return usable JSON.' };
}

function clampScores(scores: Record<string, number>): DimensionScores {
  const out = {} as DimensionScores;
  for (const dim of DIMENSIONS) {
    const value = Number(scores[dim]);
    out[dim] = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
  }
  return out;
}

/** Titles are capped at 8 words and stripped of quotes/emoji per the prompt. */
export function sanitiseTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/["'“”„]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean).slice(0, 8);
  return words.join(' ');
}

export function sanitiseReason(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ').slice(0, 25);
  const joined = words.join(' ');
  return /[.!?]$/.test(joined) ? joined : `${joined}.`;
}

export interface ScoreBatchOptions {
  adapter: ProviderAdapter;
  config: ProviderConfig;
  candidates: Candidate[];
  contentType: ContentType;
  language: string;
  focus: string;
  signal: AbortSignal;
  /** Local models get a longer budget (SPEC 07 §4.4). */
  timeoutMs: number;
}

export interface ScoreBatchOutcome {
  results: Map<string, LlmMomentResult>;
  neededRepair: boolean;
  failed: boolean;
  error?: string;
}

/** Scores one batch. Retries once at a lower temperature with a stricter reminder. */
export async function scoreBatchWithLlm(options: ScoreBatchOptions): Promise<ScoreBatchOutcome> {
  const { adapter, config, candidates, contentType, language, focus, signal } = options;
  const text = adapter.text;
  if (!text) return { results: new Map(), neededRepair: false, failed: true, error: 'No text capability.' };

  const system = buildSystemPrompt(contentType, language, focus);
  const user = buildUserPrompt(candidates);
  const validIds = new Set(candidates.map((c) => c.id));

  const attempt = async (temperature: number, strict: boolean): Promise<ParseOutcome> => {
    const result = await text.complete(
      config,
      {
        system: strict ? `${system}\n\nYour previous reply was not valid JSON. Reply with JSON only, no prose.` : system,
        user,
        temperature,
        maxTokens: Math.min(4000, 220 * candidates.length + 200),
        json: true,
        seed: 7,
        timeoutMs: options.timeoutMs,
      },
      signal
    );
    return parseLlmResponse(result.text, validIds);
  };

  try {
    const first = await attempt(0.2, false);
    if (first.ok) {
      return { results: first.results, neededRepair: first.repaired, failed: false };
    }

    if (signal.aborted) return { results: new Map(), neededRepair: false, failed: true, error: 'Cancelled' };

    const second = await attempt(0.1, true);
    if (second.ok) {
      return { results: second.results, neededRepair: true, failed: false };
    }

    return { results: new Map(), neededRepair: true, failed: true, error: second.error };
  } catch (err) {
    return {
      results: new Map(),
      neededRepair: false,
      failed: true,
      error: err instanceof Error ? err.message : 'The model call failed.',
    };
  }
}
