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
