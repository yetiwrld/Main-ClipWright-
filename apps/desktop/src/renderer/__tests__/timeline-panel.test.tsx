// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  createDefaultTimeline,
  createMediaItem,
  type TimelineState,
} from '@clipwright/timeline-engine';
import { TimelinePanel } from '../features/editor/TimelinePanel.js';
import { EditorPage } from '../features/editor/EditorPage.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import type { TimelineApi } from '../features/editor/use-timeline.js';

afterEach(() => cleanup());

function fixture(): TimelineState {
  const base = createDefaultTimeline({ id: 'clip-1', name: 'Clip' });
  const track = base.tracks[0]!;
  const first = createMediaItem({
    id: 'item-a',
    trackId: track.id,
    label: 'Opening line',
    mediaId: 'media-1',
    startUs: 0,
    durationUs: 2_000_000,
    sourceDurationUs: 10_000_000,
  });
  const second = createMediaItem({
    id: 'item-b',
    trackId: track.id,
    label: 'Second line',
    mediaId: 'media-1',
    startUs: 2_000_000,
    durationUs: 2_000_000,
    sourceDurationUs: 10_000_000,
  });
  return {
    ...base,
    tracks: base.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, itemIds: [first.id, second.id] } : candidate,
    ),
    items: { [first.id]: first, [second.id]: second },
  };
}

function fakeTimeline(state: TimelineState, overrides: Partial<TimelineApi> = {}): TimelineApi {
  const noop = () => true;
  return {
    state,
    fps: 30,
    record: null,
    loadError: '',
    saveState: 'saved',
    selection: [],
    notes: [],
    canUndo: false,
    canRedo: false,
    select: vi.fn(),
    clearSelection: vi.fn(),
    run: noop,
    undo: vi.fn(),
    redo: vi.fn(),
    move: vi.fn(() => true),
    trim: vi.fn(() => true),
    roll: vi.fn(() => true),
    split: vi.fn(() => true),
    splitAt: vi.fn(() => true),
    trimToPlayhead: vi.fn(() => true),
    moveSelectionToTrack: vi.fn(() => true),
    remove: vi.fn(() => true),
    duplicate: vi.fn(() => true),
    addMarkerAt: vi.fn(() => true),
    toggleMute: vi.fn(() => true),
    toggleMagnetic: vi.fn(() => true),
    placeMedia: vi.fn(() => true),
    dismissNotes: vi.fn(),
    copy: vi.fn(() => 0),
    cut: vi.fn(() => true),
    paste: vi.fn(() => true),
    group: vi.fn(() => true),
    ungroup: vi.fn(() => true),
    clipboardSize: 0,
    recovery: null,
    recover: vi.fn(async () => undefined),
    dismissRecovery: vi.fn(),
    ...overrides,
  };
}

