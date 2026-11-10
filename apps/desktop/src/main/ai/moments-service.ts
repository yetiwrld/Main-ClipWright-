/**
 * SPEC 07 — moment detection, persistence and clip creation.
 *
 * The pipeline itself is pure (`@clipwright/ai-core/moments`). This service does
 * the parts that need the app: read the transcript, decide which provider may
 * score it, stream progress to the window, persist the results, and turn a
 * moment into a Composition.
 */

import { CompositionRecordSchema, uuidv7, type CompositionRecord, type Moment, type ProjectRecord, type Transcript } from '@clipwright/project-schema';
import {
  buildCaptions,
  detectMoments,
  contentTypeFromProject,
  getAdapter,
  type ContentType,
  type DetectionInput,
  type DetectionProgress,
  type DetectionResult,
  type Moment as DetectedMoment,
  type MomentSettings,
  type Route,
} from '@clipwright/ai-core';

/** What `detectMoments` needs to score with a model (adapter + resolved config). */
type LlmScoringHandle = NonNullable<Parameters<typeof detectMoments>[0]['llm']>;
/** The scoring context the pipeline reports back. */
type DetectionOutcome = DetectionResult;
import type { StorageService } from '../storage/storage-service.js';
import type { Logger } from '../storage/logger.js';
import type { ConsentService } from './consent-service.js';
import type { ModelService } from './model-service.js';
import type { ProviderService } from './provider-service.js';

export interface AnalyzeRequest {
  projectId: string;
  /** 'auto' keeps the project settings; an explicit value overrides for this run. */
  contentType?: ContentType;
  targetMinSec?: number;
  targetMaxSec?: number;
  count?: number | 'auto';
  focus?: string;
  /** Ranges already covered; used by "Find more". */
  excludeRanges?: Array<{ startUs: number; endUs: number }>;
}

export interface AnalyzeResult {
  route: Route;
  moments: Moment[];
  moreMoments: Moment[];
  notes: string[];
  degraded: boolean;
  mode: 'llm' | 'heuristic';
  providerName?: string;
  model?: string;
  durationMs: number;
}

export type MomentsProgressSink = (progress: DetectionProgress) => void;

export interface CreateClipsResult {
  created: Array<{ compId: string; name: string; momentId: string }>;
  errors: Array<{ momentId: string; title: string; message: string }>;
}

/** SPEC 14 — canvas presets, shortest side 1080 unless the source is taller. */
const CANVAS_BY_ASPECT: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '4:3': { width: 1440, height: 1080 },
  '21:9': { width: 2520, height: 1080 },
};

export class MomentsService {
  private storage: StorageService;
  private providers: ProviderService;
  private models: ModelService;
  private consents: ConsentService;
  private logger: Logger;
  private progressSink: MomentsProgressSink | null = null;

  constructor(
    storage: StorageService,
    providers: ProviderService,
    models: ModelService,
    consents: ConsentService,
    logger: Logger
  ) {
    this.storage = storage;
    this.providers = providers;
    this.models = models;
    this.consents = consents;
    this.logger = logger;
  }

  setProgressSink(sink: MomentsProgressSink | null): void {
    this.progressSink = sink;
  }

  list(projectId: string): Moment[] {
    return this.storage.listMoments(projectId);
  }

  /* ------------------------------------------------------------------ analyze */

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const startedAt = Date.now();
    const project = this.storage.getProject(request.projectId);
    if (!project) throw new Error('That project could not be found.');
    const transcript = this.storage.getTranscript(request.projectId);
    if (!transcript) throw new Error('Transcribe the video first — moments are found in the words, not the pixels.');

    const settings = this.momentSettings(project, request);
    const input = this.buildInput(project, transcript, settings);

    const route = await this.routeForMoments();
    if (!route.ok && route.reason === 'needs_consent') {
      // The renderer asks for consent, then calls again.
      return {
        route,
        moments: this.storage.listMoments(request.projectId),
        moreMoments: [],
        notes: [],
        degraded: false,
        mode: 'heuristic',
        durationMs: Date.now() - startedAt,
      };
    }

