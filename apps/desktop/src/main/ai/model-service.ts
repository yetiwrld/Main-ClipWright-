/**
 * SPEC 06 §7 — the desktop side of the local model manager.
 *
 * Owns the folders, forwards progress to the window, and exposes the Ollama
 * actions (detect, list, pull with streaming progress, delete) on top of the
 * adapter that already speaks that API.
 */

import { join } from 'node:path';
import {
  OLLAMA_SUGGESTIONS,
  ModelManager,
  defaultOllamaBaseUrl,
  deleteOllamaModel,
  detectOllama,
  machineProfile,
  pullOllamaModel,
  type DownloadProgressEvent,
  type MachineProfile,
  type ModelCard,
  type OllamaSuggestion,
  type OllamaStatus,
  type ProviderConfig,
} from '@clipwright/ai-core';
import type { StorageService } from '../storage/storage-service.js';
import type { Logger } from '../storage/logger.js';
import type { ProviderService } from './provider-service.js';

export interface OllamaModelSummary {
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantisation?: string;
  modifiedAt?: string;
}

export interface LocalModelsSnapshot {
  machine: MachineProfile;
  whisper: ModelCard[];
  onnx: ModelCard[];
  disk: { freeGb: number; whisperBytes: number; onnxBytes: number };
  folders: { whisper: string; onnx: string };
}

export interface OllamaOverview {
  status: OllamaStatus;
  models: OllamaModelSummary[];
  suggestions: OllamaSuggestion[];
  /** Warn when the largest model is bigger than ~70 % of free RAM (`06 §7.3`). */
  ramWarningFor: string | null;
  baseUrl: string;
  numCtx: number;
}

export type ModelProgressSink = (event: DownloadProgressEvent) => void;
export type OllamaProgressSink = (event: { model: string; status: string; percent: number }) => void;

export class ModelService {
  private manager: ModelManager;
  private storage: StorageService;
  private logger: Logger;
  private providers: ProviderService;
  private pulls = new Map<string, AbortController>();

  constructor(storage: StorageService, providers: ProviderService, logger: Logger) {
    this.storage = storage;
    this.providers = providers;
    this.logger = logger;
    this.manager = this.createManager();
  }

  private get whisperDir(): string {
    return join(this.storage.getWorkspaceDir(), 'Models', 'whisper');
  }

  private get onnxDir(): string {
    return join(this.storage.getWorkspaceDir(), 'Models', 'onnx');
  }

  private createManager(): ModelManager {
    return new ModelManager({
      whisperDir: this.whisperDir,
      onnxDir: this.onnxDir,
      machine: machineProfile(this.whisperDir),
      speedFactors: () => this.storage.listModelThroughputs('whisper'),
      onInstalled: (modelId, outcome) => {
        this.logger.info('Model installed', { modelId, bytes: outcome.bytes, verified: outcome.verified });
      },
    });
  }

  /**
   * The manager is created once; only the sink is swapped, so a window that
   * closes mid-download cannot lose the queue.
   */
  setProgressSink(sink: ModelProgressSink): void {
    this.manager.setProgressSink(sink);
  }

  snapshot(): LocalModelsSnapshot {
    const machine = machineProfile(this.whisperDir);
    this.manager.setMachine(machine);
    const whisper = this.manager.whisperModelCards();
    const onnx = this.manager.onnxModelCards();
    const sum = (cards: ModelCard[]) =>
      cards.filter((card) => card.status === 'installed').reduce((total, card) => total + card.installedBytes, 0);

    return {
      machine,
      whisper,
      onnx,
      disk: { freeGb: machine.freeDiskGb, whisperBytes: sum(whisper), onnxBytes: sum(onnx) },
      folders: { whisper: this.whisperDir, onnx: this.onnxDir },
    };
  }

  downloadWhisper(modelId: string): { queued: boolean; needsBytes: number } {
    const result = this.manager.queueWhisperDownload(modelId);
    this.logger.info('Model download queued', { modelId, queued: result.queued });
    return result;
  }

  cancelDownload(modelId: string): boolean {
    return this.manager.cancel(modelId);
  }

  async deleteWhisper(modelId: string): Promise<void> {
    await this.manager.deleteWhisperModel(modelId);
    const settings = this.storage.getSettings();
    if (settings.defaultWhisperModel === modelId) {
      this.storage.updateSettings({ defaultWhisperModel: 'auto' });
    }
  }

  async verifyWhisper(modelId: string): Promise<{ ok: boolean; message: string }> {
    return this.manager.verifyWhisperModel(modelId);
  }

  async deleteAllDownloaded(): Promise<{ models: string[]; bytesFreed: number }> {
    const result = await this.manager.deleteAllDownloaded();
    this.logger.info('All downloaded models deleted', { count: result.models.length, bytesFreed: result.bytesFreed });
    if (result.models.length > 0) this.storage.updateSettings({ defaultWhisperModel: 'auto' });
    return result;
  }

