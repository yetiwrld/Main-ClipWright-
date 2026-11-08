/**
 * SPEC 11 §2.5 — every caption edit is a command, and the UI holds no caption
 * logic. These tests are that contract: each operation is applied to a timeline
 * state and checked through the engine, with no component involved.
 *
 * The recurring theme is that a caption has three coupled representations — the
 * word refs, the displayed text, and the times — and any edit that updates one
 * without the others produces a caption that renders one thing and exports
 * another.
 */
import { describe, expect, it } from 'vitest';
import {
  addItem,
  applyCaptionStyle,
  createCaptionItem,
  createDefaultTimeline,
  editCaptionText,
  regenerateCaptions,
  retimeCaption,
  setWordEmphasis,
  syncCaptionsWithTranscript,
  trimCaptionWordsToRange,
  type CommandResult,
  type TimelineState,
} from '../index.js';

const FPS = 30 as const;

function stateWithCaption(): { state: TimelineState; itemId: string; trackId: string } {
  const base = createDefaultTimeline({ id: 'comp-1', name: 'Captions', fps: FPS });
  const track = base.tracks.find((candidate) => candidate.kind === 'caption');
  if (!track) throw new Error('the default timeline has no caption track');

  const item = createCaptionItem({
    id: 'cap-1',
    trackId: track.id,
    startUs: 1_000_000,
    durationUs: 2_000_000,
    styleId: 'bold-creator',
    words: [
      { wordId: 'w1', startUs: 1_000_000, endUs: 1_400_000, textOverride: 'one' },
      { wordId: 'w2', startUs: 1_400_000, endUs: 1_700_000, textOverride: 'two' },
      { wordId: 'w3', startUs: 1_700_000, endUs: 2_000_000, textOverride: 'three' },
      { wordId: 'w4', startUs: 2_000_000, endUs: 2_400_000, textOverride: 'four' },
      { wordId: 'w5', startUs: 2_400_000, endUs: 2_900_000, textOverride: 'five' },
    ],
  });

  const added = addItem(base, { item, fps: FPS });
  if (!added.ok) throw new Error(`could not add the caption: ${added.message}`);
  return { state: added.state, itemId: 'cap-1', trackId: track.id };
}

const ok = (result: CommandResult): Extract<CommandResult, { ok: true }> => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result;
};

const segment = (state: TimelineState, itemId: string) => state.items[itemId]!.captionSegment!;

