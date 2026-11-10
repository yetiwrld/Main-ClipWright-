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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDefaultTimeline, createMediaItem, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';
import { ItemInspector } from '../features/editor/Inspector.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { ANIMATABLE_PROPERTIES } from '../features/editor/keyframe-controls.js';

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
    setKeyframesAt: vi.fn(() => true),
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
    //
    // It also retires the legacy `transform.scale` field. Without that write a
    // project that carries `{ scale: 1.5, scaleX: 1, scaleY: 1 }` comes back to 150%
    // the moment the user types 100%, because the compositor lets the legacy field
    // win whenever both axes are at their default. Verified against the real
    // `effectiveScale`: stored 1.5 → set 200% → set 100% renders 1.5 again until the
    // field is cleared.
    const timeline = renderInspector(makeState());
    fireEvent.change(screen.getByLabelText('Scale as a percentage'), { target: { value: '150' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], {
      transform: { scaleX: 1.5, scaleY: 1.5, scale: 1 },
    });
  });

  it('shows the legacy scale rather than claiming 100% for a clip rendered at 150%', () => {
    const state = makeState({ transform: { ...makeState().items['item-1']!.transform, scale: 1.5 } });
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect((screen.getByLabelText('Scale as a percentage') as HTMLInputElement).value).toBe('150');
  });

  it('splits the scale into two axes when the clip is already non-uniform', () => {
    /*
      A single field cannot show 120% wide by 80% tall. Showing one axis would let the
      user "correct" a value that the picture does not use, and the next edit would
      collapse the other axis.
    */
    const state = makeState({
      transform: { ...makeState().items['item-1']!.transform, scaleX: 1.2, scaleY: 0.8 },
    });
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(screen.queryByLabelText('Scale as a percentage')).toBeNull();
    expect((screen.getByLabelText('Horizontal scale as a percentage') as HTMLInputElement).value).toBe('120');
    expect((screen.getByLabelText('Vertical scale as a percentage') as HTMLInputElement).value).toBe('80');
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

describe('ItemInspector shapes and icons (SPEC 11 §12)', () => {
  /*
    Both controls were reachable only at creation time. The fields existed in the schema,
    both renderers drew them and the exporter wrote them, and the inspector had no row -
    so "the stroke field did nothing after you picked the icon" was a documented
    limitation rather than an oversight. These tests are about the *wiring*, since the
    command's own range checks are covered in `item-properties.test.ts`.
  */

  it('shows an icon\'s stroke width at its stored value and writes a change', () => {
    /*
      Asserted at a non-default value (3.5, not 2) on purpose: an input that ignored the
      stored value and displayed the default would pass a test that used 2, and the whole
      complaint was that an icon looked the same however the field was set.
    */
    const state = makeState({ iconName: 'star', iconStrokeWidth: 3.5, shapeKind: undefined });
    const timeline = renderInspector(state);
    const slider = screen.getByLabelText('Icon stroke width') as HTMLInputElement;
    expect(slider.value).toBe('3.5');

    fireEvent.change(slider, { target: { value: '1' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { iconStrokeWidth: 1 });
  });

  it('falls back to the library default for an icon that never stored a width', () => {
    // A project written before the field existed. The slider must show what the renderers
    // will actually draw, or moving it from "2" would be a lie about the starting point.
    const state = makeState({ iconName: 'star', iconStrokeWidth: undefined, shapeKind: undefined });
    renderInspector(state);
    expect((screen.getByLabelText('Icon stroke width') as HTMLInputElement).value).toBe('2');
  });

  it('offers the shape kinds for a shape, and writes the chosen one', () => {
    const state = makeState({ shapeKind: 'rect', iconName: undefined });
    const timeline = renderInspector(state);
    // `Select` is a button plus a listbox, not a native <select>: the control shows the
    // current label and the choice happens on the option, which is how the transition
    // tests drive the same component.
    expect(screen.getByLabelText('Shape kind').textContent).toContain('Rect');

    fireEvent.click(screen.getByLabelText('Shape kind'));
    fireEvent.click(screen.getByText('Star'));
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { shapeKind: 'star' });
  });

  it('names the kinds in words rather than kebab-case', () => {
    /*
      `round-rect` in a menu is a schema value leaking into the UI. The label is derived
      from the kind by `shapeKindLabel`, so adding a shape to `SHAPE_KINDS` cannot leave a
      raw identifier in the control. Opened rather than read off a `<select>`, because this
      control renders its options only when it is open.
    */
    const state = makeState({ shapeKind: 'round-rect', iconName: undefined });
    renderInspector(state);
    expect(screen.getByLabelText('Shape kind').textContent).toContain('Round rect');

    fireEvent.click(screen.getByLabelText('Shape kind'));
    /*
      `getAllByText`, because the open control shows its current label twice: once on the
      button and once as the selected option. That is the component working, not a
      duplicate — the assertion is that every kind appears in words at least once.
    */
    for (const label of ['Rect', 'Round rect', 'Ellipse', 'Triangle', 'Star', 'Line', 'Arrow', 'Bubble']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    // No raw identifier survived into the menu.
    expect(screen.queryByText('round-rect')).toBeNull();
  });

  it('shows exactly one of the two controls, never both', () => {
    /*
      A shape and an icon are two sources of geometry and the schema keeps them exclusive.
      Rendering both, with one inert, is the failure this asserts against: it would be a
      control the user can move that changes nothing, which is the bug this whole slice
      exists to remove.
    */
    const shape = makeState({ shapeKind: 'rect', iconName: undefined });
    const { unmount } = render(<ItemInspector state={shape} timeline={fakeTimeline(shape)} />);
    expect(screen.queryByLabelText('Icon stroke width')).toBeNull();
    unmount();

    const icon = makeState({ iconName: 'star', shapeKind: undefined });
    render(<ItemInspector state={icon} timeline={fakeTimeline(icon)} />);
    expect(screen.queryByLabelText('Shape kind')).toBeNull();
  });

  it('re-picks the icon on an existing item without creating another', async () => {
    /*
      The one gap this row did not close on its own. The picker was reachable only from the
      timeline menu, which *adds*, so changing a star into a heart meant deleting the item
      and losing its timing. The dialog's `value` and `strokeWidth` props had existed from
      the day it was written and no caller passed them, which is why the grid could not
      highlight the current icon either.
    */
    /*
      A *non-default* stroke width (3.5, not 2), for the reason this file has now recorded
      twice: the picker falls back to the default 2 when it is not told otherwise, so a
      fixture at 2 cannot tell "the current width is passed" from "no width is passed".
      The mutation survived until this number changed.
    */
    const state = makeState({ iconName: 'star', iconStrokeWidth: 3.5, shapeKind: undefined });
    const timeline = renderInspector(state);

    /*
      The row names the item by its label, not by the icon: `createIconItem` sets the label
      from the icon name at creation, but an item renamed since shows the name it now has,
      and the button beside it is what says which icon is in play.
    */
    fireEvent.click(screen.getByLabelText('Change icon'));

    // The dialog is the picker, and it opens on this item's icon: the `value` prop is what
    // highlights the current tile, and no caller passed it before this slice.
    expect(screen.getByText('Choose an icon')).toBeTruthy();
    expect((screen.getByLabelText('Stroke width') as HTMLInputElement).value).toBe('3.5');
    /*
      And the current icon is marked selected in the grid. This is the assertion that was
      missing first time round: dropping the `value` prop survived, because a test that only
      reads the stroke field cannot tell an edit dialog from an add dialog. `aria-pressed`
      is what the tile exposes, so it is what the user's selected state actually is.
    */
    /*
      Searched for first: page one is alphabetical, so `star` is not on it. The selected
      tile is the current icon *after* filtering, which is the state the user is shown when
      they open the dialog on an icon they already have.
    */
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'star' } });
    expect(screen.getByLabelText('star').getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'heart' } });
    fireEvent.click(screen.getByLabelText('heart'));

    /*
      One call, writing both fields, and no second item: `setItemProperties` edits in
      place. A handler that called `addIcon` would pass a test that only looked for a call
      to the timeline, which is why the assertion names the method.
    */
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], {
      iconName: 'heart',
      iconStrokeWidth: 3.5,
    });
    await waitFor(() => expect(screen.queryByText('Choose an icon')).toBeNull());
  });

  it('closes the re-pick dialog without touching the item', async () => {
    const state = makeState({ iconName: 'star', shapeKind: undefined });
    const timeline = renderInspector(state);
    fireEvent.click(screen.getByLabelText('Change icon'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Choose an icon')).toBeNull());
  });

  it('shows neither for an ordinary clip', () => {
    // The section is conditional on the item having geometry of its own; a video clip
    // has neither field and must not grow an empty row.
    renderInspector(makeState({ shapeKind: undefined, iconName: undefined }));
    expect(screen.queryByLabelText('Shape kind')).toBeNull();
    expect(screen.queryByLabelText('Icon stroke width')).toBeNull();
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

describe('the remaining animatable rows (SPEC 12 §2.4)', () => {
  it('offers a diamond on scale, position, rotation and every crop edge', () => {
    /*
      §2.4 asks for a diamond "per animatable property row". These are the rows the
      compositor actually reads — `itemGeometry` samples `transform.x/y`, both scale
      axes, rotation and the four crop edges every frame — so a row without a diamond
      would be a property the picture can animate and the sidebar cannot.
    */
    renderInspector(makeState());
    for (const label of [
      'Scale',
      'Rotation',
      'Anchor X',
      'Anchor Y',
      'Position X',
      'Position Y',
      'Crop left',
      'Crop right',
      'Crop top',
      'Crop bottom',
    ]) {
      expect(screen.getByLabelText(`Keyframe ${label} at the playhead`), label).toBeTruthy();
    }
  });

  it('writes position as a fraction of the canvas, not as a raw number', () => {
    // `transform.x` is a fraction so it means the same at proxy size and at export
    // size; the field shows a percentage because −1…1 is not a range users think in.
    const timeline = renderInspector(makeState());
    fireEvent.change(
      screen.getByLabelText('Horizontal position as a percentage of the canvas'),
      { target: { value: '25' } },
    );
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], {
      transform: { x: 0.25 },
    });
  });

  it('shows an existing position as a percentage', () => {
    const base = makeState();
    const state = makeState({ transform: { ...base.items['item-1']!.transform, x: -0.4, y: 0.1 } });
    render(<ItemInspector state={state} timeline={fakeTimeline(state)} />);
    expect(
      (screen.getByLabelText('Horizontal position as a percentage of the canvas') as HTMLInputElement).value,
    ).toBe('-40');
    expect(
      (screen.getByLabelText('Vertical position as a percentage of the canvas') as HTMLInputElement).value,
    ).toBe('10');
  });

  it('keys both scale axes from the Scale row\'s diamond too', () => {
    /*
      The diamond is the other way to create a key on this row, and it has the same
      obligation as the slider: a uniform scale is one control over two properties, so
      keying only `scaleX` would pin `scaleY` and stretch the clip the moment the
      animation started — with the stretch appearing at the click, not at the edit the
      user thought they were making.
    */
    const state = makeState();
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.click(screen.getByLabelText('Keyframe Scale at the playhead'));
    expect(timeline.addKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleX', 0, 1);
    expect(timeline.addKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleY', 0, 1);
  });

  it('removes both scale axes when the diamond clears a key', () => {
    // The mirror of the case above: leaving one axis keyed would animate half the
    // transform, which reads as the clip drifting apart.
    const state = makeState({
      keyframes: {
        'transform.scaleX': [{ timeUs: 0, value: 1, interpolation: 'linear' }],
        'transform.scaleY': [{ timeUs: 0, value: 1, interpolation: 'linear' }],
      },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.click(screen.getByLabelText('Keyframe Scale at the playhead'));
    expect(timeline.removeKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleX', 0);
    expect(timeline.removeKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleY', 0);
  });

  it('keys both scale axes from the single Scale field', () => {
    /*
      The static write already moves both axes; keying only `scaleX` would leave
      `scaleY` pinned and stretch the clip as the animation played. This is the one
      place where the "one row, one property" rule has to bend.

      A *uniform* clip is required for this test, because a non-uniform one shows two
      separate axis rows — each of which keys only its own axis, correctly, since the
      user set them separately and can see both.
    */
    const state = makeState({
      // Flat, dotted keys: the model stores keyframes in one record keyed by the
      // property path, not in a nested object per section.
      keyframes: { 'transform.scaleX': [{ timeUs: 0, value: 1, interpolation: 'linear' }] },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.change(screen.getByLabelText('Scale as a percentage'), { target: { value: '150' } });
    // The playhead is at the clip's start, where a key already exists on X, so this
    // updates rather than inserts — on both axes.
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleX', 0, { value: 1.5 });
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleY', 0, { value: 1.5 });
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('keys both axes even when only one was animated', () => {
    // An axis the user never touched must still move with its twin: leaving it
    // static would stretch the clip, which is what the shared field prevents.
    const state = makeState({
      keyframes: { 'transform.scaleX': [{ timeUs: 0, value: 1, interpolation: 'linear' }] },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    act(() => playheadStore.set(1_000_000));
    fireEvent.change(screen.getByLabelText('Scale as a percentage'), { target: { value: '150' } });
    expect(timeline.addKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleX', 1_000_000, 1.5);
    expect(timeline.addKeyframe).toHaveBeenCalledWith('item-1', 'transform.scaleY', 1_000_000, 1.5);
    act(() => playheadStore.set(0));
  });

  it('auto-keys a crop edge when that edge is already animated', () => {
    const state = makeState({
      keyframes: {
        'crop.left': [
          { timeUs: 0, value: 0, interpolation: 'linear' },
          { timeUs: 2_000_000, value: 0.5, interpolation: 'linear' },
        ],
      },
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.change(screen.getByLabelText('Crop left'), { target: { value: '20' } });
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('item-1', 'crop.left', 0, { value: 0.2 });
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('does not auto-key the other crop edges when only one is animated', () => {
    // These are genuinely independent properties: cropping the left edge over time
    // says nothing about the right one, and keying all four would animate edges the
    // user never touched.
    const state = makeState({
      keyframes: {
        crop: {
          left: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 2_000_000, value: 0.5, interpolation: 'linear' },
          ],
        },
      } as never,
    });
    const timeline = fakeTimeline(state);
    render(<ItemInspector state={state} timeline={timeline} />);
    fireEvent.change(screen.getByLabelText('Crop right'), { target: { value: '20' } });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['item-1'], { crop: { right: 0.2 } });
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
  });
});

describe('the animatable-property list is the contract (SPEC 12 §2.4)', () => {
  it('every listed property has a diamond in the inspector', () => {
    /*
      Walked from the list rather than restated in the test, so adding a property to
      the list without drawing its row fails here instead of quietly promising a
      control that does not exist. A uniform clip is used because that is the case
      where the two scale axes share one field.
    */
    renderInspector(makeState());
    for (const property of ANIMATABLE_PROPERTIES) {
      expect(
        screen.getByLabelText(`Keyframe ${property.label} at the playhead`),
        `${property.path} is listed as animatable but has no diamond`,
      ).toBeTruthy();
    }
  });

  it('every listed property, when animated, turns an edit into a keyframe', () => {
    /*
      The other half of §2.4: a diamond is easy to draw, but the rule is that an edit
      to an *animated* property becomes a keyframe. A listed property whose control
      still wrote the static value would make the user's edit invisible, because the
      evaluator reads the keys and ignores the static field.

      Driven through each row's own input, by its aria-label, so a row that loses its
      wiring fails here by name rather than passing on a neighbour's behaviour.
    */
    const inputFor: Record<string, { label: string; value: string }> = {
      opacity: { label: 'Clip opacity as a percentage', value: '50' },
      volumeDb: { label: 'Clip volume in decibels', value: '-12' },
      'transform.scaleX': { label: 'Scale as a percentage', value: '150' },
      'transform.scaleY': { label: 'Scale as a percentage', value: '150' },
      'transform.x': { label: 'Horizontal position as a percentage of the canvas', value: '25' },
      'transform.y': { label: 'Vertical position as a percentage of the canvas', value: '25' },
      'transform.rotation': { label: 'Rotation in degrees', value: '15' },
      'transform.anchorX': { label: 'Horizontal anchor as a percentage of the picture', value: '0' },
      'transform.anchorY': { label: 'Vertical anchor as a percentage of the picture', value: '0' },
      'crop.left': { label: 'Crop left', value: '20' },
      'crop.right': { label: 'Crop right', value: '20' },
      'crop.top': { label: 'Crop top', value: '20' },
      'crop.bottom': { label: 'Crop bottom', value: '20' },
      'crop.radius': { label: 'Crop radius', value: '20' },
    };

    for (const property of ANIMATABLE_PROPERTIES) {
      const driver = inputFor[property.path];
      expect(driver, `no input is mapped for ${property.path}`).toBeTruthy();

      const state = makeState({
        // The playhead is at 0, where a key already exists, so the edit takes the
        // update branch for every property.
        keyframes: {
          [property.path]: [
            { timeUs: 0, value: property.path === 'volumeDb' ? 0 : 1, interpolation: 'linear' },
            { timeUs: 3_000_000, value: property.path === 'volumeDb' ? -6 : 2, interpolation: 'linear' },
          ],
        },
      });
      const timeline = fakeTimeline(state);
      const { unmount } = render(<ItemInspector state={state} timeline={timeline} />);
      fireEvent.change(screen.getByLabelText(driver!.label), { target: { value: driver!.value } });
      expect(
        timeline.setItemProperties,
        `${property.path} was animated but the edit still wrote the static value`,
      ).not.toHaveBeenCalled();
      // The uniform Scale field keys both axes, so either axis's key counts here.
      const keyed =
        (timeline.updateKeyframe as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (call) => call[0] === 'item-1' && call[1] === property.path,
        );
      expect(keyed, `${property.path} was animated but no keyframe was written`).toBe(true);
      unmount();
    }
  });
});
