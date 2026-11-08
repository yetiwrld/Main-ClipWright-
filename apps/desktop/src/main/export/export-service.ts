/**
 * SPEC 14 §6 — the main-process export service.
 *
 * Glue between the IPC surface, the queue, the workspace folders and the export
 * history table. It resolves where files go, applies the naming template and
 * clash policy (§3.4), checks free space, and records each finished export.
 *
 * It deliberately does **not** invent jobs: `start()` refuses settings it cannot
 * render honestly (missing media, no space, locked output) with a plain-language
 * reason, per §8.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  buildExportPlan,
  extractCuesFromItems,
  generateSubtitles,
  type ExportJob,
  type ExportSettings,
  type ExportPlan,
  type ValidationReport,
} from '@clipwright/export-core';
import type { ExportHistoryRecord } from '@clipwright/project-schema';
import type { CaptionStyle } from '@clipwright/caption-styles';
import { ExportQueue, cleanupPartialFiles, type QueueSnapshot } from './export-queue.js';
import { solidColourFrameSource, writeSubtitleSidecars, type FrameSource } from './export-runner.js';
import { createDecodeFrameSource } from './decode-frame-source.js';
import { buildAudioMix, planAudioItems } from './audio-mixer.js';

/** Where the caller asked the file to go, and how to handle a name clash. */
export type ClashPolicy = 'auto-number' | 'replace' | 'ask';

export interface StartExportRequest {
  jobId: string;
  settings: ExportSettings;
  /** Display name for the queue row. */
  name: string;
  /** Snapshot label shown in the banner (§6). */
  snapshotLabel?: string;
  /** Output folder; defaults to `<workspace>/Exports/<projectId>/`. */
  outputDir?: string;
  /** Base file name without extension; defaults from the template. */
  fileName?: string;
  clashPolicy?: ClashPolicy;
  /** Run the slow full decode during validation (default true). */
  fullDecode?: boolean;
  /**
   * Project-local caption styles, keyed by id. Omit to use the built-in presets,
   * which is correct for a composition that never edited a style.
   */
  captionStyles?: Record<string, CaptionStyle>;
  /**
   * Frame source factory. Supplied by the caller (render window integration)
   * or omitted, in which case a compositor-free source renders canvas colours.
   */
  createFrameSource?: (plan: ExportPlan) => FrameSource | Promise<FrameSource>;
}

export interface StartExportFailure {
  ok: false;
  /** Plain-language reason (SPEC 14 §8). */
  error: string;
  /** What the user can do about it. */
  action: 'relink' | 'choose-folder' | 'retry' | 'change-settings' | 'none';
}

export interface StartExportSuccess {
  ok: true;
  job: ExportJob;
  outputPath: string;
}

/** Storage the service needs; narrowed to what it actually calls. */
export interface ExportStorageLike {
  getWorkspaceDir(): string;
  getMedia(mediaId: string): { path: string } | undefined;
  saveExportHistory(record: ExportHistoryRecord): ExportHistoryRecord;
  listExportHistory(options?: { projectId?: string; limit?: number }): ExportHistoryRecord[];
  averageExportSpeed(projectId?: string): number | null;
}

export class ExportService {
  private readonly queue: ExportQueue;
  private readonly storage: ExportStorageLike;
  private readonly onProgress: (progress: unknown) => void;
  /**
   * `record()` is async and was fire-and-forgotten, so `whenIdle()` could resolve
   * while the history row was still being written. A caller that reads the
   * history straight after an export — the queue panel does exactly that — would
   * intermittently not see the export that just finished.
   */
  private readonly pendingRecords = new Set<Promise<void>>();

  constructor(options: {
    storage: ExportStorageLike;
    onProgress?: (progress: unknown) => void;
    maxConcurrent?: number;
  }) {
    this.storage = options.storage;
    this.onProgress = options.onProgress ?? (() => undefined);
    this.queue = new ExportQueue({
      maxConcurrent: options.maxConcurrent ?? 1,
      onProgress: (progress) => this.onProgress(progress),
      onFinished: (result) => {
        const recording = this.record(result).finally(() => {
          this.pendingRecords.delete(recording);
        });
        this.pendingRecords.add(recording);
      },
    });
  }

