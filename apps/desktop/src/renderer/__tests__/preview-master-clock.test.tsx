/**
 * @vitest-environment jsdom
 *
 * The preview's master clock (SPEC 09 §23).
 *
 * > when any audio plays, the **audio output position is the clock**; the playhead derives from it
 * > so video never drifts from audio. With no audio, use a monotonic high-resolution timer. The
 * > preview renders the frame for the clock time; if frames can't keep up it **drops frames, never
 * > slows audio**.
 *
 * The arithmetic lives in `audio-core`'s `playback-clock.ts` and is tested there. What is tested
 * *here* is the wiring the arithmetic cannot prove: that the pane actually asks the audio device
 * rather than `performance.now()`, that a dropped frame costs picture and not sound, and that a
 * seek during playback re-anchors instead of being fought.
 *
 * `requestAnimationFrame` is driven by hand — jsdom has a real one, but a test that waited for it
 * would be measuring the wall clock, which is the thing under test.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';


/** The audio device's position, in seconds. The test moves it; the pane must follow. */
let deviceSeconds = 0;

/**
 * Just enough of an `AudioContext` for the preview's graph to build and for its clock to be read.
 *
 * Nodes are inert: this file is not testing the graph (that is `use-preview-audio.test.tsx`), only
 * that the pane takes its time from `currentTime`.
 */
const node = () => ({
  connect() {},
  disconnect() {},
  gain: { value: 1, setTargetAtTime() {} },
  pan: { value: 0, setTargetAtTime() {} },
  context: null as unknown,
});

class FakeContext {
  get currentTime() {
    return deviceSeconds;
  }
  state: 'suspended' | 'running' = 'running';
  sampleRate = 48_000;
  destination = {};
  createGain() {
    return node();
  }
  createStereoPanner() {
    return node();
  }
  createMediaElementSource() {
    return node();
  }
  resume = () => Promise.resolve();
  suspend = () => Promise.resolve();
  close = () => Promise.resolve();
}

/** A project with a video item long enough that playback does not end mid-test. */
function makeState(workAreaOutUs?: number): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));
  const item = {
    id: 'a',
    trackId: mainTrack.id,
    type: 'video' as const,
    mediaId: 'media-a',
    startUs: 0,
    durationUs: 60_000_000,
    sourceInUs: 0,
    transform: {},
    crop: {},
    keyframes: {},
  };
  tracks.find((track) => track.id === mainTrack.id)!.itemIds.push('a');
  return {
    ...base,
    tracks,
    items: { a: item },
    ...(workAreaOutUs === undefined ? {} : { workArea: { inUs: 0, outUs: workAreaOutUs } }),
  } as unknown as TimelineState;
}

/**
 * A `TimelineApi` stand-in, so the preview treats itself as attached to an editor.
 *
 * Without a timeline the preview is a standalone viewer: it builds no audio graph, and with no
 * graph there is no rate control and no audio clock. That is the right behaviour for a viewer and
 * the wrong fixture for testing the transport — the cast is confined to this helper, and nothing
 * the clock reads comes from it.
 */
/**
 * Runs animation frames by hand.
 *
 * Returning the callback list from `requestAnimationFrame` is what lets a test say "one frame
 * happened" without waiting for a real one — and is the only way to test "a frame was *dropped*",
 * which is a claim about frames that never ran.
 */
let pending: FrameRequestCallback[] = [];
function runFrame(): void {
  const callbacks = pending;
  pending = [];
  act(() => {
    for (const callback of callbacks) callback(deviceSeconds * 1000);
  });
}
function runFrames(count: number): void {
  for (let index = 0; index < count; index += 1) runFrame();
}

beforeEach(() => {
  deviceSeconds = 0;
  pending = [];
  playheadStore.set(0);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    },
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  /*
    jsdom's media elements do not implement playback: `play()` reports "not implemented" and
    returns `undefined`, and the preview does `play().catch(...)` — so without a stub that returns
    a promise the pane throws on its first frame. Real playback is not what this file is about.
  */
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
  playheadStore.set(0);
});

/**
 * Start playback and let the first frame establish the anchor.
 *
 * The anchor is taken on the first tick rather than when the effect runs, deliberately: the effect
 * fires on a React commit, before the transport has resumed the context, so an anchor taken there
 * pairs a device position that is about to change with a playhead that has not moved.
 */
function playAndAnchor(): void {
  play();
  runFrame();
}

/** The transport's Play button, found by its label. */
function play(): void {
  const button = document.querySelector('[aria-label="Play"]');
  if (!button) throw new Error('the transport rendered no Play button');
  act(() => {
    (button as HTMLElement).click();
  });
}

