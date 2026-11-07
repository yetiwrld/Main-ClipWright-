/**
 * SPEC 06 §3 & §7.3 — Ollama adapter (local and LAN).
 *
 *   GET  /api/version · GET /api/tags · POST /api/chat · POST /api/pull · DELETE /api/delete
 *
 * Ollama has no transcription endpoint, so this adapter never claims the
 * transcription capability.
 */

import { limiterFor, mergeHeaders, request, requestJson } from './http.js';
import {
  CONNECT_TIMEOUT_MS,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderConfig,
  type TestResult,
  type TestStepResult,
  type TextResult,
} from './types.js';

interface VersionResponse {
  version?: string;
}

interface TagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
  }>;
}

interface ChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

export interface OllamaStatus {
  state: 'running' | 'not_found' | 'error';
  version?: string;
  host: string;
  message?: string;
}

/** Detection used by the model manager and by the router (SPEC 06 §7.3). */
export async function detectOllama(baseUrl: string, signal: AbortSignal): Promise<OllamaStatus> {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    /* keep raw */
  }
  try {
    const { data } = await requestJson<VersionResponse>(`${baseUrl.replace(/\/+$/, '')}/api/version`, {
      timeoutMs: CONNECT_TIMEOUT_MS,
      signal,
      retries: 0,
      label: 'checking Ollama',
    });
    return { state: 'running', version: data.version, host };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'not_running' || code === 'network') {
      return {
        state: 'not_found',
        host,
        message: `Ollama isn't answering at ${host}. It's a separate app that runs language models on your computer.`,
      };
    }
    return {
      state: 'error',
      host,
      message: err instanceof Error ? err.message : `Couldn't talk to Ollama at ${host}.`,
    };
  }
}

