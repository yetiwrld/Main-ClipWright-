// @vitest-environment jsdom
/**
 * SPEC 09 §17 — the inspector's property controls.
 *
 * The point of these tests is that the controls *do* something. The volume slider
 * sat disabled with a note saying volume edits would arrive later, and opacity,
 * crop and transform had no controls at all, so a property in the file format was
 * unreachable from the app. A test that renders the slider and finds it is enough;
 * a test that moves it and checks the command is the one that would have caught the
 * original problem.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDefaultTimeline, createMediaItem, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';
import { ItemInspector } from '../features/editor/Inspector.js';

afterEach(() => cleanup());

function makeState(overrides: Partial<TimelineState['items'][string]> = {}): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const track = base.tracks.find((candidate) => candidate.role === 'main')!;
  const item = {
    ...createMediaItem({
      id: 'item-1',
      trackId: track.id,
      label: 'Opening',
      mediaId: 'media-1',
      type: 'video',
      startUs: 0,
      durationUs: 4_000_000,
      sourceDurationUs: 10_000_000,
    }),
    ...overrides,
  };
  return {
    ...base,
    tracks: base.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, itemIds: [item.id] } : candidate,
    ),
    items: { [item.id]: item },
  } as TimelineState;
}

function fakeTimeline(state: TimelineState): TimelineApi {
  return {
    state,
    fps: 30,
    selection: ['item-1'],
    setItemProperties: vi.fn(() => true),
    splitCaptionSegment: vi.fn(),
    move: vi.fn(),
    trim: vi.fn(),
    applyEffect: vi.fn(),
    removeEffect: vi.fn(),
    toggleEffectEnabled: vi.fn(),
    addTransition: vi.fn(() => true),
    updateTransition: vi.fn(() => true),
    removeTransition: vi.fn(() => true),
  } as unknown as TimelineApi;
}

const renderInspector = (state: TimelineState) => {
  const timeline = fakeTimeline(state);
  render(<ItemInspector state={state} timeline={timeline} />);
  return timeline;
};

describe('ItemInspector properties', () => {
  it('shows the opacity, volume, pan and speed controls', () => {
    renderInspector(makeState());
    expect(screen.getByLabelText('Clip opacity as a percentage')).toBeTruthy();
    expect(screen.getByLabelText('Clip volume in decibels')).toBeTruthy();
    expect(screen.getByLabelText('Clip pan')).toBeTruthy();
    expect(screen.getByLabelText('Playback speed')).toBeTruthy();
  });

  it('no longer disables the volume slider', () => {
    // It was rendered `disabled` with a note saying volume edits would arrive
    // later. That note was the honest state of the app, and now both are gone.
    renderInspector(makeState());
    const input = screen.getByLabelText('Clip volume in decibels') as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  it('writes an opacity change through the command', () => {
    const timeline = renderInspector(makeState());
    const input = screen.getByLabelText('Clip opacity as a percentage') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '40' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { opacity: 0.4 });
  });

  it('writes a volume change through the command', () => {
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Clip volume in decibels'), { target: { value: '-12' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { volumeDb: -12 });
  });

  it('writes a pan change through the command', () => {
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Clip pan'), { target: { value: '-40' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { pan: -40 });
  });

  it('shows the stored values, so the inspector is a view of the clip', () => {
    renderInspector(makeState({ opacity: 0.5, volumeDb: -12, pan: 25, speed: 2 }));
    expect((screen.getByLabelText('Clip opacity as a percentage') as HTMLInputElement).value).toBe('50');
    expect((screen.getByLabelText('Clip volume in decibels') as HTMLInputElement).value).toBe('-12');
    expect((screen.getByLabelText('Clip pan') as HTMLInputElement).value).toBe('25');
  });
});

describe('crop and transform', () => {
  it('shows a field for each crop edge', () => {
    renderInspector(makeState());
    for (const edge of ['left', 'top', 'right', 'bottom']) {
      expect(screen.getByLabelText(`Crop ${edge}`)).toBeTruthy();
    }
  });

  it('writes a crop edge as a fraction of the source', () => {
    // The schema stores 0–1; the field shows a percentage because 0.1 is harder to
    // type than 10.
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Crop left'), { target: { value: '10' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { crop: { left: 0.1 } });
  });

  it('clamps a crop edge the user types past the limit', () => {
    // Slider-less number inputs accept any typed value, including ones the schema
    // would refuse — clamping here keeps the command's validation from being the
    // only guard.
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Crop right'), { target: { value: '150' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { crop: { right: 0.95 } });
  });

  it('ignores a crop field that is not a number', () => {
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Crop left'), { target: { value: '' } });
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('sets both scale axes together, so a clip does not squash', () => {
    // A single scale control that wrote only `scaleX` would stretch the picture —
    // the kind of thing that looks like a bug in the renderer.
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Scale as a percentage'), { target: { value: '150' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], {
      transform: { scaleX: 1.5, scaleY: 1.5 },
    });
  });

  it('writes rotation in degrees', () => {
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Rotation in degrees'), { target: { value: '15' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { transform: { rotation: 15 } });
  });

  it('clamps rotation to a half turn each way', () => {
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Rotation in degrees'), { target: { value: '400' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { transform: { rotation: 180 } });
  });
});

describe('ItemInspector transitions', () => {
  /** Two adjacent clips on the main track, so a transition is possible. */
  function withNeighbour(overrides: Partial<TimelineState['items'][string]> = {}): TimelineState {
    const base = makeState(overrides);
    const item = base.items['item-1']!;
    // Put the clip second on its track and add a predecessor that ends where it
    // starts — the arrangement `addTransition` requires.
    const first = {
      ...createMediaItem({
        id: 'item-0',
        trackId: item.trackId,
        label: 'Before',
        mediaId: 'media-0',
        type: 'video',
        startUs: 0,
        durationUs: 2_000_000,
        sourceDurationUs: 10_000_000,
      }),
    };
    const second = { ...item, startUs: 2_000_000, durationUs: 2_000_000 };
    return {
      ...base,
      tracks: base.tracks.map((track) =>
        track.id === item.trackId ? { ...track, itemIds: [first.id, second.id] } : track,
      ),
      items: { [first.id]: first, [second.id]: second },
    } as TimelineState;
  }

  it('shows a transition control', () => {
    const state = withNeighbour();
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(screen.getByLabelText('Transition entering this clip')).toBeTruthy();
  });

  it('disables the control for a clip that is first on its track', () => {
    // Nothing to transition from. Accepting the click and doing nothing would read
    // as a broken control rather than an unavailable one.
    const state = makeState();
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    const control = screen.getByLabelText('Transition entering this clip');
    expect((control as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a transition when one is chosen', () => {
    const state = withNeighbour();
    const timeline = fakeTimeline(state);
    timeline.addTransition = vi.fn(() => true);
    render(<ItemInspector state={state} timeline={timeline} />);

    fireEvent.click(screen.getByLabelText('Transition entering this clip'));
    fireEvent.click(screen.getByText(/Crossfade/));
    // The inspector finds the predecessor itself: the user picks one clip.
    expect(timeline.addTransition).toHaveBeenCalledWith(
      state.items['item-1']!.trackId,
      'item-0',
      'item-1',
      'crossfade',
      500_000,
      'center',
    );
  });

  it('changes the type of an existing transition instead of adding a second', () => {
    const state = withNeighbour({
      transitionIn: {
        id: 'tr',
        type: 'crossfade',
        durationUs: 500_000,
        alignment: 'center',
        params: {},
        easing: 'easeInOut',
        crossfadeAudio: true,
      },
    } as never);
    const timeline = fakeTimeline(state);
    timeline.updateTransition = vi.fn(() => true);
    render(<ItemInspector state={state} timeline={timeline} />);

    fireEvent.click(screen.getByLabelText('Transition entering this clip'));
    fireEvent.click(screen.getByText(/Zoom/));
    expect(timeline.updateTransition).toHaveBeenCalledWith('item-1', { type: 'zoom' });
    expect(timeline.addTransition).not.toHaveBeenCalled();
  });

  it('removes a transition when None is chosen', () => {
    const state = withNeighbour({
      transitionIn: {
        id: 'tr',
        type: 'crossfade',
        durationUs: 500_000,
        alignment: 'center',
        params: {},
        easing: 'easeInOut',
        crossfadeAudio: true,
      },
    } as never);
    const timeline = fakeTimeline(state);
    timeline.removeTransition = vi.fn(() => true);
    render(<ItemInspector state={state} timeline={timeline} />);

    fireEvent.click(screen.getByLabelText('Transition entering this clip'));
    fireEvent.click(screen.getByText('None'));
    expect(timeline.removeTransition).toHaveBeenCalledWith('item-1');
  });

  it('offers a duration and alignment once a transition exists', () => {
    const state = withNeighbour({
      transitionIn: {
        id: 'tr',
        type: 'crossfade',
        durationUs: 500_000,
        alignment: 'center',
        params: {},
        easing: 'easeInOut',
        crossfadeAudio: true,
      },
    } as never);
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(screen.getByLabelText('Transition length in tens of milliseconds')).toBeTruthy();
    expect(screen.getByLabelText('Where the transition sits relative to the cut')).toBeTruthy();
  });

  it('writes a duration change through the command', () => {
    const state = withNeighbour({
      transitionIn: {
        id: 'tr',
        type: 'crossfade',
        durationUs: 500_000,
        alignment: 'center',
        params: {},
        easing: 'easeInOut',
        crossfadeAudio: true,
      },
    } as never);
    const timeline = fakeTimeline(state);
    timeline.updateTransition = vi.fn(() => true);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.change(screen.getByLabelText('Transition length in tens of milliseconds'), {
      target: { value: '100' },
    });
    expect(timeline.updateTransition).toHaveBeenCalledWith('item-1', { durationUs: 1_000_000 });
  });
});
