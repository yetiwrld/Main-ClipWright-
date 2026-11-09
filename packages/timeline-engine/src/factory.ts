// Construction helpers: a new blank clip's default track layout (SPEC 09 §5.2)
// and media items built from a library asset.

import {
  CompositionPayloadSchema,
  TimelineItemSchema,
  type TimelineItem,
  type Track,
} from '@clipwright/project-schema/schemas';
import type { TimelineState } from './selectors';
import type { Fps } from './time';

let counter = 0;

/** Deterministic, collision-free id for tests and for new items. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${Date.now().toString(36).slice(-3)}`;
}

export interface DefaultTimelineOptions {
  id: string;
  name: string;
  fps?: Fps;
  canvas?: { width: number; height: number; aspect: string };
}

function track(
  role: Track['role'],
  kind: Track['kind'],
  name: string,
  order: number,
  heightPx = 48,
  extra: Partial<Track> = {},
): Track {
  return {
    id: nextId(`trk_${role}`),
    role,
    kind,
    name,
    order,
    hidden: false,
    locked: false,
    muted: false,
    solo: false,
    heightPx,
    itemIds: [],
    auto: false,
    ...extra,
  } as Track;
}

/**
 * The default layout from SPEC 09 §5.2, top → bottom:
 * Captions · Text/Graphics · Overlay video · MAIN VIDEO · Original audio · Music · SFX.
 * `order` grows towards the front of the preview, so the main track is 0.
 */
export function createDefaultTimeline(options: DefaultTimelineOptions): TimelineState {
  const fps = options.fps ?? 30;
  const canvas = options.canvas ?? { width: 1080, height: 1920, aspect: '9:16' };

  const tracks: Track[] = [
    track('main', 'video', 'Main video', 0, 88, { magnetic: true }),
    track('overlay', 'video', 'Overlay video', 10, 48),
    track('text', 'text', 'Text / Graphics', 20, 40),
    track('captions', 'caption', 'Captions', 30, 40),
    track('overlay', 'audio', 'Original audio', -10, 40),
    track('music', 'audio', 'Music', -20, 40),
    track('sfx', 'audio', 'SFX', -30, 40),
  ];
  // Only the MAIN VIDEO track carries the 'main' role (SPEC 09 §29.6); the
  // original-audio lane follows it as an ordinary audio track.

  return CompositionPayloadSchema.parse({
    id: options.id,
    name: options.name,
    fps,
    canvas: { ...canvas, backgroundColor: '#000000', backgroundBlur: false },
    tracks,
    items: {},
    markers: [],
    links: [],
    groups: [],
    playheadUs: 0,
    viewState: { pxPerSecond: 80, scrollX: 0, scrollY: 0, headerWidthPx: 184 },
    editByTranscriptDeletedWordIds: [],
  }) as TimelineState;
}

export interface CreateMediaItemParams {
  trackId: string;
  label: string;
  mediaId: string;
  startUs: number;
  durationUs: number;
  sourceInUs?: number;
  sourceDurationUs?: number;
  type?: 'video' | 'image' | 'audio';
  id?: string;
}

export function createMediaItem(params: CreateMediaItemParams): TimelineItem {
  return TimelineItemSchema.parse({
    id: params.id ?? nextId('itm'),
    trackId: params.trackId,
    type: params.type ?? 'video',
    startUs: params.startUs,
    durationUs: params.durationUs,
    label: params.label,
    disabled: false,
    mediaId: params.mediaId,
    sourceInUs: params.sourceInUs ?? 0,
    sourceDurationUs: params.sourceDurationUs,
    speed: 1,
    volumeDb: 0,
    gainDb: 0,
    pan: 0,
    fadeInUs: 0,
    fadeOutUs: 0,
    fadeCurve: 'equal-power',
    muted: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 0, y: 0, scale: 1 },
    crop: {},
    keyframes: {},
    effects: [],
  }) as TimelineItem;
}

/**
 * A caption item (SPEC 11 §2.2): `ItemBase` of `type:'caption'` carrying the
 * segment, the style reference and any per-item overrides.
 *
 * The segment stores `wordId` + `textOverride` rather than a copy of the text:
 * the words belong to the transcript, and a caption records which of them it
 * shows. The derived `text` and `lines` are rebuilt here so they cannot disagree
 * with `wordRefs` — a caption whose stored text and words differ renders one
 * thing and exports another, and nothing in the UI would show the difference.
 */
export interface CreateCaptionItemParams {
  id?: string;
  trackId: string;
  startUs: number;
  durationUs: number;
  words: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
  /** Used only when `words` is empty, e.g. a caption typed from scratch. */
  fallbackText?: string;
  styleId?: string;
  lines?: string[];
  speaker?: string;
  manualText?: boolean;
  manualTiming?: boolean;
}

export function createCaptionItem(params: CreateCaptionItemParams): TimelineItem {
  // Word overrides win when every word has one; otherwise the caller's text is
  // the only copy that covers all the words, which is the normal case for a
  // caption generated from a transcript. Taking the overrides blindly produced an
  // empty caption, which then rendered as nothing and exported as nothing.
  const overrides = params.words.map((word) => word.textOverride ?? '');
  const text =
    params.words.length === 0
      ? (params.fallbackText ?? '')
      : overrides.every(Boolean)
        ? overrides.join(' ')
        : (params.fallbackText ?? overrides.filter(Boolean).join(' '));

  return TimelineItemSchema.parse({
    id: params.id ?? nextId('cap'),
    trackId: params.trackId,
    type: 'caption',
    startUs: params.startUs,
    durationUs: params.durationUs,
    label: text.substring(0, 60),
    disabled: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 0, y: 0, scale: 1 },
    crop: {},
    keyframes: {},
    effects: [],
    captionStyleId: params.styleId,
    captionSegment: {
      id: `seg-${params.id ?? nextId('cap')}`,
      wordRefs: params.words,
      startUs: params.startUs,
      endUs: params.startUs + params.durationUs,
      text,
      lines: params.lines ?? (text.length > 0 ? [text] : []),
      speaker: params.speaker,
      manualTiming: params.manualTiming ?? false,
      manualText: params.manualText ?? false,
      wordOverrides: {},
    },
  }) as TimelineItem;
}

