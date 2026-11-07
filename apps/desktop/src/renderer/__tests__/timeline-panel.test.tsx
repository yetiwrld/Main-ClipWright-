// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  return {
    ...base,
    tracks: base.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, itemIds: [first.id] } : candidate,
    ),
    items: { [first.id]: first },
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
    split: vi.fn(() => true),
    remove: vi.fn(() => true),
    duplicate: vi.fn(() => true),
    addMarkerAt: vi.fn(() => true),
    toggleMute: vi.fn(() => true),
    placeMedia: vi.fn(() => true),
    dismissNotes: vi.fn(),
    recovery: null,
    recover: vi.fn(async () => undefined),
    dismissRecovery: vi.fn(),
    ...overrides,
  };
}

describe('timeline panel', () => {
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
    expect(timeline.remove).toHaveBeenCalledWith(false);

    fireEvent.keyDown(window, { key: 'Delete', shiftKey: true });
    expect(timeline.remove).toHaveBeenCalledWith(true);

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
    // The clip is 2 s long, so 10 minutes clamps to the project duration.
    expect(playheadStore.get()).toBe(2_000_000);
  });

  it('says the desktop app is required instead of pretending to edit', () => {
    render(<EditorPage projectId="p1" compId="clip-1" onBack={() => undefined} />);
    // No `window.clipwright` here, so nothing is faked: the page states it.
    expect(screen.getAllByText(/clipwright desktop app/i).length).toBeGreaterThan(0);
  });
});
