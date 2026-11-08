/**
 * What the preview layer shows for a caption (SPEC 11 §3, §6).
 *
 * `visibleCaptionAt` is the join between the stored segment and the frame builder,
 * and it is where the preview can disagree with the export: `segment.text` and
 * `wordRefs` are two descriptions of the same caption, and a hand edit updates one
 * without the other. Every test here is a shape that has actually existed in the
 * file format.
 */
import { describe, expect, it } from 'vitest';
import { builtInStyle } from '@clipwright/caption-styles';
import type { TimelineState } from '@clipwright/timeline-engine';
import { captionStyleFor, visibleCaptionAt } from '../features/editor/CaptionOverlay.js';

function stateWithCaption(segment: unknown, startUs = 1_000_000, durationUs = 2_000_000): TimelineState {
  return {
    tracks: [
      {
        id: 't-caption',
        role: 'caption',
        kind: 'caption',
        name: 'Captions',
        order: 0,
        hidden: false,
        locked: false,
        muted: false,
        solo: false,
        heightPx: 48,
        auto: false,
        itemIds: ['item-1'],
      },
    ],
    items: {
      'item-1': {
        id: 'item-1',
        trackId: 't-caption',
        type: 'caption',
        label: 'Caption',
        startUs,
        durationUs,
        sourceInUs: 0,
        speed: 1,
        volumeDb: 0,
        gainDb: 0,
        pan: 0,
        fadeInUs: 0,
        fadeOutUs: 0,
        fadeCurve: 'equal-power' as const,
        muted: false,
        opacity: 1,
        blendMode: 'normal' as const,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, flipH: false, flipV: false },
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        keyframes: {},
        effects: [],
        captionSegment: segment,
      },
    },
    playheadUs: 0,
  } as unknown as TimelineState;
}

const refs = [
  { wordId: 'w1', startUs: 1_000_000, endUs: 1_300_000 },
  { wordId: 'w2', startUs: 1_300_000, endUs: 1_600_000 },
  { wordId: 'w3', startUs: 1_600_000, endUs: 2_000_000 },
];

const segment = (overrides: Record<string, unknown> = {}) => ({
  id: 'seg-1',
  wordRefs: refs,
  startUs: 1_000_000,
  endUs: 3_000_000,
  text: 'hello there world',
  lines: ['hello there world'],
  manualTiming: false,
  manualText: false,
  ...overrides,
});

describe('visibleCaptionAt', () => {
  it('pairs the stored text with the word timings', () => {
    const caption = visibleCaptionAt(stateWithCaption(segment()), 1_400_000);
    expect(caption?.text).toBe('hello there world');
    expect(caption?.wordIds).toEqual(['w1', 'w2', 'w3']);
    expect(caption?.wordTimings).toEqual([
      { startUs: 1_000_000, endUs: 1_300_000 },
      { startUs: 1_300_000, endUs: 1_600_000 },
      { startUs: 1_600_000, endUs: 2_000_000 },
    ]);
  });

  it('returns null outside the caption, not an empty string', () => {
    expect(visibleCaptionAt(stateWithCaption(segment()), 500_000)).toBeNull();
    expect(visibleCaptionAt(stateWithCaption(segment()), 3_000_000)).toBeNull();
  });

  it('shows a hand-typed caption that has no word timings', () => {
    // A caption the user typed has text but no transcript behind it. Dropping it
    // because `wordRefs` is empty would hide a caption the user can see in the list.
    const typed = segment({ wordRefs: [], text: 'typed by hand' });
    const caption = visibleCaptionAt(stateWithCaption(typed), 1_400_000);
    expect(caption?.text).toBe('typed by hand');
    expect(caption?.wordTimings).toEqual([]);
  });

  it('returns null for a caption with neither text nor words', () => {
    const blank = segment({ wordRefs: [], text: '' });
    expect(visibleCaptionAt(stateWithCaption(blank), 1_400_000)).toBeNull();
  });

  it('does not show more words than it has timings for', () => {
    // After a trim the text can be longer than the surviving refs. Showing the
    // extra words would put a word on screen with no highlight ever reaching it.
    const shorter = segment({ wordRefs: refs.slice(0, 2) });
    const caption = visibleCaptionAt(stateWithCaption(shorter), 1_400_000);
    expect(caption?.text).toBe('hello there');
    expect(caption?.wordIds).toEqual(['w1', 'w2']);
  });

  it('collapses the whitespace the engine may have left in the text', () => {
    const spaced = segment({ text: '  hello   there  world  ' });
    expect(visibleCaptionAt(stateWithCaption(spaced), 1_400_000)?.text).toBe('hello there world');
  });

  it('ignores a non-caption item on the same track', () => {
    const state = stateWithCaption(segment());
    state.items['item-2'] = {
      ...state.items['item-1']!,
      id: 'item-2',
      type: 'video',
      startUs: 1_000_000,
      durationUs: 2_000_000,
    } as (typeof state.items)['item-1'];
    expect(visibleCaptionAt(state, 1_400_000)?.text).toBe('hello there world');
  });
});

describe('captionStyleFor', () => {
  it('falls back to the default preset when the item names none', () => {
    const style = captionStyleFor(undefined, undefined);
    expect(style.id).toBe('bold-creator');
  });

  it('uses the named preset', () => {
    expect(captionStyleFor('karaoke', undefined).id).toBe('karaoke');
  });

  it('prefers a project-local copy over the built-in of the same id', () => {
    const edited = { ...builtInStyle('karaoke')!, name: 'My Karaoke', fill: { ...builtInStyle('karaoke')!.fill, color: '#00FF00' } };
    const style = captionStyleFor('karaoke', undefined, { karaoke: edited });
    expect(style.name).toBe('My Karaoke');
    expect(style.fill.color).toBe('#00FF00');
  });

  it('merges item overrides over the resolved style', () => {
    // Merging per group: overriding the weight must not blank the family.
    const style = captionStyleFor('bold-creator', { font: { weight: 900 } });
    expect(style.font.weight).toBe(900);
    expect(style.font.family).toBe(builtInStyle('bold-creator')!.font.family);
  });

  it('falls back to the default for an unknown id rather than throwing', () => {
    // A project copied from a build with a preset this build does not have must
    // still render something legible.
    expect(captionStyleFor('no-such-preset', undefined).id).toBe('bold-creator');
  });
});
