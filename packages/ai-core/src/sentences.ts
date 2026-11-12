/** Sentence segmentation over word-level transcripts. Pure and testable. */
import type { TranscriptWord } from '@clipwright/project-schema';

export interface Sentence {
  index: number;
  startUs: number;
  endUs: number;
  wordIndexes: [number, number]; // inclusive range into the words array
  text: string;
}

const TERMINAL = /[.!?。！？]["')\]]?$/;

export const segmentSentences = (words: TranscriptWord[]): Sentence[] => {
  const sentences: Sentence[] = [];
  let startWord = 0;
  for (let i = 0; i < words.length; i++) {
    const text = words[i]!.text.trim();
    if (TERMINAL.test(text) || i === words.length - 1) {
      const slice = words.slice(startWord, i + 1);
      sentences.push({
        index: sentences.length,
        startUs: slice[0]!.startUs,
        endUs: slice[slice.length - 1]!.endUs,
        wordIndexes: [startWord, i],
        text: slice.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'),
      });
      startWord = i + 1;
    }
  }
  return sentences;
};

export const wordsInRange = (words: TranscriptWord[], startUs: number, endUs: number): TranscriptWord[] =>
  words.filter((w) => w.endUs > startUs && w.startUs < endUs);

/** Pause before a word (gap to the previous word). */
export const pauseBefore = (words: TranscriptWord[], index: number): number => {
  if (index <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, words[index]!.startUs - words[index - 1]!.endUs);
};