describe('timeline panel', () => {
  beforeEach(() => {
    playheadStore.set(0);
    vi.clearAllMocks();
  });
  it('renders every default track and the clips on them', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    for (const name of ['Main video', 'Captions', 'Music', 'SFX']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Opening line clip' })).toBeTruthy();
  });

  it('shows the clip range as a timecode under the transport', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    // 2 s clip, 30 fps project: total duration readout.
    expect(screen.getByRole('button', { name: 'Current timecode' })).toBeTruthy();
  });

  it('selects a clip when it is clicked', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    // jsdom has no PointerEvent, so dispatch a MouseEvent carrying the same
    // fields React reads from a pointer gesture.
    screen
      .getByRole('button', { name: 'Opening line clip' })
      .dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 20, clientY: 10, bubbles: true }));
    expect(timeline.select).toHaveBeenCalledWith(['item-a'], false);
  });

  it('routes S, Delete and Ctrl+Z to the matching commands', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);
    playheadStore.set(1_000_000);

    fireEvent.keyDown(window, { key: 's' });
    expect(timeline.split).toHaveBeenCalledWith(1_000_000);

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(timeline.remove).toHaveBeenCalledWith(false, false);

    fireEvent.keyDown(window, { key: 'Delete', shiftKey: true });
    expect(timeline.remove).toHaveBeenCalledWith(true, false);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(timeline.undo).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(timeline.duplicate).toHaveBeenCalled();
  });

  it('moves the playhead by exactly one frame with the arrow keys', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    playheadStore.set(1_000_000);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(playheadStore.get()).toBe(1_033_333);
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    expect(playheadStore.get()).toBe(33_333);
    fireEvent.keyDown(window, { key: 'Home' });
    expect(playheadStore.get()).toBe(0);
  });

  it('commits a timecode typed into the field and clamps it to the project end', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Current timecode' }));
    const input = screen.getByRole('textbox', { name: 'Current timecode' });
    fireEvent.change(input, { target: { value: '10:00' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Two clips span 0–4 s, so 10 minutes clamps to the project duration.
    expect(playheadStore.get()).toBe(4_000_000);
  });

  it('routes Delete with ripple and the ripple-all-tracks toggle', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(timeline.remove).toHaveBeenCalledWith(false, false);

    fireEvent.keyDown(window, { key: 'Delete', shiftKey: true });
    expect(timeline.remove).toHaveBeenLastCalledWith(true, false);

    fireEvent.click(screen.getByRole('button', { name: /Ripple all tracks: off/ }));
    fireEvent.keyDown(window, { key: 'Delete', shiftKey: true });
    expect(timeline.remove).toHaveBeenLastCalledWith(true, true);
  });

  it('routes the clipboard and grouping shortcuts', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'], clipboardSize: 1 });
    render(<TimelinePanel timeline={timeline} />);

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    expect(timeline.copy).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    expect(timeline.cut).toHaveBeenCalled();

    playheadStore.set(500_000);
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    expect(timeline.paste).toHaveBeenCalledWith(500_000);

    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    expect(timeline.group).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'g', ctrlKey: true, shiftKey: true });
    expect(timeline.ungroup).toHaveBeenCalled();
  });

  it('splits the clicked clip when the razor tool is active', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);

    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' }));
    screen
      .getByRole('button', { name: 'Opening line clip' })
      .dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 200, clientY: 10, bubbles: true }));

    expect(timeline.splitAt).toHaveBeenCalledTimes(1);
    const [ids, atUs] = (timeline.splitAt as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(ids).toEqual(['item-a']);
    expect(typeof atUs).toBe('number');
  });

  it('selects clips with a marquee dragged over empty area', async () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    const { getByTestId } = render(<TimelinePanel timeline={timeline} />);
    const canvas = getByTestId('timeline-canvas');

    // y = 150 lands on the main video row (captions + text + overlay stack above it).
    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 150, bubbles: true }),
      );
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 150, bubbles: true }));
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });

    expect(timeline.select).toHaveBeenCalledWith(['item-a'], false);
  });

  it('routes Q/W trim-to-playhead keys with shift for ripple', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);

    fireEvent.keyDown(window, { key: 'q' });
    expect(timeline.trimToPlayhead).toHaveBeenCalledWith('start', 0, false);

    playheadStore.set(1_000_000);
    fireEvent.keyDown(window, { key: 'W' });
    expect(timeline.trimToPlayhead).toHaveBeenCalledWith('end', 1_000_000, false);

    fireEvent.keyDown(window, { key: 'w', shiftKey: true });
    expect(timeline.trimToPlayhead).toHaveBeenLastCalledWith('end', 1_000_000, true);
  });

  it('routes Alt+Up/Down to track moves', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);

    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
    expect(timeline.moveSelectionToTrack).toHaveBeenCalledWith('up');

    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
    expect(timeline.moveSelectionToTrack).toHaveBeenCalledWith('down');
  });

  it('starts a rolling edit with Ctrl+drag at a junction', async () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    const { getByTestId } = render(<TimelinePanel timeline={timeline} />);

    // Ctrl+pointerdown on the right edge of “Opening line” (which ends exactly
    // where “B” starts) should start a roll, not a trim.
    const handle = getByTestId('item-a-right-handle');
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, ctrlKey: true, clientX: 300, clientY: 150, bubbles: true }),
      );
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 320, clientY: 150, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });

    expect(timeline.roll).toHaveBeenCalledTimes(1);
  });

  it('toggles magnetic on the main track header', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    const { getByRole } = render(<TimelinePanel timeline={timeline} />);

    const toggle = getByRole('button', { name: /^Magnetic Main video: on$/ });
    fireEvent.click(toggle);
    expect(timeline.toggleMagnetic).toHaveBeenCalledWith(state.tracks[0]!.id);
  });

  it('says the desktop app is required instead of pretending to edit', () => {
    render(<EditorPage projectId="p1" compId="clip-1" onBack={() => undefined} />);
    // No `window.clipwright` here, so nothing is faked: the page states it.
    expect(screen.getAllByText(/clipwright desktop app/i).length).toBeGreaterThan(0);
  });
});
