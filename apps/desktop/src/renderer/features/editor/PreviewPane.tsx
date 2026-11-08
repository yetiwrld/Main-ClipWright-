import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { IconButton } from '@clipwright/design-system';
import { formatTimecode, projectDurationUs, type TimelineState } from '@clipwright/timeline-engine';
import type { CaptionStyle } from '@clipwright/caption-styles';
import { gainAt } from '@clipwright/audio-core';
import {
  itemGeometry,
  transitionAt,
  visibleLayers,
  type ItemGeometry,
  type VisibleLayer,
} from '@clipwright/compositor';
import { playheadStore, usePlayheadUs } from './playhead-store.js';
import { CaptionOverlay } from './CaptionOverlay.js';

const MEDIA_ORIGIN = 'clipwright-media://media/';

/**
 * The timeline's blend mode name → the CSS keyword that means the same thing.
 *
 * Only `add` differs: the schema calls additive blending `add` (the name ffmpeg's
 * `addition` mode is reported under in our own export), while CSS calls it
 * `plus-lighter`. Passing `add` through unchanged is invalid CSS, so the browser
 * silently drops the declaration and the layer paints as if it were `normal` —
 * a bug that looks like blending being ignored. The rest happen to agree.
 */
const CSS_BLEND_MODE: Record<string, React.CSSProperties['mixBlendMode']> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  add: 'plus-lighter',
  'soft-light': 'soft-light',
};

/**
 * Preview canvas (SPEC 10 first slice): shows the frame under the playhead from
 * the main-track item, scaled into the project canvas. Playback advances the
 * playhead from a real clock and lets the video element follow it.
 */
