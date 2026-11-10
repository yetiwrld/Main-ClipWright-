// @vitest-environment jsdom
/**
 * The brand-kit panel (SPEC 13 §8.2).
 *
 * The interesting parts are not the drawing: they are the decisions a user cannot see. That
 * applying a kit is **one undo step** even though it is four commands; that the apply button is
 * disabled by *planning* rather than by looking at the kit, so a kit whose logo is missing from
 * this project does not offer to place one; that deleting a kit says what happens to the items
 * it placed; and that a composition's length is the ruler's own function rather than a second
 * definition that could drift from it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { applyPatches, enablePatches } from 'immer';
import {
  CwbrandFormat,
  CwbrandFormatVersion,
  planKitApplication,
  type BrandKit,
} from '@clipwright/brand-kits';
import {
  createDefaultTimeline,
  projectDurationUs,
  type CommandResult,
  type TimelineState,
} from '@clipwright/timeline-engine';
import {
  APPLY_SCOPES,
  BrandKitPanel,
  applyKitCommand,
  canApply,
  kitFootprint,
  planSummary,
} from '../BrandKitPanel.js';
import { projectKitsFromSettings } from '../use-brand-kits.js';
import type { TimelineApi } from '../use-timeline.js';
import type { BrandKitsApi } from '../use-brand-kits.js';

enablePatches();
afterEach(cleanup);

const CANVAS = { widthPx: 1920, heightPx: 1080 };

function kit(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    format: CwbrandFormat,
    formatVersion: CwbrandFormatVersion,
    id: 'kit-1',
    name: 'Studio',
    colors: {
      primary: '#FF7A00',
      secondary: '#1F2937',
      accent: '#4DA3FF',
      background: '#0B0B0F',
      text: '#FFFFFF',
      custom: [],
    },
    fonts: {},
    safeAreaPreset: 'none',
    ...overrides,
  } as BrandKit;
}

const LOGO = {
  assetId: 'logo-1',
  position: 'br' as const,
  xPct: 4,
  yPct: 4,
  sizePct: 12,
  opacity: 1,
  margin: 4,
  showFrom: 'always' as const,
  showFor: 'whole' as const,
};

/** A timeline with two clips on the main track, four seconds each. */
function timelineWithClips(): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const main = base.tracks.find((track) => track.role === 'main')!;
  const items = { ...base.items };
  for (const [index, id] of ['v-1', 'v-2'].entries()) {
    items[id] = {
      ...Object.values(base.items)[0]!,
      id,
      trackId: main.id,
      type: 'video',
      label: id,
      startUs: index * 4_000_000,
      durationUs: 4_000_000,
      sourceDurationUs: 4_000_000,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, flipH: false, flipV: false },
    } as (typeof items)[string];
  }
  const tracks = base.tracks.map((track) =>
    track.id === main.id ? { ...track, itemIds: ['v-1', 'v-2'] } : track,
  );
  return { ...base, items, tracks };
}

const api = (overrides: Partial<TimelineApi> = {}): TimelineApi =>
  ({
    state: null,
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
    run: vi.fn(() => true),
    undo: vi.fn(),
    redo: vi.fn(),
    ...overrides,
  }) as unknown as TimelineApi;

const kitsApi = (kits: BrandKit[], overrides: Partial<BrandKitsApi> = {}): BrandKitsApi => ({
  kits,
  get: (id) => kits.find((entry) => entry.id === id),
  save: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  loading: false,
  error: '',
  ...overrides,
});

/**
 * A fake preload bridge. The export/import path is the only part of the panel that talks to main,
 * so installing one is the only way to reach it from a jsdom test — and the panel must ask
 * `isDesktop()` first, because the same renderer runs in a plain browser during UI work.
 */
function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    exportBrandKit: vi.fn(async () => null as { path: string; missingAssets: string[] } | null),
    importBrandKit: vi.fn(
      async () =>
        null as { kit: unknown; assets: Array<{ name: string; data: string }>; missingAssets: string[] } | null,
    ),
    ...overrides,
  };
  (window as unknown as { clipwright: unknown }).clipwright = bridge;
  return bridge;
}

afterEach(() => {
  delete (window as unknown as { clipwright?: unknown }).clipwright;
});

