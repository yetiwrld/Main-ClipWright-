/**
 * SPEC 06 §9 — Shared HTTP wrapper for every adapter.
 *
 * One place decides timeouts, retries, backoff, concurrency and how failures are
 * phrased to the user. Adapters only describe their request and response shape.
 */

import type { ProviderError, ProviderConfig } from './types.js';
import { CONNECT_TIMEOUT_MS } from './types.js';

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
  latencyMs: number;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs: number;
  signal: AbortSignal;
  /** Retries after the first attempt. Defaults to 3 per spec. */
  retries?: number;
  label: string;
}

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
const MAX_RETRY_AFTER_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(makeError('cancelled', 'The request was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeError('cancelled', 'The request was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeError(
  code: ProviderError['code'],
  message: string,
  extra: Partial<ProviderError> = {}
): ProviderError & Error {
  const err = new Error(message) as ProviderError & Error;
  err.code = code;
  err.message = message;
  err.actions = extra.actions ?? [];
  err.status = extra.status;
  err.raw = extra.raw;
  err.name = 'ProviderError';
  return err;
}

export function isProviderError(err: unknown): err is ProviderError & Error {
  return err instanceof Error && 'code' in err && 'actions' in err;
}

export function cancelledError(): ProviderError & Error {
  return makeError('cancelled', 'The request was cancelled.');
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Maps an HTTP status to the SPEC 06 §9 table. Never includes the raw body in the message. */
export function mapHttpError(status: number, label: string, providerName = 'The provider'): ProviderError & Error {
  if (status === 401 || status === 403) {
    return makeError(
      'auth',
      `The key was rejected by ${providerName}. Check that it's correct and has access to this model.`,
      { status, actions: ['edit_provider'] }
    );
  }
  if (status === 404) {
    return makeError('model_missing', `${providerName} doesn't have a model called that.`, {
      status,
      actions: ['pick_model'],
    });
  }
  if (status === 413) {
    return makeError('payload_too_large', 'The audio chunk is too large for this provider.', { status });
  }
  if (status === 429) {
    return makeError('rate_limited', `${providerName} is limiting requests. Try again later or switch provider.`, {
      status,
      actions: ['retry', 'switch_local'],
    });
  }
  if (status === 408 || status === 504) {
    return makeError('timeout', `${providerName} didn't respond in time.`, { status, actions: ['retry', 'switch_local'] });
  }
  if (status >= 500) {
    return makeError('bad_response', `${providerName} had a problem answering (${status}).`, {
      status,
      actions: ['retry', 'details'],
    });
  }
  return makeError('bad_response', `${providerName} replied in an unexpected way while ${label}.`, {
    status,
    actions: ['details'],
  });
}

function mapNetworkError(err: unknown, url: string, label: string): ProviderError & Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return makeError('cancelled', 'The request was cancelled.', { actions: [] });
  }
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw url as the label */
  }
  if (/certificate|self[- ]signed|ssl|tls/i.test(message)) {
    return makeError(
      'network',
      `Couldn't establish a secure connection to ${host}. Check the address, and that this computer's date and time are correct.`,
      { actions: ['edit_provider', 'retry'], raw: message }
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return makeError(
      'network',
      `Couldn't find ${host}. Check the address and your internet connection.`,
      { actions: ['edit_provider', 'retry'], raw: message }
    );
  }
  if (/ECONNREFUSED/i.test(message)) {
    return makeError(
      'not_running',
      `Nothing is answering at ${host}. Start the service (for example Ollama) and try again.`,
      { actions: ['retry', 'edit_provider'], raw: message }
    );
  }
  return makeError('network', `Couldn't connect to ${host} while ${label}.`, {
    actions: ['edit_provider', 'retry'],
    raw: message,
  });
}

async function fetchOnce(url: string, options: RequestOptions): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal.addEventListener('abort', onOuterAbort, { once: true });

  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (options.signal.aborted) throw makeError('cancelled', 'The request was cancelled.');
    if (controller.signal.aborted) {
      throw makeError('timeout', `The request timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`, {
        actions: ['retry', 'switch_local'],
      });
    }
    throw mapNetworkError(err, url, options.label);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onOuterAbort);
  }
}

/** Performs a request with retries, honouring `Retry-After`. Throws mapped errors. */
export async function request(url: string, options: RequestOptions): Promise<HttpResponse> {
  const retries = options.retries ?? 3;
  let attempt = 0;

  for (;;) {
    try {
      const response = await fetchOnce(url, options);
      if (response.ok) return response;

      const mapped = mapHttpError(response.status, options.label);
      mapped.raw = response.body.slice(0, 2000);

      const retryable = shouldRetryStatus(response.status);
      if (!retryable || attempt >= retries) throw mapped;

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const delay = retryAfter ?? RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      attempt++;
      await sleep(delay, options.signal);
    } catch (err) {
      const isMapped = isProviderError(err);
      const retryable = isMapped && (err.code === 'network' || err.code === 'timeout' || err.code === 'rate_limited');
      if (!isMapped || !retryable || attempt >= retries) throw err;
      attempt++;
      await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)], options.signal);
    }
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return null;
}

export async function requestJson<T>(url: string, options: RequestOptions): Promise<{ data: T; latencyMs: number }> {
  const response = await request(url, options);
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('json') && /^\s*</.test(response.body)) {
    // A captive portal or proxy returned HTML instead of JSON.
    throw makeError(
      'bad_response',
      'That address returned a web page instead of data. Check the base URL — some networks intercept requests.',
      { actions: ['edit_provider', 'details'], raw: response.body.slice(0, 500) }
    );
  }

  try {
    return { data: JSON.parse(response.body) as T, latencyMs: response.latencyMs };
  } catch {
    throw makeError('bad_response', 'The provider replied in an unexpected format.', {
      actions: ['details'],
      raw: response.body.slice(0, 500),
    });
  }
}

/** HEAD (or GET fallback) with a short timeout — used by the reach step. */
export async function reachable(url: string, signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: ProviderError }> {
  const started = Date.now();
  try {
    await request(url, { method: 'GET', timeoutMs: CONNECT_TIMEOUT_MS, signal, label: 'checking the address', retries: 1 });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    if (isProviderError(err)) return { ok: false, latencyMs: Date.now() - started, error: err };
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: makeError('unknown', "Couldn't reach that address."),
    };
  }
}

/**
 * Simple fair concurrency limiter, one per provider id (SPEC 06 §9).
 */
export class ConcurrencyLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift();
      next?.();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolvePromise) => this.waiting.push(resolvePromise));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }
}

const limiters = new Map<string, ConcurrencyLimiter>();

export function limiterFor(config: ProviderConfig): ConcurrencyLimiter {
  const existing = limiters.get(config.id);
  if (existing) {
    existing.setLimit(config.maxConcurrent || 2);
    return existing;
  }
  const created = new ConcurrencyLimiter(config.maxConcurrent || 2);
  limiters.set(config.id, created);
  return created;
}

/** Auth headers per kind. Keys never leave this function. */
export function authHeaders(config: ProviderConfig): Record<string, string> {
  const key = config.apiKey?.trim();
  switch (config.kind) {
    case 'anthropic':
      return key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'anthropic-version': '2023-06-01' };
    case 'gemini':
      return key ? { 'x-goog-api-key': key } : {};
    case 'ollama':
      return {};
    case 'openai-compatible':
    default:
      return key ? { Authorization: `Bearer ${key}` } : {};
  }
}

export function mergeHeaders(config: ProviderConfig): Record<string, string> {
  return { ...config.extraHeaders, ...authHeaders(config) };
}