export function PreviewPane({
  state,
  fps,
  captionStyles = {},
}: {
  state: TimelineState;
  fps: 30 | 60;
  /** Project-local caption styles, so the preview shows what the export will. */
  captionStyles?: Readonly<Record<string, CaptionStyle>>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [missing, setMissing] = useState(false);
  const durationUs = projectDurationUs(state);

  const canvas = state.canvas ?? { width: 1080, height: 1920, aspect: '9:16' };
  // Subscribing to the playhead is what makes a keyframed property redraw as time
  // moves; reading `playheadStore.get()` without subscribing would animate only
  // when something else happened to re-render.
  const playheadUs = usePlayheadUs();



  // Playback clock (SPEC 09 §23): advance on animation frames, stop at the end.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const deltaUs = (now - last) * 1000;
      last = now;
      const next = playheadStore.get() + deltaUs;
      if (next >= durationUs) {
        playheadStore.set(durationUs);
        setPlaying(false);
        return;
      }
      playheadStore.set(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationUs, playing]);

  useEffect(() => {
    const toggle = () => setPlaying((value) => !value);
    window.addEventListener('clipwright:toggle-play', toggle);
    return () => window.removeEventListener('clipwright:toggle-play', toggle);
  }, []);



  /**
   * Every picture layer at the playhead, bottom first (SPEC 10 §2/§6) including
   * the two sides of a running transition (SPEC 12 §4).
   *
   * The preview used to draw exactly one item — the one that started last — so an
   * overlay clip was invisible and the main video showed through it. Layering is
   * resolved by the same `visibleLayers` the export uses, which is what stops the
   * two from disagreeing about which clip is on top.
   *
   * A transition is the one case where an item is drawn outside its own time range:
   * during a centred crossfade the *outgoing* clip has already ended and the
   * *incoming* one has not started, yet both are on screen. `visibleLayers` already
   * widens the incoming side; the outgoing side is widened here by looking forward
   * for the next item on the same track.
   */
  const layers = useMemo(() => {
    const pictures = Object.values(state.items).filter(
      (entry) => (entry.type === 'video' || entry.type === 'image') && entry.mediaId,
    );
    const orderOf = (trackId: string) =>
      state.tracks.find((track) => track.id === trackId)?.order ?? 0;

    return visibleLayers(
      pictures.map((entry) => {
        // An item whose successor starts inside a transition window stays drawable
        // across that window: it is the outgoing half of the transition.
        const successor = pictures
          .filter((other) => other.trackId === entry.trackId && other.startUs > entry.startUs)
          .sort((a, b) => a.startUs - b.startUs)[0];
        // How far the successor's transition reaches back before its own start:
        // the whole duration for a `start`-aligned window, half of it for a centred
        // one, and not at all for an `end`-aligned one.
        const transitionIn = successor?.transitionIn;
        const extensionUs = !transitionIn
          ? 0
          : transitionIn.alignment === 'start'
            ? transitionIn.durationUs
            : transitionIn.alignment === 'center'
              ? Math.round(transitionIn.durationUs / 2)
              : 0;
        return {
          id: entry.id,
          startUs: entry.startUs,
          durationUs: entry.durationUs + extensionUs,
          trackOrder: orderOf(entry.trackId),
          opacity: entry.opacity,
          blendMode: entry.blendMode,
          keyframes: entry.keyframes,
          disabled: entry.disabled,
          hiddenTrack: Boolean(state.tracks.find((track) => track.id === entry.trackId)?.hidden),
          transitionIn: entry.transitionIn,
        };
      }),
      playheadUs,
    );
  }, [state, playheadUs]);

  // Sound comes from the bottom picture layer only — the one `videoRef` points at.
  // Each layer seeks itself; this function must not seek or the two would fight
  // over the same element.
  const syncVideo = useCallback(() => {
    const video = videoRef.current;
    const us = playheadStore.get();
    const bottom = layers[0] ? state.items[layers[0].id] : undefined;
    if (!video || !bottom) {
      setMissing(true);
      video?.pause();
      return;
    }
    setMissing(false);

    // The preview's level comes from the same envelope the export mixes with
    // (SPEC 12 §6.1). Reading the item's own volume is not enough: a fade or a
    // keyframed volume lives in the envelope, and a preview that ignores it sounds
    // different from the file — which is the one thing a preview must not do.
    //
    // The track's mute/solo state is folded in here too, because the video element
    // has no notion of tracks.
    const track = state.tracks.find((candidate) => candidate.id === bottom.trackId);
    const anySolo = state.tracks.some((candidate) => candidate.solo);
    video.volume = gainAt(
      {
        startUs: bottom.startUs,
        durationUs: bottom.durationUs,
        gainDb: bottom.gainDb ?? 0,
        volumeDb: bottom.volumeDb ?? 0,
        fadeInUs: bottom.fadeInUs,
        fadeOutUs: bottom.fadeOutUs,
        fadeCurve: bottom.fadeCurve,
        muted: Boolean(bottom.muted),
        trackMuted: Boolean(track?.muted),
        silencedBySolo: anySolo && !track?.solo,
      },
      us,
    );
  }, [layers, state]);

  // Follow the playhead while it moves (scrubbing and playback alike).
  useEffect(() => {
    const unsubscribe = playheadStore.subscribe(syncVideo);
    syncVideo();
    return unsubscribe;
  }, [syncVideo]);



  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface-app)',
          padding: 'var(--space-3)',
        }}
      >
        <div
          style={{
            position: 'relative',
            aspectRatio: state.canvas?.aspect ?? '9:16',
            maxHeight: '100%',
            maxWidth: '100%',
            height: '100%',
            background: canvas.backgroundColor ?? 'var(--surface-card)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            border: '1px solid var(--line-subtle)',
          }}
        >
          {layers.length > 0 ? (
            layers.map((layer: VisibleLayer, index: number) => {
              const transition = transitionFor(layer, state, playheadUs);
              return (
              <PreviewLayer
                key={layer.id}
                item={state.items[layer.id]!}
                geometry={itemGeometry({ ...state.items[layer.id]!, timeUs: playheadUs })}
                opacity={layer.opacity * (transition?.fromOpacity ?? 1)}
                blendMode={layer.blendMode}
                transitionOffsetX={transition?.offsetX ?? 0}
                transitionScale={transition?.scale ?? 1}
                initialAspect={canvas.width / canvas.height}
                muted={muted}
                playing={playing}
                onPlayRejected={() => setPlaying(false)}
                // Only the bottom layer carries sound: two <video> elements both
                // playing the same source double the volume and echo by a frame.
                audio={index === 0}
                reffed={index === 0 ? videoRef : undefined}
              />
              );
            })
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                padding: 'var(--space-3)',
                fontSize: 'var(--fs-sm)',
                color: 'var(--text-muted)',
              }}
            >
              {missing ? 'Nothing under the playhead' : 'Add a clip to preview'}
            </div>
          )}

          {/*
            Captions are painted over the video, always — including over the
            "nothing under the playhead" message, because a caption track can be
            the only track with content in a range.
          */}
          <CaptionOverlay
            state={state}
            width={canvas.width}
            height={canvas.height}
            projectCopies={captionStyles}
          />
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderTop: '1px solid var(--line-subtle)',
        }}
      >
        <IconButton
          label="Back to start"
          size={28}
          icon={<SkipBack size={14} />}
          onClick={() => playheadStore.set(0)}
        />
        <IconButton
          label={playing ? 'Pause' : 'Play'}
          shortcut="Space"
          size={32}
          active={playing}
          icon={playing ? <Pause size={14} /> : <Play size={14} />}
          onClick={() => setPlaying((value) => !value)}
        />
        <IconButton
          label="Jump to end"
          size={28}
          icon={<SkipForward size={14} />}
          onClick={() => playheadStore.set(durationUs)}
        />
        <TransportTimecode fps={fps} durationUs={durationUs} />
        <div style={{ marginLeft: 'auto' }}>
          <IconButton
            label={muted ? 'Unmute preview' : 'Mute preview'}
            size={28}
            active={muted}
            icon={muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            onClick={() => setMuted((value) => !value)}
          />
        </div>
      </div>
    </div>
  );
}

