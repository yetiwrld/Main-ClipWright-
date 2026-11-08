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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDefaultTimeline, createMediaItem, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';
import { ItemInspector } from '../features/editor/Inspector.js';
import { playheadStore } from '../features/editor/playhead-store.js';

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
    setEffectParams: vi.fn(() => true),
    moveEffect: vi.fn(() => true),
    setEffectChain: vi.fn(() => true),
    copyEffects: vi.fn(() => 0),
    pasteEffects: vi.fn(() => true),
    effectClipboardSize: 0,
    addKeyframe: vi.fn(() => true),
    removeKeyframe: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
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

  /** A clip that already has a transition of `type` entering it. */
  function withTransition(type: string, params: Record<string, string> = {}) {
    const state = withNeighbour();
    const item = state.items['item-1']!;
    return {
      ...state,
      items: {
        ...state.items,
        'item-1': {
          ...item,
          transitionIn: {
            id: 'tr-1',
            type: type as never,
            durationUs: 500_000,
            alignment: 'center' as const,
            params,
            easing: 'linear' as const,
            crossfadeAudio: true,
          },
        },
      },
    } as TimelineState;
  }

  it('offers a direction for a wipe and sends it as a param', () => {
    // SPEC 12 §4.2 gives a wipe a direction; without this control the shape the
    // engine implements is unreachable and every wipe is left-to-right.
    const state = withTransition('wipe');
    const timeline = fakeTimeline(state);
    timeline.updateTransition = vi.fn(() => true);
    render(<ItemInspector state={state} timeline={timeline} />);

    fireEvent.click(screen.getByLabelText('Direction of the transition'));
    fireEvent.click(screen.getByText('Revealed from the right'));
    expect(timeline.updateTransition).toHaveBeenCalledWith('item-1', {
      params: { direction: 'right' },
    });
  });

  it('labels a slide direction as travel, not as a reveal', () => {
    // The engine reads a slide's direction as the way the picture moves and a
    // wipe's as where the reveal begins. Reusing one list labelled one of them
    // wrongly, so each type gets its own wording.
    const state = withTransition('slide');
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    fireEvent.click(screen.getByLabelText('Direction of the transition'));
    // The custom `Select` renders the chosen option in its trigger *and* in the
    // open popup, so the label legitimately appears twice.
    expect(screen.getAllByText('Travels left').length).toBeGreaterThan(0);
    expect(screen.queryByText('Revealed from the left')).toBeNull();
  });

  it('shows the direction control only for the types that have one', () => {
    // A disabled direction picker on a crossfade would imply a setting exists that
    // does nothing.
    const state = withTransition('crossfade');
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(screen.queryByLabelText('Direction of the transition')).toBeNull();
  });

  it('reflects a direction already stored on the transition', () => {
    const state = withTransition('wipe', { direction: 'up' });
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(screen.getByLabelText('Direction of the transition').textContent).toContain(
      'top',
    );
  });

  it('offers a slide mode and sends it as a param', () => {
    // SPEC 12 §4.2 gives a slide a `mode` alongside its direction. Without a
    // control the cover and reveal shapes the engine implements are unreachable,
    // and every slide is a push — which is what shipped before this.
    const state = withTransition('slide');
    const timeline = fakeTimeline(state);
    timeline.updateTransition = vi.fn(() => true);
    render(<ItemInspector state={state} timeline={timeline} />);

    fireEvent.click(screen.getByLabelText('Motion of the slide'));
    fireEvent.click(screen.getByText('Outgoing slides away'));
    expect(timeline.updateTransition).toHaveBeenCalledWith('item-1', {
      params: { mode: 'reveal' },
    });
  });

  it('shows push as the slide mode when none is stored', () => {
    // An unset mode means push in the engine, so the picker must say so rather
    // than rendering blank and implying no mode is chosen.
    const state = withTransition('slide');
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(screen.getByLabelText('Motion of the slide').textContent).toContain('Both pictures');
  });

  it('shows the mode control only on a slide', () => {
    // Every other transition has one motion; a mode picker there would offer a
    // choice that does nothing.
    const wipe = withTransition('wipe');
    const first = render(<ItemInspector state={wipe} timeline={fakeTimeline(wipe)} />);
    expect(screen.queryByLabelText('Motion of the slide')).toBeNull();
    first.unmount();
    const crossfade = withTransition('crossfade');
    render(<ItemInspector state={crossfade} timeline={fakeTimeline(crossfade)} />);
    expect(screen.queryByLabelText('Motion of the slide')).toBeNull();
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

describe('ItemInspector effects', () => {
  it('offers a menu of effects that are not already applied', () => {
    renderInspector(makeState());
    expect(screen.getByLabelText('Add an effect to this clip')).toBeTruthy();
  });

  it('adds an effect through the command', () => {
    // There was no way to create an effect from the app at all before this: the
    // inspector listed, toggled and removed chain entries, so the chain could only
    // be populated by calling the store directly.
    const timeline = renderInspector(makeState());
    fireEvent.click(screen.getByLabelText('Add an effect to this clip'));
    fireEvent.click(screen.getByText('Exposure'));
    expect(timeline.applyEffect).toHaveBeenCalledWith('item-1', 'exposure');
  });

  it('shows each applied effect with its parameter controls', () => {
    const state = makeState({
      effects: [{ id: 'fx', effectId: 'brightness', enabled: true, params: { amount: 0.2 } }],
    } as never);
    renderInspector(state);
    expect(screen.getByText('Brightness')).toBeTruthy();
    // Label comes from the catalogue's ParamSpec, so it stays in step with the
    // range the renderer clamps to.
    expect(screen.getByLabelText('Brightness Amount')).toBeTruthy();
  });

  it('writes a parameter change through the command', () => {
    const state = makeState({
      effects: [{ id: 'fx', effectId: 'exposure', enabled: true, params: { stops: 0 } }],
    } as never);
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    // The slider is scaled so float ranges remain usable: −3…3 in steps of 0.05,
    // so slider position 20 is one stop.
    fireEvent.change(screen.getByLabelText('Exposure Stops'), { target: { value: '20' } });
    expect(timeline.setEffectParams).toHaveBeenCalledWith('item-1', 'exposure', { stops: 1 });
  });

  it('names the remove button after the effect rather than repeating "Remove effect"', () => {
    const state = makeState({
      effects: [{ id: 'fx', effectId: 'vignette', enabled: true, params: {} }],
    } as never);
    renderInspector(state);
    // Five effects in a chain would otherwise present five identical buttons.
    expect(screen.getByLabelText('Remove Vignette')).toBeTruthy();
  });

  it('does not offer an effect that is already in the chain', () => {
    const state = makeState({
      effects: [{ id: 'fx', effectId: 'blur', enabled: true, params: {} }],
    } as never);
    renderInspector(state);
    // The applied row already says "Blur (Gaussian)", so counting is the only way to
    // tell whether the *menu* also offers it.
    const before = screen.getAllByText('Blur (Gaussian)').length;
    fireEvent.click(screen.getByLabelText('Add an effect to this clip'));
    expect(screen.getAllByText('Blur (Gaussian)').length).toBe(before);
  });
});

describe('ItemInspector effect order', () => {
  const chain = makeState({
    effects: [
      { id: 'a', effectId: 'brightness', enabled: true, params: {} },
      { id: 'b', effectId: 'contrast', enabled: true, params: {} },
    ],
  } as never);

  it('moves an effect earlier through the command', () => {
    // §12's acceptance list requires the chain to be reorderable; before this the
    // order was whatever order the effects happened to be added in.
    const timeline = fakeTimeline(chain);
    render(<ItemInspector state={chain} timeline={timeline} />);
    fireEvent.click(screen.getByLabelText('Move Contrast earlier'));
    expect(timeline.moveEffect).toHaveBeenCalledWith('item-1', 'contrast', 0);
  });

  it('moves an effect later through the command', () => {
    const timeline = fakeTimeline(chain);
    render(<ItemInspector state={chain} timeline={timeline} />);
    fireEvent.click(screen.getByLabelText('Move Brightness later'));
    expect(timeline.moveEffect).toHaveBeenCalledWith('item-1', 'brightness', 1);
  });

  it('names both arrows after the effect, not after the direction', () => {
    // Two effects would otherwise give four buttons all called "Move up"/"Move
    // down", which is unusable with a screen reader.
    render(<ItemInspector state={chain} timeline={fakeTimeline(chain)} />);
    expect(screen.getByLabelText('Move Brightness earlier')).toBeTruthy();
    expect(screen.getByLabelText('Move Contrast later')).toBeTruthy();
  });
});

describe('ItemInspector copy and paste effects', () => {
  const withEffects = makeState({
    effects: [{ id: 'a', effectId: 'brightness', enabled: true, params: { amount: 0.2 } }],
  } as never);

  it('copies the chain through the command', () => {
    const timeline = fakeTimeline(withEffects);
    render(<ItemInspector state={withEffects} timeline={timeline} />);
    fireEvent.click(screen.getByText('Copy effects'));
    expect(timeline.copyEffects).toHaveBeenCalledWith('item-1');
  });

  it('disables Copy when the clip has no effects', () => {
    const state = makeState();
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    // `getByText` finds the label span inside the button, so the closest button is
    // what carries `disabled`.
    const button = screen.getByText('Copy effects').closest('button')!;
    expect(button.disabled).toBe(true);
  });

  it('disables Paste until something has been copied', () => {
    // A paste button that does nothing when the clipboard is empty is
    // indistinguishable from a broken one.
    const timeline = fakeTimeline(withEffects);
    render(<ItemInspector state={withEffects} timeline={timeline} />);
    expect(screen.getByText('Paste effects').closest('button')!.disabled).toBe(true);
  });

  it('pastes when the effect clipboard has entries', () => {
    const timeline = fakeTimeline(withEffects);
    (timeline as { effectClipboardSize: number }).effectClipboardSize = 2;
    render(<ItemInspector state={withEffects} timeline={timeline} />);
    const paste = screen.getByText('Paste effects').closest('button')!;
    expect(paste.disabled).toBe(false);
    fireEvent.click(paste);
    expect(timeline.pasteEffects).toHaveBeenCalledWith('item-1');
  });
});

describe('keyframe controls on the property rows (SPEC 12 §2.4)', () => {
  it('offers a diamond on the opacity and volume rows', () => {
    renderInspector(makeState());
    expect(screen.getByLabelText('Keyframe Opacity at the playhead')).toBeTruthy();
    expect(screen.getByLabelText('Keyframe Volume at the playhead')).toBeTruthy();
  });

  it('records the property\'s current value when the diamond creates a key', () => {
    /*
      §2.4: "Every keyframe creation records the evaluated value at that time, so
      adding a key never changes the picture." Creating a key with a default value
      instead would snap the clip to something the user never chose.
    */
    const state = makeState({ opacity: 0.4 });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.click(screen.getByLabelText('Keyframe Opacity at the playhead'));
    // The playhead starts at 0, which is the clip's start, so the local time is 0.
    expect(timeline.addKeyframe).toHaveBeenCalledWith('item-1', 'opacity', 0, 0.4);
  });

  it('removes the key when the playhead is already on one', () => {
    // The diamond is a toggle, not an insert. A second click on the same frame must
    // not stack a duplicate key at the same time.
    const state = makeState({
      keyframes: { opacity: [{ timeUs: 0, value: 0.4, interpolation: 'linear' }] },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    const diamond = screen.getByLabelText('Keyframe Opacity at the playhead');
    expect(diamond.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(diamond);
    expect(timeline.removeKeyframe).toHaveBeenCalledWith('item-1', 'opacity', 0);
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
  });

  it('disables the diamond when the playhead is outside the clip, with a reason', () => {
    // §2.4 blocks the edit "with a tooltip", so the reason has to be in the title.
    const state = makeState({ startUs: 2_000_000 });
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    const diamond = screen.getByLabelText('Keyframe Opacity at the playhead');
    expect((diamond as HTMLButtonElement).disabled).toBe(true);
    expect(diamond.getAttribute('title')).toMatch(/before this clip|past the end/);
  });

  it('updates the key already under the playhead rather than inserting a second', () => {
    /*
      Auto-keyframing. The property has keys, so a slider change must go to the keys
      — the evaluator reads them and ignores the static value, so a static edit would
      be invisible. The playhead starts at the clip's start, where a key already
      exists, so the right move is to *update* it: inserting another at the same time
      would break the model's "unique per property" rule.
    */
    const state = makeState({
      keyframes: {
        volumeDb: [
          { timeUs: 0, value: 0, interpolation: 'linear' },
          { timeUs: 3_000_000, value: -20, interpolation: 'linear' },
        ],
      },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.change(screen.getByLabelText('Clip volume in decibels'), {
      target: { value: '-12' },
    });
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('item-1', 'volumeDb', 0, { value: -12 });
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('inserts a key when the property is animated but the playhead is between keys', () => {
    // The other auto-keyframing branch: animated, but no key at this exact frame.
    const state = makeState({
      keyframes: {
        volumeDb: [
          { timeUs: 0, value: 0, interpolation: 'linear' },
          { timeUs: 3_000_000, value: -20, interpolation: 'linear' },
        ],
      },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    // Move the playhead 1 s in, between the two keys.
    act(() => playheadStore.set(1_000_000));
    fireEvent.change(screen.getByLabelText('Clip volume in decibels'), {
      target: { value: '-12' },
    });
    expect(timeline.addKeyframe).toHaveBeenCalledWith('item-1', 'volumeDb', 1_000_000, -12);
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    // Leave the store where the next test expects to find it.
    act(() => playheadStore.set(0));
  });

  it('edits the static value when the property has no keys', () => {
    // The other half of the rule: dragging a slider on a never-animated clip must
    // not start an animation.
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.change(screen.getByLabelText('Clip volume in decibels'), {
      target: { value: '-12' },
    });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { volumeDb: -12 });
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
  });
});
