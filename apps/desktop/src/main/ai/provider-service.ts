/**
 * SPEC 06 §4 — the provider service.
 *
 * Lives in the main process because it is the only place that may hold an API
 * key. The renderer sees `ProviderRecord`s (masked, never the secret) and asks
 * for actions by id.
 *
 * Responsibilities:
 *  • build a `ProviderConfig` from a stored record + the secret store,
 *  • persist records, keeping the secret out of workspace.db,
 *  • run the "Test connection" step list,
 *  • answer the router's questions about what is available right now.
 */

import { ProviderRecordSchema, uuidv7, type AppSettings, type ProviderRecord } from '@clipwright/project-schema';
import {
  PROVIDER_PRESETS,
  detectOllama,
  getAdapter,
  normaliseBaseUrl,
  resolveProvider,
  type AiTask,
  type Capability,
  type ConnectivityState,
  type Locality,
  type ModelInfo,
  type ProviderConfig,
  type ProviderKind,
  type ProviderPreset,
  type Route,
  type RouterEnvironment,
  type RouterProvider,
  type TestResult,
} from '@clipwright/ai-core';
import type { SecretStore } from '../storage/secret-store.js';
import type { StorageService } from '../storage/storage-service.js';
import type { Logger } from '../storage/logger.js';

export interface ProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  locality?: Locality;
  models?: { transcription?: string; text?: string };
  /** Plaintext key. Omitted on edit means "keep the stored key". */
  apiKey?: string;
  /** Explicitly forget the stored key. */
  clearKey?: boolean;
  timeoutMs?: number;
  maxConcurrent?: number;
  numCtx?: number;
  /** Capabilities the user has confirmed this endpoint offers. */
  capabilities?: Capability[];
}

export interface ProviderSummary {
  record: ProviderRecord;
  /** True only when a secret actually resolved, so the UI can say "Replace key". */
  keyAvailable: boolean;
  adapterCapabilities: Capability[];
}

export interface ProviderListResult {
  providers: ProviderSummary[];
  presets: ProviderPreset[];
  ollama: { state: 'running' | 'not_found' | 'error'; version?: string; host: string; message?: string };
  settings: {
    mode: AppSettings['processingMode'];
    defaultProviders: AppSettings['defaultProviders'];
    ollamaBaseUrl: string;
    llmNumCtx: number;
    llmMaxConcurrent: number;
    providerTimeoutSec: number;
  };
}

const OLLAMA_PRESET_ID = 'ollama';

export class ProviderService {
  private storage: StorageService;
  private secrets: SecretStore;
  private logger: Logger;

  constructor(storage: StorageService, secrets: SecretStore, logger: Logger) {
    this.storage = storage;
    this.secrets = secrets;
    this.logger = logger;
  }

  /* ------------------------------------------------------------------ read */

  listProviderRecords(): ProviderRecord[] {
    return this.storage.listProviders();
  }

