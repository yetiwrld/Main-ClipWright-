/**
 * SPEC 05 — Transcription orchestration in the main process.
 *
 * Runs the chunked whisper.cpp (or online provider) pipeline over a project's
 * 16 kHz audio, streams provisional words back to the renderer so the transcript
 * grows while it works, and persists the finished transcript.
 */

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  WHISPER_CATALOG,
  findWhisperModel,
  listInstalledModels,
  transcribeAudio,
  type Transcript,
  type TranscriptionProvider,
} from '@clipwright/ai-core';
import type { StorageService } from './storage/storage-service.js';

export interface TranscribeJobRequest {
  projectId: string;
  /** 16 kHz mono WAV. The handler resolves it rather than trusting a renderer path. */
  audioPath: string;
  mediaId: string;
  model: string;
  language: string;
  engine: 'whisper-local' | 'online';
  threads?: number;
  chunkDurationSec?: number;
  /** Present only when the router chose an online provider (SPEC 06 §6.1). */
  provider?: TranscriptionProvider;
}

export interface TranscribeJobProgress {
  percent: number;
  chunkIndex: number;
  totalChunks: number;
  elapsedSec: number;
  etaSec: number | null;
  liveText: string;
}

export interface TranscribeJobResult {
  transcript: Transcript;
  wordCount: number;
  language: string;
  model: string;
  durationSec: number;
}

export async function runTranscription(
  storage: StorageService,
  modelsDir: string,
  request: TranscribeJobRequest,
  onProgress: (p: TranscribeJobProgress) => void,
  signal: AbortSignal
): Promise<TranscribeJobResult> {
  if (request.engine === 'whisper-local') {
    const installed = listInstalledModels(modelsDir);
    if (!installed.some((m) => m.name === request.model)) {
      throw new Error(`The model "${request.model}" is not installed. Open Models and install it first.`);
    }
  } else if (!request.provider) {
    throw new Error('Online transcription needs a provider that can accept audio. Add one in Settings → AI providers.');
  }

  const projectDir = storage.getProjectDir(request.projectId);
  const workDir = join(projectDir, 'cache', 'whisper');
  await mkdir(workDir, { recursive: true });

  const startWall = Date.now();

  try {
    const transcript = await transcribeAudio({
      audioPath: request.audioPath,
      outputDir: workDir,
      language: request.language || 'auto',
      model: request.model,
      engine: request.engine,
      modelPath: join(modelsDir, findWhisperModel(request.model)?.fileName ?? `${request.model}.bin`),
      provider: request.provider,
      chunkDurationSec: request.chunkDurationSec ?? 30,
      threads: request.threads ?? 4,
      signal,
      onProgress: (p) => {
        onProgress({
          percent: Math.max(0, Math.min(100, Math.round(p.percent))),
          chunkIndex: p.chunkIndex,
          totalChunks: p.totalChunks,
          elapsedSec: p.elapsedSec,
          etaSec: p.etaSec,
          liveText: p.liveWords.map((w) => w.text).join(' '),
        });
      },
    });

    // The engine does not know the project; stamp the real media id and a version
    // that increments, so moments can tell when a transcript has changed.
    const existing = storage.getTranscript(request.projectId);
    const stamped: Transcript = {
      ...transcript,
      mediaId: request.mediaId,
      version: existing ? (existing.version ?? 1) + 1 : 1,
      engine: request.engine,
      model: request.model,
    };
    await storage.saveTranscript(request.projectId, stamped as never);
    storage.updateProject(request.projectId, { stage: 'moments' } as never);

    // Measured throughput makes "≈ N× real time" an observation, not a claim.
    const audioSec = stamped.durationUs / 1_000_000;
    const elapsedSec = Math.max(0.001, (Date.now() - startWall) / 1000);
    if (request.engine === 'whisper-local' && audioSec > 0) {
      storage.saveModelThroughput(request.model, Math.round((audioSec / elapsedSec) * 100) / 100, 'whisper');
    }

    return {
      transcript: stamped,
      wordCount: stamped.words.length,
      language: stamped.language,
      model: stamped.model,
      durationSec: Math.round(transcript.durationUs / 1_000_000),
    };
  } finally {
    // Chunk JSON is scratch data; keep the project folder tidy.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