function TransportTimecode({ fps, durationUs }: { fps: 30 | 60; durationUs: number }) {
  const us = usePlayheadUs();
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        color: 'var(--text-secondary)',
      }}
    >
      {formatTimecode(us, fps)} <span style={{ color: 'var(--text-muted)' }}>/ {formatTimecode(durationUs, fps)}</span>
    </span>
  );
}


/**
 * What a running transition asks of one layer (SPEC 12 §4).
 *
 * A layer can be on either side of the cut, and the two sides want opposite halves
 * of the same `TransitionState` — so this picks the half. The incoming item is the
 * one that carries `transitionIn`; the outgoing one is whichever layer's successor
 * does. Offsets are returned in frame widths, the unit the transform uses.
 */
function transitionFor(
  layer: VisibleLayer,
  state: TimelineState,
  timeUs: number,
): { fromOpacity: number; offsetX: number; scale: number } | null {
  const item = state.items[layer.id];
  if (!item) return null;

  if (item.transitionIn) {
    const at = transitionAt(item.startUs, item.transitionIn, timeUs);
    if (!at) return null;
    // `visibleLayers` already multiplies in the two fade shapes' contribution
    // (`fade-black`, `dip-color`), because those are the only ones where the
    // incoming item is *absent* rather than transparent. Applying `toOpacity` again
    // here would square the fade — a 0.5 became 0.25.
    const fadedByLayers =
      item.transitionIn.type === 'fade-black' || item.transitionIn.type === 'dip-color';
    return {
      fromOpacity: fadedByLayers ? 1 : at.state.toOpacity,
      offsetX: at.state.toOffsetX,
      scale: at.state.toScale,
    };
  }

  // Outgoing side: find the next item on this track and ask its transition.
  const pictures = Object.values(state.items).filter(
    (entry) => entry.trackId === item.trackId && entry.startUs > item.startUs,
  );
  const successor = pictures.sort((a, b) => a.startUs - b.startUs)[0];
  if (!successor?.transitionIn) return null;
  const at = transitionAt(successor.startUs, successor.transitionIn, timeUs);
  if (!at) return null;
  return {
    fromOpacity: at.state.fromOpacity,
    offsetX: at.state.fromOffsetX,
    scale: at.state.fromScale,
  };
}

/**
 * One picture layer of the preview (SPEC 10 §2/§6).
 *
 * Extracted from the canvas so the frame can hold more than one. The crop,
 * transform and flip work exactly as they did when there was a single item; what
 * is new is that each layer carries its own opacity and blend mode, applied with
 * CSS because the browser already composites this way and re-implementing the
 * blend maths in JavaScript would be slower *and* a second definition of what a
 * `multiply` is.
 *
 * `mix-blend-mode` blends against everything painted below it inside the same
 * stacking context, which is the canvas — so a `screen` overlay picks up the main
 * video, not the app chrome behind it.
 */
