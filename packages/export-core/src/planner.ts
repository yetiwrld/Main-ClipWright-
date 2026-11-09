/**
 * SPEC 14 §2-§4 — Export plan types and planner.
 *
 * The ExportPlanner takes a composition snapshot and export settings and
 * produces an ExportPlan describing what frames need to be rendered, which
 * items are active, the audio graph, and the output parameters.
 */

import type { IconShape } from '@clipwright/compositor';
import type { ExportPresetId, OutputFormatId, QualityPresetId, RateControlMode, AudioBitrate, ExportFps } from './presets.js';
import { computeResolution } from './presets.js';

/** A single item in the export plan. */
export interface PlannedItem {
  itemId: string;
  trackId: string;
  type: string;
  mediaId?: string;
  /** Timeline start time in microseconds. */
  startUs: number;
  /** Timeline duration in microseconds. */
  durationUs: number;
  /** Source in-point in microseconds. */
  sourceInUs: number;
  /** Source duration in microseconds. */
  sourceDurationUs: number;
  /** Whether this item is active (visible/audible) at any point. */
  active: boolean;
  /** Whether this item has audio. */
  hasAudio: boolean;
  /**
   * Caption text for `caption` items.
   *
   * Carried through so subtitle sidecars can be generated from the plan without
   * reaching back into the composition (SPEC 14 §4.4: sidecars are independent
   * of the burn-in path).
   */
  captionText?: string;
  /**
   * Which `.cwstyle` this caption was edited with (SPEC 11 §6). Carried so a
   * multi-style composition burns each caption in its own look, rather than every
   * caption collapsing to the project default on export.
   */
  captionStyleId?: string;
  /**
   * The whole string of a `text` item (SPEC 11 §7).
   *
   * Separate from `captionText` rather than sharing it: the two mean different things
   * to the burn-in — a caption's text is a window onto a transcript with word timings,
   * a text item's is a fixed string — and `assCuesFromPlan` branches on the item type
   * before choosing which to read.
   */
  textContent?: string;
  /** A `shape` item's geometry kind (SPEC 11 §12). */
  shapeKind?: string;
  /**
   * An icon item's Lucide name and, when the file carries it, its own geometry (§12).
   *
   * Both have to survive the plan: an icon item has no `shapeKind`, so a plan that copied
   * only that field would turn every icon into an empty shape between the project file and
   * the burn-in.
   */
  iconName?: string;
  iconShapes?: readonly IconShape[];
  iconStrokeWidth?: number;
  /**
   * The caption's full segment: word timings for karaoke, overrides, speaker.
   * Absent for a caption typed into a build that did not store one.
   */
  captionSegment?: {
    text: string;
    wordRefs?: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
    speaker?: string;
  };
  /**
   * Where the picture sits inside the canvas (SPEC 10 §8.4–8.6): the stored crop,
   * scale, rotation and offset. Carried on the plan because the preview applies
   * them, and an export that ignored them would deliver a different picture from
   * the one the user approved.
   */
  geometry?: {
    crop?: { left?: number; top?: number; right?: number; bottom?: number };
    transform?: {
      x?: number;
      y?: number;
      scale?: number;
      scaleX?: number;
      scaleY?: number;
      rotation?: number;
      flipH?: boolean;
      flipV?: boolean;
    };
  };
  /**
   * Keyframed properties, keyed as the item stores them (`transform.x`, …).
   * Carried so the decoder can split an animated item into segments (SPEC 12 §2.2):
   * ffmpeg 4.1 evaluates `scale`/`crop` once, so time-varying geometry is rendered
   * as several constant segments rather than one expression.
   */
  keyframes?: Record<string, Array<{ timeUs: number; value: unknown }>>;
  /**
   * Opacity at the start of the item, 0–1 (SPEC 10 §6). Absent means opaque.
   * Carried so the export can fade a layer instead of painting it solid, which is
   * what the inspector's slider has always looked like it does.
   */
  opacity?: number;
  /** Blend mode against the layers below (SPEC 10 §6). Absent means `normal`. */
  blendMode?: string;
  /**
   * The item's audio properties (SPEC 12 §6.2): clip gain, volume, pan, fades and mute.
   *
   * Carried on the plan because the mixer reads them and nothing else does. All five were
   * missing here while `AudioItemRequest` declared every one of them, so the mixer's
   * `?? `-fallbacks quietly substituted 0 dB and centre — the inspector's Gain, Pan and fade
   * controls on every clip changed nothing audible in the exported file. A control whose
   * value never leaves the project is indistinguishable from one that does nothing.
   */
  gainDb?: number;
  volumeDb?: number;
  /** Pan, −100 hard left … +100 hard right. **Percent, as stored** — see `panToUnit`. */
  pan?: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  fadeCurve?: 'linear' | 'equal-power' | 'exponential';
  /**
   * The item's effect chain in stored order (SPEC 12 §3). Carried so the export can
   * apply the same colour maths the preview does; without it a graded clip arrives in
   * the file ungraded.
   */
  effects?: Array<{
    effectId: string;
    enabled?: boolean;
    params?: Record<string, number | boolean | string>;
  }>;
  /**
   * The transition entering this item (SPEC 12 §4). Carried so the export can widen
   * the item's drawable span across the overlap and fade the two clips together,
   * rather than cutting hard while the preview crossfades.
   */
  transitionIn?: {
    type: string;
    durationUs: number;
    alignment: 'center' | 'start' | 'end';
    params: Record<string, number | boolean | string>;
    easing: string;
    /**
     * Whether the linked audio crossfades across the transition (SPEC 12 §4.2).
     * Off means a hard audio cut even though the picture transitions.
     */
    crossfadeAudio?: boolean;
  };
  /**
   * The transition this item is *leaving* through: its successor's, when the two
   * abut on a track.
   *
   * Filled in by `buildExportPlan` rather than passed in, because a transition is
   * stored on the incoming item and the outgoing one carries no record of it. The
   * mixer needs both halves to crossfade audio over the same window the picture
   * crossfades over (SPEC 12 §4.2).
   */
  transitionOut?: PlannedItem['transitionIn'];
  /**
   * Track stacking order, larger is nearer the viewer. Needed to composite: two
   * visible items are otherwise an unordered set, and the export would have to
   * guess which one is on top.
   */
  trackOrder?: number;
}

