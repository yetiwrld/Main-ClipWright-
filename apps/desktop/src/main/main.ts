import { app, BrowserWindow, dialog, net, protocol, shell, ipcMain, session } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import {
  buildSecureWindowConfig,
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
  DEV_SERVER_ORIGIN,
  isAllowedExternalUrl,
  resolveNavigation,
} from './security.js';
import { StorageService } from './storage/storage-service.js';
import { Logger } from './storage/logger.js';
import { SecretStore } from './storage/secret-store.js';
import { ingestMedia, type IngestRequest } from './media-pipeline.js';
import { parseScrubFrameUrl, previewSourceFor } from './preview-source.js';
import { SCRUB_MAX_EDGE_PX, pruneScrubDir, scrubFramePath } from './scrub-frames.js';
import { runTranscription, type TranscribeJobRequest } from './transcribe-job.js';
import { ProviderService } from './ai/provider-service.js';
import { ConsentService } from './ai/consent-service.js';
import { ModelService } from './ai/model-service.js';
import { MomentsService } from './ai/moments-service.js';
import { ConnectivityService, type ProcessingMode } from '@clipwright/ai-core';
import { ExportService, type StartExportRequest } from './export/export-service.js';
import { UpdateService } from './updater/update-service.js';
import { resolveTrustedKeys } from './updater/update-config.js';
import { isSmokeTest, runSmokeTestAndExit } from './smoke-test.js';
import { summariseIntegrity, verifyBundledTools } from './bin-integrity.js';
import { UpdateJournalStore, scheduleBootConfirmation } from './updater/update-journal-store.js';
import { YtDlpService } from './updater/ytdlp-service.js';
import { detectPortableMode, executableDir, portableUpdateFolder } from './portable.js';
import {
  BOOT_CONFIRM_MS,
  backupFolderName,
  createUpdateError,
  decideBootAction,
  recoveryMessage,
  type UpdateError,
  type UpdateJournal,
} from '@clipwright/update-core';
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
    const decision = resolveNavigation(url, { isDev });
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') shell.openExternal(url);
  });

  // External links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || DEV_SERVER_ORIGIN;
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

/**
 * SPEC 15 §7.3 — what the Recovery window shows. Built in the main process so
 * the renderer only has to render text it is given.
 */
interface RecoveryView {
  headline: string;
  body: string[];
  canRestorePrevious: boolean;
  fromVersion: string;
  toVersion: string;
}

function buildRecoveryContext(input: {
  journal: UpdateJournal;
  hasPreviousInstaller: boolean;
  hasBackups: boolean;
}): RecoveryView {
  const message = recoveryMessage({
    fromVersion: input.journal.from,
    toVersion: input.journal.to,
    hasPreviousInstaller: input.hasPreviousInstaller,
    hasBackups: input.hasBackups,
    // §7.5: a journal only reaches this state after the new version ran, and the
    // new version is the one that may have migrated the databases.
    migrationRan: true,
  });
  return {
    ...message,
    fromVersion: input.journal.from,
    toVersion: input.journal.to,
  };
}

/** Set when the previous update failed to open the workspace. */
let recoveryContext: RecoveryView | null = null;

/** SPEC 15 §7 — the update journal for this app run. */
let journalStore: UpdateJournalStore | null = null;

/** SPEC 15 §6.3 — whether this is a portable copy, and where its data lives. */
let portableMode: ReturnType<typeof detectPortableMode> | null = null;

/** SPEC 15 §9 — the yt-dlp updater, separate from app updates. */
let ytDlpService: YtDlpService | null = null;

/**
 * SPEC 15 §7.1 — the `prepareInstall` hook handed to the update service. Defined
 * once startup has the workspace paths, and assigns to the service's options
 * through the module-scope reference below.
 */
let updatePrepareInstall: (() => Promise<{ ok: boolean; error?: UpdateError }>) | null = null;

