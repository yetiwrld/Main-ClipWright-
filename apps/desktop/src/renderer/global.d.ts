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
  ollamaBaseUrl: string;
  llmNumCtx: 4096 | 8192 | 16384 | 32768;
  llmMaxConcurrent: number;
  providerTimeoutSec: number;
  privacy: { updateCheck: boolean; ytDlpUpdate: boolean; crashReports: boolean };
  defaultWhisperModel: string;
  momentDefaults: {
    contentType: 'auto' | 'podcast' | 'talking_head' | 'tutorial' | 'gaming' | 'lecture' | 'other';
    targetMinSec: number;
    targetMaxSec: number;
    count: 'auto' | number;
  };
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

export type ProviderKind = 'openai-compatible' | 'ollama' | 'anthropic' | 'gemini';
export type Locality = 'local' | 'network' | 'online';
export type Capability = 'transcription' | 'text';
export type AiTask = 'transcription' | 'moment_analysis' | 'titles' | 'editor_ai';

export interface ProviderRecordPayload {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  secretId?: string;
  maskedKeySuffix?: string;
  hasKey: boolean;
  capabilities: Capability[];
  models: { transcription?: string; text?: string };
  locality: Locality;
  status: 'connected' | 'not_tested' | 'error' | 'key_missing';
  lastTestedAt?: string;
  lastError?: string;
  timeoutMs: number;
  maxConcurrent: number;
  numCtx: number;
}

export interface ProviderPresetPayload {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  locality: Locality;
  capabilities: Capability[];
  needsKey: boolean;
  notes: string;
}

export interface ProviderSaveInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  locality?: Locality;
  models?: { transcription?: string; text?: string };
  apiKey?: string;
  clearKey?: boolean;
  timeoutMs?: number;
  maxConcurrent?: number;
  numCtx?: number;
  capabilities?: Capability[];
}

export interface ProviderSummaryPayload {
  record: ProviderRecordPayload;
  keyAvailable: boolean;
  adapterCapabilities: Capability[];
}

export interface ProviderListPayload {
  providers: ProviderSummaryPayload[];
  presets: ProviderPresetPayload[];
  ollama: { state: 'running' | 'not_found' | 'error'; version?: string; host: string; message?: string };
  settings: {
    mode: 'offline' | 'online' | 'automatic';
    defaultProviders: Record<string, string | undefined>;
    ollamaBaseUrl: string;
    llmNumCtx: number;
    llmMaxConcurrent: number;
    providerTimeoutSec: number;
  };
}

export interface TestStepPayload {
  step: 'reach' | 'authenticate' | 'model' | 'capability';
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface TestResultPayload {
  result: { ok: boolean; steps: TestStepPayload[]; latencyMs?: number; error?: { message: string; actions: string[] } };
  record: ProviderRecordPayload;
}

export type RoutePayload =
  | {
      ok: true;
      route: 'ollama' | 'whisper' | 'provider' | 'heuristic';
      providerId?: string;
      providerName?: string;
      model?: string;
      locality: Locality | 'local-machine';
      sendsDataOffDevice: boolean;
    }
  | {
      ok: false;
      reason: string;
      message: string;
      fix: Array<{ kind: string; label: string }>;
    };

export interface ConnectivityPayload {
  online: boolean;
  checkedAt: number;
  reason?: string;
}

export interface ConsentRecordPayload {
  id: string;
  providerId: string;
  category: string;
  scope: string;
  grantedAt: string;
  providerName?: string;
}

export interface DataSentEntryPayload {
  ts: string;
  providerHost: string;
  task: string;
  category: string;
  approxBytes: number;
}

export interface ConsentPromptPayload {
  providerId: string;
  providerName: string;
  host: string;
  category: string;
  where: string;
  message: string;
  sent: string;
  neverSent: string;
}

export interface PrivacyOverviewPayload {
  consents: ConsentRecordPayload[];
  dataSent: DataSentEntryPayload[];
  backgroundCalls: Array<{
    id: string;
    label: string;
    detail: string;
    toggleKey: 'updateCheck' | 'ytDlpUpdate' | null;
    enabled: boolean | null;
  }>;
}

export interface ModelCardPayload {
  id: string;
  category: 'whisper' | 'onnx' | 'ollama';
  label: string;
  fileName: string;
  expectedBytes: number;
  installedBytes: number;
  status: 'not_installed' | 'downloading' | 'paused' | 'verifying' | 'installed' | 'corrupt';
  progress: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  verified: boolean | null;
  checksumMissing: boolean;
  compatibility: 'good_fit' | 'slow' | 'may_run_out' | 'unknown';
  speedFactor: number | null;
  ramGb?: number;
  accuracy?: 'fastest' | 'fast' | 'balanced' | 'accurate' | 'most_accurate';
  languages?: string;
  notes?: string;
  bundled?: boolean;
  error?: string;
}

export interface ModelSnapshotPayload {
  machine: { totalRamGb: number; freeRamGb: number; freeDiskGb: number };
  whisper: ModelCardPayload[];
  onnx: ModelCardPayload[];
  disk: { freeGb: number; whisperBytes: number; onnxBytes: number };
  folders: { whisper: string; onnx: string };
}

export interface ModelDownloadProgressPayload {
  id: string;
  bytesReceived: number;
  totalBytes: number | null;
  percent: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  status: 'not_installed' | 'downloading' | 'paused' | 'verifying' | 'installed' | 'corrupt';
  resumed: boolean;
  verified: boolean | null;
  error?: string;
}

export interface OllamaOverviewPayload {
  status: { state: 'running' | 'not_found' | 'error'; version?: string; host: string; message?: string };
  models: Array<{
    name: string;
    sizeBytes?: number;
    parameterSize?: string;
    quantisation?: string;
    modifiedAt?: string;
  }>;
  suggestions: Array<{ name: string; approxSizeGb: number; ramGuidanceGb: number; notes: string }>;
  ramWarningFor: string | null;
  baseUrl: string;
  numCtx: number;
}

export interface MomentPayload {
  id: string;
  projectId: string;
  transcriptVersion: number;
  startUs: number;
  endUs: number;
  durationUs: number;
  aiStartUs?: number;
  aiEndUs?: number;
  title: string;
  reason: string;
  score: number;
  scores: Record<string, number>;
  weightsUsed: Record<string, number>;
  confidence: 'high' | 'medium' | 'low';
  basis: 'llm' | 'heuristic';
  model?: string;
  provider?: string;
  flags: string[];
  needsContext: boolean;
  transcriptPreview: string;
  hookSentence: string;
  groupId?: string;
  status: 'candidate' | 'favourite' | 'rejected' | 'clipped';
  userEdited: boolean;
  manual: boolean;
  createdAt: string;
  clips: string[];
}

export interface MomentsProgressPayload {
  stage: 'candidates' | 'features' | 'scoring' | 'dedupe' | 'ranking';
  percent: number;
  detail?: string;
  batch?: number;
  batchCount?: number;
}

export interface AnalyzeMomentsResultPayload {
  route: RoutePayload;
  moments: MomentPayload[];
  moreMoments: MomentPayload[];
  notes: string[];
  degraded: boolean;
  mode: 'llm' | 'heuristic';
  providerName?: string;
  model?: string;
  durationMs: number;
}

export interface CreateClipsResultPayload {
  created: Array<{ compId: string; name: string; momentId: string }>;
  errors: Array<{ momentId: string; title: string; message: string }>;
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
  listMoments(projectId: string): Promise<MomentPayload[]>;
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

