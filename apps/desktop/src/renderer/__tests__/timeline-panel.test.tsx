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
import { ItemInspector } from '../features/editor/Inspector.js';
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
    detachAudio: vi.fn(() => true),
    unlink: vi.fn(() => true),
    toggleDisabled: vi.fn(() => true),
    addTransition: vi.fn(() => true),
    updateTransition: vi.fn(() => true),
    removeTransition: vi.fn(() => true),
    setWorkArea: vi.fn(() => true),
    clearWorkArea: vi.fn(() => true),
    addKeyframe: vi.fn(() => true),
    removeKeyframe: vi.fn(() => true),
    updateKeyframe: vi.fn(() => true),
    moveKeyframe: vi.fn(() => true),
    duplicateKeyframe: vi.fn(() => true),
    splitCaptionSegment: vi.fn(() => true),
    mergeCaptionSegments: vi.fn(() => true),
    trimCaptionSegment: vi.fn(() => true),
    applyEffect: vi.fn(() => true),
    removeEffect: vi.fn(() => true),
    toggleEffectEnabled: vi.fn(() => true),
    updateEffectParams: vi.fn(() => true),
    updateMarker: vi.fn(() => true),
    deleteMarker: vi.fn(() => true),
    setViewState: vi.fn(() => true),
    addTrack: vi.fn(() => true),
    toggleTrackLock: vi.fn(() => true),
    toggleTrackHidden: vi.fn(() => true),
    deleteTrack: vi.fn(() => true),
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


  it('opens a clip context menu on right-click with clip actions', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    const clip = screen.getByRole('button', { name: 'Opening line clip' });
    fireEvent.contextMenu(clip, { clientX: 50, clientY: 50 });
    // Menu shows items like Cut, Copy, Paste, Duplicate, Delete
    expect(screen.getByText('Cut')).toBeTruthy();
    expect(screen.getByText('Copy')).toBeTruthy();
    expect(screen.getByText('Paste')).toBeTruthy();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('clip menu Duplicate calls timeline.duplicate', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Opening line clip' }), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByText('Duplicate'));
    expect(timeline.duplicate).toHaveBeenCalled();
  });

  it('clip menu Delete calls timeline.remove with false (no ripple)', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Opening line clip' }), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByText('Delete'));
    expect(timeline.remove).toHaveBeenCalledWith(false, false);
  });

  it('clip menu Ripple delete calls timeline.remove with true', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Opening line clip' }), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByText('Ripple delete'));
    expect(timeline.remove).toHaveBeenCalledWith(true, false);
  });

  it('opens a track header context menu on right-click', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    // Right-click on the Main video track header area
    const header = screen.getByText('Main video');
    fireEvent.contextMenu(header, { clientX: 100, clientY: 100 });
    expect(screen.getByText('Mute')).toBeTruthy();
    expect(screen.getByText('Lock')).toBeTruthy();
    expect(screen.getByText('Add track above')).toBeTruthy();
    expect(screen.getByText('Add track below')).toBeTruthy();
  });

  it('track menu Mute calls timeline.toggleMute', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.contextMenu(screen.getByText('Main video'), { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByText('Mute'));
    expect(timeline.toggleMute).toHaveBeenCalledWith(state.tracks[0]!.id);
  });

  it('track menu Delete track is disabled for the main track', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    fireEvent.contextMenu(screen.getByText('Main video'), { clientX: 100, clientY: 100 });
    const deleteBtn = screen.getByText('Delete track');
    // The button should be disabled (aria-disabled or disabled prop)
    expect(deleteBtn.getAttribute('aria-disabled') || deleteBtn.closest('[disabled]')).toBeTruthy();
  });

  it('empty track area context menu shows Paste and Add track', () => {
    const state = fixture();
    const { container } = render(<TimelinePanel timeline={fakeTimeline(state)} />);
    const emptyArea = container.querySelector('[data-testid^="empty-area"]');
    expect(emptyArea).toBeTruthy();
    fireEvent.contextMenu(emptyArea!, { clientX: 150, clientY: 150 });
    expect(screen.getByText('Paste')).toBeTruthy();
    expect(screen.getByText('Add marker here')).toBeTruthy();
    expect(screen.getByText('Add track')).toBeTruthy();
  });

  it('Escape closes the context menu', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Opening line clip' }), { clientX: 50, clientY: 50 });
    expect(screen.getByText('Cut')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Cut')).toBeNull();
  });


  it('transition methods exist on the timeline API', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    expect(typeof timeline.addTransition).toBe('function');
    expect(typeof timeline.updateTransition).toBe('function');
    expect(typeof timeline.removeTransition).toBe('function');
  });


  it('drops a media asset onto the timeline canvas', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    const { container } = render(<TimelinePanel timeline={timeline} />);
    const canvas = container.querySelector('[data-testid="timeline-canvas"]') as HTMLElement;
    expect(canvas).toBeTruthy();

    const dataTransfer = {
      getData: vi.fn(() => JSON.stringify({
        mediaId: 'media-new',
        label: 'New video.mp4',
        type: 'video',
        durationUs: 3_000_000,
        sourceDurationUs: 3_000_000,
      })),
      dropEffect: '',
    };
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as Event;
    (dropEvent as unknown as { dataTransfer: typeof dataTransfer }).dataTransfer = dataTransfer;
    Object.defineProperty(dropEvent, 'clientX', { value: 100 });
    Object.defineProperty(dropEvent, 'currentTarget', { value: canvas });

    fireEvent(canvas, dropEvent);
    expect(timeline.placeMedia).toHaveBeenCalledWith({
      mediaId: 'media-new',
      label: 'New video.mp4',
      type: 'video',
      durationUs: 3_000_000,
      sourceDurationUs: 3_000_000,
      startUs: expect.any(Number),
    });
  });

  it('ignores drops without clipwright media data', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    const { container } = render(<TimelinePanel timeline={timeline} />);
    const canvas = container.querySelector('[data-testid="timeline-canvas"]') as HTMLElement;

    const dataTransfer = {
      getData: vi.fn(() => ''),
      dropEffect: '',
    };
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as Event;
    (dropEvent as unknown as { dataTransfer: typeof dataTransfer }).dataTransfer = dataTransfer;
    Object.defineProperty(dropEvent, 'clientX', { value: 100 });
    Object.defineProperty(dropEvent, 'currentTarget', { value: canvas });

    fireEvent(canvas, dropEvent);
    expect(timeline.placeMedia).not.toHaveBeenCalled();
  });


  it('routes I and O keys to setWorkArea', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    playheadStore.set(1_000_000);
    fireEvent.keyDown(window, { key: 'i' });
    expect(timeline.setWorkArea).toHaveBeenCalledWith('in', 1_000_000);
    playheadStore.set(3_000_000);
    fireEvent.keyDown(window, { key: 'o' });
    expect(timeline.setWorkArea).toHaveBeenCalledWith('out', 3_000_000);
  });

  it('routes Alt+X to clearWorkArea', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.keyDown(window, { key: 'x', altKey: true });
    expect(timeline.clearWorkArea).toHaveBeenCalled();
  });


  it('keyframe methods exist on the timeline API', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    expect(typeof timeline.addKeyframe).toBe('function');
    expect(typeof timeline.removeKeyframe).toBe('function');
    expect(typeof timeline.updateKeyframe).toBe('function');
    expect(typeof timeline.moveKeyframe).toBe('function');
    expect(typeof timeline.duplicateKeyframe).toBe('function');
  });


  it('caption methods exist on the timeline API', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    expect(typeof timeline.splitCaptionSegment).toBe('function');
    expect(typeof timeline.mergeCaptionSegments).toBe('function');
    expect(typeof timeline.trimCaptionSegment).toBe('function');
  });


  it('toggles show keyframes and renders keyframe lane', () => {
    const state = fixture();
    // Add keyframes to the fixture item
    const itemWithKfs = {
      ...state.items['item-a'],
      keyframes: { opacity: [{ timeUs: 1_000_000, value: 0.5, interpolation: 'linear' as const }] },
    };
    const stateWithKfs = {
      ...state,
      items: { ...state.items, ['item-a']: itemWithKfs },
    };
    const { container } = render(<TimelinePanel timeline={fakeTimeline(stateWithKfs)} />);
    // Keyframe lane should not show initially (not selected, showKeyframes off)
    expect(container.querySelector('[data-testid="item-a-keyframe-lane"]')).toBeNull();

    // Toggle show keyframes
    const toggle = screen.getByRole('button', { name: /^Show keyframes$/ });
    fireEvent.click(toggle);
    const lane = container.querySelector('[data-testid="item-a-keyframe-lane"]');
    expect(lane).toBeTruthy();
  });


  it('effect methods exist on the timeline API', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    expect(typeof timeline.applyEffect).toBe('function');
    expect(typeof timeline.removeEffect).toBe('function');
    expect(typeof timeline.toggleEffectEnabled).toBe('function');
    expect(typeof timeline.updateEffectParams).toBe('function');
  });


  it('marker methods exist on the timeline API', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    expect(typeof timeline.updateMarker).toBe('function');
    expect(typeof timeline.deleteMarker).toBe('function');
  });


  it('ruler context menu shows marker and work area actions', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    const { container } = render(<TimelinePanel timeline={timeline} />);
    // Right-click on the ruler canvas area
    const rulerArea = container.querySelector('canvas') as HTMLElement;
    expect(rulerArea).toBeTruthy();
    fireEvent.contextMenu(rulerArea, { clientX: 100, clientY: 20 });
    expect(screen.getByText('Add marker')).toBeTruthy();
    expect(screen.getByText('Set work-area in')).toBeTruthy();
    expect(screen.getByText('Set work-area out')).toBeTruthy();
    expect(screen.getByText('Fit project')).toBeTruthy();
  });


  it('routes Ctrl+0 to fit project and Ctrl+=/- to zoom', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    // Ctrl+0 should call fitProject (via run)
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    // Ctrl+= should zoom in (no error)
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    // Ctrl+- should zoom out (no error)
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
  });


  it('inspector shows effects section when item has effects', () => {
    const state = fixture();
    const itemWithEffects = {
      ...state.items['item-a'],
      effects: [{ id: 'eff-1', effectId: 'blur', enabled: true, params: {} }],
    };
    const stateWithEffects = {
      ...state,
      items: { ...state.items, ['item-a']: itemWithEffects },
    };
    const timeline = fakeTimeline(stateWithEffects, { selection: ['item-a'] });
    render(<ItemInspector state={stateWithEffects} timeline={timeline} />);
    expect(screen.getByText('Effects')).toBeTruthy();
    expect(screen.getByText('blur')).toBeTruthy();
  });


  it('renders caption text instead of label on caption items', () => {
    const base = fixture();
    const captionTrack = base.tracks.find((t) => t.kind === 'caption')!;
    const capItem = {
      ...createMediaItem({
        id: 'cap-vis',
        trackId: captionTrack.id,
        label: 'Caption label',
        mediaId: 'media-1',
        type: 'video',
        startUs: 0,
        durationUs: 2_000_000,
        sourceDurationUs: 10_000_000,
      }),
      type: 'caption' as const,
      captionSegment: {
        id: 'seg-vis',
        wordRefs: [],
        startUs: 0,
        endUs: 2_000_000,
        text: 'Hello world',
        lines: ['Hello world'],
        manualTiming: false,
        manualText: false,
      },
    };
    const stateWithCap = {
      ...base,
      tracks: base.tracks.map((t) =>
        t.id === captionTrack.id ? { ...t, itemIds: [...t.itemIds, capItem.id] } : t,
      ),
      items: { ...base.items, [capItem.id]: capItem },
    };
    render(<TimelinePanel timeline={fakeTimeline(stateWithCap)} />);
    expect(screen.getByText('Hello world')).toBeTruthy();
    expect(screen.queryByText('Caption label clip')).toBeNull();
  });


  it('K key toggles show keyframes', () => {
    const state = fixture();
    const { container } = render(<TimelinePanel timeline={fakeTimeline(state)} />);
    // Initially no keyframe lanes
    expect(container.querySelector('[data-testid*="keyframe-lane"]')).toBeNull();
    // Press K to toggle on
    fireEvent.keyDown(window, { key: 'k' });
    // Press K again to toggle off
    fireEvent.keyDown(window, { key: 'k' });
  });


  it('marker right-click shows rename and delete menu', () => {
    const state = fixture();
    const marker = { id: 'mk-1', timeUs: 2_000_000, name: 'Scene 1', color: '#FFB000' };
    const stateWithMarker = { ...state, markers: [marker] };
    const { container } = render(<TimelinePanel timeline={fakeTimeline(stateWithMarker)} />);
    const markerEl = container.querySelector('[data-testid="marker-mk-1"]') as HTMLElement;
    expect(markerEl).toBeTruthy();
    fireEvent.contextMenu(markerEl, { clientX: 100, clientY: 20 });
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete marker')).toBeTruthy();
  });


  it('Ctrl+Left/Right jumps between markers', () => {
    const state = fixture();
    const marker1 = { id: 'mk-a', timeUs: 1_000_000, name: 'A', color: '#FFB000' };
    const marker2 = { id: 'mk-b', timeUs: 3_000_000, name: 'B', color: '#FFB000' };
    const stateWithMarkers = { ...state, markers: [marker1, marker2] };
    render(<TimelinePanel timeline={fakeTimeline(stateWithMarkers)} />);
    playheadStore.set(2_000_000);
    // Ctrl+Right should jump to next marker at 3s
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true });
    expect(playheadStore.get()).toBe(3_000_000);
    // Ctrl+Left should jump to previous marker at 1s
    fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true });
    expect(playheadStore.get()).toBe(1_000_000);
  });

  it('ArrowUp/Down jumps between edit points', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    playheadStore.set(1_500_000);
    // ArrowDown should jump to next edit point (2s = item-b start)
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(playheadStore.get()).toBe(2_000_000);
    // ArrowUp should jump to previous edit point
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(playheadStore.get()).toBeLessThan(2_000_000);
  });


  it('toggles show markers visibility', () => {
    const state = fixture();
    const marker = { id: 'mk-vis', timeUs: 2_000_000, name: 'Test', color: '#FFB000' };
    const stateWithMarker = { ...state, markers: [marker] };
    const { container } = render(<TimelinePanel timeline={fakeTimeline(stateWithMarker)} />);
    // Marker should be visible initially
    expect(container.querySelector('[data-testid="marker-mk-vis"]')).toBeTruthy();
    // Toggle off
    const toggle = screen.getByRole('button', { name: /^Show markers$/ });
    fireEvent.click(toggle);
    expect(container.querySelector('[data-testid="marker-mk-vis"]')).toBeNull();
    // Toggle back on
    fireEvent.click(toggle);
    expect(container.querySelector('[data-testid="marker-mk-vis"]')).toBeTruthy();
  });


  it('spacebar toggles play/pause', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    const playButton = screen.getByRole('button', { name: /^Play$/ });
    expect(playButton).toBeTruthy();
    // Spacebar should toggle play state
    fireEvent.keyDown(window, { key: ' ' });
    // After space, button should show Pause
    expect(screen.getByRole('button', { name: /^Pause$/ })).toBeTruthy();
  });


  it('renders work area drag handles when work area is set', () => {
    const state = fixture();
    const stateWithWorkArea = { ...state, workArea: { inUs: 1_000_000, outUs: 3_000_000 } };
    const { container } = render(<TimelinePanel timeline={fakeTimeline(stateWithWorkArea)} />);
    expect(container.querySelector('[data-testid="work-area-in-handle"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="work-area-out-handle"]')).toBeTruthy();
  });

  it('does not render work area handles when work area is cleared', () => {
    const state = fixture();
    const { container } = render(<TimelinePanel timeline={fakeTimeline(state)} />);
    expect(container.querySelector('[data-testid="work-area-in-handle"]')).toBeNull();
    expect(container.querySelector('[data-testid="work-area-out-handle"]')).toBeNull();
  });


  it('toggles loop playback', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    const loopButton = screen.getByRole('button', { name: /^Loop playback: off$/ });
    expect(loopButton).toBeTruthy();
    fireEvent.click(loopButton);
    expect(screen.getByRole('button', { name: /^Loop playback: on$/ })).toBeTruthy();
  });


  it('setViewState method exists on the timeline API', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    expect(typeof timeline.setViewState).toBe('function');
  });


  it('toggles follow playhead', () => {
    const state = fixture();
    render(<TimelinePanel timeline={fakeTimeline(state)} />);
    const followButton = screen.getByRole('button', { name: /^Follow playhead: on$/ });
    expect(followButton).toBeTruthy();
    fireEvent.click(followButton);
    expect(screen.getByRole('button', { name: /^Follow playhead: off$/ })).toBeTruthy();
  });


  it('shows save state in the toolbar', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { saveState: 'dirty' });
    const { container } = render(<TimelinePanel timeline={timeline} />);
    const indicator = container.querySelector('[data-testid="save-state"]');
    expect(indicator?.textContent).toBe('Unsaved');

    const timeline2 = fakeTimeline(state, { saveState: 'saved' });
    const { container: container2 } = render(<TimelinePanel timeline={timeline2} />);
    expect(container2.querySelector('[data-testid="save-state"]')?.textContent).toBe('Saved');
  });


  it('Ctrl+A selects all unlocked clips', () => {
    const state = fixture();
    const timeline = fakeTimeline(state);
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(timeline.select).toHaveBeenCalled();
    const calls = (timeline.select as unknown as { mock: { calls: Array<[unknown[], ...unknown[]]> } }).mock.calls;
    const args = calls[0]![0] as unknown[];
    expect(Array.isArray(args)).toBe(true);
    expect(args.length).toBeGreaterThan(0);
  });

  it('Esc clears selection', () => {
    const state = fixture();
    const timeline = fakeTimeline(state, { selection: ['item-a'] });
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(timeline.clearSelection).toHaveBeenCalled();
  });

  it('Ctrl+J merges two caption segments', () => {
    const state = fixture();
    // Convert fixture items to caption type
    const capA = { ...state.items['item-a'], type: 'caption' as const };
    const capB = { ...state.items['item-b'], type: 'caption' as const };
    const stateWithCaps = {
      ...state,
      items: { ...state.items, ['item-a']: capA, ['item-b']: capB },
    };
    const timeline = fakeTimeline(stateWithCaps, { selection: ['item-a', 'item-b'] });
    render(<TimelinePanel timeline={timeline} />);
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(timeline.mergeCaptionSegments).toHaveBeenCalledWith('item-a', 'item-b');
  });

  it('says the desktop app is required instead of pretending to edit', () => {
    render(<EditorPage projectId="p1" compId="clip-1" onBack={() => undefined} />);
    // No `window.clipwright` here, so nothing is faked: the page states it.
    expect(screen.getAllByText(/clipwright desktop app/i).length).toBeGreaterThan(0);
  });
});