export const ollamaAdapter: ProviderAdapter = {
  kind: 'ollama',

  capabilities() {
    return ['text'];
  },

  async listModels(config, signal): Promise<ModelInfo[]> {
    const { data } = await requestJson<TagsResponse>(`${config.baseUrl}/api/tags`, {
      headers: mergeHeaders(config),
      timeoutMs: Math.min(config.timeoutMs, 30_000),
      signal,
      label: 'listing Ollama models',
    });
    return (data.models ?? [])
      .map((m) => ({
        id: (m.name ?? m.model ?? '').trim(),
        sizeBytes: m.size,
        parameterSize: m.details?.parameter_size,
        quantisation: m.details?.quantization_level,
        modifiedAt: m.modified_at,
      }))
      .filter((m) => m.id.length > 0);
  },

  async testConnection(config, signal): Promise<TestResult> {
    const steps: TestStepResult[] = [];
    const started = Date.now();

    const status = await detectOllama(config.baseUrl, signal);
    if (status.state !== 'running') {
      steps.push({ step: 'reach', ok: false, message: status.message ?? "Ollama isn't running." });
      return {
        ok: false,
        steps,
        error: { code: 'not_running', message: status.message ?? "Ollama isn't running.", actions: ['retry'] },
      };
    }
    steps.push({
      step: 'reach',
      ok: true,
      message: status.version ? `Ollama ${status.version} is running` : 'Ollama is running',
    });
    steps.push({ step: 'authenticate', ok: true, message: 'No key needed for a local service' });

    let models: ModelInfo[] = [];
    try {
      models = await this.listModels(config, signal);
    } catch (err) {
      steps.push({ step: 'model', ok: false, message: (err as Error).message });
      return { ok: false, steps, error: err as never };
    }

    if (models.length === 0) {
      steps.push({ step: 'model', ok: false, message: 'Ollama is running but has no models yet' });
      return {
        ok: false,
        steps,
        error: { code: 'model_missing', message: 'Ollama has no models installed yet.', actions: ['open_models'] },
      };
    }

    const chosen = config.models.text;
    if (chosen && !models.some((m) => m.id === chosen)) {
      steps.push({ step: 'model', ok: false, message: `"${chosen}" is not installed in Ollama` });
      return {
        ok: false,
        steps,
        error: { code: 'model_missing', message: `Ollama doesn't have "${chosen}" installed.`, actions: ['pick_model'] },
      };
    }
    steps.push({ step: 'model', ok: true, message: chosen ? `"${chosen}" is installed` : `${models.length} model(s) available` });

    if (chosen) {
      try {
        await this.text!.complete(
          config,
          {
            system: 'Reply with JSON only.',
            user: 'Return {"ok":true}',
            temperature: 0,
            maxTokens: 20,
            json: true,
            timeoutMs: 60_000,
          },
          signal
        );
        steps.push({ step: 'capability', ok: true, message: 'The model answered a test prompt' });
      } catch (err) {
        steps.push({ step: 'capability', ok: false, message: (err as Error).message });
        return { ok: false, steps, error: err as never };
      }
    }

    return { ok: true, steps, latencyMs: Date.now() - started };
  },

  text: {
    supportsJsonMode: true,
    contextWindow(config) {
      return config.numCtx;
    },
    async complete(config, request_, signal): Promise<TextResult> {
      const body = {
        model: config.models.text,
        messages: [
          { role: 'system', content: request_.system },
          { role: 'user', content: request_.user },
        ],
        stream: false,
        ...(request_.json ? { format: 'json' } : {}),
        options: {
          temperature: request_.temperature,
          num_ctx: config.numCtx,
          num_predict: request_.maxTokens,
          ...(typeof request_.seed === 'number' ? { seed: request_.seed } : {}),
        },
      };

      const result = await limiterFor(config).run(() =>
        requestJson<ChatResponse>(`${config.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...mergeHeaders(config) },
          body: JSON.stringify(body),
          timeoutMs: request_.timeoutMs,
          signal,
          label: 'generating text with Ollama',
        })
      );

      const mapped = mapOllamaFailure(result.data);
      if (mapped) throw mapped;

      return {
        text: result.data.message?.content ?? '',
        jsonMode: request_.json,
        usage: { promptTokens: result.data.prompt_eval_count, completionTokens: result.data.eval_count },
        model: result.data.model ?? config.models.text,
      };
    },
  },
};

/** Ollama reports many failures inside a 200 response. */
function mapOllamaFailure(data: ChatResponse): { code: string; message: string; actions: string[] } | null {
  const reason = (data.done_reason ?? '').toLowerCase();
  if (!reason) return null;
  if (reason.includes('length') && !data.message?.content) {
    return { code: 'bad_response', message: 'The model ran out of room before answering. Try a larger context size.', actions: [] };
  }
  return null;
}

/** Streams a model pull so the UI can show real bytes and cancel it. */
export async function pullOllamaModel(
  config: ProviderConfig,
  modelName: string,
  signal: AbortSignal,
  onProgress: (p: { status: string; completedBytes: number; totalBytes: number; percent: number }) => void
): Promise<void> {
  const response = await request(`${config.baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...mergeHeaders(config) },
    body: JSON.stringify({ name: modelName, stream: true }),
    timeoutMs: 24 * 60 * 60 * 1000,
    signal,
    retries: 0,
    label: `pulling ${modelName}`,
  });

  if (!response.ok) {
    throw { code: 'bad_response', message: `Ollama couldn't start the download (${response.status}).`, actions: [] };
  }

  // The endpoint streams newline-delimited JSON.
  const lines = response.body.split('\n').filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (event.error) {
        throw { code: 'bad_response', message: event.error, actions: ['retry'] };
      }
      const total = event.total ?? 0;
      const completed = event.completed ?? 0;
      onProgress({
        status: event.status ?? 'downloading',
        completedBytes: completed,
        totalBytes: total,
        percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      });
    } catch (err) {
      if ((err as { code?: string }).code) throw err;
      // ignore unparsable keep-alive lines
    }
  }
}

export async function deleteOllamaModel(config: ProviderConfig, modelName: string, signal: AbortSignal): Promise<void> {
  const response = await request(`${config.baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...mergeHeaders(config) },
    body: JSON.stringify({ name: modelName }),
    timeoutMs: 30_000,
    signal,
    retries: 0,
    label: `deleting ${modelName}`,
  });
  if (!response.ok) {
    throw { code: 'bad_response', message: `Ollama couldn't delete that model (${response.status}).`, actions: [] };
  }
}
