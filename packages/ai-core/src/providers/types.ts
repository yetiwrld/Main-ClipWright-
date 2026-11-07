/**
 * SPEC 06 §2 — Provider architecture.
 *
 * One adapter file per wire format; every pipeline talks to an adapter through
 * these types only. Adapters never read settings, never see the renderer, and
 * always accept an AbortSignal.
 */

export type Capability = 'transcription' | 'text';

export type ProviderKind = 'openai-compatible' | 'ollama' | 'anthropic' | 'gemini';

export type Locality = 'local' | 'network' | 'online';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Resolved at call time by the host process; never logged or returned upward. */
  apiKey?: string;
  models: { transcription?: string; text?: string };
  locality: Locality;
  timeoutMs: number;
  maxConcurrent: number;
  numCtx: number;
  extraHeaders?: Record<string, string>;
  /** Set when the user explicitly trusted a self-signed certificate. */
  pinnedFingerprint?: string;
}

export interface ModelInfo {
  id: string;
  /** Present when the endpoint reports it (Ollama does). */
  sizeBytes?: number;
  parameterSize?: string;
  quantisation?: string;
  modifiedAt?: string;
}

export interface TextRequest {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: boolean;
  seed?: number;
  timeoutMs: number;
}

export interface TextResult {
  text: string;
  /** False when the adapter could not use a native JSON mode. */
  jsonMode: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
  model?: string;
}

export interface TranscriptionRequest {
  /** 16 kHz mono PCM WAV chunk. */
  audio: Buffer;
  language: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface TranscriptionResult {
  words: Array<{ text: string; startSec: number; endSec: number; confidence?: number }>;
  language: string;
  languageConfidence: number;
}

export interface TestStepResult {
  step: 'reach' | 'authenticate' | 'model' | 'capability';
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface TestResult {
  ok: boolean;
  steps: TestStepResult[];
  latencyMs?: number;
  /** Present when ok is false; already mapped to plain language. */
  error?: ProviderError;
}

/**
 * Every failure the user can see, in plain language, with a next action.
 * `raw` holds the response body for the redacted debug log only.
 */
export interface ProviderError {
  code:
    | 'auth'
    | 'model_missing'
    | 'rate_limited'
    | 'payload_too_large'
    | 'timeout'
    | 'network'
    | 'bad_response'
    | 'not_running'
    | 'out_of_memory'
    | 'cancelled'
    | 'unknown';
  message: string;
  actions: Array<'edit_provider' | 'pick_model' | 'retry' | 'switch_local' | 'open_models' | 'details'>;
  status?: number;
  raw?: string;
}

export interface ProviderAdapter {
  kind: ProviderKind;
  capabilities(config: ProviderConfig): Capability[];
  testConnection(config: ProviderConfig, signal: AbortSignal): Promise<TestResult>;
  listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelInfo[]>;
  text?: {
    complete(config: ProviderConfig, request: TextRequest, signal: AbortSignal): Promise<TextResult>;
    contextWindow(config: ProviderConfig, model: string): number | undefined;
    supportsJsonMode: boolean;
  };
  transcription?: {
    transcribe(config: ProviderConfig, request: TranscriptionRequest): Promise<TranscriptionResult>;
    supportsWordTimestamps: boolean;
    maxUploadBytes: number;
  };
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const LOCAL_TIMEOUT_MS = 120_000;
export const CONNECT_TIMEOUT_MS = 10_000;

/** Normalises user-typed base URLs: trims, drops a trailing slash, collapses /v1/v1. */
export function normaliseBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/v1\/v1(?=\/|$)/i, '/v1');
  return url;
}

/** True when an http:// URL only ever points at this machine or a private LAN. */
export function isLocalOrLanHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

/** SPEC 06 §4.2 — https everywhere except loopback/LAN. */
export function validateBaseUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const url = normaliseBaseUrl(raw);
  if (!url) return { ok: false, message: 'Enter the address of your provider.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: 'That address is not a valid URL.' };
  }
  if (parsed.protocol === 'http:' && !isLocalOrLanHost(url)) {
    return {
      ok: false,
      message: 'Use https:// for providers on the internet. Plain http:// is only allowed for this computer or your local network.',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Only http and https addresses are supported.' };
  }
  return { ok: true, url };
}

/** SPEC 06 §9 — documented heuristic used only for batching decisions. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(rest / 3.6 + cjk / 2.0);
}
