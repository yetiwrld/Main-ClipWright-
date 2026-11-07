/**
 * SPEC 05 — Transcription orchestration in the main process.
 *
 * Runs the chunked whisper.cpp (or online provider) pipeline over a project's
 * 16 kHz audio, streams provisional words back to the renderer so the transcript
 * grows while it works, and persists the finished transcript.
 */

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { transcribeAudio, listInstalledModels, type Transcript } from '@clipwright/ai-core';
import type { StorageService } from './storage/storage-service.js';

export interface TranscribeJobRequest {
  projectId: string;
  audioPath: string;
  mediaId: string;
  model: string;
  language: string;
  engine: 'whisper-local' | 'online';
  threads?: number;
  chunkDurationSec?: number;
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
  const installed = listInstalledModels(modelsDir);
  if (!installed.some((m) => m.name === request.model)) {
    throw new Error(`The model "${request.model}" is not installed. Open Models and install it first.`);
  }

  const projectDir = storage.getProjectDir(request.projectId);
  const workDir = join(projectDir, 'cache', 'whisper');
  await mkdir(workDir, { recursive: true });

  try {
    const transcript = await transcribeAudio({
      audioPath: request.audioPath,
      outputDir: workDir,
      language: request.language || 'auto',
      model: request.model,
      engine: request.engine,
      modelPath: join(modelsDir, `ggml-${request.model}.bin`),
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

    await storage.saveTranscript(request.projectId, transcript as never);
    storage.updateProject(request.projectId, { stage: 'moments' } as never);

    return {
      transcript,
      wordCount: transcript.words.length,
      language: transcript.language,
      model: transcript.model,
      durationSec: Math.round(transcript.durationUs / 1_000_000),
    };
  } finally {
    // Chunk JSON is scratch data; keep the project folder tidy.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
