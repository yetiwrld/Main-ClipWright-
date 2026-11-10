/**
 * The store that carries the preview graph's per-track nodes to the track headers (SPEC 12 §6.3).
 *
 * Small enough that the whole of it is "does it notify, and when", which is exactly the pair of
 * mistakes that matter: notifying when nothing changed (a re-render per playhead frame) and not
 * notifying when something did (a meter frozen at whatever it read when the graph was built).
 */
import { describe, expect, it } from 'vitest';
import { trackTapsStore } from '../track-taps-store';

const node = (): AudioNode => ({ connect() {}, disconnect() {} }) as unknown as AudioNode;
const context = (): AudioContext => ({}) as AudioContext;

describe('the track taps store', () => {
  it('notifies subscribers when the graph publishes', () => {
    let notified = 0;
    const unsubscribe = trackTapsStore.subscribe(() => {
      notified += 1;
    });
    const taps = new Map([['t1', node()]]);
    trackTapsStore.set(taps, context());
    expect(notified).toBe(1);
    expect(trackTapsStore.get()).toBe(taps);
    unsubscribe();
  });

  it('stays quiet when the same map is published again', () => {
    /*
      The graph publishes from an effect that also runs when the *context* appears, so the same
      map arrives more than once per session. Notifying on it would re-render every header for a
      change that did not happen.
    */
    const taps = new Map([['t1', node()]]);
    const audioContext = context();
    trackTapsStore.set(taps, audioContext);

    let notified = 0;
    const unsubscribe = trackTapsStore.subscribe(() => {
      notified += 1;
    });
    trackTapsStore.set(taps, audioContext);
    expect(notified).toBe(0);
    unsubscribe();
  });

  it('notifies when the context changes even though the map is the same', () => {
    /*
      This is the case a naive identity check on the map alone would miss, and its symptom is
      precise: the headers would keep the old `AudioContext`, build analysers in a closed one, and
      every meter would read silence for the rest of the session with nothing logged.
    */
    const taps = new Map([['t1', node()]]);
    trackTapsStore.set(taps, context());

    let notified = 0;
    const unsubscribe = trackTapsStore.subscribe(() => {
      notified += 1;
    });
    trackTapsStore.set(taps, context());
    expect(notified).toBe(1);
    unsubscribe();
  });

  it('reports no context before a graph exists', () => {
    trackTapsStore.set(new Map(), null);
    expect(trackTapsStore.contextOf()).toBeNull();
    expect(trackTapsStore.get().size).toBe(0);
  });

  it('stops notifying after unsubscribe', () => {
    let notified = 0;
    const unsubscribe = trackTapsStore.subscribe(() => {
      notified += 1;
    });
    unsubscribe();
    trackTapsStore.set(new Map([['t2', node()]]), context());
    expect(notified).toBe(0);
  });
});
