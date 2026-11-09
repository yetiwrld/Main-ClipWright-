/**
 * Keeps a `<video>` element's `currentTime` following the playhead without thrashing
 * it (SPEC 09 §23).
 *
 * Assigning `currentTime` starts a seek. Assigning it again while one is running
 * **aborts** the first and starts over, so a hundred pointer moves during a scrub used
 * to mean a hundred abandoned decodes and a picture that showed none of them. The
 * element spends the drag never finishing anything.
 *
 * The fix is not a timer or a debounce — a debounce would make a slow scrub lag the
 * pointer and stop following at all when the user pauses mid-drag. It is a coalescer:
 * at most one seek is ever in flight, the target is *held* rather than queued, and when
 * the element reports it has settled the newest target (if it moved) starts the next
 * seek. That converges on where the pointer actually is, in at most one seek of lag,
 * however fast the drag.
 *
 * Lives outside the component because the interesting behaviour — "a target that
 * arrives mid-seek replaces the one waiting, rather than queueing behind it" — is a
 * state machine, and a state machine tested through a real `<video>` is tested through
 * a browser's timing rather than its own logic.
 */

export interface SeekCoalescerOptions {
  /** Ask the element to seek. Must eventually be answered by `settled()`. */
  seek: (seconds: number) => void;
}

export interface SeekCoalescer {
  /** Ask for a playhead position. Replaces any target already waiting. */
  request: (seconds: number) => void;
  /** The element's `seeked` event: the in-flight seek is over. */
  settled: () => void;
  /**
   * Throw away the waiting target without seeking to it.
   *
   * For when the element changes underneath the coalescer — a new source, or a switch
   * from scrubbing to playing — where a pending scrub target is no longer meaningful
   * and following it would yank the picture back to where the pointer last was.
   */
  cancel: () => void;
  /** Whether a seek is in flight, for tests and for skipping redundant work. */
  readonly isSeeking: () => boolean;
  /** The target waiting for the in-flight seek to finish, if any. */
  readonly pendingTarget: () => number | null;
}

export function createSeekCoalescer(options: SeekCoalescerOptions): SeekCoalescer {
  let seeking = false;
  /** The newest target that arrived while a seek was running. */
  let pending: number | null = null;

  const start = (seconds: number) => {
    seeking = true;
    options.seek(seconds);
  };

  return {
    request: (seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      /*
        While a seek is running the target is *overwritten*, not queued: if the pointer
        moved through three positions during one decode the user wants the last one, and
        playing them back in order would make the picture chase the pointer rather than
        follow it.
      */
      if (seeking) {
        pending = seconds;
        return;
      }
      start(seconds);
    },
    settled: () => {
      seeking = false;
      const next = pending;
      pending = null;
      if (next !== null) start(next);
    },
    cancel: () => {
      pending = null;
    },
    isSeeking: () => seeking,
    pendingTarget: () => pending,
  };
}

/**
 * How far the playhead may drift before a seek is worth its cost, in seconds.
 *
 * The two regimes want opposite things. **While playing**, the element advances itself
 * and a seek interrupts it — a hitch on screen — so only a real drift is corrected.
 * **While scrubbing or paused**, the element is the only thing that can show the frame
 * under the playhead, so a fraction of a frame is already worth correcting; the
 * coalescer is what keeps that from becoming a seek per pointer move.
 */
export function seekThreshold(playing: boolean, fps: number): number {
  const frame = fps > 0 ? 1 / fps : 1 / 30;
  /*
    Four frames while playing: enough that ordinary drift from `play()` starting a few
    milliseconds late does not cause a correction, which would be a stutter for no
    reason. Half a frame while paused: the user is looking at a still, and half a frame
    is the point at which the still is visibly the wrong one.
  */
  return playing ? Math.max(0.2, frame * 4) : frame * 0.5;
}

/** Whether the playhead has drifted far enough to be worth a seek. */
export function shouldSeek(
  currentSeconds: number,
  targetSeconds: number,
  options: { playing: boolean; fps: number },
): boolean {
  if (!Number.isFinite(currentSeconds) || !Number.isFinite(targetSeconds)) return false;
  return Math.abs(currentSeconds - targetSeconds) > seekThreshold(options.playing, options.fps);
}
