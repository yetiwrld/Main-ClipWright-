import { app, BrowserWindow, dialog, net, protocol, shell, ipcMain, session } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import {
  buildSecureWindowConfig,
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
  isAllowedExternalUrl,
} from './security.js';
import { StorageService } from './storage/storage-service.js';
import { Logger } from './storage/logger.js';
import { SecretStore } from './storage/secret-store.js';
import { ingestMedia, type IngestRequest } from './media-pipeline.js';
import { runTranscription, type TranscribeJobRequest } from './transcribe-job.js';
import { ProviderService } from './ai/provider-service.js';
import { ConsentService } from './ai/consent-service.js';
import { ModelService } from './ai/model-service.js';
import { MomentsService } from './ai/moments-service.js';
import { ConnectivityService, type ProcessingMode } from '@clipwright/ai-core';
import { ExportService, type StartExportRequest } from './export/export-service.js';
import { UpdateService } from './updater/update-service.js';
import { resolveTrustedKeys } from './updater/update-config.js';
import { STARTUP_CHECK_DELAY_MS, autoCheckIntervalMs, shouldAutoCheck } from '@clipwright/update-core';

const isDev = !app.isPackaged;

/**
 * Project media is served over an app-owned scheme instead of raw `file://`:
 * the renderer can only ask for a media id, never for an arbitrary path, and the
 * URL survives both the dev server origin and the packaged app.
 */
const MEDIA_SCHEME = 'clipwright-media';
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
let mainWindow: BrowserWindow | null = null;
let storageService: StorageService | null = null;
let secretStore: SecretStore | null = null;
let logger: Logger | null = null;
let providers: ProviderService | null = null;
let consents: ConsentService | null = null;
let models: ModelService | null = null;
let moments: MomentsService | null = null;
let connectivity: ConnectivityService | null = null;

/** Running long jobs, keyed by the id the renderer uses to cancel them. */
const activeJobs = new Map<string, AbortController>();

// Single instance lock — a second launch focuses the existing window instead
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(): BrowserWindow {
  const preloadPath = resolve(join(__dirname, '../preload/index.cjs'));
  const config = buildSecureWindowConfig(preloadPath, process.argv, !isDev);

  const win = new BrowserWindow({
    ...config,
    width: config.defaultWidth,
    height: config.defaultHeight,
    show: false,
    backgroundColor: '#0E0E0F',
  });

  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
  });

  // CSP enforcement on every response
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDev ? DEV_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY],
      },
    });
  });

  // Navigation guard — only local app content may load in-window
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('app://') && !url.startsWith('http://localhost:5173')) {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) shell.openExternal(url);
    }
  });

  // External links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    void win.loadURL(devUrl);
    if (config.webPreferences.devTools) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(resolve(join(__dirname, '../renderer/index.html')));
  }

  return win;
}

function requireStorage(): StorageService {
  if (!storageService) throw new Error('Storage service not ready');
  return storageService;
}

/** The export queue lives for the whole app run (SPEC 14 §6). */
let exportService: ExportService | null = null;

function requireExportService(): ExportService {
  if (!exportService) throw new Error('Export service not ready');
  return exportService;
}

/** The updater (SPEC 15 §2). One instance for the app run. */
let updateService: UpdateService | null = null;
let updateAutoCheckTimer: ReturnType<typeof setInterval> | null = null;

function requireUpdateService(): UpdateService {
  if (!updateService) throw new Error('Update service not ready');
  return updateService;
}

/** In-memory record of the last check; the settings table is the durable copy. */
let lastUpdateCheckAt: number | null = null;

/**
 * `electron-updater` is required lazily: it reads `app.isPackaged` at import
 * time, and in development it must not try to talk to GitHub at all (§3).
 */
function getElectronUpdater(): import('./updater/update-service.js').UpdaterLike | null {
  if (isDev) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    return autoUpdater as never;
  } catch (error) {
    logger?.warn('electron-updater unavailable', { error: (error as Error).message });
    return null;
  }
}

