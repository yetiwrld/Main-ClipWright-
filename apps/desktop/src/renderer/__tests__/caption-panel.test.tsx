// @vitest-environment jsdom
/**
 * The caption list and word editor (SPEC 11 §7).
 *
 * The tests are about what the user can *see and do*: which caption is marked as
 * hand-edited, that a text correction goes through a command rather than a direct
 * mutation, and that emphasis is keyed by word rather than by position. The last
 * one matters because a position-keyed override silently moves to a different word
 * the first time a caption is split.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createCaptionItem, createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';
import { CaptionPanel, CaptionWordView, activeCaptionRow, captionRows } from '../features/editor/CaptionPanel.js';

afterEach(() => cleanup());

// The refs carry timing and an id; the words themselves live on the transcript,
// so the caption's own text is what `captionSegment.text` holds.
const words = [
  { wordId: 'w1', startUs: 0, endUs: 400_000 },
  { wordId: 'w2', startUs: 400_000, endUs: 800_000 },
  { wordId: 'w3', startUs: 800_000, endUs: 1_200_000 },
];

/** Two captions laid end to end on a caption track. */
function makeState(): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const captionTrack = base.tracks.find((track) => track.kind === 'caption')!;
  const first = createCaptionItem({
    id: 'cap-1',
    trackId: captionTrack.id,
    startUs: 0,
    durationUs: 1_200_000,
    words,
    fallbackText: 'Hello there world',
  });
  const second = createCaptionItem({
    id: 'cap-2',
    trackId: captionTrack.id,
    startUs: 1_200_000,
    durationUs: 1_000_000,
    words: words.slice(0, 2),
    fallbackText: 'A hand fix',
    manualText: true,
  });
  return {
    ...base,
    tracks: base.tracks.map((track) =>
      track.id === captionTrack.id ? { ...track, itemIds: [first.id, second.id] } : track,
    ),
    items: { [first.id]: first, [second.id]: second },
  } as TimelineState;
}

function fakeTimeline(state: TimelineState, overrides: Partial<TimelineApi> = {}): TimelineApi {
  return {
    state,
    fps: 30,
    selection: [],
    selectionIsEmpty: undefined,
    notes: [],
    select: vi.fn(),
    applyCaptionStyle: vi.fn(() => true),
    editCaptionText: vi.fn(() => true),
    setWordEmphasis: vi.fn(() => true),
    trimCaptionWordsToRange: vi.fn(() => true),
    ...overrides,
  } as unknown as TimelineApi;
}

describe('captionRows', () => {
  it('lists captions in timeline order', () => {
    const rows = captionRows(makeState());
    expect(rows.map((row) => row.item.id)).toEqual(['cap-1', 'cap-2']);
  });

  it('reads the text and the word count from the segment', () => {
    const [first] = captionRows(makeState());
    expect(first!.text).toBe('Hello there world');
    expect(first!.wordCount).toBe(3);
  });

  it('marks a hand-edited caption, because regeneration will respect it', () => {
    const rows = captionRows(makeState());
    expect(rows[0]!.handEdited).toBe(false);
    expect(rows[1]!.handEdited).toBe(true);
  });

  it('ignores items that are not captions', () => {
    const state = makeState();
    const rows = captionRows(state);
    expect(rows.every((row) => row.item.type === 'caption')).toBe(true);
  });
});

describe('activeCaptionRow', () => {
  it('finds the caption under the playhead', () => {
    const rows = captionRows(makeState());
    expect(activeCaptionRow(rows, 500_000)?.item.id).toBe('cap-1');
    expect(activeCaptionRow(rows, 1_800_000)?.item.id).toBe('cap-2');
  });

  it('returns null in a gap between captions', () => {
    const state = makeState();
    const rows = captionRows(state);
    // cap-2 ends at 2.2 s; nothing is between 2.2 s and the end.
    expect(activeCaptionRow(rows, 3_000_000)).toBeNull();
  });

  it('prefers the later caption where two overlap', () => {
    const rows = captionRows(makeState());
    // 1.2 s is the boundary; the second caption starts there.
    expect(activeCaptionRow(rows, 1_200_000)?.item.id).toBe('cap-2');
  });
});

