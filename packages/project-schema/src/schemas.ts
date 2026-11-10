import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 2;

export const InitialFramingSchema = z
  .object({
    x: z.number().default(0),
    y: z.number().default(0),
    scale: z.number().min(0.1).max(10).default(1),
  })
  .passthrough();

export const ProjectSettingsSchema = z
  .object({
    aspect: z
      .enum(['9:16', '16:9', '1:1', '4:5', '4:3', '21:9', 'original', 'custom'])
      .default('9:16'),
    customAspect: z
      .object({
        width: z.number().int().min(1).max(32).default(9),
        height: z.number().int().min(1).max(32).default(16),
      })
      .optional(),
    captionStyleId: z.string().default('bold-creator'),
    clipLengthPreset: z
      .enum(['short', 'medium', 'long', 'extended', 'custom'])
      .default('medium'),
    clipLengthRangeSec: z.tuple([z.number().min(5), z.number().max(600)]).default([30, 60]),
    clipCount: z.union([z.literal('auto'), z.number().int().min(1).max(50)]).default('auto'),
    clipFocus: z.string().max(300).default(''),
    contentType: z
      .enum(['auto', 'podcast', 'talking', 'tutorial', 'gaming', 'lecture', 'other'])
      .default('auto'),
    language: z.string().default('auto'),
    processingMode: z.enum(['offline', 'online', 'automatic']).default('automatic'),
    downloadQuality: z.enum(['720p', '1080p', 'best']).default('1080p'),
    whisperModel: z.string().default('auto'),
    storageMode: z.enum(['managed', 'reference']).default('managed'),
    initialFraming: InitialFramingSchema.default({ x: 0, y: 0, scale: 1 }),
    autoReframe: z.boolean().default(false),
  })
  .passthrough();

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectStageSchema = z.enum([
  'import',
  'transcribe',
  'moments',
  'editor',
  'exported',
]);

export type ProjectStage = z.infer<typeof ProjectStageSchema>;

export const ProjectRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    archived: z.boolean().default(false),
    stage: ProjectStageSchema.default('import'),
    sourceMediaIds: z.array(z.string()).default([]),
    thumbnailPath: z.string().optional(),
    schemaVersion: z.number().int().default(CURRENT_SCHEMA_VERSION),
    appVersionLastSaved: z.string().default('1.0.0'),
    settings: ProjectSettingsSchema.default({}),
  })
  .passthrough();

export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const KeyframeEasingPresetSchema = z.enum([
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeInBack',
  'easeOutBack',
  'easeOutBounce',
  'easeOutElastic',
]);

export const KeyframeSchema = z
  .object({
    timeUs: z.number().int().min(0),
    value: z.union([
      z.number(),
      z.tuple([z.number(), z.number(), z.number(), z.number()]),
    ]),
    interpolation: z.enum(['linear', 'hold', 'bezier', 'preset']).default('linear'),
    easing: z
      .object({
        preset: KeyframeEasingPresetSchema,
      })
      .optional(),
    bezier: z
      .object({
        outX: z.number().min(0).max(1),
        outY: z.number(),
        inX: z.number().min(0).max(1),
        inY: z.number(),
      })
      .optional(),
  })
  .passthrough();

export type Keyframe = z.infer<typeof KeyframeSchema>;

export const EffectInstanceSchema = z
  .object({
    id: z.string().min(1),
    effectId: z.string().min(1),
    enabled: z.boolean().default(true),
    params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  })
  .passthrough();

export type EffectInstance = z.infer<typeof EffectInstanceSchema>;

export const TransitionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum([
      'crossfade',
      'dissolve',
      'fade-black',
      'dip-color',
      'wipe',
      'slide',
      'zoom',
    ]),
    durationUs: z.number().int().min(1),
    alignment: z.enum(['center', 'start', 'end']).default('center'),
    params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
    easing: KeyframeEasingPresetSchema.default('easeInOut'),
    crossfadeAudio: z.boolean().default(true),
  })
  .passthrough();