/** Last bundled-tool verification result (SPEC 15 §6.1); null while checking. */
let binIntegrityReport: Awaited<ReturnType<typeof verifyBundledTools>> | null = null;

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

  /*
    Noise reduction (SPEC 12 §6.8).

    A background job in the spec's sense: the handler awaits the render and a non-zero exit comes
    back as `ok: false` with a sentence, rather than throwing, because every failure a user can act
    on here is a setting or the source's own content. A missing file is the exception and throws,
    since the answer to it is a relink and not a different strength.

    The media's derived directory comes from the record, so the cleaned copy lands beside the proxy
    and the peaks rather than in a directory of its own invention — one place per media to look in
    when something has to be cleaned up.
  */
  ipcMain.handle(
    'media:reduceNoise',
    async (
      event,
      request: {
        mediaId: string;
        inUs: number;
        durationUs: number;
        strength: string;
        hasAudio?: boolean;
      },
    ) => {
      const storage = requireStorage();
      const media = storage.getMedia(request.mediaId);
      if (!media) throw new Error('Media not found');
      const { derivedDirectoryFor, runNoiseReduction } = await import('./audio-enhance.js');
      const result = await runNoiseReduction({
        mediaId: request.mediaId,
        sourcePath: media.path,
        /*
          The project's `derived` directory, found from an artefact that already lives there rather
          than rebuilt from a guess.

          `dirname(media.path)` is wrong for a **reference** import — that path is the user's
          footage, and writing beside it would put the app's files in their camera card. The proxy
          lives at `derived/proxy/<mediaId>/`, so two levels up is the directory wanted, and the
          peaks files sit directly inside it. Either is a fact about where this media's derived
          files belong; the arithmetic is in `derivedDirectoryFor`, where it has a test.
        */
        derivedDir: derivedDirectoryFor(media),
        inUs: request.inUs,
        durationUs: request.durationUs,
        strength: request.strength,
        ...(request.hasAudio === undefined ? {} : { hasAudio: request.hasAudio }),
        onProgress: (progress) => {
          /* Sent to the window that asked, so a second window does not show another's progress. */
          if (!event.sender.isDestroyed()) {
            event.sender.send('media:reduceNoiseProgress', {
              mediaId: request.mediaId,
              ...progress,
            });
          }
        },
      });
      return {
        ok: result.ok,
        ...(result.outputPath ? { path: result.outputPath } : {}),
        message: result.message,
        method: result.plan.method,
        strength: result.plan.strength,
        ...(result.cached ? { cached: true } : {}),
      };
    },
  );

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

  /*
    A frame for the timeline's filmstrip (SPEC 09 §19) *and* the preview's scrub cache
    (SPEC 10 §5).

    `timeUs` used to be accepted and ignored, so every filmstrip tile drew the poster and
    a scrub had nothing to read. Now a request past the poster's own instant is extracted
    on demand and kept on disk, content-addressed on a 1/10 s grid — a scrub asks for the
    same frames repeatedly as the pointer passes over them, so the second pass is a file
    read rather than an ffmpeg run.

    Frames go under `derived/scrub/<mediaId>/`, alongside the proxy and the poster, for
    the same reason those do: derived artefacts can be cleared and regenerated, and are
    never what an export reads.
  */
  ipcMain.handle('media:getThumbnail', async (_event, mediaId: string, timeUs: number) => {
    const storage = requireStorage();
    const media = storage.getMedia(mediaId);
    if (!media) throw new Error('Media not found');
    const { readFile, mkdir, readdir, stat, unlink } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { existsSync } = await import('node:fs');

    const read = async (path: string) => {
      const data = await readFile(path);
      return { data: data.toString('base64'), mime: 'image/jpeg' };
    };

    /*
      The poster first. It is what the library shows, and the first filmstrip tile is
      almost always the item's in-point, so this is the common request and it costs no
      extraction at all.
    */
    if (!timeUs && media.thumbPath) {
      try {
        return await read(media.thumbPath);
      } catch {
        // Fall through: a deleted poster is a re-extract, not a failure.
      }
    }
    if (!media.thumbPath) return null;
    const scrubDir = join(dirname(media.thumbPath), 'scrub', mediaId);

    try {
      const cached = scrubFramePath(scrubDir, timeUs);
      if (existsSync(cached)) return await read(cached);

      /* Extracted against the *proxy* when there is one: a scrub frame is 480 px, so
         decoding 4K to produce it is wasted work the proxy has already done. */
      const source = media.proxyPath && existsSync(media.proxyPath) ? media.proxyPath : media.path;
      const target = scrubFramePath(scrubDir, timeUs);
      await mkdir(scrubDir, { recursive: true });
      const { extractFrame } = await import('@clipwright/media-core');
      /*
        `timeUs` is item-local in the caller's terms, so it is clamped by the *item's*
        duration there; here it is floored at zero and trusted otherwise. Asking ffmpeg
        past the end throws rather than writing an empty file.
      */
      await extractFrame(source, target, Math.max(0, timeUs) / 1_000_000, SCRUB_MAX_EDGE_PX);

      /*
        Prune after writing, best-effort. An unbounded cache on a long clip is a
        disk-fill waiting for a user who scrubs a lot; a failure to prune costs disk,
        which is better than failing the request that just succeeded.
      */
      void pruneScrubDir(scrubDir, timeUs, { readdir, stat }, unlink);

      return await read(target);
    } catch {
      /* A frame that cannot be extracted is cosmetic, like a missing poster: the
         filmstrip falls back to the clip colour rather than the preview going blank. */
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

  /*
    Brand kits as files (SPEC 13 §8.2: "Export/Import (`.cwbrand` zip with assets)").

    The archive is built and read in `@clipwright/brand-kits`, which is pure; what belongs here is
    the two things only the main process can do — put a save dialog in front of the user and touch
    the disk. The renderer sends a path-free request and gets a path-free answer, so the file
    picker never has to be reachable from the renderer at all.

    The renderer names the kit and the media ids it uses; **main reads the files**, from the same
    media records the library is built from. That is what makes the archive's contents and the
    library the user is looking at the same thing — and it keeps a renderer request from naming a
    path, which is the whole reason the dialog lives here.
  */
  ipcMain.handle(
    'brandKit:export',
    async (
      _event,
      kit: unknown,
      defaultName: string
    ) => {
      const { writeBrandKitArchive } = await import('@clipwright/brand-kits');
      const { dialog } = await import('electron');
      const { readFile, writeFile } = await import('node:fs/promises');
      const storage = requireStorage();

      /*
        The dialog comes **first**. Building the archive before it would read every logo and intro
        off disk for a user who then types a name and cancels — and a kit with a damaged field
        would raise an error before they had even chosen where to put it. Ask, then do the work.
      */
      const picked = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'Brand kit', extensions: ['cwbrand'] }],
      });
      if (picked.canceled || !picked.filePath) return null;

      /*
        A missing file is not an error here: `fetchAsset` returns `undefined`, and the archive
        reports the id in `missingAssets` so the caller can say which one. Throwing instead would
        make one unplugged drive stop a user exporting a kit that is otherwise complete.
      */
      const fetchAsset = async (assetId: string): Promise<Uint8Array | undefined> => {
        const record = storage.getMedia(assetId);
        if (!record) return undefined;
        try {
          return new Uint8Array(await readFile(record.path));
        } catch {
          return undefined;
        }
      };
      const written = await writeBrandKitArchive(kit as never, { fetchAsset });

      // Electron's dialog returns a path without the extension when the user types a bare name,
      // and a file called `studio` is not one another machine will offer to open.
      const filePath = picked.filePath.toLowerCase().endsWith('.cwbrand')
        ? picked.filePath
        : `${picked.filePath}.cwbrand`;
      await writeFile(filePath, written.bytes);
      logger?.info('Brand kit exported', { path: filePath, missing: written.missingAssets.length });
      return { path: filePath, missingAssets: written.missingAssets };
    }
  );

  ipcMain.handle('brandKit:import', async () => {
    const { readBrandKitArchive } = await import('@clipwright/brand-kits');
    const { dialog } = await import('electron');
    const { readFile } = await import('node:fs/promises');

    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Brand kit', extensions: ['cwbrand'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;

    const bytes = new Uint8Array(await readFile(picked.filePaths[0]!));
    /*
      Read here, not in the renderer: the archive's reader is async and uses
      `DecompressionStream`, and returning bytes over IPC only to decode them there would copy a
      megabyte of logo twice for no benefit. The kit and its assets come back as JSON-safe values.
    */
    const imported = await readBrandKitArchive(bytes);
    logger?.info('Brand kit imported', { path: picked.filePaths[0], missing: imported.missingAssets.length });
    return {
      kit: imported.kit,
      assets: [...imported.assets.entries()].map(([name, data]) => ({
        name,
        data: Buffer.from(data).toString('base64'),
      })),
      missingAssets: imported.missingAssets,
    };
  });

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

  /*
    Restored: the whole AI surface (SPEC 06 & 07).

    Commit 8418bfe ("one model catalogue for setup, settings and the manager") meant to replace the
    three `models:*` handlers that follow with delegating versions. It removed 160 lines from this
    function and added 21 — and the range it deleted took every `ai:*` handler, all six `moments:*`
    handlers and the two progress sinks with it. The services kept being constructed; only their
    registration went.

    Nothing failed loudly, which is why it survived: `requireProviders()`, `requireMoments()` and the
    rest are still there, so the file compiles, and an `ipcMain` channel with no handler is a runtime
    `Error: No handler registered` inside the renderer's promise rather than a build error. Every
    page that talks to a provider, the model manager, the privacy panel and the entire moments
    screen was dead, and no test invoked a bridge method against a real main process.
  */
  // ---- AI providers, models, consent and moments (SPEC 06 & 07) */
  const push = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // Progress is a push, not a poll: the window gets every download and batch tick.
  models?.setProgressSink((event) => push('ai:modelProgress', event));
  moments?.setProgressSink((progress) => push('ai:momentsProgress', progress));

  ipcMain.handle('ai:providers:list', async () => requireProviders().list());
  ipcMain.handle('ai:providers:save', async (_event, input) => requireProviders().save(input));
  ipcMain.handle('ai:providers:remove', async (_event, providerId: string) => {
    requireProviders().remove(providerId);
    return true;
  });
  ipcMain.handle('ai:providers:duplicate', async (_event, providerId: string) => requireProviders().duplicate(providerId));
  ipcMain.handle('ai:providers:test', async (_event, providerId: string) => requireProviders().test(providerId));
  ipcMain.handle('ai:providers:models', async (_event, providerId: string) => requireProviders().listModels(providerId));
  ipcMain.handle('ai:providers:setDefault', async (_event, task, providerId: string | null) =>
    requireProviders().setDefault(task, providerId)
  );
  ipcMain.handle('ai:route', async (_event, task) => {
    const modelSnapshot = requireModels().snapshot();
    const installed = modelSnapshot.whisper.filter((card) => card.status === 'installed');
    let ollamaAvailable = false;
    let ollamaModel: string | undefined;
    try {
      const overview = await requireModels().ollama();
      ollamaAvailable = overview.status.state === 'running' && overview.models.length > 0;
      ollamaModel = overview.models[0]?.name;
    } catch {
      ollamaAvailable = false;
    }
    const state = await requireConnectivity().check();
    return requireProviders().resolveTask(
      task,
      {
        whisperModelInstalled: installed.length > 0,
        whisperModelName: installed[0]?.id,
        ollamaAvailable,
        ollamaModel,
      },
      state
    );
  });
  ipcMain.handle('ai:connectivity', async (_event, force?: boolean) => requireConnectivity().check(force));

  // ---- Consent and privacy */
  ipcMain.handle('ai:consent:prompt', async (_event, providerId: string, category) => {
    const record = requireStorage().listProviders().find((provider) => provider.id === providerId);
    if (!record) throw new Error('That provider no longer exists.');
    let host = record.baseUrl;
    try {
      host = new URL(record.baseUrl).host;
    } catch {
      /* keep the raw address */
    }
    return requireConsents().buildPrompt({
      providerId: record.id,
      providerName: record.name,
      locality: record.locality,
      host,
      category,
    });
  });
  ipcMain.handle('ai:consent:grant', async (_event, decision) => requireConsents().grant(decision));
  ipcMain.handle('ai:consent:revoke', async (_event, providerId: string, category) => {
    requireConsents().revoke(providerId, category);
    return true;
  });
  ipcMain.handle('ai:privacy:overview', async () => requireConsents().overview());
  ipcMain.handle('ai:privacy:clearLog', async () => requireConsents().clearLog());
  ipcMain.handle('ai:privacy:exportCsv', async () => {
    const csv = requireConsents().toCsv();
    const target = await dialog.showSaveDialog({
      title: 'Save data-sent log',
      defaultPath: 'clipwright-data-sent.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (target.canceled || !target.filePath) return null;
    writeFileSync(target.filePath, csv, 'utf8');
    return target.filePath;
  });

  // ---- Local models */
  ipcMain.handle('ai:models:snapshot', async () => requireModels().snapshot());
  ipcMain.handle('ai:models:download', async (_event, modelId: string) => requireModels().downloadWhisper(modelId));
  ipcMain.handle('ai:models:cancel', async (_event, modelId: string) => requireModels().cancelDownload(modelId));
  ipcMain.handle('ai:models:delete', async (_event, modelId: string) => {
    await requireModels().deleteWhisper(modelId);
    return true;
  });
  ipcMain.handle('ai:models:verify', async (_event, modelId: string) => requireModels().verifyWhisper(modelId));
  ipcMain.handle('ai:models:setDefault', async (_event, modelId: string) =>
    requireStorage().updateSettings({ defaultWhisperModel: modelId })
  );
  ipcMain.handle('ai:models:openFolder', async () => {
    const folder = requireModels().snapshot().folders.whisper;
    const error = await shell.openPath(folder);
    return error || folder;
  });
  /*
    `deleteAllModels` has been on the Models page since it was written and had no handler at all —
    `ModelService.deleteAllDownloaded` was never registered, so the confirm dialog's "Delete all"
    rejected with "No handler registered" and the toast showed that sentence to the user. Its own
    bug rather than part of the deletion above: this channel was missing before 8418bfe too.
  */
  ipcMain.handle('ai:models:deleteAll', async () => requireModels().deleteAllDownloaded());
  ipcMain.handle('ai:models:recordSpeed', async (_event, modelId: string, throughputFactor: number) => {
    requireModels().recordSpeed(modelId, throughputFactor);
    return true;
  });

  // ---- Ollama */
  ipcMain.handle('ai:ollama:overview', async () => requireModels().ollama());
  ipcMain.handle('ai:ollama:pull', async (event, modelName: string) => {
    const sender = event.sender;
    await requireModels().pullOllama(modelName, (progress) => {
      if (!sender.isDestroyed()) sender.send('ai:ollamaProgress', progress);
    });
    return true;
  });
  ipcMain.handle('ai:ollama:cancel', async (_event, modelName: string) => requireModels().cancelOllamaPull(modelName));
  ipcMain.handle('ai:ollama:delete', async (_event, modelName: string) => {
    await requireModels().deleteOllama(modelName);
    return true;
  });
  ipcMain.handle('ai:ollama:test', async (_event, modelName: string) => requireModels().testOllama(modelName));
  ipcMain.handle('ai:ollama:setBaseUrl', async (_event, baseUrl: string) =>
    requireStorage().updateSettings({ ollamaBaseUrl: baseUrl.trim() })
  );

  // ---- Moments */
  ipcMain.handle('moments:list', async (_event, projectId: string) => requireMoments().list(projectId));
  ipcMain.handle('moments:analyze', async (_event, request) => requireMoments().analyze(request));
  ipcMain.handle('moments:update', async (_event, projectId: string, patch) =>
    requireMoments().updateMoment(projectId, patch)
  );
  ipcMain.handle('moments:addManual', async (_event, projectId: string, range) =>
    requireMoments().addManualMoment(projectId, range)
  );
  ipcMain.handle('moments:rescore', async (_event, projectId: string, momentId: string) =>
    requireMoments().rescore(projectId, momentId)
  );
  ipcMain.handle('moments:createClips', async (_event, projectId: string, momentIds: string[], options) =>
    requireMoments().createClips(projectId, momentIds, options ?? {})
  );

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

  // ---- yt-dlp updater (SPEC 15 §9) ----
  ipcMain.handle('ytdlp:status', async () => ytDlpService?.describe() ?? null);

  ipcMain.handle('ytdlp:check', async () => {
    if (!ytDlpService) return { kind: 'error', message: 'The yt-dlp updater is not available.' };
    const settings = storageService?.getSettings();
    return ytDlpService.check({
      manual: true,
      autoCheckEnabled: settings?.ytDlpAutoUpdate ?? true,
    });
  });

  ipcMain.handle(
    'ytdlp:update',
    async (_event, input: { downloadUrl: string; expectedSha256: string; version: string }) => {
      if (!ytDlpService) return { ok: false, error: 'The yt-dlp updater is not available.' };
      return ytDlpService.update(input);
    },
  );

  ipcMain.handle('ytdlp:restore-bundled', async () =>
    ytDlpService?.restoreBundled() ?? { ok: false, reason: 'The yt-dlp updater is not available.' },
  );

  // ---- Update recovery (SPEC 15 §7.3–§7.5) ----
  ipcMain.handle('updates:recovery', async () => recoveryContext);

  ipcMain.handle('updates:restore-previous', async () => {
    const context = recoveryContext;
    const store = journalStore;
    if (!context) return { ok: false, error: 'There is nothing to restore.' };
    if (!store) return { ok: false, error: 'The update journal is not available.' };

    const journal = await store.read();
    const installer = journal ? await store.findPreviousInstaller(journal.from) : null;
    if (!installer) {
      return {
        ok: false,
        error: `The installer for ${context.fromVersion} was not kept. Download it from the releases page.`,
      };
    }

    try {
      // §7.5: run the cached installer, then quit. The user sees NSIS's own
      // progress UI, so nothing here pretends to know how far along it is.
      shell.openPath(installer);
      if (journal) {
        await store.write({ ...journal, status: 'rolled-back' });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `The previous version could not be started: ${String(error)}` };
    }
  });

  ipcMain.handle('updates:dismiss-recovery', async () => {
    recoveryContext = null;
    return { ok: true };
  });

  // ---- Bundled tool integrity (SPEC 15 §6.1) ----
  ipcMain.handle('tools:integrity', async () => {
    if (binIntegrityReport) {
      return {
        manifestPresent: binIntegrityReport.manifestPresent,
        enabled: binIntegrityReport.enabled,
        problems: binIntegrityReport.problems,
        summary: summariseIntegrity(binIntegrityReport),
      };
    }
    return null;
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

app.whenReady().then(async () => {
  // SPEC 15 §8.2 step 6: `--smoke-test` proves a *packaged* copy works and then
  // exits, so the release pipeline can refuse a broken installer.
  if (isSmokeTest(process.argv)) {
    const resourcesBin = app.isPackaged
      ? join(process.resourcesPath, 'bin')
      : resolve(join(process.cwd(), 'resources', 'bin'));
    const rendererIndex = app.isPackaged
      ? join(__dirname, '../renderer/index.html')
      : resolve(join(process.cwd(), 'apps', 'desktop', 'dist', 'renderer', 'index.html'));
    await runSmokeTestAndExit({ binDir: resourcesBin, rendererIndexPath: rendererIndex });
  }

  // SPEC 15 §6.3: a portable build with `portable.flag` beside the exe keeps its
  // data next to the exe. Without the flag it behaves exactly like an installed
  // copy and uses %APPDATA%, which is the safer default: moving the exe does not
  // orphan the workspace. This has to run before anything reads a path.
  portableMode = detectPortableMode(executableDir(process.execPath));
  if (portableMode.usesLocalData && portableMode.dataDir) {
    app.setPath('userData', portableMode.dataDir);
    isDev && console.log(`Portable mode: app data in ${portableMode.dataDir}`);
  }

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

  // SPEC 15 §7: read the update journal before the window opens, record this
  // launch, and start the 60-second confirmation timer. A crash state is handed
  // to the renderer so it can show the Recovery window.
  journalStore = new UpdateJournalStore({ workspaceDir: defaultWorkspace, userDataDir: userData });
  let recoveryContext: ReturnType<typeof buildRecoveryContext> | null = null;
  try {
    const journal = await journalStore.read();
    const runningVersion = app.getVersion();

    if (journal && journal.to === runningVersion) {
      const decision = decideBootAction(journal, runningVersion);
      const launched = await journalStore.recordLaunch(runningVersion);
      if (decision.action === 'recovery') {
        recoveryContext = buildRecoveryContext({
          journal: launched ?? journal,
          hasPreviousInstaller: (await journalStore.findPreviousInstaller(journal.from)) !== null,
          hasBackups: existsSync(join(journalStore.updatesDir, backupFolderName(journal.from, journal.startedAt))),
        });
        log.warn('Update recovery needed', { reason: decision.reason });
      } else if (decision.action === 'confirm-pending') {
        // §7.3: 60 seconds of running proves more than a successful launch.
        scheduleBootConfirmation({
          delayMs: BOOT_CONFIRM_MS,
          onConfirm: async () => {
            await journalStore?.recordConfirmed();
            log.info('Update confirmed', { version: runningVersion });
          },
        });
      }
    }

    // Housekeeping is not on the critical path for the window.
    void journalStore.cleanup().catch(() => undefined);
  } catch (error) {
    // A journal problem must never stop the app from opening.
    log.warn('Update journal could not be read', { error: String(error) });
  }

  // SPEC 15 §6.1: verify the bundled binaries before anything spawns them. A
  // replaced ffmpeg is code execution with paths inside the user's workspace, so
  // a mismatch disables that tool rather than running it.
  const binDir = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : resolve(process.cwd(), 'resources', 'bin');

  // SPEC 15 §7.1: prepareInstall runs before the installer does. If it fails,
  // nothing is installed.
  updatePrepareInstall = async () => {
    const store = journalStore;
    if (!store) return { ok: true };
    const from = app.getVersion();
    const to = updateService?.snapshot().release?.version ?? from;

    let backup;
    try {
      backup = await store.backupBeforeInstall(from, new Date().toISOString());
    } catch (error) {
      return {
        ok: false,
        error: createUpdateError('unknown', `Your settings could not be backed up: ${String(error)}`),
      };
    }

    if (backup.failed.length > 0) {
      // A partial backup is not a reason to block a security update, but the
      // user has to be able to find out that one file was not saved.
      logger?.warn('Backup was incomplete before install', { failed: backup.failed });
    }

    // §7.1(c): keep the installer we are running from, so there is a way back.
    const runningInstaller = process.env['PORTABLE_EXECUTABLE_FILE'] ?? app.getPath('exe');
    await store.cachePreviousInstaller(from, runningInstaller).catch(() => false);

    await store.beginInstall(from, to);
    return { ok: true };
  };

  // SPEC 15 §9: yt-dlp has its own updater, its own cadence and its own storage.
  // It writes to user data, never to binDir, which is read-only in a real install.
  ytDlpService = new YtDlpService({ userDataDir: userData, bundledDir: binDir });

  {
    void verifyBundledTools({ binDir }).then((report) => {
      binIntegrityReport = report;
      const summary = summariseIntegrity(report);
      if (summary) {
        logger?.warn('Bundled tool verification problems', {
          problems: report.problems,
          enabled: report.enabled,
        });
      } else {
        logger?.info('Bundled tools verified', { enabled: report.enabled });
      }
    });
  }
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
      // A packaged build trusts only its embedded key (§5); the environment
      // override exists for tests and for a local build with no key yet.
      keys: resolveTrustedKeys(process.env, { allowOverride: !app.isPackaged }),
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
      // §7.1: backups, the cached installer and the journal before anything runs.
      prepareInstall: () => updatePrepareInstall?.() ?? Promise.resolve({ ok: true }),
      // §6.3: a portable copy cannot replace itself.
      isPortable: () => portableMode?.isPortable ?? false,
    });
    startAutomaticUpdateChecks(storage, log);
  }

  /*
    Serves `clipwright-media://media/<mediaId>` from the media registry only, and
    `clipwright-media://scrub/<mediaId>/<sourceUs>` from the scrub-frame cache.

    The scrub branch exists so the preview can show the frame under the playhead as an
    `<img>` instead of waiting for a `<video>` seek — the cache was written for that and had
    no reader. It resolves through the same registry, so a URL can name a *media item* but
    never a path.
  */
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const scrub = parseScrubFrameUrl(request.url);
      if (scrub) {
        const record = requireStorage().getMedia(scrub.mediaId);
        if (!record?.thumbPath) return new Response('Not found', { status: 404 });
        /*
          The file name is derived here from the *registry's* path and a numeric time, never
          from the URL, so the only thing a crafted request could name is a different frame
          of a media item it already knows about. `scrubFramePath` also floors the time, so a
          negative or fractional value cannot escape the directory.
        */
        const dir = join(dirname(record.thumbPath), 'scrub', scrub.mediaId);
        const file = scrubFramePath(dir, scrub.timeUs);
        const { readFile } = await import('node:fs/promises');
        try {
          const data = await readFile(file);
          return new Response(new Uint8Array(data), {
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' },
          });
        } catch {
          /*
            A miss is a normal answer, not an error: the renderer falls back to the video
            element and asks again once the frame has been extracted by the scrub path.
            `404` rather than `500` so the renderer can tell "not yet" from "broken".
          */
          return new Response('Not cached yet', { status: 404 });
        }
      }
      const url = new URL(request.url);
      const mediaId = decodeURIComponent(url.pathname.replace(/\/+$/, '').split('/').pop() ?? '');
      const record = mediaId ? requireStorage().getMedia(mediaId) : undefined;
      if (!record) {
        return new Response('Not found', { status: 404 });
      }
      if (record.status === 'missing') {
        return new Response('This file is no longer at its recorded location.', { status: 410 });
      }
      /*
        This protocol serves the preview only — the exporter reads `record.path` from
        storage directly, so the choice made here cannot reach a render. That is the
        property that lets a proxy be served at all: an export must never be built from
        a transcode.

        Which path to play is a policy question with fallbacks, so it lives in
        `preview-source.ts` where it can be tested; this handler only supplies the two
        facts it cannot know — the user's setting and whether the file is still there.
      */
      const useProxies = requireStorage().getSettings().useProxyPreview !== false;
      const chosen = previewSourceFor(record, {
        useProxies,
        exists: (candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        },
      });
      if (chosen.reason === 'proxy-missing') {
        // Worth a line: it means the derived directory was cleared, which is invisible
        // to the user except as "editing is slow again".
        logger?.info('Preview proxy missing, serving the original', { mediaId });
      }
      return await net.fetch(pathToFileURL(chosen.path).toString(), {
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
  // SPEC 15 §7.1(a): closing every database checkpoints its write-ahead log, so
  // this is what makes "save before installing" true. `quitAndInstall` triggers
  // this handler like any other quit — the installer waits for the process to
  // exit, so there is no window in which a write could still be buffered.
  try {
    storageService?.closeAll();
  } catch {
    /* ignore close errors on quit */
  }
});
