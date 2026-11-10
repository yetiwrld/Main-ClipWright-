import type {
  AiTask,
  ClipwrightBridge,
  ExportProgressPayload,
  ExportStartRequestPayload,
  IngestRequestPayload,
  JobProgressPayload,
  ModelDownloadProgressPayload,
  MomentsProgressPayload,
  ProviderSaveInput,
  TranscribeRequestPayload,
  UpdateStatePayload,
} from './global.js';

/**
 * Access to the Electron preload bridge.
 *
 * The renderer also runs in a plain browser during UI development, where no
 * bridge exists. Callers must handle `null` — we never fake results, so the UI
 * can tell the user that the desktop app is required for that action.
 */
export function getBridge(): ClipwrightBridge | null {
  return typeof window !== 'undefined' && window.clipwright ? window.clipwright : null;
}

export function isDesktop(): boolean {
  return getBridge() !== null;
}

export class DesktopRequiredError extends Error {
  constructor(action: string) {
    super(`${action} needs the Clipwright desktop app.`);
    this.name = 'DesktopRequiredError';
  }
}

function requireBridge(action: string): ClipwrightBridge {
  const bridge = getBridge();
  if (!bridge) throw new DesktopRequiredError(action);
  return bridge;
}

export const api = {
  // ---- Workspace ----
  async listProjects() {
    return requireBridge('Listing projects').listProjects();
  },
  async createProject(settings: { name: string; sourceMediaIds?: string[]; settings?: Record<string, unknown> }) {
    return requireBridge('Creating a project').createProject(settings);
  },
  async getProject(projectId: string) {
    return requireBridge('Opening the project').getProject(projectId);
  },
  async updateProject(projectId: string, patch: Parameters<ClipwrightBridge['updateProject']>[1]) {
    return requireBridge('Updating the project').updateProject(projectId, patch);
  },
  /*
    SPEC 03 §10's project actions. All four were implemented in the store and reachable from no
    window: the bridge exposed them from the start, `api.ts` had a wrapper only for `updateProject`,
    and `ProjectsPage` had no menu — so a project could not be renamed, duplicated, archived or
    deleted in an app that had code for each.
  */
  async duplicateProject(projectId: string) {
    return requireBridge('Duplicating the project').duplicateProject(projectId);
  },
  /**
   * Delete a project.
   *
   * `deleteMedia` is the caller's word for the store's `deleteExclusiveManagedMedia`, and the name
   * matters: the store reads that key, and `global.d.ts` used to declare `deleteMedia`, which the
   * store ignores — a caller following the type would delete the project and keep every managed
   * file, checkbox ticked, no error. The declaration now carries the store's name; this wrapper
   * accepts the friendly one and maps it, so neither spelling can be silently dropped.
   */
  async deleteProject(projectId: string, opts?: { deleteMedia?: boolean }) {
    return requireBridge('Deleting the project').deleteProject(projectId, {
      deleteExclusiveManagedMedia: opts?.deleteMedia === true,
    });
  },
  async revealProject(projectId: string) {
    return requireBridge('Showing the project folder').revealProject(projectId);
  },
  async archiveProject(projectId: string, archived: boolean) {
    /* Archive is a field on the record, not a store method: §8's "hides from Home; read-only until
       unarchived" is expressed by `archived`, and `updateProject` already writes it. */
    return requireBridge('Archiving the project').updateProject(projectId, { archived });
  },

  /**
   * Export a brand kit as a `.cwbrand` file (SPEC 13 §8.2).
   *
   * The renderer names the kit; main shows the dialog, reads the kit's assets from the media
   * library and writes the archive. A kit whose logo this machine does not have exports without
   * it and says which — a file that silently lost its logo is one the recipient finds broken.
   */
  async exportBrandKit(kit: unknown, defaultName: string) {
    return requireBridge('Exporting the kit').exportBrandKit(kit, defaultName);
  },
  /** Open a `.cwbrand` file. Resolves null when the user cancels. */
  async importBrandKit() {
    return requireBridge('Importing a kit').importBrandKit();
  },

  async getComposition(projectId: string, compId: string) {
    return requireBridge('Opening the clip').getComposition(projectId, compId) as Promise<
      { id: string; name: string; version: number; payload: unknown } | null
    >;
  },

  async getCompositions(projectId: string) {
    return requireBridge('Listing clips').getCompositions(projectId) as Promise<
      Array<{ id: string; name: string; version: number; updatedAt: string }>
    >;
  },

  async saveComposition(projectId: string, comp: unknown) {
    return requireBridge('Saving the clip').saveComposition(projectId, comp);
  },

  async appendJournal(projectId: string, entry: unknown) {
    return requireBridge('Saving the clip').appendJournal(projectId, entry);
  },

  async checkpoint(projectId: string, compositions: unknown[], upToSeq?: number) {
    return requireBridge('Saving the clip').checkpoint(projectId, compositions, upToSeq);
  },

  async checkRecovery(projectId: string) {
    return requireBridge('Checking for unsaved edits').checkRecovery(projectId);
  },

  async replayRecovery(projectId: string) {
    return requireBridge('Recovering unsaved edits').replayRecovery(projectId) as Promise<{
      recoveredCompositions: unknown[];
      appliedCount: number;
      corruptCount: number;
    }>;
  },

  // ---- Media ----
  async listMedia() {
    return requireBridge('Listing media').listMedia() as Promise<
      Array<{
        id: string;
        path: string;
        kind: 'video' | 'audio' | 'image';
        status: 'ok' | 'missing' | 'changed';
        originalName: string;
        sizeBytes: number;
        /**
         * The preview proxy, when one exists (SPEC 04 §6.3, §7).
         *
         * Main has always returned the whole record, so this was on the wire already — it was
         * only the renderer's declared shape that hid it, which meant the preview could not
         * know it was playing a proxy and so could not say so (§5.1's "never silent").
         *
         * `null` and absent are different in the record (declined vs. predates proxies) and the
         * same to the preview; see `preview-quality.ts`.
         */
        proxyPath?: string | null;
        info?: { durationUs?: number; video?: { width?: number; height?: number } };
      }>
    >;
  },
  async probeMedia(filePath: string) {
    return requireBridge('Inspecting that file').probeMedia(filePath);
  },
  async probeUrl(url: string) {
    return requireBridge('Checking that link').probeUrl(url);
  },
  async isSupportedFile(filePath: string) {
    return requireBridge('Checking that file').isSupportedFile(filePath);
  },

  // ---- Dialogs ----
  async pickVideos() {
    return requireBridge('Opening the file picker').openVideoDialog();
  },
  async pickFolder() {
    return requireBridge('Opening the folder picker').openFolderDialog();
  },

  // ---- Transcript ----
  async getTranscript(projectId: string) {
    return requireBridge('Loading the transcript').getTranscript(projectId);
  },
  async saveTranscript(projectId: string, transcript: unknown) {
    return requireBridge('Saving the transcript').saveTranscript(projectId, transcript);
  },

  // ---- Settings ----
  async relocateWorkspaceTo(targetDir: string) {
    return requireBridge('Moving the workspace').relocateWorkspace(targetDir);
  },
  async getSettings() {
    return requireBridge('Loading settings').getSettings();
  },
  async updateSettings(patch: Record<string, unknown>) {
    return requireBridge('Saving settings').updateSettings(patch);
  },

  // ---- Job records ----
  async listJobs() {
    return requireBridge('Loading background tasks').listJobs();
  },

  async exportTranscript(
    transcript: Parameters<ClipwrightBridge['exportTranscript']>[0],
    format: 'txt' | 'srt' | 'vtt' | 'json',
    aspect: string,
    defaultName: string
  ) {
    return requireBridge('Exporting the transcript').exportTranscript(transcript, format, aspect, defaultName);
  },

  // ---- Jobs ----
  async startIngest(jobId: string, request: IngestRequestPayload) {
    return requireBridge('Importing that video').startIngest(jobId, request);
  },
  async startTranscribe(jobId: string, request: TranscribeRequestPayload) {
    return requireBridge('Transcribing').startTranscribe(jobId, request);
  },
  async cancelJob(jobId: string) {
    return getBridge()?.cancelJob(jobId) ?? false;
  },
  onJobProgress(callback: (p: JobProgressPayload) => void) {
    return getBridge()?.onJobProgress(callback) ?? (() => undefined);
  },

  // ---- Models ----
  async listModels() {
    return requireBridge('Loading models').listModels();
  },
  async installModel(modelName: string) {
    return requireBridge('Installing that model').installModel(modelName);
  },
  async deleteModel(modelName: string) {
    return requireBridge('Deleting that model').deleteModel(modelName);
  },

  // ---- AI providers (SPEC 06) ----
  async listProviders() {
    return requireBridge('Loading AI providers').aiListProviders();
  },
  async saveProvider(input: ProviderSaveInput) {
    return requireBridge('Saving the provider').aiSaveProvider(input);
  },
  async removeProvider(providerId: string) {
    return requireBridge('Removing the provider').aiRemoveProvider(providerId);
  },
  async duplicateProvider(providerId: string) {
    return requireBridge('Duplicating the provider').aiDuplicateProvider(providerId);
  },
  async testProvider(providerId: string) {
    return requireBridge('Testing the provider').aiTestProvider(providerId);
  },
  async listProviderModels(providerId: string) {
    return requireBridge('Listing that provider’s models').aiListProviderModels(providerId);
  },
  async setDefaultProvider(task: AiTask, providerId: string | null) {
    return requireBridge('Changing the default provider').aiSetDefaultProvider(task, providerId);
  },
  async routeFor(task: AiTask) {
    return requireBridge('Checking which AI can run this').aiRoute(task);
  },
  async connectivity(force = false) {
    return requireBridge('Checking the connection').aiConnectivity(force);
  },

  // ---- Consent and privacy ----
  async consentPrompt(providerId: string, category: string) {
    return requireBridge('Preparing the permission dialog').aiConsentPrompt(providerId, category);
  },
  async grantConsent(providerId: string, category: string, scope: 'once' | 'always') {
    return requireBridge('Recording your choice').aiGrantConsent({ providerId, category, scope });
  },
  async revokeConsent(providerId: string, category: string) {
    return requireBridge('Revoking permission').aiRevokeConsent(providerId, category);
  },
  async privacyOverview() {
    return requireBridge('Loading privacy details').aiPrivacyOverview();
  },
  async clearDataSentLog() {
    return requireBridge('Clearing the log').aiClearDataSentLog();
  },
  async exportDataSentLog() {
    return requireBridge('Exporting the log').aiExportDataSentLog();
  },

  // ---- Local models ----
  async modelSnapshot() {
    return requireBridge('Loading local models').aiModelSnapshot();
  },
  async downloadModel(modelId: string) {
    return requireBridge('Starting the download').aiDownloadModel(modelId);
  },
  async cancelModelDownload(modelId: string) {
    return getBridge()?.aiCancelModelDownload(modelId) ?? false;
  },
  async deleteSpeechModel(modelId: string) {
    return requireBridge('Deleting that model').aiDeleteModel(modelId);
  },
  async verifyModel(modelId: string) {
    return requireBridge('Verifying that model').aiVerifyModel(modelId);
  },
  async deleteAllModels() {
    return requireBridge('Deleting the downloaded models').aiDeleteAllModels();
  },
  async setDefaultModel(modelId: string) {
    return requireBridge('Setting the default model').aiSetDefaultModel(modelId);
  },
  async openModelsFolder() {
    return requireBridge('Opening the models folder').aiOpenModelsFolder();
  },
  onModelDownloadProgress(callback: (p: ModelDownloadProgressPayload) => void) {
    return getBridge()?.onModelDownloadProgress(callback) ?? (() => undefined);
  },

  // ---- Ollama ----
  async ollamaOverview() {
    return requireBridge('Checking Ollama').aiOllamaOverview();
  },
  async pullOllamaModel(modelName: string) {
    return requireBridge('Pulling that model').aiPullOllamaModel(modelName);
  },
  async cancelOllamaPull(modelName: string) {
    return getBridge()?.aiCancelOllamaPull(modelName) ?? false;
  },
  async deleteOllamaModel(modelName: string) {
    return requireBridge('Deleting that model').aiDeleteOllamaModel(modelName);
  },
  async testOllamaModel(modelName: string) {
    return requireBridge('Testing that model').aiTestOllamaModel(modelName);
  },
  async setOllamaBaseUrl(baseUrl: string) {
    return requireBridge('Saving the Ollama address').aiSetOllamaBaseUrl(baseUrl);
  },
  onOllamaPullProgress(callback: (p: { model: string; status: string; percent: number }) => void) {
    return getBridge()?.onOllamaPullProgress(callback) ?? (() => undefined);
  },

  // ---- Moments (SPEC 07) ----
  async listMoments(projectId: string) {
    return requireBridge('Loading moments').listMoments(projectId);
  },
  async analyzeMoments(request: Parameters<ClipwrightBridge['analyzeMoments']>[0]) {
    return requireBridge('Finding moments').analyzeMoments(request);
  },
  async updateMoment(projectId: string, patch: Parameters<ClipwrightBridge['updateMoment']>[1]) {
    return requireBridge('Updating that moment').updateMoment(projectId, patch);
  },
  async addManualMoment(projectId: string, range: { startUs: number; endUs: number; title?: string }) {
    return requireBridge('Adding that range').addManualMoment(projectId, range);
  },
  async rescoreMoment(projectId: string, momentId: string) {
    return requireBridge('Re-scoring that moment').rescoreMoment(projectId, momentId);
  },
  async createClips(projectId: string, momentIds: string[], options?: { openFirst?: boolean }) {
    return requireBridge('Creating clips').createClips(projectId, momentIds, options);
  },
  onMomentsProgress(callback: (p: MomentsProgressPayload) => void) {
    return getBridge()?.onMomentsProgress(callback) ?? (() => undefined);
  },

  // ---- Updates (SPEC 15) ----
  async getUpdateState() {
    return requireBridge('Reading update status').getUpdateState();
  },
  async checkForUpdates(options?: { manual?: boolean }) {
    return requireBridge('Checking for updates').checkForUpdates(options);
  },
  async downloadUpdate() {
    return requireBridge('Downloading the update').downloadUpdate();
  },
  async cancelUpdateDownload() {
    return requireBridge('Cancelling the download').cancelUpdateDownload();
  },
  async installUpdate() {
    return requireBridge('Installing the update').installUpdate();
  },
  async skipUpdateVersion() {
    return requireBridge('Skipping that version').skipUpdateVersion();
  },
  async remindUpdateLater() {
    return requireBridge('Snoozing that update').remindUpdateLater();
  },
  async dismissUpdate() {
    return requireBridge('Closing that notice').dismissUpdate();
  },
  onUpdateState(callback: (state: UpdateStatePayload) => void) {
    return getBridge()?.onUpdateState(callback) ?? (() => undefined);
  },

  // ---- yt-dlp updater (SPEC 15 §9) ----
  async getYtDlpStatus() {
    return requireBridge('Reading the yt-dlp version').getYtDlpStatus();
  },
  async checkYtDlpUpdate() {
    return requireBridge('Checking the yt-dlp version').checkYtDlpUpdate();
  },
  async updateYtDlp(input: Parameters<ClipwrightBridge['updateYtDlp']>[0]) {
    return requireBridge('Updating yt-dlp').updateYtDlp(input);
  },
  async restoreBundledYtDlp() {
    return requireBridge('Restoring the bundled yt-dlp').restoreBundledYtDlp();
  },

  // ---- Update recovery (SPEC 15 §7) ----
  async getRecoveryState() {
    return requireBridge('Reading update recovery state').getRecoveryState();
  },
  async restorePreviousVersion() {
    return requireBridge('Restoring the previous version').restorePreviousVersion();
  },
  async dismissRecovery() {
    return requireBridge('Closing the recovery notice').dismissRecovery();
  },

  // ---- Export (SPEC 14) ----
  async startExport(request: ExportStartRequestPayload) {
    return requireBridge('Exporting').startExport(request);
  },
  async cancelExport(jobId: string) {
    return requireBridge('Cancelling that export').cancelExport(jobId);
  },
  async retryExport(jobId: string) {
    return requireBridge('Retrying that export').retryExport(jobId);
  },
  async dismissExport(jobId: string) {
    return requireBridge('Closing that export').dismissExport(jobId);
  },
  async getExportQueue() {
    return requireBridge('Reading the export queue').getExportQueue();
  },
  async setExportConcurrency(value: number) {
    return requireBridge('Saving that setting').setExportConcurrency(value);
  },
  async listExportHistory(projectId?: string) {
    return requireBridge('Reading export history').listExportHistory(projectId);
  },
  async getExportJob(jobId: string) {
    return requireBridge('Reading the export').getExportJob(jobId);
  },
  async getExportSpeed(projectId?: string) {
    return requireBridge('Reading export speed').getExportSpeed(projectId);
  },
  async planExport(settings: Record<string, unknown>) {
    return requireBridge('Preparing the export').planExport(settings);
  },
  async exportSubtitles(settings: Record<string, unknown>) {
    return requireBridge('Preparing subtitles').exportSubtitles(settings);
  },
  async openExportFolder(filePath: string) {
    return requireBridge('Opening that folder').openExportFolder(filePath);
  },
  onExportProgress(callback: (p: ExportProgressPayload) => void) {
    return getBridge()?.onExportProgress(callback) ?? (() => undefined);
  },

  // ---- App ----
  async getAppInfo() {
    return requireBridge('Reading app info').getAppInfo();
  },
};

/** Human-readable message for any error thrown by an IPC call. */
export function describeError(err: unknown): string {
  if (err instanceof DesktopRequiredError) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const raw = String((err as { message: unknown }).message);
    // Electron prefixes IPC rejections with "Error invoking remote method ..."
    return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }
  return 'Something went wrong. Please try again.';
}