export type Transition = z.infer<typeof TransitionSchema>;

export const CaptionWordRefSchema = z
  .object({
    wordId: z.string(),
    startUs: z.number().int(),
    endUs: z.number().int(),
    textOverride: z.string().optional(),
  })
  .passthrough();

export const CaptionSegmentSchema = z
  .object({
    id: z.string().min(1),
    wordRefs: z.array(CaptionWordRefSchema),
    startUs: z.number().int().min(0),
    endUs: z.number().int().min(0),
    text: z.string(),
    lines: z.array(z.string()),
    speaker: z.string().optional(),
    manualTiming: z.boolean().default(false),
    manualText: z.boolean().default(false),
    transcriptChanged: z.boolean().optional(),
    wordOverrides: z
      .record(
        z.string(),
        z.object({
          emphasis: z.boolean().optional(),
          color: z.string().optional(),
          scale: z.number().optional(),
        })
      )
      .optional(),
  })
  .passthrough();

export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;

export const TransformStateSchema = z
  .object({
    x: z.number().default(0),
    y: z.number().default(0),
    scaleX: z.number().default(1),
    scaleY: z.number().default(1),
    rotation: z.number().default(0),
    anchorX: z.number().default(0.5),
    anchorY: z.number().default(0.5),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
  })
  .passthrough();

export const CropStateSchema = z
  .object({
    left: z.number().min(0).max(0.95).default(0),
    top: z.number().min(0).max(0.95).default(0),
    right: z.number().min(0).max(0.95).default(0),
    bottom: z.number().min(0).max(0.95).default(0),
    radius: z.number().min(0).default(0),
  })
  .passthrough();

