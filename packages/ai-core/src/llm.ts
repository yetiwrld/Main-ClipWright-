/**
 * Online/local LLM providers behind one interface.
 * Online use sends ONLY transcript text and numbers — never audio/video.
 */
import { z } from 'zod';

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly online: boolean;
  complete(prompt: string, opts: { system?: string; temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<string>;
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;      // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
  label?: string;
  timeoutMs?: number;
}

export const createOpenAiCompatibleProvider = (cfg: OpenAiCompatibleConfig): LlmProvider => ({
  id: `openai:${cfg.model}`,
  label: cfg.label ?? `OpenAI-compatible (${cfg.model})`,
  online: true,
  async complete(prompt, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? cfg.timeoutMs ?? 60_000);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 2048,
          messages: [
            ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`Provider returned HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  },
});

export interface OllamaConfig {
  baseUrl: string;  // default http://localhost:11434
  model: string;    // e.g. llama3.1:8b
  timeoutMs?: number;
  numCtx?: number;
}

/** Detect Ollama at the default endpoint. Honest: returns null when absent. */
export const detectOllama = async (baseUrl = 'http://localhost:11434'): Promise<{ version: string } | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl}/api/version`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return { version: data.version ?? 'unknown' };
  } catch {
    return null;
  }
};

export const createOllamaProvider = (cfg: OllamaConfig): LlmProvider => ({
  id: `ollama:${cfg.model}`,
  label: `Ollama (${cfg.model})`,
  online: false,
  async complete(prompt, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? cfg.timeoutMs ?? 120_000);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          options: { temperature: opts.temperature ?? 0.2, num_ctx: cfg.numCtx ?? 8192 },
          messages: [
            ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`Ollama returned HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  },
});

/* ----------------------------------------------- JSON repair machinery */
const LLMResultSchema = z.object({
  id: z.string(),
  scores: z.object({
    hook: z.number(), standalone: z.number(), emotion: z.number(), interest: z.number(),
    story: z.number(), value: z.number(), pacing: z.number(), social: z.number(),
  }),
  title: z.string().default(''),
  reason: z.string().default(''),
  needsContext: z.boolean().default(false),
  trimStartSentence: z.number().int().default(0),
  trimEndSentence: z.number().int().default(0),
  flags: z.array(z.string()).default([]),
});
export type LlmCandidateResult = z.infer<typeof LLMResultSchema>;

/** Strip code fences and trailing commas, then JSON.parse; throws on failure. */
export const repairJson = (raw: string): string => {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1]!.trim();
  // find the outermost braces if there is extra prose
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  s = s.replace(/,\s*([}\]])/g, '$1'); // trailing commas
  return s;
};

export const parseLlmResults = (raw: string): { results: LlmCandidateResult[]; repaired: boolean } => {
  const attempt = (s: string): unknown => JSON.parse(s);
  let parsed: unknown;
  let repaired = false;
  try {
    parsed = attempt(raw);
  } catch {
    parsed = attempt(repairJson(raw));
    repaired = true;
  }
  const container = parsed as { results?: unknown[] };
  const arr = Array.isArray(container?.results) ? container.results : [];
  const results: LlmCandidateResult[] = [];
  for (const item of arr) {
    const r = LLMResultSchema.safeParse(item);
    if (!r.success) continue; // skip malformed entries; caller falls back per-candidate
    const scores = Object.fromEntries(
      Object.entries(r.data.scores).map(([k, v]) => [k, Math.max(0, Math.min(100, Math.round(v)))]),
    ) as LlmCandidateResult['scores'];
    results.push({ ...r.data, scores });
  }
  return { results, repaired };
};

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
