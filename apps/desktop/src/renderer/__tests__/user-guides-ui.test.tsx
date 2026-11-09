// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';

/**
 * User guides on the canvas (SPEC 10 §8.8): drawn, and creatable by `Ctrl`-dragging in
 * from a viewport edge.
 */

function makeState(
  guides: Array<{ id: string; axis: 'x' | 'y'; at: number; locked?: boolean }> = [],
): TimelineState {
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
  return {
    ...base,
    tracks,
    items: { a: item },
    guides: guides.map((guide) => ({ locked: false, ...guide })),
  } as unknown as TimelineState;
}

function fakeTimeline(): TimelineApi {
  return {
    fps: 30,
    selection: [],
    setItemProperties: vi.fn(() => true),
    addKeyframe: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
    run: vi.fn(() => true),
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

const ctrlDrag = (from: [number, number], to: [number, number]) => {
  const canvas = screen.getByTestId('preview-canvas');
  fireEvent(canvas, new MouseEvent('pointerdown', { clientX: from[0], clientY: from[1], ctrlKey: true, bubbles: true }));
  fireEvent(canvas, new MouseEvent('pointermove', { clientX: to[0], clientY: to[1], ctrlKey: true, bubbles: true }));
  fireEvent(canvas, new MouseEvent('pointerup', { clientX: to[0], clientY: to[1], ctrlKey: true, bubbles: true }));
};

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
  vi.restoreAllMocks();
});

describe('drawing user guides', () => {
  it('draws nothing when the project has none', () => {
    stubLayout();
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.queryByTestId('user-guides')).toBeNull();
  });

  it('draws a vertical guide at the stored fraction', () => {
    /*
      A guide is stored as a fraction from the top-left, which is the space CSS positions
      in, so 0.25 is 25% across with no conversion. The half-canvas shift belongs only in
      the snap-target path; doing it here too would cancel out and look symmetrical while
      being wrong.
    */
    stubLayout();
    render(
      <PreviewPane
        state={makeState([{ id: 'g1', axis: 'x', at: 0.25 }])}
        fps={30}
        timeline={fakeTimeline()}
      />,
    );
    expect(screen.getByTestId('user-guide-g1').style.left).toBe('25%');
  });

  it('draws a horizontal guide on the y axis', () => {
    stubLayout();
    render(
      <PreviewPane
        state={makeState([{ id: 'g1', axis: 'y', at: 0.6 }])}
        fps={30}
        timeline={fakeTimeline()}
      />,
    );
    expect(screen.getByTestId('user-guide-g1').style.top).toBe('60%');
  });

  it('draws every guide, whether or not a compliance overlay is on', () => {
    /*
      Unlike the safe areas, these are the user's own marks: they are on screen whenever
      the project is open, because the user put them there. Tying them to `Ctrl+;` would
      make the alignment lines vanish exactly when someone is arranging a shot.
    */
    stubLayout();
    render(
      <PreviewPane
        state={makeState([
          { id: 'g1', axis: 'x', at: 0.2 },
          { id: 'g2', axis: 'y', at: 0.8 },
        ])}
        fps={30}
        timeline={fakeTimeline()}
      />,
    );
    expect(screen.getByTestId('user-guide-g1')).toBeTruthy();
    expect(screen.getByTestId('user-guide-g2')).toBeTruthy();
    // And the area overlay is still off, which is the point of the contrast.
    expect(screen.queryByTestId('overlay-safe-area')).toBeNull();
  });
});

