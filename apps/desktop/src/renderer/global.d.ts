/**
 * The typed shape of the preload bridge exposed on `window.clipwright`.
 * Mirrors apps/desktop/src/preload/index.cjs — one entry per IPC channel.
 */

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  stage: 'import' | 'transcribe' | 'moments' | 'editor' | 'exported';
  sourceMediaIds: string[];
  schemaVersion: number;
  appVersionLastSaved: string;
  settings: Record<string, unknown>;
}

export interface MediaInfo {
  mediaId: string;
  kind: 'video' | 'audio' | 'image';
  container: string;
  durationUs: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
}

export interface AppSettings {
  firstRunCompleted: boolean;
  workspacePath: string;
  processingMode: 'offline' | 'online' | 'automatic';
  autosaveIntervalSec: number;
  autoContinueStages: boolean;
  audioScrubbing: boolean;
  clickEmptyMovesPlayhead: boolean;
  proxyQuality: 'low' | 'medium' | 'high';
  alwaysCreateProxies: boolean;
  defaultProviders: {
    transcription?: string;
    moment_analysis?: string;
    titles?: string;
    editor_ai?: string;
  };
  updateChannel: 'stable' | 'beta';
  autoCheckUpdates: 'startup' | '6h' | '1d' | '1w' | 'never';
  ytDlpAutoUpdate: boolean;
  shortcuts: Record<string, string>;
  lastStartSettings: Record<string, unknown>;
}

export interface RestorePointRecord {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  workspaceDir: string | null;
  isDev: boolean;
}

export interface IngestRequestPayload {
  projectId: string;
  sourcePath?: string;
  sourceUrl?: string;
  quality: '720p' | '1080p' | 'best';
  storageMode: 'managed' | 'reference';
}

export interface IngestResultPayload {
  mediaId: string;
  mediaPath: string;
  audio16kPath: string;
  thumbPath: string;
  proxyPath: string | null;
  durationUs: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  fps?: number;
  kind: 'video' | 'audio' | 'image';
  status: 'ok' | 'missing';
}

export interface TranscribeRequestPayload {
  projectId: string;
  audioPath: string;
  mediaId: string;
  model: string;
  language: string;
  engine: 'whisper-local' | 'online';
  threads?: number;
  chunkDurationSec?: number;
}

export interface TranscriptPayload {
  id: string;
  mediaId: string;
  language: string;
  languageConfidence?: number;
  engine: string;
  model: string;
  createdAt: string;
  version: number;
  durationUs: number;
  words: Array<{
    id: string;
    text: string;
    startUs: number;
    endUs: number;
    confidence?: number;
    speaker?: string;
    edited: boolean;
    approximate: boolean;
    lowConfidence: boolean;
    filler: boolean;
    chunkIndex: number;
  }>;
  sentences: Array<{ id: string; wordIds: string[]; startUs: number; endUs: number }>;
  paragraphs: Array<{ id: string; sentenceIds: string[]; startUs: number; endUs: number; speaker?: string }>;
  highlights: Array<{ id: string; startUs: number; endUs: number; color: string; note?: string }>;
}

export interface TranscribeResultPayload {
  transcript: TranscriptPayload;
  wordCount: number;
  language: string;
  model: string;
  durationSec: number;
}

export interface JobProgressPayload {
  jobId: string;
  percent?: number;
  phase?: string;
  detail?: string;
  chunkIndex?: number;
  totalChunks?: number;
  elapsedSec?: number;
  etaSec?: number | null;
  failed?: boolean;
  message?: string;
  result?: unknown;
}

