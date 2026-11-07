// Undo/redo as immer patch stacks (SPEC 09 §24): one transaction = one step,
// at least 200 steps, no full-state snapshots.

import { applyPatches, type Patch } from 'immer';
import type { CommandOk, TimelineState } from './commands';

export interface HistoryStep {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  affectedItemIds: string[];
}

export interface UndoResult {
  state: TimelineState;
  step: HistoryStep;
}

export class TimelineHistory {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private current: TimelineState;

  constructor(
    initial: TimelineState,
    private readonly limit = 200,
  ) {
    this.current = initial;
  }

  get state(): TimelineState {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /** Replace the state without a history step (load, recovery, external change). */
  reset(state: TimelineState, { keepHistory = false } = {}): void {
    this.current = state;
    if (!keepHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
  }

  commit(label: string, result: CommandOk): void {
    this.current = result.state;
    this.undoStack.push({
      label,
      patches: result.patches,
      inverse: result.inverse,
      affectedItemIds: result.affectedItemIds,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): UndoResult | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.current = applyPatches(this.current, step.inverse) as TimelineState;
    this.redoStack.push(step);
    return { state: this.current, step };
  }

  redo(): UndoResult | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.current = applyPatches(this.current, step.patches) as TimelineState;
    this.undoStack.push(step);
    return { state: this.current, step };
  }
}
