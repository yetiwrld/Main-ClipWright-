// @vitest-environment jsdom
/**
 * Which style the style editor opens on.
 *
 * Small function, but getting it wrong edits a style the user is not looking at:
 * they select a caption, open the editor, change the fill, and the change lands on
 * whichever caption happens to be first in the timeline. So: selection first, then
 * whatever is under the playhead, then nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCaptionItem, createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import { editingStyleId } from '../features/editor/EditorPage.js';
import { playheadStore } from '../features/editor/playhead-store.js';

let state: TimelineState;

const words = [{ wordId: 'w1', startUs: 0, endUs: 400_000 }];

/** Captions are built against the default timeline's caption track. */
function caption(id: string, startUs: number, durationUs: number, captionStyleId: string) {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const trackId = base.tracks.find((track) => track.kind === 'caption')!.id;
  return {
    ...createCaptionItem({ id, trackId, startUs, durationUs, words, fallbackText: 'Hi' }),
    captionStyleId,
  };
}

function withItems(items: ReturnType<typeof caption>[]): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  return {
    ...base,
    tracks: base.tracks.map((track) =>
      track.kind === 'caption' ? { ...track, itemIds: items.map((item) => item.id) } : track,
    ),
    items: Object.fromEntries(items.map((item) => [item.id, item])),
  } as TimelineState;
}

beforeEach(() => {
  state = withItems([caption('cap-1', 0, 1_000_000, 'bold-creator'), caption('cap-2', 2_000_000, 1_000_000, 'karaoke')]);
  playheadStore.set(0);
});

afterEach(() => playheadStore.set(0));

const captionIds = () => Object.keys(state.items);

describe('editingStyleId', () => {
  it('returns nothing without a timeline', () => {
    expect(editingStyleId(null, [])).toBeNull();
  });

  it('uses the selected caption, not the first one', () => {
    const [first, second] = captionIds();
    expect(editingStyleId(state, [second!])).toBe('karaoke');
    expect(editingStyleId(state, [first!])).toBe('bold-creator');
  });

  it('skips a selected item that is not a caption', () => {
    // Selecting a video clip while the style editor is open must not blank the
    // style the user was working on; the caption under the playhead answers.
    playheadStore.set(2_500_000);
    expect(editingStyleId(state, ['not-a-real-item'])).toBe('karaoke');
  });

  it('falls back to the caption under the playhead', () => {
    playheadStore.set(2_500_000);
    expect(editingStyleId(state, [])).toBe('karaoke');
    playheadStore.set(500_000);
    expect(editingStyleId(state, [])).toBe('bold-creator');
  });

  it('prefers the later of two overlapping captions', () => {
    // Overlapping captions are a normal result of a split; the one that started
    // last is the one on top, and it is the one the user sees.
    state = withItems([
      caption('cap-1', 0, 1_000_000, 'bold-creator'),
      caption('cap-3', 500_000, 1_000_000, 'minimal'),
    ]);
    playheadStore.set(600_000);
    expect(editingStyleId(state, [])).toBe('minimal');
  });

  it('returns nothing when no caption is under the playhead', () => {
    playheadStore.set(9_000_000);
    expect(editingStyleId(state, [])).toBeNull();
  });
});
