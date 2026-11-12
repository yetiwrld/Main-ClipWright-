/** Typed wrapper over window.clipwright. Unwraps {ok, value} / {ok, error}. */
import type {
  AppSettings, Composition, Job, MediaInfo, Moment, ProjectRecord, TranscriptWord, CaptionChunk,
} from '@clipwright/project-schema';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export class ApiError extends Error {
  constructor(message: string) { super(message); this.name = 'ApiError'; }
}

const unwrap = async <T>(p: Promise<unknown>): Promise<T> => {
  const res = (await p) as Result<T>;
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new ApiError(res.error || 'Something went wrong.');
  }
  // window chrome handlers don't wrap — return raw
  return res as T;
};

declare global {
  interface Window {
    /** Bridge exposed by src/preload/index.ts via contextBridge (typed loosely here; raw() casts). */
    clipwright: unknown;
  }
}

export interface BootData {
  version: string;
  workspaceFolder: string | null;
  settings: AppSettings;
  firstRun: boolean;
  secretsMemoryOnly: boolean;
}

export interface ExportHistoryRow {
  id: string; project_id: string; comp_id: string; output_path: string;
  size_bytes: number | null; created_at: number; validation_json: string | null;
}
export interface ProviderRow {
  id: string; kind: string; displayName: string; baseUrl: string | null; model: string | null; secretId: string | null; enabled: boolean;
}
export interface FasterWhisperStatus {
  pythonPath: string | null;
  pythonLabel: string | null;
  version: string | null;
  hubCache: string;
  models: Array<{ id: string; name: string; snapshotPath: string; sizeBytes: number }>;
}
export interface WhisperStatus {
  binaryFound: boolean; modelsDir: string;
  models: Array<{ id: string; name: string; file: string; sizeBytes: number; installed: boolean }>;
  defaultModel: string;
  fasterWhisper?: FasterWhisperStatus;
}
export interface OllamaStatus { available: boolean; version: string | null; models: string[] }

const raw = () => (window as unknown as { clipwright: Record<string, unknown> }).clipwright as never as Record<string, any>;

