/**
 * @vitest-environment jsdom
 *
 * The preview's audio graph (SPEC 12 §6.2/§6.3).
 *
 * jsdom has no Web Audio, so this file brings its own: a recording stand-in for `AudioContext`
 * whose nodes remember what was connected to what and which scheduled values were asked for.
 * That is enough to pin the four things a plausible implementation gets wrong, all of which are
 * inaudible in a unit test that only checks "did not throw":
 *
 * - a chain that is rebuilt instead of reused — `createMediaElementSource` throws the second
 *   time it is called on an element, so the preview would go silent after one seek;
 * - a gain that is *assigned* per frame instead of scheduled, which is a click per frame;
 * - muted items still being requested and played;
 * - muting the preview leaving the elements running.
 *
 * The hook is driven through a tiny component rather than by calling it directly, because the
 * behaviour that matters most (the effects) only exists once React commits.
 */
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewAudio, type PreviewAudioApi } from '../use-preview-audio';
import type { PreviewAudioTimeline } from '@clipwright/audio-core';

/* ------------------------------------------------------------------------- */
/* A recording AudioContext                                                   */
/* ------------------------------------------------------------------------- */

interface Recorded {
  kind: string;
  connects: unknown[];
  /** Every `setTargetAtTime` this node's param was given, in call order. */
  targets: number[];
}

const recorded: Recorded[] = [];
let mediaElementSources = 0;
/** The elements the graph bound, so a test can ask what happened to them. */
const bound: HTMLMediaElement[] = [];
/**
 * jsdom's media elements do not implement playback — `play()` reports "not implemented" to the
 * virtual console and never resolves. Stubbing the two methods is what lets a test tell "the
 * preview started this element" from "the preview stopped it", which is otherwise invisible: an
 * element is `paused` for its whole life in jsdom whether anyone asked it to play or not.
 */
const played: HTMLMediaElement[] = [];
const pausedElements: HTMLMediaElement[] = [];
const playingNow = new WeakSet<HTMLMediaElement>();
let pausedDescriptor: PropertyDescriptor | undefined;

const param = (node: Recorded, value = 1) => ({
  value,
  setTargetAtTime(target: number, _time: number, _constant: number) {
    node.targets.push(target);
  },
});

const fakeNode = (kind: string, context?: unknown) => {
  const node: Recorded = { kind, connects: [], targets: [] };
  recorded.push(node);
  return {
    __recorded: node,
    /*
      Real `AudioNode`s carry their context, and the hook reads `node.context.currentTime` to
      schedule against the graph's clock rather than the wall clock.
    */
    context,
    connect(target: unknown) {
      node.connects.push(target);
    },
    disconnect() {},
  };
};

class FakeContext {
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  sampleRate = 48_000;
  destination = { kind: 'destination' };

  createGain() {
    const base = fakeNode('gain', this);
    return { ...base, gain: param(base.__recorded) };
  }

  createStereoPanner() {
    const base = fakeNode('panner', this);
    return { ...base, pan: param(base.__recorded, 0) };
  }

  createMediaElementSource(element: HTMLMediaElement) {
    /*
      The real API throws on the second call for the same element. Reproducing that here is the
      whole reason this file has a fake at all: it is what turns "rebuilds the graph" from an
      invisible inefficiency into a failed test.
    */
    const key = Symbol.for('clipwright-source');
    const seen = element as unknown as Record<symbol, boolean>;
    if (seen[key]) throw new Error('already connected');
    seen[key] = true;
    mediaElementSources += 1;
    bound.push(element);
    return fakeNode('source', this);
  }

  resume = () => Promise.resolve();
  suspend = () => Promise.resolve();
  close = () => Promise.resolve();
}

const setContext = (value: unknown) => {
  (window as unknown as { AudioContext: unknown }).AudioContext = value;
};

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const track = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  ...overrides,
});

const item = (id: string, trackId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  trackId,
  type: 'audio',
  mediaId: `media-${id}`,
  startUs: 0,
  durationUs: 2_000_000,
  ...overrides,
});

