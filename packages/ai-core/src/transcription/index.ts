/**
 * Spec 05 — Transcription and Caption Data (ai-core/transcription)
 */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { mkdir, readFile, unlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { probeMedia } from '@clipwright/media-core';
import {
  WHISPER_CATALOG,
  accuracyLabel,
  downloadFile,
  whisperChecksums,
} from '../models/index.js';

export interface Word {
  id: string;
  text: string;
  startUs: number;
  endUs: number;
  confidence?: number;
  speaker?: string;
  edited: boolean;
  approximate: boolean;
  lowConfidence: boolean;
  filler: boolean;
  chunkIndex: number;
}

export interface Sentence {
  id: string;
  wordIds: string[];
  startUs: number;
  endUs: number;
}

export interface Paragraph {
  id: string;
  sentenceIds: string[];
  startUs: number;
  endUs: number;
  speaker?: string;
}

export interface Highlight {
  id: string;
  startUs: number;
  endUs: number;
  color: string;
  note?: string;
}

export interface Transcript {
  id: string;
  mediaId: string;
  language: string;
  languageConfidence?: number;
  engine: 'whisper-local' | string;
  model: string;
  createdAt: string;
  version: number;
  durationUs: number;
  words: Word[];
  sentences: Sentence[];
  paragraphs: Paragraph[];
  highlights: Highlight[];
}

export interface ChunkPlan {
  chunkIndex: number;
  startUs: number;
  endUs: number;
  durationUs: number;
  carryOverText: string;
}

export interface TranscribeProgress {
  percent: number;
  chunkIndex: number;
  totalChunks: number;
  currentChunkStartUs: number;
  chunkDurationUs: number;
  elapsedSec: number;
  etaSec: number | null;
  throughput: number;
  liveWords: Word[];
}

export interface TranscribeOptions {
  audioPath: string;
  outputDir: string;
  language: string;
  model: string;
  engine: 'whisper-local' | 'online';
  provider?: TranscriptionProvider;
  modelPath?: string;
  chunkDurationSec: number;
  threads?: number;
  signal?: AbortSignal;
  onProgress?: (p: TranscribeProgress) => void;
  onWords?: (words: Word[], provisional: boolean) => void;
}

export interface TranscriptionProvider {
  id: string;
  supportsWordTimestamps: boolean;
  maxUploadBytes: number;
  transcribe(audioChunk: Buffer, opts: { language: string; prompt: string; signal: AbortSignal }, onProgress?: (p: { percent: number }) => void): Promise<ChunkResult>;
}

export interface ChunkResult {
  words: Array<{ text: string; startSec: number; endSec: number; confidence?: number }>;
  language: string;
  languageConfidence: number;
}

/**
 * Splits an audio track into transcription chunks.
 *
 * Boundaries are deterministic: consecutive chunks tile the duration with no
 * gaps or overlaps. When `silenceBoundariesUs` is supplied (from real ffmpeg
 * silencedetect output), each nominal boundary is snapped to the nearest
 * silenced point inside a ±15s window, which improves word accuracy at the
 * joins. Without that data the nominal boundary is used as-is.
 */
export function planChunks(
  durationUs: number,
  chunkDurationSec: number,
  carryOverText: string = '',
  silenceBoundariesUs: number[] = []
): ChunkPlan[] {
  const chunkDurationUs = chunkDurationSec * 1_000_000;
  if (durationUs <= 0 || chunkDurationUs <= 0) return [];

  const sortedSilences = [...silenceBoundariesUs].sort((a, b) => a - b);
  const snapWindowUs = 15_000_000;
  const chunks: ChunkPlan[] = [];
  let currentStart = 0;
  let prevText = carryOverText;

  while (currentStart < durationUs) {
    const nominalEnd = currentStart + chunkDurationUs;
    let currentEnd = Math.min(nominalEnd, durationUs);

    if (nominalEnd < durationUs && sortedSilences.length > 0) {
      const lo = Math.max(currentStart + 1, nominalEnd - snapWindowUs);
      const hi = Math.min(durationUs, nominalEnd + snapWindowUs);
      let best: number | null = null;
      for (const boundary of sortedSilences) {
        if (boundary < lo) continue;
        if (boundary > hi) break;
        if (best === null || Math.abs(boundary - nominalEnd) < Math.abs(best - nominalEnd)) {
          best = boundary;
        }
      }
      if (best !== null) currentEnd = best;
    }

    // Guard against a zero-length or backwards chunk from bad silence data
    if (currentEnd <= currentStart) currentEnd = Math.min(nominalEnd, durationUs);

    chunks.push({
      chunkIndex: chunks.length,
      startUs: currentStart,
      endUs: currentEnd,
      durationUs: currentEnd - currentStart,
      carryOverText: prevText.slice(-200),
    });
    prevText = '';
    currentStart = currentEnd;
  }

  return chunks;
}

export async function transcribeAudio(opts: TranscribeOptions): Promise<Transcript> {
  const totalDurationUs = await getAudioDurationUs(opts.audioPath);
  const chunks = planChunks(totalDurationUs, opts.chunkDurationSec);
  const allWords: Word[] = [];
  let detectedLanguage = opts.language;
  let languageConfidence: number | undefined;

  let completedAudioSec = 0;
  let elapsedSec = 0;
  let smoothedThroughput = 0;
  const startWall = Date.now();

  for (const chunk of chunks) {
    if (opts.signal?.aborted) {
      throw new Error('Transcription cancelled');
    }

    const chunkWords = await transcribeChunk(chunk, opts, detectedLanguage, chunk.carryOverText);

    if (!detectedLanguage || detectedLanguage === 'auto') {
      detectedLanguage = chunkWords.language;
      languageConfidence = chunkWords.languageConfidence;
    }

    const absoluteWords: Word[] = chunkWords.words.map((w, i) => ({
      id: `word_${chunk.chunkIndex}_${i}`,
      text: w.text,
      startUs: Math.round(chunk.startUs + w.startSec * 1_000_000),
      endUs: Math.round(chunk.startUs + w.endSec * 1_000_000),
      confidence: w.confidence,
      edited: false,
      approximate: w.approximate ?? false,
      lowConfidence: false,
      filler: isFiller(w.text),
      chunkIndex: chunk.chunkIndex,
    }));

    allWords.push(...absoluteWords);
    completedAudioSec += chunk.durationUs / 1_000_000;
    elapsedSec = (Date.now() - startWall) / 1000;

    const chunkThroughput = chunk.durationUs / 1_000_000 / elapsedSec;
    smoothedThroughput = smoothedThroughput === 0 ? chunkThroughput : smoothedThroughput * 0.7 + chunkThroughput * 0.3;

    const percent = totalDurationUs > 0 ? (completedAudioSec * 1_000_000 / totalDurationUs) * 100 : 0;
    const remainingSec = totalDurationUs > 0 ? (totalDurationUs - completedAudioSec * 1_000_000) / 1_000_000 : 0;
    const etaSec = smoothedThroughput > 0 ? Math.round(remainingSec / smoothedThroughput) : null;

    opts.onProgress?.({
      percent: Math.round(percent),
      chunkIndex: chunk.chunkIndex + 1,
      totalChunks: chunks.length,
      currentChunkStartUs: chunk.startUs,
      chunkDurationUs: chunk.durationUs,
      elapsedSec: Math.round(elapsedSec),
      etaSec,
      throughput: Math.round(smoothedThroughput),
      liveWords: absoluteWords,
    });

    opts.onWords?.(absoluteWords, false);
  }

  const { sentences, paragraphs } = buildSentencesAndParagraphs(allWords);

  return {
    id: `transcript_${Date.now()}`,
    mediaId: opts.audioPath.split('/').pop() || 'unknown',
    language: detectedLanguage,
    languageConfidence,
    engine: opts.engine,
    model: opts.model,
    createdAt: new Date().toISOString(),
    version: 1,
    durationUs: totalDurationUs,
    words: allWords,
    sentences,
    paragraphs,
    highlights: [],
  };
}

async function transcribeChunk(
  chunk: ChunkPlan,
  opts: TranscribeOptions,
  language: string,
  carryOver: string
): Promise<RawChunkResult> {
  if (opts.engine === 'whisper-local') {
    return transcribeWithWhisper(chunk, opts, language, carryOver);
  } else if (opts.provider) {
    return transcribeWithProvider(chunk, opts, language, carryOver);
  }
  throw new Error('No transcription engine configured');
}

/** Raw word timings produced by a transcription backend, chunk-relative. */
interface RawWord {
  text: string;
  startSec: number;
  endSec: number;
  confidence?: number;
  /** True when timing was interpolated rather than produced by the model. */
  approximate?: boolean;
}

interface RawChunkResult {
  words: RawWord[];
  language: string;
  languageConfidence: number;
}

/** whisper.cpp JSON: offsets are milliseconds from the start of the audio. */
interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  p?: number;
}