describe('creating a guide with Ctrl and a drag from an edge', () => {
  it('makes a vertical guide from a drag off the left edge', () => {
    /*
      Pull from the side, get a line parallel to that side: a drag beginning at the left
      edge makes a guide with a fixed x, placed where the pointer is released.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    ctrlDrag([4, 200], [120, 200]);
    expect(timeline.run).toHaveBeenCalled();
    const command = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(command?.[0]).toBe('Add guide');
  });

  it('does not make a guide when the Ctrl-drag starts on a clip', () => {
    /*
      The layer sits inside the canvas, so its pointer-down bubbles to the canvas handler.
      Without the origin check one gesture both moved the picture and left a line behind —
      the same "two things at once" that the rotate handle stops propagation to avoid.
      Checked from the canvas edge so the *only* reason no guide appears is the origin.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, new MouseEvent('pointerdown', { clientX: 10, clientY: 200, ctrlKey: true, bubbles: true }));
    fireEvent(layer, new MouseEvent('pointermove', { clientX: 100, clientY: 200, ctrlKey: true, bubbles: true }));
    fireEvent(layer, new MouseEvent('pointerup', { clientX: 100, clientY: 200, ctrlKey: true, bubbles: true }));
    const guideCalls = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'Add guide',
    );
    expect(guideCalls).toHaveLength(0);
  });

  it('ignores a Ctrl-drag that does not start at an edge', () => {
    // An ordinary `Ctrl`-drag over the picture is not a gesture this surface gives a
    // meaning; making a guide there would be a surprise.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    ctrlDrag([200, 200], [260, 200]);
    expect(timeline.run).not.toHaveBeenCalled();
  });

  it('ignores a drag that is not Ctrl-modified', () => {
    // Without the modifier this is an ordinary drag, which the layers handle.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    const canvas = screen.getByTestId('preview-canvas');
    fireEvent(canvas, new MouseEvent('pointerdown', { clientX: 4, clientY: 200, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointerup', { clientX: 120, clientY: 200, bubbles: true }));
    expect(timeline.run).not.toHaveBeenCalled();
  });

  it('places the guide where the pointer was released, not where it started', () => {
    /*
      The gesture exists so a user can pull a line in from the edge and let go where the
      subject actually is. A guide fixed at the edge it came from would mean always
      dragging it twice.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    ctrlDrag([4, 200], [100, 200]);
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      state: TimelineState,
    ) => { state: TimelineState };
    const result = runCommand(makeState());
    // 100 px of 400 is a quarter across.
    expect(result.state.guides[0]!.at).toBeCloseTo(0.25, 6);
    expect(result.state.guides[0]!.axis).toBe('x');
  });

  it('makes a horizontal guide from a drag off the top edge', () => {
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    ctrlDrag([200, 4], [200, 300]);
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      state: TimelineState,
    ) => { state: TimelineState };
    const result = runCommand(makeState());
    expect(result.state.guides[0]!.axis).toBe('y');
    expect(result.state.guides[0]!.at).toBeCloseTo(0.75, 6);
  });

  it('removes a guide with Shift and a Ctrl-drag', () => {
    /*
      The inverse gesture, and the reason it reads `shiftKey` at pointer-*down*: a
      `pointerup` carries no modifier state, so reading it at release would always be
      false and the removal would silently never fire.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'gone', axis: 'x', at: 0.25 }])}
        fps={30}
        timeline={timeline}
      />,
    );
    const canvas = screen.getByTestId('preview-canvas');
    const down = new MouseEvent('pointerdown', {
      clientX: 4, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true,
    });
    fireEvent(canvas, down);
    fireEvent(canvas, new MouseEvent('pointermove', { clientX: 100, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointerup', { clientX: 100, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    const calls = (timeline.run as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toBe('Remove guide');
    // And the command it handed over resolves the reach itself, against the state it is
    // given rather than the list this render saw — so the id is right for *that* state.
    const removeCommand = calls.at(-1)?.[1] as (current: TimelineState) => { state: TimelineState } | null;
    const after = removeCommand(makeState([{ id: 'gone', axis: 'x', at: 0.25 }]));
    expect(after?.state.guides).toEqual([]);
  });

  it('adds rather than removes when Shift is not held', () => {
    // The two gestures differ by one modifier and one of them destroys work, so the
    // distinction is checked in both directions.
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'keep', axis: 'x', at: 0.25 }])}
        fps={30}
        timeline={timeline}
      />,
    );
    const canvas = screen.getByTestId('preview-canvas');
    fireEvent(canvas, new MouseEvent('pointerdown', { clientX: 4, clientY: 200, ctrlKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointermove', { clientX: 300, clientY: 200, ctrlKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointerup', { clientX: 300, clientY: 200, ctrlKey: true, bubbles: true }));
    const calls = (timeline.run as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toBe('Add guide');
  });

  it('removes nothing when the Shift-drag is nowhere near a guide', () => {
    /*
      A removal gesture on a sparse canvas must not delete whatever happens to be nearest:
      the user would have no idea what they just lost.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'far', axis: 'x', at: 0.9 }])}
        fps={30}
        timeline={timeline}
      />,
    );
    const canvas = screen.getByTestId('preview-canvas');
    fireEvent(canvas, new MouseEvent('pointerdown', { clientX: 4, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointermove', { clientX: 80, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointerup', { clientX: 80, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    /*
      The gesture still reports itself to `run` — the reach is resolved inside the command,
      against live state — but the command must answer `null`, because `run` treats a
      `CommandResult` with `ok: false` as something to tell the user about, and a
      removal that found nothing is not.
    */
    const calls = (timeline.run as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toBe('Remove guide');
    const removeCommand = calls.at(-1)?.[1] as (current: TimelineState) => unknown;
    expect(removeCommand(makeState([{ id: 'far', axis: 'x', at: 0.9 }]))).toBeNull();
  });

  it('replaces a guide placed practically on top of an existing one', () => {
    // Two targets a hair apart would make the snap a coin toss and the canvas impossible
    // to tidy without deleting twice.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'old', axis: 'x', at: 0.25 }])} fps={30} timeline={timeline} />);
    ctrlDrag([4, 200], [100, 200]);
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      state: TimelineState,
    ) => { state: TimelineState };
    const result = runCommand(makeState([{ id: 'old', axis: 'x', at: 0.25 }]));
    expect(result.state.guides).toHaveLength(1);
    expect(result.state.guides[0]!.id).not.toBe('old');
  });

  it('does not replace a locked guide from the creating gesture', () => {
    /*
      The corner the two rules meet in. *Ctrl*-drag lands within 0.005 of a locked guide:
      the replacement rule wants to overwrite it, and *Lock* says no. Lock wins — otherwise
      the one gesture Lock exists to guard becomes the way around it.
    */
    stubLayout();
    const timeline = fakeTimeline();
    const state = makeState([{ id: 'protected', axis: 'x', at: 0.25, locked: true }]);
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    ctrlDrag([4, 200], [100, 200]);
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      current: TimelineState,
    ) => { state: TimelineState };
    const result = runCommand(state);
    expect(result.state.guides.map((guide) => guide.id)).toEqual(['protected', expect.any(String)]);
    expect(result.state.guides).toHaveLength(2);
  });

  it('does not remove a locked guide with Shift and a Ctrl-drag', () => {
    // The removal gesture, over the exact position of a locked guide.
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'protected', axis: 'x', at: 0.25, locked: true }])}
        fps={30}
        timeline={timeline}
      />,
    );
    const canvas = screen.getByTestId('preview-canvas');
    fireEvent(canvas, new MouseEvent('pointerdown', { clientX: 4, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointermove', { clientX: 100, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    fireEvent(canvas, new MouseEvent('pointerup', { clientX: 100, clientY: 200, ctrlKey: true, shiftKey: true, bubbles: true }));
    /*
      The gesture reports itself, and the command — resolving the reach against the state
      it is handed — finds nothing removable and answers `null`. That is the guarantee that
      matters: a locked guide leaves no undo step behind, and `run` stays silent.
    */
    const calls = (timeline.run as ReturnType<typeof vi.fn>).mock.calls;
    const names = calls.map((call) => call[0]);
    expect(names).not.toContain('Add guide');
    const removeCommand = calls.at(-1)?.[1] as (current: TimelineState) => unknown;
    expect(removeCommand(makeState([{ id: 'protected', axis: 'x', at: 0.25, locked: true }]))).toBeNull();
  });
});