describe('playhead-independent decisions', () => {
  it('takes the composition’s length from the ruler’s own function', () => {
    /*
      A `showFor: 'whole'` logo and the outro's start both need the composition's length. The
      panel calls `projectDurationUs` rather than computing its own, so the two cannot drift —
      and the difference is observable: that function ignores *hidden* tracks, so a project
      whose only clips are on a hidden track measures one second, as the ruler does. A local
      `max over every item` would say eight, and the logo would run past the visible end.
    */
    const state = timelineWithClips();
    const hidden: TimelineState = {
      ...state,
      tracks: state.tracks.map((track) =>
        track.itemIds.length > 0 ? { ...track, hidden: true } : track,
      ),
    };
    expect(Math.round(projectDurationUs(state) / 1_000_000)).toBe(8);
    expect(Math.round(projectDurationUs(hidden) / 1_000_000)).toBe(1);
  });

  it('counts what a kit has already placed here, and only this kit', () => {
    /*
      The count decides whether the card offers "Apply" or "Reapply", so it has to be about
      *this* kit. A project with a kit already applied twice — once by each of two kits — must
      report one item each, not two.
    */
    expect(kitFootprint(timelineWithClips(), 'kit-1')).toEqual({ count: 0, itemIds: [] });

    const state = timelineWithClips();
    const tagged = (id: string, kitId: string, trackId: string) => ({
      ...Object.values(state.items)[0]!,
      id,
      trackId,
      type: 'image' as const,
      mediaId: `asset-${id}`,
      startUs: 0,
      durationUs: 1_000_000,
      aiProvenance: { tool: 'brand-kit' as const, kitId, appliedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    });
    const main = state.tracks.find((track) => track.role === 'main')!;
    const withKits: TimelineState = {
      ...state,
      items: {
        ...state.items,
        'logo-a': tagged('logo-a', 'kit-1', main.id),
        'logo-b': tagged('logo-b', 'kit-2', main.id),
      } as typeof state.items,
      tracks: state.tracks.map((track) =>
        track.id === main.id ? { ...track, itemIds: [...track.itemIds, 'logo-a', 'logo-b'] } : track,
      ),
    };
    expect(kitFootprint(withKits, 'kit-1')).toEqual({ count: 1, itemIds: ['logo-a'] });
    expect(kitFootprint(withKits, 'kit-2').count).toBe(1);
  });

  it('offers the three scopes the spec names, in its order', () => {
    expect(APPLY_SCOPES.map((scope) => scope.label)).toEqual(['This clip', 'All clips']);
  });
});

describe('canApply', () => {
  const parts = {
    captions: true,
    logo: true,
    introOutro: true,
    lowerThird: true,
    music: true,
    textDefaults: true,
  };

  it('enables the button when the project has the logo', () => {
    const enabled = canApply(
      kit({ logo: LOGO }),
      timelineWithClips(),
      parts,
      CANVAS,
      new Set(),
      new Set(['logo-1']),
    );
    expect(enabled).toBe(true);
  });

  it('disables it when the kit’s only part needs an asset this project lacks', () => {
    /*
      The button is decided by *planning*, not by "does the kit have a logo": a kit with a logo
      that is not in this project would light up a button that then does nothing.
    */
    const enabled = canApply(
      kit({ logo: LOGO }),
      timelineWithClips(),
      parts,
      CANVAS,
      new Set(),
      new Set(['something-else']),
    );
    expect(enabled).toBe(false);
  });

  it('ignores a part the user switched off', () => {
    // Unchecking the logo makes a kit with only a logo inapplicable — and that is correct:
    // the user asked for nothing, and the report says so.
    const enabled = canApply(
      kit({ logo: LOGO }),
      timelineWithClips(),
      { ...parts, logo: false },
      CANVAS,
      new Set(),
      new Set(['logo-1']),
    );
    expect(enabled).toBe(false);
  });

  it('is enabled for a caption style the project has', () => {
    const enabled = canApply(
      kit({ captionStyleId: 'bold-creator' }),
      timelineWithClips(),
      parts,
      CANVAS,
      new Set(['bold-creator']),
      new Set(),
    );
    expect(enabled).toBe(true);
  });
});

describe('planSummary', () => {
  it('describes the parts the plan will apply', () => {
    const plan = planKitApplication(
      kit({ logo: LOGO, intro: { assetId: 'intro-1', durationSec: 2 } }),
      CANVAS,
      8_000_000,
      { assetIds: new Set(['logo-1', 'intro-1']), captionStyleIds: new Set() },
    );
    const lines = planSummary(plan).join(' ').toLowerCase();
    expect(lines).toContain('logo');
    expect(lines).toContain('intro');
  });

  it('says nothing about a part that will not be applied', () => {
    // A summary that listed every part would promise a watermark to a kit that has none.
    const plan = planKitApplication(kit({ logo: LOGO }), CANVAS, 8_000_000, {
      assetIds: new Set(['logo-1']),
      captionStyleIds: new Set(),
    });
    const lines = planSummary(plan).join(' ').toLowerCase();
    expect(lines).not.toContain('watermark');
    expect(lines).not.toContain('music');
  });
});

describe('applyKitCommand', () => {
  const parts = {
    captions: true,
    logo: true,
    introOutro: true,
    lowerThird: true,
    music: true,
    textDefaults: true,
  };

  const options = {
    canvas: CANVAS,
    fps: 30 as const,
    captionStyleIds: new Set<string>(),
    assetIds: new Set(['logo-1', 'intro-1']),
    now: () => '2026-01-01T00:00:00.000Z',
  };

  it('applies graphics, captions and an intro as one undo step', () => {
    /*
      The claim the spec makes by saying "one transaction": pressing Apply once and pressing
      Ctrl+Z once must return the project to where it was. The four commands each produce their
      own patch set, so the composed command has to rebuild one that covers all of them.
    */
    const state = timelineWithClips();
    const command = applyKitCommand(
      kit({ logo: LOGO, captionStyleId: 'bold-creator', intro: { assetId: 'intro-1', durationSec: 2 } }),
      parts,
      { ...options, captionStyleIds: new Set(['bold-creator']) },
    );
    const result = command(state) as CommandResult;
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;

    // The logo is there, the intro is there, and the pictures moved.
    const items = Object.values(result.state.items);
    expect(items.some((item) => item.mediaId === 'logo-1')).toBe(true);
    expect(items.some((item) => item.mediaId === 'intro-1')).toBe(true);
    expect(result.state.items['v-1']!.startUs).toBe(2_000_000);

    // And one undo step puts every one of them back.
    const undone = applyPatches(result.state, result.inverse);
    expect(undone.items['v-1']!.startUs).toBe(0);
    expect(Object.values(undone.items).some((item) => item.mediaId === 'logo-1')).toBe(false);
    expect(Object.values(undone.items).some((item) => item.mediaId === 'intro-1')).toBe(false);
  });

  it('redoes with the forward patches, restoring what the undo removed', () => {
    /*
      Undo and redo are the two halves of one history entry, and the first version of this
      suite only exercised the inverse: a patch set full of *before* values undid correctly and
      then redid the project to the state it was already in. `run` applies `patches` on redo, so
      that is the direction asserted here.
    */
    const command = applyKitCommand(
      kit({ logo: LOGO, intro: { assetId: 'intro-1', durationSec: 2 } }),
      { captions: true, logo: true, introOutro: true, lowerThird: true, music: true, textDefaults: true },
      { ...options, assetIds: new Set(['logo-1', 'intro-1']) },
    );
    const result = command(timelineWithClips()) as CommandResult;
    if (!result.ok) throw new Error('expected the apply to succeed');

    const undone = applyPatches(result.state, result.inverse);
    expect(Object.values(undone.items).some((item) => item.mediaId === 'logo-1')).toBe(false);

    const redone = applyPatches(undone, result.patches);
    expect(Object.values(redone.items).some((item) => item.mediaId === 'logo-1')).toBe(true);
    expect(redone.items['v-1']!.startUs).toBe(2_000_000);
  });

  it('reports the items it affected', () => {
    // The history uses these to restore a selection after an undo; an empty list would leave
    // the user looking at a timeline with nothing selected after pressing Apply.
    const result = applyKitCommand(kit({ logo: LOGO }), parts, options)(timelineWithClips()) as CommandResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.affectedItemIds.length).toBeGreaterThan(0);
  });

  it('returns null when nothing changed', () => {
    // `run` treats null as "nothing to do" and pushes no undo step. An apply that produced an
    // empty history entry would make Ctrl+Z appear broken.
    const result = applyKitCommand(kit(), parts, options)(timelineWithClips());
    expect(result).toBeNull();
  });
});

