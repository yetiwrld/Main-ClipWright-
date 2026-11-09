// @vitest-environment jsdom
/**
 * `TimelineApi.run` — the one place an edit becomes an undo step.
 *
 * Three answers have to be told apart, and getting any of them wrong is a bug the user
 * sees rather than a test failure: a command that succeeded (commit, journal, save), one
 * that failed (say why, change nothing), and one that decided there was nothing to do —
 * `null` — which must be silent. The third was added for the guide-removal gesture, which
 * reports itself before it knows whether a guide is within reach; before it existed, the
 * only way to say "nothing to remove" was a failure, and a drag across empty canvas would
 * have put a message on screen for a gesture that was meant to do nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { addGuide, createDefaultTimeline } from '@clipwright/timeline-engine';

const getComposition = vi.fn();
const checkRecovery = vi.fn();
const saveComposition = vi.fn();
const appendJournal = vi.fn();

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    getComposition: (...args: unknown[]) => getComposition(...args),
    checkRecovery: (...args: unknown[]) => checkRecovery(...args),
    saveComposition: (...args: unknown[]) => saveComposition(...args),
    appendJournal: (...args: unknown[]) => appendJournal(...args),
    getProject: vi.fn(async () => ({ id: 'p1', settings: {} })),
    updateProject: vi.fn(async () => ({ id: 'p1', settings: {} })),
    getTranscript: vi.fn(async () => null),
  },
}));

const { useTimeline } = await import('../features/editor/use-timeline.js');

const payload = () => {
  const base = createDefaultTimeline({ id: 'comp', name: 'Clip', fps: 30 });
  return { ...base, canvas: base.canvas };
};

beforeEach(() => {
  getComposition.mockReset().mockResolvedValue({
    id: 'comp',
    projectId: 'p1',
    name: 'Clip',
    version: 1,
    updatedAt: new Date().toISOString(),
    payload: payload(),
  });
  checkRecovery.mockReset().mockResolvedValue({ needsRecovery: false, entries: [] });
  saveComposition.mockReset().mockResolvedValue(undefined);
  appendJournal.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The hook, once its composition has loaded. */
async function loaded() {
  const rendered = renderHook(() => useTimeline('p1', 'comp'));
  await waitFor(() => expect(rendered.result.current.state).not.toBeNull());
  return rendered;
}

describe('running a command', () => {
  it('commits a successful command as one undo step', async () => {
    const { result } = await loaded();
    act(() => {
      result.current.run('Add guide', (state) =>
        addGuide(state, { id: 'g1', axis: 'x', at: 0.5 }),
      );
    });
    expect(result.current.state?.guides).toHaveLength(1);
    expect(result.current.canUndo).toBe(true);
    // And a journal entry, or a crash between the edit and the autosave would lose it.
    expect(appendJournal).toHaveBeenCalledTimes(1);
  });

  it('commits nothing and says nothing when a command declines with `null`', async () => {
    /*
      This is the contract the guide-removal gesture relies on. `run` returning `false` is
      right — nothing was committed — but no undo step may appear and no note may be
      posted, because the gesture asked a question and got "no".
    */
    const { result } = await loaded();
    let answer: boolean | undefined;
    act(() => {
      answer = result.current.run('Remove guide', () => null);
    });
    expect(answer).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.notes).toEqual([]);
    expect(appendJournal).not.toHaveBeenCalled();
    expect(saveComposition).not.toHaveBeenCalled();
  });

  it('says why when a command fails, and still commits nothing', async () => {
    /*
      The other side of the same distinction: a failure is worth telling the user about, a
      no-op is not. A command that declined here would be silently swallowed, and the user
      would think their edit landed.
    */
    const { result } = await loaded();
    let answer: boolean | undefined;
    act(() => {
      answer = result.current.run('Remove guide', (state) => ({
        ok: false,
        code: 'not_found',
        message: 'That guide is already gone.',
      }));
    });
    expect(answer).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.notes).toEqual(['That guide is already gone.']);
  });

  it('does not treat a `null` from one command as a reason to block the next', async () => {
    // A declined no-op must leave the session exactly as it was, so the next edit works.
    const { result } = await loaded();
    act(() => {
      result.current.run('Remove guide', () => null);
    });
    act(() => {
      result.current.run('Add guide', (state) =>
        addGuide(state, { id: 'g1', axis: 'y', at: 0.25 }),
      );
    });
    expect(result.current.state?.guides).toEqual([
      { id: 'g1', axis: 'y', at: 0.25, locked: false },
    ]);
    expect(result.current.notes).toEqual([]);
  });
});

