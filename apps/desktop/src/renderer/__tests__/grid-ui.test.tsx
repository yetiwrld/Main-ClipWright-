// @vitest-environment jsdom
/**
 * The composition grid on screen (SPEC 10 §8.8, §9).
 *
 * The thirds have been a boolean since they were added; this is the slice that makes them
 * one setting of a general grid. The two things worth checking are that the default did
 * not move, and that a choice survives the toggle that turns the grid off and on — the
 * failure mode of a "setting plus visibility" pair is always that the setting gets reset
 * by the visibility.
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

const chord = (key: string) => fireEvent.keyDown(document, { key, ctrlKey: true, bubbles: true });

/** Open the Guides/grid menu and pick the grid item. */
function openGridDialog() {
  fireEvent.click(screen.getByRole('button', { name: /Guides and grid/ }));
  const menu = screen.getByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Composition grid/ }));
}

const typeInto = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
  vi.restoreAllMocks();
});

describe('the grid overlay', () => {
  it('draws the thirds by default, unchanged', () => {
    /*
      The regression that had to hold: `Ctrl+'` has drawn two verticals and two
      horizontals since this overlay existed, and making the grid configurable must not
      move them.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    chord("'");
    const verticals = ['overlay-grid-v-0', 'overlay-grid-v-1'];
    const horizontals = ['overlay-grid-h-0', 'overlay-grid-h-1'];
    for (const id of [...verticals, ...horizontals]) expect(screen.getByTestId(id)).toBeTruthy();
    // And nothing beyond them.
    expect(screen.queryByTestId('overlay-grid-v-2')).toBeNull();
  });

  it('draws a custom grid from the dialog', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '4');
    typeInto('Rows', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // Four columns means three internal verticals; two rows means one horizontal.
    for (const id of ['overlay-grid-v-0', 'overlay-grid-v-1', 'overlay-grid-v-2']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId('overlay-grid-h-0')).toBeTruthy();
    expect(screen.queryByTestId('overlay-grid-h-1')).toBeNull();
  });

  it('turns the grid on when a choice is applied', () => {
    /*
      Someone who opens the grid dialog has asked to see a grid. Making them press `Ctrl+'`
      afterwards to find out whether the numbers were what they wanted is a second step
      for no reason.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
    openGridDialog();
    typeInto('Columns', '5');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByTestId('overlay-grid-v-0')).toBeTruthy();
  });

  it('keeps the chosen grid across Ctrl+\' off and on', () => {
    /*
      The failure mode of a setting that shares a key with a visibility: `Ctrl+'` off and
      on again quietly restores the default, and the user's 5×4 is gone with no indication
      that anything happened.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '5');
    typeInto('Rows', '4');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    chord("'");
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
    chord("'");
    // Five columns: four verticals. Four rows: three horizontals.
    expect(screen.getByTestId('overlay-grid-v-3')).toBeTruthy();
    expect(screen.getByTestId('overlay-grid-h-2')).toBeTruthy();
  });

  it('says which grid is in force on the button that opens the dialog', () => {
    // The lines themselves say nothing about whether they are 3×3 or 5×4.
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    expect(screen.getByRole('button', { name: /Guides and grid \(3×3\)/ })).toBeTruthy();
    openGridDialog();
    typeInto('Columns', '7');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('button', { name: /Guides and grid \(7×3\)/ })).toBeTruthy();
  });

  it('stores 3×3 as the default rather than as a custom grid', () => {
    /*
      The two draw identically, so treating them as the same setting costs nothing and
      keeps the menu able to say "the thirds" about a grid the user did not configure.
      Checked through the label, which is the only place the distinction shows.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '3');
    typeInto('Rows', '3');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('button', { name: /Guides and grid \(3×3\)/ })).toBeTruthy();
  });
});

describe('the grid dialog', () => {
  it('starts from the grid in force', () => {
    // Re-opening after a change has to show that change, or Apply looks like it did nothing.
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '6');
    typeInto('Rows', '5');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    openGridDialog();
    expect((screen.getByLabelText('Columns') as HTMLInputElement).value).toBe('6');
    expect((screen.getByLabelText('Rows') as HTMLInputElement).value).toBe('5');
  });

  it('refuses to apply when a field cannot be a grid', () => {
    /*
      Disabled rather than clamped behind the user's back: a grid that silently becomes
      2×2 while the box reads "abc" is a mystery, and the range is stated in the dialog
      instead.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', 'abc');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    typeInto('Columns', '4');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves an emptied field alone instead of reading it as zero', () => {
    /*
      `Number('')` is `0`, not `NaN`, so a cleared box would clamp to the minimum and flash
      a 2×2 grid on the keystroke that emptied it. The Apply button going disabled is what
      tells the user the field is not usable yet.
    */
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Rows', '');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clamps a number outside the range rather than applying it', () => {
    // 99 is typeable; a thousand lines would be a thousand DOM nodes.
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '99');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('button', { name: /Guides and grid \(12×3\)/ })).toBeTruthy();
  });

  it('goes back to the thirds on Use thirds', () => {
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '8');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    openGridDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Use thirds' }));
    expect(screen.getByRole('button', { name: /Guides and grid \(3×3\)/ })).toBeTruthy();
  });

  it('changes nothing on Cancel', () => {
    // The draft exists so that a cancelled edit is not half-applied.
    render(<PreviewPane state={makeState()} fps={30} timeline={fakeTimeline()} />);
    openGridDialog();
    typeInto('Columns', '8');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Guides and grid \(3×3\)/ })).toBeTruthy();
    expect(screen.queryByTestId('preview-overlays')).toBeNull();
  });
});
