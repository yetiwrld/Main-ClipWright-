// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { SnapGuides, guidePercent } from '../features/editor/SnapGuides.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';

/**
 * The guides a snap draws (SPEC 10 §8.8).
 *
 * Snapping already moves the picture correctly; what these check is that the movement is
 * *explained* — a line appears on the target while the drag is in progress, and goes when
 * it ends.
 */

function makeState(transform: Record<string, number> = {}): TimelineState {
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
    transform,
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

const pointer = (type: string, clientX: number, clientY: number) =>
  new MouseEvent(type, { clientX, clientY, bubbles: true });

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('drawing a snap guide', () => {
  it('converts a canvas fraction to a percentage from the top-left', () => {
    /*
      Targets are fractions measured from the canvas *centre*; CSS positions from the
      top-left. Getting the half-canvas shift wrong draws the line somewhere plausible
      and wrong, which is worse than not drawing it.
    */
    expect(guidePercent(-0.5)).toBe(0);
    expect(guidePercent(0)).toBe(50);
    expect(guidePercent(0.5)).toBe(100);
    expect(guidePercent(-0.25)).toBe(25);
  });

  it('draws nothing when nothing is snapped', () => {
    render(<SnapGuides guides={{ x: null, y: null }} />);
    expect(screen.queryByTestId('snap-guides')).toBeNull();
  });

  it('draws one line per snapped axis', () => {
    render(<SnapGuides guides={{ x: { at: 0, kind: 'canvas-centre' }, y: null }} />);
    expect(screen.getByTestId('snap-guide-x')).toBeTruthy();
    expect(screen.queryByTestId('snap-guide-y')).toBeNull();
  });

  it('puts the line on the target it names', () => {
    // A canvas-centre target is at fraction 0, which is 50% across.
    render(<SnapGuides guides={{ x: { at: 0, kind: 'canvas-centre' }, y: null }} />);
    expect(screen.getByTestId('snap-guide-x').style.left).toBe('50%');
  });

  it('shows during a drag and goes when it ends', () => {
    /*
      The behaviour that makes the guide an affordance rather than a decoration. A line
      left behind after release would claim the clip is still aligned to something when it
      is simply where it ended up.
    */
    stubLayout();
    render(<PreviewPane state={makeState({ x: 0.1 })} fps={30} timeline={fakeTimeline()} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 200));
    // 0.1 minus 0.095 lands within 8 px of the centre line, so it snaps and shows a guide.
    fireEvent(layer, pointer('pointermove', 162, 200));
    expect(screen.getByTestId('snap-guides')).toBeTruthy();

    fireEvent(layer, pointer('pointerup', 162, 200));
    expect(screen.queryByTestId('snap-guides')).toBeNull();
  });

  it('shows no guide while Alt bypasses snapping', () => {
    /*
      `Alt` means "let me put it exactly here". A guide drawn anyway would contradict the
      modifier and, worse, suggest the clip had been pulled when it had not.
    */
    stubLayout();
    render(<PreviewPane state={makeState({ x: 0.1 })} fps={30} timeline={fakeTimeline()} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, new MouseEvent('pointerdown', { clientX: 200, clientY: 200, altKey: true, bubbles: true }));
    fireEvent(layer, new MouseEvent('pointermove', { clientX: 162, clientY: 200, altKey: true, bubbles: true }));
    expect(screen.queryByTestId('snap-guides')).toBeNull();
  });

  it('drops the guide when the drag is cancelled with Escape', () => {
    // `Esc` abandons the gesture, and the guide belongs to the gesture.
    stubLayout();
    render(<PreviewPane state={makeState({ x: 0.1 })} fps={30} timeline={fakeTimeline()} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 200));
    fireEvent(layer, pointer('pointermove', 162, 200));
    expect(screen.getByTestId('snap-guides')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('snap-guides')).toBeNull();
  });
});
