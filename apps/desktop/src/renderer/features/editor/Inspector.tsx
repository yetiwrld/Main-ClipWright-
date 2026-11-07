import React from 'react';
import { Film, Plus, Power, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Input, Slider } from '@clipwright/design-system';
import {
  formatTimecode,
  quantizeUs,
  type TimelineState,
} from '@clipwright/timeline-engine';
import type { TimelineApi } from './use-timeline.js';
import { playheadStore } from './playhead-store.js';

export interface MediaAsset {
  id: string;
  originalName: string;
  kind: 'video' | 'audio' | 'image';
  status: 'ok' | 'missing' | 'changed';
  sizeBytes: number;
  info?: { durationUs?: number };
}

/**
 * Left panel media library and the right-hand inspector (SPEC 08 §5, §7). Every
 * property edit goes through an engine command, never a direct mutation.
 */
export function MediaLibrary({
  media,
  timeline,
  loading,
  error,
}: {
  media: MediaAsset[];
  timeline: TimelineApi;
  loading: boolean;
  error: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-2)', minHeight: 0, overflow: 'auto' }}>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>
        Media library
      </div>
      {loading && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>Loading media…</div>}
      {error && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--error)' }}>{error}</div>}
      {!loading && !error && media.length === 0 && (
        <EmptyState
          icon={<Film size={20} />}
          title="Nothing imported yet"
          explanation="Import a video from the start screen and it appears here."
        />
      )}
      {media.map((asset) => {
        const durationUs = asset.info?.durationUs ?? 0;
        return (
          <Card
            key={asset.id}
            draggable={asset.status === 'ok'}
            onDragStart={(event) => {
              event.dataTransfer.setData(
                'application/x-clipwright-media',
                JSON.stringify({
                  mediaId: asset.id,
                  label: asset.originalName,
                  type: asset.kind,
                  durationUs: durationUs || 3_000_000,
                  sourceDurationUs: durationUs || 3_000_000,
                }),
              );
              event.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={asset.originalName}
                >
                  {asset.originalName}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                  {asset.kind} · {durationUs ? formatTimecode(durationUs, 30) : 'unknown length'}
                  {asset.status !== 'ok' ? ` · ${asset.status}` : ''}
                </div>
              </div>
              <Button
                size={28}
                variant="secondary"
                icon={<Plus size={12} />}
                disabled={asset.status !== 'ok'}
                onClick={() =>
                  timeline.placeMedia({
                    mediaId: asset.id,
                    label: asset.originalName,
                    type: asset.kind,
                    durationUs: durationUs || 3_000_000,
                    sourceDurationUs: durationUs || 3_000_000,
                    startUs: quantizeUs(playheadStore.get(), timeline.fps),
                  })
                }
              >
                Add
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function ItemInspector({ state, timeline }: { state: TimelineState; timeline: TimelineApi }) {
  const selected = timeline.selection.map((id) => state.items[id]).filter(Boolean);
  if (selected.length === 0) {
    return (
      <div style={{ padding: 'var(--space-2)' }}>
        <EmptyState
          icon={<Film size={20} />}
          title="Nothing selected"
          explanation="Select a clip on the timeline to edit its timing, volume and framing."
        />
      </div>
    );
  }
  if (selected.length > 1) {
    return (
      <div style={{ padding: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
        {selected.length} clips selected. Timing edits apply one clip at a time.
      </div>
    );
  }

  const item = selected[0]!;
  const fps = timeline.fps;
  const track = state.tracks.find((candidate) => candidate.id === item.trackId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-2)', overflow: 'auto' }}>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)', fontWeight: 600 }}>{item.label}</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {track?.name} · {item.type}
      </div>

      <Field label="Start">
        <Input
          value={formatTimecode(item.startUs, fps)}
          onChange={(event) => {
            const parts = event.target.value.split(':').map(Number);
            if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return;
            const [h, m, s, f] = parts;
            const us = quantizeUs((h! * 3600 + m! * 60 + s!) * 1_000_000 + (f! / fps) * 1_000_000, fps);
            timeline.move([{ itemId: item.id, startUs: us }]);
          }}
          aria-label="Clip start timecode"
        />
      </Field>

      <Field label="Duration">
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          <Button
            size={28}
            variant="secondary"
            onClick={() => timeline.trim(item.id, 'end', item.startUs + item.durationUs - 1_000_000 / fps)}
          >
            −1 frame
          </Button>
          <Button
            size={28}
            variant="secondary"
            onClick={() => timeline.trim(item.id, 'end', item.startUs + item.durationUs + 1_000_000 / fps)}
          >
            +1 frame
          </Button>
        </div>
      </Field>

      <Field label="Volume">
        <Slider
          value={item.volumeDb}
          min={-60}
          max={12}
          step={1}
          ariaLabel="Clip volume in decibels"
          formatValue={(value) => `${value} dB`}
          onChange={() => undefined}
          disabled
        />
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Volume edits arrive with the audio tools; the value is stored on the clip and used for preview muting.
        </div>
      </Field>

      {/* Effects section (SPEC 09 §17) */}
      {(item.effects && item.effects.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Effects</span>
          {item.effects.map((effect) => (
            <div
              key={effect.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-raised)',
                opacity: effect.enabled ? 1 : 0.5,
              }}
            >
              <IconButton
                label={effect.enabled ? 'Disable effect' : 'Enable effect'}
                size={28}
                icon={<Power size={12} />}
                onClick={() => timeline.toggleEffectEnabled(item.id, effect.effectId)}
              />
              <span style={{ flex: 1, fontSize: 'var(--fs-xs)', color: 'var(--text-primary)' }}>
                {effect.effectId}
              </span>
              <IconButton
                label="Remove effect"
                size={28}
                icon={<Trash2 size={12} />}
                onClick={() => timeline.removeEffect(item.id, effect.effectId)}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        Source in {formatTimecode(item.sourceInUs, fps)}
        {item.speed !== 1 ? ` · ${item.speed}×` : ''}
        {track?.locked ? ' · track locked' : ''}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  );
}
