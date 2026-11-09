// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  guides: Array<{ id: string; axis: 'x' | 'y'; at: number }> = [],
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
  return { ...base, tracks, items: { a: item }, guides } as unknown as TimelineState;
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
    expect(timeline.run).not.toHaveBeenCalled();
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
});