describe('the Guides menu (SPEC 10 §8.8)', () => {
  const openMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: /Guides/ }));
    return screen.getByRole('menu');
  };
  const item = (label: RegExp) => within(screen.getByRole('menu')).getByRole('menuitem', { name: label });

  it('opens from the transport strip', () => {
    stubLayout();
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.queryByRole('menu')).toBeNull();
    const menu = openMenu();
    expect(menu).toBeTruthy();
  });

  it('offers both orientations, lock and clear', () => {
    stubLayout();
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openMenu();
    expect(item(/Add horizontal guide/)).toBeTruthy();
    expect(item(/Add vertical guide/)).toBeTruthy();
    expect(item(/Lock guides/)).toBeTruthy();
    expect(item(/Clear guides/)).toBeTruthy();
  });

  it('adds a vertical guide down the middle of the composition', () => {
    /*
      A position has to be chosen for a menu-made guide, and the middle is the only one
      that is not already occupied by an edge handle. It is a starting point, not a
      preference: the user drags it where they want it.
    */
    stubLayout();
    const timeline = fakeTimeline();
    const state = makeState();
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    openMenu();
    fireEvent.click(item(/Add vertical guide/));
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      current: TimelineState,
    ) => { state: TimelineState };
    const result = runCommand(state);
    expect(result.state.guides).toEqual([
      { id: expect.any(String), axis: 'x', at: 0.5, locked: false },
    ]);
  });

  it('adds a horizontal guide on the other axis', () => {
    // The axis is a full-width line's fixed coordinate: horizontal means fixed `y`, which
    // is the axis the gestures call `'y'` too.
    stubLayout();
    const timeline = fakeTimeline();
    const state = makeState();
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    openMenu();
    fireEvent.click(item(/Add horizontal guide/));
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      current: TimelineState,
    ) => { state: TimelineState };
    expect(runCommand(state).state.guides[0]).toMatchObject({ axis: 'y', at: 0.5 });
  });

  it('locks every guide, and the item then offers to unlock', () => {
    stubLayout();
    const timeline = fakeTimeline();
    const state = makeState([{ id: 'g1', axis: 'x', at: 0.25 }]);
    const { rerender } = render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    openMenu();
    fireEvent.click(item(/^Lock guides/));
    expect((timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('Lock guides');

    /*
      And back again. Checking only that the label flipped would prove nothing about what
      the item *does*: the label comes from the state, while the argument has to come from
      the menu. So this runs the command the unlocked menu hands over and reads the guides
      that come out.
    */
    rerender(
      <PreviewPane
        state={makeState([{ id: 'g1', axis: 'x', at: 0.25, locked: true }])}
        fps={30}
        timeline={timeline}
      />,
    );
    openMenu();
    const unlock = item(/Unlock guides/);
    fireEvent.click(unlock);
    const unlockCall = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(unlockCall[0]).toBe('Unlock guides');
    const unlockCommand = unlockCall[1] as (current: TimelineState) => { state: TimelineState };
    const unlocked = unlockCommand(makeState([{ id: 'g1', axis: 'x', at: 0.25, locked: true }]));
    expect(unlocked.state.guides).toEqual([{ id: 'g1', axis: 'x', at: 0.25, locked: false }]);
  });

  it('keeps a guide placed while the menu was open', () => {
    /*
      `setGuides` replaces the whole array, so the list this item builds must come from the
      state the *command* is handed, not from the one the menu was rendered with. Otherwise
      a `Ctrl`-drag that lands while the menu is open is silently discarded by the next
      click — the menu and the gesture look independent, and the menu would undo it.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    openMenu();
    fireEvent.click(item(/Add vertical guide/));
    const runCommand = (timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (
      current: TimelineState,
    ) => { state: TimelineState };
    // The command is applied to a state that gained a guide after the menu was rendered.
    const result = runCommand(makeState([{ id: 'meanwhile', axis: 'x', at: 0.2 }]));
    expect(result.state.guides.map((guide) => guide.id)).toContain('meanwhile');
    expect(result.state.guides).toHaveLength(2);
  });

  it('says Clear will keep locked guides when any are locked', () => {
    // A menu that promises to clear everything and silently spares some is worse than one
    // that says what it will do.
    stubLayout();
    render(
      <PreviewPane
        state={makeState([{ id: 'g1', axis: 'x', at: 0.25, locked: true }])}
        fps={30}
        timeline={fakeTimeline()}
      />,
    );
    openMenu();
    expect(item(/Clear unlocked guides/)).toBeTruthy();
  });

  it('disables Lock and Clear when there are no guides', () => {
    stubLayout();
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openMenu();
    // A plain property read: this suite has no jest-dom matchers installed.
    expect((item(/Lock guides/) as HTMLButtonElement).disabled).toBe(true);
    expect((item(/Clear guides/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs Clear as a command, so it can be undone', () => {
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([
          { id: 'g1', axis: 'x', at: 0.25 },
          { id: 'g2', axis: 'y', at: 0.75 },
        ])}
        fps={30}
        timeline={timeline}
      />,
    );
    openMenu();
    fireEvent.click(item(/Clear guides/));
    expect((timeline.run as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('Clear guides');
  });
});

describe('the Guides button toggling', () => {
  it('closes the menu when the button is clicked again', () => {
    /*
      `Menu` closes on any `mousedown` outside itself, and the button *is* outside it. That
      listener runs before the click, so a naive toggle opens the menu again on the same
      press and the button never closes what it opened — the menu would only ever go away
      by clicking elsewhere.
    */
    stubLayout();
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const button = screen.getByRole('button', { name: /Guides/ });
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).not.toBeNull();
    // A press: `mousedown` first, as a browser sends it, then the click.
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