  // AI providers (SPEC 06)
  aiListProviders(): Promise<ProviderListPayload>;
  aiSaveProvider(input: ProviderSaveInput): Promise<ProviderRecordPayload>;
  aiRemoveProvider(providerId: string): Promise<boolean>;
  aiTestProvider(providerId: string): Promise<TestResultPayload>;
  aiListProviderModels(providerId: string): Promise<Array<{ id: string; sizeBytes?: number; parameterSize?: string; quantisation?: string; modifiedAt?: string }>>;
  aiSetDefaultProvider(task: AiTask, providerId: string | null): Promise<AppSettings>;
  aiRoute(task: AiTask): Promise<RoutePayload>;
  aiConnectivity(force?: boolean): Promise<ConnectivityPayload>;

  // Consent and privacy (SPEC 06 §8)
  aiConsentPrompt(providerId: string, category: string): Promise<ConsentPromptPayload>;
  aiGrantConsent(decision: { providerId: string; category: string; scope: 'once' | 'always' }): Promise<ConsentRecordPayload>;
  aiRevokeConsent(providerId: string, category: string): Promise<boolean>;
  aiPrivacyOverview(): Promise<PrivacyOverviewPayload>;
  aiClearDataSentLog(): Promise<number>;
  aiExportDataSentLog(): Promise<string | null>;

  // Local models (SPEC 06 §7)
  aiModelSnapshot(): Promise<ModelSnapshotPayload>;
  aiDownloadModel(modelId: string): Promise<{ queued: boolean; needsBytes: number }>;
  aiCancelModelDownload(modelId: string): Promise<boolean>;
  aiDeleteModel(modelId: string): Promise<boolean>;
  aiVerifyModel(modelId: string): Promise<{ ok: boolean; message: string }>;
  aiSetDefaultModel(modelId: string): Promise<AppSettings>;
  aiOpenModelsFolder(): Promise<string>;
  aiRecordModelSpeed(modelId: string, throughputFactor: number): Promise<boolean>;
  onModelDownloadProgress(callback: (p: ModelDownloadProgressPayload) => void): () => void;

  // Ollama (SPEC 06 §7.3)
  aiOllamaOverview(): Promise<OllamaOverviewPayload>;
  aiPullOllamaModel(modelName: string): Promise<boolean>;
  aiCancelOllamaPull(modelName: string): Promise<boolean>;
  aiDeleteOllamaModel(modelName: string): Promise<boolean>;
  aiTestOllamaModel(modelName: string): Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  aiSetOllamaBaseUrl(baseUrl: string): Promise<AppSettings>;
  onOllamaPullProgress(callback: (p: { model: string; status: string; percent: number }) => void): () => void;

  // Moments (SPEC 07)
  analyzeMoments(request: {
    projectId: string;
    contentType?: string;
    targetMinSec?: number;
    targetMaxSec?: number;
    count?: number | 'auto';
    focus?: string;
    excludeRanges?: Array<{ startUs: number; endUs: number }>;
  }): Promise<AnalyzeMomentsResultPayload>;
  updateMoment(projectId: string, patch: Partial<MomentPayload> & { id: string }): Promise<MomentPayload>;
  addManualMoment(projectId: string, range: { startUs: number; endUs: number; title?: string }): Promise<MomentPayload>;
  rescoreMoment(projectId: string, momentId: string): Promise<MomentPayload>;
  createClips(
    projectId: string,
    momentIds: string[],
    options?: { openFirst?: boolean }
  ): Promise<CreateClipsResultPayload>;
  onMomentsProgress(callback: (p: MomentsProgressPayload) => void): () => void;

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