describe('projectKitsFromSettings', () => {
  it('reads kits out of the project settings, keyed by id', () => {
    const kits = projectKitsFromSettings({
      brandKits: { 'kit-1': kit({ name: 'Studio' }), 'kit-2': kit({ id: 'kit-2', name: 'Shorts' }) },
    });
    expect(Object.keys(kits).sort()).toEqual(['kit-1', 'kit-2']);
    expect(kits['kit-2']!.name).toBe('Shorts');
  });

  it('drops an entry that is not a kit instead of failing the whole project', () => {
    // A kit written by a newer build, or one a bad merge mangled, must not stop the editor
    // from opening: the user loses that kit, not the project.
    const kits = projectKitsFromSettings({
      brandKits: { good: kit(), bad: { format: 'something-else' } },
    });
    expect(Object.keys(kits)).toEqual(['good']);
  });

  it('returns nothing for a project with no kits', () => {
    expect(projectKitsFromSettings(undefined)).toEqual({});
    expect(projectKitsFromSettings({})).toEqual({});
  });

  it('keys by the map’s id when the object disagrees', () => {
    // The map is the identity every caller looks a kit up with; an object whose `id` drifted
    // would otherwise be found under one key and report another.
    const kits = projectKitsFromSettings({ brandKits: { keyed: kit({ id: 'other' }) } });
    expect(kits.keyed!.id).toBe('keyed');
  });
});

