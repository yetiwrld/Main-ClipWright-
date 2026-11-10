import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageService } from '../storage/storage-service.js';
import { SecretStore } from '../storage/secret-store.js';
import { ProviderService } from '../ai/provider-service.js';
import { ConsentService } from '../ai/consent-service.js';
import { ModelService } from '../ai/model-service.js';
import { MomentsService } from '../ai/moments-service.js';
import type { Transcript } from '@clipwright/project-schema';

let dir: string;
let storage: StorageService;
let providers: ProviderService;
let consents: ConsentService;
let moments: MomentsService;

/** A short transcript with real timings, used for analysis and clip creation. */
function transcript(mediaId: string): Transcript {
  const sentences = [
    'Most people think motivation comes before action.',
    'That is exactly backwards.',
    'When you wait to feel ready, you wait forever.',
    'So I started doing one small thing every morning.',
    'By the third week something strange happened.',
    'I stopped negotiating with myself.',
  ];

  const words: Transcript['words'] = [];
  const sentenceRecords: Transcript['sentences'] = [];
  let timeUs = 0;

  sentences.forEach((text, sentenceIndex) => {
    const ids: string[] = [];
    for (const token of text.split(' ')) {
      const startUs = timeUs;
      const endUs = timeUs + 380_000;
      const id = `w${sentenceIndex}_${ids.length}`;
      ids.push(id);
      words.push({
        id,
        text: token,
        startUs,
        endUs,
        edited: false,
        approximate: false,
        lowConfidence: false,
        filler: false,
        chunkIndex: 0,
        confidence: 0.9,
      });
      timeUs = endUs + 60_000;
    }
    sentenceRecords.push({ id: `s${sentenceIndex}`, wordIds: ids, startUs: words[0].startUs, endUs: timeUs });
    timeUs += 400_000;
  });

  return {
    id: 'tr_1',
    mediaId,
    language: 'en',
    engine: 'whisper-local',
    model: 'small',
    createdAt: new Date().toISOString(),
    version: 1,
    durationUs: timeUs,
    words,
    sentences: sentenceRecords,
    paragraphs: [
      {
        id: 'p0',
        sentenceIds: sentenceRecords.map((s) => s.id),
        startUs: 0,
        endUs: timeUs,
      },
    ],
    highlights: [],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-ai-'));
  storage = new StorageService(path.join(dir, 'workspace'), path.join(dir, 'appdata'));
  const secrets = new SecretStore(path.join(dir, 'appdata'));
  providers = new ProviderService(storage, secrets, storage.logger);
  consents = new ConsentService(storage, storage.logger);
  const models = new ModelService(storage, providers, storage.logger);
  moments = new MomentsService(storage, providers, models, consents, storage.logger);
});