const timeline = (items: Record<string, ReturnType<typeof item>>): PreviewAudioTimeline => ({
  tracks: [track('t1'), track('t2')],
  items,
});

/** Drives the hook and hands the latest API back to the test. */
function Harness({
  timeline: value,
  enabled,
  rate,
  onApi,
}: {
  timeline: PreviewAudioTimeline | null;
  enabled: boolean;
  rate?: number;
  onApi: (api: PreviewAudioApi) => void;
}) {
  const api = usePreviewAudio(value, { enabled, rate });
  // An effect rather than a render-time call: the graph lives in effects, so the value is only
  // final once they have run, and a test that read it during render would see the previous one.
  useEffect(() => {
    onApi(api);
  }, [api, onApi]);
  return null;
}

let api: PreviewAudioApi | null = null;
const capture = (value: PreviewAudioApi) => {
  api = value;
};

beforeEach(() => {
  recorded.length = 0;
  mediaElementSources = 0;
  bound.length = 0;
  played.length = 0;
  pausedElements.length = 0;
  api = null;
  setContext(FakeContext);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    played.push(this);
    playingNow.add(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    pausedElements.push(this);
    playingNow.delete(this);
  });
  /*
    jsdom's `paused` is a constant `true`, so an implementation that guards on it looks like it
    never pauses — and a test asserting "it paused" would pass only by calling `pause()`
    unconditionally, which is not the behaviour either. The getter follows the stubbed calls.
  */
  pausedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return !playingNow.has(this);
    },
  });
});

afterEach(() => {
  cleanup();
  setContext(undefined);
  vi.restoreAllMocks();
  if (pausedDescriptor) {
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', pausedDescriptor);
    pausedDescriptor = undefined;
  }
});

const seek = (timeUs: number, playing = false) =>
  act(() => {
    api!.seekTo(timeUs, playing);
  });