  /** Resolves the stored secret into a callable config. Throws when it is missing. */
  toConfig(record: ProviderRecord): ProviderConfig {
    const apiKey = record.secretId ? this.secrets.getSecret(record.secretId) : undefined;
    if (record.hasKey && !apiKey) {
      throw new Error(`The key for ${record.name} is no longer available. Add it again.`);
    }
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      baseUrl: record.baseUrl,
      apiKey,
      models: { ...record.models },
      locality: record.locality,
      timeoutMs: record.timeoutMs,
      maxConcurrent: record.maxConcurrent,
      numCtx: record.numCtx,
    };
  }

  async list(): Promise<ProviderListResult> {
    const settings = this.storage.getSettings();
    const records = this.listProviderRecords();
    const providers: ProviderSummary[] = records.map((record) => ({
      record,
      keyAvailable: record.secretId ? Boolean(this.secrets.getSecret(record.secretId)) : false,
      adapterCapabilities: getAdapter(record.kind).capabilities(this.safeConfig(record)),
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    let ollama: ProviderListResult['ollama'];
    try {
      const status = await detectOllama(settings.ollamaBaseUrl, controller.signal);
      ollama = { state: status.state, version: status.version, host: status.host, message: status.message };
    } catch (error) {
      ollama = {
        state: 'error',
        host: settings.ollamaBaseUrl,
        message: error instanceof Error ? error.message : 'Ollama did not answer.',
      };
    } finally {
      clearTimeout(timer);
    }

    return {
      providers,
      presets: PROVIDER_PRESETS,
      ollama,
      settings: {
        mode: settings.processingMode,
        defaultProviders: settings.defaultProviders,
        ollamaBaseUrl: settings.ollamaBaseUrl,
        llmNumCtx: settings.llmNumCtx,
        llmMaxConcurrent: settings.llmMaxConcurrent,
        providerTimeoutSec: settings.providerTimeoutSec,
      },
    };
  }

  /** A config for read-only questions (capabilities), tolerating a missing key. */
  private safeConfig(record: ProviderRecord): ProviderConfig {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      baseUrl: record.baseUrl,
      models: { ...record.models },
      locality: record.locality,
      timeoutMs: record.timeoutMs,
      maxConcurrent: record.maxConcurrent,
      numCtx: record.numCtx,
    };
  }

  /* ----------------------------------------------------------------- write */

  save(input: ProviderInput): ProviderRecord {
    const settings = this.storage.getSettings();
    const existing = input.id ? this.storage.listProviders().find((p) => p.id === input.id) : undefined;

    const baseUrl = normaliseBaseUrl(input.baseUrl);
    if (!baseUrl) throw new Error('Enter the provider’s base URL.');

    const kind = input.kind;
    const preset = PROVIDER_PRESETS.find((p) => p.kind === kind && p.baseUrl === baseUrl);
    const locality = input.locality ?? preset?.locality ?? this.guessLocality(baseUrl);

    let capabilities: Capability[] = input.capabilities ?? existing?.capabilities ?? preset?.capabilities ?? ['text'];
    capabilities = [...new Set(capabilities)];

    let secretId = existing?.secretId;
    let maskedKeySuffix = existing?.maskedKeySuffix;
    let hasKey = existing?.hasKey ?? false;

    if (input.clearKey) {
      if (secretId) this.secrets.deleteSecret(secretId);
      secretId = undefined;
      maskedKeySuffix = undefined;
      hasKey = false;
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
      // A key typed with a stray newline must still work (SPEC 06 §10).
      const stored = this.secrets.saveSecret(input.apiKey, secretId);
      secretId = stored.secretId;
      maskedKeySuffix = stored.maskedSuffix;
      hasKey = true;
    }

    const needsKey = preset?.needsKey ?? (kind !== 'ollama');
    const status: ProviderRecord['status'] = needsKey && !hasKey ? 'key_missing' : (existing?.status ?? 'not_tested');

    const record = ProviderRecordSchema.parse({
      id: existing?.id ?? uuidv7(),
      name: input.name.trim() || preset?.name || 'Provider',
      kind,
      baseUrl,
      secretId,
      maskedKeySuffix,
      hasKey,
      capabilities,
      models: { ...(existing?.models ?? {}), ...(input.models ?? {}) },
      locality,
      status,
      lastTestedAt: existing?.lastTestedAt,
      lastError: existing?.lastError,
      timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? settings.providerTimeoutSec * 1000,
      maxConcurrent: input.maxConcurrent ?? existing?.maxConcurrent ?? settings.llmMaxConcurrent,
      numCtx: input.numCtx ?? existing?.numCtx ?? settings.llmNumCtx,
    });

    this.storage.saveProvider(record);
    this.logger.info('Provider saved', { id: record.id, kind: record.kind, locality: record.locality });
    return record;
  }

  remove(providerId: string): void {
    const record = this.storage.listProviders().find((p) => p.id === providerId);
    if (record?.secretId) this.secrets.deleteSecret(record.secretId);
    this.storage.deleteProvider(providerId);
    this.storage.deleteConsentsForProvider(providerId);

    // A removed provider must never stay as a task default.
    const settings = this.storage.getSettings();
    const remaining = Object.entries(settings.defaultProviders).filter(([, id]) => id !== providerId);
    if (remaining.length !== Object.entries(settings.defaultProviders).length) {
      this.storage.updateSettings({ defaultProviders: Object.fromEntries(remaining) });
    }
    this.logger.info('Provider removed', { id: providerId });
  }

  setDefault(task: AiTask, providerId: string | null): AppSettings {
    const settings = this.storage.getSettings();
    const next = { ...settings.defaultProviders };
    if (providerId) next[task] = providerId;
    else delete next[task];
    return this.storage.updateSettings({ defaultProviders: next });
  }

  /* ------------------------------------------------------------------ test */

  async test(providerId: string): Promise<{ result: TestResult; record: ProviderRecord }> {
    const record = this.listProviderRecords().find((p) => p.id === providerId);
    if (!record) throw new Error('That provider no longer exists.');

    const adapter = getAdapter(record.kind);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(record.timeoutMs, 15_000));
    let result: TestResult;
    try {
      result = await adapter.testConnection(this.toConfig(record), controller.signal);
    } catch (error) {
      result = {
        ok: false,
        steps: [
          {
            step: 'reach',
            ok: false,
            message: error instanceof Error ? error.message : 'The test could not run.',
          },
        ],
      };
    } finally {
      clearTimeout(timer);
    }

    const updated = this.storage.saveProvider(
      ProviderRecordSchema.parse({
        ...record,
        status: result.ok ? 'connected' : record.hasKey ? 'error' : 'key_missing',
        lastTestedAt: new Date().toISOString(),
        lastError: result.ok ? undefined : (result.error?.message ?? result.steps.find((s) => !s.ok)?.message),
      })
    );

    this.logger.info('Provider test finished', {
      id: providerId,
      ok: result.ok,
      steps: result.steps.map((s) => `${s.step}:${s.ok ? 'ok' : 'fail'}`),
    });
    return { result, record: updated };
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    const record = this.listProviderRecords().find((p) => p.id === providerId);
    if (!record) throw new Error('That provider no longer exists.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(record.timeoutMs, 15_000));
    try {
      return await getAdapter(record.kind).listModels(this.toConfig(record), controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /* --------------------------------------------------------- router input */

  /**
   * Answers "which provider may run this task right now?" for the mode panel and
   * the per-task chips. Local availability (Whisper model, Ollama) is supplied by
   * the caller because it involves disk and network probes of its own.
   */
  resolveTask(
    task: AiTask,
    env: Pick<RouterEnvironment, 'whisperModelInstalled' | 'whisperModelName' | 'ollamaAvailable' | 'ollamaModel'>,
    connectivity: ConnectivityState | null
  ): Route {
    const settings = this.storage.getSettings();

    // "Automatic" must not treat an unreachable network as an online option.
    const mode =
      settings.processingMode === 'automatic' && connectivity && !connectivity.online ? 'offline' : settings.processingMode;

    const routerProviders: RouterProvider[] = this.listProviderRecords().map((record) => ({
      id: record.id,
      name: record.name,
      kind: record.kind,
      capabilities: record.capabilities,
      locality: record.locality,
      status: record.status,
      models: { ...record.models },
      consentGranted: record.locality === 'local' ? true : Boolean(this.storage.findConsent(record.id, this.categoryFor(task))),
    }));

    return resolveProvider(
      task,
      { mode, defaultProviders: settings.defaultProviders },
      routerProviders,
      env
    );
  }

  /** SPEC 06 §8 — what a task sends decides which consent category it needs. */
  categoryFor(task: AiTask): 'transcript' | 'audio' {
    return task === 'transcription' ? 'audio' : 'transcript';
  }

  /** The Ollama endpoint to talk to, taken from settings rather than a constant. */
  ollamaBaseUrl(): string {
    return this.storage.getSettings().ollamaBaseUrl;
  }

  ollamaConfig(model?: string): ProviderConfig {
    const settings = this.storage.getSettings();
    const record = this.listProviderRecords().find((p) => p.kind === 'ollama');
    const baseUrl = record?.baseUrl ?? settings.ollamaBaseUrl;
    const preset = PROVIDER_PRESETS.find((p) => p.id === OLLAMA_PRESET_ID);
    return {
      id: record?.id ?? 'ollama-local',
      name: record?.name ?? preset?.name ?? 'Ollama',
      kind: 'ollama',
      baseUrl,
      models: { text: model ?? record?.models.text },
      locality: record?.locality ?? this.guessLocality(baseUrl),
      timeoutMs: record?.timeoutMs ?? settings.providerTimeoutSec * 1000,
      maxConcurrent: record?.maxConcurrent ?? settings.llmMaxConcurrent,
      numCtx: record?.numCtx ?? settings.llmNumCtx,
    };
  }

  private guessLocality(baseUrl: string): Locality {
    try {
      const host = new URL(baseUrl).hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return 'local';
      if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'network';
    } catch {
      // fall through
    }
    return 'online';
  }
}
