import type { TimelineState } from './state.js';

/**
 * Undo/redo history over TimelineState. Each command carries its inverse so
 * no state is ever deep-copied eagerly except on commit. Journal entries can
 * be derived from command name + forward/inverse patches.
 */
export interface Command<TExtra = unknown> {
  readonly name: string;
  readonly apply: (s: TimelineState) => TimelineState;
  readonly revert: (s: TimelineState) => TimelineState;
  readonly meta?: TExtra;
}

const snapshot = (s: TimelineState): TimelineState => ({
  tracks: s.tracks.map((t) => ({ ...t })),
  items: s.items.map((i) => ({ ...i, transform: { ...i.transform, crop: { ...i.transform.crop } } })),
  markers: s.markers.map((m) => ({ ...m })),
});

/** Build a command from before/after snapshots (simple, robust, used everywhere). */
export const commandFromSnapshots = (name: string, before: TimelineState, after: TimelineState): Command => ({
  name,
  apply: () => snapshot(after),
  revert: () => snapshot(before),
});

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  get undoDepth(): number { return this.undoStack.length; }
  get redoDepth(): number { return this.redoStack.length; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** Apply a command, recording it. Clears the redo stack. */
  execute(state: TimelineState, cmd: Command): TimelineState {
    const next = cmd.apply(state);
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return next;
  }

  /** Record a change that already happened (before → after) as one undo step. */
  record(state: TimelineState, name: string, before: TimelineState): TimelineState {
    this.undoStack.push(commandFromSnapshots(name, before, state));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return state;
  }

  undo(state: TimelineState): { state: TimelineState; name: string | null } {
    const cmd = this.undoStack.pop();
    if (!cmd) return { state, name: null };
    this.redoStack.push(cmd);
    return { state: cmd.revert(state), name: cmd.name };
  }

  redo(state: TimelineState): { state: TimelineState; name: string | null } {
    const cmd = this.redoStack.pop();
    if (!cmd) return { state, name: null };
    this.undoStack.push(cmd);
    return { state: cmd.apply(state), name: cmd.name };
  }

  clear(): void { this.undoStack = []; this.redoStack = []; }
}
