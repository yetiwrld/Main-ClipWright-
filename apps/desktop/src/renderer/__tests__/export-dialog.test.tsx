// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExportDialog, collectExportItems } from '../features/export/ExportDialog.js';
import type { TimelineState } from '@clipwright/timeline-engine';

// The dialog talks to the desktop bridge; without it, exports must not pretend.
vi.mock('../api.js', () => ({
  isDesktop: () => false,
  api: {
    startExport: vi.fn(),
    getExportQueue: vi.fn(async () => ({ jobs: [], running: 0, maxConcurrent: 1 })),
    getExportSpeed: vi.fn(async () => null),
    onExportProgress: () => () => undefined,
    cancelExport: vi.fn(),
    retryExport: vi.fn(),
    dismissExport: vi.fn(),
    openExportFolder: vi.fn(),
  },
  describeError: (err: unknown) => String(err),
}));

afterEach(() => cleanup());

function makeState(overrides: Partial<TimelineState> = {}): TimelineState {
  return {
    tracks: [
      { id: 'track-video', role: 'main', kind: 'video', name: 'Video', order: 0, hidden: false, locked: false, muted: false, solo: false, heightPx: 48, auto: false, itemIds: [] },
      { id: 'track-captions', role: 'caption', kind: 'caption', name: 'Captions', order: 1, hidden: false, locked: false, muted: false, solo: false, heightPx: 48, auto: false, itemIds: [] },
      { id: 'track-hidden', role: 'overlay', kind: 'video', name: 'Hidden', order: 2, hidden: true, locked: false, muted: false, solo: false, heightPx: 48, auto: false, itemIds: [] },
    ],
    items: {
      'item-1': {
        id: 'item-1',
        trackId: 'track-video',
        type: 'video',
        mediaId: 'media-1',
        startUs: 0,
        durationUs: 5_000_000,
        sourceInUs: 1_000_000,
        sourceDurationUs: 5_000_000,
      },
      'item-2': {
        id: 'item-2',
        trackId: 'track-captions',
        type: 'caption',
        startUs: 0,
        durationUs: 2_000_000,
        sourceInUs: 0,
        captionSegment: { text: 'Hello' },
      },
      'item-3': {
        id: 'item-3',
        trackId: 'track-hidden',
        type: 'image',
        startUs: 0,
        durationUs: 5_000_000,
        sourceInUs: 0,
      },
    },
    ...overrides,
  } as unknown as TimelineState;
}

describe('collectExportItems', () => {
  it('returns nothing without a timeline', () => {
    expect(collectExportItems(null)).toEqual([]);
  });

  it('excludes items on hidden tracks', () => {
    const items = collectExportItems(makeState());
    expect(items.map((item) => item.id)).not.toContain('item-3');
  });

  it('keeps video items with their source in-point', () => {
    const items = collectExportItems(makeState());
    const video = items.find((item) => item.id === 'item-1')!;
    expect(video.sourceInUs).toBe(1_000_000);
    expect(video.hasAudio).toBe(true);
    expect(video.muted).toBe(false);
  });

  it('marks caption items as having no audio and carries their text', () => {
    const items = collectExportItems(makeState());
    const caption = items.find((item) => item.id === 'item-2')!;
    expect(caption.hasAudio).toBe(false);
    expect(caption.muted).toBe(true);
    expect(caption.captionSegment).toEqual({ text: 'Hello' });
  });

  it('treats a muted track as silent without dropping its video', () => {
    const state = makeState();
    (state.tracks[0] as { muted: boolean }).muted = true;
    const items = collectExportItems(state);
    const video = items.find((item) => item.id === 'item-1')!;
    expect(video).toBeTruthy();
    expect(video.muted).toBe(true);
  });
});

describe('ExportDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <ExportDialog
        open={false}
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={5_000_000}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens with the settings panel and an empty queue', () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={5_000_000}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Export' })).toBeTruthy();
    expect(screen.getByTestId('export-queue-empty')).toBeTruthy();
    expect(screen.getByTestId('export-button')).toBeTruthy();
  });

  it('shows what range will be exported', () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={5_000_000}
      />,
    );
    expect(screen.getByText(/Exporting 5s of clip/)).toBeTruthy();
  });

  it('offers the work area only when one exists', () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={5_000_000}
        workAreaUs={null}
      />,
    );
    const workArea = screen.getByLabelText('Work area') as HTMLInputElement;
    expect(workArea.disabled).toBe(true);
  });

  it('uses the work area when one is set', () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={10_000_000}
        workAreaUs={[2_000_000, 4_000_000]}
      />,
    );
    expect(screen.getByText(/Exporting 2s of clip/)).toBeTruthy();
  });

  it('switches back to the whole clip when asked', () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={10_000_000}
        workAreaUs={[2_000_000, 4_000_000]}
      />,
    );
    fireEvent.click(screen.getByLabelText('Whole clip'));
    expect(screen.getByText(/Exporting 10s of clip/)).toBeTruthy();
  });

  it('tells the user the desktop app is required instead of faking an export', async () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={5_000_000}
      />,
    );
    expect(screen.getByText('Exporting needs the Clipwright desktop app.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('export-button'));
    const message = await screen.findByTestId('export-message');
    expect(message.textContent).toContain('desktop app');
  });

  it('updates the summary when the preset changes', () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        projectId="proj-1"
        compositionId="comp-1"
        compositionName="Clip"
        state={makeState()}
        fps={30}
        durationUs={5_000_000}
      />,
    );
    // Default 1080p at 9:16.
    expect(screen.getByText(/1080×1920/)).toBeTruthy();
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '720p' } });
    expect(screen.getByText(/720×1280/)).toBeTruthy();
  });
});
