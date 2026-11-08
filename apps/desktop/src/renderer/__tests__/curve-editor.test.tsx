// @vitest-environment jsdom
/**
 * SPEC 12 §2.6 — the curve editor.
 *
 * Keyframes could be created, moved and removed on the timeline lane, and their
 * easing picked from a dropdown of the eleven named presets, but the `bezier` field
 * the schema and the evaluator have always supported was unreachable: no command
 * could write it. These tests cover the two halves of closing that — that a handle
 * writes the shape the user dragged, and that the graph shows what is stored.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineState } from '@clipwright/timeline-engine';
import { Button, IconButton } from '@clipwright/design-system';
import { CurveEditor, curveSeriesFor, seriesColour, valueRange, SERIES_COLOURS } from '../features/editor/CurveEditor.js';
import type { TimelineApi } from '../features/editor/use-timeline.js';

// The drawer renders design-system buttons, which need a toast context in some
// builds; stubbing them keeps this file about the curve maths.
vi.mock('@clipwright/design-system', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  IconButton: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick} />
  ),
}));

afterEach(() => cleanup());

void Button;
void IconButton;

function stateWithKeyframes(
  keyframes: Record<string, Array<Record<string, unknown>>>,
  durationUs = 2_000_000,
): TimelineState {
  return {
    tracks: [{ id: 'track-main', kind: 'video', itemIds: ['item-1'] }],
    items: {
      'item-1': {
        id: 'item-1',
        trackId: 'track-main',
        type: 'video',
        startUs: 0,
        durationUs,
        sourceInUs: 0,
        sourceDurationUs: 5_000_000,
        keyframes,
        disabled: false,
        muted: false,
        locked: false,
      },
    },
  } as unknown as TimelineState;
}

function fakeTimeline(state: TimelineState): TimelineApi {
  return {
    state,
    fps: 30,
    setBezierHandles: vi.fn(() => true),
  } as unknown as TimelineApi;
}

describe('curve editor geometry (SPEC 12 §2.6)', () => {
  it('graphs only numeric properties', () => {
    // A colour keyframe's value is an RGBA tuple. Plotting "the red channel" and
    // calling it the property's curve would be a quiet lie about what the graph
    // means, so it is left out rather than approximated.
    const state = stateWithKeyframes({
      opacity: [{ timeUs: 0, value: 0, interpolation: 'linear' }],
      'text.fill': [{ timeUs: 0, value: [1, 0, 0, 1], interpolation: 'linear' }],
    });
    const series = curveSeriesFor(state.items['item-1']);
    expect(series.map((entry) => entry.property)).toEqual(['opacity']);
  });

  it('orders keys by time however they are stored', () => {
    // The engine sorts on write, but a file from another tool need not, and a graph
    // drawn from unsorted keys zig-zags back on itself.
    const state = stateWithKeyframes({
      opacity: [
        { timeUs: 1_000_000, value: 1, interpolation: 'linear' },
        { timeUs: 0, value: 0, interpolation: 'linear' },
      ],
    });
    const series = curveSeriesFor(state.items['item-1']);
    expect(series[0]!.keyframes.map((keyframe) => keyframe.timeUs)).toEqual([0, 1_000_000]);
  });

  it('skips properties whose keys are all non-numeric', () => {
    const state = stateWithKeyframes({
      'text.fill': [{ timeUs: 0, value: [1, 0, 0, 1], interpolation: 'linear' }],
    });
    expect(curveSeriesFor(state.items['item-1'])).toEqual([]);
  });

  it('gives a flat line a window instead of collapsing it onto an axis', () => {
    // One keyframe means a constant value. A zero-height range would divide by zero
    // when mapping to the graph and put the line at the top or bottom rather than
    // through the middle.
    const flat = valueRange([{ timeUs: 0, value: 5, interpolation: 'linear' }]);
    expect(flat.max).toBeGreaterThan(flat.min);
    expect((flat.min + flat.max) / 2).toBeCloseTo(5, 6);

    // Zero is a common constant and the naive "pad by 10 % of the value" gives 0.
    const zero = valueRange([{ timeUs: 0, value: 0, interpolation: 'linear' }]);
    expect(zero.max).toBeGreaterThan(zero.min);
  });

  it('spans the real range when the values differ', () => {
    const range = valueRange([
      { timeUs: 0, value: 0.2, interpolation: 'linear' },
      { timeUs: 1_000_000, value: 0.8, interpolation: 'linear' },
    ]);
    expect(range.min).toBeCloseTo(0.2, 6);
    expect(range.max).toBeCloseTo(0.8, 6);
  });

  it('never draws a series in the brand colour', () => {
    // §2.6 asks for per-property colours that are "muted, never orange": orange is
    // the brand, and a data line in it reads as an interactive control.
    for (let index = 0; index < SERIES_COLOURS.length * 2; index += 1) {
      const colour = seriesColour(index);
      expect(colour.toLowerCase()).not.toContain('brand');
      expect(colour.toLowerCase()).not.toContain('ff8a1f');
    }
    // Cycling is total, so an item with more properties than colours still draws.
    expect(seriesColour(SERIES_COLOURS.length)).toBe(SERIES_COLOURS[0]);
  });
});

describe('curve editor interaction (SPEC 12 §2.6)', () => {
  const twoKeys = {
    opacity: [
      { timeUs: 0, value: 0, interpolation: 'linear' },
      { timeUs: 1_000_000, value: 1, interpolation: 'linear' },
    ],
  };

  it('says so when nothing is selected rather than drawing an empty graph', () => {
    // A blank graph reads as a bug; a clip with no keys is a real and common state.
    const state = stateWithKeyframes({});
    render(
      <CurveEditor
        state={state}
        timeline={fakeTimeline(state)}
        itemId={null}
        fps={30}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/Select a clip/)).toBeTruthy();
  });

  it('explains a clip that has no keyframes', () => {
    const state = stateWithKeyframes({});
    render(
      <CurveEditor
        state={state}
        timeline={fakeTimeline(state)}
        itemId="item-1"
        fps={30}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/no keyframed properties/)).toBeTruthy();
  });

  it('draws one diamond per keyframe', () => {
    const state = stateWithKeyframes(twoKeys);
    render(
      <CurveEditor
        state={state}
        timeline={fakeTimeline(state)}
        itemId="item-1"
        fps={30}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('curve-key-0')).toBeTruthy();
    expect(screen.getByTestId('curve-key-1000000')).toBeTruthy();
  });

  it('offers handles only once a key with a following segment is selected', () => {
    // Easing governs the segment *leaving* a key, so the last key has no curve to
    // shape. Showing handles there would offer a drag that changes nothing.
    const state = stateWithKeyframes(twoKeys);
    render(
      <CurveEditor
        state={state}
        timeline={fakeTimeline(state)}
        itemId="item-1"
        fps={30}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByTestId('handle-out')).toBeNull();

    fireEvent.click(screen.getByTestId('curve-key-0'));
    expect(screen.getByTestId('handle-out')).toBeTruthy();
    expect(screen.getByTestId('handle-in')).toBeTruthy();
  });

  it('shows no handles on the last key', () => {
    const state = stateWithKeyframes(twoKeys);
    render(
      <CurveEditor
        state={state}
        timeline={fakeTimeline(state)}
        itemId="item-1"
        fps={30}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('curve-key-1000000'));
    expect(screen.queryByTestId('handle-out')).toBeNull();
    expect(screen.getByText(/no following segment/)).toBeTruthy();
  });

  it('writes the dragged handle as a proportion of the segment', () => {
    /*
      The write happens on release, so a drag is one undo step. The pointer is placed
      at the *start* of the segment to make the expected ratio unambiguous: 0 across,
      and half-way up the segment's value span.
    */
    const state = stateWithKeyframes(twoKeys);
    const timeline = fakeTimeline(state);
    render(
      <CurveEditor state={state} timeline={timeline} itemId="item-1" fps={30} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getByTestId('curve-key-0'));

    /*
      Stub the box on the element the handler will read, not on a fresh query: the
      handler goes through `event.currentTarget.ownerSVGElement`, and jsdom returns a
      new DOMRect from `getBoundingClientRect` on every call, so an override placed
      on some other reference is never seen.
    */
    const svg = (screen.getByTestId('handle-out') as unknown as SVGElement).ownerSVGElement!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    // x = 0 is the left edge, which is outX = 0. y = 50 is mid-graph; the segment
    // runs from the bottom (value 0) to the top (value 1), so the middle is outY 0.5.
    /*
      `fireEvent.pointerUp(el, { clientX })` silently drops the coordinates in this
      jsdom build — verified with a bare probe, which read `undefined`. Constructing
      the event and dispatching it with `fireEvent(el, event)` does carry them.
    */
    fireEvent(
      screen.getByTestId('handle-out'),
      new MouseEvent('pointerup', { clientX: 0, clientY: 50, bubbles: true }),
    );
    expect(timeline.setBezierHandles).toHaveBeenCalledTimes(1);
    const [itemId, property, timeUs, bezier] = (timeline.setBezierHandles as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]!;
    expect(itemId).toBe('item-1');
    expect(property).toBe('opacity');
    expect(timeUs).toBe(0);
    expect((bezier as { outX: number }).outX).toBeCloseTo(0, 6);
    expect((bezier as { outY: number }).outY).toBeCloseTo(0.5, 6);
    // The untouched handle keeps the default, or the first drag would silently reset
    // the other end of the curve.
    expect((bezier as { inX: number }).inX).toBeCloseTo(0.58, 6);
  });
});
