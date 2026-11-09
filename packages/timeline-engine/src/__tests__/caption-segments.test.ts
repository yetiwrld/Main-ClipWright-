import { describe, expect, it } from 'vitest';
import {
  captionTrackId,
  segmentTranscript,
  transcriptWords,
  type TranscriptWord,
} from '../caption-segments.js';

/**
 * SPEC 11 §9 — the grouping that both caption commands were missing a caller for.
 *
 * These are the decisions, not the plumbing: which words become one card, and what
 * happens at the edges where the source data is degenerate.
 */

const word = (text: string, startMs: number, endMs: number, id = text): TranscriptWord => ({
  id,
  text,
  startUs: startMs * 1000,
  endUs: endMs * 1000,
});

describe('grouping a transcript into captions (SPEC 11 §9)', () => {
  it('ends a caption at a sentence boundary the transcript supplies', () => {
    /*
      The word list cannot say where a sentence ended; the transcript can. Grouping on
      durations alone puts two sentences on one card, which is the single most obvious
      way generated captions look machine-made.
    */
    const words = [word('Hello', 0, 400), word('there.', 400, 900), word('How', 900, 1200), word('are', 1200, 1400), word('you?', 1400, 1800)];
    const segments = segmentTranscript(words, { sentenceEndWordIds: new Set(['there.', 'you?']) });
    expect(segments.map((segment) => segment.text)).toEqual(['Hello there.', 'How are you?']);
    expect(segments[0]!.startUs).toBe(0);
    expect(segments[1]!.startUs).toBe(900_000);
  });

  it('breaks a long run with no sentence ends at the word cap', () => {
    // Unpunctuated speech (an auto-transcript, or a language without full stops) would
    // otherwise become one caption the length of the clip.
    const words = Array.from({ length: 10 }, (_, index) => word(`w${index}`, index * 300, (index + 1) * 300));
    const segments = segmentTranscript(words, { maxWords: 4 });
    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.words.length)).toEqual([4, 4, 2]);
  });

  it('breaks at the duration cap even when a sentence is still running', () => {
    /*
      A nine-second sentence still has to be split: a caption that outruns its card is
      unreadable on screen, and the spec's own limit is about legibility rather than about
      punctuation.
    */
    const words = [word('one', 0, 2000), word('two', 2000, 4000), word('three', 4000, 6000), word('four', 6000, 9000)];
    const segments = segmentTranscript(words, { maxDurationUs: 5_000_000, maxWords: 99 });
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('one two three');
    expect(segments[1]!.text).toBe('four');
  });

  it('produces contiguous, non-overlapping segments', () => {
    /*
      Overlap is illegal on a caption track (SPEC 11 §3), so the grouping has to be
      correct by construction rather than repaired afterwards. Every word lands in exactly
      one segment, in order, and each starts at or after the previous one ended.
    */
    const words = Array.from({ length: 9 }, (_, index) => word(`w${index}`, index * 250, (index + 1) * 250));
    const segments = segmentTranscript(words);
    expect(segments.flatMap((segment) => segment.words.map((entry) => entry.text))).toEqual(
      words.map((entry) => entry.text),
    );
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.startUs).toBeGreaterThanOrEqual(segments[index - 1]!.endUs);
    }
  });

  it('keeps a word with a backwards span instead of dropping it', () => {
    // A caption that silently loses a word is worse than one whose timing is tight; the
    // text is still part of what was said, and the export would read a negative duration.
    const words = [word('before', 0, 500), { id: 'bad', text: 'after', startUs: 900_000, endUs: 400_000 }];
    const segments = segmentTranscript(words, { maxWords: 99 });
    expect(segments[0]!.text).toBe('before after');
    expect(segments[0]!.endUs).toBeGreaterThan(segments[0]!.startUs);
    expect(segments[0]!.words[1]!.endUs).toBeGreaterThan(segments[0]!.words[1]!.startUs);
  });

  it('never emits a segment whose end precedes its own start', () => {
    /*
      A transcript can carry a word whose `endUs` predates the first word of its group —
      a re-timed word, or a hand-edited file. `regenerateCaptions` would pass that to the
      timeline as a negative duration, and the track refuses it: one bad word would make
      the whole regeneration fail rather than producing a slightly tight caption.
    */
    const words = [
      word('first', 1_000, 1_400),
      { id: 'early', text: 'early', startUs: 1_400_000, endUs: 900_000 },
    ];
    const segments = segmentTranscript(words, { maxWords: 99 });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.endUs).toBeGreaterThan(segments[0]!.startUs);
  });

  it('drops whitespace-only entries rather than emitting a blank caption', () => {
    const words = [word('one', 0, 300), { id: 'gap', text: '   ', startUs: 300_000, endUs: 600_000 }, word('two', 600, 900)];
    const segments = segmentTranscript(words, { maxWords: 99 });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe('one two');
  });

  it('returns nothing for an empty transcript', () => {
    // The panel asks on every render, before a transcription has run.
    expect(segmentTranscript([])).toEqual([]);
  });

  it('gives every word an id, synthesising one where the transcript has none', () => {
    /*
      The emphasis feature addresses words by id (SPEC 11 §2). A transcript that predates
      ids — or a test fixture written by hand — would otherwise produce captions whose
      words cannot be emphasised or keyframed at all.
    */
    const words = [{ text: 'no', startUs: 0, endUs: 300_000 }, { text: 'ids', startUs: 300_000, endUs: 600_000 }];
    const segments = segmentTranscript(words, { maxWords: 99 });
    expect(segments[0]!.words.every((entry) => entry.id.length > 0)).toBe(true);
    expect(new Set(segments[0]!.words.map((entry) => entry.id)).size).toBe(2);
  });
});

describe('reading a transcript into command input (SPEC 11 §9)', () => {
  it('trims text and keeps ids and confidence', () => {
    const words = transcriptWords({
      words: [{ id: 'a', text: ' hi ', startUs: 0, endUs: 200_000, confidence: 0.9 }],
    });
    expect(words).toEqual([{ id: 'a', text: 'hi', startUs: 0, endUs: 200_000, confidence: 0.9 }]);
  });

  it('is empty for a missing transcript rather than throwing', () => {
    // The renderer asks before the transcript has loaded.
    expect(transcriptWords(null)).toEqual([]);
    expect(transcriptWords(undefined)).toEqual([]);
  });

  it('repairs a zero-width word instead of passing it to the command', () => {
    // The engine refuses a caption shorter than a frame, so a degenerate word here would
    // turn into a whole regeneration failing.
    const words = transcriptWords({ words: [{ text: 'x', startUs: 500_000, endUs: 500_000 }] });
    expect(words[0]!.endUs).toBeGreaterThan(words[0]!.startUs);
  });
});

describe('finding the caption track', () => {
  it('finds the track by kind', () => {
    expect(captionTrackId([{ id: 'v', kind: 'video' }, { id: 'c', kind: 'caption' }])).toBe('c');
  });

  it('finds the track by role when the kind is absent', () => {
    // Older documents, and the schema's own `role` vocabulary.
    expect(captionTrackId([{ id: 'v', role: 'main' }, { id: 'c', role: 'captions' }])).toBe('c');
  });

  it('is null when there is none, rather than inventing one', () => {
    /*
      The caller reports this. Creating a track here would put captions on a second track
      in any project that already had one hidden behind a different name.
    */
    expect(captionTrackId([{ id: 'v', kind: 'video' }])).toBeNull();
    expect(captionTrackId([])).toBeNull();
  });
});
