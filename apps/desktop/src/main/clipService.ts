/**
 * "Create clips" (Section 12.9): each selected moment becomes a Composition —
 * main video track item + caption track with the chosen style + markers.
 */
import { newId, MarkerSchema, type Composition, type Item, type Track, type AspectRatioChoice, type ProjectSettingsSnapshot } from '@clipwright/project-schema';
import { buildCaptions } from '@clipwright/caption-styles';
import type { StorageService } from './storage.js';

export const canvasSizeFor = (aspect: AspectRatioChoice, original?: { width: number; height: number }): { width: number; height: number } => {
  const even = (n: number) => { const r = Math.round(n); return r % 2 === 0 ? r : r + 1; };
  const short = 1080;
  const byRatio = (w: number, h: number) => {
    const a = w / h;
    if (a >= 1) return { width: even(short * a), height: short };
    return { width: short, height: even(short / a) };
  };
  switch (aspect) {
    case '9:16': return byRatio(9, 16);
    case '16:9': return byRatio(16, 9);
    case '1:1': return { width: short, height: short };
    case '4:5': return byRatio(4, 5);
    case '4:3': return byRatio(4, 3);
    case '21:9': return byRatio(21, 9);
    case 'original': {
      const o = original ?? { width: 1920, height: 1080 };
      const scale = Math.min(1, 1920 / o.width, 1080 / o.height);
      return { width: even(o.width * scale), height: even(o.height * scale) };
    }
    default:
      if (typeof aspect === 'object' && aspect) return byRatio(aspect.customW, aspect.customH);
      return byRatio(9, 16);
  }
};

export interface CreateClipResult { comp: Composition; momentId: string; title: string; }

export const createClipFromMoment = (
  storage: StorageService,
  projectId: string,
  momentId: string,
  titleOverride?: string,
): CreateClipResult | null => {
  const project = storage.getProject(projectId);
  if (!project) throw new Error('Project not found.');
  const moment = storage.loadMoments(projectId).find((m) => m.id === momentId);
  if (!moment) throw new Error('Moment not found.');
  const settings = project.settings;
  const media = project.sourceMediaId ? storage.getMedia(project.sourceMediaId) : null;
  const original = media?.info?.video
    ? { width: media.info.video.displayWidth, height: media.info.video.displayHeight }
    : undefined;
  const canvas = canvasSizeFor(settings.aspectRatio, original);

  const sourceDurationUs = moment.endUs - moment.startUs;
  const videoTrackId = newId();
  const captionTrackId = newId();
  const tracks: Track[] = [
    { id: videoTrackId, type: 'video', name: 'Main', order: 0, locked: false, hidden: false, height: 64 },
    { id: captionTrackId, type: 'caption', name: 'Captions', order: 1, locked: false, hidden: false, height: 48 },
  ];

  const videoItem: Item = {
    id: newId(), trackId: videoTrackId, kind: 'video', name: media?.originalName ?? 'Source',
    startUs: 0, durationUs: sourceDurationUs, inUs: moment.startUs, mediaId: media?.id,
    transform: {
      x: settings.initialFraming?.x ?? 0,
      y: settings.initialFraming?.y ?? 0,
      scale: settings.initialFraming?.scale ?? 1,
      rotationDeg: 0, opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false,
    },
    volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false, effects: [],
  };

  // captions from the transcript words inside the moment, shifted to 0
  const items: Item[] = [videoItem];
  const words = storage.loadTranscript(projectId).filter((w) => w.endUs > moment.startUs && w.startUs < moment.endUs);
  const chunks = buildCaptions(words, { timeOffsetUs: -moment.startUs });
  for (const ch of chunks) {
    const startUs = Math.max(0, ch.startUs);
    const endUs = Math.min(sourceDurationUs, ch.endUs);
    if (endUs - startUs < 150_000) continue;
    items.push({
      id: newId(), trackId: captionTrackId, kind: 'caption', name: ch.text.slice(0, 48),
      startUs, durationUs: endUs - startUs, inUs: 0,
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false },
      volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false,
      text: ch.text, captionStyleId: settings.captionStyleId, effects: [],
    });
  }

  const now = Date.now();
  const title = titleOverride?.trim() || moment.title || 'Untitled clip';
  const comp: Composition = {
    id: newId(), projectId, name: uniqueCompName(storage, projectId, title),
    fps: 30, width: canvas.width, height: canvas.height,
    tracks, items,
    markers: [
      MarkerSchema.parse({ id: newId(), timeUs: 0, label: 'Moment start' }),
      MarkerSchema.parse({ id: newId(), timeUs: sourceDurationUs, label: 'Moment end' }),
    ],
    keyframes: [], effects: [], transitions: [],
    createdAt: now, updatedAt: now, schemaVersion: 1,
  };
  storage.saveComposition(projectId, comp);
  storage.updateMomentStatus(projectId, momentId, 'clip-created');
  return { comp, momentId, title: comp.name };
};

const uniqueCompName = (storage: StorageService, projectId: string, base: string): string => {
  const existing = new Set(storage.listCompositions(projectId).map((c) => c.name));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
};
