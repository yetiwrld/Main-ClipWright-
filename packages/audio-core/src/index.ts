/**
 * SPEC 12 §6.1 — the audio model shared by the preview and the export.
 *
 * Pure TypeScript, no Web Audio and no PCM buffering: `export-core` owns the mixer
 * and the renderer owns the Web Audio graph, but both ask *this* package what the
 * gain is at a given instant. That is the whole point of it existing — two
 * implementations of a volume envelope will always drift, and the audible result is
 * a preview that sounds right and an export that clips.
 */
export const AUDIO_CORE_VERSION = '1.0.0';

export {
  SILENCE_DB,
  activeRanges,
  applyGainEnvelope,
  dbToGain,
  easingValue,
  envelopeCurve,
  fadeAt,
  fadeCurveValue,
  gainAt,
  gainToDb,
  valueAt,
  type EnvelopeKeyframe,
  type FadeCurve,
  type GainEnvelopeInput,
} from './envelope.js';

export {
  EMPTY_LOUDNESS_WINDOW,
  LOUDNESS_FLOOR_LUFS,
  MOMENTARY_WINDOW_MS,
  SILENT_READING,
  ZERO_BIQUAD,
  ZERO_K_WEIGHT,
  channelMeanSquare,
  describeLoudness,
  gateSamples,
  kWeight,
  loudnessOf,
  pushLoudness,
  type BiquadState,
  type KWeightState,
  type LoudnessReading,
  type LoudnessWindow,
} from './loudness.js';

export {
  gainAtInstant,
  gainCurveFor,
  hasAudioAt,
  previewAudioRequests,
  type PreviewAudioRequest,
  type PreviewAudioTimeline,
} from './preview-graph.js';
