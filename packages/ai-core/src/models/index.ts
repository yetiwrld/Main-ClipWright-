/**
 * SPEC 06 §7 — local model manager.
 *
 * Catalogue, download engine and the single-concurrency queue. The desktop app
 * owns the folder paths and forwards progress; nothing here talks to the UI
 * directly.
 */

export * from './types.js';
export {
  WHISPER_CATALOG,
  ONNX_CATALOG,
  accuracyLabel,
  byAccuracy,
  compatibilityFor,
  describeCompatibility,
  findOnnxModel,
  findWhisperModel,
  hasRoomForDownload,
  machineProfile,
  onnxCards,
  onnxChecksums,
  scanModelDir,
  whisperCards,
  whisperChecksums,
} from './catalog.js';
export {
  ChecksumMismatchError,
  DownloadCancelledError,
  downloadFile,
  freeDiskGb,
  partialBytes,
  removeModelFile,
  sha256OfFile,
} from './download.js';
export { ModelManager, defaultOllamaBaseUrl, type DownloadJob, type ModelManagerOptions } from './manager.js';
export {
  OLLAMA_SUGGESTIONS,
  PROVIDER_PRESETS,
  getProviderPreset,
  presetsForKind,
  presetsWithCapability,
  type OllamaSuggestion,
  type ProviderPreset,
} from '../providers/presets.js';