afterEach(() => {
  storage.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProviderService', () => {
  it('stores the key outside the workspace and only reports a masked suffix', () => {
    const record = providers.save({
      name: 'Local gateway',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      models: { text: 'local-model' },
      apiKey: '  sk-test-1234\n',
      capabilities: ['text'],
    });

    expect(record.hasKey).toBe(true);
    expect(record.maskedKeySuffix).toBe('••••1234');
    expect(record.locality).toBe('local');
    expect(record.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(JSON.stringify(record)).not.toContain('sk-test-1234');

    const config = providers.toConfig(record);
    expect(config.apiKey).toBe('sk-test-1234');
  });

  it('keeps the existing key when the form is saved without one', () => {
    const first = providers.save({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-keep-me',
      capabilities: ['text'],
    });
    const edited = providers.save({ ...first, name: 'OpenAI (renamed)' });
    expect(edited.secretId).toBe(first.secretId);
    expect(providers.toConfig(edited).apiKey).toBe('sk-keep-me');
  });

  it('marks a key-requiring provider as key_missing instead of pretending it works', () => {
    const record = providers.save({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      capabilities: ['text'],
    });
    expect(record.hasKey).toBe(false);
    expect(record.status).toBe('key_missing');
  });

  it('forgets the key when asked to clear it', () => {
    const first = providers.save({
      name: 'Groq',
      kind: 'openai-compatible',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk-abc',
      capabilities: ['text'],
    });
    const cleared = providers.save({ ...first, clearKey: true });
    expect(cleared.hasKey).toBe(false);
    expect(cleared.secretId).toBeUndefined();
  });

  it('never writes the key into workspace.db', () => {
    const secret = 'sk-should-never-be-on-disk-without-encryption';
    providers.save({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secret,
      capabilities: ['text'],
    });

    const dbPath = path.join(dir, 'workspace', 'workspace.db');
    expect(fs.existsSync(dbPath)).toBe(true);
    const bytes = fs.readFileSync(dbPath).toString('latin1');
    expect(bytes.includes(secret)).toBe(false);
  });

  it('duplicating a provider does not copy the stored key', () => {
    const original = providers.save({
      name: 'Together',
      kind: 'openai-compatible',
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: 'tok-copy',
      capabilities: ['text'],
    });

    const copy = providers.duplicate(original.id);

    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Together (copy)');
    expect(copy.hasKey).toBe(false);
    expect(copy.secretId).toBeUndefined();
    expect(providers.toConfig(original).apiKey).toBe('tok-copy');
  });

  it('removing a provider also drops its consent and its task default', () => {
    const record = providers.save({
      name: 'Together',
      kind: 'openai-compatible',
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: 'tok',
      capabilities: ['text'],
    });
    consents.grant({ providerId: record.id, category: 'transcript', scope: 'always' });
    providers.setDefault('moment_analysis', record.id);

    providers.remove(record.id);

    expect(storage.listProviders()).toHaveLength(0);
    expect(storage.listConsents()).toHaveLength(0);
    expect(storage.getSettings().defaultProviders.moment_analysis).toBeUndefined();
  });

  it('refuses on-device transcription when no Whisper model is installed', () => {
    storage.updateSettings({ processingMode: 'offline' });
    const route = providers.resolveTask(
      'transcription',
      { whisperModelInstalled: false, ollamaAvailable: false },
      null
    );
    expect(route.ok).toBe(false);
    if (route.ok) return;
    expect(route.reason).toBe('no_model');
    expect(route.fix[0].kind).toBe('download_model');
  });

  it('asks for consent before an online provider may see the transcript', () => {
    const record = providers.save({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      capabilities: ['text'],
    });
    storage.saveProvider({ ...record, status: 'connected', models: { text: 'gpt-4o-mini' } });
    storage.updateSettings({ processingMode: 'online' });

    const refused = providers.resolveTask('moment_analysis', { whisperModelInstalled: false, ollamaAvailable: false }, null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('needs_consent');
      expect(refused.providerId).toBe(record.id);
    }

    consents.grant({ providerId: record.id, category: 'transcript', scope: 'always' });
    const allowed = providers.resolveTask('moment_analysis', { whisperModelInstalled: false, ollamaAvailable: false }, {
      online: true,
      checkedAt: Date.now(),
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.sendsDataOffDevice).toBe(true);
  });

  it('falls back to basic scoring offline rather than failing', () => {
    storage.updateSettings({ processingMode: 'offline' });
    const route = providers.resolveTask('moment_analysis', { whisperModelInstalled: true, ollamaAvailable: false }, null);
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.route).toBe('heuristic');
  });
});

describe('ConsentService', () => {
  it('consumes an "allow once" permission but keeps "always"', () => {
    const provider = providers.save({
      name: 'Gemini',
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'key',
      capabilities: ['text'],
    });

    consents.grant({ providerId: provider.id, category: 'transcript', scope: 'once' });
    expect(consents.isGranted(provider.id, 'transcript')).toBe(true);
    consents.consumeOneTime(provider.id, 'transcript');
    expect(consents.isGranted(provider.id, 'transcript')).toBe(false);

    consents.grant({ providerId: provider.id, category: 'transcript', scope: 'always' });
    consents.consumeOneTime(provider.id, 'transcript');
    expect(consents.isGranted(provider.id, 'transcript')).toBe(true);
  });

  it('writes the exact spec wording for a network provider', () => {
    const prompt = consents.buildPrompt({
      providerId: 'p1',
      providerName: 'Studio PC',
      locality: 'network',
      host: '192.168.1.10:11434',
      category: 'transcript',
    });
    expect(prompt.message).toContain('another computer on your network');
    expect(prompt.message).toContain('transcript text with timestamps');
    expect(prompt.neverSent).toBe('audio, video, thumbnails, file paths, or other projects');
  });

  it('names every outbound host in Settings → Privacy (§10)', () => {
    // §10 says Settings → Privacy lists every place the app talks to. That list
    // used to say "our release server", which names nothing a user can look up
    // and was not even accurate: releases live on GitHub. A vague entry here
    // undermines the whole page, because the page's value is that it is complete
    // and checkable.
    const overview = consents.overview();
    const entries = overview.backgroundCalls;
    const text = entries.map((entry) => `${entry.label} ${entry.detail}`).join(' ');

    expect(entries).toHaveLength(4);
    expect(text).toContain('github.com');
    expect(text).toContain('huggingface.co');
    // No unnamed servers: every entry must say where it goes.
    expect(text).not.toMatch(/release server/i);
    expect(text).not.toMatch(/our server/i);
  });

  it('logs metadata only and exports it as CSV', () => {
    consents.recordTransfer({ providerHost: 'api.openai.com', task: 'moment_analysis', category: 'transcript', approxBytes: 4821 });
    consents.recordTransfer({ providerHost: 'api.openai.com', task: 'transcription', category: 'audio', approxBytes: 120_000 });

    const overview = consents.overview();
    expect(overview.dataSent).toHaveLength(2);
    expect(JSON.stringify(overview.dataSent)).not.toMatch(/transcript text|speech/i);

    const csv = consents.toCsv();
    expect(csv.split('\n')[0]).toBe('time,provider host,task,data category,approximate bytes');
    expect(csv).toContain('api.openai.com');
    expect(csv.split('\n')).toHaveLength(3);

    expect(consents.clearLog()).toBe(2);
    expect(storage.listDataSent()).toHaveLength(0);
  });

  it('lists the four outbound calls with their toggle state', () => {
    storage.updateSettings({ privacy: { updateCheck: false, ytDlpUpdate: true, crashReports: false } });
    const overview = consents.overview();
    const update = overview.backgroundCalls.find((call) => call.id === 'updates');
    expect(update?.enabled).toBe(false);
    expect(overview.backgroundCalls.filter((call) => call.toggleKey === null)).toHaveLength(2);
  });
});

describe('ModelService', () => {
  it('reports the real disk state and deletes only what exists', async () => {
    const modelService = new ModelService(storage, providers, storage.logger);
    const folder = path.join(storage.getWorkspaceDir(), 'Models', 'whisper');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'ggml-tiny.bin'), Buffer.alloc(100));

    const snapshot = modelService.snapshot();
    const tiny = snapshot.whisper.find((card) => card.id === 'tiny');
    expect(tiny?.status).toBe('corrupt'); // 100 bytes is not the published size

    const result = await modelService.deleteAllDownloaded();
    expect(result.models).toContain('tiny');
    expect(fs.existsSync(path.join(folder, 'ggml-tiny.bin'))).toBe(false);
    expect(storage.getSettings().defaultWhisperModel).toBe('auto');
  });

  it('never claims Ollama is running when nothing answers', async () => {
    storage.updateSettings({ ollamaBaseUrl: 'http://127.0.0.1:1' });
    const modelService = new ModelService(storage, providers, storage.logger);
    const overview = await modelService.ollama();
    expect(overview.status.state).not.toBe('running');
    expect(overview.models).toHaveLength(0);
    expect(overview.suggestions.length).toBeGreaterThan(0);
  });
});