describe('the preview audio graph', () => {
  it('creates one chain per audible item, each into the bus', () => {
    render(
      <Harness
        timeline={timeline({ a: item('a', 't1'), b: item('b', 't2') })}
        enabled
        onApi={capture}
      />,
    );
    expect(mediaElementSources).toBe(2);
    expect(api!.ready).toBe(true);
    /* A source, a gain and a pan per item, plus the bus. */
    expect(recorded.filter((node) => node.kind === 'source')).toHaveLength(2);
    expect(recorded.filter((node) => node.kind === 'gain')).toHaveLength(3);
    expect(recorded.filter((node) => node.kind === 'panner')).toHaveLength(2);
  });

  it('does not rebuild a chain when the same item is planned again', () => {
    const first = timeline({ a: item('a', 't1') });
    const { rerender } = render(<Harness timeline={first} enabled onApi={capture} />);
    expect(mediaElementSources).toBe(1);

    /*
      A new object with the same content: this is what an edit elsewhere in the project looks
      like to the hook. A rebuild would call `createMediaElementSource` a second time on the same
      element, which is an exception in a browser — and would have been silently swallowed by the
      hook's `catch`, leaving the clip mute.
    */
    rerender(<Harness timeline={timeline({ a: item('a', 't1') })} enabled onApi={capture} />);
    expect(mediaElementSources).toBe(1);
    expect(recorded.filter((node) => node.kind === 'source')).toHaveLength(1);
  });

  it('applies an edit to an item that already has a chain', () => {
    const { rerender } = render(
      <Harness timeline={timeline({ a: item('a', 't1') })} enabled onApi={capture} />,
    );
    const panner = recorded.filter((node) => node.kind === 'panner')[0]!;
    expect(panner.targets.at(-1)).toBe(0);

    /*
      The pan moved from centre to hard right. This is the assertion that catches a graph which
      rebuilds instead of re-planning: a rebuild throws on `createMediaElementSource`, the hook
      swallows it and skips the chain, the old request stays on the node, and the preview keeps
      playing the clip centred while the export puts it on the right. Measuring "how many
      sources were created" cannot see that, because the throw happens before the count.
    */
    rerender(<Harness timeline={timeline({ a: item('a', 't1', { pan: 100 }) })} enabled onApi={capture} />);
    expect(panner.targets.at(-1)).toBe(1);
  });

  it('schedules gain every frame instead of assigning it', () => {
    render(
      <Harness
        timeline={timeline({ a: item('a', 't1', { fadeOutUs: 2_000_000 }) })}
        enabled
        onApi={capture}
      />,
    );
    seek(0);
    const before = recorded.filter((node) => node.kind === 'gain')[1]!.targets.length;
    seek(1_000_000);
    seek(1_500_000);
    const after = recorded.filter((node) => node.kind === 'gain')[1]!.targets.length;
    /* One scheduling call per frame, and the value moves as the fade does. */
    expect(after).toBeGreaterThan(before);
  });

  it('requests nothing for an item on a muted track', () => {
    render(
      <Harness
        timeline={{
          tracks: [track('t1', { muted: true })],
          items: { a: item('a', 't1') },
        }}
        enabled
        onApi={capture}
      />,
    );
    /*
      Not requested at all, rather than requested and zeroed: a node whose gain is zero still
      decodes a file, and the export mixer does not decode muted items either.
    */
    expect(mediaElementSources).toBe(0);
  });

  it('keeps the graph across a mute, because the binding cannot be undone', () => {
    const value = timeline({ a: item('a', 't1') });
    const { rerender } = render(<Harness timeline={value} enabled onApi={capture} />);
    expect(mediaElementSources).toBe(1);
    const element = bound[0]!;
    /* Playing first, so "the mute stopped it" is a claim about a change. */
    seek(500_000, true);
    expect(played).toContain(element);

    rerender(<Harness timeline={value} enabled={false} onApi={capture} />);
    /*
      Muting must not tear the chain down and must not rebuild it on unmute: `createMediaElementSource`
      is a once-per-element binding, so a rebuild would throw, the hook would swallow it, and the
      clip would be silent for the rest of the session. The element is also left *not playing* —
      a mute that only zeroes a gain leaves the file decoding and the element drifting away from
      the playhead, so unmuting would resume from the wrong place.
    */
    expect(pausedElements).toContain(element);

    rerender(<Harness timeline={value} enabled onApi={capture} />);
    expect(mediaElementSources).toBe(1);
    expect(api!.ready).toBe(true);
  });

  it('starts the element on play and stops it on pause', () => {
    render(<Harness timeline={timeline({ a: item('a', 't1') })} enabled onApi={capture} />);
    const element = bound[0]!;

    seek(500_000, true);
    expect(played).toContain(element);

    seek(600_000, false);
    expect(pausedElements).toContain(element);
  });

  it('leaves an element stopped when the playhead is outside its clip', () => {
    render(
      <Harness
        timeline={timeline({ a: item('a', 't1', { startUs: 1_000_000, durationUs: 1_000_000 }) })}
        enabled
        onApi={capture}
      />,
    );
    /* Before the clip starts: nothing to play, however much the transport is running. */
    seek(0, true);
    expect(played).toHaveLength(0);

    seek(1_500_000, true);
    expect(played).toHaveLength(1);
  });

  it('builds no graph for a preview with no timeline', () => {
    render(<Harness timeline={null} enabled onApi={capture} />);
    expect(api!.ready).toBe(false);
    expect(api!.tap).toBeNull();
    expect(mediaElementSources).toBe(0);
  });

  it('does nothing rather than throwing when the environment has no AudioContext', () => {
    setContext(undefined);
    render(
      <Harness timeline={timeline({ a: item('a', 't1') })} enabled onApi={capture} />,
    );
    expect(api!.ready).toBe(false);
    /* Seeking with no context is a no-op, not a crash — the preview draws without sound. */
    expect(() => seek(500_000)).not.toThrow();
  });

  it('exposes the bus so the meter can tap the mix rather than one layer', () => {
    render(
      <Harness
        timeline={timeline({ a: item('a', 't1'), b: item('b', 't2') })}
        enabled
        onApi={capture}
      />,
    );
    expect(api!.tap).not.toBeNull();
    /*
      The tap is the bus: the one gain node with no panner in front of it, which everything else
      connects into. If this were a per-item gain the meter would measure one item; if it were the
      video element it would measure the bottom picture layer, which is the bug being fixed.
    */
    const bus = api!.tap!.node as unknown as { __recorded?: Recorded };
    const destination = (api!.tap!.context as unknown as { destination: unknown }).destination;
    /*
      Identified by what it connects to rather than by being *a* gain node: every item has one of
      those too, so `kind === 'gain'` would pass against a per-item tap. The bus is the node that
      reaches the destination.
    */
    expect(bus.__recorded?.connects).toContain(destination);
    expect(recorded.filter((node) => node.connects.includes(destination))).toHaveLength(1);
  });
});

