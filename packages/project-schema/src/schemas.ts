import { z } from 'zod';

/** Helper: top-level payloads keep unknown fields so newer apps don't lose data. */
const passthrough = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const MicrosecondsSchema = z.number().int().nonnegative();
export const FpsSchema = z.union([z.literal(30), z.literal(60)]);
export type Fps = z.infer<typeof FpsSchema>;

/* ---------------------------------------------------------------- media */
export const MediaKindSchema = z.enum(['video', 'audio', 'image']);
export const MediaStorageModeSchema = z.enum(['managed', 'reference']);
export const MediaStatusSchema = z.enum(['ok', 'missing', 'changed']);

export const MediaInfoSchema = passthrough({
  mediaId: z.string(),
  kind: MediaKindSchema,
  container: z.string().default('unknown'),
  durationUs: MicrosecondsSchema,
  sizeBytes: z.number().int().nonnegative(),
  bitrate: z.number().nonnegative().optional(),
  video: passthrough({
    codec: z.string(),
    profile: z.string().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    displayWidth: z.number().int().positive(),
    displayHeight: z.number().int().positive(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    sar: z.string().default('1:1'),
    dar: z.string().default('1:1'),
    fps: z.number().positive(),
    fpsMode: z.enum(['constant', 'variable', 'unknown']).default('unknown'),
    pixFmt: z.string().default('unknown'),
    colorSpace: z.string().optional(),
    hdr: z.boolean().default(false),
    bitDepth: z.number().int().optional(),
    hasAlpha: z.boolean().default(false),
  }).optional(),
  audio: z.array(passthrough({
    index: z.number().int().nonnegative(),
    codec: z.string(),
    channels: z.number().int().nonnegative(),
    sampleRate: z.number().int().nonnegative(),
    language: z.string().optional(),
    title: z.string().optional(),
    default: z.boolean().default(false),
  })).default([]),
  metadata: z.record(z.string()).default({}),
  creationTime: z.string().optional(),
  hasSpeechAudio: z.boolean().default(true),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

export const MediaAssetSchema = passthrough({
  id: z.string(),
  kind: MediaKindSchema,
  storageMode: MediaStorageModeSchema,
  path: z.string(),
  originalName: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  fingerprint: z.string(),
  volumeId: z.string().optional(),
  createdAt: z.number().int(),
  info: MediaInfoSchema.optional(),
  status: MediaStatusSchema.default('ok'),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/* ------------------------------------------------------- settings snap */
export const AspectRatioChoiceSchema = z.union([
  z.literal('9:16'), z.literal('16:9'), z.literal('1:1'), z.literal('4:5'),
  z.literal('4:3'), z.literal('21:9'), z.literal('original'),
  z.object({ customW: z.number().int().min(1).max(32), customH: z.number().int().min(1).max(32) }),
]);
export type AspectRatioChoice = z.infer<typeof AspectRatioChoiceSchema>;

export const ClipLengthChoiceSchema = z.union([
  z.literal('short'),    // 15-30s
  z.literal('medium'),   // 30-60s
  z.literal('long'),     // 60-90s
  z.literal('extended'), // 90-180s
  z.object({ minUs: MicrosecondsSchema, maxUs: MicrosecondsSchema }),
]);
export type ClipLengthChoice = z.infer<typeof ClipLengthChoiceSchema>;

export const NumClipsChoiceSchema = z.union([z.literal('auto'), z.number().int().min(1).max(50)]);
export type NumClipsChoice = z.infer<typeof NumClipsChoiceSchema>;

export const ContentTypeSchema = z.enum([
  'auto', 'podcast', 'talking-head', 'tutorial', 'gaming', 'lecture', 'other',
]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const ProcessingModeSchema = z.enum(['offline', 'online', 'automatic']);
export type ProcessingMode = z.infer<typeof ProcessingModeSchema>;

export const ProjectSettingsSnapshotSchema = passthrough({
  aspectRatio: AspectRatioChoiceSchema.default('9:16'),
  captionStyleId: z.string().default('bold-creator'),
  clipLength: ClipLengthChoiceSchema.default('medium'),
  numClips: NumClipsChoiceSchema.default('auto'),
  clipFocus: z.string().max(300).default(''),
  contentType: ContentTypeSchema.default('auto'),
  language: z.string().default('auto'),
  processingMode: ProcessingModeSchema.default('automatic'),
  downloadQuality: z.enum(['720p', '1080p', 'best']).default('1080p'),
  transcriptionModel: z.string().default('auto'),
  storageMode: z.enum(['copy', 'reference']).default('copy'),
  initialFraming: z.object({ x: z.number(), y: z.number(), scale: z.number().positive() }).optional(),
  projectName: z.string().max(200).default(''),
});
export type ProjectSettingsSnapshot = z.infer<typeof ProjectSettingsSnapshotSchema>;

/* ------------------------------------------------------------- project */
export const ProjectStageSchema = z.enum([
  'created', 'importing', 'import-failed', 'transcribing', 'transcribe-failed',
  'transcribed', 'moments', 'moments-failed', 'moments-ready', 'editor', 'exported',
]);
export type ProjectStage = z.infer<typeof ProjectStageSchema>;

export const ProjectRecordSchema = passthrough({
  id: z.string(),
  name: z.string().min(1).max(200),
  stage: ProjectStageSchema.default('created'),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  archived: z.boolean().default(false),
  settings: ProjectSettingsSnapshotSchema,
  sourceMediaId: z.string().optional(),
  sourceUrl: z.string().optional(),
  thumbnailPath: z.string().optional(),
  schemaVersion: z.number().int().default(1),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

/* --------------------------------------------------------- transcript */
export const TranscriptWordSchema = passthrough({
  id: z.string(),
  index: z.number().int().nonnegative(),
  text: z.string(),
  startUs: MicrosecondsSchema,
  endUs: MicrosecondsSchema,
  confidence: z.number().min(0).max(1).optional(),
  speaker: z.string().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const CaptionChunkSchema = passthrough({
  id: z.string(),
  startUs: MicrosecondsSchema,
  endUs: MicrosecondsSchema,
  text: z.string(),
  wordIds: z.array(z.string()).default([]),
  emphasisWordIds: z.array(z.string()).default([]),
});
export type CaptionChunk = z.infer<typeof CaptionChunkSchema>;

/* ------------------------------------------------------------- moments */
export const MomentScoreSchema = passthrough({
  hook: z.number().min(0).max(20),
  standalone: z.number().min(0).max(20),
  emotion: z.number().min(0).max(15),
  interest: z.number().min(0).max(15),
  story: z.number().min(0).max(10),
  value: z.number().min(0).max(10),
  pacing: z.number().min(0).max(5),
  social: z.number().min(0).max(5),
});
export type MomentScore = z.infer<typeof MomentScoreSchema>;

export const MomentSchema = passthrough({
  id: z.string(),
  projectId: z.string(),
  startUs: MicrosecondsSchema,
  endUs: MicrosecondsSchema,
  score: z.number().min(0).max(100),
  breakdown: MomentScoreSchema,
  reasons: z.array(z.string()).default([]),
  title: z.string().default(''),
  excerpt: z.string().default(''),
  status: z.enum(['candidate', 'favourite', 'rejected', 'clip-created']).default('candidate'),
  stale: z.boolean().default(false),
  createdAt: z.number().int(),
});
export type Moment = z.infer<typeof MomentSchema>;

/* -------------------------------------------------------- composition */
export const TrackTypeSchema = z.enum([
  'video', 'overlay', 'image', 'voiceover', 'audio', 'music', 'sfx',
  'caption', 'text', 'adjustment',
]);
export type TrackType = z.infer<typeof TrackTypeSchema>;

export const TrackSchema = passthrough({
  id: z.string(),
  type: TrackTypeSchema,
  name: z.string(),
  order: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  height: z.number().int().min(32).max(200).default(64),
});
export type Track = z.infer<typeof TrackSchema>;

export const TransformSchema = passthrough({
  x: z.number().default(0),          // px in composition space, centre-anchored offset
  y: z.number().default(0),
  scale: z.number().positive().default(1),
  rotationDeg: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  crop: z.object({
    left: z.number().min(0).max(1).default(0),
    top: z.number().min(0).max(1).default(0),
    right: z.number().min(0).max(1).default(0),
    bottom: z.number().min(0).max(1).default(0),
  }).default({ left: 0, top: 0, right: 0, bottom: 0 }),
  flipH: z.boolean().default(false),
  flipV: z.boolean().default(false),
});
export type Transform = z.infer<typeof TransformSchema>;

export const ItemKindSchema = z.enum(['video', 'audio', 'image', 'text', 'caption', 'graphics', 'adjustment']);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ItemSchema = passthrough({
  id: z.string(),
  trackId: z.string(),
  kind: ItemKindSchema,
  name: z.string().default(''),
  startUs: MicrosecondsSchema,
  durationUs: MicrosecondsSchema,
  inUs: MicrosecondsSchema.default(0),   // source offset for media items
  mediaId: z.string().optional(),
  transform: TransformSchema.default({}),
  volume: z.number().min(0).max(2).default(1),
  fadeInUs: MicrosecondsSchema.default(0),
  fadeOutUs: MicrosecondsSchema.default(0),
  muted: z.boolean().default(false),
  text: z.string().optional(),           // for text/caption/graphics items
  captionStyleId: z.string().optional(),
  fontSize: z.number().positive().optional(),
  effects: z.array(z.string()).default([]),
});
export type Item = z.infer<typeof ItemSchema>;

export const MarkerSchema = passthrough({
  id: z.string(),
  timeUs: MicrosecondsSchema,
  label: z.string().default(''),
  color: z.string().default('#FFB000'),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const KeyframeSchema = passthrough({
  id: z.string(),
  itemId: z.string(),
  property: z.string(),
  timeUs: MicrosecondsSchema,   // relative to item start
  value: z.number(),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']).default('ease-in-out'),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const EffectSchema = passthrough({
  id: z.string(),
  itemId: z.string().optional(),   // undefined = track/adjustment level
  type: z.string(),
  enabled: z.boolean().default(true),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});
export type Effect = z.infer<typeof EffectSchema>;

export const TransitionSchema = passthrough({
  id: z.string(),
  trackId: z.string(),
  junctionItemId: z.string(),   // the item AFTER the cut
  type: z.enum(['dissolve', 'fade-black', 'fade-white', 'wipe-left', 'wipe-right', 'slide-left', 'slide-right', 'zoom', 'spin', 'none']),
  durationUs: MicrosecondsSchema.default(500_000),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const CompositionSchema = passthrough({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  fps: FpsSchema.default(30),
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  tracks: z.array(TrackSchema).default([]),
  items: z.array(ItemSchema).default([]),
  markers: z.array(MarkerSchema).default([]),
  keyframes: z.array(KeyframeSchema).default([]),
  effects: z.array(EffectSchema).default([]),
  transitions: z.array(TransitionSchema).default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  schemaVersion: z.number().int().default(1),
});
export type Composition = z.infer<typeof CompositionSchema>;

/** Duration of a composition = end of the last item (0 if empty). */
export const compositionDurationUs = (c: Composition): number =>
  c.items.reduce((end, it) => Math.max(end, it.startUs + it.durationUs), 0);

/* -------------------------------------------------------- save/restore */
export const JournalEntrySchema = passthrough({
  seq: z.number().int().nonnegative(),
  compId: z.string(),
  ts: z.number().int(),
  commandName: z.string(),
  forward: z.unknown(),
  inverse: z.unknown(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/* ---------------------------------------------------------------- jobs */
export const JobStatusSchema = z.enum(['queued', 'running', 'paused', 'cancelling', 'cancelled', 'failed', 'done']);
export const JobTypeSchema = z.enum([
  'probe', 'copy', 'download', 'extract_audio', 'thumbnails', 'proxy', 'peaks',
  'transcribe', 'analyse', 'moments', 'export', 'audio_enhance',
]);
export const JobSchema = passthrough({
  id: z.string(),
  type: JobTypeSchema,
  projectId: z.string().optional(),
  mediaId: z.string().optional(),
  params: z.record(z.unknown()).default({}),
  status: JobStatusSchema.default('queued'),
  priority: z.enum(['user-blocking', 'editing-helper', 'background']).default('background'),
  progress: z.number().min(0).max(1).default(0),
  attempt: z.number().int().nonnegative().default(0),
  error: z.string().nullish(),
  errorTechnical: z.string().nullish(),
  startedAt: z.number().int().nullish(),
  finishedAt: z.number().int().nullish(),
  createdAt: z.number().int(),
});
export type Job = z.infer<typeof JobSchema>;

/* ------------------------------------------------------------ settings */
export const AppSettingsSchema = passthrough({
  workspaceFolder: z.string().nullable().default(null),
  processingMode: ProcessingModeSchema.default('automatic'),
  autoSaveSeconds: z.number().min(10).max(300).default(30),
  autoSaveMaxIntervalSeconds: z.number().int().default(300),
  proxyQuality: z.enum(['low', 'medium', 'high']).default('medium'),
  alwaysCreateProxies: z.boolean().default(false),
  restorePoints: z.boolean().default(true),
  dailyAutoBackup: z.boolean().default(false),
  duckingEnabled: z.boolean().default(true),
  loudnessTargetLufs: z.number().default(-16),
  defaultAudioBitrateKbps: z.number().int().default(192),
  downloadQuality: z.enum(['720p', '1080p', 'best']).default('1080p'),
  transcriptionModel: z.string().default('auto'),
  firstRunComplete: z.boolean().default(false),
  cookiesFilePath: z.string().nullable().default(null),
  ollamaModel: z.string().default('llama3.1:8b'),
  preferredOnlineProviderId: z.string().nullable().default(null),
  lastUsed: ProjectSettingsSnapshotSchema.partial().default({}),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const defaultAppSettings = (): AppSettings => AppSettingsSchema.parse({});
export const defaultProjectSettings = (): ProjectSettingsSnapshot =>
  ProjectSettingsSnapshotSchema.parse({});