interface WhisperSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: WhisperToken[];
}

interface WhisperJson {
  transcription?: WhisperSegment[];
  result?: { language?: string };
  params?: { language?: string };
}

async function transcribeWithWhisper(
  chunk: ChunkPlan,
  opts: TranscribeOptions,
  language: string,
  carryOver: string
): Promise<RawChunkResult> {
  const whisperPath = resolve(join(process.cwd(), 'resources', 'bin', 'whisper-cli'));
  const modelPath =
    opts.modelPath || resolve(join(process.cwd(), 'Models', 'whisper', `ggml-${opts.model}.bin`));
  const outputBase = join(opts.outputDir, `chunk_${chunk.chunkIndex}`);

  if (!existsSync(modelPath)) {
    throw new Error(
      `The transcription model "${opts.model}" is not installed. Open Models and install it, then try again.`
    );
  }

  // whisper.cpp writes word-level timings when segments are limited to one line
  // and the full JSON (with per-token offsets) is requested.
  const args = [
    '-m', modelPath,
    '-f', opts.audioPath,
    '-l', language === 'auto' ? 'auto' : language,
    '-t', String(Math.max(1, opts.threads ?? 2)),
    '-ml', '1',
    '-ojf',
    '-of', outputBase,
    '--offset-t', String(Math.round(chunk.startUs / 1000)),
    '--duration-t', String(Math.round(chunk.durationUs / 1000)),
  ];

  if (carryOver) {
    args.push('--prompt', carryOver.slice(-200));
  }

  await runWhisper(whisperPath, args, opts.signal);

  const jsonPath = `${outputBase}.json`;
  const raw = await readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(raw) as WhisperJson;

  const segments = parsed.transcription ?? [];
  const words: RawWord[] = [];
  let segmentStartSec = 0;

  for (const seg of segments) {
    const segStart = (seg.offsets?.from ?? 0) / 1000;
    const segEnd = (seg.offsets?.to ?? seg.offsets?.from ?? 0) / 1000;
    segmentStartSec = Math.max(segmentStartSec, segEnd);

    const tokens = seg.tokens ?? [];
    if (tokens.length > 0) {
      for (const token of tokens) {
        const text = (token.text ?? '').trim();
        if (!text || text.startsWith('[') || /^\s*$/.test(text)) continue;
        const from = (token.offsets?.from ?? segStart * 1000) / 1000;
        const to = (token.offsets?.to ?? from * 1000 + 100) / 1000;
        words.push({
          text,
          startSec: Math.max(0, from),
          endSec: Math.max(from, to),
          confidence: typeof token.p === 'number' ? Math.max(0, Math.min(1, token.p)) : undefined,
          approximate: false,
        });
      }
      continue;
    }

    const text = (seg.text ?? '').trim();
    if (!text) continue;
    const parts = text.split(/\s+/).filter(Boolean);
    const span = Math.max(0, segEnd - segStart);
    const per = span / Math.max(parts.length, 1);
    parts.forEach((part, i) => {
      words.push({
        text: part,
        startSec: segStart + i * per,
        endSec: segStart + (i + 1) * per,
        confidence: 0.5,
        approximate: true,
      });
    });
  }

  if (words.length === 0) {
    throw new Error('No speech was found in this recording. Check the audio track and try again.');
  }

  return {
    words,
    language: parsed.result?.language || parsed.params?.language || (language === 'auto' ? 'en' : language),
    languageConfidence: 0.9,
  };
}

