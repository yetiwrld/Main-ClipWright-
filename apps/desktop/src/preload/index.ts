/**
 * Preload — the only bridge between renderer and main.
 * Exposes a minimal, typed API. No Node APIs leak into the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args);

const on = (channel: string, listener: (payload: unknown) => void): (() => void) => {
  const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const api = {
  invoke,
  on,
  /* convenience typed wrappers */
  getBoot: () => invoke('app:getBoot'),
  updateSettings: (patch: Record<string, unknown>) => invoke('settings:update', patch),
  pickWorkspaceFolder: () => invoke('settings:pickWorkspaceFolder'),
  revealPath: (path: string) => invoke('app:revealPath', path),
  openExternal: (url: string) => invoke('app:openExternal', url),
  logRendererError: (message: string) => invoke('app:logRendererError', message),
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
  },
  projects: {
    list: () => invoke('projects:list'),
    get: (id: string) => invoke('projects:get', id),
    create: (input: unknown) => invoke('projects:create', input),
    update: (id: string, patch: Record<string, unknown>) => invoke('projects:update', { id, patch }),
    delete: (id: string) => invoke('projects:delete', id),
    duplicate: (id: string) => invoke('projects:duplicate', id),
  },
  media: {
    pickVideoFile: () => invoke('media:pickVideoFile'),
    probePath: (path: string) => invoke('media:probePath', path),
    importFile: (input: unknown) => invoke('media:importFile', input),
    get: (mediaId: string) => invoke('media:get', mediaId),
  },
  jobs: {
    list: () => invoke('jobs:list'),
    cancel: (id: string) => invoke('jobs:cancel', id),
    onProgress: (fn: (p: unknown) => void) => on('job:progress', fn),
    onDone: (fn: (p: unknown) => void) => on('job:done', fn),
    onFailed: (fn: (p: unknown) => void) => on('job:failed', fn),
  },
  transcript: {
    load: (projectId: string) => invoke('transcript:load', projectId),
    updateWord: (payload: unknown) => invoke('transcript:updateWord', payload),
    deleteWord: (payload: unknown) => invoke('transcript:deleteWord', payload),
  },
  captions: {
    load: (projectId: string) => invoke('captions:load', projectId),
    save: (payload: unknown) => invoke('captions:save', payload),
  },
  moments: {
    load: (projectId: string) => invoke('moments:load', projectId),
    setStatus: (payload: unknown) => invoke('moments:setStatus', payload),
    run: (projectId: string) => invoke('moments:run', projectId),
    createClips: (payload: unknown) => invoke('moments:createClips', payload),
  },
  composition: {
    list: (projectId: string) => invoke('composition:list', projectId),
    load: (payload: unknown) => invoke('composition:load', payload),
    save: (payload: unknown) => invoke('composition:save', payload),
    delete: (payload: unknown) => invoke('composition:delete', payload),
  },
  recovery: {
    status: (projectId: string) => invoke('recovery:status', projectId),
    lock: (projectId: string) => invoke('recovery:lock', projectId),
    unlock: (projectId: string) => invoke('recovery:unlock', projectId),
  },
  export: {
    plan: (payload: unknown) => invoke('export:plan', payload),
    start: (payload: unknown) => invoke('export:start', payload),
    history: () => invoke('export:history'),
  },
  whisper: {
    listModels: (refresh?: boolean) => invoke('whisper:listModels', refresh === true),
  },
  providers: {
    list: () => invoke('providers:list'),
    saveOpenAiCompatible: (payload: unknown) => invoke('providers:saveOpenAiCompatible', payload),
    delete: (id: string) => invoke('providers:delete', id),
    test: (id: string) => invoke('providers:test', id),
  },
  ollama: {
    status: () => invoke('ollama:status'),
  },
  onOpenFile: (fn: (path: string) => void) => on('app:openFile', (p) => fn(String(p))),
};

export type ClipwrightApi = typeof api;

contextBridge.exposeInMainWorld('clipwright', api);
