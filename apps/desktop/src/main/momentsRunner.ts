/**
 * Moments pipeline (Section 12). Stages 1, 2, 4-lite, 5, 6 run fully offline.
 * Stage 3 (LLM) runs only when a provider is available per processing mode;
 * any LLM failure falls back to heuristic scoring for the affected batch.
 */
import {
  generateCandidates, heuristicScoreCandidate, weightsFor, weightedTotal, dedupe, autoSelect,
  blendDims, detectOllama, createOllamaProvider, createOpenAiCompatibleProvider,
  parseLlmResults, SYSTEM_PROMPT, type LlmProvider, type Candidate, type DimScores,
} from '@clipwright/ai-core';
import { newId, type ContentType, type Moment, type MomentScore, type ProjectSettingsSnapshot } from '@clipwright/project-schema';
import type { JobContext } from './jobs.js';

const LENGTH_RANGES_US: Record<string, { minUs: number; maxUs: number }> = {
  short: { minUs: 15_000_000, maxUs: 30_000_000 },
  medium: { minUs: 30_000_000, maxUs: 60_000_000 },
  long: { minUs: 60_000_000, maxUs: 90_000_000 },
  extended: { minUs: 90_000_000, maxUs: 180_000_000 },
};

export const lengthRangeFor = (clipLength: ProjectSettingsSnapshot['clipLength']): { minUs: number; maxUs: number } => {
  if (typeof clipLength === 'object' && clipLength && 'minUs' in clipLength) {
    return { minUs: clipLength.minUs, maxUs: clipLength.maxUs };
  }
  return LENGTH_RANGES_US[clipLength as string] ?? LENGTH_RANGES_US['medium']!;
};

export const candidateCountFor = (numClips: ProjectSettingsSnapshot['numClips']): number | 'auto' =>
  numClips === 'auto' ? 'auto' : numClips;

interface ResolvedProvider { provider: LlmProvider | null; mode: 'llm' | 'heuristic'; label: string; warning?: string; }

const pickProvider = async (
  settings: ProjectSettingsSnapshot,
  onlineProvider: { baseUrl: string; apiKey: string; model: string; label?: string } | null,
  ollamaModel: string | null,
): Promise<ResolvedProvider> => {
  const wantMode = settings.processingMode;
  const tryOllama = async (): Promise<ResolvedProvider | null> => {
    const detected = await detectOllama();
    if (detected && ollamaModel) {
      return { provider: createOllamaProvider({ baseUrl: 'http://localhost:11434', model: ollamaModel }), mode: 'llm', label: `Ollama (${ollamaModel}) — local` };
    }
    return null;
  };
  const tryOnline = (): ResolvedProvider | null => {
    if (onlineProvider) {
      return { provider: createOpenAiCompatibleProvider(onlineProvider), mode: 'llm', label: onlineProvider.label ?? `Online (${onlineProvider.model})` };
    }
    return null;
  };
  if (wantMode === 'offline') {
    const local = await tryOllama();
    return local ?? { provider: null, mode: 'heuristic', label: 'Basic scoring (offline, no AI model)', warning: 'No local model found. Install Ollama and pull a model for AI scoring, or switch processing mode.' };
  }
  if (wantMode === 'online') {
    const online = tryOnline();
    return online ?? { provider: null, mode: 'heuristic', label: 'Basic scoring (no online provider configured)', warning: 'No online provider is set up. Add one in Settings → Providers, or switch to offline/automatic.' };
  }
  // automatic: local first, then online, then heuristic
  const local = await tryOllama();
  if (local) return local;
  const online = tryOnline();
  if (online) return online;
  return { provider: null, mode: 'heuristic', label: 'Basic scoring (no model available)', warning: 'Neither a local Ollama model nor an online provider is configured — using basic scoring.' };
};

export interface MomentsResult {
  moments: Moment[];
  modeLabel: string;
  basis: 'llm' | 'heuristic';
  warning?: string;
}