describe('playback rate (SPEC 09 §23)', () => {
  /*
    The rate is applied to the elements, not to the clock. That division is the thing worth
    testing: an implementation that scaled the *playhead* by the rate as well would double-count
    it, playing at 2× while the playhead ran at 4× — the picture racing ahead of the sound.
  */
  it('sets every element\'s playbackRate to the transport rate', () => {
    render(
      <Harness
        timeline={timeline({ a: item('a', 't1'), b: item('b', 't2') })}
        enabled
        rate={2}
        onApi={capture}
      />,
    );
    seek(500_000, true);
    expect(bound).toHaveLength(2);
    for (const element of bound) expect(element.playbackRate).toBe(2);
  });

  it('preserves pitch, so a slowed read is slow rather than an octave down', () => {
    render(
      <Harness timeline={timeline({ a: item('a', 't1') })} enabled rate={0.5} onApi={capture} />,
    );
    seek(500_000, true);
    /*
      Assembled from a plain object rather than written inline: `preservesPitch` does not exist on
      the DOM type jsdom provides, so reading it through the element is the only honest way to
      assert the assignment happened at all.
    */
    const element = bound[0] as unknown as { preservesPitch?: boolean };
    expect(element.preservesPitch).toBe(true);
  });

  it('falls back to real time for a rate the transport does not offer', () => {
    /* A stored or hand-edited value must not play at 0× (stuck) or a scramble. */
    render(
      <Harness timeline={timeline({ a: item('a', 't1') })} enabled rate={7} onApi={capture} />,
    );
    seek(500_000, true);
    expect(bound[0]!.playbackRate).toBe(2);
  });

  it('follows a rate change mid-playback', () => {
    const value = timeline({ a: item('a', 't1') });
    const { rerender } = render(<Harness timeline={value} enabled rate={1} onApi={capture} />);
    seek(500_000, true);
    expect(bound[0]!.playbackRate).toBe(1);

    rerender(<Harness timeline={value} enabled rate={1.5} onApi={capture} />);
    seek(600_000, true);
    /*
      One frame later, not on the next pause: a rate that only took effect after a stop would
      look like the buttons did nothing while the transport was running — which is exactly when
      someone presses them.
    */
    expect(bound[0]!.playbackRate).toBe(1.5);
  });

  it('exposes a clock that advances with the audio context', () => {
    render(<Harness timeline={timeline({ a: item('a', 't1') })} enabled onApi={capture} />);
    expect(api!.clock()).not.toBeNull();
    const before = api!.clock()!;
    (api!.tap!.context as unknown as { currentTime: number }).currentTime += 2.5;
    expect(api!.clock()! - before).toBeCloseTo(2.5, 5);
  });

  it('has no clock when no graph could be built', () => {
    /*
      The clock returning null is what makes the transport fall back to `performance.now()`.
      A clock that returned 0 would look like a working audio clock stopped at zero, and the
      playhead would never advance.
    */
    setContext(undefined);
    render(<Harness timeline={timeline({ a: item('a', 't1') })} enabled onApi={capture} />);
    expect(api!.clock()).toBeNull();
  });
});
