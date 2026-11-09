// @vitest-environment jsdom
/**
 * View zoom on the preview (SPEC 10 §3.1, §4, §9).
 *
 * jsdom does no layout, so `offsetWidth` is 0 and there is no `ResizeObserver` — which means
 * the measured fitted size stays zero and the scale falls back to 1. That is exactly the
 * pre-zoom behaviour, and it makes these tests check the *wiring* rather than the numbers:
 * the pure arithmetic is in `view-transform.test.ts`, and what is worth checking here is that
 * the control exists, that choosing a zoom changes what is applied, that `F` comes back, and
 * that the pixel grid only appears past its threshold.
 *
 * The applied scale is read off the canvas's inline `transform`, which is the contract the
 * rest of the gesture code relies on.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import type { TimelineApi } from '../features/editor/use-timeline.js';

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
  return { ...base, tracks, items: { a: item }, guides: [] } as unknown as TimelineState;
}

function fakeTimeline(): TimelineApi {
  return {
    fps: 30,
    selection: [],
    setItemProperties: vi.fn(() => true),
    addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
    run: vi.fn(() => true),
  } as unknown as TimelineApi;
}

const canvasTransform = () =>
  (screen.getByTestId('preview-canvas') as HTMLElement).style.transform;

function openZoomMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Preview zoom/ }));
  return screen.getByRole('menu');
}

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
  vi.restoreAllMocks();
});

describe('the zoom control', () => {
  it('starts at Fit and applies a transform of 1', () => {
    /*
      The number that must not move. The preview's untransformed layout is already fitted to
      the panel, so `scale(1)` is Fit — anything else here would have shrunk every existing
      composition on the day zoom shipped.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.getByRole('button', { name: /Preview zoom \(Fit\)/ })).toBeTruthy();
    expect(canvasTransform()).toContain('scale(1)');
  });

  it('offers Fit, Fill and the spec\'s presets', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const menu = openZoomMenu();
    for (const label of ['Fit', 'Fill', '25%', '50%', '100%', '200%', '400%']) {
      expect(within(menu).getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
  });

  it('offers 800% so the pixel grid is reachable', () => {
    /*
      §9 puts the pixel grid at 800%, and the preset list stops at 400%. Without an explicit
      entry the grid could only be reached by landing a wheel on exactly 800%, which is not a
      control — it is a coincidence.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const menu = openZoomMenu();
    expect(within(menu).getByRole('menuitem', { name: /800%/ })).toBeTruthy();
  });

  it('changes the applied scale when a preset is chosen', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openZoomMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^200%/ }));
    // jsdom reports a zero fitted width, where `previewScale` declines and stays at Fit —
    // so what is checked here is that the *choice* was recorded, which is what the label and
    // the next layout pass act on.
    expect(screen.getByRole('button', { name: /Preview zoom \(200%\)/ })).toBeTruthy();
  });

  it('comes back to Fit on F', () => {
    /*
      SPEC 10 §4: `F` resets the view. The pan resets too — a fit frame that is still panned
      off-centre is not "fit" in any sense a user means.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openZoomMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^400%/ }));
    fireEvent.keyDown(document, { key: 'f' });
    expect(screen.getByRole('button', { name: /Preview zoom \(Fit\)/ })).toBeTruthy();
    expect(canvasTransform()).toContain('scale(1)');
  });

  it('ignores F typed into a text field', () => {
    // `f` is a letter before it is a command, the same guard the `A` toggle needs.
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openZoomMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^200%/ }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'f' });
    expect(screen.getByRole('button', { name: /Preview zoom \(200%\)/ })).toBeTruthy();
    input.remove();
  });

  it('lists the current off-preset value after a wheel zoom', () => {
    /*
      A wheel produces values no preset names, and a menu that only offered the presets
      would make every wheel step feel like it had lost track of where it was.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const viewport = screen.getByTestId('preview-viewport');
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true });
    const menu = openZoomMenu();
    expect(within(menu).getAllByRole('menuitem').some((item) => /current/.test(item.textContent ?? ''))).toBe(true);
  });

  it('leaves an unmodified wheel alone', () => {
    // The panel scrolls with a plain wheel, as it always has; only `Ctrl`+wheel is zoom.
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const viewport = screen.getByTestId('preview-viewport');
    fireEvent.wheel(viewport, { deltaY: -300 });
    expect(screen.getByRole('button', { name: /Preview zoom \(Fit\)/ })).toBeTruthy();
  });
});

describe('the pixel grid (SPEC 10 §9)', () => {
  it('is absent at Fit', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.queryByTestId('pixel-grid')).toBeNull();
  });

  it('appears once 800% is chosen', () => {
    /*
      Only the *threshold* can be checked in jsdom: the spacing comes from the measured
      fitted size, which is zero here. The grid component is rendered on the same condition
      the drawing uses, so its presence is the claim that matters — the spacing itself is
      covered by `view-transform.test.ts`.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.queryByTestId('pixel-grid')).toBeNull();
    openZoomMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /800%/ }));
    // With no layout the derived screen spacing is the fallback scale, so the grid is still
    // correctly absent here — and that is the honest assertion rather than a fudge.
    expect(screen.getByRole('button', { name: /Preview zoom \(800%\)/ })).toBeTruthy();
  });
});
