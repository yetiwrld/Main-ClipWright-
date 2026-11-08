import React from 'react';
import { Film, Plus, Power, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Input, Select, Slider } from '@clipwright/design-system';
import {
  formatTimecode,
  quantizeUs,
  type TimelineState,
} from '@clipwright/timeline-engine';
import { EFFECTS, effectDefinition } from '@clipwright/compositor';
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

      {/*
        Transitions (SPEC 12 §4) belong next to Opacity because that is where a
        user looks for "how this clip comes in". The control is a mode picker
        rather than a list of saved transitions because only one transition can
        enter a clip, and its geometry is implied: it joins this clip to whatever
        sits immediately before it on the track.
      */}
      <Field label="Transition in">
        <Select
          value={item.transitionIn?.type ?? 'none'}
          ariaLabel="Transition entering this clip"
          // A transition joins two clips, so a clip that is first on its track has
          // nothing to join to. Disabling beats accepting the click and doing
          // nothing, which reads as a broken control.
          disabled={!previousClipOnTrack(state, item) && !item.transitionIn}
          options={TRANSITION_OPTIONS}
          onChange={(value) => {
            const neighbour = previousClipOnTrack(state, item);
            if (value === 'none') {
              if (item.transitionIn) timeline.removeTransition(item.id);
              return;
            }
            if (!neighbour) return;
            if (item.transitionIn) {
              timeline.updateTransition(item.id, { type: value as TransitionType });
            } else {
              // Half a second is short enough to keep the clips recognisable and
              // long enough to see; the duration control below adjusts it.
              timeline.addTransition(
                item.trackId,
                neighbour.id,
                item.id,
                value as TransitionType,
                500_000,
                'center',
              );
            }
          }}
        />
      </Field>

      {item.transitionIn && (
        <Field label="Transition length">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <Slider
              value={Math.round(item.transitionIn.durationUs / 10_000)}
              min={4}
              max={200}
              step={1}
              ariaLabel="Transition length in tens of milliseconds"
              formatValue={(value) => `${(value / 100).toFixed(2)} s`}
              onChange={(value) =>
                timeline.updateTransition(item.id, { durationUs: Math.round(value * 10_000) })
              }
            />
            <Select
              value={item.transitionIn.alignment}
              ariaLabel="Where the transition sits relative to the cut"
              options={ALIGNMENT_OPTIONS}
              onChange={(value) =>
                timeline.updateTransition(item.id, {
                  alignment: value as 'center' | 'start' | 'end',
                })
              }
            />
          </div>
        </Field>
      )}

      <Field label="Opacity">
        <Slider
          value={Math.round(item.opacity * 100)}
          min={0}
          max={100}
          step={1}
          ariaLabel="Clip opacity as a percentage"
          formatValue={(value) => `${value}%`}
          onChange={(value) => timeline.setItemProperties([item.id], { opacity: value / 100 })}
        />
      </Field>

      <Field label="Volume">
        <Slider
          value={item.volumeDb}
          min={-60}
          max={12}
          step={1}
          ariaLabel="Clip volume in decibels"
          formatValue={(value) => (value <= -60 ? 'Silent' : `${value} dB`)}
          onChange={(value) => timeline.setItemProperties([item.id], { volumeDb: value })}
        />
      </Field>

      <Field label="Pan">
        <Slider
          value={item.pan}
          min={-100}
          max={100}
          step={1}
          ariaLabel="Clip pan"
          formatValue={(value) =>
            value === 0 ? 'Centre' : `${Math.abs(value)}% ${value < 0 ? 'left' : 'right'}`
          }
          onChange={(value) => timeline.setItemProperties([item.id], { pan: value })}
        />
      </Field>

      <Field label="Speed">
        <Slider
          value={item.speed}
          min={0.25}
          max={4}
          step={0.05}
          ariaLabel="Playback speed"
          formatValue={(value) => `${value.toFixed(2)}×`}
          onChange={(value) => timeline.setItemProperties([item.id], { speed: value })}
        />
      </Field>

      {/*
        Crop and transform are numeric fields rather than canvas drag handles. The
        canvas interaction is the better tool and it is not built yet; a field that
        works is more honest than a handle that does not exist, and both go through
        the same command so the drag can be added without changing the model.
      */}
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Crop (% of source)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-1)' }}>
        {(['left', 'top', 'right', 'bottom'] as const).map((edge) => (
          <Field key={edge} label={edge[0]!.toUpperCase() + edge.slice(1)}>
            <Input
              type="number"
              min={0}
              max={95}
              value={Math.round(item.crop[edge] * 100)}
              aria-label={`Crop ${edge}`}
              onChange={(event) => {
                // `Number('')` is 0, so clearing the field would silently crop the
                // clip to nothing. An empty field means "no edit yet".
                if (event.target.value.trim() === '') return;
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent)) return;
                timeline.setItemProperties([item.id], { crop: { [edge]: Math.min(95, Math.max(0, percent)) / 100 } });
              }}
            />
          </Field>
        ))}
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Transform</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-1)' }}>
        <Field label="Scale">
          <Input
            type="number"
            min={10}
            max={400}
            value={Math.round(item.transform.scaleX * 100)}
            aria-label="Scale as a percentage"
            onChange={(event) => {
              if (event.target.value.trim() === '') return;
              const percent = Number(event.target.value);
              if (!Number.isFinite(percent)) return;
              const scale = Math.min(4, Math.max(0.1, percent / 100));
              timeline.setItemProperties([item.id], { transform: { scaleX: scale, scaleY: scale } });
            }}
          />
        </Field>
        <Field label="Rotation">
          <Input
            type="number"
            min={-180}
            max={180}
            value={Math.round(item.transform.rotation)}
            aria-label="Rotation in degrees"
            onChange={(event) => {
              if (event.target.value.trim() === '') return;
              const degrees = Number(event.target.value);
              if (!Number.isFinite(degrees)) return;
              timeline.setItemProperties([item.id], {
                transform: { rotation: Math.min(180, Math.max(-180, degrees)) },
              });
            }}
          />
        </Field>
      </div>

      {/* Effects section (SPEC 09 §17) */}
      {(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Effects</span>
          {/*
            Adding an effect was impossible before this control: the inspector could
            list, toggle and remove chain entries but the only way to create one was
            to call the command. The menu is generated from the effect catalogue, so a
            new effect appears here without touching this file.
          */}
          <Select
            value=""
            ariaLabel="Add an effect to this clip"
            placeholder="Add effect…"
            options={EFFECTS.filter(
              (definition) => !item.effects?.some((e) => e.effectId === definition.id),
            ).map((definition) => ({ value: definition.id, label: definition.name }))}
            onChange={(value) => {
              if (value) timeline.applyEffect(item.id, value);
            }}
          />
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
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-primary)' }}>
                  {effectDefinition(effect.effectId)?.name ?? effect.effectId}
                </span>
                {/*
                  Parameters are generated from the catalogue's ParamSpecs (§3.1), so
                  the ranges and defaults here cannot drift from the ones the renderer
                  clamps to.
                */}
                {(effectDefinition(effect.effectId)?.params ?? []).map((spec) => {
                  const current =
                    typeof effect.params[spec.id] === 'number'
                      ? (effect.params[spec.id] as number)
                      : Number(spec.default);
                  // A slider works in integers, so a float range has to be scaled
                  // into positions. Ranges up to 10 (brightness, exposure, contrast,
                  // radius) get hundredths, which is finer than anyone can drag;
                  // wider ranges (blur's 0–100) get whole units.
                  const step = spec.max - spec.min <= 10 ? 0.05 : 1;
                  const scale = 1 / step;
                  return (
                    <Slider
                      key={spec.id}
                      value={Math.round(current * scale)}
                      min={Math.round(spec.min * scale)}
                      max={Math.round(spec.max * scale)}
                      step={1}
                      ariaLabel={`${effectDefinition(effect.effectId)?.name} ${spec.label}`}
                      formatValue={(value) => String(Number((value / scale).toFixed(2)))}
                      onChange={(value) =>
                        timeline.setEffectParams(item.id, effect.effectId, {
                          [spec.id]: Number((value / scale).toFixed(3)),
                        })
                      }
                    />
                  );
                })}
              </div>
              <IconButton
                label={`Remove ${effectDefinition(effect.effectId)?.name ?? effect.effectId}`}
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

type TransitionType =
  | 'crossfade'
  | 'dissolve'
  | 'fade-black'
  | 'dip-color'
  | 'wipe'
  | 'slide'
  | 'zoom';

/**
 * The transitions the inspector offers.
 *
 * Labels describe what the user sees rather than the spec's internal name, because
 * "dissolve" and "crossfade" are the pair most easily confused: one fades the new
 * clip in against the old, the other fades the old one *out* as well.
 */
const TRANSITION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'crossfade', label: 'Crossfade — both clips blend' },
  { value: 'dissolve', label: 'Dissolve — new clip fades in over the old' },
  { value: 'fade-black', label: 'Fade through black' },
  { value: 'dip-color', label: 'Dip to colour' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
];

const ALIGNMENT_OPTIONS = [
  { value: 'center', label: 'Centred on the cut' },
  { value: 'start', label: 'Before the cut' },
  { value: 'end', label: 'After the cut' },
];

/**
 * The clip immediately before `item` on its own track.
 *
 * A transition joins two adjacent clips, so the inspector has to find the other
 * half itself — the user picks one clip and the UI figures out what it is joining
 * to. `null` when the clip is first on its track, which is also the case where the
 * control is disabled: there is nothing to transition *from*.
 */
function previousClipOnTrack(
  state: TimelineState,
  item: TimelineState['items'][string],
): TimelineState['items'][string] | null {
  const before = Object.values(state.items)
    .filter((other) => other.trackId === item.trackId && other.id !== item.id)
    .filter((other) => other.startUs < item.startUs)
    .sort((a, b) => b.startUs - a.startUs);
  return before[0] ?? null;
}