describe('caption regeneration is gated by the document (SPEC 11 §9)', () => {
  /*
    The gate lives in the hook, not the panel, because it is a rule about the *document*:
    with linking off, a caption track is independent text and nothing may overwrite it,
    whatever opened the command. A panel that forgot the check would be a second place to
    get it wrong — and the panel now has its own `disabled` for the affordance, so
    removing this one would leave the rule enforced only by a disabled button.
  */
  const withLinked = (payload: unknown, linked: boolean) => ({
    id: 'comp', projectId: 'p1', name: 'Clip',
    version: 1, updatedAt: new Date().toISOString(),
    payload: {
      ...(payload as Record<string, unknown>),
      toggles: {
        ...((payload as { toggles: Record<string, unknown> }).toggles),
        linkedToTranscript: linked,
      },
    },
  });

  it('does nothing when linking is off, and says so', async () => {
    // The load must carry the flag: `createDefaultTimeline` ships it on, so a fixture that
    // only overrode the *read* would test the reader rather than the document.
    getComposition.mockResolvedValueOnce(withLinked(payload(), false));
    const { result } = await loaded();
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.regenerateCaptionsFromTranscript();
    });
    expect(answer).toBe(false);
    expect(result.current.notes.join(' ')).toContain('not linked');
    expect(result.current.canUndo).toBe(false);
    expect(appendJournal).not.toHaveBeenCalled();
  });

  it('refuses when there is no transcript rather than erasing the captions', async () => {
    /*
      `regenerateCaptions` writes exactly the segments it is given — an empty list would
      delete every untouched caption on the track. Refusing before the command is what
      keeps a missing transcript from looking like a way to clear the track.
    */
    const { result } = await loaded();
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.regenerateCaptionsFromTranscript();
    });
    expect(answer).toBe(false);
    expect(result.current.notes.join(' ')).toContain('no transcript');
  });

  it('reports the transcript it could not read instead of throwing', async () => {
    // The bridge mock has no `getTranscript`, so the call rejects. An `onClick` that threw
    // would leave the panel looking as though the button did nothing.
    const { result } = await loaded();
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.regenerateCaptionsFromTranscript();
    });
    expect(answer).toBe(false);
    expect(result.current.notes.length).toBeGreaterThan(0);
  });

  it('exposes the flag from the document', async () => {
    // `!== false`, so a project saved before the field existed reads as on, which is the
    // schema's default.
    getComposition.mockResolvedValueOnce(withLinked(payload(), false));
    const { result } = await loaded();
    expect(result.current.linkedToTranscript).toBe(false);
  });
});

describe('adding an icon (SPEC 11 §12)', () => {
  it('adds a drawable icon as an undoable item', async () => {
    const { result } = await loaded();
    const before = Object.keys(result.current.state?.items ?? {}).length;
    let answer: boolean | undefined;
    act(() => {
      answer = result.current.addIcon('star');
    });
    expect(answer).toBe(true);
    expect(Object.keys(result.current.state?.items ?? {}).length).toBe(before + 1);
    const item = Object.values(result.current.state?.items ?? {}).find(
      (candidate) => candidate.iconName === 'star',
    );
    expect(item).toBeDefined();
    // No `shapeKind`: the renderers branch on that to ask the icon library.
    expect(item?.shapeKind).toBeUndefined();
    expect(result.current.canUndo).toBe(true);
    // The journal, or a crash between the edit and the autosave loses it.
    expect(appendJournal).toHaveBeenCalledTimes(1);
  });

  it('refuses an icon this build cannot draw, rather than adding one that paints nothing', async () => {
    /*
      The failure this guards: an item is created, the timeline draws its chip, the user
      selects and moves it, and no renderer ever produces a pixel — in the editor *and* in
      the export. `gift` is a real Lucide icon whose ribbon is an elliptical arc, which this
      build refuses by name; it must be refused *here*, before the item exists.
    */
    const { result } = await loaded();
    const before = Object.keys(result.current.state?.items ?? {}).length;
    let answer: boolean | undefined;
    act(() => {
      answer = result.current.addIcon('gift');
    });
    expect(answer).toBe(false);
    expect(Object.keys(result.current.state?.items ?? {}).length).toBe(before);
    expect(result.current.canUndo).toBe(false);
    expect(appendJournal).not.toHaveBeenCalled();
  });

  it('refuses a name that is not in the library', async () => {
    const { result } = await loaded();
    let answer: boolean | undefined;
    act(() => {
      answer = result.current.addIcon('no-such-icon');
    });
    expect(answer).toBe(false);
    expect(result.current.canUndo).toBe(false);
  });
});
