/**
 * Running noise reduction from the inspector (SPEC 12 §6.8).
 *
 * The job itself is the main process's; this hook is the editor's half — it holds the in-flight
 * state per item, sends the request, and applies the result as a **command** on the timeline so the
 * change is undoable and lands in the project like every other edit.
 *
 * ## Why the result goes through the timeline API and not a `useState`
 *
 * The spec says the item points at the derived file and *Revert* restores the original. Both are
 * edits: they change what the project plays and what an export contains. A local state that only
 * the panel knew about would produce a preview that sounded cleaned and an export that did not —
 * the divergence this project has caught before, and the reason settings live on the item.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Strength } from './noise-reduction-panel.js';

/** The shape of the `media:reduceNoise` reply. Mirrors the handler in `main.ts`. */
export interface ReduceNoiseReply {
  ok: boolean;
  path?: string;
  message: string;
  method: 'afftdn' | 'arnndn';
  strength: Strength;
  cached?: boolean;
}

interface ClipwrightBridge {
  reduceNoise?: (request: {
    mediaId: string;
    inUs: number;
    durationUs: number;
    strength: string;
    hasAudio?: boolean;
  }) => Promise<ReduceNoiseReply>;
}

function getBridge(): ClipwrightBridge | undefined {
  return (window as unknown as { clipwright?: ClipwrightBridge }).clipwright;
}

export interface NoiseReductionTarget {
  /**
   * The item that asked. The result is applied to *this*, not to whatever is selected when the job
   * finishes — a job takes seconds and the selection can move in that time.
   */
  itemId: string;
  mediaId: string;
  inUs: number;
  durationUs: number;
  hasAudio?: boolean;
}

export interface UseNoiseReductionResult {
  /** Whether a job is running right now. One per editor, not one per item. */
  running: boolean;
  /** 0–100, or `null` before a job starts. */
  progress: number | null;
  /** The last sentence the job produced, for the panel to show. Cleared on the next run. */
  message: string | null;
  /** Start a job and hand the result to `onResult`. */
  reduce: (target: NoiseReductionTarget, strength: Strength) => Promise<void>;
  /** The job's own words, for a caller that wants to show them and nothing else. */
  clearMessage: () => void;
}

/**
 * @param onResult called with the finished job when it succeeded. The caller applies it to the
 *   timeline; this hook deliberately knows nothing about the document.
 */
export function useNoiseReduction(
  onResult: (result: { target: NoiseReductionTarget; reply: ReduceNoiseReply }) => void,
): UseNoiseReductionResult {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /*
    A ref rather than the `running` state, because the guard has to hold against a second press
    that arrives in the same tick as the first — before React has re-rendered the button as
    disabled. Two encodes of the same range is not a correctness bug, but it is two minutes of CPU
    the user did not ask for and two writes to the same path.
  */
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  /* Progress arrives as an event from the main process; subscribed once, not per job. */
  useEffect(() => {
    const bridge = window as unknown as {
      clipwright?: { onNoiseReductionProgress?: (cb: (p: { percent: number }) => void) => () => void };
    };
    const subscribe = bridge.clipwright?.onNoiseReductionProgress;
    if (!subscribe) return undefined;
    const unsubscribe = subscribe((update) => {
      if (mounted.current) setProgress(update.percent);
    });
    return unsubscribe;
  }, []);

  const reduce = useCallback(
    async (target: NoiseReductionTarget, strength: Strength) => {
      if (inFlight.current) return;
      const bridge = getBridge();
      if (!bridge?.reduceNoise) {
        /*
          No bridge means the renderer is running outside Electron — a test, or a browser preview.
          Saying so is better than an empty `await` that reads as a job that did nothing.
        */
        setMessage('Noise reduction needs the desktop app.');
        return;
      }

      inFlight.current = true;
      setRunning(true);
      setProgress(0);
      setMessage(null);
      try {
        const reply = await bridge.reduceNoise({
          mediaId: target.mediaId,
          inUs: target.inUs,
          durationUs: target.durationUs,
          strength,
          ...(target.hasAudio === undefined ? {} : { hasAudio: target.hasAudio }),
        });
        if (!mounted.current) return;
        setMessage(reply.message);
        if (reply.ok && reply.path) {
          onResultRef.current({
            target,
            reply: { ...reply, path: reply.path },
          });
        }
      } catch (error) {
        /*
          A thrown error here is the missing-file case the handler lets through, or a crash. The
          original is untouched either way, and the sentence has to say so — a user who has just
          seen an error needs to know their audio is still there.
        */
        if (mounted.current) {
          setMessage(
            error instanceof Error && error.message
              ? `${error.message} The original audio is untouched.`
              : 'Noise reduction failed. The original audio is untouched.',
          );
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) {
          setRunning(false);
          setProgress(null);
        }
      }
    },
    [],
  );

  const clearMessage = useCallback(() => setMessage(null), []);

  return { running, progress, message, reduce, clearMessage };
}