/**
 * A text item (SPEC 11 §7): free-standing text on the canvas, rather than a caption
 * bound to a transcript.
 *
 * It is deliberately a *caption without words*: the same `captionStyleId` and
 * `styleOverrides`, resolved by the same `resolveStyle` and laid out by the same
 * `layoutText`. A title that used a different styling system from the captions would
 * be two systems to keep in agreement, and the project has spent a lot of effort
 * making sure the preview and the export are one.
 *
 * `textContent` is the whole text — no word timings, no karaoke. A text item is on
 * screen for its duration and does not follow a transcript.
 */
export interface CreateTextItemParams {
  id?: string;
  trackId: string;
  startUs: number;
  durationUs: number;
  text: string;
  styleId?: string;
  /** A label for the timeline; defaults to the start of the text. */
  label?: string;
}

export function createTextItem(params: CreateTextItemParams): TimelineItem {
  const text = params.text;
  return TimelineItemSchema.parse({
    id: params.id ?? nextId('txt'),
    trackId: params.trackId,
    type: 'text',
    startUs: params.startUs,
    durationUs: params.durationUs,
    /*
      The label is the text itself, trimmed to a readable length, because the timeline
      shows it rather than an id: a row of "Text 1, Text 2, Text 3" tells a user
      nothing about which title is which. An empty string falls back rather than
      producing a blank chip.
    */
    label: params.label ?? (text.trim().substring(0, 60) || 'Text'),
    disabled: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 0, y: 0, scale: 1 },
    crop: {},
    keyframes: {},
    effects: [],
    textContent: text,
    captionStyleId: params.styleId,
  }) as TimelineItem;
}

/**
 * A shape item (SPEC 11 §12): a rectangle, ellipse, star and so on.
 *
 * `shapeKind` is what the renderer switches on; the geometry comes from the schema's
 * own enum rather than a second list here, so a kind the renderer cannot draw cannot
 * be created either.
 */
export interface CreateShapeItemParams {
  id?: string;
  trackId: string;
  startUs: number;
  durationUs: number;
  shapeKind: NonNullable<TimelineItem['shapeKind']>;
  label?: string;
  styleId?: string;
}

export function createShapeItem(params: CreateShapeItemParams): TimelineItem {
  return TimelineItemSchema.parse({
    id: params.id ?? nextId('shp'),
    trackId: params.trackId,
    type: 'shape',
    startUs: params.startUs,
    durationUs: params.durationUs,
    label: params.label ?? SHAPE_LABELS[params.shapeKind],
    disabled: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 0, y: 0, scale: 1 },
    crop: {},
    keyframes: {},
    effects: [],
    shapeKind: params.shapeKind,
    captionStyleId: params.styleId,
  }) as TimelineItem;
}

/**
 * An icon item (SPEC 11 §12), which is a shape item that names a Lucide icon.
 *
 * Stored as `type: 'shape'` with `iconName` set rather than a new item type, deliberately:
 * an icon is drawn by the same code as a rectangle — same box, same fill, same transform, same
 * export path — and a separate `type` would have meant a case in every switch that already
 * handles shapes, including the ones in the exporter that would silently drop it.
 *
 * `iconShapes` is optional and is written by the caller when it wants the file to carry the
 * geometry, so a project opened by a build with a different icon set still draws what it did.
 */
export interface CreateIconItemParams {
  id?: string;
  trackId: string;
  startUs: number;
  durationUs: number;
  /** Lucide's kebab-case name, e.g. `star`. */
  iconName: string;
  /** The icon's children, if the file should not depend on this build's library. */
  iconShapes?: TimelineItem['iconShapes'];
  label?: string;
  styleId?: string;
}

export function createIconItem(params: CreateIconItemParams): TimelineItem {
  return TimelineItemSchema.parse({
    id: params.id ?? nextId('ico'),
    trackId: params.trackId,
    type: 'shape',
    startUs: params.startUs,
    durationUs: params.durationUs,
    label: params.label ?? ICON_LABEL(params.iconName),
    disabled: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 0, y: 0, scale: 1 },
    crop: {},
    keyframes: {},
    effects: [],
    iconName: params.iconName,
    ...(params.iconShapes ? { iconShapes: params.iconShapes } : {}),
    captionStyleId: params.styleId,
  }) as TimelineItem;
}

/**
 * The timeline chip for an icon: its name in words.
 *
 * `star` becomes `Star`, `arrow-up-right` becomes `Arrow up right`. The timeline shows this
 * rather than an id, for the same reason a text item shows its text — "Icon 1, Icon 2" tells
 * a user nothing about which is which.
 */
export function ICON_LABEL(iconName: string): string {
  const words = iconName.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return 'Icon';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human names for the shape kinds, so the timeline does not show "round-rect". */
export const SHAPE_LABELS: Readonly<Record<string, string>> = {
  rect: 'Rectangle',
  'round-rect': 'Rounded rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  polygon: 'Polygon',
  star: 'Star',
  line: 'Line',
  arrow: 'Arrow',
  bubble: 'Speech bubble',
};