  isDownloading(modelId: string): boolean {
    return this.manager.isActive(modelId);
  }

  /** Records a measured throughput so later runs can honestly show "≈ N× real time". */
  recordSpeed(modelId: string, throughputFactor: number): void {
    if (!Number.isFinite(throughputFactor) || throughputFactor <= 0) return;
    this.storage.saveModelThroughput(modelId, Math.round(throughputFactor * 100) / 100);
  }

  /* --------------------------------------------------------------- Ollama */

  async ollama(): Promise<OllamaOverview> {
    const settings = this.storage.getSettings();
    const baseUrl = settings.ollamaBaseUrl || defaultOllamaBaseUrl();
    const config = this.providers.ollamaConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);

    let status: OllamaStatus;
    const models: OllamaModelSummary[] = [];
    try {
      status = await detectOllama(baseUrl, controller.signal);
      if (status.state === 'running') {
        const { getAdapter } = await import('@clipwright/ai-core');
        const listed = await getAdapter('ollama').listModels(config, controller.signal);
        for (const model of listed) {
          models.push({
            name: model.id,
            sizeBytes: model.sizeBytes,
            parameterSize: model.parameterSize,
            quantisation: model.quantisation,
            modifiedAt: model.modifiedAt,
          });
        }
      }
    } catch (error) {
      status = {
        state: 'error',
        host: baseUrl,
        message: error instanceof Error ? error.message : 'Ollama did not answer.',
      };
    } finally {
      clearTimeout(timer);
    }

    const machine = machineProfile(this.whisperDir);
    const biggest = models
      .map((model) => ({ model, gb: (model.sizeBytes ?? 0) / 1024 ** 3 }))
      .sort((a, b) => b.gb - a.gb)[0];
    const ramWarningFor =
      biggest && machine.freeRamGb > 0 && biggest.gb > machine.freeRamGb * 0.7 ? biggest.model.name : null;

    return {
      status,
      models,
      suggestions: OLLAMA_SUGGESTIONS,
      ramWarningFor,
      baseUrl,
      numCtx: settings.llmNumCtx,
    };
  }

  async pullOllama(modelName: string, onProgress: OllamaProgressSink): Promise<void> {
    const trimmed = modelName.trim();
    if (!trimmed) throw new Error('Type the model name exactly as Ollama lists it.');

    const controller = new AbortController();
    this.pulls.set(trimmed, controller);
    const config = this.providers.ollamaConfig();
    try {
      await pullOllamaModel(config, trimmed, controller.signal, (progress) => {
        onProgress({ model: trimmed, status: progress.status, percent: progress.percent });
      });
      this.logger.info('Ollama model pulled', { model: trimmed });
      // Ollama does the verifying; we only record which model is now the default.
      const settings = this.storage.getSettings();
      if (!settings.defaultProviders.moment_analysis) {
        const ollamaRecord = this.storage.listProviders().find((p) => p.kind === 'ollama');
        if (ollamaRecord) {
          this.storage.saveProvider({ ...ollamaRecord, models: { ...ollamaRecord.models, text: trimmed }, status: 'connected' });
        }
      }
    } finally {
      this.pulls.delete(trimmed);
    }
  }

  cancelOllamaPull(modelName: string): boolean {
    const controller = this.pulls.get(modelName);
    if (!controller) return false;
    controller.abort();
    this.pulls.delete(modelName);
    return true;
  }

  async deleteOllama(modelName: string): Promise<void> {
    const config = this.providers.ollamaConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      await deleteOllamaModel(config, modelName, controller.signal);
      this.logger.info('Ollama model deleted', { model: modelName });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Small JSON completion, proving a model can actually answer (`06 §7.3`). */
  async testOllama(modelName: string): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    const { getAdapter } = await import('@clipwright/ai-core');
    const config: ProviderConfig = { ...this.providers.ollamaConfig(modelName), models: { text: modelName } };
    const adapter = getAdapter('ollama');
    if (!adapter.text) return { ok: false, message: 'This provider cannot answer text prompts.' };

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await adapter.text.complete(
        config,
        {
          system: 'Reply with JSON only.',
          user: 'Reply with {"ok":true} and nothing else.',
          temperature: 0,
          maxTokens: 40,
          json: true,
          timeoutMs: 90_000,
        },
        controller.signal
      );
      const latencyMs = Date.now() - started;
      const answered = result.text.includes('{') && result.text.includes('}');
      return {
        ok: answered,
        message: answered
          ? `Answered in ${(latencyMs / 1000).toFixed(1)} s${result.jsonMode ? ' with native JSON mode' : ' (JSON asked for in the prompt)'}.`
          : `The model replied, but not with JSON: “${result.text.slice(0, 80)}”.`,
        latencyMs,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The model did not answer.' };
    } finally {
      clearTimeout(timer);
    }
  }
}