export const runMomentsPipeline = async (
  ctx: JobContext,
  projectId: string,
  settings: ProjectSettingsSnapshot,
  onlineProvider: { baseUrl: string; apiKey: string; model: string; label?: string } | null,
  ollamaModel: string | null,
): Promise<MomentsResult> => {
  ctx.report(0.05, 'Preparing candidates');
  const words = ctx.storage.loadTranscript(projectId);
  if (words.length === 0) throw new Error('There is no transcript to analyse yet. Transcribe the video first.');

  const range = lengthRangeFor(settings.clipLength);
  const requestedCount = candidateCountFor(settings.numClips);
  const candidates = generateCandidates(words, { minUs: range.minUs, maxUs: range.maxUs, requestedCount });
  if (candidates.length === 0) {
    throw new Error('No complete ideas fit the chosen clip length in this video. Try a longer target length.');
  }

  ctx.report(0.15, 'Analysing audio');
  const contentType = (settings.contentType === 'auto' ? 'podcast' : settings.contentType) as ContentType;
  const focusBoost = settings.clipFocus.trim().length > 0;
  const weights = weightsFor(contentType, focusBoost);

  const heuristic = new Map<string, ReturnType<typeof heuristicScoreCandidate>>();
  for (const c of candidates) heuristic.set(c.id, heuristicScoreCandidate(c, words));

  const resolved = await pickProvider(settings, onlineProvider, ollamaModel);
  ctx.logger.info('Moments scoring mode', { mode: resolved.mode, label: resolved.label });

  const llmDims = new Map<string, MomentScore>();
  const llmTitles = new Map<string, { title: string; reason: string; needsContext: boolean; flags: string[] }>();

  if (resolved.provider) {
    ctx.report(0.25, 'Scoring (AI)');
    const BATCH = 6;
    const focusLine = focusBoost ? `The user is especially interested in: ${settings.clipFocus.trim()}` : '';
    const system = SYSTEM_PROMPT
      .replace('{contentType}', settings.contentType)
      .replace('{language}', settings.language)
      .replace('{focusLine}', focusLine);
    let done = 0;
    for (let i = 0; i < candidates.length; i += BATCH) {
      if (ctx.signal.aborted) throw new Error('Cancelled by the user.');
      const batch = candidates.slice(i, i + BATCH);
      const prompt = buildBatchPrompt(batch, words, contentType);
      try {
        const raw = await resolved.provider.complete(prompt, { system, temperature: 0.2, timeoutMs: resolved.provider.online ? 60_000 : 120_000 });
        const { results } = parseLlmResults(raw);
        const byId = new Map(results.map((r) => [r.id, r]));
        for (const c of batch) {
          const r = byId.get(c.id);
          if (r) {
            llmDims.set(c.id, {
              hook: r.scores.hook, standalone: r.scores.standalone, emotion: r.scores.emotion,
              interest: r.scores.interest, story: r.scores.story, value: r.scores.value, pacing: r.scores.pacing, social: r.scores.social,
            });
            llmTitles.set(c.id, { title: r.title, reason: r.reason, needsContext: r.needsContext, flags: r.flags });
          }
        }
      } catch (err) {
        ctx.logger.warn('LLM batch failed; falling back to heuristic for this batch', { error: err instanceof Error ? err.message : String(err) });
      }
      done += batch.length;
      ctx.report(0.25 + 0.55 * (done / candidates.length), `Scoring ${done} of ${candidates.length}`);
    }
  } else {
    ctx.report(0.7, 'Scoring (basic)');
  }

  ctx.report(0.82, 'Removing duplicates');
  const scored = candidates.map((c) => {
    const heur = heuristic.get(c.id)!;
    const heurDims: DimScores = {
      hook: heur.hook, standalone: heur.standalone, emotion: heur.emotion, interest: heur.interest,
      story: heur.story, value: heur.value, pacing: heur.pacing, social: heur.social,
    };
    const llm = llmDims.get(c.id);
    const dims = llm ? blendDims(llm, heurDims) : heurDims;
    return {
      candidate: c,
      dims,
      score: weightedTotal(dims, weights),
      basis: llm ? ('llm' as const) : ('heuristic' as const),
      title: llmTitles.get(c.id)?.title ?? '',
      reason: llmTitles.get(c.id)?.reason ?? '',
      flags: llmTitles.get(c.id)?.flags ?? [],
    };
  });

  const scoredFlat = scored.map((s) => ({ ...s, startUs: s.candidate.startUs, endUs: s.candidate.endUs, text: s.candidate.text }));
  const deduped = dedupe(scoredFlat, (s) => s.text).sort((a, b) => b.score - a.score);
  const k = requestedCount === 'auto' ? autoSelect(deduped) : Math.min(requestedCount, deduped.length);

  ctx.report(0.92, 'Ranking');
  const nowTs = Date.now();
  const moments: Moment[] = deduped.slice(0, Math.max(k, Math.min(deduped.length, 2 * k))).map((s) => ({
    id: newId(),
    projectId,
    startUs: s.candidate.startUs,
    endUs: s.candidate.endUs,
    score: s.score,
    breakdown: s.dims as MomentScore,
    reasons: s.reason ? [s.reason] : defaultReasons(s.dims),
    title: s.title || autoTitle(s.candidate.text),
    excerpt: s.candidate.text.slice(0, 220),
    status: 'candidate',
    stale: false,
    createdAt: nowTs,
  }));

  ctx.storage.replaceMoments(projectId, moments);
  ctx.report(1, 'Done');
  return { moments, modeLabel: resolved.label, basis: resolved.mode === 'llm' ? 'llm' : 'heuristic', warning: resolved.warning };
};

const buildBatchPrompt = (batch: Candidate[], words: Parameters<typeof generateCandidates>[0], contentType: ContentType): string => {
  const lines = batch.map((c) => {
    const firstWord = words[0];
    void firstWord;
    const excerpt = c.text.slice(0, 1400);
    return `Candidate id: ${c.id}
Start: ${(c.startUs / 1_000_000).toFixed(1)}s  End: ${(c.endUs / 1_000_000).toFixed(1)}s  Duration: ${(c.durationUs / 1_000_000).toFixed(1)}s
Transcript: ${excerpt}`;
  }).join('\n\n---\n\n');
  return `Content type: ${contentType}\n\n${lines}`;
};

const defaultReasons = (dims: DimScores): string[] => {
  const entries = Object.entries(dims) as Array<[keyof DimScores, number]>;
  entries.sort((a, b) => b[1] - a[1]);
  const [bestDim] = entries[0]!;
  const names: Record<keyof MomentScore, string> = {
    hook: 'strong opening', standalone: 'works without extra context', emotion: 'emotional payoff',
    interest: 'novel or discussion-worthy', story: 'clear arc', value: 'concrete takeaway', pacing: 'tight pacing', social: 'fits short-form',
  };
  return [`Scored highest on ${names[bestDim]}.`];
};

const autoTitle = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').slice(0, 8).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
