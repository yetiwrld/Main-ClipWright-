/**
 * The preview's audio graph (SPEC 12 §6.2, §6.3, SPEC 10 §7.1).
 *
 * Until this existed, sound came from the one `<video>` element the preview drives. That is why
 * an audio item on its own track was silent in the editor and present in the export, why pan was
 * applied by the mixer and never heard, and why the master meter measured the bottom picture
 * layer rather than the mix.
 *
 * ## The shape
 *
 *   media element → MediaElementSource → GainNode (the envelope) → StereoPannerNode → bus
 *                                                                                  ↓
 *                                          … one chain per audible item … → bus → destination
 *                                                                                  ↓
 *                                                                              analysers (meter)
 *
 * One chain per *item*, because an item is the unit that has a gain curve and a pan. Per track
 * would be cheaper and would lose the keyframes; per track-and-item is what the mixer does and
 * what the plan describes.
 *
 * ## The constraints, and they are all real
 *
 * - **`createMediaElementSource` may be called once per element, ever.** A second call throws.
 *   So elements are created here, keyed by item, and *reused* across renders and across a seek —
 *   never rebuilt when the source changes. That is also why the pool is a ref rather than state.
 * - **`AudioContext` starts suspended.** Creating the graph on mount would build it correctly and
 *   produce no sound, because the context never resumes without a user gesture. The transport's
 *   play is that gesture, and `resume()` is exposed for it.
 * - **jsdom has no Web Audio at all.** Every branch is behind a feature check, and a missing
 *   context means the promise is "no preview audio" rather than a thrown error in a render path.
 *
 * ## What it deliberately does not do
 *
 * It does not own the transport. The playhead, the seek and the play/pause are the preview's,
 * and this hook is told the time so it can position each element — the alternative is two
 * clocks, which is the bug SPEC 09 §23 exists to avoid.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  gainAtInstant,
  gainCurveFor,
  previewAudioRequests,
  type PreviewAudioRequest,
  type PreviewAudioTimeline,
} from '@clipwright/audio-core';

/** Where the preview's media bytes come from. Same origin the video layers use. */
const MEDIA_ORIGIN = 'clipwright-media://';

/** How many points a gain curve gets. Web Audio interpolates linearly between them. */
const CURVE_POINTS = 256;

/**
 * How far an element may be from where it should be before it is repositioned.
 *
 * Seeking an element is expensive and audible — a `currentTime` write flushes the buffer and
 * restarts decoding — so the graph corrects drift in coarse steps rather than every frame. 80 ms
 * is under a frame at 12 fps and well above the jitter of a 60 Hz timer.
 */
const SYNC_TOLERANCE_US = 80_000;

interface Chain {
  request: PreviewAudioRequest;
  element: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  /** The media id last loaded into the element, so a re-render does not reload it. */
  loadedMediaId: string;
}

export interface PreviewAudioApi {
  /** Whether a graph exists and is running. The transport's meter relies on this. */
  ready: boolean;
  /**
   * The mix bus, once a context exists: the node everything audible passes through.
   *
   * The meter taps *this* rather than the `<video>` element. Tapping the element measured the
   * bottom picture layer, which is what `docs/limitations.md` used to record as a bug: a mix
   * containing three audio items read as one, and pan read as centred because the element
   * has no pan. The bus is the only node whose level is the level the export would produce.
   */
  tap: { context: AudioContext; node: AudioNode } | null;
  /** Start or resume the context. Must be called from a user gesture (play). */
  resume: () => void;
  /** Suspend the context, so a paused preview is not spinning a clock. */
  suspend: () => void;
  /**
   * Position every element for a playhead instant, and start or stop each item.
   *
   * Called by the preview's own playback loop rather than driven from here: the playhead is the
   * one clock, and a second `setInterval` would be a second clock.
   */
  seekTo: (timeUs: number, playing: boolean) => void;
}

/**
 * Build and maintain the preview's audio graph.
 *
 * `enabled` is the user's mute switch: a muted preview builds no graph at all, so muting costs
 * nothing rather than summing every item into a node whose output goes nowhere.
 */
