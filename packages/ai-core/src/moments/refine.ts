/**
 * SPEC 07 §4.5 — Boundary refinement.
 *
 * Clips must never cut mid-word, never include another speaker's words, and
 * always carry a little breathing room. Everything is clamped to the words the
 * candidate actually covers.
 */

import type { SentenceIndexEntry } from './candidates.js';
import type { Candidate, MomentSettings } from './types.js';

const PRE_ROLL_US = 250_000;
const POST_ROLL_US = 400_000;

export interface RefinedRange {
  startUs: number;
  endUs: number;
  durationUs: number;
  sentenceStart: number;
  sentenceEnd: number;
  /** True when the range was widened to repair standalone-ness. */
  extended: boolean;
}

export interface RefineOptions {
  candidate: Candidate;
  entries: SentenceIndexEntry[];
  settings: MomentSettings;
  trimStartSentence?: number;
  trimEndSentence?: number;
  needsContext?: boolean;
}

export function refineBoundaries(options: RefineOptions): RefinedRange | null {
  const { candidate, entries, settings } = options;

  let startIndex = clampIndex(options.trimStartSentence ?? candidate.sentenceStart, candidate.sentenceStart, candidate.sentenceEnd);
  let endIndex = clampIndex(options.trimEndSentence ?? candidate.sentenceEnd, startIndex, candidate.sentenceEnd);

  const startEntry = entries[startIndex];
  const endEntry = entries[endIndex];
  if (!startEntry || !endEntry) return null;

  // 1. Snap to word edges.
  let startUs = startEntry.words[0].startUs;
  let endUs = endEntry.words[endEntry.words.length - 1].endUs;

  // 2. Breathing room, bounded by the neighbouring words.
  const beforeGap = startUs - (entries[startIndex - 1]?.endUs ?? startUs);
  startUs = Math.max(0, startUs - Math.min(PRE_ROLL_US, Math.max(0, beforeGap)));

  const afterGap = (entries[endIndex + 1]?.startUs ?? endUs) - endUs;
  endUs = endUs + Math.min(POST_ROLL_US, Math.max(0, afterGap));

  // 3. Prefer an end that lands after a real pause.
  const pauseCandidates = entries
    .slice(Math.max(startIndex, endIndex - 2), endIndex + 1)
    .filter((entry) => entry.pausesBeforeUs >= 300_000);
  if (pauseCandidates.length > 0) {
    const lastPause = pauseCandidates[pauseCandidates.length - 1];
    if (lastPause.endUs <= endUs && endUs - lastPause.endUs <= 1_500_000) {
      endUs = Math.min(endUs, lastPause.endUs + POST_ROLL_US);
    }
  }

  // 4. Standalone repair: widen the start backwards while under the maximum.
  let extended = false;
  const maxUs = settings.targetMaxSec * 1.2 * 1_000_000;
  if (options.needsContext && candidate.features.standaloneRisk > 0.4) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const previous = entries[startIndex - 1];
      if (!previous) break;
      const candidateStart = previous.words[0].startUs;
      if (endUs - candidateStart > maxUs) break;
      startIndex -= 1;
      startUs = candidateStart;
      extended = true;
    }
  }

  const durationUs = endUs - startUs;

  // 5. Length gate.
  const minUs = settings.targetMinSec * 0.8 * 0.8 * 1_000_000;
  const hardMaxUs = maxUs * 1.1;
  if (durationUs < minUs || durationUs > hardMaxUs) return null;

  return { startUs, endUs, durationUs, sentenceStart: startIndex, sentenceEnd: endIndex, extended };
}

function clampIndex(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** SPEC 07 §4.6 — 5-word shingle Jaccard similarity. */
export function shingleSimilarity(a: string, b: string): number {
  const shinglesA = shingles(a);
  const shinglesB = shingles(b);
  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;

  let intersection = 0;
  for (const shingle of shinglesA) {
    if (shinglesB.has(shingle)) intersection++;
  }
  const union = shinglesA.size + shinglesB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set<string>();
  if (words.length < 5) {
    if (words.length > 0) set.add(words.join(' '));
    return set;
  }
  for (let i = 0; i + 5 <= words.length; i++) {
    set.add(words.slice(i, i + 5).join(' '));
  }
  return set;
}

export function overlapFraction(
  a: { startUs: number; endUs: number; durationUs: number },
  b: { startUs: number; endUs: number; durationUs: number }
): number {
  const overlapUs = Math.min(a.endUs, b.endUs) - Math.max(a.startUs, b.startUs);
  if (overlapUs <= 0) return 0;
  const shorter = Math.min(a.durationUs, b.durationUs);
  return shorter <= 0 ? 0 : overlapUs / shorter;
}