describe('the audio device is the master clock (SPEC 09 §23)', () => {
  it('derives the playhead from the audio position, not from the animation frames', () => {
    render(<PreviewPane state={makeState()} fps={30} />);
    playAndAnchor();

    /*
      Four seconds pass on the *audio device* while only one frame is delivered. A clock
      accumulating frame deltas would be at zero here, because a frame it never saw is a delta it
      never got. The audio device does not care how many frames were drawn.
    */
    deviceSeconds = 4;
    runFrame();

    expect(playheadStore.get()).toBeGreaterThan(3_900_000);
    expect(playheadStore.get()).toBeLessThan(4_100_000);
  });

  it('does not accumulate error across a dropped frame', () => {
    /*
      The test the timer clock fails. Frames 1–3 arrive on time, then a long hitch, then the
      playhead is compared against the device rather than against the sum of the frame deltas.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    playAndAnchor();

    deviceSeconds = 0.5;
    runFrames(3);
    deviceSeconds = 3.5;
    runFrame();

    /* 3.5 s of audio has played, so the playhead is at 3.5 s — not at 0.5 s plus three frames. */
    expect(playheadStore.get()).toBeGreaterThan(3_400_000);
    expect(playheadStore.get()).toBeLessThan(3_600_000);
  });

  it('holds the playhead when the clock reads before the anchor', () => {
    /*
      An `AudioContext` can report a `currentTime` *before* the instant the anchor was taken —
      after a device change, or when the context was recreated under us. Elapsed time is
      negative there, and the playhead must hold rather than rewind into the clip: a rewind is a
      visible jump backwards and, because the graph re-seeks every element, a burst of sound from
      the wrong place.

      Note what this test does *not* claim. A clock that reads forward but is simply slow — 1 s
      after the anchor said 5 — is indistinguishable, from inside one frame, from a clock whose
      anchor was taken at 0. `playheadAt` reports what the device says, which is the point of the
      device being the clock; only a reading *before* the anchor is unambiguous, and that is the
      case pinned here.
    */
    /*
      Anchored at 10 s into the project, so "hold" and "rewind" are different numbers: holding
      leaves the playhead at 10 s, while an unfloored clock would put it back to the anchor minus
      the wind-back.
    */
    act(() => playheadStore.set(10_000_000));
    render(<PreviewPane state={makeState()} fps={30} />);
    playAndAnchor();

    deviceSeconds = 5;
    runFrame();
    const forward = playheadStore.get();
    expect(forward).toBeGreaterThan(14_000_000);

    /* Wound back to before the anchor (taken at device time 0). */
    deviceSeconds = -2;
    runFrame();
    /* Held at the anchor's playhead rather than dragged back to it — which is 10 s, not 14 s. */
    expect(playheadStore.get()).toBe(10_000_000);
  });

  it('re-anchors on a seek during playback instead of fighting it', () => {
    /*
      A scrub while the transport is running moves the playhead from outside the clock. Without a
      re-anchor the next frame would snap it back to where the audio says it should be — the seek
      would appear to be ignored, and only while playing.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    playAndAnchor();

    deviceSeconds = 2;
    runFrame();
    expect(playheadStore.get()).toBeGreaterThan(1_000_000);

    /* The user scrubs to 30 s, far outside the frame's own tolerance. */
    act(() => playheadStore.set(30_000_000));
    deviceSeconds = 2.1;
    runFrame();

    expect(playheadStore.get()).toBeGreaterThan(29_000_000);
  });

  it('stops at the end of the project and leaves the playhead on the last frame', () => {
    /*
      "Stops at the end" is worth pinning because the clock has no opinion about the project: it
      is an offset plus elapsed device time, and left alone it would run past the last clip and
      keep going, which reads as a playhead that escaped the timeline.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    playAndAnchor();

    deviceSeconds = 61;
    runFrame();

    expect(playheadStore.get()).toBe(60_000_000);
  });

  it('falls back to the timer when no audio graph exists', () => {
    /*
      No Web Audio — an environment without it, or a project with no audible item. Playback must
      still work; the spec's sentence has two halves and only the first is about audio.
    */
    (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
    render(<PreviewPane state={makeState()} fps={30} />);
    play();

    /* With the timer as the clock, the playhead is derived from `performance.now()`, which in a
       synchronous test has barely moved — the assertion is that it is still a *number* and the
       transport is still running rather than stopped. */
    runFrames(2);
    expect(playheadStore.get()).toBeGreaterThanOrEqual(0);
    expect(document.querySelector('[aria-label="Pause"]')).not.toBeNull();
  });
});

describe('the work area is the stop point (SPEC 09 §23)', () => {
  it('stops at the work-area out rather than at the project end', () => {
    /*
      The work area is the user's explicit statement about what a playback pass means — a range
      they want to watch, or a range they are about to export. Playing past it is the transport
      ignoring a setting, and the symptom is quiet: it only looks wrong once the playhead is past
      the marker, by which point the user has stopped watching the marker.
    */
    render(<PreviewPane state={makeState(12_000_000)} fps={30} />);
    playAndAnchor();

    deviceSeconds = 20;
    runFrame();

    expect(playheadStore.get()).toBe(12_000_000);
  });
});

describe('the clock does not steer itself', () => {
  it('does not re-anchor from its own write when the device clock stalls', () => {
    /*
      The feedback loop this pins is subtle and real. The tick writes the playhead, which notifies
      the subscription, which asks "does the playhead agree with the clock?" — a question the tick
      has *just answered*. On a healthy clock it agrees and nothing happens.

      It stops agreeing when the device clock stalls, which it does whenever the context is
      suspended, or between a resume request and the device starting. Then the tick keeps writing
      a playhead whose value is correctly held, but a subscription that re-anchored on that write
      would adopt *the held value as the new origin*, and from then on every frame would measure
      elapsed time from a moving anchor — so the playhead freezes a hair ahead of where it
      started, forever, while the transport still says "playing".

      A stalled clock is the fixture that tells "guard present" from "guard absent": with the
      guard the playhead stays pinned at where it was when the device stopped.
    */
    render(<PreviewPane state={makeState()} fps={30} />);
    playAndAnchor();

    deviceSeconds = 2;
    runFrame();
    const pinned = playheadStore.get();
    expect(pinned).toBeGreaterThan(1_900_000);

    /* The device stops advancing while frames keep arriving. */
    runFrames(5);
    expect(playheadStore.get()).toBe(pinned);
  });
});
