// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';

function makeState(aspect = '9:16'): TimelineState {
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
    canvas: { ...(base.canvas ?? {}), aspect },
    tracks,
    items: { a: item },
  } as unknown as TimelineState;
}

/** Dispatch a keypress the way the browser reports a chord. */
const chord = (key: string) =>
  fireEvent.keyDown(document, { key, ctrlKey: true, bubbles: true });

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('the overlay set (SPEC 10 §9)', () => {
  it('starts off', () => {
    /*
      "Safe areas off by default" is the spec's rule, and it matters: a guide nobody
      asked for is furniture on the picture, and the first thing a new user sees should
      be their frame rather than two rectangles.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
  });

  it('cycles title safe, action safe and platform zones on Ctrl+;', () => {
    /*
      One key for the set rather than four toggles, and the cycle must visit each stop
      because a user cannot otherwise reach `action-safe` or the platform bands.
    */
    render(<PreviewPane state={makeState()} fps={30} />);

    chord(';');
    expect(screen.getByTestId('preview-overlays').dataset.area).toBe('title-safe');

    chord(';');
    expect(screen.getByTestId('preview-overlays').dataset.area).toBe('action-safe');

    chord(';');
    expect(screen.getByTestId('preview-overlays').dataset.area).toBe('platform-zones');

    // And wraps back to nothing, so the cycle is escapable with the same key.
    chord(';');
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
  });

  it('skips the platform stop on a landscape canvas', () => {
    /*
      A 16:9 frame has no top band and no column of action buttons. Offering the stop
      would draw three invisible bands and make the key look broken — the cycle would
      appear to do nothing.
    */
    render(<PreviewPane state={makeState('16:9')} fps={30} />);
    chord(';');
    chord(';');
    chord(';');
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
  });

  it('draws the safe area as a centred inset rectangle', () => {
    // Title safe is 90%, so the rectangle is inset 5% on every side. Drawn from the
    // parsed data, not from a number in the component.
    render(<PreviewPane state={makeState()} fps={30} />);
    chord(';');
    const rect = screen.getByTestId('overlay-safe-area');
    expect(parseFloat(rect.style.left)).toBeCloseTo(5, 4);
    expect(parseFloat(rect.style.top)).toBeCloseTo(5, 4);
    expect(parseFloat(rect.style.width)).toBeCloseTo(90, 4);
  });

  it('draws three platform bands, not one rectangle', () => {
    /*
      The bands cover the chrome. A single rectangle would dim the *safe* middle and
      leave the obstructed edges bright — the exact inverse of the guide's purpose.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    chord(';');
    chord(';');
    chord(';');
    for (const band of ['top', 'bottom', 'right']) {
      expect(screen.getByTestId(`overlay-platform-${band}`)).toBeTruthy();
    }
  });

  it('toggles the rule of thirds independently', () => {
    /*
      The spec's "at most one set" rule is about the safe-area overlays, which are
      alternatives to each other. Thirds are a composition aid and belong alongside
      them, so this is a separate toggle rather than a fourth stop in the cycle.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    chord("'");
    expect(screen.getByTestId('overlay-grid-v-0')).toBeTruthy();
    expect(screen.getByTestId('overlay-grid-h-1')).toBeTruthy();
    // No safe area was switched on by the thirds key.
    expect(screen.queryByTestId('overlay-safe-area')).toBeNull();

    chord("'");
    expect(screen.queryByTestId('overlay-grid-v-0')).toBeNull();
  });

  it('composes thirds with a safe area rather than replacing it', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    chord(';');
    chord("'");
    expect(screen.getByTestId('overlay-safe-area')).toBeTruthy();
    expect(screen.getByTestId('overlay-grid-v-0')).toBeTruthy();
  });

  it('never takes a keystroke from a text field', () => {
    /*
      `;` and `'` are ordinary characters. A user typing a caption or a file name must
      be able to enter them without turning on guides, which is why the handler checks
      its target before claiming the chord.
    */
    render(
      <div>
        <input data-testid="some-field" />
      </div>,
    );
    render(<PreviewPane state={makeState()} fps={30} />);
    const field = screen.getByTestId('some-field');
    fireEvent.keyDown(field, { key: ';', ctrlKey: true, bubbles: true });
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
  });

  it('ignores the chord without a modifier', () => {
    // Plain `;` in the editor is not a shortcut, so it must not switch an overlay on.
    render(<PreviewPane state={makeState()} fps={30} />);
    fireEvent.keyDown(document, { key: ';', bubbles: true });
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
  });
});