/** Export plan describing the full render. */
export interface ExportPlan {
  /** Unique plan ID. */
  id: string;
  /** Composition ID. */
  compositionId: string;
  /** Project ID. */
  projectId: string;
  /** Output resolution. */
  width: number;
  height: number;
  /** Output frame rate. */
  fps: ExportFps;
  /** Output format. */
  format: OutputFormatId;
  /** Video codec. */
  videoCodec: string;
  /** Audio codec. */
  audioCodec: string;
  /** Quality preset. */
  quality: QualityPresetId;
  /** x264 CRF value. */
  crf: number;
  /** x264 preset. */
  preset: string;
  /** VP9 CRF value. */
  vp9Crf: number;
  /** Rate control mode. */
  rateControl: RateControlMode;
  /** Video bitrate in Mbps (for CBR/VBR modes). */
  videoBitrate?: number;
  /** Max bitrate in Mbps. */
  maxBitrate?: number;
  /** Audio bitrate in kbps. */
  audioBitrate: AudioBitrate;
  /** Total number of frames to render. */
  totalFrames: number;
  /** Start of the exported range on the timeline, in microseconds. */
  rangeStartUs: number;
  /** Duration in microseconds. */
  durationUs: number;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Planned items. */
  items: PlannedItem[];
  /** Whether audio is included. */
  includeAudio: boolean;
  /** Whether captions are burned in. */
  burnCaptions: boolean;
  /** Whether to also save subtitle files. */
  saveSubtitles: boolean;
  /** Subtitle formats to save. */
  subtitleFormats: ('srt' | 'vtt')[];
  /** Whether to embed project name in metadata. */
  embedProjectName: boolean;
  /** Whether to normalise loudness. */
  normaliseLoudness: boolean;
  /** Target loudness in LUFS (if normalising). */
  targetLufs: number;
  /** Whether this is a draft export. */
  isDraft: boolean;
  /**
   * Canvas colour behind every layer, as `#rrggbb` (SPEC 10 §4.1).
   *
   * The compositor needs it: a faded bottom layer mixes toward the canvas, not
   * toward black, so a project on a white canvas must not export a grey frame just
   * because its only clip is at 50 %. Absent means black.
   */
  backgroundColor?: string;
}