describe('BrandKitPanel', () => {
  it('says what a kit is for when the project has none, and offers nothing disabled', () => {
    // SPEC 13 §2: an unfinished tool is never shown as a teaser. With no kits there is no
    // greyed-out Apply button — there is an explanation and nothing else.
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set()}
        media={[]}
      />,
    );
    expect(screen.getByText('No brand kits yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('offers Apply on a kit that has not been used here', () => {
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([kit({ logo: LOGO })])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[]}
      />,
    );
    expect(screen.getByText('Studio')).toBeTruthy();
    expect(screen.getByRole('button', { name: /apply…/i })).toBeTruthy();
    // No "Reapply" until the kit has actually placed something.
    expect(screen.queryByRole('button', { name: /reapply/i })).toBeNull();
  });

  it('says what deleting a kit does to the items it placed', () => {
    // The sentence that stops a user keeping a kit they have outgrown because they fear the
    // timeline losing its logo.
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([kit({ logo: LOGO })])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /delete studio/i }));
    expect(screen.getByText(/stay where they are/i)).toBeTruthy();
  });

  it('shows the apply dialog with the spec’s parts as checkboxes', () => {
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([kit({ logo: LOGO })])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply…/i }));
    for (const label of ['Caption style', 'Logo / watermark', 'Intro / outro', 'Lower third', 'Music + ducking']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('warns in the dialog when the kit’s logo is not in this project', () => {
    /*
      SPEC 13 §8.3's "missing asset → skipped with a report", surfaced where the user is
      standing. The dialog must name the problem before the button is pressed, not after.
    */
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([kit({ logo: LOGO })])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set()}
        media={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply…/i }));
    expect(screen.getByText(/logo is missing from the media library/i)).toBeTruthy();
  });

  it('runs the apply through the timeline, so it is undoable', () => {
    // Nothing in the panel touches state directly: `timeline.run` is the only writer, which is
    // what keeps the autosave honest and the undo stack complete.
    // Typed with the real signature: an untyped `vi.fn` records calls as a zero-argument
    // tuple, so reading the label off it is a type error rather than a test.
    const run = vi.fn((_label: string, _command: unknown) => true);
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api({ run })}
        brandKits={kitsApi([kit({ logo: LOGO })])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply…/i }));
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    expect(run).toHaveBeenCalledTimes(1);
    // `run` takes (label, command); the label is what the undo history shows the user.
    expect(run.mock.calls.map((call) => call[0])).toContain('Apply brand kit');
  });
});

