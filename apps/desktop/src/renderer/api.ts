import type {
  ClipwrightBridge,
  IngestRequestPayload,
  JobProgressPayload,
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