export const TimelineItemSchema = z
  .object({
    id: z.string().min(1),
    trackId: z.string().min(1),
    type: z.enum([
      'video',
      'image',
      'audio',
      'caption',
      'text',
      'shape',
      'icon',
      'sticker',
      'adjustment',
    ]),
    startUs: z.number().int().min(0),
    durationUs: z.number().int().min(1),
    label: z.string().default('Item'),
    disabled: z.boolean().default(false),
    linkId: z.string().optional(),
    groupId: z.string().optional(),
    mediaId: z.string().optional(),
    sourceInUs: z.number().int().min(0).default(0),
    sourceDurationUs: z.number().int().min(1).optional(),
    speed: z.number().min(0.1).max(8).default(1),
    volumeDb: z.number().min(-60).max(12).default(0),
    gainDb: z.number().min(-24).max(24).default(0),
    pan: z.number().min(-100).max(100).default(0),
    fadeInUs: z.number().int().min(0).default(0),
    fadeOutUs: z.number().int().min(0).default(0),
    fadeCurve: z.enum(['linear', 'equal-power', 'exponential']).default('equal-power'),
    /**
     * Noise reduction, when the user has asked for it (SPEC 12 §6.8).
     *
     * The spec's rule is that the item **points to the derived file** and *Revert* restores the
     * original — so this stores the strength and the path of the cleaned copy, and the original
     * media is never touched. Optional throughout: an item without it plays its source, which is
     * what every project written before this field existed does.
     *
     * `path` is stored rather than recomputed because the derived file is content-addressed on the
     * range and filter chain: recomputing it needs the same inputs the job ran with, and an item
     * whose range was later trimmed would compute a *different* key and silently lose its cleaned
     * audio. The path is the fact.
     */
    noiseReduction: z
      .object({
        strength: z.enum(['low', 'medium', 'high']),
        /** Absolute path of the denoised WAV under the media's `derived/enhanced` directory. */
        path: z.string().min(1),
        /** Which denoiser produced it, so the panel can say so and a re-run can be explained. */
        method: z.enum(['arnndn', 'afftdn']).optional(),
        /** When it was made, for the panel's own line. Not used for ordering anything. */
        createdAt: z.string().optional(),
      })
      .passthrough()
      .optional(),
    muted: z.boolean().default(false),
    opacity: z.number().min(0).max(1).default(1),
    blendMode: z
      .enum(['normal', 'multiply', 'screen', 'overlay', 'add', 'soft-light'])
      .default('normal'),
    transform: TransformStateSchema.default({}),
    crop: CropStateSchema.default({}),
    keyframes: z.record(z.string(), z.array(KeyframeSchema)).default({}),
    effects: z.array(EffectInstanceSchema).default([]),
    transitionIn: TransitionSchema.optional(),
    transitionOut: TransitionSchema.optional(),
    captionSegment: CaptionSegmentSchema.optional(),
    captionStyleId: z.string().optional(),
    styleOverrides: z.record(z.string(), z.unknown()).optional(),
    textContent: z.string().optional(),
    shapeKind: z
      .enum(['rect', 'round-rect', 'ellipse', 'triangle', 'polygon', 'star', 'line', 'arrow', 'bubble'])
      .optional(),
    /*
      SPEC 11 §12 — an icon item names a Lucide icon rather than carrying its geometry.
      `iconName` is the normal case and is what the picker writes: the library ships with
      the build, so the name is enough and two projects using the same icon share nothing.
      `iconShapes` is the escape hatch for a file opened by a build whose Lucide set is
      older or newer than the one that saved it — without it, an icon added in a future
      version would draw nothing, silently. Named shapes win over the library when both
      are present, because the stored geometry is what the file says the icon *was*.
    */
    iconName: z.string().optional(),
    /*
      SPEC 11 §12's "stroke width adjustable (0.5–4)", in the icon's own units — the 24-box
      Lucide draws in, where the library's own default is 2. Absent means the default, so a
      project written before this field existed draws exactly as it did.
    */
    iconStrokeWidth: z.number().min(0.5).max(4).optional(),
    iconShapes: z
      .array(
        z.discriminatedUnion('t', [
          z.object({ t: z.literal('path'), d: z.string() }),
          z.object({ t: z.literal('circle'), cx: z.number(), cy: z.number(), r: z.number() }),
          z.object({
            t: z.literal('rect'),
            x: z.number(),
            y: z.number(),
            w: z.number(),
            h: z.number(),
            rx: z.number().optional(),
          }),
          z.object({
            t: z.literal('line'),
            x1: z.number(),
            y1: z.number(),
            x2: z.number(),
            y2: z.number(),
          }),
          z.object({ t: z.literal('polyline'), points: z.string() }),
          z.object({ t: z.literal('polygon'), points: z.string() }),
          z.object({
            t: z.literal('ellipse'),
            cx: z.number(),
            cy: z.number(),
            rx: z.number(),
            ry: z.number(),
          }),
        ])
      )
      .optional(),
    aiProvenance: z
      .object({
        tool: z.string(),
        version: z.number().default(1),
        appliedAt: z.string(),
        kitId: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const TrackRoleSchema = z.enum([
  'main',
  'overlay',
  'image',
  'voiceover',
  'music',
  'sfx',
  'captions',
  'text',
  'graphics',
  'adjustment',
]);

export const TrackKindSchema = z.enum(['video', 'audio', 'caption', 'text', 'effect']);

export const TrackSchema = z
  .object({
    id: z.string().min(1),
    role: TrackRoleSchema,
    kind: TrackKindSchema,
    name: z.string().min(1),
    order: z.number().int(),
    hidden: z.boolean().default(false),
    locked: z.boolean().default(false),
    muted: z.boolean().default(false),
    solo: z.boolean().default(false),
    heightPx: z.number().int().min(28).max(160).default(48),
    magnetic: z.boolean().optional(),
    auto: z.boolean().default(false),
    itemIds: z.array(z.string()).default([]),
    ducking: z
      .object({
        enabled: z.boolean().default(false),
        triggerTrackIds: z.array(z.string()).default([]),
        reductionDb: z.number().default(-12),
        thresholdDb: z.number().default(-42),
        attackMs: z.number().default(120),
        releaseMs: z.number().default(400),
      })
      .optional(),
  })
  .passthrough();

export type Track = z.infer<typeof TrackSchema>;

export const MarkerSchema = z
  .object({
    id: z.string().min(1),
    timeUs: z.number().int().min(0),
    name: z.string().default('Marker'),
    note: z.string().optional(),
    color: z.string().default('#FFB000'),
  })
  .passthrough();

export type Marker = z.infer<typeof MarkerSchema>;

export const WorkAreaSchema = z
  .object({
    inUs: z.number().int().min(0),
    outUs: z.number().int().min(1),
  })
  .passthrough();

export const LinkGroupSchema = z
  .object({
    id: z.string().min(1),
    itemIds: z.array(z.string()),
  })
  .passthrough();

export const GroupSchema = z
  .object({
    id: z.string().min(1),
    itemIds: z.array(z.string()),
  })
  .passthrough();

export const CompositionTogglesSchema = z
  .object({
    snapping: z.boolean().default(true),
    magneticMain: z.boolean().default(true),
    rippleAll: z.boolean().default(false),
    linkedSelection: z.boolean().default(true),
    followPlayhead: z.boolean().default(true),
    showWaveforms: z.boolean().default(true),
    showKeyframes: z.boolean().default(false),
    editMode: z.enum(['normal', 'insert', 'overwrite']).default('normal'),
    coverLock: z.boolean().default(true),
    linkedToTranscript: z.boolean().default(true),
  })
  .passthrough();

/**
 * A user-placed composition guide (SPEC 10 §8.8).
 *
 * Saved with the project — unlike the safe-area and thirds overlays, which are view
 * state and never written — because a guide is something the user *made*: it marks where
 * this video's subject sits, and it should still be there tomorrow.
 *
 * `at` is a fraction of the canvas on the named axis, measured from the top-left, the
 * same space the guides are drawn in. Storing it that way rather than as a pixel keeps it
 * correct when the canvas resolution changes, and keeps the snapping conversion a single
 * subtraction rather than a two-step with an aspect ratio in it.
 */
export const UserGuideSchema = z
  .object({
    id: z.string().min(1),
    axis: z.enum(['x', 'y']),
    at: z.number().min(0).max(1),
    /**
     * Whether this guide is protected from the removal gesture (SPEC 10 §8.8's *Lock*).
     *
     * Defaulted rather than required, so a guide saved before Lock existed opens unlocked
     * — which is the state it was actually in.
     */
    locked: z.boolean().default(false),
  })
  .passthrough();

export type UserGuide = z.infer<typeof UserGuideSchema>;

export const CompositionPayloadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    fps: z.union([z.literal(30), z.literal(60)]).default(30),
    canvas: z
      .object({
        width: z.number().int().min(128).max(7680).default(1080),
        height: z.number().int().min(128).max(7680).default(1920),
        aspect: z.string().default('9:16'),
        backgroundColor: z.string().default('#000000'),
        backgroundBlur: z.boolean().default(false),
      })
      .passthrough(),
    tracks: z.array(TrackSchema),
    items: z.record(z.string(), TimelineItemSchema),
    markers: z.array(MarkerSchema).default([]),
    workArea: WorkAreaSchema.optional(),
    links: z.array(LinkGroupSchema).default([]),
    groups: z.array(GroupSchema).default([]),
    playheadUs: z.number().int().min(0).default(0),
    toggles: CompositionTogglesSchema.default({}),
    viewState: z
      .object({
        pxPerSecond: z.number().min(0.25).max(2000).default(80),
        scrollX: z.number().min(0).default(0),
        scrollY: z.number().min(0).default(0),
        headerWidthPx: z.number().int().min(48).max(280).default(184),
      })
      .default({}),
    editByTranscriptDeletedWordIds: z.array(z.string()).default([]),
    /*
      Defaulted to an empty array so a project saved before guides existed opens with
      none rather than failing validation — the same rule every other field added since
      v1 follows.
    */
    guides: z.array(UserGuideSchema).default([]),
  })
  .passthrough();

export type CompositionPayload = z.infer<typeof CompositionPayloadSchema>;

export const CompositionRecordSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    createdFromMomentId: z.string().optional(),
    version: z.number().int().min(1).default(1),
    payload: CompositionPayloadSchema,
    updatedAt: z.string(),
  })
  .passthrough();

