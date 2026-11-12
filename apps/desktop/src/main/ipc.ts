/**
 * Typed IPC surface. Every handler validates its input, calls one service,
 * and returns plain JSON. The renderer never touches the filesystem or DBs.
 */
import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  AppSettingsSchema, CompositionSchema, ProjectSettingsSnapshotSchema, TranscriptWordSchema,
  CaptionChunkSchema, newId, type AppSettings,
} from '@clipwright/project-schema';
import { resolveBinaries, probeInput, parseFfprobeJson } from '@clipwright/media-core';
import { detectOllama, createOpenAiCompatibleProvider } from '@clipwright/ai-core';
import type { StorageService } from './storage.js';
import type { Logger } from './logging.js';
import type { SecretStore } from './secrets.js';
import type { JobRunner } from './jobs.js';
import { Journal, lockStatus, recoveryDir, removeLock, writeLock } from './journal.js';
import { fastFingerprint } from '@clipwright/media-core';
import { listWhisperModels, defaultModel } from './whisper.js';
import { detectFasterWhisper } from './fasterWhisper.js';
import { createClipFromMoment } from './clipService.js';
import { buildExportPlan, type ExportPlanSettings } from '@clipwright/export-core';
import { compositionDurationUs } from '@clipwright/project-schema';
import { initWorkspace, isWorkspace } from './workspace.js';

export interface AppContext {
  storage: StorageService;
  logger: Logger;
  secrets: SecretStore;
  jobs: JobRunner;
  getMainWindow: () => BrowserWindow | null;
  workspaceRoot: () => string;
  setWorkspaceRoot: (root: string) => void;
  version: string;
}

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (message: string) => ({ ok: false as const, error: message });