describe('MomentsService', () => {
  function projectWithTranscript() {
    const project = storage.createProject({ name: 'Test project', sourceMediaIds: ['media_1'] });
    storage.saveTranscript(project.id, transcript('media_1'));
    return project;
  }

  it('analyses a transcript offline and persists ranked moments', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });

    const result = await moments.analyze({ projectId: project.id });

    expect(result.route.ok).toBe(true);
    expect(result.mode).toBe('heuristic');
    expect(result.moments.length).toBeGreaterThan(0);
    for (const moment of result.moments) {
      expect(moment.score).toBeGreaterThanOrEqual(0);
      expect(moment.score).toBeLessThanOrEqual(100);
      expect(moment.basis).toBe('heuristic');
      expect(moment.transcriptVersion).toBe(1);
    }

    const stored = storage.listMoments(project.id);
    expect(stored.length).toBe(result.moments.length);
    expect(storage.getProject(project.id)?.stage).toBe('moments');
  });

  it('degrade to basic scoring with an explanation when online mode has no provider', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'online' });

    const result = await moments.analyze({ projectId: project.id });

    expect(result.route.ok).toBe(false);
    expect(result.moments.length).toBeGreaterThan(0);
    expect(result.mode).toBe('heuristic');
    expect(result.notes[0]).toMatch(/Basic scoring/i);
  });

  it('writes a clip composition with captions and one video item', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });
    const analysed = await moments.analyze({ projectId: project.id });
    const moment = analysed.moments[0];
    expect(moment).toBeDefined();
    if (!moment) return;

    const created = moments.createClips(project.id, [moment.id], { openFirst: true });
    expect(created.errors).toHaveLength(0);
    expect(created.created).toHaveLength(1);

    const comp = storage.getComposition(project.id, created.created[0].compId);
    expect(comp).toBeDefined();
    if (!comp) return;

    expect(comp.createdFromMomentId).toBe(moment.id);
    expect(comp.payload.canvas.aspect).toBe('9:16');
    expect(comp.payload.canvas.width).toBe(1080);
    expect(comp.payload.tracks.map((track) => track.kind).sort()).toEqual(['caption', 'video']);

    const items = Object.values(comp.payload.items);
    const videoItem = items.find((item) => item.type === 'video');
    expect(videoItem).toBeDefined();
    expect(videoItem?.sourceInUs).toBe(moment.startUs);
    expect(videoItem?.durationUs).toBe(moment.durationUs);

    // The project's framing must land on the axes the item's transform actually
    // reads (`transform.scaleX/scaleY`), not on a `scale` key nothing consumes.
    expect(videoItem?.transform.scaleX).toBe(project.settings.initialFraming.scale);
    expect(videoItem?.transform.scaleY).toBe(project.settings.initialFraming.scale);

    const captions = items.filter((item) => item.type === 'caption');
    expect(captions.length).toBeGreaterThan(0);
    for (const caption of captions) {
      expect(caption.startUs).toBeGreaterThanOrEqual(0);
      expect(caption.startUs + caption.durationUs).toBeLessThanOrEqual(moment.durationUs + 1);
      expect(caption.captionSegment?.text.length).toBeGreaterThan(0);
    }

    const updated = storage.listMoments(project.id).find((item) => item.id === moment.id);
    expect(updated?.status).toBe('clipped');
    expect(updated?.clips).toContain(comp.id);
  });

  it('creates a new version instead of overwriting when asked twice', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });
    const analysed = await moments.analyze({ projectId: project.id });
    const moment = analysed.moments[0];
    if (!moment) throw new Error('no moment');

    const first = moments.createClips(project.id, [moment.id]);
    const second = moments.createClips(project.id, [moment.id]);

    expect(first.created[0].compId).not.toBe(second.created[0].compId);
    expect(second.created[0].name).toBe(`${moment.title} v2`);
    expect(storage.listCompositions(project.id).compositions).toHaveLength(2);
  });

  it('reports a failure per clip without losing the others', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });
    const analysed = await moments.analyze({ projectId: project.id });
    const moment = analysed.moments[0];
    if (!moment) throw new Error('no moment');

    const result = moments.createClips(project.id, [moment.id, 'mom_does_not_exist']);
    expect(result.created).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].momentId).toBe('mom_does_not_exist');
  });

  it('keeps a manual range unscored and marked as the user’s own', () => {
    const project = projectWithTranscript();
    const created = moments.addManualMoment(project.id, { startUs: 0, endUs: 3_000_000 });

    expect(created.manual).toBe(true);
    expect(created.userEdited).toBe(true);
    expect(created.score).toBe(0);
    expect(created.reason).toMatch(/not been scored/i);
    expect(storage.listMoments(project.id)).toHaveLength(1);
  });

  it('rejects a one-millisecond edit instead of saving a broken range', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });
    const analysed = await moments.analyze({ projectId: project.id });
    const moment = analysed.moments[0];
    if (!moment) throw new Error('no moment');

    expect(() => moments.updateMoment(project.id, { id: moment.id, endUs: moment.startUs + 10 })).toThrow(
      /at least one second/i
    );
  });

  it('records an edit and keeps the AI boundaries for Reset', async () => {
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });
    const analysed = await moments.analyze({ projectId: project.id });
    const moment = analysed.moments[0];
    if (!moment) throw new Error('no moment');

    const edited = moments.updateMoment(project.id, {
      id: moment.id,
      startUs: moment.startUs,
      endUs: moment.endUs + 1_000_000,
    });

    expect(edited.userEdited).toBe(true);
    expect(edited.aiStartUs).toBe(moment.startUs);
    expect(edited.aiEndUs).toBe(moment.endUs);
    expect(edited.durationUs).toBe(moment.durationUs + 1_000_000);
  });

  it('uses the project’s clip-length range, which is what the start screen now writes', async () => {
    /*
      Two slices meet here. `moments-service` has always read `project.settings.clipLengthRangeSec`
      to decide how long a moment should be, and the start screen used to send `clipLength`
      instead — an unknown key the schema passed through and nothing read, so every project was
      analysed against the 30–60 s default whatever the user picked. Nothing tested this line, so
      neither half of that was visible: the analyser's dependency had no test, and the field it
      depended on had no writer.

      The assertion is the *selection*, not the setting: a five-second range must choose short
      moments from the same transcript that a ninety-second range chooses long ones from. A range
      that is stored but ignored would return the same moments both times.
    */
    const project = projectWithTranscript();
    storage.updateSettings({ processingMode: 'offline' });

    const short = await moments.analyze({ projectId: project.id });
    const shortLongest = Math.max(...short.moments.map((moment) => moment.durationUs));

    /* 5 s: the schema's own floor, and well under the 30–60 s default. */
    storage.updateProject(project.id, { settings: { ...project.settings, clipLengthRangeSec: [5, 6] } });
    const brief = await moments.analyze({ projectId: project.id });
    const briefLongest = Math.max(...brief.moments.map((moment) => moment.durationUs));

    expect(brief.moments.length).toBeGreaterThan(0);
    expect(briefLongest).toBeLessThan(shortLongest);
    expect(briefLongest).toBeLessThanOrEqual(6_500_000);
  });

  it('explains a missing transcript instead of returning nothing', async () => {
    const project = storage.createProject({ name: 'No transcript' });
    await expect(moments.analyze({ projectId: project.id })).rejects.toThrow(/Transcribe the video first/i);
  });
});
