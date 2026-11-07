/**
 * SPEC 07 §13 — Small, hand-written transcripts used by the moments tests.
 *
 * Each fixture is deterministic: the same words at the same timings. The
 * `goodMoments` labels are the seconds a human would pick, written by hand so
 * the tests never grade the scorer against itself.
 */

import type { Sentence, Word } from '../../transcription/index.js';

export interface FixtureSentence {
  text: string;
  startSec: number;
  endSec: number;
  pauseAfterSec?: number;
}

export interface TranscriptFixture {
  name: string;
  sentences: FixtureSentence[];
  /** [startSec, endSec] ranges a human marked as genuinely good clips. */
  goodMoments: Array<[number, number]>;
}

export const PODCAST_FIXTURE: TranscriptFixture = {
  name: 'podcast',
  sentences: [
    { text: 'Most people think motivation comes before action.', startSec: 0, endSec: 3.2 },
    { text: 'That is exactly backwards.', startSec: 3.6, endSec: 5.1 },
    { text: 'When you wait to feel ready, you wait forever.', startSec: 5.5, endSec: 8.4 },
    { text: 'So I started doing one small thing every morning before I checked my phone.', startSec: 9.1, endSec: 14.2 },
    { text: 'The first week was terrible.', startSec: 14.8, endSec: 16.4 },
    { text: 'I hated it and I almost quit on day four.', startSec: 16.9, endSec: 20.1 },
    { text: 'But by the third week something strange happened.', startSec: 20.9, endSec: 24.2 },
    { text: 'I stopped negotiating with myself.', startSec: 24.8, endSec: 27.0 },
    { text: 'That is the whole trick.', startSec: 27.5, endSec: 29.2 },
    { text: 'Now let me talk about how we structure our sponsorship reads.', startSec: 31.0, endSec: 35.4 },
    { text: 'We keep them to forty seconds and read them ourselves.', startSec: 35.9, endSec: 39.8 },
    { text: 'Which brings me to the question everyone asks me.', startSec: 41.0, endSec: 44.3 },
    { text: 'How do you find guests who will actually say something interesting?', startSec: 44.8, endSec: 49.6 },
    { text: 'I stopped asking for impressive people and started asking for specific people.', startSec: 50.4, endSec: 56.2 },
    { text: 'Specific people tell you what actually happened.', startSec: 56.8, endSec: 60.1 },
    { text: 'Impressive people tell you what they wish had happened.', startSec: 60.6, endSec: 64.4 },
  ],
  goodMoments: [
    [0, 29.2],
    [44.8, 64.4],
  ],
};

export const TUTORIAL_FIXTURE: TranscriptFixture = {
  name: 'tutorial',
  sentences: [
    { text: 'Today I am going to show you how to colour grade a video in four steps.', startSec: 0, endSec: 4.8 },
    { text: 'Step one is setting your exposure correctly before anything else.', startSec: 5.4, endSec: 9.9 },
    { text: 'If your exposure is wrong, no amount of colour work will fix it.', startSec: 10.4, endSec: 14.8 },
    { text: 'Step two is white balance.', startSec: 15.4, endSec: 17.2 },
    { text: 'Pick a neutral point in the shot and sample it.', startSec: 17.8, endSec: 21.0 },
    { text: 'Step three is contrast, and this is where most people overdo it.', startSec: 21.8, endSec: 26.4 },
    { text: 'Push the shadows down a little and stop.', startSec: 27.0, endSec: 30.2 },
    { text: 'Step four is the look.', startSec: 30.8, endSec: 32.6 },
    { text: 'Use a LUT at a third of its strength and then adjust.', startSec: 33.2, endSec: 37.4 },
    { text: 'If you follow those four steps in order, your footage will look consistent every time.', startSec: 38.2, endSec: 44.1 },
    { text: 'Thanks for watching and subscribe if you want the project file.', startSec: 45.0, endSec: 49.2 },
  ],
  goodMoments: [
    [0, 14.8],
    [21.8, 37.4],
  ],
};

export const VLOG_FIXTURE: TranscriptFixture = {
  name: 'vlog',
  sentences: [
    { text: 'Okay so this morning did not go how I planned at all.', startSec: 0, endSec: 3.9 },
    { text: 'I woke up at six to film the sunrise and my camera battery was dead.', startSec: 4.4, endSec: 9.8 },
    { text: 'Completely flat.', startSec: 10.2, endSec: 11.1 },
    { text: 'So I grabbed the spare and drove to the hill anyway.', startSec: 11.8, endSec: 15.9 },
    { text: 'And I got there thirty seconds after the sun cleared the ridge.', startSec: 16.4, endSec: 21.2 },
    { text: 'Thirty seconds.', startSec: 21.6, endSec: 22.7 },
    { text: 'But the light afterwards was honestly better than the sunrise itself.', startSec: 23.4, endSec: 28.9 },
    { text: 'Here is what it looked like.', startSec: 29.3, endSec: 31.0 },
    { text: 'So the lesson is simple.', startSec: 32.0, endSec: 33.9 },
    { text: 'Plan less and leave earlier.', startSec: 34.4, endSec: 36.6 },
    { text: 'Anyway, tomorrow I am going to try the lake instead.', startSec: 37.4, endSec: 41.2 },
  ],
  goodMoments: [
    [0, 11.1],
    [23.4, 36.6],
  ],
};

export const ALL_FIXTURES = [PODCAST_FIXTURE, TUTORIAL_FIXTURE, VLOG_FIXTURE];

/** Expands a fixture into the Word/Sentence structures the pipeline consumes. */
export function toTranscript(fixture: TranscriptFixture): {
  words: Word[];
  sentences: Sentence[];
  paragraphStarts: Set<number>;
} {
  const words: Word[] = [];
  const sentences: Sentence[] = [];
  const paragraphStarts = new Set<number>();

  fixture.sentences.forEach((sentence, sentenceIndex) => {
    const tokens = sentence.text.split(/\s+/).filter(Boolean);
    const span = sentence.endSec - sentence.startSec;
    const per = span / Math.max(tokens.length, 1);

    const wordIds: string[] = [];
    tokens.forEach((token, i) => {
      const id = `w_${sentenceIndex}_${i}`;
      wordIds.push(id);
      words.push({
        id,
        text: token,
        startUs: Math.round((sentence.startSec + i * per) * 1_000_000),
        endUs: Math.round((sentence.startSec + (i + 1) * per) * 1_000_000),
        confidence: 0.92,
        edited: false,
        approximate: false,
        lowConfidence: false,
        filler: false,
        chunkIndex: 0,
      });
    });

    sentences.push({
      id: `sent_${sentenceIndex}`,
      wordIds,
      startUs: Math.round(sentence.startSec * 1_000_000),
      endUs: Math.round(sentence.endSec * 1_000_000),
    });

    // A pause of ≥ 0.6 s marks a paragraph start, mirroring real speech.
    if (sentenceIndex > 0) {
      const previous = fixture.sentences[sentenceIndex - 1];
      if (sentence.startSec - previous.endSec >= 0.6) paragraphStarts.add(sentenceIndex);
    } else {
      paragraphStarts.add(0);
    }
  });

  return { words, sentences, paragraphStarts };
}