describe('editCaptionText (SPEC 11 §8)', () => {
  it('keeps the timing when the word count is unchanged', () => {
    // Fixing a typo must not move anything.
    const { state, itemId } = stateWithCaption();
    const next = ok(editCaptionText(state, { itemId, text: 'ONE TWO THREE FOUR FIVE' }));
    const words = segment(next.state, itemId).wordRefs;
    expect(words.map((word) => word.textOverride)).toEqual(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']);
    expect(words.map((word) => word.startUs)).toEqual([1_000_000, 1_400_000, 1_700_000, 2_000_000, 2_400_000]);
  });

  it('redistributes the times proportionally when the word count changes', () => {
    const { state, itemId } = stateWithCaption();
    const next = ok(editCaptionText(state, { itemId, text: 'a bb ccc dddd' }));
    const seg = segment(next.state, itemId);
    expect(seg.wordRefs).toHaveLength(4);
    // The last word ends exactly on the segment end, so rounding cannot leave a gap.
    expect(seg.wordRefs[3]!.endUs).toBe(seg.endUs);
    expect(next.notes[0]).toContain('redistributed');
  });

  it('marks the caption as hand-edited so regeneration leaves it alone', () => {
    const { state, itemId } = stateWithCaption();
    const next = ok(editCaptionText(state, { itemId, text: 'typed by hand' }));
    expect(segment(next.state, itemId).manualText).toBe(true);
  });

  it('keeps the derived text in step with the words', () => {
    const { state, itemId } = stateWithCaption();
    const next = ok(editCaptionText(state, { itemId, text: 'alpha beta' }));
    const seg = segment(next.state, itemId);
    expect(seg.text).toBe('alpha beta');
    expect(seg.lines.join(' ')).toBe('alpha beta');
  });

  it('refuses empty text rather than creating a blank caption', () => {
    const { state, itemId } = stateWithCaption();
    const result = editCaptionText(state, { itemId, text: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('refuses when the track is locked', () => {
    const { state, itemId, trackId } = stateWithCaption();
    const locked: TimelineState = {
      ...state,
      tracks: state.tracks.map((track) => (track.id === trackId ? { ...track, locked: true } : track)),
    };
    const result = editCaptionText(locked, { itemId, text: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('is undoable back to the previous text', () => {
    const { state, itemId } = stateWithCaption();
    const next = ok(editCaptionText(state, { itemId, text: 'changed' }));
    expect(next.inverse.length).toBeGreaterThan(0);
    // Applying the inverse patches must restore the original text.
    const { applyPatches, enablePatches } = require('immer') as {
      applyPatches: (base: unknown, patches: unknown[]) => TimelineState;
      enablePatches: () => void;
    };
    // Immer's patch plugin must be enabled in this module's own copy of immer;
    // the engine enables it for its instance, not for a fresh `require` here.
    enablePatches();
    const restored = applyPatches(next.state, next.inverse);
    expect(segment(restored, itemId).text).toBe('one two three four five');
  });
});

describe('retimeCaption (SPEC 11 §3, §8)', () => {
  it('hides words outside the range without deleting them', () => {
    const { state, itemId } = stateWithCaption();
    // Shrink to cover only "one" and "two".
    const next = ok(retimeCaption(state, { itemId, startUs: 1_000_000, endUs: 1_700_000, fps: FPS }));
    const seg = segment(next.state, itemId);
    expect(seg.wordRefs).toHaveLength(5);
    expect(seg.text).toBe('one two');
  });

  it('restores the hidden words when extended again', () => {
    // This is the whole reason trimming hides rather than deletes.
    const { state, itemId } = stateWithCaption();
    const shrunk = ok(retimeCaption(state, { itemId, startUs: 1_000_000, endUs: 1_700_000, fps: FPS }));
    const restored = ok(retimeCaption(shrunk.state, { itemId, startUs: 1_000_000, endUs: 2_900_000, fps: FPS }));
    expect(segment(restored.state, itemId).text).toBe('one two three four five');
  });

  it('keeps the item and its segment in agreement', () => {
    const { state, itemId } = stateWithCaption();
    const next = ok(retimeCaption(state, { itemId, startUs: 500_000, endUs: 3_000_000, fps: FPS }));
    const item = next.state.items[itemId]!;
    expect(item.startUs).toBe(segment(next.state, itemId).startUs);
    expect(item.startUs + item.durationUs).toBe(segment(next.state, itemId).endUs);
  });

  it('refuses a caption shorter than one frame', () => {
    const { state, itemId } = stateWithCaption();
    const result = retimeCaption(state, { itemId, startUs: 1_000_000, endUs: 1_000_001, fps: FPS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_short');
  });

  it('is a no-op when nothing changes, not an error', () => {
    // A drag that ends where it began must not be reported as a failure.
    const { state, itemId } = stateWithCaption();
    const result = ok(retimeCaption(state, { itemId, startUs: 1_000_000, endUs: 3_000_000, fps: FPS }));
    expect(result.affectedItemIds).toEqual([]);
  });
});

describe('trimCaptionWordsToRange (SPEC 11 §8)', () => {
  it('removes the words outside the range, when asked explicitly', () => {
    const { state, itemId } = stateWithCaption();
    const shrunk = ok(retimeCaption(state, { itemId, startUs: 1_000_000, endUs: 1_700_000, fps: FPS }));
    const trimmed = ok(trimCaptionWordsToRange(shrunk.state, { itemId }));
    expect(segment(trimmed.state, itemId).wordRefs).toHaveLength(2);
    expect(trimmed.notes[0]).toContain('3 words');
  });

  it('does nothing when every word is inside the range', () => {
    const { state, itemId } = stateWithCaption();
    const result = ok(trimCaptionWordsToRange(state, { itemId }));
    expect(result.affectedItemIds).toEqual([]);
  });
});

describe('applyCaptionStyle (SPEC 11 §2.2, §8)', () => {
  it('sets the style id on every selected caption', () => {
    const { state, itemId } = stateWithCaption();
    const next = ok(applyCaptionStyle(state, { itemIds: [itemId], styleId: 'karaoke' }));
    expect(next.state.items[itemId]!.captionStyleId).toBe('karaoke');
  });

  it('clears per-item overrides unless asked to keep them', () => {
    const { state, itemId } = stateWithCaption();
    const withOverrides: TimelineState = {
      ...state,
      items: { ...state.items, [itemId]: { ...state.items[itemId]!, styleOverrides: { position: { yPct: 10 } } } },
    };
    const cleared = ok(applyCaptionStyle(withOverrides, { itemIds: [itemId], styleId: 'karaoke' }));
    expect(cleared.state.items[itemId]!.styleOverrides).toBeUndefined();

    const kept = ok(applyCaptionStyle(withOverrides, { itemIds: [itemId], styleId: 'karaoke', keepOverrides: true }));
    expect(kept.state.items[itemId]!.styleOverrides).toBeDefined();
  });

  it('ignores items that are not captions', () => {
    const { state, itemId } = stateWithCaption();
    const result = applyCaptionStyle(state, { itemIds: ['not-a-caption', itemId], styleId: 'karaoke' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.affectedItemIds).toEqual([itemId]);
  });

  it('fails when nothing selected is a caption', () => {
    const { state } = stateWithCaption();
    const result = applyCaptionStyle(state, { itemIds: ['missing'], styleId: 'karaoke' });
    expect(result.ok).toBe(false);
  });
});

describe('setWordEmphasis (SPEC 11 §7)', () => {
  it('stores emphasis per word, not in the style', () => {
    // Swapping styles must keep the user's chosen emphasis.
    const { state, itemId } = stateWithCaption();
    const next = ok(setWordEmphasis(state, { itemId, wordIndex: 2, emphasis: true }));
    const overrides = segment(next.state, itemId).wordOverrides;
    expect(overrides?.w3?.emphasis).toBe(true);
    expect(next.state.items[itemId]!.styleOverrides).toBeUndefined();
  });

  it('removes the entry when emphasis is turned off again', () => {
    const { state, itemId } = stateWithCaption();
    const on = ok(setWordEmphasis(state, { itemId, wordIndex: 0, emphasis: true }));
    const off = ok(setWordEmphasis(on.state, { itemId, wordIndex: 0, emphasis: false }));
    expect(segment(off.state, itemId).wordOverrides?.w1).toBeUndefined();
  });

  it('refuses a word index that is not in the caption', () => {
    const { state, itemId } = stateWithCaption();
    const result = setWordEmphasis(state, { itemId, wordIndex: 99, emphasis: true });
    expect(result.ok).toBe(false);
  });
});

describe('regenerateCaptions (SPEC 11 §9)', () => {
  const generated = [
    { startUs: 0, endUs: 500_000, text: 'new one', words: [{ id: 'g1', text: 'new', startUs: 0, endUs: 250_000 }, { id: 'g2', text: 'one', startUs: 250_000, endUs: 500_000 }] },
  ];

  it('replaces untouched captions', () => {
    const { state, trackId } = stateWithCaption();
    const next = ok(regenerateCaptions(state, { trackId, segments: generated }));
    const captions = Object.values(next.state.items).filter((item) => item.type === 'caption');
    expect(captions).toHaveLength(1);
    expect(captions[0]!.captionSegment!.text).toBe('new one');
  });

  it('never overwrites a caption the user edited', () => {
    // Losing a hand fix is worse than keeping a stale one.
    const { state, itemId, trackId } = stateWithCaption();
    const edited = ok(editCaptionText(state, { itemId, text: 'typed by hand' }));
    const next = ok(regenerateCaptions(edited.state, { trackId, segments: generated }));
    expect(next.state.items[itemId]).toBeDefined();
    expect(segment(next.state, itemId).text).toBe('typed by hand');
    expect(next.notes.join(' ')).toContain('kept 1');
  });

  it('replaces everything when forced', () => {
    const { state, itemId, trackId } = stateWithCaption();
    const edited = ok(editCaptionText(state, { itemId, text: 'typed by hand' }));
    const next = ok(regenerateCaptions(edited.state, { trackId, segments: generated, force: true }));
    expect(next.state.items[itemId]).toBeUndefined();
  });

  it('skips a generated segment that would overlap a preserved caption', () => {
    // Overlapping captions on one track violate invariant 1 (§3).
    const { state, itemId, trackId } = stateWithCaption();
    const edited = ok(editCaptionText(state, { itemId, text: 'kept' }));
    const overlapping = [{ startUs: 1_100_000, endUs: 1_600_000, text: 'clash', words: [{ id: 'x', text: 'clash', startUs: 1_100_000, endUs: 1_600_000 }] }];
    const next = ok(regenerateCaptions(edited.state, { trackId, segments: overlapping }));
    expect(next.state.items[itemId]).toBeDefined();
    const captions = Object.values(next.state.items).filter((item) => item.type === 'caption');
    expect(captions).toHaveLength(1);
  });

  it('refuses a track that cannot hold captions', () => {
    const { state } = stateWithCaption();
    const videoTrack = state.tracks.find((track) => track.kind === 'video')!;
    const result = regenerateCaptions(state, { trackId: videoTrack.id, segments: generated });
    expect(result.ok).toBe(false);
  });
});

describe('syncCaptionsWithTranscript (SPEC 11 §9)', () => {
  it('realigns a caption whose words moved in the transcript', () => {
    const { state, itemId, trackId } = stateWithCaption();
    const moved = [
      { text: 'one', startUs: 5_000_000, endUs: 5_400_000 },
      { text: 'two', startUs: 5_400_000, endUs: 5_700_000 },
      { text: 'three', startUs: 5_700_000, endUs: 6_000_000 },
      { text: 'four', startUs: 6_000_000, endUs: 6_400_000 },
      { text: 'five', startUs: 6_400_000, endUs: 6_900_000 },
    ];
    const next = ok(syncCaptionsWithTranscript(state, { trackId, words: moved }));
    const seg = segment(next.state, itemId);
    expect(seg.startUs).toBe(5_000_000);
    expect(next.notes[0]).toContain('Realigned 1');
  });

  it('flags rather than deletes a caption it cannot match', () => {
    const { state, itemId, trackId } = stateWithCaption();
    const unrelated = [{ text: 'completely', startUs: 0, endUs: 100_000 }];
    const next = ok(syncCaptionsWithTranscript(state, { trackId, words: unrelated }));
    expect(next.state.items[itemId]).toBeDefined();
    expect(segment(next.state, itemId).transcriptChanged).toBe(true);
    expect(next.notes.join(' ')).toContain('flagged for review');
  });

  it('leaves a hand-edited caption alone', () => {
    const { state, itemId, trackId } = stateWithCaption();
    const edited = ok(editCaptionText(state, { itemId, text: 'mine' }));
    const before = segment(edited.state, itemId).startUs;
    const next = ok(syncCaptionsWithTranscript(edited.state, { trackId, words: [{ text: 'other', startUs: 9_000_000, endUs: 9_100_000 }] }));
    expect(segment(next.state, itemId).startUs).toBe(before);
  });
});
