import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { IconButton } from '@clipwright/design-system';
import { formatTimecode, projectDurationUs, type TimelineState } from '@clipwright/timeline-engine';
import type { CaptionStyle } from '@clipwright/caption-styles';
import { gainAt } from '@clipwright/audio-core';
import { itemGeometry } from '@clipwright/compositor';
import { playheadStore, usePlayheadUs } from './playhead-store.js';
import { CaptionOverlay } from './CaptionOverlay.js';

const MEDIA_ORIGIN = 'clipwright-media://media/';

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
  // The source's own aspect ratio, known only after the first frame's metadata.
  // Until then the canvas ratio is the best guess, which is also what the element
  // was doing before crop existed.
  const [sourceAspect, setSourceAspect] = useState((state.canvas?.width ?? 1080) / (state.canvas?.height ?? 1920));
  const durationUs = projectDurationUs(state);

  // The item that is showing at a given time; read imperatively so playback does
  // not re-render the whole editor.
  const itemAt = useCallback(
    (us: number) =>
      Object.values(state.items)
        .filter((item) => (item.type === 'video' || item.type === 'image') && item.mediaId)
        .filter((item) => us >= item.startUs && us < item.startUs + item.durationUs)
        .sort((a, b) => b.startUs - a.startUs)[0] ?? null,
    [state],
  );

  const syncVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const us = playheadStore.get();
    const item = itemAt(us);
    if (!item) {
      setMissing(true);
      video.pause();
      return;
    }
    setMissing(false);
    const sourceUs = item.sourceInUs + (us - item.startUs) * (item.speed ?? 1);
    const target = sourceUs / 1_000_000;
    if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.08) {
      video.currentTime = target;
    }

    // The preview's level comes from the same envelope the export mixes with
    // (SPEC 12 §6.1). Reading the item's own volume is not enough: a fade or a
    // keyframed volume lives in the envelope, and a preview that ignores it sounds
    // different from the file — which is the one thing a preview must not do.
    //
    // The track's mute/solo state is folded in here too, because the video element
    // has no notion of tracks.
    const track = state.tracks.find((candidate) => candidate.id === item.trackId);
    const anySolo = state.tracks.some((candidate) => candidate.solo);
    video.volume = gainAt(
      {
        startUs: item.startUs,
        durationUs: item.durationUs,
        gainDb: item.gainDb ?? 0,
        volumeDb: item.volumeDb ?? 0,
        fadeInUs: item.fadeInUs,
        fadeOutUs: item.fadeOutUs,
        fadeCurve: item.fadeCurve,
        muted: Boolean(item.muted),
        trackMuted: Boolean(track?.muted),
        silencedBySolo: anySolo && !track?.solo,
      },
      us,
    );
  }, [itemAt, state]);

  // Follow the playhead while it moves (scrubbing and playback alike).
  useEffect(() => {
    const unsubscribe = playheadStore.subscribe(syncVideo);
    syncVideo();
    return unsubscribe;
  }, [syncVideo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, [playing]);

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

  const activeItemId = useSyncExternalStore(
    playheadStore.subscribe,
    () => itemAt(playheadStore.get())?.id ?? null,
    () => null,
  );
  const item = activeItemId ? (state.items[activeItemId] ?? null) : null;
  const src = item?.mediaId ? `${MEDIA_ORIGIN}${encodeURIComponent(item.mediaId)}` : undefined;
  const canvas = state.canvas ?? { width: 1080, height: 1920, aspect: '9:16' };
  // The playhead is read through the same subscription as `item`, so a keyframed
  // property redraws as time moves. Reading `playheadStore.get()` here without
  // subscribing would animate only when something else happened to re-render.
  const playheadUs = usePlayheadUs();
  const geometry = itemGeometry({ ...(item ?? {}), timeUs: playheadUs });

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
          {src && !missing ? (
            /*
              Crop is a source-rectangle selection, not a clip: the surviving part
              of the source is fitted to the canvas exactly as the whole source
              would have been, so an uncropped item looks the same as before and a
              cropped one does not stretch (SPEC 14 §3.2: never stretch). The
              fitted box is sized from the crop's own aspect ratio; the video inside
              it is oversized by the crop factors and offset, which makes the box
              show precisely the cropped region.

              The transform sits on a wrapper rather than the <video> so it does not
              also move or scale the caption canvas drawn above it (SPEC 10 §4).
            */
            <div
              data-testid="preview-item"
              style={{
                position: 'absolute',
                inset: 0,
                // `inset: 0` makes this the canvas, so these percentages are
                // percentages of the frame — the unit `transform.x/y` is stored in.
                transform: `translate(${geometry.offsetX * 100}%, ${geometry.offsetY * 100}%)`,
              }}
            >
              <div
                data-testid="preview-item-fit"
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: `translate(-50%, -50%) scale(${
                    geometry.scaleX * (geometry.flipH ? -1 : 1)
                  }, ${geometry.scaleY * (geometry.flipV ? -1 : 1)}) rotate(${geometry.rotation}deg)`,
                  // Fitted inside the canvas, preserving the cropped aspect.
                  maxWidth: '100%',
                  maxHeight: '100%',
                  aspectRatio: `${geometry.source.width * sourceAspect} / ${
                    geometry.source.height
                  }`,
                  width: '100%',
                  overflow: 'hidden',
                }}
              >
                <video
                  ref={videoRef}
                  src={src}
                  muted={muted}
                  playsInline
                  crossOrigin="anonymous"
                  onLoadedMetadata={(event) => {
                    const { videoWidth, videoHeight } = event.currentTarget;
                    if (videoWidth > 0 && videoHeight > 0) setSourceAspect(videoWidth / videoHeight);
                  }}
                  style={{
                    position: 'absolute',
                    // Oversized by 1/crop and shifted by the crop origin: the box
                    // then shows the cropped rectangle and nothing else.
                    left: `${-(geometry.source.x / geometry.source.width) * 100}%`,
                    top: `${-(geometry.source.y / geometry.source.height) * 100}%`,
                    width: `${100 / geometry.source.width}%`,
                    height: `${100 / geometry.source.height}%`,
                    objectFit: 'fill',
                  }}
                />
              </div>
            </div>
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
