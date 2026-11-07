/**
 * SPEC 06 §3 — Anthropic Messages API adapter (text only).
 *
 * Anthropic has no native JSON mode, so the adapter asks for JSON in the system
 * prompt, sets `jsonMode: false`, and leaves malformed output for the moments
 * pipeline's repair/validate step (SPEC 07 §4.4).
 */

import { limiterFor, mergeHeaders, requestJson } from './http.js';
import {
  CONNECT_TIMEOUT_MS,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderConfig,
  type TestResult,
  type TestStepResult,
  type TextResult,
} from './types.js';

interface MessagesResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

interface ModelsApiResponse {
  data?: Array<{ id?: string; display_name?: string }>;
}

const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',

  capabilities() {
    return ['text'];
  },

  async listModels(config, signal): Promise<ModelInfo[]> {
    const { data } = await requestJson<ModelsApiResponse>(`${config.baseUrl}/v1/models`, {
      headers: mergeHeaders(config),
      timeoutMs: Math.min(config.timeoutMs, 30_000),
      signal,
      label: 'listing Anthropic models',
    });
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id }));
  },

  async testConnection(config, signal): Promise<TestResult> {
    const steps: TestStepResult[] = [];
    const started = Date.now();

    try {
      const models = await this.listModels(config, signal);
      steps.push({ step: 'reach', ok: true, message: `Reached ${new URL(config.baseUrl).host}` });
      steps.push({ step: 'authenticate', ok: true, message: 'Key accepted' });

      const chosen = config.models.text;
      if (chosen && models.length > 0 && !models.some((m) => m.id === chosen)) {
        steps.push({ step: 'model', ok: false, message: `"${chosen}" is not in this account's model list` });
        return {
          ok: false,
          steps,
          error: { code: 'model_missing', message: `This account doesn't list a model called "${chosen}".`, actions: ['pick_model'] },
        };
      }
      steps.push({ step: 'model', ok: true, message: chosen ? `"${chosen}" is available` : 'No model chosen yet' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The provider could not be reached.';
      steps.push({ step: 'reach', ok: false, message });
      return { ok: false, steps, error: err as never };
    }

    if (config.models.text) {
      try {
        await this.text!.complete(
          config,
          {
            system: 'Reply with JSON only.',
            user: 'Return {"ok":true}',
            temperature: 0,
            maxTokens: 20,
            json: true,
            timeoutMs: 20_000,
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
    supportsJsonMode: false,
    contextWindow() {
      return undefined;
    },
    async complete(config, request_, signal): Promise<TextResult> {
      const system = request_.json
        ? `${request_.system}\n\nRespond with only valid JSON. No prose, no markdown fences.`
        : request_.system;

      const body = {
        model: config.models.text,
        max_tokens: request_.maxTokens,
        temperature: request_.temperature,
        system,
        messages: [{ role: 'user', content: request_.user }],
      };

      const result = await limiterFor(config).run(() =>
        requestJson<MessagesResponse>(`${config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            ...mergeHeaders(config),
          },
          body: JSON.stringify(body),
          timeoutMs: request_.timeoutMs,
          signal,
          label: 'generating text with Anthropic',
        })
      );

      const text = (result.data.content ?? [])
        .filter((part) => part.type === 'text' || part.text)
        .map((part) => part.text ?? '')
        .join('');

      return {
        text,
        jsonMode: false,
        usage: {
          promptTokens: result.data.usage?.input_tokens,
          completionTokens: result.data.usage?.output_tokens,
        },
        model: result.data.model ?? config.models.text,
      };
    },
  },
};

export const ANTHROPIC_CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS;
