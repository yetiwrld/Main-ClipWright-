/**
 * @vitest-environment jsdom
 *
 * Per-track meters (SPEC 12 §6.3).
 *
 * jsdom has no Web Audio, so the context here is a recording fake whose analysers return chosen
 * sample windows. That is enough to pin the four things that would otherwise be invisible:
 *
 * - a meter reading the *wrong* track, which looks perfectly plausible on screen;
 * - a peak hold that never holds, because the previous reading came from a stale closure;
 * - one timer per track, which is a performance bug that only shows at scale;
 * - a meter that re-renders 30 times a second for bars that have not moved.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrackMeters } from '../use-track-meters';
import type { MeterState } from '../audio-meter';

/** What the left analyser reads. */
let sample = 0;
/** What the right analyser reads, so the two bars can be told apart. */
let sampleRight = 0;
/** How many analyser pairs were built, so a duplicate build is visible. */
let analyserPairs = 0;
/** How many intervals are running, so "one timer, not one per track" is checkable. */
let intervals = 0;

/**
 * An analyser whose two channels can differ.
 *
 * The left/right distinction is the whole reason a meter draws two bars, but jsdom gives the hook
 * no way to tell them apart — a fake that fills both channels with one value lets "reads the left
 * channel twice" pass, which is a bug that looks entirely plausible on screen.
 *
 * The channel is decided by *which analyser node* is read, in the order the hook creates them: a
 * splitter's output 0 is the left. So the pair is handed out alternating, and the test asserts the
 * second bar follows the second analyser.
 */
class FakeAnalyser {
  fftSize = 1024;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(buffer: Float32Array<ArrayBuffer>) {
    buffer.fill(this.channel === 0 ? sample : sampleRight);
  }
  /** 0 for the left-hand analyser of a pair, 1 for the right. */
  constructor(readonly channel: 0 | 1) {}
}

class FakeContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 48_000;
  destination = {};
  /** Alternates, so the first analyser of a pair is the left channel and the second the right. */
  private nextChannel: 0 | 1 = 0;

  createAnalyser() {
    analyserPairs += 1;
    const channel = this.nextChannel;
    this.nextChannel = channel === 0 ? 1 : 0;
    return new FakeAnalyser(channel);
  }
  createChannelSplitter() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} } };
  }
  resume = () => Promise.resolve();
  suspend = () => Promise.resolve();
  close = () => Promise.resolve();
}

/** Renders the hook's answer for two tracks and hands it to the test. */
/**
 * A stable context for the life of a test.
 *
 * It has to be module-level rather than created inside the harness: a context made per render is
 * a new identity every frame, the effect re-runs, `setMeters` re-renders, and the test allocates
 * until the worker dies. That is a property of the harness, but it is worth pinning because the
 * same mistake in a caller — passing a fresh `AudioContext` — would be the same hang.
 */
let context: AudioContext;

function Harness({
  taps,
  onMeters,
}: {
  taps: ReadonlyMap<string, AudioNode>;
  onMeters: (meters: ReadonlyMap<string, MeterState>) => void;
}) {
  const meters = useTrackMeters(context, taps);
  /*
    Called during render deliberately: the test wants every value the hook produced, including
    the ones React batched away. The caller decides whether to keep them all, and the ones that
    do keep only the last few — an unbounded array fed at 30 Hz is how this file first ran the
    test worker out of memory.
  */
  onMeters(meters);
  return (
    <div>
      {[...meters].map(([trackId, meter]) => (
        <span key={trackId} data-testid={`meter-${trackId}`}>
          {meter.leftDb.toFixed(0)}/{meter.rightDb.toFixed(0)}
        </span>
      ))}
    </div>
  );
}

/**
 * A stable map, created once per test.
 *
 * A fresh `Map` per render has a new identity, so the effect re-runs on every render — and the
 * effect calls `setMeters`, so that is a render loop rather than a slow test. It is also the real
 * shape of the mistake a caller could make, which is why the hook below collapses an unchanged
 * published map before setting state.
 */
/** A node stand-in. `connect`/`disconnect` are required: the hook calls both, and a bare `{}` makes
 * the analyser build throw into the `catch` — which is how it stays silent, not how it works. */
const trackNode = (): AudioNode => ({ connect() {}, disconnect() {} }) as unknown as AudioNode;

let twoTracks: ReadonlyMap<string, AudioNode>;

const taps = () => twoTracks;
const oneTrack = () => new Map<string, AudioNode>([['t1', trackNode()]]);

beforeEach(() => {
  context = new FakeContext() as unknown as AudioContext;
  sampleRight = 0;
  twoTracks = new Map<string, AudioNode>([
    ['t1', trackNode()],
    ['t2', trackNode()],
  ]);
  sample = 0;
  analyserPairs = 0;
  intervals = 0;
  /*
    Real timers, counted rather than faked. `vi.useFakeTimers()` would intercept the very
    `setInterval` this file is counting *and* read the analysers only when the test says so, which
    makes "one timer for every track" a claim about the fake. The interval is 33 ms, so a real one
    ticks within the wait the assertions below use.

    Counting at the boundary rather than inside the hook keeps the hook uninstrumented: what is
    asserted is how many intervals it *asked for*, which is the thing that scales with tracks.
  */
  const realSetInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
  ) => {
    intervals += 1;
    return realSetInterval(handler, timeout);
  }) as typeof window.setInterval);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Let one 30 Hz interval elapse and React commit the result. */
const tick = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 45));
  });
};