export interface WhisperModelEntry {
  name: string;
  label: string;
  speed: string;
  expectedBytes: number;
  installed: boolean;
  bytes: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface ClipwrightBridge {
  // Workspace
  ensureWorkspace(): Promise<{ workspaceDir: string }>;
  listProjects(): Promise<ProjectRecord[]>;
  createProject(settings: { name: string; sourceMediaIds?: string[]; settings?: Record<string, unknown> }): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord | undefined>;
  updateProject(projectId: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord>;
  duplicateProject(projectId: string): Promise<ProjectRecord>;
  deleteProject(projectId: string, opts?: { deleteMedia?: boolean }): Promise<unknown>;

  // Compositions
  getCompositions(projectId: string): Promise<unknown[]>;
  getComposition(projectId: string, compId: string): Promise<unknown | undefined>;
  saveComposition(projectId: string, comp: unknown): Promise<unknown>;

  // Journal / recovery
  appendJournal(projectId: string, entry: unknown): Promise<boolean>;
  checkpoint(projectId: string, compositions: unknown[], upToSeq?: number): Promise<boolean>;
  checkRecovery(projectId: string): Promise<{ entries: unknown[]; corruptLines: string[]; needsRecovery: boolean }>;
  replayRecovery(projectId: string): Promise<unknown>;
  createRestorePoint(projectId: string, label: string): Promise<RestorePointRecord>;
  listRestorePoints(projectId: string): Promise<RestorePointRecord[]>;
  restoreFromPoint(projectId: string, restorePointId: string): Promise<unknown>;

  // Locks
  acquireLock(projectId: string): Promise<unknown>;
  releaseLock(projectId: string): Promise<boolean>;

  // Media / transcript / moments / jobs
  saveMedia(media: unknown): Promise<unknown>;
  listMedia(): Promise<unknown[]>;
  saveTranscript(projectId: string, transcript: unknown): Promise<unknown>;
  getTranscript(projectId: string): Promise<unknown>;
  saveMoments(projectId: string, moments: unknown[]): Promise<unknown[]>;
  listMoments(projectId: string): Promise<unknown[]>;
  saveJob(job: unknown): Promise<unknown>;
  listJobs(): Promise<unknown[]>;

  // Packages
  exportPackage(projectId: string, destPath: string, opts?: { includeMedia?: boolean }): Promise<unknown>;
  importPackage(packPath: string, opts?: { conflictMode?: 'copy' | 'replace' }): Promise<unknown>;
  relocateWorkspace(targetDir: string, opts?: unknown): Promise<unknown>;

  // Settings
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resetSettings(): Promise<AppSettings>;

  // Secrets
  setSecret(plainText: string, existingSecretId?: string): Promise<{ secretId: string; maskedSuffix: string; persisted: boolean }>;
  getSecret(secretId: string): Promise<string | undefined>;
  deleteSecret(secretId: string): Promise<boolean>;

  // Logging
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, meta?: Record<string, unknown>): Promise<boolean>;
  recentLogs(limit?: number): Promise<string[]>;

  // Dialogs
  openVideoDialog(): Promise<string[]>;
  openFolderDialog(): Promise<string[]>;
  saveFileDialog(defaultName: string, filters?: FileFilter[]): Promise<string | null>;

  // Media operations
  probeMedia(filePath: string): Promise<MediaInfo>;
  probeUrl(url: string): Promise<MediaInfo | { title: string; durationUs: number }>;
  isSupportedFile(filePath: string): Promise<{ supported: boolean; kind: 'video' | 'audio' | 'image' | 'none' }>;

  // Transcript export (writes the file and returns its path, or null if cancelled)
  exportTranscript(
    transcript: TranscriptPayload,
    format: 'txt' | 'srt' | 'vtt' | 'json',
    aspect: string,
    defaultName: string
  ): Promise<string | null>;

  // Long-running jobs
  startIngest(jobId: string, request: IngestRequestPayload): Promise<IngestResultPayload>;
  startTranscribe(jobId: string, request: TranscribeRequestPayload): Promise<TranscribeResultPayload>;
  cancelJob(jobId: string): Promise<boolean>;
  onJobProgress(callback: (p: JobProgressPayload) => void): () => void;

  // Transcription models
  listModels(): Promise<WhisperModelEntry[]>;
  installModel(modelName: string): Promise<{ path: string }>;
  deleteModel(modelName: string): Promise<boolean>;
  onModelProgress(callback: (p: { modelName: string; percent: number }) => void): () => void;

  // App
  getAppInfo(): Promise<AppInfo>;
  openPath(targetPath: string): Promise<boolean | string>;
}

declare global {
  interface Window {
    clipwright?: ClipwrightBridge;
  }
}

export {};