    // Basic scoring is always available, so a refusal (no provider, no model,
    // no consent) degrades to heuristics with an explanation instead of failing.
    const fallbackNote = route.ok
      ? null
      : `${route.message} Moments were scored locally with Basic scoring instead.`;
    const llm = route.ok ? this.buildLlmHandle(route) : null;
    const outcome: DetectionOutcome = await detectMoments({
      input,
      signal: new AbortController().signal,
      llm: llm ?? undefined,
      excludeRanges: request.excludeRanges,
      onProgress: (progress) => this.progressSink?.(progress),
    });

    if (fallbackNote) outcome.notes.unshift(fallbackNote);

    if (llm) {
      // "Allow once" is used up by the run that asked for it.
      const category = this.providers.categoryFor('moment_analysis');
      if (route.ok && route.providerId) this.consents.consumeOneTime(route.providerId, category);
      if (route.ok && route.providerId && route.sendsDataOffDevice) {
        this.consents.recordTransfer({
          providerHost: this.hostOf(route.providerId),
          task: 'moment_analysis',
          category: 'transcript',
          approxBytes: Buffer.byteLength(transcript.words.map((w) => w.text).join(' '), 'utf8'),
        });
      }
    }

    const detected = outcome.moments.map((moment) => this.toRecord(project.id, moment, outcome.context));
    const more = outcome.moreMoments.map((moment) => this.toRecord(project.id, moment, outcome.context));

    // "Find more" appends; a fresh analysis replaces the ranked list but keeps
    // favourites, rejections and manual moments the user made themselves.
    const existing = this.storage.listMoments(request.projectId);
    const keep = existing.filter(
      (moment) => moment.manual || moment.status === 'favourite' || moment.status === 'clipped' || moment.status === 'rejected'
    );
    const replacing = request.excludeRanges && request.excludeRanges.length > 0;
    const merged = replacing ? [...keep, ...detected, ...more] : [...keep.filter((m) => m.manual), ...detected, ...more];
    const saved = this.storage.saveMoments(request.projectId, merged);

    this.storage.updateProject(project.id, {
      stage: 'moments',
      lastMomentRun: {
        at: new Date().toISOString(),
        mode: outcome.context.mode,
        provider: outcome.context.providerName,
        model: outcome.context.model,
        language: transcript.language,
        transcriptVersion: transcript.version,
      },
    } as Partial<ProjectRecord>);

    this.logger.info('Moments analysed', {
      projectId: project.id,
      mode: outcome.context.mode,
      count: detected.length,
      degraded: outcome.degraded,
    });

