/**
 * whisper.cpp integration. HONEST by construction: if no whisper binary or
 * no model is installed, the job fails with a clear, actionable message —
 * the app never invents a transcript.
 */
import { existsSync, readdirSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseWhisperJson, type ParsedTranscript } from '@clipwright/ai-core';
import { newId } from '@clipwright/project-schema';
import type { TranscriptWord } from '@clipwright/project-schema';

export interface WhisperBinaryInfo { path: string; version?: string; }
export interface WhisperModelInfo { id: string; name: string; file: string; sizeBytes: number; installed: boolean; quant?: string; }

/** Recommended models (downloaded on demand from the whisper.cpp model store). */
export const KNOWN_MODELS: Array<{ id: string; name: string; file: string; sizeBytes: number; englishOnly?: boolean }> = [
  { id: 'tiny', name: 'Whisper tiny', file: 'ggml-tiny.bin', sizeBytes: 75_000_000 },
  { id: 'tiny.en', name: 'Whisper tiny (English)', file: 'ggml-tiny.en.bin', sizeBytes: 75_000_000, englishOnly: true },
  { id: 'base', name: 'Whisper base', file: 'ggml-base.bin', sizeBytes: 142_000_000 },
  { id: 'base.en', name: 'Whisper base (English)', file: 'ggml-base.en.bin', sizeBytes: 142_000_000, englishOnly: true },
  { id: 'small', name: 'Whisper small (recommended)', file: 'ggml-small.bin', sizeBytes: 466_000_000 },
  { id: 'small.en', name: 'Whisper small (English, recommended)', file: 'ggml-small.en.bin', sizeBytes: 466_000_000, englishOnly: true },
  { id: 'medium', name: 'Whisper medium', file: 'ggml-medium.bin', sizeBytes: 1_500_000_000 },
  { id: 'large-v3', name: 'Whisper large v3', file: 'ggml-large-v3.bin', sizeBytes: 2_900_000_000 },
];

export const resolveWhisperBinary = (resourcesDir?: string): WhisperBinaryInfo | null => {
  // Packaged app: extraResources places binaries in <resourcesPath>/bin.
  const packaged = (typeof process !== 'undefined' && (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath) || undefined;
  const candidates = [
    process.env['CLIPWRIGHT_WHISPER'],
    resourcesDir ? join(resourcesDir, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli') : undefined,
    packaged ? join(packaged, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli') : undefined,
    join(process.cwd(), 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) if (existsSync(c)) return { path: c };
  // PATH lookup
  const dirs = (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const name of ['whisper-cli', 'whisper-cpp', 'main']) {
    for (const d of dirs) {
      const p = join(d, process.platform === 'win32' ? `${name}.exe` : name);
      if (existsSync(p)) return { path: p };
    }
  }
  return null;
};

export const listWhisperModels = (modelsDir: string): WhisperModelInfo[] => {
  let files: string[] = [];
  try { files = readdirSync(modelsDir); } catch { files = []; }
  return KNOWN_MODELS.map((m) => {
    const path = join(modelsDir, m.file);
    const installed = existsSync(path);
    let sizeBytes = m.sizeBytes;
    if (installed) { try { sizeBytes = statSync(path).size; } catch { /* keep estimate */ } }
    return { id: m.id, name: m.name, file: m.file, sizeBytes, installed };
  });
};

export const defaultModel = (englishOnly: boolean): string => (englishOnly ? 'small.en' : 'small');

export class WhisperError extends Error {
  constructor(message: string, readonly code: 'no-binary' | 'no-model' | 'failed' | 'empty') {
    super(message);
    this.name = 'WhisperError';
  }
}

export interface TranscribeOptions {
  audioWav: string;       // 16 kHz mono pcm_s16le
  modelPath: string;
  language?: string;      // 'auto' or ISO code
  onProgress?: (fraction: number, phase: string) => void;
  signal?: AbortSignal;
}

/** Run whisper-cli and parse word-level timings. Throws WhisperError on failure. */
export const transcribe = async (opts: TranscribeOptions): Promise<ParsedTranscript & { words: TranscriptWord[] }> => {
  const binary = resolveWhisperBinary(process.resourcesPath);
  if (!binary) {
    throw new WhisperError(
      'The offline transcription engine (whisper.cpp) is not installed in this build. Install whisper-cli or use an online transcription provider.',
      'no-binary',
    );
  }
  if (!existsSync(opts.modelPath)) {
    throw new WhisperError('The selected Whisper model is not downloaded yet. Download it from the Models page and try again.', 'no-model');
  }
  const outPrefix = opts.audioWav.replace(/\.wav$/i, '') + '.whisper';
  const language = !opts.language || opts.language === 'auto' ? 'auto' : opts.language;
  const args = ['-m', opts.modelPath, '-f', opts.audioWav, '-oj', '-of', outPrefix, '-l', language, '-ml', '1', '--print-progress'];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new WhisperError('Transcription timed out.', 'failed')); }, 3 * 60 * 60 * 1000);
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    let progressBuf = '';
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      progressBuf += s;
      const matches = progressBuf.match(/progress\s*=\s*(\d+)\s*%/g) ?? [];
      for (const m of matches) {
        const pct = Number(m.match(/(\d+)/)?.[1] ?? '0');
        opts.onProgress?.(pct / 100, 'transcribing');
      }
      if (progressBuf.length > 8192) progressBuf = progressBuf.slice(-4096);
    });
    child.on('error', (err) => { clearTimeout(timer); reject(new WhisperError(`Could not start whisper-cli: ${err.message}`, 'failed')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new WhisperError(`whisper-cli exited with code ${code}. The audio may be unsupported or the model file may be corrupt.`, 'failed'));
    });
  });

  const jsonPath = outPrefix + '.json';
  if (!existsSync(jsonPath)) {
    throw new WhisperError('whisper-cli finished but produced no output file.', 'failed');
  }
  const parsed = parseWhisperJson(JSON.parse(readFileSync(jsonPath, 'utf8')), newId);
  try { unlinkSync(jsonPath); } catch { /* keep for debugging */ }
  if (parsed.words.length === 0) {
    throw new WhisperError('No speech was detected in this video.', 'empty');
  }
  return parsed;
};