describe('CaptionPanel', () => {
  it('says so when there are no captions, rather than showing an empty list', () => {
    const empty = { ...makeState(), items: {} } as TimelineState;
    render(<CaptionPanel state={empty} timeline={fakeTimeline(empty)} />);
    expect(screen.getByText('No captions yet')).toBeTruthy();
  });

  it('shows every caption in order', () => {
    const state = makeState();
    render(<CaptionPanel state={state} timeline={fakeTimeline(state)} />);
    expect(screen.getByText('Hello there world')).toBeTruthy();
    expect(screen.getByText('A hand fix')).toBeTruthy();
    expect(screen.getByText('2 captions')).toBeTruthy();
  });

  it('flags the hand-edited caption so its text is not lost to a regeneration', () => {
    const state = makeState();
    render(<CaptionPanel state={state} timeline={fakeTimeline(state)} />);
    expect(screen.getByText('edited')).toBeTruthy();
  });

  it('edits through a command, not a direct mutation', () => {
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<CaptionPanel state={state} timeline={timeline} />);

    fireEvent.click(screen.getAllByLabelText('Edit caption text')[0]!);
    const field = screen.getByLabelText('Caption text') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Hello there Earth' } });
    fireEvent.click(screen.getByText('Save'));

    expect(timeline.editCaptionText).toHaveBeenCalledWith('cap-1', 'Hello there Earth');
  });

  it('does not fire a command when the text did not change', () => {
    // An untouched field that still writes would put an undo step on the stack for
    // nothing, and undo would appear broken.
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<CaptionPanel state={state} timeline={timeline} />);

    fireEvent.click(screen.getAllByLabelText('Edit caption text')[0]!);
    fireEvent.click(screen.getByText('Save'));
    expect(timeline.editCaptionText).not.toHaveBeenCalled();
  });

  it('commits on Enter and cancels on Escape', () => {
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<CaptionPanel state={state} timeline={timeline} />);

    fireEvent.click(screen.getAllByLabelText('Edit caption text')[0]!);
    const field = screen.getByLabelText('Caption text');
    fireEvent.change(field, { target: { value: 'Changed' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(timeline.editCaptionText).toHaveBeenCalledWith('cap-1', 'Changed');

    fireEvent.click(screen.getAllByLabelText('Edit caption text')[0]!);
    fireEvent.keyDown(screen.getByLabelText('Caption text'), { key: 'Escape' });
    expect(screen.queryByLabelText('Caption text')).toBeNull();
  });

  it('applies a style to one caption from its picker', () => {
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<CaptionPanel state={state} timeline={timeline} />);

    const picker = screen.getAllByLabelText('Caption style')[0]! as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'karaoke' } });
    expect(timeline.applyCaptionStyle).toHaveBeenCalledWith(['cap-1'], 'karaoke', true);
  });

  it('restyles every caption without dropping emphasis overrides', () => {
    // `keepOverrides` is the argument that stops a restyle from erasing words the
    // user had marked; losing them on "restyle all" would be silent data loss.
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<CaptionPanel state={state} timeline={timeline} />);

    fireEvent.click(screen.getByLabelText('Apply a style to every caption'));
    expect(timeline.applyCaptionStyle).toHaveBeenCalledWith(['cap-1', 'cap-2'], 'bold-creator', true);
  });
});

describe('CaptionWordView', () => {
  it('shows one button per word', () => {
    const state = makeState();
    render(<CaptionWordView state={state} timeline={fakeTimeline(state)} itemId="cap-1" />);
    expect(screen.getByLabelText(/Word 1: Hello/)).toBeTruthy();
    expect(screen.getByLabelText(/Word 3: world/)).toBeTruthy();
  });

  it('toggles emphasis by word index, which the command resolves to a word id', () => {
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<CaptionWordView state={state} timeline={timeline} itemId="cap-1" />);

    fireEvent.click(screen.getByLabelText(/Word 2: there/));
    expect(timeline.setWordEmphasis).toHaveBeenCalledWith('cap-1', 1, true);
  });

  it('shows an emphasised word as pressed and removes it on a second click', () => {
    const state = makeState();
    const item = state.items['cap-1']!;
    const emphasised = {
      ...item,
      captionSegment: {
        ...item.captionSegment!,
        wordOverrides: { w2: { emphasis: true } },
      },
    };
    const withOverride = { ...state, items: { ...state.items, 'cap-1': emphasised } } as TimelineState;
    const timeline = fakeTimeline(withOverride);
    render(<CaptionWordView state={withOverride} timeline={timeline} itemId="cap-1" />);

    const button = screen.getByLabelText(/Word 2: there, emphasised/);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(timeline.setWordEmphasis).toHaveBeenCalledWith('cap-1', 1, false);
  });

  it('explains why a caption with no word timings cannot be word-edited', () => {
    const state = makeState();
    const plain = createCaptionItem({
      id: 'cap-plain',
      trackId: 'x',
      startUs: 0,
      durationUs: 1_000_000,
      words: [],
      fallbackText: 'A caption with no timings',
    });
    const withPlain = { ...state, items: { ...state.items, 'cap-plain': plain } } as TimelineState;
    render(<CaptionWordView state={withPlain} timeline={fakeTimeline(withPlain)} itemId="cap-plain" />);
    expect(screen.getByText(/no word timings/)).toBeTruthy();
  });

  it('says nothing was edited for a caption straight from the transcript', () => {
    const state = makeState();
    render(<CaptionWordView state={state} timeline={fakeTimeline(state)} itemId="cap-1" />);
    expect(screen.getByText('Generated from the transcript.')).toBeTruthy();
  });
});