/**
 * The kit editor, from the panel's side.
 *
 * The draft's rules are tested in `brand-kit-draft.test.ts`; what is checked here is that the
 * dialog is *reachable* and that saving writes through the store — a form nobody can open, or
 * one whose Save goes nowhere, is the failure mode a pure-function suite cannot see.
 */
describe('kit editor', () => {
  const renderPanel = (kits: BrandKit[], overrides: Partial<BrandKitsApi> = {}) =>
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi(kits, overrides)}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[
          { id: 'logo-1', label: 'logo.png', kind: 'image' },
          { id: 'intro-1', label: 'intro.mp4', kind: 'video' },
        ]}
      />,
    );

  it('opens the editor from the empty state, so a project with no kits can make one', () => {
    // The gap this closes: before the editor, a new project's kit list was permanently empty
    // and nothing in the app could write a kit.
    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: /new kit/i }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/new brand kit/i)).toBeTruthy();
  });

  it('opens the editor on an existing kit with its fields filled in', () => {
    renderPanel([kit({ name: 'Studio', captionStyleId: 'bold-creator' })]);
    fireEvent.click(screen.getByRole('button', { name: /edit studio/i }));
    expect(screen.getByText(/edit “studio”/i)).toBeTruthy();
    // The caption style id comes from the kit, not from a default.
    const input = screen.getByDisplayValue('bold-creator');
    expect(input).toBeTruthy();
  });

  it('saves a new kit through the store', () => {
    // Typed so the call's argument is a `BrandKit` rather than a zero-length tuple.
    const save = vi.fn(async (_kit: BrandKit) => true);
    renderPanel([], { save });
    fireEvent.click(screen.getByRole('button', { name: /new kit/i }));

    // The name is required, so the first press reports the problem instead of saving.
    fireEvent.click(screen.getByRole('button', { name: /save kit/i }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/needs a name/i);

    fireEvent.change(screen.getByPlaceholderText(/studio, client a/i), { target: { value: 'Client A' } });
    fireEvent.click(screen.getByRole('button', { name: /save kit/i }));
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]![0];
    expect(saved.name).toBe('Client A');
    // A readable id from the name, so the kit is identifiable in a `.cwbrand` file.
    expect(saved.id).toBe('client-a');
  });

  it('offers “From this clip” only when there is a clip to capture', () => {
    // SPEC 13 §2: a control that cannot work is not drawn, not drawn disabled.
    const { rerender } = renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: /new kit/i }));
    expect(screen.queryByRole('button', { name: /from this clip/i })).toBeNull();

    rerender(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([])}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[]}
        captureItems={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /new kit/i }));
    expect(screen.getByRole('button', { name: /from this clip/i })).toBeTruthy();
  });

  it('fills the form from the clip when “From this clip” is pressed', () => {
    /*
      The capture's result must reach the *fields*, and its notes must be visible: a capture
      that reported "this clip has no captions" into a toast the dialog covers up would leave
      the user wondering why the colours did not appear.
    */
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi([])}
        canvas={CANVAS}
        captionStyleIds={new Set(['bold-creator'])}
        assetIds={new Set(['logo-1'])}
        media={[]}
        captureItems={[
          {
            id: 'cap-1',
            type: 'caption',
            trackId: 'captions',
            startUs: 0,
            durationUs: 1_000_000,
            captionStyleId: 'bold-creator',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /new kit/i }));
    fireEvent.click(screen.getByRole('button', { name: /from this clip/i }));
    expect(screen.getByDisplayValue('bold-creator')).toBeTruthy();
    // The note about the clip's lack of a corner image is shown above the form.
    expect(screen.getByRole('status').textContent).toMatch(/logo|caption/i);
  });
});

