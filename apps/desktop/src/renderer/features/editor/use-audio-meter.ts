/**
 * The preview's audio graph, in as much as it exists (SPEC 12 §6.3).
 *
 * This is deliberately the *smallest* graph that can feed a meter: one `MediaElementSource`
 * on the preview's `<video>`, one splitter into two analysers, and the source connected to
 * the destination so sound keeps coming out. It exists so the transport's peak meter reads
 * something real rather than a synthesised number.
 *
 * What it is **not** yet: the full graph the spec describes. Pan, per-item gain automation
 * and the audio-mastered playback clock all want per-item nodes rather than one node on the
 * bottom layer, and this slice does not pretend otherwise — see `docs/limitations.md` §3.1.
 * Building the meter first is the useful order: the meter is what makes the rest of the
 * graph *checkable*, since every later change can be heard and seen instead of trusted.
 *
 * Two constraints shape the code:
 *
 * - `createMediaElementSource` may be called **once per element**, ever. A second call
 *   throws, so the graph is created once and kept in a ref rather than rebuilt when the
 *   source changes.
 * - jsdom has no `AudioContext` at all. Everything here is behind a feature check, and a
 *   missing graph means the meter reads silence instead of the component throwing — the
 *   same "never silently broken" rule the rest of the preview follows.
 */

import { useEffect, useRef, useState } from 'react';
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
): AudioMeterApi {
  const [meter, setMeter] = useState<MeterState>(SILENT_METER);
  const contextRef = useRef<AudioContext | null>(null);
  const leftRef = useRef<AnalyserNode | null>(null);
  const rightRef = useRef<AnalyserNode | null>(null);
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
    const context = contextRef.current;
    if (context && context.state === 'suspended') void context.resume();
  };

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;

    // No Web Audio in this environment (jsdom, or a browser that refuses one): the meter
    // stays at silence and nothing throws. The transport still draws its scale, so the
    // absence reads as "quiet" rather than as "no meter".
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;

    let context = contextRef.current;
    if (!context) {
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

    const timer = window.setInterval(() => {
      const left = leftRef.current;
      const right = rightRef.current;
      if (!left || !right) return;
      const buffer = bufferRef.current;
      left.getFloatTimeDomainData(buffer);
      const leftDb = channelPeakDb(buffer, 0, 1);
      right.getFloatTimeDomainData(buffer);
      const rightDb = channelPeakDb(buffer, 0, 1);
      setMeter((current) => updateMeter(current, { leftDb, rightDb }, performance.now()));
    }, METER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [active, videoRef]);

  return { meter, clearClip, resume };
}
