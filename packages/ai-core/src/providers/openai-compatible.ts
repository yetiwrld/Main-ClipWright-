/**
 * SPEC 06 §3 — `openai-compatible` adapter.
 *
 * Covers OpenAI itself and every gateway that speaks the same wire format:
 *   POST {base}/chat/completions
 *   POST {base}/audio/transcriptions
 *   GET  {base}/models
 */

import {
  limiterFor,
  mapHttpError,
  mergeHeaders,
  request,
  requestJson,
} from './http.js';
import {
  CONNECT_TIMEOUT_MS,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderConfig,
  type TestResult,
  type TestStepResult,
  type TextRequest,
  type TextResult,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.js';

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

interface TranscriptionResponse {
  text?: string;
  language?: string;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

function textFrom(choice: ChatResponse['choices']): string {
  const content = choice?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('');
  return '';
}

export const openAiCompatibleAdapter: ProviderAdapter = {
  kind: 'openai-compatible',

  capabilities() {
    return ['transcription', 'text'];
  },

  async listModels(config, signal): Promise<ModelInfo[]> {
    const { data } = await requestJson<ModelsResponse>(`${config.baseUrl}/models`, {
      headers: mergeHeaders(config),
      timeoutMs: Math.min(config.timeoutMs, 30_000),
      signal,
      label: 'listing models',
    });
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id }));
  },

  async testConnection(config, signal): Promise<TestResult> {
    const steps: TestStepResult[] = [];
    const started = Date.now();

    // 1. Reach
    try {
      await request(`${config.baseUrl}/models`, {
        headers: mergeHeaders(config),
        timeoutMs: CONNECT_TIMEOUT_MS,
        signal,
        retries: 0,
        label: 'checking the address',
      });
      steps.push({ step: 'reach', ok: true, message: `Reached ${new URL(config.baseUrl).host}` });
    } catch (err) {
      const mapped = err as { message?: string };
      steps.push({ step: 'reach', ok: false, message: mapped.message ?? "Couldn't reach that address." });
      return { ok: false, steps, error: err as never };
    }

    // 2. Authenticate + 3. Model check both come from the same listing call.
    let models: string[] = [];
    try {
      models = (await this.listModels(config, signal)).map((m) => m.id);
      steps.push({ step: 'authenticate', ok: true, message: 'Key accepted' });
    } catch (err) {
      const mapped = err as { message?: string };
      steps.push({ step: 'authenticate', ok: false, message: mapped.message ?? 'The key was rejected.' });
      return { ok: false, steps, error: err as never };
    }

    const chosenModel = config.models.text ?? config.models.transcription;
    if (chosenModel) {
      const found = models.includes(chosenModel);
      steps.push({
        step: 'model',
        ok: found,
        message: found ? `Model "${chosenModel}" is available` : `"${chosenModel}" is not in this provider's model list`,
      });
      if (!found) {
        return {
          ok: false,
          steps,
          error: {
            code: 'model_missing',
            message: `This provider doesn't list a model called "${chosenModel}".`,
            actions: ['pick_model'],
          },
        };
      }
    } else {
      steps.push({ step: 'model', ok: true, message: 'No model chosen yet' });
    }

    // 4. Capability probe — synthetic payload only.
    if (this.capabilities(config).includes('text') && config.models.text) {
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
        steps.push({ step: 'capability', ok: true, message: 'Text generation responded' });
      } catch (err) {
        const mapped = err as { message?: string };
        steps.push({ step: 'capability', ok: false, message: mapped.message ?? 'The capability probe failed.' });
        return { ok: false, steps, error: err as never };
      }
    }

    return { ok: true, steps, latencyMs: Date.now() - started };
  },

  text: {
    supportsJsonMode: true,
    contextWindow() {
      // Not assumed: endpoints do not agree, and guessing would mis-size batches.
      return undefined;
    },
    async complete(config, request_, signal): Promise<TextResult> {
      const body = {
        model: config.models.text,
        messages: [
          { role: 'system', content: request_.system },
          { role: 'user', content: request_.user },
        ],
        temperature: request_.temperature,
        max_tokens: request_.maxTokens,
        ...(request_.json ? { response_format: { type: 'json_object' } } : {}),
        ...(typeof request_.seed === 'number' ? { seed: request_.seed } : {}),
      };

      const result = await limiterFor(config).run(() =>
        requestJson<ChatResponse>(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...mergeHeaders(config) },
          body: JSON.stringify(body),
          timeoutMs: request_.timeoutMs,
          signal,
          label: 'generating text',
        })
      );

      return {
        text: textFrom(result.data.choices),
        jsonMode: request_.json,
        usage: {
          promptTokens: result.data.usage?.prompt_tokens,
          completionTokens: result.data.usage?.completion_tokens,
        },
        model: result.data.model ?? config.models.text,
      };
    },
  },

  transcription: {
    supportsWordTimestamps: true,
    // SPEC 05 §5 — 24 MB keeps us under the common 25 MB endpoint limit.
    maxUploadBytes: 24 * 1024 * 1024,
    async transcribe(config, request_: TranscriptionRequest): Promise<TranscriptionResult> {
      if (!config.models.transcription) {
        throw {
          code: 'model_missing',
          message: 'Choose a transcription model for this provider.',
          actions: ['pick_model'],
        };
      }

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(request_.audio)], { type: 'audio/wav' }), 'chunk.wav');
      form.append('model', config.models.transcription);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (request_.language && request_.language !== 'auto') form.append('language', request_.language);
      if (request_.prompt) form.append('prompt', request_.prompt.slice(-200));

      const response = await limiterFor(config).run(() =>
        request(`${config.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: mergeHeaders(config),
          body: form,
          timeoutMs: request_.timeoutMs,
          signal: request_.signal,
          label: 'transcribing audio',
        })
      );

      if (!response.ok) throw mapHttpError(response.status, 'transcribing audio');

      let parsed: TranscriptionResponse;
      try {
        parsed = JSON.parse(response.body) as TranscriptionResponse;
      } catch {
        throw {
          code: 'bad_response',
          message: 'The provider replied in an unexpected format.',
          actions: ['details'],
          raw: response.body.slice(0, 500),
        };
      }

      if (Array.isArray(parsed.words) && parsed.words.length > 0) {
        return {
          words: parsed.words.map((w) => ({
            text: (w.word ?? '').trim(),
            startSec: w.start ?? 0,
            endSec: w.end ?? w.start ?? 0,
          })),
          language: parsed.language ?? request_.language ?? 'auto',
          languageConfidence: 0.9,
        };
      }

      // Endpoint returned segments only: distribute words proportionally.
      const segments = parsed.segments ?? [];
      const words: TranscriptionResult['words'] = [];
      for (const seg of segments) {
        const parts = (seg.text ?? '').trim().split(/\s+/).filter(Boolean);
        const start = seg.start ?? 0;
        const end = seg.end ?? start;
        const per = (end - start) / Math.max(parts.length, 1);
        parts.forEach((text, i) => {
          words.push({ text, startSec: start + i * per, endSec: start + (i + 1) * per });
        });
      }

      if (words.length === 0 && parsed.text) {
        const parts = parsed.text.trim().split(/\s+/).filter(Boolean);
        const span = Math.max(parts.length * 0.4, 1);
        const per = span / parts.length;
        parts.forEach((text, i) => words.push({ text, startSec: i * per, endSec: (i + 1) * per }));
      }

      return {
        words,
        language: parsed.language ?? request_.language ?? 'auto',
        languageConfidence: 0.8,
      };
    },
  },
};