export type CompositionRecord = z.infer<typeof CompositionRecordSchema>;

export const MediaInfoSchema = z
  .object({
    mediaId: z.string(),
    kind: z.enum(['video', 'audio', 'image']),
    container: z.string(),
    durationUs: z.number().int().min(0),
    sizeBytes: z.number().int().min(0),
    bitrate: z.number().optional(),
    hasSpeechAudio: z.boolean().default(true),
    video: z
      .object({
        codec: z.string(),
        profile: z.string().optional(),
        width: z.number().int(),
        height: z.number().int(),
        displayWidth: z.number().int(),
        displayHeight: z.number().int(),
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
        sar: z.string().default('1:1'),
        dar: z.string().default('16:9'),
        fps: z.number(),
        fpsMode: z.enum(['constant', 'variable', 'unknown']).default('constant'),
        pixFmt: z.string().default('yuv420p'),
        colorSpace: z.string().default('bt709'),
        hdr: z.boolean().default(false),
        bitDepth: z.number().int().default(8),
        hasAlpha: z.boolean().default(false),
      })
      .optional(),
    audio: z
      .array(
        z.object({
          index: z.number().int(),
          codec: z.string(),
          channels: z.number().int(),
          sampleRate: z.number().int(),
          language: z.string().optional(),
          title: z.string().optional(),
          default: z.boolean().default(true),
        })
      )
      .default([]),
    metadata: z.record(z.string(), z.string()).default({}),
    creationTime: z.string().optional(),
  })
  .passthrough();