  /** Queue an export, or explain why it cannot start. */
  async start(request: StartExportRequest): Promise<StartExportSuccess | StartExportFailure> {
    const plan = buildExportPlan(request.settings);

    // ---- Missing media blocks the export before it starts (§4.2, §8).
    const missing = this.findMissingMedia(plan);
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          missing.length === 1
            ? "A file used in this clip can't be found."
            : `${missing.length} files used in this clip can't be found.`,
        action: 'relink',
      };
    }

    const outputDir = request.outputDir ?? join(this.storage.getWorkspaceDir(), 'Exports', plan.projectId);
    const fileName = request.fileName ?? defaultFileName(plan, request.name);
    const resolution = await this.resolveOutputPath(
      outputDir,
      fileName,
      plan.format === 'webm' ? '.webm' : '.mp4',
      request.clashPolicy ?? 'auto-number',
    );
    if (!resolution.ok) {
      return { ok: false, error: resolution.error, action: 'choose-folder' };
    }

    // ---- Free-space check (§3.4): estimated size × 1.5, plus the temp file.
    const space = await this.checkSpace(outputDir, plan, resolution.path);
    if (!space.ok) {
      return { ok: false, error: space.error, action: 'choose-folder' };
    }

    const outputPath = resolution.path;

    // ---- Audio: mix it now, so a job never starts without the sound it promised
    // (SPEC 14 §5). The WAV lands next to the temp file and is deleted on success.
    let audioPath: string | undefined;
    let audioWarnings: string[] = [];
    if (plan.includeAudio) {
      const audioItems = planAudioItems(plan, (mediaId) => this.storage.getMedia(mediaId)?.path);
      if (audioItems.length > 0) {
        const mixPath = join(this.storage.getWorkspaceDir(), 'Cache', 'export', `${request.jobId}.wav`);
        audioPath = mixPath;
        try {
          const mix = await buildAudioMix({ plan, items: audioItems, wavPath: mixPath });
          audioWarnings = mix.warnings;
        } catch (err) {
          return {
            ok: false,
            error:
              err instanceof Error && err.message
                ? err.message
                : 'The audio for this clip could not be prepared.',
            action: 'retry',
          };
        }
      }
    }

    const createFrameSource = request.createFrameSource
      ?? ((exportPlan: ExportPlan) => this.defaultFrameSource(exportPlan));

    try {
      const job = this.queue.add({
        id: request.jobId,
        name: request.name,
        settings: request.settings,
        outputPath,
        audioPath,
        audioWarnings,
        createFrameSource,
        snapshotLabel: request.snapshotLabel,
        fullDecode: request.fullDecode ?? true,
        // Without these a burn-in silently uses the built-in preset, so a caption
        // the user restyled exports in the look it started from.
        captionStyles: request.captionStyles as Record<string, CaptionStyle> | undefined,
      });
      // Sidecar subtitles are written next to the finished file on success;
      // see `record`.
      return { ok: true, job, outputPath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'The export could not be started.',
        action: 'retry',
      };
    }
  }

  cancel(jobId: string): boolean {
    return this.queue.cancel(jobId);
  }

  retry(jobId: string): ExportJob | null {
    return this.queue.retry(jobId);
  }

  dismiss(jobId: string): boolean {
    return this.queue.dismiss(jobId);
  }

  getJob(jobId: string): ExportJob | undefined {
    return this.queue.getJob(jobId);
  }

  snapshot(): QueueSnapshot {
    return this.queue.snapshot();
  }

  setMaxConcurrent(value: number): void {
    this.queue.setMaxConcurrent(value);
  }

  getMaxConcurrent(): number {
    return this.queue.getMaxConcurrent();
  }

  markInterrupted(): void {
    this.queue.markInterrupted();
  }

  /**
   * Resolve once the queue is empty *and* every finished job's history row has
   * been written. Without the second half this returned early under load.
   */
  async whenIdle(): Promise<void> {
    await this.queue.whenIdle();
    while (this.pendingRecords.size > 0) {
      await Promise.all([...this.pendingRecords]);
    }
  }

  listHistory(projectId?: string): ExportHistoryRecord[] {
    return this.storage.listExportHistory(projectId ? { projectId } : {});
  }

  /** Average measured speed for this machine, for the dialog's time estimate. */
  averageSpeed(projectId?: string): number | null {
    return this.storage.averageExportSpeed(projectId);
  }

  /** Remove stale `.partial` files from this project's export folder. */
  async cleanup(projectId?: string): Promise<void> {
    const base = join(this.storage.getWorkspaceDir(), 'Exports');
    await cleanupPartialFiles(projectId ? join(base, projectId) : base);
  }

  /**
   * The default frame source.
   *
   * With video on the timeline this decodes the real footage through ffmpeg
   * (SPEC 14 §4.2) and composites it topmost-wins. With no video it renders the
   * canvas background colour. Either way the bytes in the file are produced
   * here and measured afterwards; the compositor's text/effects/transitions are
   * still to come, which `docs/export.md` states plainly.
   */
  private defaultFrameSource(plan: ExportPlan): FrameSource {
    const hasVideo = plan.items.some(
      (item) => (item.type === 'video' || item.type === 'image') && item.mediaId,
    );
    if (hasVideo) {
      return createDecodeFrameSource({
        plan,
        resolveMediaPath: (mediaId) => this.storage.getMedia(mediaId)?.path,
      });
    }
    return solidColourFrameSource({ width: plan.width, height: plan.height, luma: 16, chroma: 128 });
  }

  private findMissingMedia(plan: ExportPlan): string[] {
    const missing: string[] = [];
    for (const item of plan.items) {
      if (!item.mediaId) continue;
      const media = this.storage.getMedia(item.mediaId);
      if (!media || !existsSync(media.path)) missing.push(item.mediaId);
    }
    return missing;
  }

  /** Apply the clash policy and make sure the folder exists (§3.4). */
  private async resolveOutputPath(
    outputDir: string,
    baseName: string,
    extension: string,
    policy: ClashPolicy,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    try {
      await mkdir(outputDir, { recursive: true });
    } catch {
      return { ok: false, error: `Clipwright can't write to ${outputDir}.` };
    }
    const sanitised = sanitiseFileName(baseName);
    const candidate = join(outputDir, `${sanitised}${extension}`);
    if (!existsSync(candidate)) return { ok: true, path: candidate };
    if (policy === 'replace') return { ok: true, path: candidate };
    // auto-number (and "ask", which the UI resolves before calling us)
    for (let counter = 2; counter < 1000; counter += 1) {
      const numbered = join(outputDir, `${sanitised} ${counter}${extension}`);
      if (!existsSync(numbered)) return { ok: true, path: numbered };
    }
    return { ok: false, error: `There are too many files named ${sanitised} in that folder.` };
  }

  /** Estimated size × 1.5 must fit, with a small floor for the temp file. */
  private async checkSpace(
    outputDir: string,
    plan: ExportPlan,
    _outputPath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let freeBytes: number;
    try {
      const fsStats = await statfs(outputDir);
      freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
    } catch {
      // Cannot measure (some network shares): do not block the export.
      return { ok: true };
    }
    const estimatedBytes = estimateOutputBytes(plan);
    const requiredBytes = estimatedBytes * 1.5 + 64 * 1024 * 1024;
    if (freeBytes < requiredBytes) {
      return {
        ok: false,
        error: `Not enough disk space: ${formatBytes(requiredBytes)} needed, ${formatBytes(freeBytes)} free.`,
      };
    }
    return { ok: true };
  }

  /** Persist a finished export and write any subtitle sidecars (§6, §4.4). */
  private async record(result: {
    job: ExportJob;
    outputPath: string;
    validation: ValidationReport | null;
    plan: ExportPlan;
    elapsedMs: number;
    speedFactor: number;
    sizeBytes: number;
    status: 'verified' | 'warnings' | 'failed' | 'cancelled';
  }): Promise<void> {
    let sizeBytes = result.sizeBytes;
    if (result.status !== 'cancelled' && result.status !== 'failed') {
      const stat2 = await stat(result.outputPath).catch(() => null);
      if (stat2) sizeBytes = stat2.size;
      // Sidecars only for a file we actually published.
      if (result.plan.saveSubtitles) {
        const cues = extractCuesFromItems(result.plan.items as never);
        if (cues.length > 0) await writeSubtitleSidecars(result.plan, result.outputPath).catch(() => undefined);
      }
    }

    const record: ExportHistoryRecord = {
      id: result.job.id,
      projectId: result.plan.projectId,
      compId: result.plan.compositionId,
      outputPath: result.outputPath,
      name: result.job.name,
      status: result.status,
      verdict: result.job.verdict ?? '',
      settings: result.job.settingsSnapshot,
      validationReport: result.validation ?? undefined,
      presetLabel: `${result.plan.width}×${result.plan.height} · ${result.plan.fps} fps`,
      width: result.plan.width,
      height: result.plan.height,
      fps: result.plan.fps,
      durationSeconds: result.plan.durationSeconds,
      sizeBytes,
      elapsedMs: result.elapsedMs,
      speedFactor: result.speedFactor,
      createdAt: new Date().toISOString(),
      fileMissing: false,
    };
    try {
      this.storage.saveExportHistory(record);
    } catch {
      // History is a convenience; never fail a good export over it.
    }

    // The mix WAV can be as large as duration x 48000 x 8 bytes (§5.2); it has
    // done its job once the file is published or the job is finished.
    await rm(join(this.storage.getWorkspaceDir(), 'Cache', 'export', `${result.job.id}.wav`), {
      force: true,
    }).catch(() => undefined);
  }
}