const PreviewLayer = memo(function PreviewLayer({
  item,
  geometry,
  opacity,
  blendMode,
  initialAspect,
  transitionOffsetX,
  transitionScale,
  muted,
  playing,
  onPlayRejected,
  audio,
  reffed,
}: {
  item: TimelineState['items'][string];
  geometry: ItemGeometry;
  opacity: number;
  blendMode: string;
  /** Canvas aspect, used until the source reports its own. */
  initialAspect: number;
  /** Horizontal slide from a running transition, in frame widths. */
  transitionOffsetX: number;
  /** Scale from a running `zoom` transition. */
  transitionScale: number;
  muted: boolean;
  playing: boolean;
  onPlayRejected: () => void;
  /** Whether this layer supplies sound. Only the bottom layer does. */
  audio: boolean;
  reffed?: React.MutableRefObject<HTMLVideoElement | null>;
}) {
  // The source's own aspect ratio, known only after the first frame's metadata.
  // Until then the canvas ratio is the best guess, which is also what the element
  // was doing before crop existed.
  const [sourceAspect, setSourceAspect] = useState(initialAspect);
  const src = item.mediaId ? `${MEDIA_ORIGIN}${encodeURIComponent(item.mediaId)}` : undefined;
  const fitRef = useRef<HTMLDivElement>(null);

  // Each layer's <video> has to follow the playhead on its own: they carry
  // different source in-points, so one shared `currentTime` would put every layer
  // at the same frame of the same file.
  useEffect(() => {
    const video = fitRef.current?.querySelector('video');
    if (!video) return;
    const sync = () => {
      const us = playheadStore.get();
      const sourceUs = item.sourceInUs + (us - item.startUs) * (item.speed ?? 1);
      const target = sourceUs / 1_000_000;
      if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.08) {
        video.currentTime = target;
      }
    };
    const unsubscribe = playheadStore.subscribe(sync);
    sync();
    return unsubscribe;
  }, [item.sourceInUs, item.startUs, item.speed]);

  // Every layer plays its own element: the parent used to call `play()` on the
  // single <video>, and with a stack the overlays would sit frozen on their first
  // frame while the layer beneath them ran.
  useEffect(() => {
    const video = fitRef.current?.querySelector('video');
    if (!video) return;
    if (playing) void video.play().catch(onPlayRejected);
    else video.pause();
  }, [playing, onPlayRejected]);

  if (!src) return null;

  return (
    <div
      data-testid="preview-item"
      data-layer-id={item.id}
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        mixBlendMode: CSS_BLEND_MODE[blendMode] ?? 'normal',
        // The transition's slide adds to the item's own offset: both are frame
        // fractions, so they compose without conversion.
        transform: `translate(${(geometry.offsetX + transitionOffsetX) * 100}%, ${
          geometry.offsetY * 100
        }%)`,
      }}
    >
      <div
        ref={fitRef}
        data-testid="preview-item-fit"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(-50%, -50%) scale(${
            geometry.scaleX * (geometry.flipH ? -1 : 1) * transitionScale
          }, ${geometry.scaleY * (geometry.flipV ? -1 : 1) * transitionScale}) rotate(${
            geometry.rotation
          }deg)`,
          maxWidth: '100%',
          maxHeight: '100%',
          aspectRatio: `${geometry.source.width * sourceAspect} / ${geometry.source.height}`,
          width: '100%',
          overflow: 'hidden',
        }}
      >
        <video
          ref={reffed}
          src={src}
          muted={muted || !audio}
          playsInline
          crossOrigin="anonymous"
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) setSourceAspect(videoWidth / videoHeight);
          }}
          style={{
            position: 'absolute',
            left: `${-(geometry.source.x / geometry.source.width) * 100}%`,
            top: `${-(geometry.source.y / geometry.source.height) * 100}%`,
            width: `${100 / geometry.source.width}%`,
            height: `${100 / geometry.source.height}%`,
            objectFit: 'fill',
          }}
        />
      </div>
    </div>
  );
});
