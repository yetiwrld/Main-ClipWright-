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
  formatValidationVerdict,
  failedCheckNames,
} from './validation.js';
export type {
  ValidationReport,
  ValidationCheck,
  ValidationStatus,
  ValidationOptions,
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
  formatJobSummary,
  formatEta,
  isCancellable,
  ACTIVE_EXPORT_STATUSES,
  FINISHED_EXPORT_STATUSES,
} from './job-queue.js';
export type {
  ExportJob,
  ExportJobStatus,
  ExportQueueState,
} from './job-queue.js';

// Encoder (ffmpeg arguments, codec table, hardware selection)
export {
  buildEncoderArgs,
  buildDecodeArgs,
  buildLoudnessArgs,
  chooseVideoEncoder,
  containerFor,
  audioArgs,
  metadataArgs,
  videoQualityArgs,
  sourceFilterChain,
  buildSegmentedDecodeArgs,
  hardwareQualityValue,
  parseIntegratedLoudness,
  loudnessGainDb,
  cfrArgs,
  detectCapabilities,
  COLOUR_ARGS,
  DEFAULT_CAPABILITIES,
  SOFTWARE_H264,
  SOFTWARE_VP9,
  HARDWARE_ENCODERS,
} from './encoder.js';

/**
 * SPEC 12 §2.2 — keyframed geometry in a decode with no notion of time.
 *
 * ffmpeg 4.1 evaluates `scale`/`crop` once, so a keyframed move is rendered as
 * several segments with a constant value each, concatenated.
 */
export {
  geometrySegments,
  sameGeometry,
  segmentBoundaries,
  segmentedDecodeChain,
  type GeometryAt,
  type GeometrySegment,
} from './keyframe-segments.js';
export type { EncoderCapabilities, EncoderInputs, HardwareEncoderId, VideoEncoderChoice } from './encoder.js';

// Audio mix (§5 / SPEC 12 §6.1)
export {
  MIX_SAMPLE_RATE,
  MIX_CHANNELS,
  LIMITER_CEILING_DB,
  usToSamples,
  samplesToUs,
  createClip,
  clipEndSamples,
  applyItemProcessing,
  applyCrossfade,
  equalPowerGain,
  mixClipInto,
  duckingCurve,
  applyGainCurve,
  peakLevel,
  amplitudeToDb,
  isSilent,
  limit,
  fitLength,
} from './audio-mix.js';
export type { ItemMixParams, PcmClip } from './audio-mix.js';

// Quick presets (§3.5)
export {
  BUILT_IN_QUICK_PRESETS,
  validateQuickPresets,
  findQuickPreset,
  applyQuickPreset,
} from './quick-presets.js';
export type { QuickPreset, QuickPresetSettings, QuickPresetFile, PresetValidationIssue } from './quick-presets.js';

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

// Styled caption burn-in (§4.3) — an ASS script ffmpeg renders itself.
export {
  assAlignment,
  assColour,
  assCuesFromPlan,
  assDialogue,
  assHeader,
  assStyleLine,
  assStyleName,
  assTimestamp,
  buildAssScript,
  escapeAssText,
} from './ass-captions.js';
export type { AssCue, AssScriptOptions, AssWord } from './ass-captions.js';