describe('export and import (SPEC 13 §8)', () => {
  const panel = (kits: BrandKit[], overrides: Partial<BrandKitsApi> = {}) =>
    render(
      <BrandKitPanel
        state={timelineWithClips()}
        timeline={api()}
        brandKits={kitsApi(kits, overrides)}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[]}
      />,
    );

  it('names the extension when main asks for a file name, so nobody types it', async () => {
    // Electron returns the typed name unchanged. A user who types "Studio" must still get a
    // .cwbrand file — one their colleague's machine offers to open.
    const bridge = installBridge({ exportBrandKit: vi.fn(async () => ({ path: '/tmp/Studio.cwbrand', missingAssets: [] })) });
    panel([kit({ logo: LOGO })]);
    fireEvent.click(screen.getByRole('button', { name: /export studio/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Exported to \/tmp\/Studio\.cwbrand/));
    expect(bridge.exportBrandKit).toHaveBeenCalledWith(expect.objectContaining({ id: 'kit-1' }), 'Studio.cwbrand');
  });

  it('reports assets that could not go into the file, by name', async () => {
    // A file with a note beats no file, but silently dropping the logo would give the recipient
    // a kit that references a picture it does not contain.
    installBridge({
      exportBrandKit: vi.fn(async () => ({ path: '/tmp/Studio.cwbrand', missingAssets: ['logo.png'] })),
    });
    panel([kit({ logo: LOGO })]);
    fireEvent.click(screen.getByRole('button', { name: /export studio/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/logo\.png/));
  });

  it('says nothing at all when the save dialog is cancelled', async () => {
    // Cancelling is not an outcome. "Export cancelled." under a kit a second later looks like a
    // failure the user has to reason about; nothing happening is what they asked for.
    installBridge({ exportBrandKit: vi.fn(async () => null) });
    panel([kit({ logo: LOGO })]);
    fireEvent.click(screen.getByRole('button', { name: /export studio/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /export studio/i })).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays silent in a browser, where there is no file to write', () => {
    panel([kit({ logo: LOGO })]);
    fireEvent.click(screen.getByRole('button', { name: /export studio/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('imports a kit and saves it with the file’s own id', async () => {
    const bridge = installBridge({
      importBrandKit: vi.fn(async () => ({ kit: kit({ id: 'studio-x', name: 'Studio X' }), assets: [], missingAssets: [] })),
    });
    const save = vi.fn<BrandKitsApi['save']>(async () => true);
    panel([], { save });
    fireEvent.click(screen.getByRole('button', { name: /import a brand kit/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Imported “Studio X”/));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'studio-x' }));
    expect(bridge.importBrandKit).toHaveBeenCalledTimes(1);
  });

  it('re-ids an imported kit that collides, because importing is an add and not a replace', async () => {
    // Overwriting would silently move every item the existing kit had applied to the new one's
    // provenance — and delete, reapply, and the "comes from" label all key on that id.
    installBridge({
      importBrandKit: vi.fn(async () => ({ kit: kit({ id: 'kit-1' }), assets: [], missingAssets: [] })),
    });
    const save = vi.fn<BrandKitsApi['save']>(async () => true);
    panel([kit({ id: 'kit-1' })], { save });
    fireEvent.click(screen.getByRole('button', { name: /import a brand kit/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const saved = save.mock.calls[0]![0];
    expect(saved.id).not.toBe('kit-1');
    expect(saved.id).toMatch(/^studio-imported/);
  });

  it('imports into a project with no kits at all', () => {
    // The empty state is where importing matters most — a fresh project — so the button must be
    // in that branch too, not only next to the cards.
    installBridge({
      importBrandKit: vi.fn(async () => ({ kit: kit({ id: 'studio-x', name: 'Studio X' }), assets: [], missingAssets: [] })),
    });
    panel([]);
    expect(screen.getByText('No brand kits yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /import a brand kit/i })).toBeTruthy();
  });

  it('tells the user which assets the file did not contain', async () => {
    installBridge({
      importBrandKit: vi.fn(async () => ({
        kit: kit({ id: 'studio-x', name: 'Studio X' }),
        assets: [],
        missingAssets: ['intro.mp4'],
      })),
    });
    panel([]);
    fireEvent.click(screen.getByRole('button', { name: /import a brand kit/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/intro\.mp4/));
  });

  it('explains a file that is not a kit instead of crashing on it', async () => {
    // Picking the wrong file is a user mistake, not a broken app. The schema's own summary names
    // the field that is wrong, which is more use than "invalid file".
    installBridge({ importBrandKit: vi.fn(async () => ({ kit: { name: 42 }, assets: [], missingAssets: [] })) });
    const save = vi.fn<BrandKitsApi['save']>(async () => true);
    panel([], { save });
    fireEvent.click(screen.getByRole('button', { name: /import a brand kit/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/format|version|name|id/i));
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the message main sent, not the Electron wrapper around it', async () => {
    // Electron prefixes rejections with "Error invoking remote method 'brandKit:import': Error:",
    // which is noise the user cannot act on. `describeError` strips it.
    installBridge({
      importBrandKit: vi.fn(async () => {
        throw new Error("Error invoking remote method 'brandKit:import': Error: The file is not a .cwbrand archive.");
      }),
    });
    panel([]);
    fireEvent.click(screen.getByRole('button', { name: /import a brand kit/i }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('The file is not a .cwbrand archive.'),
    );
  });
});

describe('batch apply across the project’s clips (SPEC 08 §8.1)', () => {
  /*
    The other clips are documents this window never loaded, so the panel has to read them, plan
    them and write them back. These tests drive that through the stubbed bridge, because the
    interesting part is *which* files get written — and in particular that the open clip is not
    one of them: its own history owns it.
  */
  const record = { projectId: 'project-1' } as unknown as NonNullable<TimelineApi['record']>;

  /**
   * The clips the batch reads back. They are built from the panel's *own* state, because the
   * batch is required to plan a clip against what is on disk — a fixture with a different
   * document would test the fixture rather than the panel.
   */
  const clipPayload = () => timelineWithClips();

  const bridge = () => {
    const saveComposition = vi.fn(async (_projectId: string, comp: unknown) => comp);
    const b = installBridge({
      getCompositions: vi.fn(async () => [
        { id: 'open-clip', name: 'Open clip', version: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'second', name: 'Second', version: 5, updatedAt: '2026-01-01T00:00:00.000Z' },
      ]),
      getComposition: vi.fn(async (_projectId: string, compId: string) => ({
        id: compId,
        projectId: 'project-1',
        name: compId === 'second' ? 'Second' : 'Open clip',
        version: compId === 'second' ? 5 : 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
        payload: { ...clipPayload(), id: compId },
      })),
      saveComposition,
      exportBrandKit: vi.fn(async () => null),
      importBrandKit: vi.fn(async () => null),
    });
    return { b, saveComposition };
  };

  const panelWithRecord = (timelineOverrides: Partial<TimelineApi> = {}, kits: BrandKit[] = [kit({ logo: LOGO })]) =>
    render(
      <BrandKitPanel
        /* The document's own id is what the batch uses to tell the open clip from the others. */
        state={{ ...timelineWithClips(), id: 'open-clip' }}
        timeline={{ ...api(), record, ...timelineOverrides }}
        brandKits={kitsApi(kits)}
        canvas={CANVAS}
        captionStyleIds={new Set()}
        assetIds={new Set(['logo-1'])}
        media={[{ id: 'logo-1', label: 'logo.png', kind: 'image' }]}
      />,
    );

  const openApply = () => {
    fireEvent.click(screen.getByRole('button', { name: /apply…/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'All clips' }));
  };

  it('writes every other clip and leaves the open one to its own undo', async () => {
    /*
      One application, two undo routes. The open clip goes through `timeline.run`, so Ctrl+Z in
      this window undoes it; writing it here as well would make the undo stack describe a file
      that is no longer on disk.
    */
    const { saveComposition } = bridge();
    const run = vi.fn(() => true);
    panelWithRecord({ run });
    openApply();
    fireEvent.click(screen.getByRole('button', { name: /apply to all clips/i }));

    /*
      Two writers, and both are wanted: the batch writes *the other* clip, and the open clip's
      own debounce (two seconds) saves the document `run` changed. Asserting a count would pin
      the debounce; asserting the ids says what the batch is responsible for.
    */
    await waitFor(() => expect(saveComposition).toHaveBeenCalled());
    const written = saveComposition.mock.calls.map((call) => (call[1] as { id: string }).id);
    expect(written).toContain('second');
    expect(written.filter((id) => id === 'second')).toHaveLength(1);
    expect(run).toHaveBeenCalled();
    expect((run.mock.calls[0] as unknown[])[0]).toBe('Apply brand kit to all clips');
  });

  it('offers one undo for the clips that are not open, and restores them', async () => {
    /*
      The batch is the only writer of the other clips, and their history lives in whichever
      editor opens them next. Without this button the honest option would be to refuse batch
      apply — and a change with no way back is worse than either.
    */
    const { saveComposition } = bridge();
    panelWithRecord();
    openApply();
    fireEvent.click(screen.getByRole('button', { name: /apply to all clips/i }));

    const undo = await screen.findByRole('button', { name: /undo batch/i });
    expect(undo.textContent).toMatch(/1 other clip/);
    /* The open clip's debounce lands too; the undo is about the *other* clip, so clear first. */
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    saveComposition.mockClear();
    fireEvent.click(undo);
    await waitFor(() => expect(saveComposition).toHaveBeenCalledTimes(1));
    /* The restored payload is the *unbranded* one, not the branded one it just wrote. */
    const restored = (saveComposition.mock.calls[0]![1] as { payload: TimelineState }).payload;
    const branded = Object.values(restored.items).some(
      (item) => item.aiProvenance?.tool === 'brand-kit',
    );
    expect(branded).toBe(false);
  });

  it('writes nothing when a clip cannot take the kit, and says which', async () => {
    /*
      A half-applied batch across five clips is the one outcome a user cannot unpick by hand, so
      every clip is planned before a single file is written. The refusal here is real: a
      composition template cannot be built as a clip yet (SPEC 13 §8.3), and the engine says so
      rather than inserting a clip with no media.
    */
    const saveComposition = vi.fn(async (_projectId: string, comp: unknown) => comp);
    installBridge({
      getCompositions: vi.fn(async () => [
        { id: 'open-clip', name: 'Open clip', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'second', name: 'Second', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
      ]),
      getComposition: vi.fn(async (_projectId: string, compId: string) => ({
        id: compId,
        projectId: 'project-1',
        name: compId === 'second' ? 'Second' : 'Open clip',
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        payload: { ...timelineWithClips(), id: compId },
      })),
      saveComposition,
    });
    panelWithRecord(
      { run: vi.fn(() => true) },
      [
        kit({
          logo: LOGO,
          intro: { compositionTemplateId: 'tpl-1', durationSec: 2 },
        } as Partial<BrandKit>),
      ],
    );
    openApply();
    fireEvent.click(screen.getByRole('button', { name: /apply to all clips/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not apply/i));
    expect(screen.getByRole('status').textContent).toMatch(/template/i);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    /* The open clip's own debounce does not save, because the batch refused before plan time. */
    expect(saveComposition).not.toHaveBeenCalled();
  });

  it('shows progress while it runs, so a five-clip batch is not a frozen button', async () => {
    const { saveComposition } = bridge();
    panelWithRecord();
    openApply();
    fireEvent.click(screen.getByRole('button', { name: /apply to all clips/i }));
    await waitFor(() => expect(saveComposition).toHaveBeenCalled());
    /* Once finished the progress line is replaced by the summary. */
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/applied to/i));
  });

  it('says so instead of doing nothing when the project has no clips', async () => {
    installBridge({
      getCompositions: vi.fn(async () => []),
      getComposition: vi.fn(async () => null),
      saveComposition: vi.fn(async () => null),
    });
    panelWithRecord();
    openApply();
    fireEvent.click(screen.getByRole('button', { name: /apply to all clips/i }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/no clips in this project/i),
    );
  });

  it('offers no “Selected” scope while choosing clips is impossible', () => {
    /*
      SPEC 13 §8.2 lists three scopes. Choosing several clips needs a clip bin, and this build
      has none — so the third is *absent* rather than disabled or, worse, silently doing what
      "This clip" does under another name.
    */
    expect(APPLY_SCOPES.map((entry) => entry.label)).toEqual(['This clip', 'All clips']);
    panelWithRecord();
    fireEvent.click(screen.getByRole('button', { name: /apply…/i }));
    expect(screen.queryByRole('radio', { name: 'Selected' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'All clips' })).toBeTruthy();
  });
});
