/// <reference types="node" />
/**
 * SPEC 06 §7.2 — the model download queue.
 *
 * One download at a time, queued in order, cancellable and resumable. The
 * manager keeps no UI state of its own: it emits progress events and callers
 * rebuild cards from `catalog.ts`, which reads the disk. That way a restart
 * mid-download shows the truth (a `.part` file and its real size).
 */

import path from 'node:path';
import type {
  DownloadOutcome,
  DownloadProgressEvent,
  MachineProfile,
  ModelCard,
  ModelStatus,
} from './types.js';
import { downloadFile, freeDiskGb, removeModelFile, sha256OfFile } from './download.js';
import { findOnnxModel, findWhisperModel, hasRoomForDownload, onnxCards, onnxChecksums, whisperCards, whisperChecksums } from './catalog.js';
import { getProviderPreset } from '../providers/presets.js';

const GB = 1024 ** 3;
const WHISPER_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

interface ActiveDownload {
  modelId: string;
  controllerAbort: AbortController;
  bytesReceived: number;
  totalBytes: number | null;
  percent: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  status: ModelStatus;
}

export interface DownloadJob {
  modelId: string;
  url: string;
  fileName: string;
  expectedBytes: number;
  expectedSha256?: string;
}

export interface ModelManagerOptions {
  /** Absolute path to `Models/whisper`. */
  whisperDir: string;
  /** Absolute path to `Models/onnx`. */
  onnxDir: string;
  machine: MachineProfile;
  /** Called for every progress update; the desktop app forwards this to the window. */
  onProgress?: (event: DownloadProgressEvent) => void;
  /** Called when a file lands and has been verified (or accepted unverified). */
  onInstalled?: (modelId: string, outcome: DownloadOutcome) => void;
  /** Look up a measured speed factor for a model on this machine. */
  speedFactors?: () => Record<string, number>;
}

export class ModelManager {
  private active = new Map<string, ActiveDownload>();
  private queue: DownloadJob[] = [];
  private running: Promise<void> | null = null;
  private verifiedIds = new Set<string>();
  private options: ModelManagerOptions;

  constructor(options: ModelManagerOptions) {
    this.options = options;
  }

  setMachine(machine: MachineProfile): void {
    this.options.machine = machine;
  }

  /** Swaps the progress listener (a closed window must stop receiving events). */
  setProgressSink(sink: ((event: DownloadProgressEvent) => void) | undefined): void {
    this.options.onProgress = sink;
  }

  get whisperDir(): string {
    return this.options.whisperDir;
  }

  get onnxDir(): string {
    return this.options.onnxDir;
  }

  private activeSnapshot() {
    const map = new Map<string, { progress: number; bytesPerSecond: number | null; etaSeconds: number | null; status: ModelStatus }>();
    for (const [id, entry] of this.active) {
      map.set(id, {
        progress: entry.percent,
        bytesPerSecond: entry.bytesPerSecond,
        etaSeconds: entry.etaSeconds,
        status: entry.status,
      });
    }
    return map;
  }

  whisperModelCards(): ModelCard[] {
    return whisperCards({
      dir: this.options.whisperDir,
      machine: this.options.machine,
      checksums: whisperChecksums(),
      active: this.activeSnapshot(),
      speedFactors: this.options.speedFactors?.(),
      verifiedIds: this.verifiedIds,
    });
  }

  onnxModelCards(): ModelCard[] {
    return onnxCards({
      dir: this.options.onnxDir,
      machine: this.options.machine,
      checksums: onnxChecksums(),
      active: this.activeSnapshot(),
      verifiedIds: this.verifiedIds,
    });
  }

  /** Free space on the models volume, used by the storage tab and pre-flight checks. */
  async diskSpace(): Promise<{ freeGb: number; whisperBytes: number; onnxBytes: number }> {
    const freeGb = await freeDiskGb(this.options.whisperDir);
    const sum = (cards: ModelCard[]) =>
      cards.filter((c) => c.status === 'installed').reduce((total, card) => total + card.installedBytes, 0);
    return { freeGb, whisperBytes: sum(this.whisperModelCards()), onnxBytes: sum(this.onnxModelCards()) };
  }

  /**
   * Queues a Whisper download. Returns immediately; progress arrives through
   * `onProgress`. Throws for an unknown model or when there is not enough room.
   */
  queueWhisperDownload(modelId: string): { queued: boolean; needsBytes: number } {
    const model = findWhisperModel(modelId);
    if (!model) throw new Error(`Unknown speech model "${modelId}".`);
    if (this.active.has(modelId) || this.queue.some((job) => job.modelId === modelId)) {
      return { queued: false, needsBytes: model.bytes };
    }
    if (!hasRoomForDownload(model.bytes, this.options.machine)) {
      throw new Error(
        `Not enough free space: ${model.label} needs about ${(model.bytes / GB).toFixed(1)} GB plus 20% working room, and ${this.options.machine.freeDiskGb.toFixed(1)} GB is free.`
      );
    }

    const checksums = whisperChecksums();
    this.queue.push({
      modelId: model.id,
      url: `${WHISPER_BASE_URL}/${model.fileName}`,
      fileName: model.fileName,
      expectedBytes: model.bytes,
      expectedSha256: checksums[model.id],
    });
    void this.pump();
    return { queued: true, needsBytes: model.bytes };
  }