describe('per-track meters', () => {
  it('builds one analyser pair per track, not one per meter read', async () => {
    render(<Harness taps={taps()} onMeters={() => {}} />);
    expect(analyserPairs).toBe(4);
    await tick();
    await tick();
    /* Still four: the pairs are reused, which is what keeps the graph's node count stable. */
    expect(analyserPairs).toBe(4);
  });

  it('runs one timer for every track', () => {
    /*
      The scale bug this prevents: twelve headers each running a 30 Hz `setInterval` and reading
      two analysers is 720 reads a second, growing with the number of tracks — the cost of the
      feature scaling with the thing the feature helps you watch.
    */
    render(<Harness taps={taps()} onMeters={() => {}} />);
    expect(intervals).toBe(1);
  });

  it('reports a reading per track once the analysers have data', async () => {
    render(<Harness taps={taps()} onMeters={() => {}} />);
    sample = 0.5;
    await tick();
    /* 0.5 amplitude is about −6 dBFS on both channels of both tracks. */
    const reading = screen.getByTestId('meter-t1').textContent ?? '';
    expect(reading.startsWith('-6')).toBe(true);
    expect(screen.getByTestId('meter-t2').textContent).toBe(reading);
  });

  it('holds a peak after the level falls, rather than following it straight down', async () => {
    /*
      The hold is kept in a ref precisely so this works: `updateMeter` needs the *previous*
      reading, and a `setInterval` closure that read React state would see the value from the
      render the effect ran in — so every frame would compare against silence and no peak would
      ever hold.
    */
    let latest: ReadonlyMap<string, MeterState> = new Map();
    render(<Harness taps={taps()} onMeters={(meters) => (latest = meters)} />);

    sample = 0.9;
    await tick();
    sample = 0;
    await tick();

    const last = latest;
    /* The instantaneous level has fallen to the floor; the held peak has not. */
    expect(last.get('t1')!.leftDb).toBeLessThan(-50);
    expect(last.get('t1')!.peakLeftDb).toBeGreaterThan(-5);
  });

  it('draws nothing for a track the graph did not publish', async () => {
    const one = oneTrack();
    render(<Harness taps={one} onMeters={() => {}} />);
    sample = 0.5;
    await tick();
    expect(screen.getByTestId('meter-t1')).toBeTruthy();
    expect(screen.queryByTestId('meter-t2')).toBeNull();
  });

  it('reports nothing at all when there is no audio context', () => {
    /*
      No graph means no nodes and no meters — not a row of dark bars. The header asks whether a
      meter exists, so an empty map is the answer that draws nothing.
    */
    let latest: ReadonlyMap<string, MeterState> = new Map([['stale', {} as never]]);
    function NoContext() {
      latest = useTrackMeters(null, taps());
      return null;
    }
    render(<NoContext />);
    expect(latest.size).toBe(0);
    expect(intervals).toBe(0);
  });
});

describe('the cost of metering, which is the reason for the shape', () => {
  it('tells the left and right channels apart', async () => {
    /*
      A meter whose two bars always match is not a stereo meter, and this is the failure that
      reads as correct: both bars full, both bars moving together, nothing obviously wrong. The
      fake analysers carry different values so the assertion can name the channel.
    */
    render(<Harness taps={taps()} onMeters={() => {}} />);
    sample = 0;
    sampleRight = 0.5;
    await tick();
    expect(screen.getByTestId('meter-t1').textContent).toMatch(/^-\d+\/-6$/);
  });

  it('builds the analyser pairs once, not once per read', async () => {
    /*
      `createAnalyser` is not free — each holds a buffer and is read from the audio thread's pool
      — and a build per frame would allocate 60 nodes per second per track. This counts builds
      across several frames.

      What it does **not** prove is the `has(trackId)` guard in the build loop: that loop runs once
      per effect run, not per tick, so removing the guard changes nothing a test can see. The
      guard is there because the loop is re-entered when the effect re-runs, and keeping a record
      of which tracks already have analysers is what stops that re-entry from adding a second pair
      to the same node — a case this fixture does not construct, since it never changes the tap
      map mid-flight.
    */
    render(<Harness taps={taps()} onMeters={() => {}} />);
    const afterMount = analyserPairs;
    await tick();
    await tick();
    await tick();
    expect(analyserPairs).toBe(afterMount);
  });

  it('does not re-render when nothing has moved', async () => {
    /*
      The 30 Hz timer runs whether or not there is sound, and a header re-render per frame is a
      cost paid by every track in the project for bars that are a pixel wide. This counts the
      renders the hook's consumer sees: a silent project must settle rather than update forever.
    */
    let renders = 0;
    function Counting() {
      const meters = useTrackMeters(context, twoTracks);
      renders += 1;
      return <i>{meters.size}</i>;
    }
    render(<Counting />);
    /*
      One tick first, so the first reading has arrived and React has committed it. What is being
      measured is the *steady state*: a hook that updated unconditionally would keep going after
      the reading settled, and counting from mount would mix that with the legitimate first
      update.
    */
    await tick();
    const settled = renders;
    await tick();
    await tick();
    await tick();
    /*
      Some updates are expected — React's own batching and the first reading arriving. The claim
      is that it settles: a hook that called `setMeters` unconditionally would show one render per
      tick, forever, so the bound is what distinguishes the two.
    */
    /*
      Zero is the correct answer and it is achievable: on a silent, unmoving project the readings
      are identical frame to frame, so the hook's comparison finds no change and sets no state.
      An unconditional `setMeters` gives one render per tick, which over three ticks is three —
      so the bound has to be 0 to separate them.
    */
    expect(renders - settled).toBe(0);
  });
});
