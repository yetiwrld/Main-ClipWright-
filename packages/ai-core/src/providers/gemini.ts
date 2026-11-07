/**
 * SPEC 06 §3 — Google Generative Language API adapter (text only).
 *
 * Uses `responseMimeType: application/json` when JSON is requested and
 * normalises the reply into the shared TextResult shape.
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

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

interface ListModelsResponse {
  models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
}

function modelPath(id: string): string {
  return id.startsWith('models/') ? id : `models/${id}`;
}

/** Gemini reports its key in the query string; we keep it in a header instead. */
export const geminiAdapter: ProviderAdapter = {
  kind: 'gemini',

  capabilities() {
    return ['text'];
  },

  async listModels(config, signal): Promise<ModelInfo[]> {
    const { data } = await requestJson<ListModelsResponse>(`${config.baseUrl}/v1beta/models`, {
      headers: mergeHeaders(config),
      timeoutMs: Math.min(config.timeoutMs, 30_000),
      signal,
      label: 'listing Gemini models',
    });
    return (data.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter((id) => id.length > 0)
      .map((id) => ({ id }));
  },

  async testConnection(config, signal): Promise<TestResult> {
    const steps: TestStepResult[] = [];
    const started = Date.now();

    let models: ModelInfo[] = [];
    try {
      models = await this.listModels(config, signal);
      steps.push({ step: 'reach', ok: true, message: `Reached ${new URL(config.baseUrl).host}` });
      steps.push({ step: 'authenticate', ok: true, message: 'Key accepted' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The provider could not be reached.';
      steps.push({ step: 'reach', ok: false, message });
      return { ok: false, steps, error: err as never };
    }

    const chosen = config.models.text;
    if (chosen && models.length > 0 && !models.some((m) => m.id === chosen.replace(/^models\//, ''))) {
      steps.push({ step: 'model', ok: false, message: `"${chosen}" is not available for this key` });
      return {
        ok: false,
        steps,
        error: { code: 'model_missing', message: `This key doesn't have access to a model called "${chosen}".`, actions: ['pick_model'] },
      };
    }
    steps.push({ step: 'model', ok: true, message: chosen ? `"${chosen}" is available` : 'No model chosen yet' });

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
    supportsJsonMode: true,
    contextWindow() {
      return undefined;
    },
    async complete(config, request_, signal): Promise<TextResult> {
      const model = config.models.text;
      if (!model) {
        throw { code: 'model_missing', message: 'Choose a model for this provider.', actions: ['pick_model'] };
      }

      const body = {
        systemInstruction: { parts: [{ text: request_.system }] },
        contents: [{ role: 'user', parts: [{ text: request_.user }] }],
        generationConfig: {
          temperature: request_.temperature,
          maxOutputTokens: request_.maxTokens,
          ...(request_.json ? { responseMimeType: 'application/json' } : {}),
        },
      };

      const result = await limiterFor(config).run(() =>
        requestJson<GenerateResponse>(
          `${config.baseUrl}/v1beta/${modelPath(model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...mergeHeaders(config) },
            body: JSON.stringify(body),
            timeoutMs: request_.timeoutMs,
            signal,
            label: 'generating text with Gemini',
          }
        )
      );

      if (result.data.promptFeedback?.blockReason) {
        throw {
          code: 'bad_response',
          message: `Gemini refused to answer (${result.data.promptFeedback.blockReason}).`,
          actions: ['details'],
        };
      }

      const text = (result.data.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');

      return {
        text,
        jsonMode: request_.json,
        usage: {
          promptTokens: result.data.usageMetadata?.promptTokenCount,
          completionTokens: result.data.usageMetadata?.candidatesTokenCount,
        },
        model: result.data.modelVersion ?? model,
      };
    },
  },
};

export const GEMINI_CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS;
