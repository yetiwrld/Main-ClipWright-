// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { builtInStyle } from '@clipwright/caption-styles';
import { ExportDialog, collectExportItems } from '../features/export/ExportDialog.js';
import type { TimelineState } from '@clipwright/timeline-engine';

// The dialog talks to the desktop bridge; without it, exports must not pretend. The
// flag is mutable so one block can exercise the real export path.
const bridge = vi.hoisted(() => ({ desktop: false }));

vi.mock('../api.js', () => ({
  isDesktop: () => bridge.desktop,
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

  /**
   * SPEC 12 §4.2 / §12 item 8 — "mute/solo (export honours mute; solo per
   * setting)". Mute reaches the export; solo never did. Silencing a track by
   * soloing another one previewed correctly and then exported with every track
   * audible, which is the worst kind of disagreement: the user hears the mistake
   * only after the render finishes.
   */
  it('silences tracks that are not soloed when another one is', () => {
    const state = makeState();
    // Two audio-bearing tracks, so "the others" is a real set.
    (state.tracks[0] as { solo: boolean }).solo = true;
    (state as { tracks: unknown[] }).tracks.push({
      id: 'track-music', role: 'music', kind: 'audio', name: 'Music', order: 3,
      hidden: false, locked: false, muted: false, solo: false, heightPx: 48, auto: false,
      itemIds: ['item-4'],
    });
    (state.items as Record<string, unknown>)['item-4'] = {
      id: 'item-4', trackId: 'track-music', type: 'audio', mediaId: 'media-2',
      startUs: 0, durationUs: 5_000_000, sourceInUs: 0, sourceDurationUs: 5_000_000,
    };

    const items = collectExportItems(state);
    // The soloed track's audio survives...
    expect(items.find((item) => item.id === 'item-1')!.muted).toBe(false);
    // ...and the un-soloed one is silent. Its *video* would still be drawn if it
    // had any; only the sound is suppressed.
    expect(items.find((item) => item.id === 'item-4')!.muted).toBe(true);
  });

  it('leaves everything audible when nothing is soloed', () => {
    // The flag only takes effect while at least one track is soloed; an unsoloed
    // project must not silently mute itself.
    const state = makeState();
    (state as { tracks: unknown[] }).tracks.push({
      id: 'track-music', role: 'music', kind: 'audio', name: 'Music', order: 3,
      hidden: false, locked: false, muted: false, solo: false, heightPx: 48, auto: false,
      itemIds: ['item-4'],
    });
    (state.items as Record<string, unknown>)['item-4'] = {
      id: 'item-4', trackId: 'track-music', type: 'audio', mediaId: 'media-2',
      startUs: 0, durationUs: 5_000_000, sourceInUs: 0, sourceDurationUs: 5_000_000,
    };
    expect(collectExportItems(state).find((item) => item.id === 'item-4')!.muted).toBe(false);
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

describe('ExportDialog caption styles', () => {
  it('passes the project copies on to the export', async () => {
    bridge.desktop = true;
    // This is the contract that makes the style editor worth anything: a saved
    // copy has to reach the burn-in, or the export silently renders the preset the
    // copy started from (SPEC 11 §6).
    const startExport = (await import('../api.js')).api.startExport as unknown as ReturnType<typeof vi.fn>;
    startExport.mockReset();
    startExport.mockResolvedValue({
      ok: true,
      job: { id: 'job-1', status: 'queued' },
    });
    const house = { ...builtInStyle('bold-creator')!, id: 'house', name: 'House', font: { ...builtInStyle('bold-creator')!.font, sizePctOfShortSide: 9 } };

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
        captionStyles={{ house }}
      />,
    );
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(startExport).toHaveBeenCalled());
    const payload = startExport.mock.calls[0]![0] as { captionStyles?: Record<string, unknown> };
    expect(payload.captionStyles).toBeDefined();
    expect((payload.captionStyles as Record<string, typeof house>).house!.name).toBe('House');
  });

  it('omits nothing when the project has no copies', async () => {
    bridge.desktop = true;
    // An absent map and an empty map mean the same thing to the main process; what
    // must not happen is the dialog inventing a preset map of its own, which would
    // override a copy the export runner could have resolved itself.
    const startExport = (await import('../api.js')).api.startExport as unknown as ReturnType<typeof vi.fn>;
    startExport.mockReset();
    startExport.mockResolvedValue({ ok: true, job: { id: 'job-2', status: 'queued' } });
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
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(startExport).toHaveBeenCalled());
    const payload = startExport.mock.calls[0]![0] as { captionStyles?: unknown };
    expect(payload.captionStyles).toBeUndefined();
  });
});

describe('collectExportItems — what the plan carries', () => {
  it('carries each caption\'s own style id', () => {
    // The burn-in reads the style from the plan. A dialog that dropped this field
    // exported every caption in the project default's look while the preview showed
    // per-caption styles — the export silently disagreeing with what was approved.
    const state = makeState();
    (state.items['item-2'] as { captionStyleId?: string }).captionStyleId = 'karaoke';
    const caption = collectExportItems(state).find((item) => item.id === 'item-2')!;
    expect((caption as { captionStyleId?: string }).captionStyleId).toBe('karaoke');
  });

  it('carries the crop and transform the inspector wrote', () => {
    // Same failure, one layer down: the export filter chain needs the geometry or
    // it renders the clip whole and centred however it was framed.
    const state = makeState();
    Object.assign(state.items['item-1']!, {
      crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
      transform: { x: 0.1, y: 0, scaleX: 1.5, scaleY: 1.5, rotation: 15 },
    });
    const video = collectExportItems(state).find((item) => item.id === 'item-1')!;
    expect(video.geometry).toEqual({
      crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
      transform: { x: 0.1, y: 0, scaleX: 1.5, scaleY: 1.5, rotation: 15 },
    });
  });
});

describe('the export panel starts from the composition it is exporting', () => {
  /*
    SPEC 14 §3. The panel's aspect decides the *output frame*, and it used to start at a constant
    9:16 whatever the composition was — so exporting a 16:9 project from a panel nobody adjusted
    produced a portrait file. The composition's canvas is the truth, and the dialog already had the
    timeline state.
  */
  function renderWithCanvas(canvas?: { width: number; height: number }) {
    bridge.desktop = false;
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
        canvas={canvas}
      />,
    );
  }

  it('reads the aspect off a landscape canvas', () => {
    renderWithCanvas({ width: 1920, height: 1080 });
    expect((screen.getByLabelText('Aspect ratio') as HTMLSelectElement).value).toBe('16:9');
  });

  it('keeps 9:16 for a portrait canvas, which is the app’s default project', () => {
    renderWithCanvas({ width: 1080, height: 1920 });
    expect((screen.getByLabelText('Aspect ratio') as HTMLSelectElement).value).toBe('9:16');
  });

  it('takes the resolution preset from the short side', () => {
    /* 1080×1920 and 1920×1080 are both 1080p; a 720-short-side canvas is 720p. */
    renderWithCanvas({ width: 1280, height: 720 });
    expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('720p');
  });

  it('falls back to the documented default when there is no composition yet', () => {
    /* The dialog is also rendered before a timeline exists; hiding the control would be worse. */
    renderWithCanvas(undefined);
    expect((screen.getByLabelText('Aspect ratio') as HTMLSelectElement).value).toBe('9:16');
  });

  it('still lets the user change it — the canvas is a starting point, not a lock', () => {
    renderWithCanvas({ width: 1920, height: 1080 });
    const select = screen.getByLabelText('Aspect ratio') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1:1' } });
    expect((screen.getByLabelText('Aspect ratio') as HTMLSelectElement).value).toBe('1:1');
  });
});

describe('every export control is named for assistive technology', () => {
  /*
    The panel's `Field` rendered a `<label>` with no `htmlFor` that wrapped nothing, so all six
    selects reached a screen reader as "combobox, combobox, …". The toggles were fine — they wrap
    their input — which is exactly why this went unnoticed: the pattern looked correct next to a
    working one.

    Asserted through `getByLabelText`, which only resolves a label that is actually associated with a
    control. A test that queried by the label *text* would pass against the broken markup.
  */
  it('associates each select with its label', () => {
    bridge.desktop = false;
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
    for (const label of ['Resolution', 'Aspect ratio', 'Frame rate', 'Format', 'Quality']) {
      expect(screen.getByLabelText(label).tagName).toBe('SELECT');
    }
    /* The bitrate label carries its value, so it is matched by prefix. */
    expect(screen.getByLabelText(/^Audio bitrate/).tagName).toBe('SELECT');
  });

  it('gives the bitrate select a stable id as its value changes', () => {
    /*
      An id derived from the label text would break the association every time the value changed —
      the label reads "Audio bitrate: 192 kbps" — which is a trap a `Field` keyed on its own text
      walks straight into.
    */
    bridge.desktop = false;
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
    const before = screen.getByLabelText(/^Audio bitrate/).id;
    fireEvent.change(screen.getByLabelText(/^Audio bitrate/), { target: { value: '256' } });
    expect(screen.getByLabelText(/^Audio bitrate/).id).toBe(before);
    expect(screen.getByLabelText('Audio bitrate: 256 kbps')).toBeTruthy();
  });
});