/**
 * SPEC 15 §3 — automatic checks.
 *
 * Two things matter more than the schedule itself: a startup check must not run
 * for at least 20 s (so it never competes with the app opening), and no check may
 * run more often than the user's interval. `shouldAutoCheck` owns the rule; this
 * only supplies the timer.
 */
function startAutomaticUpdateChecks(storage: StorageService, log: Logger): void {
  const settings = storage.getSettings();
  if (settings.autoCheckUpdates === 'never' || !settings.privacy.updateCheck) {
    log.info('Automatic update checks are off');
    return;
  }
  if (isDev) return;

  const run = (): void => {
    const current = storage.getSettings();
    const service = updateService;
    if (!service) return;
    const due = shouldAutoCheck({
      now: Date.now(),
      lastCheckedAt: lastUpdateCheckAt,
      setting: current.autoCheckUpdates,
    });
    void service.autoCheckIfDue(due).catch((error: unknown) => {
      // Automatic failures are silent for the user (§3) but never swallowed.
      log.warn('Automatic update check failed', { error: (error as Error)?.message });
    });
  };

  // A startup check runs once, well after the window is usable.
  setTimeout(run, STARTUP_CHECK_DELAY_MS)?.unref?.();

  // ...then on the user's interval for the rest of the session.
  const interval = autoCheckIntervalMs(settings.autoCheckUpdates);
  if (interval) {
    updateAutoCheckTimer = setInterval(run, Math.max(interval, 6 * 60 * 60 * 1000));
    updateAutoCheckTimer.unref?.();
  }
}

/** Bytes handed to each provider during this run, for the data-sent log. */
const uploadSizes = new Map<string, number>();

function hostOfProvider(storage: StorageService, providerId: string): string {
  const record = storage.listProviders().find((provider) => provider.id === providerId);
  if (!record) return 'unknown';
  try {
    return new URL(record.baseUrl).host;
  } catch {
    return record.baseUrl;
  }
}

/**
 * Finds the 16 kHz mono WAV for a project, extracting it if the import predates
 * this build. Never falls back to the source video: uploads must be audio only.
 */
async function resolveAudio16k(storage: StorageService, projectId: string, hinted: string): Promise<string> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const derived = join(storage.getProjectDir(projectId), 'derived', 'audio16k.wav');
  if (existsSync(derived)) return derived;
  if (hinted && hinted.toLowerCase().endsWith('.wav') && existsSync(hinted)) return hinted;

  const project = storage.getProject(projectId);
  const mediaId = project?.sourceMediaIds[0];
  const media = mediaId ? storage.getMedia(mediaId) : undefined;
  if (!media) throw new Error('This project has no media to transcribe. Import a video first.');

  const { extractAudio16k } = await import('@clipwright/media-core');
  return extractAudio16k(media.path, join(storage.getProjectDir(projectId), 'derived'), 0);
}

/** Wraps an adapter's transcription capability in the pipeline's provider shape. */
async function buildTranscriptionProvider(
  adapter: Awaited<ReturnType<typeof import('@clipwright/ai-core').getAdapter>>,
  config: import('@clipwright/ai-core').ProviderConfig
) {
  const capability = adapter.transcription;
  if (!capability) return null;
  const sizeKey = config.id;

  return {
    id: config.name,
    supportsWordTimestamps: capability.supportsWordTimestamps,
    maxUploadBytes: capability.maxUploadBytes,
    async transcribe(
      audio: Buffer,
      options: { language: string; prompt: string; signal: AbortSignal }
    ): Promise<{ words: Array<{ text: string; startSec: number; endSec: number; confidence?: number }>; language: string; languageConfidence: number }> {
      uploadSizes.set(sizeKey, (uploadSizes.get(sizeKey) ?? 0) + audio.byteLength);
      const result = await capability.transcribe(config, {
        audio,
        language: options.language,
        prompt: options.prompt,
        timeoutMs: Math.max(config.timeoutMs, 120_000),
        signal: options.signal,
      });
      return {
        words: result.words.map((word) => ({
          text: word.text,
          startSec: word.startSec,
          endSec: word.endSec,
          confidence: word.confidence,
        })),
        language: result.language,
        languageConfidence: result.languageConfidence,
      };
    },
  };
}

