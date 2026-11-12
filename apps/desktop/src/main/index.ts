/**
 * Clipwright Studio — main process entry.
 * Security: contextIsolation on, sandbox on, node integration off,
 * strict CSP, single instance, typed IPC only.
 */
import { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, session } from 'electron';
import { join, normalize } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tokens } from '@clipwright/design-system/tokens.js';
import { createLogger } from './logging.js';
import { SecretStore } from './secrets.js';
import { StorageService } from './storage.js';
import { JobRunner } from './jobs.js';
import { registerIpc, type AppContext } from './ipc.js';
import { registerJobHandlers } from './runners.js';
import { initWorkspace, defaultWorkspaceFolder, isWorkspace, workspaceLogs } from './workspace.js';

protocol.registerSchemesAsPrivileged([
  { scheme: 'clipwright-media', privileges: { secure: true, supportFetchAPI: true, stream: true } },
]);

const APP_VERSION = app.getVersion();
let mainWindow: BrowserWindow | null = null;
let storage: StorageService | null = null;

/* --------------------------------------------------------- app state */
interface AppState { workspaceFolder: string | null; windowBounds?: { x: number; y: number; width: number; height: number; maximized?: boolean } }
const appStatePath = () => join(app.getPath('userData'), 'app-state.json');
const readAppState = (): AppState => {
  try { return JSON.parse(readFileSync(appStatePath(), 'utf8')) as AppState; } catch { return { workspaceFolder: null }; }
};
const writeAppState = (patch: Partial<AppState>): void => {
  const next = { ...readAppState(), ...patch };
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(appStatePath(), JSON.stringify(next, null, 2), 'utf8');
};

const resolveWorkspaceRoot = (): string | null => {
  const state = readAppState();
  const settings = storage?.getSettings();
  const candidate = settings?.workspaceFolder ?? state.workspaceFolder ?? null;
  if (candidate && isWorkspace(candidate)) return candidate;
  const fallback = defaultWorkspaceFolder();
  if (isWorkspace(fallback)) return fallback;
  return null; // first run — the setup dialog will create it
};

const ensureWorkspace = (): string => {
  let root = resolveWorkspaceRoot();
  if (!root) {
    root = defaultWorkspaceFolder();
    initWorkspace(root);
    storage?.updateSettings({ workspaceFolder: root });
    writeAppState({ workspaceFolder: root });
  }
  return root;
};

/* ------------------------------------------------------------ window */
const createMainWindow = (workspaceRoot: string | null): BrowserWindow => {
  const state = readAppState();
  const bounds = state.windowBounds;
  const win = new BrowserWindow({
    width: bounds?.width ?? 1360,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 1100,
    minHeight: 680,
    frame: false, // custom 40px top bar
    backgroundColor: tokens.color.surfaceApp,
    show: false,
    title: 'Clipwright Studio',
    icon: join(__dirname, process.platform === 'win32' ? '../../assets/ClipWright_Icon.ico' : '../../assets/ClipWright_Icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (bounds?.maximized) win.maximize();
    win.show();
  });

  const saveBounds = () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    writeAppState({ windowBounds: { ...b, maximized: win.isMaximized() } });
  };
  win.on('resize', debounce(saveBounds, 400));
  win.on('move', debounce(saveBounds, 400));
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
};

const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms: number) => {
  let t: NodeJS.Timeout | null = null;
  return (...args: A) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/* -------------------------------------------------------------- boot */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // "Open with Clipwright" — focus and forward the file path
    const fileArg = argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && existsSync(a));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (fileArg) mainWindow.webContents.send('app:openFile', fileArg);
    }
  });

  void app.whenReady().then(() => {
    // CSP for all sessions
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: clipwright-media:; media-src 'self' clipwright-media: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*;",
          ],
        },
      });
    });

    // media protocol: serves files from inside known roots only
    protocol.handle('clipwright-media', (request) => {
      const url = new URL(request.url);
      // clipwright-media://media?p=<encoded-absolute-path>
      const p = url.searchParams.get('p');
      if (!p) return new Response('Bad request', { status: 400 });
      const decoded = normalize(p);
      const root = resolveWorkspaceRoot();
      if (!root) return new Response('No workspace', { status: 403 });
      const rootNorm = normalize(root);
      const allowed = decoded === rootNorm || decoded.startsWith(rootNorm + (process.platform === 'win32' ? '\\' : '/'));
      if (!allowed) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(decoded).toString());
    });

    // early storage so settings exist before the window opens
    const userDataRoot = join(app.getPath('appData'), 'Clipwright Studio');
    mkdirSync(userDataRoot, { recursive: true });
    // workspace (may be null on first run — but we create a default so the app works)
    const root = ensureWorkspace();
    const logger = createLogger(workspaceLogs(root));
    storage = new StorageService(root);
    const secrets = new SecretStore(userDataRoot);

    const jobs = new JobRunner(storage, logger, (channel, payload) => {
      mainWindow?.webContents.send(channel, payload);
    });

    let workspaceRoot = root;
    const ctx: AppContext = {
      storage,
      logger,
      secrets,
      jobs,
      getMainWindow: () => mainWindow,
      workspaceRoot: () => workspaceRoot,
      setWorkspaceRoot: (next: string) => {
        workspaceRoot = next;
        storage?.close();
        storage = new StorageService(next);
        // re-register job handlers against the new storage
        registerJobHandlers(jobs, {
          storage, logger, secrets,
          workspaceRoot: () => next,
          getSettings: () => storage!.getSettings(),
        });
      },
      version: APP_VERSION,
    };

    // crash recovery: interrupted jobs resume as queued
    const revived = storage.reviveInterruptedJobs();
    if (revived > 0) logger.info('Revived interrupted jobs', { count: revived });

    registerJobHandlers(jobs, {
      storage, logger, secrets,
      workspaceRoot: () => workspaceRoot,
      getSettings: () => storage!.getSettings(),
    });
    registerIpc(ctx);

    mainWindow = createMainWindow(root);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(workspaceRoot);
    });

    app.on('before-quit', () => {
      try { storage?.close(); } catch { /* already closed */ }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