export const api = {
  getBoot: () => unwrap<BootData>(raw()['getBoot']()),
  updateSettings: (patch: Partial<AppSettings>) => unwrap<AppSettings>(raw()['updateSettings'](patch)),
  pickWorkspaceFolder: () => unwrap<string | null>(raw()['pickWorkspaceFolder']()),
  revealPath: (path: string) => unwrap<boolean>(raw()['revealPath'](path)),
  openExternal: (url: string) => unwrap<boolean>(raw()['openExternal'](url)),
  logRendererError: (message: string) => unwrap<boolean>(raw()['logRendererError'](message)),

  windowChrome: {
    minimize: () => (raw()['window'] as any).minimize(),
    toggleMaximize: () => (raw()['window'] as any).toggleMaximize(),
    close: () => (raw()['window'] as any).close(),
    isMaximized: () => (raw()['window'] as any).isMaximized(),
  },

  projects: {
    list: () => unwrap<ProjectRecord[]>(raw()['projects'].list()),
    get: (id: string) => unwrap<ProjectRecord | null>(raw()['projects'].get(id)),
    create: (input: { name: string; settings: unknown; sourceUrl?: string }) => unwrap<ProjectRecord>(raw()['projects'].create(input)),
    update: (id: string, patch: Record<string, unknown>) => unwrap<ProjectRecord | null>(raw()['projects'].update(id, patch)),
    delete: (id: string) => unwrap<boolean>(raw()['projects'].delete(id)),
    duplicate: (id: string) => unwrap<ProjectRecord>(raw()['projects'].duplicate(id)),
  },
  media: {
    pickVideoFile: () => unwrap<string | null>(raw()['media'].pickVideoFile()),
    probePath: (path: string) => unwrap<MediaInfo>(raw()['media'].probePath(path)),
    get: (mediaId: string) => unwrap<{ id: string; kind: string; storageMode: string; path: string; originalName: string; sizeBytes: number; status: string; info?: MediaInfo } | null>(raw()['media'].get(mediaId)),
    importFile: (input: { path: string; projectId: string; storageMode: 'managed' | 'reference' }) =>
      unwrap<{ mediaId: string }>(raw()['media'].importFile(input)),
  },
  jobs: {
    list: () => unwrap<{ active: Job[]; recent: Job[] }>(raw()['jobs'].list()),
    cancel: (id: string) => unwrap<boolean>(raw()['jobs'].cancel(id)),
    onProgress: (fn: (p: { id: string; progress: number; phase?: string; type?: string }) => void) => (raw()['jobs'].onProgress as Function)(fn),
    onDone: (fn: (p: { id: string; type: string; result?: unknown }) => void) => (raw()['jobs'].onDone as Function)(fn),
    onFailed: (fn: (p: { id: string; type: string; error: string }) => void) => (raw()['jobs'].onFailed as Function)(fn),
  },
  transcript: {
    load: (projectId: string) => unwrap<TranscriptWord[]>(raw()['transcript'].load(projectId)),
    updateWord: (payload: { projectId: string; wordId: string; text?: string; startUs?: number; endUs?: number }) =>
      unwrap<TranscriptWord>(raw()['transcript'].updateWord(payload)),
    deleteWord: (payload: { projectId: string; wordId: string }) => unwrap<boolean>(raw()['transcript'].deleteWord(payload)),
  },
  captions: {
    load: (projectId: string) => unwrap<CaptionChunk[]>(raw()['captions'].load(projectId)),
    save: (projectId: string, captions: CaptionChunk[]) => unwrap<boolean>(raw()['captions'].save({ projectId, captions })),
  },
  moments: {
    load: (projectId: string) => unwrap<Moment[]>(raw()['moments'].load(projectId)),
    setStatus: (projectId: string, momentId: string, status: Moment['status']) => unwrap<boolean>(raw()['moments'].setStatus({ projectId, momentId, status })),
    run: (projectId: string) => unwrap<string>(raw()['moments'].run(projectId)),
    createClips: (projectId: string, momentIds: string[]) =>
      unwrap<{ created: Array<{ compId: string; name: string }>; errors: Array<{ momentId: string; error: string }> }>(raw()['moments'].createClips({ projectId, momentIds })),
  },
  composition: {
    list: (projectId: string) => unwrap<Composition[]>(raw()['composition'].list(projectId)),
    load: (projectId: string, compId: string) => unwrap<Composition | null>(raw()['composition'].load({ projectId, compId })),
    save: (projectId: string, comp: Composition) => unwrap<{ savedAt: number }>(raw()['composition'].save({ projectId, comp })),
    delete: (projectId: string, compId: string) => unwrap<boolean>(raw()['composition'].delete({ projectId, compId })),
  },
  downloadStart: (projectId: string, url: string, quality: '720p' | '1080p' | 'best') =>
    unwrap<string>((raw()['invoke'] as Function)('download:start', { projectId, url, quality })),
  transcribeStart: (projectId: string) =>
    unwrap<string>((raw()['invoke'] as Function)('transcribe:start', { projectId })),
  exportPlan: (projectId: string, compId: string, settings: unknown) => unwrap<{ summary: string; output: { width: number; height: number }; durationFrames: number; estimatedBytes: number }>(raw()['export'].plan({ projectId, compId, settings })),
  exportStart: (projectId: string, compId: string, settings: unknown, fileName?: string) =>
    unwrap<string>(raw()['export'].start({ projectId, compId, settings, fileName })),
  exportHistory: () => unwrap<ExportHistoryRow[]>(raw()['export'].history()),
  whisper: { listModels: (refresh?: boolean) => unwrap<WhisperStatus>(raw()['whisper'].listModels(refresh === true)) },
  providers: {
    list: () => unwrap<ProviderRow[]>(raw()['providers'].list()),
    saveOpenAiCompatible: (payload: { baseUrl: string; apiKey: string; model: string; label?: string }) =>
      unwrap<{ id: string; maskedSuffix: string | null }>(raw()['providers'].saveOpenAiCompatible(payload)),
    delete: (id: string) => unwrap<boolean>(raw()['providers'].delete(id)),
    test: (id: string) => unwrap<{ reply: string }>(raw()['providers'].test(id)),
  },
  ollama: { status: () => unwrap<OllamaStatus>(raw()['ollama'].status()) },
};

export type { Composition, MediaInfo, Moment, ProjectRecord, TranscriptWord, CaptionChunk };