function requireProviders(): ProviderService {
  if (!providers) throw new Error('AI services are not ready yet.');
  return providers;
}
function requireConsents(): ConsentService {
  if (!consents) throw new Error('AI services are not ready yet.');
  return consents;
}
function requireModels(): ModelService {
  if (!models) throw new Error('Model manager is not ready yet.');
  return models;
}
function requireMoments(): MomentsService {
  if (!moments) throw new Error('Moment analysis is not ready yet.');
  return moments;
}
function requireConnectivity(): ConnectivityService {
  if (!connectivity) throw new Error('Connectivity check is not ready yet.');
  return connectivity;
}

function registerIPC(): void {
  // ---- Workspace */
  ipcMain.handle('workspace:ensure', async () => {
    const storage = requireStorage();
    storage.initWorkspaceFolders(storage.getWorkspaceDir());
    return { workspaceDir: storage.getWorkspaceDir() };
  });

  ipcMain.handle('workspace:listProjects', async () => requireStorage().listProjects(true));

  ipcMain.handle('workspace:createProject', async (_event, settings) => requireStorage().createProject(settings));

  ipcMain.handle('workspace:getProject', async (_event, projectId: string) => requireStorage().getProject(projectId));

  ipcMain.handle('workspace:updateProject', async (_event, projectId: string, patch) =>
    requireStorage().updateProject(projectId, patch)
  );

  ipcMain.handle('workspace:duplicateProject', async (_event, projectId: string) =>
    requireStorage().duplicateProject(projectId)
  );

  ipcMain.handle('workspace:deleteProject', async (_event, projectId: string, opts) =>
    requireStorage().deleteProject(projectId, opts)
  );

  // ---- Compositions */
  ipcMain.handle('workspace:getCompositions', async (_event, projectId: string) =>
    requireStorage().listCompositions(projectId)
  );

  ipcMain.handle('workspace:getComposition', async (_event, projectId: string, compId: string) =>
    requireStorage().getComposition(projectId, compId)
  );

  ipcMain.handle('workspace:saveComposition', async (_event, projectId: string, comp) =>
    requireStorage().saveComposition(projectId, comp)
  );

  // ---- Journal / checkpoints / recovery */
  ipcMain.handle('workspace:appendJournal', async (_event, projectId: string, entry) => {
    requireStorage().appendJournalEntry(projectId, entry);
    return true;
  });

  ipcMain.handle('workspace:checkpoint', async (_event, projectId: string, compositions, upToSeq?: number) => {
    requireStorage().writeCheckpoint(projectId, compositions, upToSeq);
    return true;
  });

  ipcMain.handle('workspace:checkRecovery', async (_event, projectId: string) =>
    requireStorage().checkProjectRecovery(projectId)
  );

  ipcMain.handle('workspace:replayRecovery', async (_event, projectId: string) =>
    requireStorage().replayRecoveryJournal(projectId)
  );

  ipcMain.handle('workspace:createRestorePoint', async (_event, projectId: string, label: string) =>
    requireStorage().createRestorePoint(projectId, label)
  );

  ipcMain.handle('workspace:listRestorePoints', async (_event, projectId: string) =>
    requireStorage().listRestorePoints(projectId)
  );

  ipcMain.handle('workspace:restoreFromPoint', async (_event, projectId: string, restorePointId: string) =>
    requireStorage().restoreFromPoint(projectId, restorePointId)
  );

  // ---- Project locks */
  ipcMain.handle('workspace:acquireLock', async (_event, projectId: string) =>
    requireStorage().acquireProjectLock(projectId)
  );

  ipcMain.handle('workspace:releaseLock', async (_event, projectId: string) => {
    requireStorage().releaseProjectLock(projectId);
    return true;
  });

  // ---- Media / transcripts / moments / jobs */
  ipcMain.handle('workspace:saveMedia', async (_event, media) => requireStorage().saveMedia(media));
  ipcMain.handle('workspace:listMedia', async () => requireStorage().listMedia());
  ipcMain.handle('workspace:saveTranscript', async (_event, projectId: string, transcript) =>
    requireStorage().saveTranscript(projectId, transcript)
  );
  ipcMain.handle('workspace:getTranscript', async (_event, projectId: string) =>
    requireStorage().getTranscript(projectId)
  );
  ipcMain.handle('workspace:saveMoments', async (_event, projectId: string, moments) =>
    requireStorage().saveMoments(projectId, moments)
  );
  ipcMain.handle('workspace:listMoments', async (_event, projectId: string) =>
    requireStorage().listMoments(projectId)
  );
  ipcMain.handle('workspace:saveJob', async (_event, job) => requireStorage().saveJob(job));
  ipcMain.handle('workspace:listJobs', async () => requireStorage().listJobs());

  // ---- Packages */
  ipcMain.handle('workspace:exportPackage', async (_event, projectId: string, destPath: string, opts) =>
    requireStorage().exportProjectPackage(projectId, destPath, opts)
  );

  ipcMain.handle('workspace:importPackage', async (_event, packPath: string, opts) =>
    requireStorage().importProjectPackage(packPath, opts)
  );

  ipcMain.handle('workspace:relocate', async (_event, targetDir: string, opts) =>
    requireStorage().relocateWorkspace(targetDir, opts)
  );

  // ---- Settings */
  ipcMain.handle('settings:get', async () => requireStorage().getSettings());
  ipcMain.handle('settings:update', async (_event, patch) => {
    const updated = requireStorage().updateSettings(patch);
    // Offline mode must take effect immediately: the connectivity probe stops
    // and the router refuses to send anything.
    if (patch && 'processingMode' in patch) {
      connectivity?.setOfflineMode(updated.processingMode === ('offline' as ProcessingMode));
      connectivity?.invalidate();
    }
    return updated;
  });
  ipcMain.handle('settings:reset', async () => requireStorage().resetSettings());

  // ---- Secret store (never persisted in the workspace) */
  ipcMain.handle('secret:set', async (_event, plainText: string, existingSecretId?: string) => {
    if (!secretStore) throw new Error('Secret store not ready');
    return secretStore.saveSecret(plainText, existingSecretId);
  });

  ipcMain.handle('secret:get', async (_event, secretId: string) => {
    if (!secretStore) throw new Error('Secret store not ready');
    return secretStore.getSecret(secretId);
  });

  ipcMain.handle('secret:delete', async (_event, secretId: string) => {
    if (!secretStore) throw new Error('Secret store not ready');
    secretStore.deleteSecret(secretId);
    return true;
  });

  // ---- Logging */
  ipcMain.handle('log:write', async (_event, level: string, message: string, meta?: Record<string, unknown>) => {
    logger?.log(level as 'error' | 'warn' | 'info' | 'debug', message, meta);
    return true;
  });

  ipcMain.handle('log:recent', async (_event, limit?: number) => logger?.getRecentLines(limit) ?? []);

  // ---- Dialogs */
  ipcMain.handle('dialog:openVideo', async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'mts', 'm2ts', 'ts', '3gp', 'ogv'] },
        { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_event, defaultName: string, filters?: Electron.FileFilter[]) => {
    const { dialog } = await import('electron');
    const result = await dialog.showSaveDialog({ defaultPath: defaultName, filters });
    return result.canceled ? null : result.filePath;
  });

  // ---- Media operations */
  ipcMain.handle('media:probe', async (_event, filePath: string) => {
    const media = await import('@clipwright/media-core');
    return media.probeMedia(filePath);
  });

  ipcMain.handle('media:probeUrl', async (_event, url: string) => {
    const media = await import('@clipwright/media-core');
    const source = media.resolveIngestSource(url);
    if (!source) throw new Error('That link is not supported. Import the file instead.');
    return source.probe(url);
  });

  ipcMain.handle('media:isSupported', async (_event, filePath: string) => {
    const media = await import('@clipwright/media-core');
    return media.isSupportedFile(filePath);
  });

  // ---- Media assets: peaks and thumbnails (SPEC 09 §19) ----
  ipcMain.handle('media:getPeaks', async (_event, mediaId: string) => {
    const storage = requireStorage();
    const media = storage.getMedia(mediaId);
    if (!media) throw new Error('Media not found');
    const { readFile } = await import('node:fs/promises');
    const parse = (buf: Buffer | null) => {
      if (!buf || buf.length === 0) return { min: [], max: [] };
      const count = buf.length / 4;
      const min: number[] = [];
      const max: number[] = [];
      for (let i = 0; i < count; i++) {
        const val = buf.readFloatLE(i * 4);
        // The peaks file stores RMS values; we draw symmetric around zero.
        const abs = Math.abs(val);
        min.push(-abs);
        max.push(abs);
      }
      return { min, max };
    };
    try {
      const [peaks256Raw, peaks4096Raw] = await Promise.all([
        media.peaks256Path ? readFile(media.peaks256Path).catch(() => null) : null,
        media.peaks4096Path ? readFile(media.peaks4096Path).catch(() => null) : null,
      ]);
      return { peaks256: parse(peaks256Raw), peaks4096: parse(peaks4096Raw) };
    } catch {
      return { peaks256: { min: [], max: [] }, peaks4096: { min: [], max: [] } };
    }
  });

  ipcMain.handle('media:getThumbnail', async (_event, mediaId: string, timeUs: number) => {
    const storage = requireStorage();
    const media = storage.getMedia(mediaId);
    if (!media) throw new Error('Media not found');
    const { readFile } = await import('node:fs/promises');
    if (!media.thumbPath) return null;
    try {
      const data = await readFile(media.thumbPath);
      return { data: data.toString('base64'), mime: 'image/jpeg' };
    } catch {
      return null;
    }
  });

  // ---- Transcript export */
  ipcMain.handle(
    'transcript:export',
    async (
      _event,
      transcript: unknown,
      format: 'txt' | 'srt' | 'vtt' | 'json',
      aspect: string,
      defaultName: string
    ) => {
      const ai = await import('@clipwright/ai-core');
      const { dialog } = await import('electron');
      const { writeFile } = await import('node:fs/promises');

      const content = ai.exportTranscript(transcript as never, format, aspect);
      const filters: Record<string, string[]> = {
        txt: ['txt'], srt: ['srt'], vtt: ['vtt'], json: ['json'],
      };

      const picked = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: format.toUpperCase(), extensions: filters[format] ?? ['txt'] }],
      });
      if (picked.canceled || !picked.filePath) return null;

      await writeFile(picked.filePath, content, 'utf8');
      logger?.info('Transcript exported', { format, path: picked.filePath });
      return picked.filePath;
    }
  );

  // ---- Long-running jobs (import + transcription) */
  ipcMain.handle('job:startIngest', async (event, jobId: string, request: IngestRequest) => {
    const storage = requireStorage();
    const controller = new AbortController();
    activeJobs.set(jobId, controller);

    const sender = event.sender;
    const emit = (payload: Record<string, unknown>) => {
      if (!sender.isDestroyed()) sender.send('job:progress', { jobId, ...payload });
    };
    sender.once('destroyed', () => {
      controller.abort();
      activeJobs.delete(jobId);
    });

    try {
      const settings = storage.getSettings();
      const result = await ingestMedia(
        storage,
        request,
        (p) => emit({ percent: p.percent, phase: p.phase, detail: p.detail }),
        controller.signal,
        { alwaysCreateProxy: Boolean(settings.alwaysCreateProxies) }
      );
      emit({ percent: 100, phase: 'Import complete', result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ failed: true, message });
      throw new Error(message);
    } finally {
      activeJobs.delete(jobId);
    }
  });

  ipcMain.handle('job:startTranscribe', async (event, jobId: string, request: TranscribeJobRequest) => {
    const storage = requireStorage();
    const controller = new AbortController();
    activeJobs.set(jobId, controller);

    const sender = event.sender;
    const emit = (payload: Record<string, unknown>) => {
      if (!sender.isDestroyed()) sender.send('job:progress', { jobId, ...payload });
    };
    sender.once('destroyed', () => {
      controller.abort();
      activeJobs.delete(jobId);
    });

    try {
      const ai = await import('@clipwright/ai-core');

      // The 16 kHz mono WAV is what both engines need; the source video is never
      // uploaded, and we do not trust the renderer's path (SPEC 06 §8).
      const audioPath = await resolveAudio16k(storage, request.projectId, request.audioPath);

      const modelSnapshot = models?.snapshot();
      const installedModels = modelSnapshot?.whisper.filter((card) => card.status === 'installed') ?? [];
      const ollamaOverview = await models?.ollama().catch(() => null);
      const route = requireProviders().resolveTask(
        'transcription',
        {
          whisperModelInstalled: installedModels.length > 0,
          whisperModelName: installedModels[0]?.id,
          ollamaAvailable: Boolean(ollamaOverview && ollamaOverview.status.state === 'running' && ollamaOverview.models.length),
          ollamaModel: ollamaOverview?.models[0]?.name,
        },
        connectivity?.peek() ?? null
      );

      if (!route.ok) {
        const message = `${route.message}${route.fix.length ? ` (${route.fix.map((fix) => fix.label).join(', ')})` : ''}`;
        emit({ failed: true, message });
        throw new Error(message);
      }

      let providerHandle: Awaited<ReturnType<typeof buildTranscriptionProvider>> = null;
      let model = request.model;
      let engine: 'whisper-local' | 'online' = 'whisper-local';

      if (route.route === 'provider' && route.providerId) {
        const record = storage.listProviders().find((provider) => provider.id === route.providerId);
        if (!record) throw new Error('That provider no longer exists.');
        const config = requireProviders().toConfig(record);
        providerHandle = await buildTranscriptionProvider(ai.getAdapter(record.kind), config);
        if (!providerHandle) throw new Error(`${record.name} cannot accept audio for transcription.`);
        engine = 'online';
        model = route.model ?? record.models.transcription ?? record.name;
      } else if (route.route === 'whisper') {
        engine = 'whisper-local';
        const preferred = route.model ?? request.model;
        model = installedModels.some((card) => card.id === preferred)
          ? preferred
          : (installedModels[0]?.id ?? preferred);
      } else if (route.route === 'heuristic' || route.route === 'ollama') {
        throw new Error('This task needs a transcription engine, not a language model. Install a Whisper model.');
      }

      emit({ percent: 0, phase: engine === 'online' ? `Transcribing with ${route.providerName ?? 'provider'}` : 'Transcribing' });

      const result = await runTranscription(
        storage,
        resolve(storage.getWorkspaceDir(), 'Models', 'whisper'),
        { ...request, audioPath, engine, model, provider: providerHandle ?? undefined },
        (p) => emit({ ...p, phase: 'Transcribing', detail: p.liveText }),
        controller.signal
      );

      if (engine === 'online' && route.providerId && route.sendsDataOffDevice) {
        const providerId = route.providerId;
        const category = requireProviders().categoryFor('transcription');
        const bytes = uploadSizes.get(providerHandle?.id ?? '') ?? 0;
        uploadSizes.delete(providerHandle?.id ?? '');
        consents?.recordTransfer({
          providerHost: hostOfProvider(storage, providerId),
          task: 'transcription',
          category,
          approxBytes: bytes,
        });
        consents?.consumeOneTime(providerId, category);
      }

      emit({ percent: 100, phase: 'Transcription complete', result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ failed: true, message });
      throw new Error(message);
    } finally {
      activeJobs.delete(jobId);
    }
  });

  ipcMain.handle('job:cancel', async (_event, jobId: string) => {
    const controller = activeJobs.get(jobId);
    if (!controller) return false;
    controller.abort();
    activeJobs.delete(jobId);
    return true;
  });

  // ---- Transcription models */
  const modelsDir = () => resolve(storageService?.getWorkspaceDir() ?? app.getPath('documents'), 'Models', 'whisper');

  ipcMain.handle('models:list', async () => {
    // One source of truth: the model manager's cards, not a second catalogue copy.
    const snapshot = requireModels().snapshot();
    return snapshot.whisper.map((card) => ({
      name: card.id,
      label: card.label,
      speed: card.accuracy ?? 'unrated',
      expectedBytes: card.expectedBytes,
      installed: card.status === 'installed',
      bytes: card.installedBytes,
      compatibility: card.compatibility,
      verified: card.verified,
      status: card.status,
    }));
  });

  ipcMain.handle('models:install', async (_event, modelName: string) => {
    // Queues through the manager so the download resumes, verifies and is
    // reported with real progress rather than a fire-and-forget fetch.
    const result = requireModels().downloadWhisper(modelName);
    return { queued: result.queued, needsBytes: result.needsBytes };
  });

  ipcMain.handle('models:delete', async (_event, modelName: string) => {
    await requireModels().deleteWhisper(modelName);
    return true;
  });

  // ---- App info */
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    workspaceDir: storageService?.getWorkspaceDir() ?? null,
    isDev,
  }));

  ipcMain.handle('app:openPath', async (_event, targetPath: string) => {
    const err = await shell.openPath(targetPath);
    return err === '' ? true : err;
  });

  // ---- Updates (SPEC 15) ----
  ipcMain.handle('update:state', async () => requireUpdateService().snapshot());

  ipcMain.handle('update:check', async (_event, options?: { manual?: boolean }) => {
    const result = await requireUpdateService().check({ manual: options?.manual ?? true });
    return result;
  });

  ipcMain.handle('update:download', async () => requireUpdateService().download());

  ipcMain.handle('update:cancelDownload', async () => {
    requireUpdateService().cancelDownload();
    return requireUpdateService().snapshot();
  });

  ipcMain.handle('update:install', async () => requireUpdateService().installAndRestart());

  ipcMain.handle('update:skip', async () => {
    requireUpdateService().skip();
    return requireUpdateService().snapshot();
  });

  ipcMain.handle('update:remindLater', async () => {
    requireUpdateService().remindLater();
    return requireUpdateService().snapshot();
  });

  ipcMain.handle('update:dismiss', async () => {
    requireUpdateService().dismiss();
    return requireUpdateService().snapshot();
  });

  // ---- Export (SPEC 14) ----
  ipcMain.handle('export:start', async (_event, request: StartExportRequest) => {
    const service = requireExportService();
    const outcome = await service.start(request);
    if (!outcome.ok) {
      // Plain-language refusal (§8) rather than a half-started job.
      return { ok: false, error: outcome.error, action: outcome.action };
    }
    return { ok: true, job: outcome.job, outputPath: outcome.outputPath };
  });

  ipcMain.handle('export:cancel', async (_event, jobId: string) => requireExportService().cancel(jobId));

  ipcMain.handle('export:retry', async (_event, jobId: string) => requireExportService().retry(jobId));

  ipcMain.handle('export:dismiss', async (_event, jobId: string) => requireExportService().dismiss(jobId));

  ipcMain.handle('export:queue', async () => requireExportService().snapshot());

  ipcMain.handle('export:setConcurrency', async (_event, value: number) => {
    requireExportService().setMaxConcurrent(value);
    return requireExportService().getMaxConcurrent();
  });

  ipcMain.handle('export:history', async (_event, projectId?: string) =>
    requireExportService().listHistory(projectId),
  );

  ipcMain.handle('export:job', async (_event, jobId: string) => requireExportService().getJob(jobId) ?? null);

  ipcMain.handle('export:speed', async (_event, projectId?: string) =>
    requireExportService().averageSpeed(projectId),
  );

  ipcMain.handle('export:plan', async (_event, settings: unknown) => {
    const { buildExportPlan } = await import('@clipwright/export-core');
    return buildExportPlan(settings as never);
  });

  ipcMain.handle('export:subtitles', async (_event, settings: unknown) => {
    const { buildExportPlan } = await import('@clipwright/export-core');
    const { buildSubtitleContents } = await import('./export/export-service.js');
    return buildSubtitleContents(buildExportPlan(settings as never));
  });

  ipcMain.handle('export:openFolder', async (_event, filePath: string) => {
    const { dirname } = await import('node:path');
    shell.showItemInFolder(filePath || dirname(filePath));
    return true;
  });
}

