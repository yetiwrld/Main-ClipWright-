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
  /** Whether the preview plays proxies. Exports always use the original. */
  useProxyPreview: boolean;
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
      providerId?: string;
      providerName?: string;
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
  /**
   * `deleteExclusiveManagedMedia` is the store's own key (`StorageService.deleteProject`). The
   * declaration said `deleteMedia`, which the store ignores — a caller following the type would
   * have deleted the project and kept every managed file, with the checkbox ticked and no error.
   */
  deleteProject(
    projectId: string,
    opts?: { deleteExclusiveManagedMedia?: boolean },
  ): Promise<unknown>;

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

  /**
   * Write a `.cwbrand` archive (SPEC 13 §8.2). Main shows the save dialog, reads the kit's assets
   * from the media library and writes the file. Resolves `null` when the user cancels, and
   * reports any asset that could not be found so the caller can say which one.
   */
  exportBrandKit(
    kit: unknown,
    defaultName: string
  ): Promise<{ path: string; missingAssets: string[] } | null>;

  /**
   * Read a `.cwbrand` archive. Main shows the open dialog, parses the zip and returns the kit
   * with its assets as base64. Resolves `null` when cancelled; rejects with a readable message
   * when the file is not a kit.
   */
  importBrandKit(): Promise<{
    kit: unknown;
    assets: Array<{ name: string; data: string }>;
    missingAssets: string[];
  } | null>;

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
  installModel(modelName: string): Promise<{ queued: boolean; needsBytes: number }>;
  deleteModel(modelName: string): Promise<boolean>;
  onModelProgress(callback: (p: { modelName: string; percent: number }) => void): () => void;

  // AI providers (SPEC 06)
  aiListProviders(): Promise<ProviderListPayload>;
  aiSaveProvider(input: ProviderSaveInput): Promise<ProviderRecordPayload>;
  aiRemoveProvider(providerId: string): Promise<boolean>;
  aiDuplicateProvider(providerId: string): Promise<ProviderRecordPayload>;
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
  aiDeleteAllModels(): Promise<{ models: string[]; bytesFreed: number }>;
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

  // Updates (SPEC 15)
  getUpdateState(): Promise<UpdateStatePayload>;
  checkForUpdates(options?: { manual?: boolean }): Promise<UpdateCheckResultPayload>;
  downloadUpdate(): Promise<UpdateDownloadResultPayload>;
  cancelUpdateDownload(): Promise<UpdateStatePayload>;
  installUpdate(): Promise<{ ok: boolean; error?: UpdateErrorPayload }>;
  skipUpdateVersion(): Promise<UpdateStatePayload>;
  remindUpdateLater(): Promise<UpdateStatePayload>;
  dismissUpdate(): Promise<UpdateStatePayload>;
  onUpdateState(callback: (state: UpdateStatePayload) => void): () => void;

  // Update recovery (SPEC 15 §7)
  getRecoveryState(): Promise<RecoveryStatePayload | null>;
  restorePreviousVersion(): Promise<{ ok: boolean; error?: string }>;
  dismissRecovery(): Promise<{ ok: boolean }>;

  // Bundled tool integrity (SPEC 15 §6.1)
  getToolIntegrity(): Promise<ToolIntegrityPayload | null>;

  // yt-dlp updater (SPEC 15 §9)
  getYtDlpStatus(): Promise<YtDlpStatePayload | null>;
  checkYtDlpUpdate(): Promise<YtDlpCheckPayload>;
  updateYtDlp(input: { downloadUrl: string; expectedSha256: string; version: string }): Promise<{
    ok: boolean;
    error?: string;
    state: YtDlpStatePayload;
  }>;
  restoreBundledYtDlp(): Promise<{ ok: boolean; reason?: string; state: YtDlpStatePayload }>;

  // Export (SPEC 14)
  startExport(request: ExportStartRequestPayload): Promise<ExportStartResultPayload>;
  cancelExport(jobId: string): Promise<boolean>;
  retryExport(jobId: string): Promise<ExportJobPayload | null>;
  dismissExport(jobId: string): Promise<boolean>;
  getExportQueue(): Promise<ExportQueuePayload>;
  setExportConcurrency(value: number): Promise<number>;
  listExportHistory(projectId?: string): Promise<ExportHistoryPayload[]>;
  getExportJob(jobId: string): Promise<ExportJobPayload | null>;
  getExportSpeed(projectId?: string): Promise<number | null>;
  planExport(settings: Record<string, unknown>): Promise<Record<string, unknown>>;
  exportSubtitles(settings: Record<string, unknown>): Promise<{ srt: string | null; vtt: string | null }>;
  openExportFolder(filePath: string): Promise<boolean>;
  onExportProgress(callback: (p: ExportProgressPayload) => void): () => void;

  // App
  getAppInfo(): Promise<AppInfo>;
  openPath(targetPath: string): Promise<boolean | string>;
}

/* ------------------------------------------------------------------ export */