export function usePreviewAudio(
  /**
   * The timeline, or `null` when the preview is rendered without one.
   *
   * Null rather than undefined because it is *not* the same as an empty timeline: with no
   * timeline there is nothing to be wrong about, and the hook must not build a context for
   * a preview that cannot play anything. An empty timeline, by contrast, is a real project
   * with nothing audible in it, and the context is still worth having so the transport's
   * meter has a bus to read.
   */
  timeline: PreviewAudioTimeline | null,
  options: { enabled: boolean; volume?: number },
): PreviewAudioApi {
  const [ready, setReady] = useState(false);
  const [tap, setTap] = useState<{ context: AudioContext; node: AudioNode } | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  /*
    Read by `createContext` for the bus's starting gain. A ref rather than a dependency: the
    volume changes on every drag of the slider, and rebuilding the context callback on each
    step would re-run the build effect for a value that effect does not otherwise want.
  */
  const volumeRef = useRef(options.volume ?? 1);
  volumeRef.current = options.volume ?? 1;
  const busRef = useRef<GainNode | null>(null);
  const chainsRef = useRef<Map<string, Chain>>(new Map());
  const elementsRef = useRef<Map<string, HTMLMediaElement>>(new Map());

  /*
    The plan, recomputed when the timeline changes. It is memoised on the *whole* timeline
    object because that object is replaced by immer on every edit — which is exactly the signal
    that a rebuild may be needed.
  */
  const requests = useMemo(
    () => (timeline ? previewAudioRequests(timeline) : []),
    [timeline],
  );

  const createContext = useCallback((): AudioContext | null => {
    if (contextRef.current) return contextRef.current;
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    try {
      const context = new Context();
      const bus = context.createGain();
      bus.gain.value = volumeRef.current;
      bus.connect(context.destination);
      contextRef.current = context;
      busRef.current = bus;
      setReady(true);
      setTap({ context, node: bus });
      return context;
    } catch {
      return null;
    }
  }, []);

  /*
    The master volume follows the transport's slider. Set through `setTargetAtTime` rather than
    assigned, because assigning `gain.value` on a live graph is a discontinuity — an audible
    click on every drag of the slider.
  */
  useEffect(() => {
    const bus = busRef.current;
    if (!bus) return;
    bus.gain.setTargetAtTime(options.volume ?? 1, bus.context.currentTime, 0.01);
  }, [options.volume]);

  /** One element per item, created once and kept. */
  const elementFor = useCallback((itemId: string): HTMLMediaElement => {
    const existing = elementsRef.current.get(itemId);
    if (existing) return existing;
    /*
      An `<audio>` element rather than a `<video>`: these sources are never drawn, and a hidden
      video element would decode frames nobody sees. The element is deliberately **not** attached
      to the document — Chromium plays a detached element through Web Audio, and attaching it
      would put invisible media in the accessibility tree.
    */
    const element = document.createElement('audio');
    element.preload = 'auto';
    element.crossOrigin = 'anonymous';
    elementsRef.current.set(itemId, element);
    return element;
  }, []);

  /*
    The session gate. With no context there is no bus and nothing to seek, so `seekTo` would
    do nothing per frame — cheap, but it would also leave every element unpositioned, and a
    stale `currentTime` on an element that later gets connected is a burst of sound from the
    wrong place. Skipping the work entirely is the honest behaviour.
  */
  const enabled = options.enabled && timeline !== null;

  /* Build, rebuild and tear down chains as the plan changes. */
  useEffect(() => {
    if (!enabled) {
      /*
        Muted: stop the sound, keep the graph.

        Suspending the context is not enough — a suspended context is not a silent one, and
        even if it were, the elements would keep decoding and would resume from wherever they
        had drifted to. Pausing them here means unmuting resumes from the playhead rather than
        from a buffer that ran on unwatched. The chains themselves are kept, because
        `createMediaElementSource` cannot be undone: dropping them would leave the element
        permanently unplayable through the graph, so the mute has to be a pause, not a teardown.
      */
      for (const chain of chainsRef.current.values()) {
        if (!chain.element.paused) chain.element.pause();
      }
      return;
    }
    const context = createContext();
    const bus = busRef.current;
    if (!context || !bus) return;

    const wanted = new Set(requests.map((request) => request.itemId));

    /* Drop chains for items that are no longer audible (deleted, muted, un-soloed). */
    for (const [itemId, chain] of chainsRef.current) {
      if (wanted.has(itemId)) continue;
      chain.element.pause();
      try {
        chain.source.disconnect();
        chain.gain.disconnect();
        chain.panner.disconnect();
      } catch {
        /* A disconnected node throws on a second disconnect; nothing to do about it. */
      }
      chainsRef.current.delete(itemId);
    }

    for (const request of requests) {
      const element = elementFor(request.itemId);
      const url = `${MEDIA_ORIGIN}${encodeURIComponent(request.mediaId)}`;
      if (element.dataset['clipwrightMedia'] !== request.mediaId) {
        element.src = url;
        element.dataset['clipwrightMedia'] = request.mediaId;
      }

      let chain = chainsRef.current.get(request.itemId);
      if (!chain) {
        try {
          const source = context.createMediaElementSource(element);
          const gain = context.createGain();
          const panner = context.createStereoPanner();
          source.connect(gain);
          gain.connect(panner);
          panner.connect(bus);
          chain = { request, element, source, gain, panner, loadedMediaId: request.mediaId };
          chainsRef.current.set(request.itemId, chain);
        } catch {
          /*
            Already bound to another context, or the environment refuses the node. Leave this
            item silent rather than throwing into a render path — the same rule the meter
            follows.
          */
          continue;
        }
      }
      chain.request = request;
    }
  }, [createContext, elementFor, enabled, requests]);

  /* Gain and pan, whenever the plan changes. */
  useEffect(() => {
    for (const chain of chainsRef.current.values()) {
      const curve = gainCurveFor(chain.request, CURVE_POINTS);
      /*
        `setValueCurveAtTime` would be the obvious call, but it throws if a curve is scheduled
        over a range that is already scheduled — and this graph re-plans on every timeline edit.
        Scheduling the *current* value and letting the per-frame `seekTo` correct it keeps the
        graph stable across an edit that arrives mid-playback; the alternative is an exception
        from a user's keystroke.
      */
      chain.gain.gain.setTargetAtTime(
        curve[0] ?? 1,
        chain.gain.context.currentTime,
        0.01,
      );
      chain.panner.pan.setTargetAtTime(chain.request.pan, chain.panner.context.currentTime, 0.01);
    }
  }, [requests]);

  const seekTo = useCallback((timeUs: number, playing: boolean) => {
    const context = contextRef.current;
    if (!context) return;
    for (const chain of chainsRef.current.values()) {
      const { request, element } = chain;
      const active = timeUs >= request.startUs && timeUs < request.startUs + request.durationUs;
      if (!active) {
        if (!element.paused) element.pause();
        continue;
      }
      const wantedUs = request.sourceInUs + (timeUs - request.startUs);
      const currentUs = element.currentTime * 1_000_000;
      /*
        Coarse correction only. `currentTime` is written when the element is meaningfully out of
        position — a seek, a track change, or drift past the tolerance — and never while it is
        within a fraction of a frame, because writing it flushes the decoder.
      */
      if (Math.abs(currentUs - wantedUs) > SYNC_TOLERANCE_US) {
        element.currentTime = wantedUs / 1_000_000;
      }
      /*
        The envelope is evaluated **now**, every frame, because it changes within a clip — a
        volume keyframe or a fade is a function of time and this is the point of the whole
        exercise. `setTargetAtTime` with a short time constant rather than an assignment: a raw
        `gain.value` write per frame is a discontinuity per frame, which is a rasp on a fade.
      */
      chain.gain.gain.setTargetAtTime(gainAtInstant(request, timeUs), context.currentTime, 0.02);
      if (playing && element.paused) void element.play().catch(() => undefined);
      if (!playing && !element.paused) element.pause();
    }
  }, []);

  const resume = useCallback(() => {
    const context = createContext();
    if (context && context.state === 'suspended') void context.resume();
  }, [createContext]);

  const suspend = useCallback(() => {
    const context = contextRef.current;
    if (context && context.state === 'running') void context.suspend();
  }, []);

  /* Tear everything down when the preview unmounts. */
  useEffect(
    () => () => {
      for (const chain of chainsRef.current.values()) {
        chain.element.pause();
        chain.element.removeAttribute('src');
        try {
          chain.source.disconnect();
        } catch {
          /* already gone */
        }
      }
      chainsRef.current.clear();
      elementsRef.current.clear();
      if (contextRef.current) void contextRef.current.close().catch(() => undefined);
      contextRef.current = null;
      busRef.current = null;
      setReady(false);
      setTap(null);
    },
    [],
  );

  /*
    A stable object, because the preview puts it in effect dependency lists that subscribe to the
    playhead. A fresh literal each render would resubscribe on every frame of playback — cheap
    per frame and a leak of listeners over a long session, and the kind of thing that only shows
    up as "the preview gets slower the longer I leave it open".
  */
  return useMemo(
    () => ({ ready, tap, resume, suspend, seekTo }),
    [ready, tap, resume, suspend, seekTo],
  );
}
