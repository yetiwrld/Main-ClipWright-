/**
 * Parse whisper.cpp JSON output into word-level timings.
 * Handles both layouts:
 *  a) one-word segments (whisper-cli -ml 1) — precise word times
 *  b) sentence/phrase segments — word times estimated proportionally by
 *     characters within the segment and flagged `approximate: true`
 * Pure and unit-tested. Never invents words.
 */
import { z } from 'zod';
import type { TranscriptWord } from '@clipwright/project-schema';

const OffsetsSchema = z.object({ from: z.number(), to: z.number() }); // milliseconds
const SegmentSchema = z.object({
  offsets: OffsetsSchema.optional(),
  timestamps: z.object({ from: z.string(), to: z.string() }).optional(),
  text: z.string(),
  tokens: z.array(z.object({
    text: z.string(),
    offsets: OffsetsSchema.optional(),
    p: z.number().optional(),
  })).optional(),
});

const OutputSchema = z.object({
  transcription: z.array(SegmentSchema),
});

export interface ParsedTranscript {
  words: TranscriptWord[];
  approximate: boolean;
  language?: string;
}

const toUs = (ms: number) => Math.round(ms * 1000);

export const parseWhisperJson = (raw: unknown, newId: () => string): ParsedTranscript => {
  const parsed = OutputSchema.parse(raw);
  const words: TranscriptWord[] = [];
  let approximate = false;

  for (const seg of parsed.transcription) {
    const segFromMs = seg.offsets?.from;
    const segToMs = seg.offsets?.to;

    // Layout A: tokens carry offsets (word-level)
    if (seg.tokens && seg.tokens.some((t) => t.offsets)) {
      for (const t of seg.tokens) {
        const text = t.text.trim();
        if (!text || /^\[_.*_\]$/.test(text)) continue; // skip [_BEG_] style markers
        if (!t.offsets) continue;
        words.push({
          id: newId(),
          index: words.length,
          text,
          startUs: toUs(t.offsets.from),
          endUs: Math.max(toUs(t.offsets.to), toUs(t.offsets.from) + 1),
          confidence: t.p,
        });
      }
      continue;
    }

    // Layout B: estimate word times inside the segment proportional to characters
    const segText = seg.text.trim();
    if (!segText) continue;
    const segWords = segText.split(/\s+/).filter(Boolean);
    if (segFromMs === undefined || segToMs === undefined || segToMs <= segFromMs) {
      // no timing info at all — emit nothing rather than fake times
      approximate = true;
      continue;
    }
    if (segWords.length > 1) approximate = true; // multi-word estimation
    const totalChars = segWords.reduce((a, w) => a + w.length, 0) || 1;
    const durMs = segToMs - segFromMs;
    let cursor = segFromMs;
    for (const w of segWords) {
      const frac = w.length / totalChars;
      const wordDur = Math.max(120, durMs * frac);
      const start = cursor;
      const end = Math.min(segToMs, start + wordDur);
      words.push({ id: newId(), index: words.length, text: w, startUs: toUs(start), endUs: toUs(Math.max(end, start + 1)) });
      cursor = end;
    }
  }

  return { words, approximate };
};

/** SRT/VTT/plain-text import fallback: split into cues/words evenly (flagged approximate). */
export const parseSubtitleFile = (content: string, newId: () => string): ParsedTranscript => {
  const words: TranscriptWord[] = [];
  const cueRe = /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/g;
  const lines = content.split(/\r?\n/);
  let current: { startMs: number; endMs: number; text: string[] } | null = null;
  const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
  const timeToMs = (h: string | undefined, m: string, s: string, ms: string) =>
    ((h ? Number(h) : 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0'));
  for (const line of lines) {
    const m = cueRe.exec(line);
    cueRe.lastIndex = 0;
    if (m) {
      if (current && current.text.length) cues.push({ startMs: current.startMs, endMs: current.endMs, text: current.text.join(' ') });
      current = { startMs: timeToMs(m[1]?.replace(':', ''), m[2]!, m[3]!, m[4]!), endMs: timeToMs(m[5]?.replace(':', ''), m[6]!, m[7]!, m[8]!), text: [] };
      continue;
    }
    const t = line.trim();
    if (!t || /^WEBVTT/.test(t) || /^\d+$/.test(t)) continue;
    if (current) current.text.push(t);
  }
  if (current && current.text.length) cues.push({ startMs: current.startMs, endMs: current.endMs, text: current.text.join(' ') });
  for (const cue of cues) {
    const segWords = cue.text.split(/\s+/).filter(Boolean);
    if (segWords.length === 0) continue;
    const totalChars = segWords.reduce((a, w) => a + w.length, 0) || 1;
    const dur = cue.endMs - cue.startMs;
    let cursor = cue.startMs;
    for (const w of segWords) {
      const wordDur = (w.length / totalChars) * dur;
      const start = cursor; const end = Math.min(cue.endMs, start + wordDur);
      words.push({ id: newId(), index: words.length, text: w, startUs: toUs(start), endUs: toUs(Math.max(end, start + 1)) });
      cursor = end;
    }
  }
  return { words, approximate: true };
};