function runWhisper(binPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (!existsSync(binPath)) {
      reject(new Error('The Whisper engine is missing from this installation. Reinstall Clipwright to restore it.'));
      return;
    }

    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new Error('Transcription cancelled')));
    };
    signal?.addEventListener('abort', onAbort);

    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (err) => finish(() => reject(err)));

    child.on('close', (code) => {
      if (code === 0) {
        finish(() => resolvePromise());
      } else {
        finish(() => reject(new Error(`Whisper failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`)));
      }
    });
  });
}

async function transcribeWithProvider(
  chunk: ChunkPlan,
  opts: TranscribeOptions,
  language: string,
  carryOver: string
): Promise<RawChunkResult> {
  const provider = opts.provider;
  if (!provider) throw new Error('No transcription provider is configured.');

  // Audio is normalised to 16 kHz mono 16-bit PCM, so a chunk maps to a byte range.
  const bytesPerSec = 16_000 * 2;
  const startByte = Math.floor((chunk.startUs / 1_000_000) * bytesPerSec);
  const length = Math.floor((chunk.durationUs / 1_000_000) * bytesPerSec);

  if (length > provider.maxUploadBytes) {
    throw new Error(
      `This chunk is larger than ${provider.id} accepts. Reduce the chunk length in Settings, or use local transcription.`
    );
  }

  const chunkData = await readByteRange(opts.audioPath, startByte, length);

  const result = await provider.transcribe(
    chunkData,
    {
      language: language === 'auto' ? 'auto' : language,
      prompt: carryOver,
      signal: opts.signal ?? new AbortController().signal,
    },
    (p) => {
      opts.onProgress?.({
        percent: Math.round(p.percent),
        chunkIndex: chunk.chunkIndex + 1,
        totalChunks: 1,
        currentChunkStartUs: chunk.startUs,
        chunkDurationUs: chunk.durationUs,
        elapsedSec: 0,
        etaSec: null,
        throughput: 0,
        liveWords: [],
      });
    }
  );

  return {
    words: result.words.map((w) => ({
      text: w.text,
      startSec: w.startSec,
      endSec: w.endSec,
      confidence: w.confidence,
      approximate: false,
    })),
    language: result.language,
    languageConfidence: result.languageConfidence,
  };
}