/** Default file name from the §3.4 template `{project}-{clip}-{preset}`. */
export function defaultFileName(plan: ExportPlan, clipName: string): string {
  const project = shortId(plan.projectId);
  const clip = sanitiseFileName(clipName) || 'clip';
  return `${project}-${clip}-${plan.width}x${plan.height}`;
}

/**
 * Apply the naming template.
 *
 * Tokens: `{project} {clip} {date} {time} {res} {fps} {aspect} {n}` (§3.4).
 */
export function applyNameTemplate(
  template: string,
  values: {
    project: string;
    clip: string;
    width: number;
    height: number;
    fps: number;
    aspect: string;
    index?: number;
    now?: Date;
  },
): string {
  const now = values.now ?? new Date();
  const replacements: Record<string, string> = {
    '{project}': values.project,
    '{clip}': values.clip,
    '{date}': `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    '{time}': `${pad2(now.getHours())}${pad2(now.getMinutes())}`,
    '{res}': `${values.width}x${values.height}`,
    '{fps}': String(values.fps),
    '{aspect}': values.aspect.replace(':', 'x'),
    '{n}': String(values.index ?? 1),
  };
  let result = template;
  for (const [token, replacement] of Object.entries(replacements)) {
    result = result.split(token).join(replacement);
  }
  return sanitiseFileName(result);
}

/** Windows-illegal characters become `-`; the result is shown before export. */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    // Windows reserves these names regardless of extension.
    .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i, '$1-')
    .replace(/[. ]+$/, '');
  return cleaned || 'clip';
}

/** Rough output size from the bitrate table, for the space check and estimate. */
export function estimateOutputBytes(plan: ExportPlan): number {
  const videoMbps = plan.videoBitrate ?? qualityBitrate(plan);
  const audioKbps = plan.includeAudio ? plan.audioBitrate : 0;
  const bitsPerSecond = videoMbps * 1_000_000 + audioKbps * 1_000;
  return Math.round((bitsPerSecond * plan.durationSeconds) / 8);
}

/** Resolution × fps lookup used when no bitrate was specified (§3.4). */
export function qualityBitrate(plan: ExportPlan): number {
  const qualityScale: Record<string, number> = { draft: 1.6, standard: 4, high: 7.5, maximum: 12 };
  // Scale from a 1080p30 baseline by pixel count and frame rate.
  const baselinePixels = 1920 * 1080;
  const scale = (plan.width * plan.height) / baselinePixels;
  const fpsScale = plan.fps / 30;
  return Math.max(0.5, qualityScale[plan.quality] * scale * fpsScale);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Subtitle sidecar contents without touching disk (used by the IPC preview). */
export function buildSubtitleContents(plan: ExportPlan): { srt: string | null; vtt: string | null } {
  const cues = extractCuesFromItems(plan.items as never);
  return {
    srt: plan.subtitleFormats.includes('srt') ? generateSubtitles(cues, 'srt') : null,
    vtt: plan.subtitleFormats.includes('vtt') ? generateSubtitles(cues, 'vtt') : null,
  };
}

/** Resolve a relative output folder against the workspace. */
export function resolveOutputDir(workspaceDir: string, requested: string | undefined, projectId: string): string {
  if (!requested) return join(workspaceDir, 'Exports', projectId);
  return resolve(workspaceDir, requested);
}

export { basename, dirname, extname };