/** Export settings input to the planner. */
export interface ExportSettings {
  compositionId: string;
  projectId: string;
  preset: ExportPresetId;
  aspect: string;
  fps: ExportFps;
  format: OutputFormatId;
  quality: QualityPresetId;
  rateControl: RateControlMode;
  videoBitrate?: number;
  maxBitrate?: number;
  audioBitrate: AudioBitrate;
  includeAudio: boolean;
  burnCaptions: boolean;
  saveSubtitles: boolean;
  subtitleFormats: ('srt' | 'vtt')[];
  embedProjectName: boolean;
  normaliseLoudness: boolean;
  targetLufs: number;
  isDraft: boolean;
  /** Canvas colour behind every layer, `#rrggbb`. */
  backgroundColor?: string;
  /** Timeline range to export: [startUs, endUs]. */
  rangeUs: [number, number];
  /** Composition fps for re-sampling checks. */
  compositionFps: number;
  /** Composition duration in microseconds. */
  compositionDurationUs: number;
  /** Composition items. */
  items: Array<{
    id: string;
    trackId: string;
    type: string;
    mediaId?: string;
    startUs: number;
    durationUs: number;
    sourceInUs: number;
    sourceDurationUs?: number;
    disabled: boolean;
    muted: boolean;
    hasAudio: boolean;
    /** Caption text, for `caption` items (feeds the subtitle sidecars). */
    captionSegment?: {
      text: string;
      wordRefs?: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
      speaker?: string;
    };
    /** Which `.cwstyle` the caption uses, for a styled burn-in. */
    captionStyleId?: string;
    /** A `text` item's whole string (SPEC 11 §7). */
    textContent?: string;
    /** A `shape` item's geometry kind (SPEC 11 §12), for the ASS drawing pass. */
    shapeKind?: string;
    /** An icon item's name, stored geometry and stroke width (§12). */
    iconName?: string;
    iconShapes?: readonly IconShape[];
    iconStrokeWidth?: number;
    /** Keyframed properties, so an animated item can be segmented. */
    keyframes?: Record<string, Array<{ timeUs: number; value: unknown }>>;
    /** Audio properties, so the mix matches the inspector (SPEC 12 §6.2). */
    gainDb?: number;
    volumeDb?: number;
    pan?: number;
    fadeInUs?: number;
    fadeOutUs?: number;
    fadeCurve?: 'linear' | 'equal-power' | 'exponential';
    /** Crop and transform, so the decoded frame matches the preview. */
    geometry?: {
      crop?: { left?: number; top?: number; right?: number; bottom?: number };
      transform?: {
        x?: number;
        y?: number;
        scale?: number;
        scaleX?: number;
        scaleY?: number;
        rotation?: number;
        flipH?: boolean;
        flipV?: boolean;
      };
    };
    /** Item opacity, 0–1 (SPEC 10 §6). */
    opacity?: number;
    /** Blend mode against the layers below (SPEC 10 §6). */
    blendMode?: string;
    /** The item's effect chain, in stored order (SPEC 12 §3). */
    effects?: PlannedItem['effects'];
    /** The transition entering this item (SPEC 12 §4). */
    transitionIn?: PlannedItem['transitionIn'];
    /** Stacking order of the item's track; larger is nearer the viewer. */
    trackOrder?: number;
  }>;
}

/**
 * Deterministic plan ID.
 *
 * SPEC 14 §2.3 requires the planner to be deterministic, so the ID is derived
 * from the settings that define the output rather than from the clock. The same
 * settings always produce the same plan, including its ID (tests assert this).
 */