    return {
      route,
      moments: saved.filter((moment) => !more.some((m) => m.id === moment.id)),
      moreMoments: more.length ? saved.filter((moment) => more.some((m) => m.id === moment.id)) : [],
      notes: outcome.notes,
      degraded: outcome.degraded,
      mode: outcome.context.mode,
      providerName: outcome.context.providerName,
      model: outcome.context.model,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Re-scores one moment in place, keeping its id and user edits (`07 §9.5`). */
  async rescore(projectId: string, momentId: string): Promise<Moment> {
    const all = this.storage.listMoments(projectId);
    const target = all.find((moment) => moment.id === momentId);
    if (!target) throw new Error('That moment is no longer in this project.');

    const route = await this.routeForMoments();
    const project = this.storage.getProject(projectId);
    const transcript = this.storage.getTranscript(projectId);
    if (!project || !transcript) throw new Error('This project is missing its transcript.');

    const settings = this.momentSettings(project, { projectId });
    const input = this.buildInput(project, transcript, settings);
    // Basic scoring is always available, so a refusal (no provider, no model,
    // no consent) degrades to heuristics with an explanation instead of failing.
    const fallbackNote = route.ok
      ? null
      : `${route.message} Moments were scored locally with Basic scoring instead.`;
    const llm = route.ok ? this.buildLlmHandle(route) : null;

    const outcome = await detectMoments({
      input,
      signal: new AbortController().signal,
      llm: llm ?? undefined,
      onProgress: (progress) => this.progressSink?.(progress),
    });

    const match =
      outcome.moments.find((moment) => this.overlaps(moment, target) > 0.5) ??
      outcome.moreMoments.find((moment) => this.overlaps(moment, target) > 0.5);
    if (!match) {
      throw new Error('Re-scoring found nothing for this range. Keep the current score or regenerate all moments.');
    }

    const updated: Moment = {
      ...target,
      score: match.score,
      scores: match.scores,
      weightsUsed: match.weightsUsed,
      confidence: match.confidence,
      basis: match.basis,
      model: match.model,
      provider: match.provider,
      title: target.userEdited ? target.title : match.title,
      reason: match.reason,
      flags: match.flags,
    };
    this.storage.saveMoments(
      projectId,
      all.map((moment) => (moment.id === momentId ? updated : moment))
    );
    return updated;
  }

  /** Manual range → moment record, not scored (`07 §9.4`). */
  addManualMoment(projectId: string, range: { startUs: number; endUs: number; title?: string }): Moment {
    const project = this.storage.getProject(projectId);
    const transcript = this.storage.getTranscript(projectId);
    if (!project || !transcript) throw new Error('Open the project and transcribe it first.');

    const startUs = Math.max(0, Math.round(range.startUs));
    const endUs = Math.max(startUs + 1_000_000, Math.round(range.endUs));
    const words = transcript.words.filter((word) => word.endUs > startUs && word.startUs < endUs);
    const zeroScores = { hook: 0, standalone: 0, emotion: 0, interest: 0, story: 0, value: 0, pacing: 0, social: 0 };

    const moment: Moment = {
      id: `mom_${uuidv7()}`,
      projectId,
      transcriptVersion: transcript.version || 1,
      startUs,
      endUs,
      durationUs: endUs - startUs,
      aiStartUs: startUs,
      aiEndUs: endUs,
      title: range.title?.trim() || words.slice(0, 6).map((w) => w.text).join(' ') || 'Manual range',
      reason: 'You chose this range yourself. It has not been scored.',
      score: 0,
      scores: zeroScores,
      weightsUsed: zeroScores,
      confidence: 'low',
      basis: 'heuristic',
      flags: [],
      needsContext: false,
      transcriptPreview: words.map((w) => w.text).join(' ').slice(0, 240),
      hookSentence: words.slice(0, 12).map((w) => w.text).join(' '),
      status: 'candidate',
      userEdited: true,
      manual: true,
      createdAt: new Date().toISOString(),
      clips: [],
    };

    const existing = this.storage.listMoments(projectId);
    this.storage.saveMoments(projectId, [...existing, moment]);
    return moment;
  }

  /** Updates one moment's boundaries or status (favourite / rejected / edits). */
  updateMoment(projectId: string, patch: Partial<Moment> & { id: string }): Moment {
    const all = this.storage.listMoments(projectId);
    const target = all.find((moment) => moment.id === patch.id);
    if (!target) throw new Error('That moment is no longer in this project.');

    const merged: Moment = {
      ...target,
      ...patch,
      // Any boundary change is a user edit; keep the AI values for Reset.
      userEdited: patch.startUs !== undefined || patch.endUs !== undefined ? true : (patch.userEdited ?? target.userEdited),
      durationUs:
        patch.startUs !== undefined || patch.endUs !== undefined
          ? (patch.endUs ?? target.endUs) - (patch.startUs ?? target.startUs)
          : target.durationUs,
      aiStartUs: target.aiStartUs ?? target.startUs,
      aiEndUs: target.aiEndUs ?? target.endUs,
    };
    if (merged.durationUs < 1_000_000) throw new Error('A clip must be at least one second long.');

    this.storage.saveMoments(projectId, all.map((moment) => (moment.id === patch.id ? merged : moment)));
    return merged;
  }

  /* --------------------------------------------------------- clip creation */

  /** SPEC 07 §10 — one Composition per selected moment, never overwriting. */
  createClips(projectId: string, momentIds: string[], options: { openFirst?: boolean } = {}): CreateClipsResult {
    const project = this.storage.getProject(projectId);
    const transcript = this.storage.getTranscript(projectId);
    if (!project) throw new Error('That project could not be found.');
    if (!transcript) throw new Error('There is no transcript to build captions from.');

    const all = this.storage.listMoments(projectId);
    const existingComps = this.storage.listCompositions(projectId).compositions;
    const created: CreateClipsResult['created'] = [];
    const errors: CreateClipsResult['errors'] = [];

    for (const momentId of momentIds) {
      const moment = all.find((item) => item.id === momentId);
      if (!moment) {
        errors.push({ momentId, title: momentId, message: 'That moment is no longer in this project.' });
        continue;
      }

      try {
        const version = (moment.clips?.length ?? 0) + 1;
        const name = this.uniqueName(
          version > 1 ? `${moment.title} v${version}` : moment.title,
          existingComps.map((comp) => comp.name)
        );
        const comp = this.buildComposition(project, transcript, moment, { id: uuidv7(), name, version });
        this.storage.saveComposition(projectId, comp);
        existingComps.push(comp);

        const updated: Moment = {
          ...moment,
          status: 'clipped',
          clips: [...(moment.clips ?? []), comp.id],
        };
        const index = all.findIndex((item) => item.id === moment.id);
        all[index] = updated;
        created.push({ compId: comp.id, name: comp.name, momentId: moment.id });
      } catch (error) {
        errors.push({
          momentId,
          title: moment.title,
          message: error instanceof Error ? error.message : 'This clip could not be created.',
        });
      }
    }

    this.storage.saveMoments(projectId, all);
    if (created.length > 0) {
      this.storage.updateProject(projectId, { stage: 'editor' } as Partial<ProjectRecord>);
    }
    this.logger.info('Clips created', { projectId, created: created.length, failed: errors.length, openFirst: options.openFirst });
    return { created, errors };
  }

  private buildComposition(
    project: ProjectRecord,
    transcript: Transcript,
    moment: Moment,
    params: { id: string; name: string; version: number }
  ): CompositionRecord {
    const aspect = project.settings.aspect === 'original' || project.settings.aspect === 'custom' ? '9:16' : project.settings.aspect;
    const canvas = CANVAS_BY_ASPECT[aspect] ?? CANVAS_BY_ASPECT['9:16'];
    const durationUs = Math.max(1, moment.endUs - moment.startUs);
    const mediaId = project.sourceMediaIds[0] ?? transcript.mediaId;

    const videoTrackId = `trk_${uuidv7()}`;
    const captionTrackId = `trk_${uuidv7()}`;
    const videoItemId = `itm_${uuidv7()}`;

    const wordsInRange = transcript.words.filter((word) => word.endUs > moment.startUs && word.startUs < moment.endUs);
    const shifted = wordsInRange.map((word) => ({
      ...word,
      startUs: Math.max(0, word.startUs - moment.startUs),
      endUs: Math.max(1, Math.min(durationUs, word.endUs - moment.startUs)),
    }));

    const captions = buildCaptions(shifted, aspect as '9:16' | '16:9' | '1:1' | '4:5' | '4:3' | '21:9');
    const captionItems: Record<string, unknown> = {};
    const captionItemIds: string[] = [];

    for (const segment of captions) {
      const id = `itm_${uuidv7()}`;
      captionItemIds.push(id);
      captionItems[id] = {
        id,
        trackId: captionTrackId,
        type: 'caption',
        startUs: Math.max(0, segment.startUs),
        durationUs: Math.max(1, Math.min(durationUs, segment.endUs) - Math.max(0, segment.startUs)),
        label: segment.text.slice(0, 40),
        captionSegment: {
          ...segment,
          wordRefs: segment.wordRefs.map((ref) => ({
            ...ref,
            startUs: Math.max(0, ref.startUs - moment.startUs),
            endUs: Math.max(1, ref.endUs - moment.startUs),
          })),
        },
        captionStyleId: project.settings.captionStyleId,
      };
    }

    const framing = project.settings.initialFraming;
    const wasExtended = (moment.aiStartUs ?? moment.startUs) !== moment.startUs || (moment.aiEndUs ?? moment.endUs) !== moment.endUs;

    const markers = wasExtended
      ? [
          { id: `mrk_${uuidv7()}`, timeUs: 0, name: 'Moment start', color: '#FFB000' },
          { id: `mrk_${uuidv7()}`, timeUs: durationUs, name: 'Moment end', color: '#FFB000' },
        ]
      : [];

    return CompositionRecordSchema.parse({
      id: params.id,
      projectId: project.id,
      name: params.name,
      createdFromMomentId: moment.id,
      version: params.version,
      updatedAt: new Date().toISOString(),
      payload: {
        id: params.id,
        name: params.name,
        fps: 30,
        canvas: { width: canvas.width, height: canvas.height, aspect, backgroundColor: '#000000', backgroundBlur: false },
        tracks: [
          {
            id: videoTrackId,
            role: 'main',
            kind: 'video',
            name: 'Video 1',
            order: 0,
            itemIds: [videoItemId],
          },
          {
            id: captionTrackId,
            role: 'captions',
            kind: 'caption',
            name: 'Captions',
            order: 1,
            itemIds: captionItemIds,
          },
        ],
        items: {
          [videoItemId]: {
            id: videoItemId,
            trackId: videoTrackId,
            type: 'video',
            startUs: 0,
            durationUs,
            label: moment.title,
            mediaId,
            sourceInUs: moment.startUs,
            sourceDurationUs: durationUs,
            // `scale` is the project's framing field (`02 §8`); the item's own
            // transform stores per-axis scale. Writing `scale` here put a key on the
            // item's transform that nothing read, so a clip created from a moment
            // opened at 100% however it had been framed.
            transform: { x: framing.x, y: framing.y, scaleX: framing.scale, scaleY: framing.scale },
            volumeDb: 0,
            effects: [],
            keyframes: {},
          },
          ...captionItems,
        },
        markers,
        links: [],
        groups: [],
        playheadUs: 0,
        viewState: { pxPerSecond: 80, scrollX: 0, scrollY: 0, headerWidthPx: 184 },
        editByTranscriptDeletedWordIds: [],
      },
    });
  }

  private uniqueName(name: string, taken: string[]): string {
    const base = name.trim() || 'Clip';
    if (!taken.includes(base)) return base;
    let n = 2;
    while (taken.includes(`${base} (${n})`)) n += 1;
    return `${base} (${n})`;
  }

  /* ------------------------------------------------------------- internals */

  private momentSettings(project: ProjectRecord, request: AnalyzeRequest): MomentSettings {
    /*
      Translated, not cast. A project stores `talking`; the scoring table is keyed by
      `talking_head`. The cast this replaces compiled and produced `undefined` for the adjustment,
      so choosing "Talking head/vlog" applied the generic `other` weights and nothing said so.
    */
    const contentType = contentTypeFromProject(request.contentType ?? project.settings.contentType ?? 'auto');
    const settings = this.storage.getSettings();
    const [min, max] = project.settings.clipLengthRangeSec;
    return {
      targetMinSec: request.targetMinSec ?? min ?? settings.momentDefaults.targetMinSec,
      targetMaxSec: request.targetMaxSec ?? max ?? settings.momentDefaults.targetMaxSec,
      requestedCount: request.count ?? (project.settings.clipCount === 'auto' ? 'auto' : project.settings.clipCount),
      clipFocus: request.focus ?? project.settings.clipFocus ?? '',
      contentType,
      language: project.settings.language === 'auto' ? 'auto' : project.settings.language,
    };
  }

  private buildInput(project: ProjectRecord, transcript: Transcript, settings: MomentSettings): DetectionInput {
    const sentenceIndexById = new Map(transcript.sentences.map((sentence, index) => [sentence.id, index]));
    const paragraphStarts = new Set<number>();
    for (const paragraph of transcript.paragraphs) {
      const first = paragraph.sentenceIds[0];
      const index = first ? sentenceIndexById.get(first) : undefined;
      if (index !== undefined) paragraphStarts.add(index);
    }
    if (transcript.paragraphs.length === 0) paragraphStarts.add(0);

    return {
      projectId: project.id,
      transcriptVersion: transcript.version ?? 1,
      words: transcript.words,
      sentences: transcript.sentences,
      paragraphStarts,
      settings,
    };
  }

  private async routeForMoments(): Promise<Route> {
    const snapshot = this.models.snapshot();
    const whisperInstalled = snapshot.whisper.some((card) => card.status === 'installed');

    let ollamaAvailable = false;
    let ollamaModel: string | undefined;
    try {
      const overview = await this.models.ollama();
      ollamaAvailable = overview.status.state === 'running' && overview.models.length > 0;
      ollamaModel = overview.models[0]?.name;
    } catch {
      ollamaAvailable = false;
    }

    return this.providers.resolveTask(
      'moment_analysis',
      {
        whisperModelInstalled: whisperInstalled,
        whisperModelName: snapshot.whisper.find((card) => card.status === 'installed')?.id,
        ollamaAvailable,
        ollamaModel,
      },
      null
    );
  }

  private buildLlmHandle(route: Route): LlmScoringHandle | null {
    if (!route.ok) return null;
    if (route.route === 'heuristic') return null;

    if (route.route === 'ollama') {
      const config = this.providers.ollamaConfig(route.model);
      const adapter = getAdapter('ollama');
      return {
        adapter,
        config,
        providerName: config.name,
        model: route.model ?? config.models.text ?? 'ollama',
        contextWindowTokens: config.numCtx,
        platform: config.locality === 'online' ? 'online' : 'local',
      };
    }

    if (route.route === 'provider' && route.providerId) {
      const record = this.storage.listProviders().find((provider) => provider.id === route.providerId);
      if (!record) return null;
      const config = this.providers.toConfig(record);
      return {
        adapter: getAdapter(record.kind),
        config,
        providerName: record.name,
        model: route.model ?? record.models.text ?? 'default',
        contextWindowTokens: record.numCtx,
        platform: record.locality === 'online' ? 'online' : 'local',
      };
    }

    return null;
  }

  private toRecord(projectId: string, moment: DetectedMoment, context: DetectionOutcome['context']): Moment {
    return {
      id: moment.id.startsWith('mom_') ? moment.id : `mom_${uuidv7()}`,
      projectId,
      transcriptVersion: moment.transcriptVersion,
      startUs: moment.startUs,
      endUs: moment.endUs,
      durationUs: moment.durationUs,
      aiStartUs: moment.startUs,
      aiEndUs: moment.endUs,
      title: moment.title,
      reason: moment.reason,
      score: moment.score,
      scores: moment.scores,
      weightsUsed: moment.weightsUsed,
      confidence: moment.confidence,
      basis: moment.basis,
      model: moment.model ?? context.model,
      provider: moment.provider ?? context.providerName,
      flags: moment.flags,
      needsContext: moment.needsContext,
      transcriptPreview: moment.transcriptPreview,
      hookSentence: moment.hookSentence,
      groupId: moment.groupId,
      status: 'candidate',
      userEdited: false,
      manual: false,
      createdAt: new Date().toISOString(),
      clips: [],
    };
  }

  private overlaps(a: { startUs: number; endUs: number }, b: { startUs: number; endUs: number }): number {
    const overlap = Math.min(a.endUs, b.endUs) - Math.max(a.startUs, b.startUs);
    const shortest = Math.min(a.endUs - a.startUs, b.endUs - b.startUs);
    return shortest > 0 ? Math.max(0, overlap) / shortest : 0;
  }

  private hostOf(providerId: string): string {
    const record = this.storage.listProviders().find((provider) => provider.id === providerId);
    if (!record) return 'unknown';
    try {
      return new URL(record.baseUrl).host;
    } catch {
      return record.baseUrl;
    }
  }
}
