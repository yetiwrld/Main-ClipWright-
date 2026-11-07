import { useSyncExternalStore } from 'react';

/**
 * The playhead is deliberately not React state (SPEC 09 §2.4): only the
 * playhead line, the timecode readouts and the preview subscribe to it, so
 * clips, tracks and the ruler never re-render on a playback tick.
 */
class PlayheadStore {
  private us = 0;
  private listeners = new Set<() => void>();

  get(): number {
    return this.us;
  }

  set(us: number): void {
    const next = Math.max(0, Math.round(us));
    if (next === this.us) return;
    this.us = next;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const playheadStore = new PlayheadStore();

export function usePlayheadUs(): number {
  return useSyncExternalStore(playheadStore.subscribe, () => playheadStore.get(), () => 0);
}