function planId(settings: ExportSettings): string {
  const key = [
    settings.compositionId,
    settings.preset,
    settings.aspect,
    settings.fps,
    settings.format,
    settings.quality,
    settings.rateControl,
    settings.videoBitrate ?? 0,
    settings.audioBitrate,
    settings.rangeUs[0],
    settings.rangeUs[1],
    settings.isDraft ? 'draft' : 'final',
  ].join('|');
  // FNV-1a 32-bit: small, dependency-free, stable across platforms.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `plan-${settings.compositionId}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Build an ExportPlan from the settings and composition snapshot.
 * The planner is deterministic: the same inputs always produce the same plan.
 */
export function buildExportPlan(settings: ExportSettings): ExportPlan {
  const { width, height } = computeResolution(
    EXPORT_PRESETS_LOOKUP[settings.preset],
    settings.aspect,
  );

  const [rangeStartUs, rangeEndUs] = settings.rangeUs;
  const rangeDurationUs = rangeEndUs - rangeStartUs;
  const fps = settings.fps;
  const durationSeconds = rangeDurationUs / 1_000_000;
  const totalFrames = Math.round(durationSeconds * fps);

  // Determine which items are active within the export range.
  const items: PlannedItem[] = settings.items
    .filter((item) => !item.disabled)
    .map((item) => {
      const itemEndUs = item.startUs + item.durationUs;
      const overlaps = itemEndUs > rangeStartUs && item.startUs < rangeEndUs;
      const hasAudio = item.hasAudio && !item.muted;
      return {
        itemId: item.id,
        trackId: item.trackId,
        type: item.type,
        mediaId: item.mediaId,
        startUs: Math.max(item.startUs, rangeStartUs),
        durationUs: Math.min(itemEndUs, rangeEndUs) - Math.max(item.startUs, rangeStartUs),
        sourceInUs: item.sourceInUs,
        sourceDurationUs: item.sourceDurationUs ?? item.durationUs,
        active: overlaps,
        hasAudio,
        captionText: item.captionSegment?.text,
        captionStyleId: item.captionStyleId,
        textContent: item.textContent,
        shapeKind: item.shapeKind,
        iconName: item.iconName,
        iconShapes: item.iconShapes,
        iconStrokeWidth: item.iconStrokeWidth,
        geometry: item.geometry,
        keyframes: item.keyframes,
        gainDb: item.gainDb,
        volumeDb: item.volumeDb,
        pan: item.pan,
        fadeInUs: item.fadeInUs,
        fadeOutUs: item.fadeOutUs,
        fadeCurve: item.fadeCurve,
        opacity: item.opacity,
        blendMode: item.blendMode,
        trackOrder: item.trackOrder,
        transitionIn: item.transitionIn,
        effects: item.effects,
        captionSegment: item.captionSegment,
      };
    })
    .filter((item) => item.active);

  /*
    Link each item to the transition it leaves through (SPEC 12 §4.2).

    A transition is stored on the *incoming* item, so the outgoing one has no record
    of it. The mixer needs both halves to crossfade audio, and looking the successor
    up there would duplicate the "next item on this track" rule the renderers
    already implement — with a different idea of what "next" means once a track has
    a gap. Resolving it once here keeps one definition.
  */
  const byTrack = new Map<string, PlannedItem[]>();
  for (const item of items) {
    const list = byTrack.get(item.trackId) ?? [];
    list.push(item);
    byTrack.set(item.trackId, list);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.startUs - b.startUs);
    for (let index = 0; index + 1 < list.length; index += 1) {
      const successor = list[index + 1]!;
      // Only an abutting pair shares a transition; a gap between them means they
      // are not joined and the successor's transition belongs to another cut.
      const current = list[index]!;
      if (successor.transitionIn && successor.startUs === current.startUs + current.durationUs) {
        current.transitionOut = successor.transitionIn;
      }
    }
  }

  // Quality settings lookup.
  const quality = QUALITY_PRESETS_LOOKUP[settings.quality];

  return {
    id: planId(settings),
    compositionId: settings.compositionId,
    projectId: settings.projectId,
    width,
    height,
    fps,
    format: settings.format,
    videoCodec: FORMAT_LOOKUP[settings.format].videoCodec,
    audioCodec: FORMAT_LOOKUP[settings.format].audioCodec,
    quality: settings.quality,
    crf: quality.x264Crf,
    preset: quality.x264Preset,
    vp9Crf: quality.vp9Crf,
    rateControl: settings.rateControl,
    videoBitrate: settings.videoBitrate,
    maxBitrate: settings.maxBitrate,
    audioBitrate: settings.audioBitrate,
    totalFrames,
    rangeStartUs,
    durationUs: rangeDurationUs,
    durationSeconds,
    items,
    includeAudio: settings.includeAudio,
    burnCaptions: settings.burnCaptions,
    saveSubtitles: settings.saveSubtitles,
    subtitleFormats: settings.subtitleFormats,
    embedProjectName: settings.embedProjectName,
    normaliseLoudness: settings.normaliseLoudness,
    targetLufs: settings.targetLufs,
    isDraft: settings.isDraft,
    backgroundColor: settings.backgroundColor,
  };
}

// Lookup tables (kept local to avoid circular imports with presets.ts).
const EXPORT_PRESETS_LOOKUP: Record<ExportPresetId, number> = {
  '720p': 720,
  '1080p': 1080,
  'dci-2k': 1152,
  'qhd-1440p': 1440,
  '4k-uhd': 2160,
};

const QUALITY_PRESETS_LOOKUP: Record<QualityPresetId, { x264Crf: number; x264Preset: string; vp9Crf: number }> = {
  draft: { x264Crf: 26, x264Preset: 'veryfast', vp9Crf: 38 },
  standard: { x264Crf: 22, x264Preset: 'fast', vp9Crf: 33 },
  high: { x264Crf: 19, x264Preset: 'medium', vp9Crf: 30 },
  maximum: { x264Crf: 16, x264Preset: 'slow', vp9Crf: 27 },
};

const FORMAT_LOOKUP: Record<OutputFormatId, { videoCodec: string; audioCodec: string }> = {
  mp4: { videoCodec: 'h264', audioCodec: 'aac' },
  webm: { videoCodec: 'vp9', audioCodec: 'opus' },
};
