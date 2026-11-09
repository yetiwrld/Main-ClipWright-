// @vitest-environment jsdom
/**
 * The preview's view gestures (SPEC 10 §3.1, §4, §8.2): the **Handles** toggle, the **Pan
 * view** tool, and Space+drag.
 *
 * jsdom does no layout, so the fitted size stays zero and `previewScale` falls back to 1 —
 * which means panning is bounded to zero here. That is deliberate: the arithmetic is checked
 * in `view-tool.test.ts`, and what these tests are for is the *wiring* — that the toggle
 * hides the handles, that a pan press does not move the clip, and that Space is not stolen
 * from the transport.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

let setItemProperties: ReturnType<typeof vi.fn>;

function fakeTimeline(): TimelineApi {
  setItemProperties = vi.fn(() => true);
  return {
    fps: 30,
    selection: ['a'],
    setItemProperties,
    addKeyframe: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
    run: vi.fn(() => true),
  } as unknown as TimelineApi;
}

/** The canvas and the picture both measure 400×400 at the origin. */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400,
    toJSON: () => ({}),
  } as DOMRect);
  for (const [prop, value] of [['offsetWidth', 400], ['offsetHeight', 400]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
}

const canvas = () => screen.getByTestId('preview-canvas') as HTMLElement;
const viewport = () => screen.getByTestId('preview-viewport') as HTMLElement;
const layer = () => document.querySelector('[data-layer-id="a"]') as HTMLElement;

const pointer = (type: string, clientX: number, clientY: number) =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, button: 0 });

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
  vi.restoreAllMocks();
});

describe('the Handles toggle', () => {
  it('draws the handles for a selected clip by default', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.getByTestId('preview-rotate-handle')).toBeTruthy();
    expect(screen.getByTestId('preview-anchor')).toBeTruthy();
  });

  it('hides them when the toolbar button is pressed', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    fireEvent.click(screen.getByRole('button', { name: /Hide transform handles/ }));
    expect(screen.queryByTestId('preview-rotate-handle')).toBeNull();
    expect(screen.queryByTestId('preview-handle-top')).toBeNull();
  });

  it('hides them on H, and brings them back on H again', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    fireEvent.keyDown(document, { key: 'h' });
    expect(screen.queryByTestId('preview-rotate-handle')).toBeNull();
    fireEvent.keyDown(document, { key: 'h' });
    expect(screen.getByTestId('preview-rotate-handle')).toBeTruthy();
  });

  it('leaves the anchor crosshair visible when the handles are hidden', () => {
    /*
      `A`'s crosshair and `H`'s handles are separate state on purpose. The crosshair is a
      readout of the pivot as much as it is a grip, so a user who hides the handles to look at
      a picture should still be able to see where the clip will turn about.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    fireEvent.keyDown(document, { key: 'h' });
    expect(screen.getByTestId('preview-anchor')).toBeTruthy();
    // …and `A` still hides it independently.
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.queryByTestId('preview-anchor')).toBeNull();
  });

  it('does not deselect the clip, so the inspector keeps editing it', () => {
    // Hiding the chrome is a view change. The selection is the document gesture's subject.
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    fireEvent.keyDown(document, { key: 'h' });
    expect(timeline.selection).toStrictEqual(['a']);
  });

  it('ignores H typed into a text field', () => {
    render(
      <div>
        <input aria-label="some field" />
        <PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />
      </div>,
    );
    const field = screen.getByLabelText('some field');
    fireEvent.keyDown(field, { key: 'h' });
    expect(screen.getByTestId('preview-rotate-handle')).toBeTruthy();
  });
});

describe('the Pan view tool', () => {
  it('is off by default, so a press belongs to the clip', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.getByRole('button', { name: 'Pan view' })).toBeTruthy();
  });

  it('toggles, and says so', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan view' }));
    expect(screen.getByRole('button', { name: 'Pan view (on)' })).toBeTruthy();
  });

  it('claims the pointer press, so the clip under it does not move', () => {
    stubLayout();
    /*
      The behaviour that makes the tool worth having. Without the capture-phase guard the
      layer's own `pointerdown` starts a move and the clip slides while the view is panned —
      two things at once, which is exactly what the rotate handle has to stop too.
    */
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan view' }));

    fireEvent(layer(), pointer('pointerdown', 200, 200));
    fireEvent(layer(), pointer('pointermove', 240, 200));
    fireEvent(layer(), pointer('pointerup', 240, 200));

    // A move would have committed a position; a pan commits nothing to the document.
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('does not claim a right-button press', () => {
    stubLayout();
    // A right-press is not this gesture, and swallowing it would take the context menu away.
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan view' }));
    fireEvent(layer(), new MouseEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true, button: 2 }));
    fireEvent(window, pointer('pointerup', 260, 200));
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });
});

describe('Space+drag', () => {
  it('pans instead of moving the clip when Space is held at the press', () => {
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);

    fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    fireEvent.pointerDown(canvas(), { button: 0, clientX: 10, clientY: 10, bubbles: true });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 80 });

    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('gives the press back to the clip once Space is released', () => {
    stubLayout();
    /*
      The pair that makes the gesture a *modifier* rather than a mode: holding Space changes
      what the next press means, and releasing it restores the ordinary meaning without any
      extra step.
    */
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);

    fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    fireEvent.keyUp(document, { code: 'Space', key: ' ' });

    fireEvent(layer(), pointer('pointerdown', 200, 200));
    fireEvent(layer(), pointer('pointermove', 240, 200));
    fireEvent(layer(), pointer('pointerup', 240, 200));

    // Back to an ordinary drag: the clip moved, so something was committed.
    expect(timeline.setItemProperties).toHaveBeenCalled();
  });


  it('disarms on window blur, because a key-up in another window never arrives', () => {
    /*
      The stuck-hand bug, and it is the worst kind: `keyup` fires on the document that has
      focus, so alt-tabbing while Space is held leaves the flag set with no event coming to
      clear it. Every later press would then pan instead of editing, and the symptom a user
      reports is "the canvas stopped responding to clicks", miles from the cause.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);

    fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    fireEvent.blur(window);

    fireEvent(layer(), pointer('pointerdown', 200, 200));
    fireEvent(layer(), pointer('pointermove', 240, 200));
    fireEvent(layer(), pointer('pointerup', 240, 200));

    // The hand was disarmed by the blur, so this is an ordinary clip drag again.
    expect(timeline.setItemProperties).toHaveBeenCalled();
  });


  it('arms only for Space, not for every key that happens to be held', () => {
    /*
      The flag is read on pointer-down, so an over-eager "any keydown arms the hand" would
      make a press while typing a shortcut pan instead of editing — and it would look
      intermittent, because it would depend on which key the user happened to be holding.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState()} fps={30} timeline={timeline} />);

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK' });

    fireEvent(layer(), pointer('pointerdown', 200, 200));
    fireEvent(layer(), pointer('pointermove', 240, 200));
    fireEvent(layer(), pointer('pointerup', 240, 200));

    expect(timeline.setItemProperties).toHaveBeenCalled();
  });

  it('never prevents the default, so the transport still sees the key', () => {
    /*
      Space is Play/Pause (§3.2) *and* pan (§4), on the same key. The resolution is that this
      listener is passive: playback stays the keydown, and the pan is a press that happens
      while it is held. A `preventDefault` here would silently take the transport shortcut
      away, which is the failure this asserts against.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