  queueOnnxDownload(modelId: string, baseUrl: string): { queued: boolean } {
    const model = findOnnxModel(modelId);
    if (!model) throw new Error(`Unknown vision model "${modelId}".`);
    const url = `${baseUrl.replace(/\/+$/, '')}/${model.fileName}`;
    this.queue.push({
      modelId: model.id,
      url,
      fileName: model.fileName,
      expectedBytes: model.bytes,
      expectedSha256: onnxChecksums()[model.id],
    });
    void this.pump();
    return { queued: true };
  }

  /** Stops a download. The `.part` file stays so Resume continues from there. */
  cancel(modelId: string): boolean {
    const queuedIndex = this.queue.findIndex((job) => job.modelId === modelId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      return true;
    }
    const active = this.active.get(modelId);
    if (!active) return false;
    active.controllerAbort.abort();
    return true;
  }

  isActive(modelId: string): boolean {
    return this.active.has(modelId);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  async deleteWhisperModel(modelId: string): Promise<void> {
    const model = findWhisperModel(modelId);
    if (!model) throw new Error(`Unknown speech model "${modelId}".`);
    this.cancel(modelId);
    await removeModelFile(this.options.whisperDir, model.fileName);
    this.verifiedIds.delete(modelId);
  }

  async deleteOnnxModel(modelId: string): Promise<void> {
    const model = findOnnxModel(modelId);
    if (!model) throw new Error(`Unknown vision model "${modelId}".`);
    if (model.bundled) throw new Error('That model ships with Clipwright and cannot be deleted.');
    await removeModelFile(this.options.onnxDir, model.fileName);
  }

  /** Re-hashes an installed model against the pinned digest (the "Verify" action). */
  async verifyWhisperModel(modelId: string): Promise<{ ok: boolean; message: string }> {
    const model = findWhisperModel(modelId);
    if (!model) throw new Error(`Unknown speech model "${modelId}".`);
    const expected = whisperChecksums()[model.id];
    if (!expected) {
      return { ok: false, message: 'No published checksum for this file yet, so it cannot be verified.' };
    }
    const filePath = path.join(this.options.whisperDir, model.fileName);
    const actual = await sha256OfFile(filePath);
    const ok = actual.toLowerCase() === expected.toLowerCase();
    if (ok) this.verifiedIds.add(model.id);
    else {
      this.verifiedIds.delete(model.id);
      await removeModelFile(this.options.whisperDir, model.fileName);
    }
    return {
      ok,
      message: ok ? 'Verified against the published checksum.' : 'The file was damaged and has been removed. Try again.',
    };
  }

  /** Runs the queue one download at a time. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = (async () => {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        await this.run(job);
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(job: DownloadJob): Promise<void> {
    const dir = findOnnxModel(job.modelId) ? this.options.onnxDir : this.options.whisperDir;
    const abort = new AbortController();
    const entry: ActiveDownload = {
      modelId: job.modelId,
      controllerAbort: abort,
      bytesReceived: 0,
      totalBytes: job.expectedBytes,
      percent: 0,
      bytesPerSecond: null,
      etaSeconds: null,
      status: 'downloading',
    };
    this.active.set(job.modelId, entry);

    try {
      const outcome = await downloadFile(
        {
          id: job.modelId,
          url: job.url,
          destDir: dir,
          fileName: job.fileName,
          expectedBytes: job.expectedBytes,
          expectedSha256: job.expectedSha256,
          signal: abort.signal,
        },
        (event) => {
          entry.bytesReceived = event.bytesReceived;
          entry.totalBytes = event.totalBytes;
          entry.percent = event.percent ?? entry.percent;
          entry.bytesPerSecond = event.bytesPerSecond;
          entry.etaSeconds = event.etaSeconds;
          entry.status = event.status;
          this.options.onProgress?.(event);
        }
      );

      if (outcome.verified) this.verifiedIds.add(job.modelId);
      this.options.onInstalled?.(job.modelId, outcome);
      this.emit(
        job.modelId,
        'installed',
        outcome.bytes,
        job.expectedBytes,
        100,
        null,
        0,
        outcome.verified,
        path.join(dir, job.fileName)
      );
    } catch (error) {
      const cancelled = (error as Error)?.name === 'DownloadCancelledError';
      this.emit(
        job.modelId,
        cancelled ? 'paused' : 'not_installed',
        entry.bytesReceived,
        job.expectedBytes,
        entry.percent,
        null,
        null,
        null,
        undefined,
        (error as Error)?.message
      );
    } finally {
      this.active.delete(job.modelId);
    }
  }

  private emit(
    id: string,
    status: ModelStatus,
    bytesReceived: number,
    totalBytes: number | null,
    percent: number | null,
    bytesPerSecond: number | null,
    etaSeconds: number | null,
    verified: boolean | null,
    _path?: string,
    error?: string
  ): void {
    this.options.onProgress?.({
      id,
      bytesReceived,
      totalBytes,
      percent,
      bytesPerSecond,
      etaSeconds,
      status,
      resumed: false,
      verified,
      error,
    });
  }
}

/**
 * The Ollama base URL to use when the user has not added a provider for it.
 * Presets are data (`/assets/provider-presets.json`), so the default address is
 * read from there instead of being hard-coded in the UI.
 */
export function defaultOllamaBaseUrl(): string {
  const preset = getProviderPreset('ollama');
  return preset?.baseUrl ?? 'http://localhost:11434';
}
