/**
 * Per-track meters for the track headers (SPEC 12 §6.3).
 *
 * The graph publishes one summing node per track that has something audible on it
 * (`usePreviewAudio`'s `trackTaps`); this reads them all on **one** timer and hands back a
 * `MeterState` per track id. One timer rather than one per header is the whole design: a project
 * with twelve tracks would otherwise run twelve `setInterval`s at 30 Hz, each reading two
 * analysers, and the cost would grow with the thing the meters are meant to help you watch.
 *
 * The analysers are built here rather than in the graph so the graph stays about sound: a meter is
 * a *tap*, and adding one must not change what is played. Each is `connect`ed to its track node
 * and to nothing else — a connected-then-forgotten analyser still costs CPU per read, so the
 * teardown disconnects them.
 *
 * Silent tracks are omitted from the result rather than reported at the floor, matching the
 * graph's decision to publish only the tracks that can make sound. A header asks
 * `meters.get(track.id)` and draws a meter when the answer exists.
 */
import { useEffect, useRef, useState } from 'react';
import { SILENT_METER, channelPeakDb, updateMeter, type MeterState } from './audio-meter.js';

/** How often the analysers are read (SPEC 12 §6.3: meters update at 30 Hz). */
const METER_INTERVAL_MS = 1000 / 30;

/**
 * How many samples each analyser window holds.
 *
 * Smaller than the master meter's 2048. A track meter is a glancing check on a header row, and
 * 1024 samples is 21 ms at 48 kHz — long enough to catch the peak of a syllable, short enough to
 * react between them. The master meter keeps the larger window because it is also what the
 * momentary loudness is computed from.
 */
const TRACK_ANALYSER_FFT = 1024;

interface TrackAnalysers {
  left: AnalyserNode;
  right: AnalyserNode;
}

export function useTrackMeters(
  context: AudioContext | null,
  trackTaps: ReadonlyMap<string, AudioNode>,
): ReadonlyMap<string, MeterState> {
  const [meters, setMeters] = useState<ReadonlyMap<string, MeterState>>(new Map());
  const analysersRef = useRef<Map<string, TrackAnalysers>>(new Map());
  /*
    The buffer is reused across every track and every frame — 1024 floats, allocated once. Allocating
    per read would put 12 tracks × 30 Hz × 1024 floats of garbage on the heap every second, which
    is a real cost in a renderer that is also decoding video.
  */
  const bufferRef = useRef<Float32Array<ArrayBuffer>>(new Float32Array(TRACK_ANALYSER_FFT));
  /*
    The held state, kept in refs as well as in React state. `updateMeter` needs the previous
    reading to hold a peak, and reading it from state inside the interval callback would capture
    the value from the render the effect ran in — so the peak would never advance past the first
    frame's. `metersRef` is the same value for the same reason: it is what the "has anything
    changed" test compares against, and state would be one interval behind.

    Declared here rather than beside the return because a `let`/`const` is only initialised at its
    own line: an effect that ran before the declaration line would hit the temporal dead zone.
  */
  const prevRef = useRef<Map<string, MeterState>>(new Map());
  const metersRef = useRef<ReadonlyMap<string, MeterState>>(new Map());

  useEffect(() => {
    if (!context) {
      analysersRef.current.clear();
      setMeters(new Map());
      return;
    }

    /*
      Build an analyser pair for each newly-published track node. Nodes that are no longer published
      are left connected: the graph keeps the track node for the life of the context (a muted track
      gets its node back rather than a new one), so tearing the analyser down and rebuilding it on
      every mute/unmute would be churn for a meter that reads correctly either way — the node is
      silent, so the analyser reads silence.
    */
    for (const [trackId, node] of trackTaps) {
      if (analysersRef.current.has(trackId)) continue;
      try {
        const splitter = context.createChannelSplitter(2);
        const left = context.createAnalyser();
        const right = context.createAnalyser();
        left.fftSize = TRACK_ANALYSER_FFT;
        right.fftSize = TRACK_ANALYSER_FFT;
        node.connect(splitter);
        splitter.connect(left, 0);
        splitter.connect(right, 1);
        analysersRef.current.set(trackId, { left, right });
      } catch {
        /*
          A context that refuses a node, or one that has been closed. Leave this track unmetered
          rather than throwing from an effect — the same rule the master meter follows, and the
          reason the header draws nothing.
        */
        continue;
      }
    }

    const timer = window.setInterval(() => {
      const buffer = bufferRef.current;
      const next = new Map<string, MeterState>();
      const now = performance.now();
      for (const [trackId, analysers] of analysersRef.current) {
        analysers.left.getFloatTimeDomainData(buffer);
        const leftDb = channelPeakDb(buffer, 0, 1);
        analysers.right.getFloatTimeDomainData(buffer);
        const rightDb = channelPeakDb(buffer, 0, 1);
        /*
          The hold and the clip light are computed per track by the same `updateMeter` the master
          meter uses, so a track that clipped latches exactly as the master does. The *held*
          state is carried in `meters`, which is what makes the hold work at all: a fresh
          `SILENT_METER` each frame would forget the peak immediately.
        */
        const previous = prevRef.current.get(trackId) ?? SILENT_METER;
        const updated = updateMeter(previous, { leftDb, rightDb }, now);
        next.set(trackId, updated);
      }
      prevRef.current = next;
      /*
        Only re-render when a reading actually moved by enough to change a 3 px bar, or when the
        set of tracks changed. Thirty state updates a second per track would re-render every
        header on every frame for bars that are a pixel wide.
      */
      let changed = next.size !== metersRef.current.size;
      if (!changed) {
        for (const [trackId, reading] of next) {
          const before = metersRef.current.get(trackId);
          if (!before || before.leftDb !== reading.leftDb || before.rightDb !== reading.rightDb) {
            changed = true;
            break;
          }
        }
      }
      metersRef.current = next;
      if (changed) setMeters(next);
    }, METER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [context, trackTaps]);

  return meters;
}