export type MediaInfo = z.infer<typeof MediaInfoSchema>;

export const MediaRecordSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['video', 'audio', 'image']),
    storageMode: z.enum(['managed', 'reference']),
    path: z.string(),
    originalName: z.string(),
    sizeBytes: z.number().int().min(0),
    sha256: z.string().optional(),
    fingerprint: z.string(),
    /**
     * Which volume the file was imported from, and where it was mounted at the time
     * (SPEC 04 §4.1).
     *
     * The identifier survives the volume coming back at a different mount point — the
     * ordinary external-drive failure — and the root is what a relocated path is rebuilt
     * from: `E:\` plus the relative path the record already carries. Without the root the
     * identifier alone says "the right disk" but not where on it the file sits, which is
     * why recording one is what made the other usable.
     *
     * Only **reference** imports set these. A managed copy lives in the library, and its
     * volume is the workspace's rather than the user's footage.
     */
    volumeId: z.string().optional(),
    volumeRoot: z.string().optional(),
    createdAt: z.string(),
    info: MediaInfoSchema,
    status: z.enum(['ok', 'missing', 'changed']).default('ok'),
    peaks256Path: z.string().optional(),
    peaks4096Path: z.string().optional(),
    thumbPath: z.string().optional(),
    /**
     * The preview proxy, when one was generated (SPEC 04 §7).
     *
     * Recorded on the media rather than derived from the layout, because the path
     * depends on the storage mode and the derived directory — and a record that cannot
     * name its own proxy is a proxy nothing can ever find, which is what happened
     * before this field existed: every proxy was written and then orphaned.
     *
     * Optional and nullable both appear in practice: absent on media imported before
     * proxies existed, null when `needsProxy` declined to make one.
     */
    proxyPath: z.string().nullish(),
  })
  .passthrough();

