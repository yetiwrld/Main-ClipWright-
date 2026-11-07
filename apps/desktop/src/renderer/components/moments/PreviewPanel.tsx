import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip } from '@clipwright/design-system';
import { Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { MomentPayload, TranscriptPayload } from '../../global.js';
import { formatDuration, formatTimecode } from './MomentCard.js';

/** Context shown either side of the clip on the mini timeline (SPEC 07 §9.3). */
const CONTEXT_US = 15_000_000;

export function mediaUrl(mediaId: string | undefined): string | null {
  return mediaId ? `clipwright-media://media/${encodeURIComponent(mediaId)}` : null;
}

export function PreviewPanel({
  moment,
  transcript,
  mediaId,
  aspect,
  captionStyleId,
  playheadUs,
  playing,
  loop,
  muted,
  onTogglePlay,
  onToggleLoop,
  onToggleMute,
  onSeek,
  onPlayheadChange,
  onRangeChange,
  onReset,
  onRescore,
  scoring,
}: {
  moment: MomentPayload | null;
  transcript: TranscriptPayload | null;
  mediaId?: string;
  aspect: string;
  captionStyleId: string;
  playheadUs: number;
  playing: boolean;
  loop: boolean;
  muted: boolean;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
  onToggleMute: () => void;
  onSeek: (us: number) => void;
  onPlayheadChange: (us: number) => void;
  onRangeChange: (startUs: number, endUs: number) => void;
  onReset: () => void;
  onRescore: () => void;
  scoring: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [durationUs, setDurationUs] = useState(0);
  const src = mediaUrl(mediaId);

  const wordsInRange = useMemo(() => {
    if (!moment || !transcript) return [];
    return transcript.words.filter((word) => word.endUs > moment.startUs && word.startUs < moment.endUs);
  }, [moment, transcript]);

  // The player is confined to the moment range; seeking outside it is a range edit.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !moment) return;
    const seconds = moment.startUs / 1_000_000;
    if (Math.abs(video.currentTime - seconds) > 0.2) video.currentTime = seconds;
  }, [moment?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !moment) return;
    if (playing) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [playing, moment?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !moment) return;
    const currentUs = Math.round(video.currentTime * 1_000_000);
    onPlayheadChange(currentUs);
    if (currentUs >= moment.endUs) {
      if (loop) {
        video.currentTime = moment.startUs / 1_000_000;
      } else {
        video.pause();
      }
    }
  }, [moment, loop, onPlayheadChange]);

  if (!moment) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 'var(--fs-sm)',
          padding: 32,
          textAlign: 'center',
        }}
      >
        Select a moment to preview it here.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 'var(--space-4)', height: '100%', overflow: 'auto' }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: aspectRatioCss(aspect),
          maxHeight: 380,
          margin: '0 auto',
          background: 'var(--surface-app)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          border: '1px solid var(--line-subtle)',
        }}
      >
        {src ? (
          <video
            ref={videoRef}
            src={src}
            muted={muted}
            playsInline
            onLoadedMetadata={(event) => setDurationUs(Math.round(event.currentTarget.duration * 1_000_000))}
            onTimeUpdate={handleTimeUpdate}
            style={{ width: '100%', height: '100%', objectFit: 'cover', background: 'black' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', padding: 16, textAlign: 'center' }}>
            The source video for this project could not be found.
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            left: 10,
            right: 10,
            bottom: 10,
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-overlay)',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-sm)',
            fontWeight: 700,
            textAlign: 'center',
          }}
        >
          {currentCaption(wordsInRange, playheadUs) ?? ' '}
        </div>
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-muted)',
            background: 'var(--surface-overlay)',
            padding: '2px 6px',
            borderRadius: 'var(--radius-xs)',
          }}
        >
          {captionStyleId}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
        <Button size={32} variant="ghost" onClick={onTogglePlay} icon={playing ? <Pause size={14} /> : <Play size={14} />}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button size={32} variant="ghost" onClick={onToggleLoop}>
          {loop ? 'Loop on' : 'Loop off'}
        </Button>
        <Button size={32} variant="ghost" onClick={onToggleMute} icon={muted ? <VolumeX size={14} /> : <Volume2 size={14} />}>
          {muted ? 'Unmute' : 'Mute'}
        </Button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {formatTimecode(playheadUs)} / {formatTimecode(moment.endUs)}
        </span>
      </div>

      <MiniTimeline
        moment={moment}
        transcript={transcript}
        playheadUs={playheadUs}
        durationUs={durationUs}
        onSeek={onSeek}
        onRangeChange={onRangeChange}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {formatTimecode(moment.startUs)}–{formatTimecode(moment.endUs)} · {formatDuration(moment.durationUs)}
        </span>
        {moment.userEdited && <Chip variant="info">Edited — score may differ</Chip>}
        {moment.userEdited && (
          <Button size={28} variant="ghost" icon={<RotateCcw size={14} />} onClick={onReset}>
            Reset to AI boundaries
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Button size={28} loading={scoring} onClick={onRescore}>
          Re-score this moment
        </Button>
      </div>

      <TranscriptStrip moment={moment} transcript={transcript} playheadUs={playheadUs} onSeek={onSeek} />
    </div>
  );
}

