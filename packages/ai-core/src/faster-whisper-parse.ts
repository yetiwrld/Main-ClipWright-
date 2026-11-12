/**
 * Parse faster-whisper JSON (as emitted by the desktop app's Python helper)
 * into word-level timings compatible with the caption pipeline.
 *
 * The helper runs faster-whisper with `word_timestamps=True`, so normally every
 * segment carries word-level `start`/`end` in SECONDS and a `probability`.
 * Segments without word timings fall back to proportional character estimates,
 * flagged `approximate: true` — words are never invented and never dropped
 * without a time basis. Pure and unit-tested.
 */
import { z } from 'zod';
import type { TranscriptWord } from '@clipwright/project-schema';
import type { ParsedTranscript } from './whisper-parse.js';

const WordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  probability: z.number().optional(),
});
const SegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(WordSchema).optional(),
});
const OutputSchema = z.object({
  language: z.string().optional(),
  segments: z.array(SegmentSchema),
});

const toUs = (seconds: number) => Math.round(seconds * 1_000_000);

export const parseFasterWhisperJson = (raw: unknown, newId: () => string): ParsedTranscript => {
  const parsed = OutputSchema.parse(raw);
  const words: TranscriptWord[] = [];
  let approximate = false;

  const push = (text: string, startS: number, endS: number, confidence?: number): void => {
    const t = text.trim();
    if (!t) return;
    const startUs = toUs(Math.max(0, startS));
    const endUs = Math.max(toUs(Math.max(0, endS)), startUs + 1);
    words.push({
      id: newId(),
      index: words.length,
      text: t,
      startUs,
      endUs,
      ...(confidence !== undefined && Number.isFinite(confidence) ? { confidence: Math.min(1, Math.max(0, confidence)) } : {}),
    });
  };

  for (const seg of parsed.segments) {
    const timed = (seg.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
    if (timed.length > 0) {
      for (const w of timed) push(w.word, w.start, w.end, w.probability);
      continue;
    }
    const text = seg.text.trim();
    if (!text) continue;
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (seg.end <= seg.start) { approximate = true; continue; } // no timing basis — skip rather than fake
    if (parts.length > 1) approximate = true;
    const totalChars = parts.reduce((acc, w) => acc + w.length, 0) || 1;
    const durS = seg.end - seg.start;
    let cursor = seg.start;
    for (const w of parts) {
      const wordDur = Math.max(0.12, durS * (w.length / totalChars));
      const start = cursor;
      const end = Math.min(seg.end, start + wordDur);
      push(w, start, end);
      cursor = end;
    }
  }

  return {
    words,
    approximate,
    ...(parsed.language ? { language: parsed.language } : {}),
  };
};