export type MediaRecord = z.infer<typeof MediaRecordSchema>;

export const WordSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    startUs: z.number().int().min(0),
    endUs: z.number().int().min(0),
    confidence: z.number().min(0).max(1).optional(),
    speaker: z.string().optional(),
    edited: z.boolean().default(false),
    approximate: z.boolean().default(false),
    lowConfidence: z.boolean().default(false),
    filler: z.boolean().default(false),
    chunkIndex: z.number().int().default(0),
  })
  .passthrough();

export type Word = z.infer<typeof WordSchema>;

export const SentenceSchema = z
  .object({
    id: z.string().min(1),
    wordIds: z.array(z.string()),
    startUs: z.number().int().min(0),
    endUs: z.number().int().min(0),
  })
  .passthrough();

export type Sentence = z.infer<typeof SentenceSchema>;

export const ParagraphSchema = z
  .object({
    id: z.string().min(1),
    sentenceIds: z.array(z.string()),
    startUs: z.number().int().min(0),
    endUs: z.number().int().min(0),
    speaker: z.string().optional(),
  })
  .passthrough();

export type Paragraph = z.infer<typeof ParagraphSchema>;

export const HighlightSchema = z
  .object({
    id: z.string().min(1),
    wordIds: z.array(z.string()),
    color: z.string(),
    note: z.string().optional(),
  })
  .passthrough();

export type Highlight = z.infer<typeof HighlightSchema>;

export const TranscriptSchema = z
  .object({
    id: z.string().min(1),
    mediaId: z.string().min(1),
    language: z.string().default('en'),
    languageConfidence: z.number().optional(),
    engine: z.string().default('whisper-local'),
    model: z.string().default('small.en'),
    createdAt: z.string(),
    version: z.number().int().min(1).default(1),
    durationUs: z.number().int().min(0),
    words: z.array(WordSchema),
    sentences: z.array(SentenceSchema),
    paragraphs: z.array(ParagraphSchema),
    highlights: z.array(HighlightSchema).default([]),
  })
  .passthrough();

export type Transcript = z.infer<typeof TranscriptSchema>;

export const MomentScoresSchema = z.object({
  hook: z.number().int().min(0).max(100),
  standalone: z.number().int().min(0).max(100),
  emotion: z.number().int().min(0).max(100),
  interest: z.number().int().min(0).max(100),
  story: z.number().int().min(0).max(100),
  value: z.number().int().min(0).max(100),
  pacing: z.number().int().min(0).max(100),
  social: z.number().int().min(0).max(100),
});

export type MomentScores = z.infer<typeof MomentScoresSchema>;

export const MomentSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    transcriptVersion: z.number().int().default(1),
    startUs: z.number().int().min(0),
    endUs: z.number().int().min(1),
    durationUs: z.number().int().min(1),
    aiStartUs: z.number().int().optional(),
    aiEndUs: z.number().int().optional(),
    title: z.string(),
    reason: z.string(),
    score: z.number().int().min(0).max(100),
    scores: MomentScoresSchema,
    weightsUsed: MomentScoresSchema,
    confidence: z.enum(['high', 'medium', 'low']).default('high'),
    basis: z.enum(['llm', 'heuristic']).default('heuristic'),
    model: z.string().optional(),
    provider: z.string().optional(),
    flags: z.array(z.string()).default([]),
    needsContext: z.boolean().default(false),
    transcriptPreview: z.string(),
    hookSentence: z.string(),
    groupId: z.string().optional(),
    status: z.enum(['candidate', 'favourite', 'rejected', 'clipped']).default('candidate'),
    userEdited: z.boolean().default(false),
    manual: z.boolean().default(false),
    createdAt: z.string(),
    clips: z.array(z.string()).default([]),
  })
  .passthrough();