async function readByteRange(filePath: string, start: number, length: number): Promise<Buffer> {
  const fileSize = statSync(filePath).size;
  const available = Math.max(0, fileSize - start);
  const toRead = Math.min(length, available);
  if (toRead <= 0) return Buffer.alloc(0);

  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end: start + toRead - 1 });
    stream.on('data', (d) => chunks.push(d as Buffer));
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Reads the true duration of an audio file with ffprobe (via media-core).
 * Falls back to parsing the RIFF header only for plain WAV input.
 */
async function getAudioDurationUs(audioPath: string): Promise<number> {
  try {
    const info = await probeMedia(audioPath);
    if (info.durationUs > 0) return info.durationUs;
  } catch {
    /* ffprobe unavailable or the file is not probeable — try the WAV header */
  }

  if (audioPath.toLowerCase().endsWith('.wav')) {
    return readWavDurationUs(audioPath);
  }

  throw new Error('Could not read the duration of this audio file.');
}

function readWavDurationUs(audioPath: string): number {
  const fd = openSync(audioPath, 'r');
  try {
    const header = Buffer.alloc(44);
    readSync(fd, header, 0, 44, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('This file is not a valid WAV file.');
    }
    const byteRate = header.readUInt32LE(28);
    if (byteRate <= 0) throw new Error('This WAV file has an invalid header.');
    const fileSize = statSync(audioPath).size;
    const dataBytes = Math.max(0, fileSize - 44);
    return Math.round((dataBytes / byteRate) * 1_000_000);
  } finally {
    closeSync(fd);
  }
}

const FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'hmm', 'mm', 'hm', 'hey', 'umm', 'uhh', 'err', 'ahem',
  'you know', 'i mean', 'like', 'basically', 'actually', 'literally', 'so', 'well',
]);

export function isFiller(text: string): boolean {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, '');
  return FILLER_WORDS.has(lower) || FILLER_WORDS.has(lower.split(/\s+/)[0]);
}

export function buildSentencesAndParagraphs(words: Word[]): { sentences: Sentence[]; paragraphs: Paragraph[] } {
  const sentences: Sentence[] = [];
  const paragraphs: Paragraph[] = [];
  let currentSentenceWords: Word[] = [];
  let currentParagraphSentences: Sentence[] = [];

  const sentenceEnders = new Set(['.', '?', '!', '…']);
  const abbreviations = new Set(['mr.', 'ms.', 'dr.', 'e.g.', 'i.e.', 'etc.', 'vs.', 'fig.', 'no.']);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];

    const endsSentence =
      w.text.length > 0 &&
      sentenceEnders.has(w.text.slice(-1)) &&
      !abbreviations.has(w.text.toLowerCase());

    if (endsSentence) {
      currentSentenceWords.push(w);
      const sentence = makeSentence(currentSentenceWords, sentences.length);
      sentences.push(sentence);
      currentSentenceWords = [];
      currentParagraphSentences.push(sentence);

      if (currentParagraphSentences.length >= 8) {
        paragraphs.push(makeParagraph(currentParagraphSentences, paragraphs.length, words));
        currentParagraphSentences = [];
      }
    } else if (next && next.startUs - w.endUs > 1_000_000) {
      // Pause > 1s forces sentence break
      if (currentSentenceWords.length > 0) {
        currentSentenceWords.push(w);
        const sentence = makeSentence(currentSentenceWords, sentences.length);
        sentences.push(sentence);
        currentSentenceWords = [];
        currentParagraphSentences.push(sentence);
      }
    } else if (currentSentenceWords.length >= 40) {
      currentSentenceWords.push(w);
      const sentence = makeSentence(currentSentenceWords, sentences.length);
      sentences.push(sentence);
      currentSentenceWords = [];
      currentParagraphSentences.push(sentence);
    } else {
      currentSentenceWords.push(w);
    }
  }

  if (currentSentenceWords.length > 0) {
    const sentence = makeSentence(currentSentenceWords, sentences.length);
    sentences.push(sentence);
    currentParagraphSentences.push(sentence);
  }

  if (currentParagraphSentences.length > 0) {
    paragraphs.push(makeParagraph(currentParagraphSentences, paragraphs.length, words));
  }

  return { sentences, paragraphs };
}

function makeSentence(words: Word[], index: number): Sentence {
  return {
    id: `sent_${index}`,
    wordIds: words.map((w) => w.id),
    startUs: words[0].startUs,
    endUs: words[words.length - 1].endUs,
  };
}

function makeParagraph(sentences: Sentence[], index: number, words: Word[]): Paragraph {
  const firstWord = words.find((w) => w.id === sentences[0].wordIds[0]);
  const lastSentence = sentences[sentences.length - 1];
  const lastWord = words.find((w) => w.id === lastSentence.wordIds[lastSentence.wordIds.length - 1]);
  return {
    id: `para_${index}`,
    sentenceIds: sentences.map((s) => s.id),
    startUs: firstWord?.startUs || 0,
    endUs: lastWord?.endUs || 0,
    speaker: firstWord?.speaker,
  };
}