function MiniTimeline({
  moment,
  transcript,
  playheadUs,
  durationUs,
  onSeek,
  onRangeChange,
}: {
  moment: MomentPayload;
  transcript: TranscriptPayload | null;
  playheadUs: number;
  durationUs: number;
  onSeek: (us: number) => void;
  onRangeChange: (startUs: number, endUs: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<'start' | 'end' | null>(null);

  const sourceDurationUs = transcript?.durationUs ?? durationUs ?? moment.endUs + CONTEXT_US;
  const viewStartUs = Math.max(0, moment.startUs - CONTEXT_US);
  const viewEndUs = Math.min(sourceDurationUs || moment.endUs + CONTEXT_US, moment.endUs + CONTEXT_US);
  const span = Math.max(1, viewEndUs - viewStartUs);
  const pct = (us: number) => ((us - viewStartUs) / span) * 100;

  const words = transcript?.words ?? [];
  const wordMarks = words.filter((word) => word.endUs > viewStartUs && word.startUs < viewEndUs);

  /** Snaps to the nearest word edge inside the range (Alt keeps raw position). */
  const snap = useCallback(
    (us: number, altKey: boolean): number => {
      if (altKey || words.length === 0) return Math.max(0, Math.round(us));
      let best = us;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const word of words) {
        for (const edge of [word.startUs, word.endUs]) {
          const distance = Math.abs(edge - us);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = edge;
          }
        }
      }
      return bestDistance <= 400_000 ? best : Math.max(0, Math.round(us));
    },
    [words]
  );

  const positionFromEvent = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return viewStartUs;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return viewStartUs + ratio * span;
  };

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragging.current) return;
      const us = snap(positionFromEvent(event.clientX), event.altKey);
      if (dragging.current === 'start') onRangeChange(Math.min(us, moment.endUs - 1_000_000), moment.endUs);
      else onRangeChange(moment.startUs, Math.max(us, moment.startUs + 1_000_000));
    };
    const up = () => {
      dragging.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [moment.startUs, moment.endUs, onRangeChange, snap]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        ref={trackRef}
        onClick={(event) => onSeek(snap(positionFromEvent(event.clientX), event.altKey))}
        style={{
          position: 'relative',
          height: 64,
          background: 'var(--surface-panel)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--line-subtle)',
          overflow: 'hidden',
          cursor: 'crosshair',
        }}
      >
        {/* Speech density derived from real word timings — not a synthetic waveform. */}
        {wordMarks.map((word) => {
          const left = pct(word.startUs);
          const width = Math.max(0.15, ((word.endUs - word.startUs) / span) * 100);
          const inRange = word.startUs >= moment.startUs && word.endUs <= moment.endUs;
          return (
            <div
              key={word.id}
              title={word.text}
              style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${width}%`,
                bottom: 8,
                height: `${28 + Math.min(20, word.text.length * 2)}px`,
                background: inRange ? 'var(--brand)' : 'var(--line-default)',
                opacity: inRange ? 0.85 : 0.4,
                borderRadius: 'var(--radius-xs)',
              }}
            />
          );
        })}

        <div
          style={{
            position: 'absolute',
            left: `${pct(moment.startUs)}%`,
            width: `${pct(moment.endUs) - pct(moment.startUs)}%`,
            top: 0,
            bottom: 0,
            border: '1px solid var(--brand)',
            borderTop: 'none',
            borderBottom: 'none',
            pointerEvents: 'none',
          }}
        />

        <Handle leftPct={pct(moment.startUs)} onGrab={() => (dragging.current = 'start')} label="Start" />
        <Handle leftPct={pct(moment.endUs)} onGrab={() => (dragging.current = 'end')} label="End" />

        <div
          style={{
            position: 'absolute',
            left: `${pct(playheadUs)}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: 'var(--text-primary)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        <span>{formatTimecode(viewStartUs)}</span>
        <span>Handles snap to words · hold Alt for a free position</span>
        <span>{formatTimecode(viewEndUs)}</span>
      </div>
    </div>
  );
}

function Handle({ leftPct, onGrab, label }: { leftPct: number; onGrab: () => void; label: string }) {
  return (
    <div
      role="separator"
      aria-label={`${label} handle`}
      onMouseDown={(event) => {
        event.stopPropagation();
        onGrab();
      }}
      style={{
        position: 'absolute',
        left: `calc(${leftPct}% - 5px)`,
        top: 0,
        bottom: 0,
        width: 10,
        cursor: 'ew-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3,
      }}
    >
      <div style={{ width: 3, height: '100%', background: 'var(--brand)', borderRadius: 'var(--radius-pill)' }} />
    </div>
  );
}

function TranscriptStrip({
  moment,
  transcript,
  playheadUs,
  onSeek,
}: {
  moment: MomentPayload;
  transcript: TranscriptPayload | null;
  playheadUs: number;
  onSeek: (us: number) => void;
}) {
  const words = transcript?.words.filter((word) => word.endUs > moment.startUs && word.startUs < moment.endUs) ?? [];

  return (
    <div
      style={{
        maxHeight: 140,
        overflow: 'auto',
        padding: 'var(--space-3)',
        background: 'var(--surface-panel)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--line-subtle)',
        fontSize: 'var(--fs-sm)',
        lineHeight: 'var(--lh-md)',
      }}
    >
      {words.length === 0 && (
        <span style={{ color: 'var(--text-muted)' }}>There are no words in this range.</span>
      )}
      {words.map((word) => {
        const active = playheadUs >= word.startUs && playheadUs < word.endUs;
        return (
          <button
            key={word.id}
            type="button"
            onClick={() => onSeek(word.startUs)}
            style={{
              background: active ? 'var(--brand-tint-strong)' : 'transparent',
              color: active ? 'var(--text-brand)' : 'var(--text-secondary)',
              border: 'none',
              padding: '0 2px',
              marginRight: 2,
              borderRadius: 'var(--radius-xs)',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {word.text}
          </button>
        );
      })}
    </div>
  );
}

function currentCaption(
  words: Array<{ text: string; startUs: number; endUs: number }>,
  playheadUs: number
): string | null {
  const index = words.findIndex((word) => playheadUs >= word.startUs && playheadUs < word.endUs);
  if (index < 0) return null;
  // A short line around the current word, like the caption style would break it.
  const start = Math.max(0, index - 2);
  return words
    .slice(start, Math.min(words.length, index + 3))
    .map((word) => word.text)
    .join(' ');
}

function aspectRatioCss(aspect: string): string {
  switch (aspect) {
    case '16:9':
      return '16 / 9';
    case '1:1':
      return '1 / 1';
    case '4:5':
      return '4 / 5';
    case '4:3':
      return '4 / 3';
    case '21:9':
      return '21 / 9';
    default:
      return '9 / 16';
  }
}
