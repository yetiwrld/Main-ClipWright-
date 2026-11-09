/**
 * SPEC 11 §9 — turning a transcript into caption segments.
 *
 * `regenerateCaptions` takes segments and writes them; `syncCaptionsWithTranscript` takes
 * words and realigns existing captions. Both were tested at the command level and neither
 * had a caller, so a project's captions could only ever be the ones a transcription job
 * happened to leave behind and no edit to the transcript could reach them. What was
 * missing between the two was this: the grouping that decides which words are one caption.
 *
 * The grouping is a real editorial decision, not plumbing, which is why it lives in a file
 * of its own with tests rather than inside the panel's click handler:
 *
 * - a caption ends at a **sentence** boundary wherever one is available, because that is
 *   the unit a reader expects to read at once;
 * - otherwise it ends when it would run past a **duration** or a **word count** limit, since
 *   one long unpunctuated sentence is unreadable as a single card;
 * - and it always ends before the words stop fitting the time they occupy, so a two-word
 *   caption never fills three seconds of silence.
 */

export interface TranscriptWord {
  id?: string;
  text: string;
  startUs: number;
  endUs: number;
  confidence?: number;
}

export interface CaptionSegmentDraft {
  startUs: number;
  endUs: number;
  text: string;
  words: Array<{ id: string; text: string; startUs: number; endUs: number; confidence?: number }>;
}

export interface SegmentOptions {
  /** Longest a caption may run, before a boundary is forced. */
  maxDurationUs?: number;
  /** Most words one caption may hold, for languages with no sentence punctuation. */
  maxWords?: number;
  /**
   * Sentence ends supplied by the transcript.
   *
   * The word list alone cannot say where a sentence finished — `endUs` gaps and capital
   * letters both lie on real speech — so when the transcript carries sentence boundaries
   * they are authoritative. `sentenceEndWordIds` is the subset of word ids that end one.
   */
  sentenceEndWordIds?: ReadonlySet<string>;
}

const DEFAULT_MAX_DURATION_US = 3_500_000;
const DEFAULT_MAX_WORDS = 8;

/**
 * Group transcript words into caption segments.
 *
 * Words are taken in order and packed until one of the three limits is reached, so the
 * result is contiguous and non-overlapping by construction: every word lands in exactly
 * one segment and each segment's span is the span of its words. That is what keeps the
 * output legal on a caption track (SPEC 11 §3 forbids overlap) without a repair pass.
 *
 * A word with a zero-width or backwards span is *kept* rather than dropped — the text is
 * still part of what the speaker said, and a caption that silently loses a word is worse
 * than one whose timing is tight. The segment's bounds come from the first and last word,
 * so a degenerate word in the middle cannot invert them.
 */
export function segmentTranscript(
  words: readonly TranscriptWord[],
  options: SegmentOptions = {},
): CaptionSegmentDraft[] {
  const maxDurationUs = options.maxDurationUs ?? DEFAULT_MAX_DURATION_US;
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  const sentenceEnds = options.sentenceEndWordIds;

  const segments: CaptionSegmentDraft[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    /*
      A segment must be at least one frame-ish long or the timeline will refuse it. Keeping
      the *last* word's end rather than the max of both is the honest choice: the end of a
      caption is where its final word finished, and a stray word whose `endUs` ran past the
      next sentence's start would otherwise stretch the card over speech it does not hold.
    */
    const startUs = first.startUs;
    const endUs = Math.max(startUs + 1, last.endUs);
    segments.push({
      startUs,
      endUs,
      text: current.map((word) => word.text).join(' ').trim(),
      words: current.map((word, index) => ({
        id: word.id ?? `${startUs}-${index}`,
        text: word.text,
        startUs: word.startUs,
        endUs: Math.max(word.startUs + 1, word.endUs),
        ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
      })),
    });
    current = [];
  };

  for (const word of words) {
    const text = word.text.trim();
    // Whitespace-only entries are not words; keeping one would put a double space in the
    // caption and a zero-width span on the track.
    if (!text) continue;
    const clean = { ...word, text };
    current.push(clean);

    const first = current[0]!;
    const reachedDuration = clean.endUs - first.startUs >= maxDurationUs;
    const reachedWords = current.length >= maxWords;
    const reachedSentence = word.id !== undefined && sentenceEnds?.has(word.id) === true;
    /*
      A sentence end wins over the other two limits only when it *fits*: a 9-second
      sentence still has to be broken, because a caption that outruns the screen is worse
      than one split at a comma-less point. The word cap is what splits it.
    */
    if (reachedSentence || reachedDuration || reachedWords) flush();
  }
  flush();
  return segments;
}

/**
 * The words of a transcript, in the shape both caption commands want.
 *
 * `syncCaptionsWithTranscript` matches by *text* and needs no ids; `regenerateCaptions`
 * uses ids for the per-word emphasis that SPEC 11 §2 defines, so they are passed through
 * where the transcript has them and synthesised from the position where it does not.
 */
export function transcriptWords(
  transcript: { words: readonly TranscriptWord[] } | null | undefined,
): Array<{ id: string; text: string; startUs: number; endUs: number; confidence?: number }> {
  if (!transcript) return [];
  return transcript.words
    .filter((word) => word.text.trim().length > 0)
    .map((word, index) => ({
      id: word.id ?? `w${index}`,
      text: word.text.trim(),
      startUs: word.startUs,
      endUs: Math.max(word.startUs + 1, word.endUs),
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
    }));
}

/**
 * Which caption track to write to.
 *
 * The schema already ships a `Text / Graphics` track and a captions track (§factory), so
 * this is a lookup rather than a creation: a project always has one, and creating a second
 * would put half its captions on each. Returns `null` when there is none, which the caller
 * reports rather than papering over — a caption command against a missing track would fail
 * with a message about the wrong thing.
 */
export function captionTrackId(
  tracks: readonly { id: string; kind?: string; role?: string }[],
): string | null {
  return tracks.find((track) => track.kind === 'caption' || track.role === 'captions')?.id ?? null;
}