export function buildCaptions(
  words: Word[],
  aspect: '9:16' | '1:1' | '16:9' | '4:5' | '4:3' | '21:9',
  styleHints?: { wordByWord?: boolean; karaoke?: boolean }
): Array<{
  id: string;
  wordRefs: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
  startUs: number;
  endUs: number;
  text: string;
  lines: string[];
  speaker?: string;
  manualTiming: boolean;
  manualText: boolean;
}> {
  const config = getCaptionConfig(aspect, styleHints);
  const segments: Array<{
    id: string;
    wordRefs: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
    startUs: number;
    endUs: number;
    text: string;
    lines: string[];
    speaker?: string;
    manualTiming: boolean;
    manualText: boolean;
  }> = [];

  let currentSegment: typeof segments[0] | null = null;
  let currentWords: Word[] = [];
  let pauseBefore: number = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const pauseAfter = next ? next.startUs - w.endUs : 0;

    if (currentSegment && (
      (next && next.startUs - currentSegment.startUs >= config.maxDurationUs) ||
      pauseAfter >= 500_000 ||
      (currentWords.length >= config.targetWordsMax)
    )) {
      finalizeSegment(currentSegment, currentWords, segments);
      currentSegment = null;
      currentWords = [];
    }

    if (!currentSegment) {
      currentSegment = {
        id: `cap_${segments.length}`,
        wordRefs: [],
        startUs: w.startUs,
        endUs: w.endUs,
        text: '',
        lines: [],
        speaker: w.speaker,
        manualTiming: false,
        manualText: false,
      };
      currentWords = [];
    }

    currentSegment.wordRefs.push({ wordId: w.id, startUs: w.startUs, endUs: w.endUs, textOverride: undefined });
    currentWords.push(w);
    currentSegment.endUs = w.endUs;
    currentSegment.text = currentWords.map((cw) => cw.text).join(' ');

    // Check punctuation break
    if (sentenceEnders.has(w.text.replace(/[^.?!…]$/, '')) && w.text.endsWith(w.text.replace(/[^.?!…]$/, ''))) {
      if (currentWords.length >= config.targetWordsMin) {
        finalizeSegment(currentSegment, currentWords, segments);
        currentSegment = null;
        currentWords = [];
      }
    }
  }

  if (currentSegment && currentWords.length > 0) {
    finalizeSegment(currentSegment, currentWords, segments);
  }

  // Merge tiny segments
  const merged: typeof segments[0][] = [];
  for (const seg of segments) {
    if (merged.length > 0 && seg.endUs - seg.startUs < 600_000) {
      const prev = merged[merged.length - 1];
      prev.wordRefs.push(...seg.wordRefs);
      prev.endUs = seg.endUs;
      prev.text = prev.wordRefs.map((wr) => wr.textOverride || words.find((w) => w.id === wr.wordId)?.text || '').join(' ');
    } else {
      merged.push(seg);
    }
  }

  // Balance lines
  for (const seg of merged) {
    seg.lines = balanceLines(seg.text, config.maxCharsPerLine, config.maxLines);
  }

  return merged;
}

const sentenceEnders = new Set(['.', '?', '!', '…']);

function getCaptionConfig(aspect: string, styleHints?: { wordByWord?: boolean; karaoke?: boolean }) {
  if (aspect === '9:16' || aspect === '4:5') {
    return {
      maxCharsPerLine: 20,
      maxLines: 2,
      maxDurationUs: 3_000_000,
      targetWordsMin: 3,
      targetWordsMax: 6,
    };
  }
  if (aspect === '1:1') {
    return {
      maxCharsPerLine: 28,
      maxLines: 2,
      maxDurationUs: 3_500_000,
      targetWordsMin: 4,
      targetWordsMax: 8,
    };
  }
  // 16:9, 21:9, 4:3
  return {
    maxCharsPerLine: 40,
    maxLines: 2,
    maxDurationUs: 4_500_000,
    targetWordsMin: 6,
    targetWordsMax: 12,
  };
}

function finalizeSegment(
  segment: NonNullable<ReturnType<typeof buildCaptions>[0]>,
  words: Word[],
  segments: Array<ReturnType<typeof buildCaptions>[0]>
) {
  segment.text = words.map((w) => w.text).join(' ');
  segment.lines = balanceLines(segment.text, 40, 2); // will be recalculated
  segments.push(segment);
}

function balanceLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  if (words.length === 0) return [''];
  if (words.length === 1) return [text];

  const lines: string[] = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxChars) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines - 1) {
        // Remaining words go on last line
        const remaining = words.slice(words.indexOf(word));
        return [...lines, remaining.join(' ')];
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

export function exportTranscript(transcript: Transcript, format: 'txt' | 'srt' | 'vtt' | 'json', aspect: string = '16:9'): string {
  if (format === 'json') {
    return JSON.stringify(transcript, null, 2);
  }

  if (format === 'txt') {
    return transcript.paragraphs.map((p) =>
      p.sentenceIds.map((sid) => transcript.sentences.find((s) => s.id === sid))
        .filter(Boolean)
        .map((s) => transcript.words.filter((w) => s!.wordIds.includes(w.id)).map((w) => w.text).join(' '))
        .join(' ')
    ).join('\n\n');
  }

  const captions = buildCaptions(transcript.words, aspect as any);

  if (format === 'srt') {
    return captions.map((c, i) => {
      const start = formatTimecode(c.startUs);
      const end = formatTimecode(c.endUs);
      return `${i + 1}\n${start} --> ${end}\n${c.lines.join('\n')}\n`;
    }).join('\n');
  }

  if (format === 'vtt') {
    return `WEBVTT\n\n` + captions.map((c, i) => {
      const start = formatVttTimecode(c.startUs);
      const end = formatVttTimecode(c.endUs);
      return `${i + 1}\n${start} --> ${end}\n${c.lines.join('\n')}\n`;
    }).join('\n');
  }

  return '';
}

function formatTimecode(us: number): string {
  const ms = Math.floor(us / 1000);
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const s = seconds % 60;
  const m = minutes % 60;
  const h = hours;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function formatVttTimecode(us: number): string {
  const ms = Math.floor(us / 1000);
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const s = seconds % 60;
  const m = minutes % 60;
  const h = hours;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

/**
 * Speech models, derived from the catalogue data file.
 *
 * `name` and `fileName` come from `/assets/whisper-models.json`, so adding or
 * correcting a model never means editing logic. Sizes are the published ones,
 * used for the pre-download space check and for spotting a truncated file.
 */
export const WHISPER_MODELS: Array<{
  name: string;
  bytes: number;
  label: string;
  speed: string;
  fileName: string;
}> = WHISPER_CATALOG.map((model) => ({
  name: model.id,
  bytes: model.bytes,
  label: model.label,
  speed: `${accuracyLabel(model.accuracy)} · needs about ${model.ramGb} GB RAM`,
  fileName: model.fileName,
}));

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function modelFileName(modelName: string): string {
  const known = WHISPER_MODELS.find((m) => m.name === modelName);
  return known?.fileName ?? `ggml-${modelName}.bin`;
}

/**
 * Downloads a speech model with range-resume and digest verification
 * (`06 §7.2`). Thin wrapper kept for callers that only want a path back.
 */
export async function downloadWhisperModel(
  modelName: string,
  outputDir: string,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<string> {
  const known = WHISPER_MODELS.find((m) => m.name === modelName);
  if (!known) throw new Error(`Unknown model "${modelName}".`);

  const outcome = await downloadFile(
    {
      id: known.name,
      url: `${MODEL_BASE_URL}/${known.fileName}`,
      destDir: outputDir,
      fileName: known.fileName,
      expectedBytes: known.bytes,
      expectedSha256: whisperChecksums()[known.name],
      signal,
    },
    (event) => {
      if (event.percent !== null) onProgress?.(event.percent);
    }
  );

  onProgress?.(100);
  return outcome.filePath;
}

/** Lists models already installed in a models directory. */
export function listInstalledModels(
  modelsDir: string
): Array<{ name: string; path: string; bytes: number; verified: boolean | null }> {
  if (!existsSync(modelsDir)) return [];
  const checksums = whisperChecksums();
  return WHISPER_MODELS.flatMap((m) => {
    const file = join(modelsDir, m.fileName);
    if (!existsSync(file)) return [];
    const bytes = statSync(file).size;
    return [
      {
        name: m.name,
        path: file,
        bytes,
        // Correct size is not proof; without a pinned digest it stays "unknown".
        verified: bytes === m.bytes && checksums[m.name] ? null : false,
      },
    ];
  });
}
