import { app, BrowserWindow, shell, ipcMain, session } from 'electron';
import { join, resolve } from 'node:path';
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

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let storageService: StorageService | null = null;
let secretStore: SecretStore | null = null;
let logger: Logger | null = null;

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
  ipcMain.handle('settings:update', async (_event, patch) => requireStorage().updateSettings(patch));
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
      const result = await runTranscription(
        storage,
        resolve(storage.getWorkspaceDir(), 'Models', 'whisper'),
        request,
        (p) => emit({ ...p, phase: 'Transcribing', detail: p.liveText }),
        controller.signal
      );
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
    const ai = await import('@clipwright/ai-core');
    const installed = ai.listInstalledModels(modelsDir());
    return ai.WHISPER_MODELS.map((m) => {
      const found = installed.find((i) => i.name === m.name);
      return { name: m.name, label: m.label, speed: m.speed, expectedBytes: m.bytes, installed: !!found, bytes: found?.bytes ?? 0 };
    });
  });

  ipcMain.handle('models:install', async (event, modelName: string) => {
    const ai = await import('@clipwright/ai-core');
    const controller = new AbortController();
    const sender = event.sender;
    sender.once('destroyed', () => controller.abort());
    const path = await ai.downloadWhisperModel(modelName, modelsDir(), controller.signal, (percent) => {
      if (!sender.isDestroyed()) sender.send('models:progress', { modelName, percent });
    });
    return { path };
  });

  ipcMain.handle('models:delete', async (_event, modelName: string) => {
    const { unlink } = await import('node:fs/promises');
    await unlink(resolve(modelsDir(), `ggml-${modelName}.bin`)).catch(() => undefined);
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
