// @vitest-environment jsdom
/**
 * The transcript editor's export button (SPEC 05 §9).
 *
 * The editor had no test. The bug it was carrying: `handleExport` passed the literal `'16:9'` as
 * the aspect, and that argument decides how SRT and WebVTT cues are line-wrapped — `exportTranscript`
 * calls `buildCaptions(words, aspect)`. So every project exported subtitles wrapped for a landscape
 * frame, including the 9:16 portrait projects that are the default for a new project and the shape
 * this app is built around.
 *
 * The wrapping is not cosmetic. A cue that fits a 1080-wide landscape frame in two lines needs three
 * in a 1080-wide portrait frame, and a file wrapped for the wrong shape shows the wrong break in
 * every player that renders it.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TranscriptEditor } from '../components/TranscriptEditor.js';
import type { TranscriptPayload } from '../global.js';

const calls: Array<{ format: string; aspect: string; defaultName: string }> = [];

vi.mock('../api.js', () => ({
  api: {
    async exportTranscript(
      _transcript: unknown,
      format: string,
      aspect: string,
      defaultName: string,
    ) {
      calls.push({ format, aspect, defaultName });
      return '/tmp/out.srt';
    },
  },
  describeError: (err: unknown) => String(err),
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
});

function transcript(): TranscriptPayload {
  const words = Array.from({ length: 6 }, (_, index) => ({
    id: `w${index}`,
    text: `word${index}`,
    startUs: index * 300_000,
    endUs: index * 300_000 + 250_000,
  }));
  return {
    id: 'tr_1',
    mediaId: 'med_1',
    language: 'en',
    words,
    sentences: [
      {
        id: 's1',
        startUs: 0,
        endUs: 1_750_000,
        text: words.map((w) => w.text).join(' '),
        /* The editor resolves each sentence's words through these ids, so a fixture without them
           renders nothing and would have made the render-time errors look like a component bug. */
        wordIds: words.map((w) => w.id),
      },
    ],
    paragraphs: [{ id: 'p1', sentenceIds: ['s1'] }],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as TranscriptPayload;
}

describe('the transcript export carries the composition’s aspect ratio', () => {
  it('sends the aspect it was given, not a hardcoded 16:9', async () => {
    /*
      The assertion that would have caught it. `'16:9'` used to be in the call; the prop is what
      the page passes and the page has the project's own `settings.aspect`.
    */
    render(<TranscriptEditor transcript={transcript()} aspect="9:16" />);
    fireEvent.click(screen.getByTitle('Export as SRT'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.aspect).toBe('9:16');
    expect(calls[0]!.format).toBe('srt');
  });

  it('passes each of the four formats the spec names', async () => {
    /* §9's menu is TXT, SRT, VTT, JSON; all four are buttons and all four reach the bridge. */
    render(<TranscriptEditor transcript={transcript()} aspect="9:16" />);
    for (const format of ['TXT', 'SRT', 'VTT', 'JSON']) {
      fireEvent.click(screen.getByTitle(`Export as ${format}`));
      await waitFor(() => expect(calls.at(-1)?.format).toBe(format.toLowerCase()));
    }
    expect(calls.map((call) => call.format)).toEqual(['txt', 'srt', 'vtt', 'json']);
  });

  it('falls back to 16:9 only when no aspect is supplied', async () => {
    /*
      The default is the old hardcoded value, which is honest for a caller that has no project —
      the editor is also usable on a transcript with no composition. What must not happen is the
      default being used when the page *did* pass one, and the test above covers that.
    */
    render(<TranscriptEditor transcript={transcript()} />);
    fireEvent.click(screen.getByTitle('Export as VTT'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.aspect).toBe('16:9');
  });

  it('names the file after the format, so a .vtt is not saved as .srt', async () => {
    render(<TranscriptEditor transcript={transcript()} aspect="9:16" />);
    fireEvent.click(screen.getByTitle('Export as VTT'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.defaultName).toBe('transcript.vtt');
  });
});
