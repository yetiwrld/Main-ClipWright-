/**
 * The transport's master meter (SPEC 12 §6.3, `10 §3.2`).
 *
 * It reads whatever `usePreviewAudio` built. When the preview graph exists the source is its
 * **mix bus** — the node every item is summed into — so the reading is the level a listener
 * hears rather than one layer of it. When no graph could be built (no Web Audio, or a standalone
 * preview with no timeline) it falls back to tapping the `<video>` element, which only carries
 * the bottom picture layer; that fallback is the old behaviour kept deliberate, and the reading
 * is labelled "quiet" rather than presented as a mix.
 *
 * The arithmetic — the −60…0 dB scale, the 1.5 s hold, the latching clip light, the K-weighted
 * momentary loudness — lives in `audio-meter.ts` and `audio-core`'s `loudness.ts` as pure
 * functions. This file is only the wiring: analysers, a 30 Hz timer, and the same `MeterState`
 * every other meter in the app uses.
 *
 * Two constraints shape it:
 *
 * - An `AnalyserNode` can only connect to a node in **its own** `AudioContext`, so the analysers
 *   are built against the tap's context rather than one of the meter's own.
 * - jsdom has no `AudioContext` at all. Everything here is behind a feature check, and a missing
 *   graph means the meter reads silence instead of the component throwing — the same "never
 *   silently broken" rule the rest of the preview follows.
 */

import { useEffect, useRef, useState } from 'react';
import {
  EMPTY_LOUDNESS_WINDOW,
  SILENT_READING,
  channelMeanSquare,
  loudnessOf,
  pushLoudness,
  type KWeightState,
  type LoudnessReading,
  type LoudnessWindow,
} from '@clipwright/audio-core';
import {
  SILENT_METER,
  channelPeakDb,
  updateMeter,
  type MeterState,
} from './audio-meter.js';

/** How often the analysers are read (SPEC 12 §6.3: meters update at 30 Hz). */
const METER_INTERVAL_MS = 1000 / 30;

/** How many samples each analyser window holds. A power of two is required by the API. */
const ANALYSER_FFT = 2048;

export interface AudioMeterApi {
  /** What the transport's meter draws. Silence while no graph exists. */
  meter: MeterState;
  /**
   * Momentary loudness over the last 400 ms (SPEC 12 §6.3), for the Audio meters popover.
   *
   * Separate from `meter` because it answers a different question and changes on a different
   * timescale: the peak meter jumps with every sample, this settles over a gate. Deriving one
   * from the other would be wrong in both directions — a peak does not tell you loudness, and
   * a loudness does not tell you whether anything clipped.
   */
  loudness: LoudnessReading;
  /** Clear the latched clip light. Called by a click on it. */
  clearClip: () => void;
  /**
   * Start the graph, if it is not running.
   *
   * Called from a user gesture — `AudioContext` starts suspended in every modern browser
   * and `resume()` needs a gesture, so a graph created on mount would be created
   * correctly and then make no sound. Play is the gesture the transport already has.
   */
  resume: () => void;
}

/**
 * Read both channels and fold them into the meter, once every 30th of a second.
 *
 * A plain `setInterval` rather than `requestAnimationFrame`: the meter must keep reading
 * while the tab is visible even when the preview is paused, and rAF stops in a hidden
 * tab, which would leave a latched clip light frozen at its last value.
 */
