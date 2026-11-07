import type {
  AiTask,
  ClipwrightBridge,
  IngestRequestPayload,
  JobProgressPayload,
  ModelDownloadProgressPayload,
  MomentsProgressPayload,
  ProviderSaveInput,
  TranscribeRequestPayload,
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

  // ---- Media ----
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
  onModelProgress(callback: (p: { modelName: string; percent: number }) => void) {
    return getBridge()?.onModelProgress(callback) ?? (() => undefined);
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