app.whenReady().then(() => {
  const defaultWorkspace = resolve(app.getPath('documents'), 'Clipwright Studio');
  const userData = app.getPath('userData');

  logger = new Logger(resolve(userData, 'logs'), isDev);
  secretStore = new SecretStore(userData);
  storageService = new StorageService(defaultWorkspace);

  try {
    storageService.initWorkspaceFolders(defaultWorkspace);
  } catch (err) {
    logger.error('Failed to initialise workspace', { error: String(err) });
  }

  const storage = storageService;
  const secrets = secretStore;
  const log = logger;
  if (storage && secrets && log) {
    providers = new ProviderService(storage, secrets, log);
    consents = new ConsentService(storage, log);
    models = new ModelService(storage, providers, log);
    moments = new MomentsService(storage, providers, models, consents, log);
    connectivity = new ConnectivityService();
    connectivity.setOfflineMode(storage.getSettings().processingMode === 'offline');

    // SPEC 14 §6: the export queue survives window reloads for the whole run and
    // streams progress to every renderer window.
    exportService = new ExportService({
      storage: {
        getWorkspaceDir: () => storage.getWorkspaceDir(),
        getMedia: (mediaId) => storage.getMedia(mediaId),
        saveExportHistory: (record) => storage.saveExportHistory(record),
        listExportHistory: (opts) => storage.listExportHistory(opts),
        averageExportSpeed: (projectId) => storage.averageExportSpeed(projectId),
      },
      onProgress: (progress) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('export:progress', progress);
        }
      },
    });
    // Anything left mid-flight from a previous session is reported honestly
    // rather than silently resumed (§6 "restarted" messaging).
    exportService.markInterrupted();

    // SPEC 15 §2: the updater lives in main and the renderer only sees state.
    updateService = new UpdateService({
      currentVersion: app.getVersion(),
      channel: storage.getSettings().updateChannel,
      keys: resolveTrustedKeys(process.env),
      getUpdater: () => getElectronUpdater(),
      fetch: (url, init) => fetch(url, init) as never,
      cacheDir: join(app.getPath('userData'), 'updates'),
      getLastCheckedAt: () => lastUpdateCheckAt,
      setLastCheckedAt: (at) => {
        lastUpdateCheckAt = at;
      },
      onStateChange: (state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('update:state', state);
        }
      },
      logger: log,
      isInstallerSigned: () => Boolean(process.env.CSC_LINK),
    });
    startAutomaticUpdateChecks(storage, log);
  }

  // Serves `clipwright-media://media/<mediaId>` from the media registry only.
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const mediaId = decodeURIComponent(url.pathname.replace(/\/+$/, '').split('/').pop() ?? '');
      const record = mediaId ? requireStorage().getMedia(mediaId) : undefined;
      if (!record) {
        return new Response('Not found', { status: 404 });
      }
      if (record.status === 'missing') {
        return new Response('This file is no longer at its recorded location.', { status: 410 });
      }
      return await net.fetch(pathToFileURL(record.path).toString(), {
        headers: request.headers,
        method: request.method,
      });
    } catch (error) {
      logger?.warn('Media protocol request failed', { error: String(error) });
      return new Response('Could not read that file.', { status: 500 });
    }
  });

  registerIPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    storageService?.closeAll();
  } catch {
    /* ignore close errors on quit */
  }
});