export const registerIpc = (ctx: AppContext): void => {
  const { storage, logger, secrets } = ctx;
  const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return ok(await fn(...(args as T)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('IPC handler failed', { channel, error: message });
        return fail(friendly(message));
      }
    });
  };
  const friendly = (msg: string): string =>
    msg
      .replace(/ENOENT[^\n]*/g, 'A file or folder could not be found.')
      .replace(/EACCES[^\n]*/g, 'Clipwright does not have permission for that file or folder.')
      .slice(0, 600);

  /* ------------------------------------------------------- window chrome */
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('window:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

  /* --------------------------------------------------------- app/boot */
  handle('app:getBoot', async () => ({
    version: ctx.version,
    workspaceFolder: storage.getSettings().workspaceFolder,
    settings: storage.getSettings(),
    firstRun: !storage.getSettings().firstRunComplete,
    secretsMemoryOnly: secrets.isMemoryOnly,
  }));

  handle('settings:update', async (patch: Partial<AppSettings>) =>
    storage.updateSettings(AppSettingsSchema.partial().parse(patch)));

  handle('settings:pickWorkspaceFolder', async () => {
    const win = ctx.getMainWindow();
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a workspace folder' });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folder = result.filePaths[0]!;
    initWorkspace(folder);
    ctx.setWorkspaceRoot(folder);
    storage.updateSettings({ workspaceFolder: folder });
    return folder;
  });

  handle('app:revealPath', async (path: string) => { shell.showItemInFolder(path); return true; });
  handle('app:openExternal', async (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http(s) links can be opened.');
    await shell.openExternal(url);
    return true;
  });
  handle('app:logRendererError', async (message: string) => { logger.error('Renderer', { detail: message.slice(0, 1000) }); return true; });

  /* ---------------------------------------------------------- projects */
  handle('projects:list', async () => storage.listProjects({ includeArchived: true }));
  handle('projects:get', async (id: string) => storage.getProject(z.string().parse(id)));

  handle('projects:create', async (input: { name: string; settings: unknown; sourceUrl?: string }) => {
    const parsed = ProjectSettingsSnapshotSchema.parse(input.settings);
    const name = z.string().min(1).max(200).parse(input.name);
    const project = storage.createProject({ name, settings: parsed, sourceUrl: input.sourceUrl });
    return project;
  });

  handle('projects:update', async (payload: { id: string; patch: Record<string, unknown> }) => {
    const id = z.string().parse(payload.id);
    const patch = payload.patch ?? {};
    const allowed: Record<string, unknown> = {};
    if (typeof patch['name'] === 'string') allowed['name'] = patch['name'].slice(0, 200);
    if (typeof patch['stage'] === 'string') allowed['stage'] = patch['stage'];
    if (typeof patch['archived'] === 'boolean') allowed['archived'] = patch['archived'];
    return storage.updateProject(id, allowed);
  });

  handle('projects:delete', async (id: string) => {
    z.string().parse(id);
    const project = storage.getProject(id);
    if (project) {
      const dir = join(ctx.workspaceRoot(), 'Projects', id);
      if (existsSync(dir)) await shell.trashItem(dir);
    }
    storage.deleteProject(id);
    return true;
  });

  handle('projects:duplicate', async (id: string) => {
    const project = storage.getProject(id);
    if (!project) throw new Error('Project not found.');
    const copy = storage.createProject({ name: `${project.name} copy`, settings: project.settings, sourceUrl: project.sourceUrl });
    if (project.sourceMediaId) {
      // share media by reference (never copy bytes implicitly)
      linkSourceMedia(storage, copy.id, project.sourceMediaId);
    }
    return copy;
  });

  /* ------------------------------------------------------------- media */
  handle('media:pickVideoFile', async () => {
    const win = ctx.getMainWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      title: 'Choose a video',
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'flv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  handle('media:probePath', async (path: string) => {
    const p = z.string().min(1).parse(path);
    if (!existsSync(p)) throw new Error('That file no longer exists. It may have been moved or deleted.');
    const bins = resolveBinaries();
    const size = statSync(p).size;
    const { probe, warnings } = await probeInput(bins, p, size, 30_000);
    for (const w of warnings) logger.warn('Probe warning', { detail: w });
    const info = parseFfprobeJson(probe, 'probe');
    if (!info.video && info.audio.length === 0) throw new Error('This file has no audio or video streams that Clipwright can read.');
    return info;
  });

  handle('media:importFile', async (input: { path: string; projectId: string; storageMode: 'managed' | 'reference' }) => {
    const p = z.string().min(1).parse(input.path);
    const projectId = z.string().parse(input.projectId);
    if (!existsSync(p)) throw new Error('That file no longer exists.');
    const root = ctx.workspaceRoot();
    const bins = resolveBinaries();
    // probe now so the job queue knows duration/type
    const size = statSync(p).size;
    const { probe } = await probeInput(bins, p, size, 30_000);
    const info = parseFfprobeJson(probe, 'import');
    const kind = info.kind;
    const fingerprint = await fastFingerprint(p, size);

    if (input.storageMode === 'reference') {
      const mediaId = newId();
      storage.registerMedia({
        id: mediaId, kind, storageMode: 'reference', path: p, originalName: basename(p),
        sizeBytes: size, fingerprint, createdAt: Date.now(), info: { ...info, mediaId }, status: 'ok',
      });
      linkSourceMedia(storage, projectId, mediaId);
      storage.enqueueJob({ type: 'thumbnails', mediaId, params: { mediaId, workspaceRoot: root }, priority: 'editing-helper' });
      if (info.audio.length > 0) storage.enqueueJob({ type: 'extract_audio', mediaId, params: { mediaId, workspaceRoot: root }, priority: 'user-blocking' });
      void ctx.jobs.pump();
      return { mediaId, queued: true };
    }

    const mediaId = newId();
    storage.registerMedia({
      id: mediaId, kind, storageMode: 'managed', path: p, originalName: basename(p),
      sizeBytes: size, fingerprint, createdAt: Date.now(), info: { ...info, mediaId }, status: 'ok',
    });
    storage.enqueueJob({ type: 'copy', mediaId, projectId, params: { mediaId, path: p, workspaceRoot: root }, priority: 'user-blocking' });
    storage.enqueueJob({ type: 'probe', mediaId, projectId, params: { mediaId, path: join(root, 'Media', mediaId, `original${extnameSafe(p)}`), workspaceRoot: root }, priority: 'user-blocking' });
    storage.enqueueJob({ type: 'thumbnails', mediaId, params: { mediaId, workspaceRoot: root }, priority: 'editing-helper' });
    if (info.audio.length > 0) storage.enqueueJob({ type: 'extract_audio', mediaId, params: { mediaId, workspaceRoot: root }, priority: 'editing-helper' });
    linkSourceMedia(storage, projectId, mediaId);
    void ctx.jobs.pump();
    return { mediaId, queued: true };
  });

  /* ----------------------------------------------------------- download */
  handle('download:start', async (payload: { projectId: string; url: string; quality?: '720p' | '1080p' | 'best' }) => {
    const projectId = z.string().parse(payload.projectId);
    const url = z.string().url().parse(payload.url);
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) links can be downloaded.');
    const quality = payload.quality === '720p' || payload.quality === '1080p' || payload.quality === 'best' ? payload.quality : '1080p';
    storage.setProjectStage(projectId, 'importing');
    const jobId = storage.enqueueJob({ type: 'download', projectId, params: { projectId, url, quality }, priority: 'user-blocking' });
    void ctx.jobs.pump();
    return jobId;
  });

  handle('transcribe:start', async (payload: { projectId: string }) => {
    const projectId = z.string().parse(payload.projectId);
    const project = storage.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    if (!project.sourceMediaId) throw new Error('This project has no video yet. Import a video first.');
    storage.setProjectStage(projectId, 'transcribing');
    const jobId = storage.enqueueJob({ type: 'transcribe', projectId, params: { projectId }, priority: 'user-blocking' });
    void ctx.jobs.pump();
    return jobId;
  });

  handle('media:get', async (mediaId: string) => {
    const id = z.string().parse(mediaId);
    const media = storage.getMedia(id);
    if (!media) throw new Error('Media not found.');
    return media;
  });

  /* -------------------------------------------------------------- jobs */
  handle('jobs:list', async () => ({ active: storage.listActiveJobs(), recent: storage.listRecentJobs(10) }));
  handle('jobs:cancel', async (id: string) => ctx.jobs.cancel(z.string().parse(id)));

  /* --------------------------------------------------------- transcript */
  handle('transcript:load', async (projectId: string) => storage.loadTranscript(z.string().parse(projectId)));
  handle('transcript:updateWord', async (payload: { projectId: string; wordId: string; text?: string; startUs?: number; endUs?: number }) => {
    const projectId = z.string().parse(payload.projectId);
    const words = storage.loadTranscript(projectId);
    const idx = words.findIndex((w) => w.id === payload.wordId);
    if (idx < 0) throw new Error('That word no longer exists.');
    const word = { ...words[idx]! };
    if (payload.text !== undefined) word.text = payload.text;
    if (payload.startUs !== undefined) word.startUs = Math.max(0, Math.round(payload.startUs));
    if (payload.endUs !== undefined) word.endUs = Math.max(word.startUs + 1, Math.round(payload.endUs));
    words[idx] = TranscriptWordSchema.parse(word);
    storage.replaceTranscript(projectId, words);
    return word;
  });
  handle('transcript:deleteWord', async (payload: { projectId: string; wordId: string }) => {
    const projectId = z.string().parse(payload.projectId);
    const words = storage.loadTranscript(projectId).filter((w) => w.id !== payload.wordId);
    storage.replaceTranscript(projectId, words.map((w, i) => ({ ...w, index: i })));
    return true;
  });

  /* ----------------------------------------------------------- captions */
  handle('captions:load', async (projectId: string) => storage.loadCaptions(z.string().parse(projectId)));
  handle('captions:save', async (payload: { projectId: string; captions: unknown[] }) =>
    storage.replaceCaptions(z.string().parse(payload.projectId), CaptionChunkSchema.array().parse(payload.captions)) ?? true);

  /* ------------------------------------------------------------ moments */
  handle('moments:load', async (projectId: string) => storage.loadMoments(z.string().parse(projectId)));
  handle('moments:setStatus', async (payload: { projectId: string; momentId: string; status: 'candidate' | 'favourite' | 'rejected' | 'clip-created' }) => {
    storage.updateMomentStatus(z.string().parse(payload.projectId), z.string().parse(payload.momentId), payload.status);
    return true;
  });
  handle('moments:run', async (projectId: string) => {
    const id = z.string().parse(projectId);
    storage.setProjectStage(id, 'moments');
    return storage.enqueueJob({ type: 'moments', projectId: id, params: { projectId: id }, priority: 'user-blocking' });
  });
  handle('moments:createClips', async (payload: { projectId: string; momentIds: string[] }) => {
    const projectId = z.string().parse(payload.projectId);
    const ids = z.array(z.string()).min(1).max(20).parse(payload.momentIds);
    const created: Array<{ compId: string; name: string }> = [];
    const errors: Array<{ momentId: string; error: string }> = [];
    for (const momentId of ids) {
      try {
        const res = createClipFromMoment(storage, projectId, momentId);
        if (res) created.push({ compId: res.comp.id, name: res.comp.name });
      } catch (err) {
        errors.push({ momentId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { created, errors };
  });

  /* ------------------------------------------------------- composition */
  handle('composition:list', async (projectId: string) => storage.listCompositions(z.string().parse(projectId)));
  handle('composition:load', async (payload: { projectId: string; compId: string }) =>
    storage.loadComposition(z.string().parse(payload.projectId), z.string().parse(payload.compId)));
  handle('composition:save', async (payload: { projectId: string; comp: unknown }) => {
    const projectId = z.string().parse(payload.projectId);
    const comp = CompositionSchema.parse(payload.comp);
    const dir = recoveryDir(ctx.workspaceRoot(), projectId);
    const journal = new Journal(dir);
    journal.append(comp);
    journal.flush();
    try {
      storage.saveComposition(projectId, { ...comp, updatedAt: Date.now() });
    } catch (err) {
      // journal still holds the composition — crash recovery can replay it
      throw err;
    }
    journal.clear(); // journal consumed by the checkpoint
    return { savedAt: Date.now() };
  });
  handle('composition:delete', async (payload: { projectId: string; compId: string }) => {
    storage.deleteComposition(z.string().parse(payload.projectId), z.string().parse(payload.compId));
    return true;
  });

  handle('recovery:status', async (projectId: string) => {
    const dir = recoveryDir(ctx.workspaceRoot(), z.string().parse(projectId));
    return lockStatus(dir);
  });
  handle('recovery:lock', async (projectId: string) => {
    const dir = recoveryDir(ctx.workspaceRoot(), z.string().parse(projectId));
    return writeLock(dir, ctx.version);
  });
  handle('recovery:unlock', async (projectId: string) => {
    const dir = recoveryDir(ctx.workspaceRoot(), z.string().parse(projectId));
    removeLock(dir);
    return true;
  });

  /* ------------------------------------------------------------ export */
  handle('export:plan', async (payload: { projectId: string; compId: string; settings: ExportPlanSettings }) => {
    const comp = storage.loadComposition(z.string().parse(payload.projectId), z.string().parse(payload.compId));
    if (!comp) throw new Error('Composition not found.');
    return buildExportPlan({ fps: comp.fps, durationUs: compositionDurationUs(comp) }, payload.settings);
  });
  handle('export:start', async (payload: { projectId: string; compId: string; settings: ExportPlanSettings; fileName?: string }) => {
    const projectId = z.string().parse(payload.projectId);
    const compId = z.string().parse(payload.compId);
    return storage.enqueueJob({
      type: 'export', projectId,
      params: { projectId, compId, settings: payload.settings, workspaceRoot: ctx.workspaceRoot(), outputDir: join(ctx.workspaceRoot(), 'Exports', projectId), fileName: payload.fileName ?? '{project}-{clip}-{preset}' },
      priority: 'user-blocking',
    });
  });
  handle('export:history', async () => storage.listExports(50));

  /* ------------------------------------------------------------ models */
  handle('whisper:listModels', async (refresh?: boolean) => {
    const fw = await detectFasterWhisper(refresh === true);
    return {
      binaryFound: !!(process.env['CLIPWRIGHT_WHISPER'] || existsSync(join(process.resourcesPath ?? '', 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'))),
      modelsDir: join(ctx.workspaceRoot(), 'Models', 'whisper'),
      models: listWhisperModels(join(ctx.workspaceRoot(), 'Models', 'whisper')),
      defaultModel: defaultModel(false),
      fasterWhisper: {
        pythonPath: fw.pythonPath,
        pythonLabel: fw.pythonLabel,
        version: fw.version,
        hubCache: fw.hubCache,
        models: fw.models.map((m) => ({ id: m.repoId, name: m.repoId, snapshotPath: m.snapshotPath, sizeBytes: m.sizeBytes })),
      },
    };
  });

  /* ---------------------------------------------------------- providers */
  handle('providers:list', async () => storage.listProviders());
  handle('providers:saveOpenAiCompatible', async (payload: { baseUrl: string; apiKey: string; model: string; label?: string }) => {
    const baseUrl = z.string().url().parse(payload.baseUrl);
    const apiKey = z.string().min(8).parse(payload.apiKey);
    const model = z.string().min(1).parse(payload.model);
    const secretId = secrets.setSecret(apiKey);
    const id = storage.saveProvider({ kind: 'openai-compatible', displayName: payload.label?.trim() || `OpenAI-compatible (${model})`, baseUrl, model, secretId });
    return { id, secretId, maskedSuffix: secrets.maskedSuffix(secretId) };
  });
  handle('providers:delete', async (id: string) => {
    const providerId = z.string().parse(id);
    const record = storage.listProviders().find((p) => p.id === providerId);
    if (record?.secretId) secrets.deleteSecret(record.secretId);
    storage.deleteProvider(providerId);
    return true;
  });
  handle('providers:test', async (id: string) => {
    const providerId = z.string().parse(id);
    const record = storage.listProviders().find((p) => p.id === providerId);
    if (!record || !record.secretId) throw new Error('Provider not found or has no key.');
    const key = secrets.getSecret(record.secretId);
    if (!key) throw new Error('The stored key could not be read.');
    const provider = createOpenAiCompatibleProvider({ baseUrl: record.baseUrl!, apiKey: key, model: record.model!, timeoutMs: 20_000 });
    const reply = await provider.complete('Reply with the single word: ok', { maxTokens: 8, temperature: 0 });
    return { reply: reply.trim().slice(0, 80) };
  });

  handle('ollama:status', async () => {
    const detected = await detectOllama();
    let models: string[] = [];
    if (detected) {
      try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ name: string }> };
          models = (data.models ?? []).map((m) => m.name);
        }
      } catch { /* ollama not reachable */ }
    }
    return { available: !!detected, version: detected?.version ?? null, models };
  });

  logger.info('IPC handlers registered');
};

const extnameSafe = (p: string): string => {
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(p);
  return (m?.[1] ?? '.bin').toLowerCase();
};

const linkSourceMedia = (storage: StorageService, projectId: string, mediaId: string): void => {
  // storage has no typed relink method; use updateProject with sourceMediaId
  storage.updateProject(projectId, { sourceMediaId: mediaId } as Parameters<StorageService['updateProject']>[1]);
};
