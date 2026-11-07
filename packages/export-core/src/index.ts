export const EXPORT_CORE_VERSION = '1.0.0';

// Presets
export {
  EXPORT_PRESETS,
  ASPECT_RATIOS,
  QUALITY_PRESETS,
  OUTPUT_FORMATS,
  EXPORT_FPS_OPTIONS,
  AUDIO_BITRATES,
  RATE_CONTROL_MODES,
  EXPORT_RANGE_OPTIONS,
  DEFAULT_AUDIO_BITRATE,
  roundEven,
  parseAspect,
  computeResolution,
  resolutionForPreset,
} from './presets.js';
export type {
  ExportPresetId,
  AspectRatio,
  QualityPresetId,
  OutputFormatId,
  ExportFps,
  AudioBitrate,
  RateControlMode,
  ExportRange,
} from './presets.js';

// Planner
export { buildExportPlan } from './planner.js';
export type {
  ExportPlan,
  ExportSettings,
  PlannedItem,
} from './planner.js';

// Validation
export {
  validateExport,
  parseFrameRate,
  formatValidationSummary,
} from './validation.js';
export type {
  ValidationReport,
  ValidationCheck,
  ValidationStatus,
  ProbeResult,
} from './validation.js';

// Job queue
export {
  createExportJob,
  updateJobStatus,
  sortJobs,
  filterJobsByStatus,
  calculateEta,
  calculateSpeed,
} from './job-queue.js';
export type {
  ExportJob,
  ExportJobStatus,
  ExportQueueState,
} from './job-queue.js';

// Subtitles
export {
  generateSrt,
  generateVtt,
  generateSubtitles,
  extractCuesFromItems,
  formatSrtTimestamp,
  formatVttTimestamp,
} from './subtitles.js';
export type { CaptionCue } from './subtitles.js';
