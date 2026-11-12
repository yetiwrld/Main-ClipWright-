/**
 * Build caption chunks from word-level timings. Deterministic.
 * Rules: max chars per chunk (~2 lines of style hint), max duration,
 * break on long pauses, never mid-word.
 */
import type { CaptionChunk, TranscriptWord } from '@clipwright/project-schema';
import { randomUUID } from 'node:crypto';

export interface ChunkOptions {
  maxChars?: number;        // default 42 (2 lines x ~21 chars)
  maxWords?: number;        // default 12
  maxDurationUs?: number;   // default 4_000_000
  pauseBreakUs?: number;    // default 500_000
  timeOffsetUs?: number;    // shift all times by this (for clip creation)
  id?: () => string;
}

export const buildCaptions = (words: TranscriptWord[], opts: ChunkOptions = {}): CaptionChunk[] => {
  const maxChars = opts.maxChars ?? 42;
  const maxWords = opts.maxWords ?? 12;
  const maxDurationUs = opts.maxDurationUs ?? 4_000_000;
  const pauseBreakUs = opts.pauseBreakUs ?? 500_000;
  const offset = opts.timeOffsetUs ?? 0;
  const id = opts.id ?? (() => randomUUID());

  const chunks: CaptionChunk[] = [];
  let current: TranscriptWord[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    chunks.push({
      id: id(),
      startUs: first.startUs + offset,
      endUs: last.endUs + offset,
      text: current.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'),
      wordIds: current.map((w) => w.id),
      emphasisWordIds: [],
    });
    current = [];
    currentChars = 0;
  };

  for (const word of words) {
    const wordChars = word.text.length + 1;
    const pauseBeforeWord = current.length ? word.startUs - current[current.length - 1]!.endUs : 0;
    const wouldOverflowChars = currentChars + wordChars > maxChars;
    const wouldOverflowWords = current.length >= maxWords;
    const wouldOverflowDur = current.length ? word.endUs - current[0]!.startUs > maxDurationUs : false;
    const pauseBreak = current.length > 0 && pauseBeforeWord >= pauseBreakUs;

    if (pauseBreak || wouldOverflowChars || wouldOverflowWords || wouldOverflowDur) flush();
    current.push(word);
    currentChars += wordChars;
  }
  flush();
  return chunks;
};