export function useAudioMeter(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  /**
   * The preview's mix bus, when a preview graph exists.
   *
   * Passing it makes the meter measure the *mix* — every audible item, panned and
   * enveloped, summed exactly as the export sums them. Without it the meter falls back to
   * tapping the `<video>` element, which is the bottom picture layer only; that fallback
   * exists for the environments where no preview graph could be built (no Web Audio), not
   * as a second opinion about the level.
   */
  tap: { context: AudioContext; node: AudioNode } | null = null,
): AudioMeterApi {
  const [meter, setMeter] = useState<MeterState>(SILENT_METER);
  const [loudness, setLoudness] = useState<LoudnessReading>(SILENT_READING);
  const contextRef = useRef<AudioContext | null>(null);
  const leftRef = useRef<AnalyserNode | null>(null);
  const rightRef = useRef<AnalyserNode | null>(null);
  /*
    The K-weighting filters carry state between frames *and* between channels, and both are
    ordinary refs rather than React state: they are read and written once per frame, and a state
    update per sample would re-render the transport sixty times a second to no visible effect.
  */
  const loudnessWindowRef = useRef<LoudnessWindow>(EMPTY_LOUDNESS_WINDOW);
  const channelStateRef = useRef<KWeightState[]>([
    { shelf: { x1: 0, x2: 0, y1: 0, y2: 0 }, rlb: { x1: 0, x2: 0, y1: 0, y2: 0 } },
    { shelf: { x1: 0, x2: 0, y1: 0, y2: 0 }, rlb: { x1: 0, x2: 0, y1: 0, y2: 0 } },
  ]);
  /*
    `Float32Array<ArrayBuffer>` explicitly: `getFloatTimeDomainData` will not accept the
    `ArrayBufferLike` that a bare `new Float32Array(n)` is inferred as, because the DOM
    type excludes a `SharedArrayBuffer` backing store.
  */
  const bufferRef = useRef<Float32Array<ArrayBuffer>>(new Float32Array(ANALYSER_FFT));

  /*
    The clear is defined here rather than in the component so the latched state has one
    owner. A `clearClip` that set component state would be a second source of truth for
    a field `updateMeter` also writes, and the two would disagree between frames.
  */
  const clearClip = () => {
    setMeter((current) => ({ ...current, clipped: false }));
  };

  const resume = () => {
    const context = tap ? tap.context : contextRef.current;
    if (context && context.state === 'suspended') void context.resume();
  };

  useEffect(() => {
    if (!active) return;

    /*
      Two ways to feed the analysers, and which one applies is not a preference:

      - **A tap on the preview's mix bus** when the preview graph exists. This is the only
        node whose samples are the mix the export would produce.
      - **The `<video>` element** otherwise — no Web Audio, or a build that predates the
        graph. It measures the bottom picture layer, so it is a fallback, not the truth.

      The `<video>` is not required when a tap is present, which is why the ref is only
      consulted on the fallback path: a preview with all its sound in audio items still has
      a video element, but requiring one would tie the meter to a picture being on screen.
    */
    let context: AudioContext;
    if (tap) {
      context = tap.context;
      try {
        const splitter = context.createChannelSplitter(2);
        const left = context.createAnalyser();
        const right = context.createAnalyser();
        left.fftSize = ANALYSER_FFT;
        right.fftSize = ANALYSER_FFT;
        /*
          `connect` on an existing node is additive, so tapping the bus leaves the sound
          path alone — the bus already reaches `destination`, and the meter is a branch off
          it, not a stage in it. That also means nothing needs disconnecting on teardown
          beyond the analysers themselves, which are dropped with the effect.
        */
        tap.node.connect(splitter);
        splitter.connect(left, 0);
        splitter.connect(right, 1);
        leftRef.current = left;
        rightRef.current = right;
      } catch {
        leftRef.current = null;
        rightRef.current = null;
        return;
      }
    } else {
      const video = videoRef.current;
      if (!video) return;

      // No Web Audio in this environment (jsdom, or a browser that refuses one): the meter
      // stays at silence and nothing throws. The transport still draws its scale, so the
      // absence reads as "quiet" rather than as "no meter".
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;

      const existing = contextRef.current;
      if (existing) {
        context = existing;
      } else {
        try {
          context = new Context();
          contextRef.current = context;
          /*
            One source per element, forever. `MediaElementAudioSourceNode` disconnects the
            element from the default output when it is created, so the source *must* be
            connected through to the destination or the preview goes silent the moment the
            meter starts — a spectacular way to introduce a bug while adding an instrument.
          */
          const source = context.createMediaElementSource(video);
          const splitter = context.createChannelSplitter(2);
          const left = context.createAnalyser();
          const right = context.createAnalyser();
          left.fftSize = ANALYSER_FFT;
          right.fftSize = ANALYSER_FFT;
          source.connect(splitter);
          splitter.connect(left, 0);
          splitter.connect(right, 1);
          // And the sound itself, unaltered: the meter is a tap, not an effect.
          source.connect(context.destination);
          leftRef.current = left;
          rightRef.current = right;
        } catch {
          // A second `createMediaElementSource` on the same element, or a context the
          // environment will not give us. Leave the meter silent rather than throwing into
          // React's render path.
          contextRef.current = null;
          return;
        }
      }
    }

    const timer = window.setInterval(() => {
      const left = leftRef.current;
      const right = rightRef.current;
      if (!left || !right) return;
      const buffer = bufferRef.current;
      left.getFloatTimeDomainData(buffer);
      const leftDb = channelPeakDb(buffer, 0, 1);
      /*
        Loudness needs the samples *after* this line reads them into the buffer, so it is
        computed here rather than in a second pass — one copy of the analyser's window per
        channel per frame, which is what the mono buffers above already are.
      */
      const leftEnergy = channelMeanSquare(buffer, 0, 1, channelStateRef.current[0]!);
      channelStateRef.current[0] = leftEnergy.state;
      right.getFloatTimeDomainData(buffer);
      const rightDb = channelPeakDb(buffer, 0, 1);
      const rightEnergy = channelMeanSquare(buffer, 0, 1, channelStateRef.current[1]!);
      channelStateRef.current[1] = rightEnergy.state;

      const now = performance.now();
      setMeter((current) => updateMeter(current, { leftDb, rightDb }, now));
      /*
        `filled` is the analyser's window length, not the sample rate's — the buffer holds what
        it holds, whatever the source's rate is. Reporting the gate's own sample count here
        instead would claim a full 400 ms from the first frame on.
      */
      loudnessWindowRef.current = pushLoudness(
        loudnessWindowRef.current,
        [leftEnergy.meanSquare, rightEnergy.meanSquare],
        now,
        buffer.length,
      );
      setLoudness(loudnessOf(loudnessWindowRef.current, context.sampleRate));
    }, METER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [active, videoRef, tap]);

  return { meter, loudness, clearClip, resume };
}
