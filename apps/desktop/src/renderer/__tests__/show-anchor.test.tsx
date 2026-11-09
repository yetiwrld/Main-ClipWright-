// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';

/**
 * §8.2's *Show anchor* toggle, `A`.
 *
 * The crosshair is a readout as much as a grip, so what matters is that it can be put
 * away, that putting it away does not take the rest of the editing surface with it, and
 * that the key never eats an `a` typed into a field.
 */

function makeState(): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));
  tracks.find((track) => track.id === mainTrack.id)!.itemIds.push('a');
  const item = {
    id: 'a',
    trackId: mainTrack.id,
    type: 'video' as const,
    mediaId: 'media-a',
    startUs: 0,
    durationUs: 5_000_000,
    sourceInUs: 0,
    transform: {},
    crop: {},
    keyframes: {},
  };
  return { ...base, tracks, items: { a: item } } as unknown as TimelineState;
}

function fakeTimeline(): TimelineApi {
  return {
    fps: 30,
    selection: ['a'],
    setItemProperties: vi.fn(() => true),
    addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
  } as unknown as TimelineApi;
}

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400,
    toJSON: () => ({}),
  } as DOMRect);
  for (const [prop, value] of [['offsetWidth', 400], ['offsetHeight', 400]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
}

const draw = () => {
  stubLayout();
  render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
};

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('the Show anchor toggle', () => {
  it('shows the crosshair on the selected clip to begin with', () => {
    // The default had to be chosen rather than inherited; it is on, so a new user sees
    // the pivot without having to learn a key.
    draw();
    expect(screen.getByTestId('preview-anchor')).toBeTruthy();
  });

  it('hides it on `A`, and brings it back on `A`', () => {
    draw();
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.queryByTestId('preview-anchor')).toBeNull();

    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByTestId('preview-anchor')).toBeTruthy();
  });

  it('hides it on a capital `A` too', () => {
    // With caps lock on the same key arrives uppercased; the toggle is the key, not the
    // character.
    draw();
    fireEvent.keyDown(document, { key: 'A' });
    expect(screen.queryByTestId('preview-anchor')).toBeNull();
  });

  it('leaves the rest of the editing surface in place', () => {
    /*
      The failure this guards against is a toggle wired to the wrong thing: hiding the
      selection with the crosshair would make the clip undraggable, and the user's next
      gesture would appear to do nothing.
    */
    draw();
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.queryByTestId('preview-anchor')).toBeNull();
    expect(screen.getByTestId('preview-selection')).toBeTruthy();
    expect(screen.getByTestId('preview-corner-nw')).toBeTruthy();
  });

  it('ignores `A` typed into a text field', () => {
    // `a` is a letter before it is a command.
    draw();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'a' });
    expect(screen.getByTestId('preview-anchor')).toBeTruthy();
    input.remove();
  });

  it('ignores Ctrl+A', () => {
    // `Ctrl+A` is select-all in the timeline; the preview must not answer it as well.
    draw();
    fireEvent.keyDown(document, { key: 'a', ctrlKey: true });
    expect(screen.getByTestId('preview-anchor')).toBeTruthy();
  });

  it('does not repaint the toggle for a held key', () => {
    // `repeat` fires at the keyboard rate; toggling on every one would make a leaning
    // finger flicker the crosshair.
    draw();
    fireEvent.keyDown(document, { key: 'a' });
    fireEvent.keyDown(document, { key: 'a', repeat: true });
    expect(screen.queryByTestId('preview-anchor')).toBeNull();
  });
});