export type ExportJobStatusPayload =
  | 'queued'
  | 'rendering'
  | 'measuring-loudness'
  | 'encoding'
  | 'finalising'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface ExportJobPayload {
  id: string;
  compositionId: string;
  projectId: string;
  name: string;
  status: ExportJobStatusPayload;
  percent: number;
  framesDone: number;
  totalFrames: number;
  speedFactor: number;
  etaSec: number | null;
  message: string;
  validationStatus?: 'verified' | 'warnings' | 'failed';
  verdict?: string;
  error?: string;
  outputPath: string;
  settingsSnapshot: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ExportQueuePayload {
  jobs: ExportJobPayload[];
  running: number;
  maxConcurrent: number;
}

export interface ExportProgressPayload {
  jobId: string;
  name?: string;
  status: ExportJobStatusPayload;
  percent: number;
  framesDone: number;
  totalFrames: number;
  speedFactor: number;
  etaSec: number | null;
  message: string;
}

/* ---------- Updates (SPEC 15) ---------- */

export type UpdateStatusPayload =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error';

export interface UpdateReleasePayload {
  version: string;
  summary: string;
  full: string;
  releasedAt: string;
  prerelease: boolean;
  downloadBytes: number;
  signed: boolean;
  htmlUrl: string;
}

export interface UpdateErrorPayload {
  kind:
    | 'offline'
    | 'rate-limited'
    | 'unverified'
    | 'damaged'
    | 'not-enough-space'
    | 'quarantined'
    | 'no-signature'
    | 'unknown';
  message: string;
  retryable: boolean;
  detail?: string;
}

export interface UpdateProgressPayload {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSec: number | null;
}

/** What the Recovery window shows (SPEC 15 §7.3). Built in the main process. */
export interface RecoveryStatePayload {
  headline: string;
  body: string[];
  canRestorePrevious: boolean;
  fromVersion: string;
  toVersion: string;
}

/** yt-dlp status for Settings → Updates (SPEC 15 §9). */
export interface YtDlpStatePayload {
  version: string | null;
  source: 'bundled' | 'user' | null;
  path: string | null;
  available: { version: string; downloadUrl: string } | null;
  lastCheckedAt: number | null;
  message: string;
  error: string | null;
}

/** The result of a yt-dlp check, mirroring update-core's YtDlpUpdateCheck. */
export type YtDlpCheckPayload =
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; assetName: string; downloadUrl: string; expectedSha256: string }
  | { kind: 'not-due'; nextCheckAt: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; message: string };

/** Bundled-tool verification summary (SPEC 15 §6.1). */
export interface ToolIntegrityPayload {
  manifestPresent: boolean;
  enabled: string[];
  problems: string[];
  summary: string | null;
}

/**
 * The payloads above are hand-copied across the IPC boundary, because the
 * renderer bundle should not grow a runtime dependency on update-core just for
 * types. These assertions make the copy compile-checked rather than trusted: if
 * update-core's `UpdateState` gains or changes a field and this file is not
 * updated, `tsc` fails here instead of the renderer silently reading `undefined`
 * at runtime.
 */
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _updateStateMatchesCore: AssertSame<UpdateStatePayload, import('@clipwright/update-core').UpdateState> = true;
const _updateStatusMatchesCore: AssertSame<UpdateStatusPayload, import('@clipwright/update-core').UpdateStatus> = true;
const _updateProgressMatchesCore: AssertSame<UpdateProgressPayload, import('@clipwright/update-core').UpdateProgress> = true;
const _ytDlpCheckMatchesCore: AssertSame<YtDlpCheckPayload, import('@clipwright/update-core').YtDlpUpdateCheck> = true;
void _updateStateMatchesCore;
void _updateStatusMatchesCore;
void _updateProgressMatchesCore;
void _ytDlpCheckMatchesCore;

export interface UpdateStatePayload {
  status: UpdateStatusPayload;
  currentVersion: string;
  channel: 'stable' | 'beta';
  lastCheckedAt: number | null;
  release: UpdateReleasePayload | null;
  progress: UpdateProgressPayload | null;
  error: UpdateErrorPayload | null;
  skippedVersion: string | null;
  snoozedUntil: number | null;
  notice: string | null;
}

export type UpdateCheckResultPayload =
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; release: UpdateReleasePayload }
  | { status: 'error'; error: UpdateErrorPayload };

export type UpdateDownloadResultPayload =
  | { ok: true; filePath: string }
  | { ok: false; error: UpdateErrorPayload };

export interface ExportStartRequestPayload {
  jobId: string;
  name: string;
  /** Export settings, shaped like `ExportSettings` in export-core. */
  settings: Record<string, unknown>;
  snapshotLabel?: string;
  outputDir?: string;
  fileName?: string;
  clashPolicy?: 'auto-number' | 'replace' | 'ask';
  fullDecode?: boolean;
  /**
   * Project-local caption styles, keyed by id, so a burn-in honours edits rather
   * than falling back to the preset a style started from (SPEC 11 §6).
   */
  captionStyles?: Record<string, unknown>;
}

export type ExportStartResultPayload =
  | { ok: true; job: ExportJobPayload; outputPath: string }
  | { ok: false; error: string; action: 'relink' | 'choose-folder' | 'retry' | 'change-settings' | 'none' };

export interface ExportHistoryPayload {
  id: string;
  projectId: string;
  compId: string;
  outputPath: string;
  name: string;
  status: 'verified' | 'warnings' | 'failed' | 'cancelled';
  verdict: string;
  validationReport?: unknown;
  presetLabel: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  sizeBytes: number;
  elapsedMs: number;
  speedFactor: number;
  createdAt: string;
  fileMissing: boolean;
}

declare global {
  interface Window {
    clipwright?: ClipwrightBridge;
  }
}

export {};