export type Moment = z.infer<typeof MomentSchema>;

export const JobRecordSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum([
      'probe',
      'copy',
      'download',
      'extract_audio',
      'thumbnails',
      'proxy',
      'peaks',
      'transcribe',
      'analyse',
      'audio_enhance',
      'auto_reframe',
      'export',
    ]),
    projectId: z.string().optional(),
    mediaId: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
    status: z
      .enum(['queued', 'running', 'paused', 'cancelling', 'cancelled', 'failed', 'done'])
      .default('queued'),
    priority: z.number().int().default(10),
    progress: z.number().min(0).max(100).default(0),
    attempt: z.number().int().default(1),
    error: z.string().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .passthrough();

export type JobRecord = z.infer<typeof JobRecordSchema>;

/**
 * SPEC 14 §6 — one row per finished export in `export_history`.
 *
 * Keeps the settings that produced the file (so *Re-export* can repeat them
 * exactly), the result, the validation report and the measured timings used to
 * improve later time estimates.
 */
export const ExportHistoryRecordSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    compId: z.string().min(1),
    /** Final path of the exported file. */
    outputPath: z.string().min(1),
    /** Human name shown in the queue/history row. */
    name: z.string().default(''),
    status: z.enum(['verified', 'warnings', 'failed', 'cancelled']),
    /** `Done ✓ Verified` etc., precomputed for the row. */
    verdict: z.string().default(''),
    /** Immutable snapshot of the export settings, for Re-export. */
    settings: z.record(z.string(), z.unknown()).default({}),
    /** The full `ValidationReport` (SPEC 14 §7). */
    validationReport: z.unknown().optional(),
    presetLabel: z.string().default(''),
    width: z.number().int().positive().default(0),
    height: z.number().int().positive().default(0),
    fps: z.number().positive().default(0),
    durationSeconds: z.number().nonnegative().default(0),
    sizeBytes: z.number().nonnegative().default(0),
    /** Measured wall-clock time, used to calibrate later estimates (§6 Timing). */
    elapsedMs: z.number().nonnegative().default(0),
    /** Throughput as a multiple of real time (2.4 = 2.4× real time). */
    speedFactor: z.number().nonnegative().default(0),
    createdAt: z.string().min(1),
    /** Set when the file has since gone missing (§6 History). */
    fileMissing: z.boolean().default(false),
  })
  .passthrough();

export type ExportHistoryRecord = z.infer<typeof ExportHistoryRecordSchema>;

export const ProviderRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['openai-compatible', 'ollama', 'anthropic', 'gemini']),
    baseUrl: z.string().url(),
    secretId: z.string().optional(),
    maskedKeySuffix: z.string().optional(),
    hasKey: z.boolean().default(false),
    capabilities: z.array(z.enum(['transcription', 'text'])),
    models: z
      .object({
        transcription: z.string().optional(),
        text: z.string().optional(),
      })
      .default({}),
    locality: z.enum(['local', 'network', 'online']).default('online'),
    status: z.enum(['connected', 'not_tested', 'error', 'key_missing']).default('not_tested'),
    lastTestedAt: z.string().optional(),
    lastError: z.string().optional(),
    timeoutMs: z.number().int().default(60000),
    maxConcurrent: z.number().int().default(2),
    numCtx: z.number().int().default(8192),
  })
  .passthrough();

export type ProviderRecord = z.infer<typeof ProviderRecordSchema>;

