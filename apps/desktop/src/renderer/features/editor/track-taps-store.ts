/**
 * The preview graph's per-track nodes, published for the track headers (SPEC 12 §6.3).
 *
 * The graph is owned by `PreviewPane` and the headers are owned by `TimelinePanel`; the two are
 * siblings. The options were to thread the node map through the editor's props — a chain that
 * would carry an `AudioNode` through half a dozen components that have no use for it — or to
 * publish it, which is what `playheadStore` already does for the same kind of reason. A store
 * keeps the nodes out of the component tree entirely, and a header that is not rendered costs
 * nothing because nothing subscribes.
 *
 * The store holds **what the graph published**, never a copy: the graph replaces the map when the
 * set of audible tracks changes, and it is the graph's job to decide that.
 */
import { useSyncExternalStore } from 'react';

class TrackTapsStore {
  private taps: ReadonlyMap<string, AudioNode> = new Map();
  /**
   * The `AudioContext` the nodes belong to.
   *
   * Separate from the map because `trackTaps.size === 0` happens for two very different reasons —
   * a project with nothing audible, and no graph at all — and a consumer that wants to build
   * analysers needs the context in the first case and cannot in the second. One nullable field
   * says both.
   */
  private context: AudioContext | null = null;
  private listeners = new Set<() => void>();

  get(): ReadonlyMap<string, AudioNode> {
    return this.taps;
  }

  contextOf(): AudioContext | null {
    return this.context;
  }

  /**
   * Replace what the headers read.
   *
   * Identity comparison rather than a deep one: the graph builds a fresh map only when the plan
   * changed, so a new object *is* the signal, and comparing 500 nodes to find out that nothing
   * moved would run on every playhead frame.
   */
  set(taps: ReadonlyMap<string, AudioNode>, context: AudioContext | null): void {
    if (this.taps === taps && this.context === context) return;
    this.taps = taps;
    this.context = context;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const trackTapsStore = new TrackTapsStore();

/** The map, for a component that draws one meter per track. */
export function useTrackTaps(): ReadonlyMap<string, AudioNode> {
  return useSyncExternalStore(trackTapsStore.subscribe, () => trackTapsStore.get(), () => trackTapsStore.get());
}

/** The context as well, so a meter hook can build its analysers. */
export function useTrackTapsWithContext(): {
  context: AudioContext | null;
  taps: ReadonlyMap<string, AudioNode>;
} {
  const taps = useTrackTaps();
  /*
    Read during render rather than subscribed separately. The context only ever changes together
    with the map — both are written in one `set` — so the map's identity already covers it, and a
    second `useSyncExternalStore` for a value that cannot change on its own would be noise.
  */
  return { context: trackTapsStore.contextOf(), taps };
}
