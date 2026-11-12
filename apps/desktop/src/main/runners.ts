/**
 * Job handler registrations: media pipeline, transcription, moments,
 * export, URL download, model download.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { JobRunner } from './jobs.js';
import type { StorageService } from './storage.js';
import type { Logger } from './logging.js';
import type { SecretStore } from './secrets.js';
import { probeMedia, copyManaged, extractAudio, makeThumbnail, makeProxy } from './mediaRunner.js';
import { resolveBinaries, parseFfprobeJson, probeInput, fastFingerprint } from '@clipwright/media-core';
import { newId, type AppSettings } from '@clipwright/project-schema';
import { buildCaptions } from '@clipwright/caption-styles';
import { transcribe, listWhisperModels, resolveWhisperBinary, KNOWN_MODELS } from './whisper.js';
import { runMomentsPipeline } from './momentsRunner.js';
import { runExportJob } from './exportRunner.js';
import { mediaFolder } from './workspace.js';

export interface RunnerDeps {
  storage: StorageService;
  logger: Logger;
  secrets: SecretStore;
  workspaceRoot: () => string;
  getSettings: () => AppSettings;
}

export const registerJobHandlers = (jobs: JobRunner, deps: RunnerDeps): void => {
  const { storage, logger, secrets, workspaceRoot } = deps;

  jobs.register('probe', probeMedia);
  jobs.register('copy', copyManaged);
  jobs.register('extract_audio', extractAudio);
  jobs.register('thumbnails', makeThumbnail);
  jobs.register('proxy', makeProxy);

  jobs.register('transcribe', async (ctx, params) => {
    const projectId = String(params['projectId'] ?? '');
    const appSettings = deps.getSettings();
    const project = storage.getProject(projectId);
    if (!project?.sourceMediaId) throw new Error('This project has no source media yet.');
    const media = storage.getMedia(project.sourceMediaId);
    if (!media) throw new Error('The source media record is missing.');

    ctx.report(0.02, 'Preparing audio');
    const extractRes = await extractAudio(ctx, { mediaId: media.id, workspaceRoot: workspaceRoot(), audioStreamIndex: 0 });
    const audioPath = String(extractRes.path);

    // resolve model
    const modelsDir = join(workspaceRoot(), 'Models', 'whisper');
    mkdirSync(modelsDir, { recursive: true });
    const configuredModel = project.settings.transcriptionModel !== 'auto' ? project.settings.transcriptionModel : appSettings.transcriptionModel;
    let modelId = configuredModel === 'auto' ? 'small' : configuredModel;
    if (modelId === 'auto') modelId = 'small';
    const known = KNOWN_MODELS.find((m) => m.id === modelId) ?? KNOWN_MODELS.find((m) => m.id === 'small')!;
    const modelPath = join(modelsDir, known.file);
    if (!existsSync(modelPath)) {
      const installed = listWhisperModels(modelsDir).filter((m) => m.installed);
      throw new Error(
        installed.length === 0
          ? `The offline transcription model (${known.name}) isn't downloaded yet. Open Models to download it, or switch this stage to an online provider in Settings.`
          : `The selected model (${known.name}) isn't downloaded. Installed models: ${installed.map((m) => m.name).join(', ')}. Pick one in Settings → Models.`,
      );
    }
    const bin = resolveWhisperBinary(process.resourcesPath);
    if (!bin) {
      throw new Error('The offline transcription engine (whisper.cpp) is not available in this build. Switch transcription to an online provider in Settings, or install whisper-cli.');
    }

    storage.setProjectStage(projectId, 'transcribing');
    ctx.report(0.05, 'Transcribing');
    const parsed = await transcribe({
      audioWav: audioPath,
      modelPath,
      language: project.settings.language === 'auto' ? 'auto' : project.settings.language,
      onProgress: (f, phase) => ctx.report(0.05 + 0.85 * f, phase),
      signal: ctx.signal,
    });
    if (ctx.signal.aborted) throw new Error('Cancelled by the user.');

    ctx.report(0.92, 'Building captions');
    storage.replaceTranscript(projectId, parsed.words);
    const approxNote = parsed.approximate ? ' (timing approximate)' : '';
    logger.info('Transcript stored', { words: parsed.words.length, approximate: parsed.approximate });
    storage.replaceCaptions(projectId, buildCaptions(parsed.words));
    storage.setProjectStage(projectId, 'transcribed');
    return { wordCount: parsed.words.length, approximateNote: approxNote || undefined };
  });

  jobs.register('moments', async (ctx, params) => {
    const projectId = String(params['projectId'] ?? '');
    const project = storage.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const settings = project.settings;
    const appSettings = deps.getSettings();

    // resolve an online provider if configured + any local Ollama
    let onlineProvider: { baseUrl: string; apiKey: string; model: string; label?: string } | null = null;
    const preferredId = appSettings.preferredOnlineProviderId;
    const providerRecords = storage.listProviders().filter((p) => p.enabled && p.kind === 'openai-compatible');
    const chosen = (preferredId ? providerRecords.find((p) => p.id === preferredId) : undefined) ?? providerRecords[0];
    if (chosen?.secretId && chosen.baseUrl && chosen.model) {
      const key = secrets.getSecret(chosen.secretId);
      if (key) onlineProvider = { baseUrl: chosen.baseUrl, apiKey: key, model: chosen.model, label: chosen.displayName };
    }

    const result = await runMomentsPipeline(ctx, projectId, settings, onlineProvider, appSettings.ollamaModel);
    storage.setProjectStage(projectId, 'moments-ready');
    return {
      momentCount: result.moments.length,
      modeLabel: result.modeLabel,
      basis: result.basis,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  });

  jobs.register('export', runExportJob);

  jobs.register('download', async (ctx, params) => {
    const projectId = String(params['projectId'] ?? '');
    const url = String(params['url'] ?? '');
    const quality = String(params['quality'] ?? '1080p'); // 720p | 1080p | best
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) links can be downloaded.');
    const ytdlp = resolveYtdlp();
    if (!ytdlp) {
      throw new Error('URL downloads are not available in this build because yt-dlp is not bundled. Download the video with your browser and import the file instead.');
    }
    const heightLimit = quality === '720p' ? 720 : quality === '1080p' ? 1080 : undefined;
    const cacheDir = join(workspaceRoot(), 'Cache', 'downloads', String(params['jobId'] ?? newId()));
    mkdirSync(cacheDir, { recursive: true });
    const outTemplate = join(cacheDir, 'source.%(ext)s');
    const format = heightLimit ? `bv*[height<=${heightLimit}]+ba/b[height<=${heightLimit}]/b` : 'bv*+ba/b';
    const args = [
      '--no-playlist', '--continue', '--merge-output-format', 'mp4',
      '-f', format,
      '-o', outTemplate,
      '--newline', '--no-colors',
      ...(deps.getSettings().cookiesFilePath ? ['--cookies', deps.getSettings().cookiesFilePath!] : []),
      url,
    ];
    ctx.report(0.01, 'Checking link');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ytdlp.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let buf = '';
      const finishReject = (msg: string) => reject(new Error(msg));
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const m = /\[download\]\s+([\d.]+)%/.exec(line);
          if (m) ctx.report(Math.min(0.9, 0.02 + 0.88 * (Number(m[1]) / 100)), 'Downloading');
          else if (/\[Merger\]/.test(line)) ctx.report(0.94, 'Merging');
          else if (/\[ExtractAudio\]|Fixing/.test(line)) ctx.report(0.96, 'Finalising');
        }
        const err = /ERROR:\s*(.+)/.exec(buf);
        if (err) finishReject(friendlyYtDlpError(err[1]!));
      });
      child.on('error', (err) => finishReject(`Could not start yt-dlp: ${err.message}`));
      const timer = setTimeout(() => { child.kill('SIGKILL'); finishReject('The download timed out.'); }, 6 * 60 * 60 * 1000);
      opts_kill_on_abort(child, ctx.signal);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (ctx.signal.aborted) reject(new Error('Cancelled by the user.'));
        else if (code === 0) resolve();
        else reject(new Error('yt-dlp failed. The video may be private, unavailable, region-locked or protected.'));
      });
    });

    // find the produced file
    const { readdirSync } = await import('node:fs');
    const produced = readdirSync(cacheDir).filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
    if (produced.length === 0) throw new Error('The download finished but no file was produced.');
    const src = join(cacheDir, produced[0]!);
    const mediaId = newId();
    const size = statSync(src).size;
    const bins = resolveBinaries();
    const { probe } = await probeInput(bins, src, size, 30_000);
    const info = parseFfprobeJson(probe, mediaId);
    const fingerprint = await fastFingerprint(src, size);
    const root = workspaceRoot();
    const dir = mediaFolder(root, mediaId);
    mkdirSync(dir, { recursive: true });
    const ext = extname(src) || '.mp4';
    const dst = join(dir, `original${ext.toLowerCase()}`);
    renameSync(src, dst);
    try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* Cache is safe to lose */ }
    storage.registerMedia({
      id: mediaId, kind: info.kind, storageMode: 'managed', path: dst, originalName: basename(dst),
      sizeBytes: size, fingerprint, createdAt: Date.now(), info, status: 'ok',
    });
    storage.updateProject(projectId, { sourceMediaId: mediaId, stage: 'created' });
    storage.enqueueJob({ type: 'thumbnails', mediaId, params: { mediaId, workspaceRoot: root }, priority: 'user-blocking' });
    if (info.audio.length > 0) storage.enqueueJob({ type: 'extract_audio', mediaId, params: { mediaId, workspaceRoot: root }, priority: 'user-blocking' });
    return { mediaId, path: dst };
  });

  jobs.register('model-download', async (ctx, params) => {
    const modelId = String(params['modelId'] ?? '');
    const known = KNOWN_MODELS.find((m) => m.id === modelId);
    if (!known) throw new Error('Unknown model.');
    const modelsDir = join(workspaceRoot(), 'Models', 'whisper');
    mkdirSync(modelsDir, { recursive: true });
    const dst = join(modelsDir, known.file);
    const tmp = dst + '.partial';
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${known.file}`;
    ctx.report(0, 'Downloading model');
    const res = await fetch(url, { signal: ctx.signal });
    if (!res.ok || !res.body) {
      throw new Error(`The model download failed (HTTP ${res.status}). Check your internet connection and try again.`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    const fileStream = createWriteStream(tmp);
    let received = 0;
    const nodeStream = (await import('node:stream')).Readable.fromWeb(res.body as never);
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (total > 0) ctx.report(0.02 + 0.95 * (received / total), `Downloading ${known.name}`);
    });
    await pipeline(nodeStream, fileStream);
    if (statSync(tmp).size < 1_000_000) { rmSync(tmp, { force: true }); throw new Error('The downloaded model file is too small and was discarded. Try again.'); }
    renameSync(tmp, dst);
    ctx.report(1, 'Done');
    return { modelId, path: dst };
  });
};

const opts_kill_on_abort = (child: ReturnType<typeof spawn>, signal: AbortSignal): void => {
  signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, { once: true });
};

const resolveYtdlp = (): { path: string } | null => {
  const env = process.env['CLIPWRIGHT_YTDLP'];
  if (env && existsSync(env)) return { path: env };
  const dirs = (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const d of dirs) {
    for (const name of ['yt-dlp', 'yt-dlp.exe']) {
      const p = join(d, name);
      if (existsSync(p)) return { path: p };
    }
  }
  return null;
};

const friendlyYtDlpError = (raw: string): string => {
  const s = raw.toLowerCase();
  if (s.includes('private') || s.includes('login') || s.includes('sign in')) return 'This video is private or needs a login. Clipwright can\'t download it.';
  if (s.includes('age')) return 'This video needs you to be signed in to confirm your age.';
  if (s.includes('geo') || s.includes('region')) return 'This video isn\'t available in your region.';
  if (s.includes('drm')) return 'This video is protected (DRM). Clipwright can\'t download protected videos.';
  if (s.includes('not available') || s.includes('removed')) return 'This video is no longer available.';
  if (s.includes('429') || s.includes('rate')) return 'The site is limiting requests. Try again in a few minutes.';
  if (s.includes('unsupported url')) return 'This site isn\'t supported. If you have the file, import it instead.';
  return 'Something went wrong while downloading. See the log for details.';
};