export const JournalEntrySchema = z
  .object({
    seq: z.number().int().min(1),
    compId: z.string().min(1),
    ts: z.string(),
    commandName: z.string(),
    forwardPatch: z.unknown(),
    inversePatch: z.unknown(),
  })
  .passthrough();

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const CwpackManifestSchema = z
  .object({
    format: z.literal('cwpack'),
    formatVersion: z.number().int().default(1),
    schemaVersion: z.number().int().default(CURRENT_SCHEMA_VERSION),
    appVersion: z.string(),
    createdAt: z.string(),
    projectId: z.string(),
    name: z.string(),
    media: z.array(
      z.object({
        id: z.string(),
        originalName: z.string(),
        sizeBytes: z.number().int(),
        sha256: z.string(),
        included: z.boolean(),
        ext: z.string(),
      })
    ),
    fonts: z.array(z.string()).default([]),
    brandKits: z.array(z.string()).default([]),
    checksums: z.record(z.string(), z.string()),
  })
  .passthrough();

export type CwpackManifest = z.infer<typeof CwpackManifestSchema>;

export const AppSettingsSchema = z
  .object({
    firstRunCompleted: z.boolean().default(false),
    workspacePath: z.string().default(''),
    processingMode: z.enum(['offline', 'online', 'automatic']).default('automatic'),
    autosaveIntervalSec: z.number().int().min(10).max(300).default(30),
    autoContinueStages: z.boolean().default(true),
    audioScrubbing: z.boolean().default(true),
    clickEmptyMovesPlayhead: z.boolean().default(false),
    proxyQuality: z.enum(['low', 'medium', 'high']).default('medium'),
    alwaysCreateProxies: z.boolean().default(false),
    /**
     * Whether the *preview* plays proxies instead of the originals.
     *
     * Defaults on: a proxy that is made but never played is pure waste, which is
     * exactly what the last few releases did. Off is the escape hatch for a proxy that
     * a transcode got wrong — the user can see the real file without deleting anything.
     */
    useProxyPreview: z.boolean().default(true),
    defaultProviders: z
      .object({
        transcription: z.string().optional(),
        moment_analysis: z.string().optional(),
        titles: z.string().optional(),
        editor_ai: z.string().optional(),
      })
      .default({}),
    /** SPEC 06 §7.3 — address of the local Ollama server (may be on the LAN). */
    ollamaBaseUrl: z.string().default('http://localhost:11434'),
    /** Context window handed to local models; the moments batch planner reads this. */
    llmNumCtx: z.union([z.literal(4096), z.literal(8192), z.literal(16384), z.literal(32768)]).default(8192),
    llmMaxConcurrent: z.number().int().min(1).max(4).default(2),
    providerTimeoutSec: z.number().int().min(15).max(300).default(60),
    /** SPEC 06 §8 — the only background outbound calls the user can switch off. */
    privacy: z
      .object({
        updateCheck: z.boolean().default(true),
        ytDlpUpdate: z.boolean().default(true),
        crashReports: z.boolean().default(false),
      })
      .default({}),
    /** Speech model used by new projects; 'auto' picks from RAM and language. */
    defaultWhisperModel: z.string().default('auto'),
    /** Moment defaults, remembered per workspace (SPEC 07 §5). */
    momentDefaults: z
      .object({
        contentType: z
          .enum(['auto', 'podcast', 'talking_head', 'tutorial', 'gaming', 'lecture', 'other'])
          .default('auto'),
        targetMinSec: z.number().int().min(3).max(600).default(20),
        targetMaxSec: z.number().int().min(5).max(600).default(60),
        count: z.union([z.literal('auto'), z.number().int().min(1).max(50)]).default('auto'),
      })
      .default({}),
    updateChannel: z.enum(['stable', 'beta']).default('stable'),
    autoCheckUpdates: z.enum(['startup', '6h', '1d', '1w', 'never']).default('1d'),
    ytDlpAutoUpdate: z.boolean().default(true),
    shortcuts: z.record(z.string(), z.string()).default({}),
    lastStartSettings: ProjectSettingsSchema.default({}),
  })
  .passthrough();

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const IpcRequestSchema = z.object({
  channel: z.string().min(1),
  payload: z.unknown().optional(),
});

export const IpcResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      actionHint: z.string().optional(),
    })
    .optional(),
});
