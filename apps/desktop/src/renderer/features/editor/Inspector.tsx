import React from 'react';
import { ChevronDown, ChevronUp, Film, Plus, Power, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Input, Select, Slider } from '@clipwright/design-system';
import {
  formatTimecode,
  quantizeUs,
  type TimelineState,
} from '@clipwright/timeline-engine';
import {
  EFFECTS,
  ICON_DEFAULT_STROKE_WIDTH,
  SHAPE_KINDS,
  effectDefinition,
  shapeKindLabel,
} from '@clipwright/compositor';
import type { TimelineApi } from './use-timeline.js';
import { playheadStore, usePlayheadUs } from './playhead-store.js';
import {
  adjacentKeyTime,
  displayedScale,
  isUniformScale,
  keyframeAt,
  keyframeWriteRefusal,
  planPairedEdit,
  planPropertyEdit,
} from './keyframe-controls.js';

export interface MediaAsset {
  id: string;
  originalName: string;
  kind: 'video' | 'audio' | 'image';
  status: 'ok' | 'missing' | 'changed';
  sizeBytes: number;
  /** The preview proxy, when one exists (SPEC 04 §6.3). See `preview-quality.ts`. */
  proxyPath?: string | null;
  /**
   * Whether the pipeline intends to make one. Read by `EditorPage` to decide whether to watch the
   * job list at all; a file that needs no proxy is never going to produce a `proxy` job.
   */
  needsProxy?: boolean;
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

/**
 * Apply a property edit with §2.4's auto-keyframing rule.
 *
 * The playhead is read at call time rather than passed in because the slider's
 * `onChange` closure is created before the user moves the playhead; reading the
 * store here means the key lands where the playhead actually is, which is what §2.4
 * describes.
 */
function applyAnimatable(
  timeline: TimelineApi,
  item: TimelineState['items'][string],
  path: string,
  value: number,
  editStatic: () => void,
): void {
  const plan = planPropertyEdit(
    item.keyframes?.[path],
    item,
    quantizeUs(playheadStore.get(), timeline.fps),
    value,
  );
  if (plan.kind === 'insert-key') {
    // Insert first, then update, so a brand-new key ends up holding exactly the
    // value the user dragged to — `addKeyframe` records the value it is given.
    timeline.addKeyframe(item.id, path, plan.timeUs, plan.value);
    return;
  }
  if (plan.kind === 'update-key') {
    timeline.updateKeyframe(item.id, path, plan.timeUs, { value: plan.value });
    return;
  }
  editStatic();
}

/**
 * Apply an edit to two axes that are shown as one control (the uniform Scale field).
 *
 * Both axes are written together whatever the plan is — static or keyed — so the
 * picture cannot stretch. That is the whole reason the two axes share a row.
 */
function applyAnimatablePair(
  timeline: TimelineApi,
  item: TimelineState['items'][string],
  paths: readonly [string, string],
  value: number,
  editStatic: () => void,
): void {
  const plan = planPairedEdit(
    paths.map((path) => item.keyframes?.[path]),
    item,
    quantizeUs(playheadStore.get(), timeline.fps),
    value,
  );
  if (plan.kind === 'insert-key') {
    for (const path of paths) timeline.addKeyframe(item.id, path, plan.timeUs, plan.value);
    return;
  }
  if (plan.kind === 'update-key') {
    for (const path of paths) timeline.updateKeyframe(item.id, path, plan.timeUs, { value: plan.value });
    return;
  }
  editStatic();
}

/**
 * A property row with its keyframe diamond and ◀ ▶ jumpers (SPEC 12 §2.4).
 *
 * A `Field` is a `<label>`, so a button placed inside one would forward its clicks
 * to the wrapped input — which is why this row wraps the label in a flex row with
 * the controls outside it, rather than nesting them.
 *
 * The diamond records the property's *current* value when it creates a key, so
 * adding one never changes the picture (§2.4). It is drawn filled when a key sits
 * exactly on the playhead, and half-filled when the property is animated but the
 * playhead is between keys.
 */
function KeyframeRow({
  label,
  accessibleName,
  path,
  alsoPaths,
  value,
  item,
  timeline,
  children,
}: {
  label: string;
  /**
   * Longer name for the buttons' accessible names, when the short display label
   * would be ambiguous. "Left" is fine under a Crop heading and useless in a
   * screen reader's list of controls.
   */
  accessibleName?: string;
  path: string;
  /**
   * Additional paths written alongside `path`, for a control that governs several
   * properties at once. The uniform Scale field is the only one: both axes share it,
   * so the diamond has the same obligation the slider does — keying one half of a
   * pair the user set together would stretch the clip.
   */
  alsoPaths?: readonly string[];
  /** The property's current value, recorded when a key is created. */
  value: number;
  item: TimelineState['items'][string];
  timeline: TimelineApi;
  children: React.ReactNode;
}) {
  const playheadUs = usePlayheadUs();
  const keys = item.keyframes?.[path];
  const animated = (keys?.length ?? 0) > 0;
  const refusal = keyframeWriteRefusal(item, playheadUs);
  const local = playheadUs - item.startUs;
  const name = accessibleName ?? label;

  const previous = adjacentKeyTime(keys, local, 'previous');
  const next = adjacentKeyTime(keys, local, 'next');

  // Every path this row governs, so a shared control never writes half of itself.
  const paths = [path, ...(alsoPaths ?? [])];
  const onKey = paths.some((candidate) => keyframeAt(item.keyframes?.[candidate], local) !== undefined);
  const toggle = () => {
    if (refusal) return;
    if (onKey) {
      for (const candidate of paths) timeline.removeKeyframe(item.id, candidate, local);
      return;
    }
    for (const candidate of paths) timeline.addKeyframe(item.id, candidate, local, value);
  };

  const jump = (target: number | null) => {
    if (target === null) return;
    playheadStore.set(item.startUs + target);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-1)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Field label={label}>{children}</Field>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingBottom: 2 }}>
        <button
          type="button"
          aria-label={`Previous ${name} keyframe`}
          disabled={previous === null}
          onClick={() => jump(previous)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: previous === null ? 'default' : 'pointer',
            color: previous === null ? 'var(--text-disabled)' : 'var(--text-secondary)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 1,
          }}
        >
          ◀
        </button>
        <button
          type="button"
          aria-label={`Keyframe ${name} at the playhead`}
          aria-pressed={onKey}
          // The tooltip is the entire user-facing half of the "blocked outside the
          // clip" rule, so it carries the reason rather than being a generic label.
          title={refusal ?? (onKey ? `Remove the ${name} keyframe here` : `Add a ${name} keyframe here`)}
          disabled={refusal !== null}
          onClick={toggle}
          style={{
            width: 10,
            height: 10,
            padding: 0,
            margin: '0 2px',
            // §2.5's diamond: a rotated square, brand-filled when selected.
            transform: 'rotate(45deg)',
            background: onKey ? 'var(--brand)' : animated ? 'var(--text-muted)' : 'transparent',
            border: `1px solid ${animated ? 'var(--brand)' : 'var(--line-default)'}`,
            cursor: refusal ? 'not-allowed' : 'pointer',
            opacity: refusal ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          aria-label={`Next ${name} keyframe`}
          disabled={next === null}
          onClick={() => jump(next)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: next === null ? 'default' : 'pointer',
            color: next === null ? 'var(--text-disabled)' : 'var(--text-secondary)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 1,
          }}
        >
          ▶
        </button>
      </div>
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
            {/*
              Only the types that actually have a direction get the control. A
              crossfade with a disabled direction picker would suggest the setting
              exists and is merely unavailable, which is worse than not showing it.
            */}
            {(() => {
              const options = directionOptionsFor(item.transitionIn.type);
              if (!options) return null;
              return (
                <Select
                  value={String(item.transitionIn.params?.direction ?? 'left')}
                  ariaLabel="Direction of the transition"
                  options={options}
                  onChange={(value) =>
                    timeline.updateTransition(item.id, { params: { direction: value } })
                  }
                />
              );
            })()}
            {(() => {
              const options = modeOptionsFor(item.transitionIn.type);
              if (!options) return null;
              return (
                <Select
                  // `push` is what an unset mode means, so the picker shows that
                  // rather than an empty value the engine would silently treat as
                  // push anyway.
                  value={String(item.transitionIn.params?.mode ?? 'push')}
                  ariaLabel="Motion of the slide"
                  options={options}
                  onChange={(value) =>
                    timeline.updateTransition(item.id, { params: { mode: value } })
                  }
                />
              );
            })()}
          </div>
        </Field>
      )}

      {/*
        Shapes and icons (SPEC 11 §12). Neither had a row here: a shape's kind and an
        icon's stroke width could be chosen once, when the item was created, and never
        changed again. `docs/limitations.md` recorded that as the gap it was, and this is
        the row that closes it.

        The section is one or the other, never both. A shape has a `shapeKind`, an icon has
        an `iconName`, and the schema keeps them exclusive — so the inspector asks which
        sort of item it is holding rather than showing two controls and letting one do
        nothing.
      */}
      {item.iconName !== undefined ? (
        <Field label="Icon">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              {item.label ?? item.iconName}
            </div>
            <Slider
              value={item.iconStrokeWidth ?? ICON_DEFAULT_STROKE_WIDTH}
              min={0.5}
              max={4}
              step={0.5}
              ariaLabel="Icon stroke width"
              formatValue={(value) => `${value}`}
              onChange={(value) =>
                timeline.setItemProperties([item.id], { iconStrokeWidth: value })
              }
            />
          </div>
        </Field>
      ) : item.shapeKind !== undefined ? (
        <Field label="Shape">
          <Select
            value={item.shapeKind}
            ariaLabel="Shape kind"
            options={SHAPE_KINDS.map((kind) => ({ value: kind, label: shapeKindLabel(kind) }))}
            onChange={(value) =>
              timeline.setItemProperties([item.id], {
                // Narrowed rather than cast: the options come from `SHAPE_KINDS`, so a
                // value outside it cannot reach here, and the compiler should say so if
                // the list ever changes shape.
                shapeKind: value as NonNullable<typeof item.shapeKind>,
              })
            }
          />
        </Field>
      ) : null}

      <KeyframeRow label="Opacity" path="opacity" value={item.opacity} item={item} timeline={timeline}>
        <Slider
          value={Math.round(item.opacity * 100)}
          min={0}
          max={100}
          step={1}
          ariaLabel="Clip opacity as a percentage"
          formatValue={(value) => `${value}%`}
          onChange={(value) =>
            /*
              Auto-keyframing (§2.4): with existing keys the change becomes a keyframe
              at the playhead; with none it stays a static edit, so a slider drag
              never starts an animation the user did not ask for.
            */
            applyAnimatable(timeline, item, 'opacity', value / 100, () =>
              timeline.setItemProperties([item.id], { opacity: value / 100 }),
            )
          }
        />
      </KeyframeRow>

      <KeyframeRow label="Volume" path="volumeDb" value={item.volumeDb} item={item} timeline={timeline}>
        <Slider
          value={item.volumeDb}
          min={-60}
          max={12}
          step={1}
          ariaLabel="Clip volume in decibels"
          formatValue={(value) => (value <= -60 ? 'Silent' : `${value} dB`)}
          onChange={(value) =>
            applyAnimatable(timeline, item, 'volumeDb', value, () =>
              timeline.setItemProperties([item.id], { volumeDb: value }),
            )
          }
        />
      </KeyframeRow>

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
          <KeyframeRow
            key={edge}
            label={edge[0]!.toUpperCase() + edge.slice(1)}
            accessibleName={`Crop ${edge}`}
            path={`crop.${edge}`}
            value={item.crop[edge]}
            item={item}
            timeline={timeline}
          >
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
                // The schema floor (0) and ceiling (0.95) are the real limits: a crop
                // that met itself edge to edge would leave no picture at all.
                const fraction = Math.min(95, Math.max(0, percent)) / 100;
                applyAnimatable(timeline, item, `crop.${edge}`, fraction, () =>
                  timeline.setItemProperties([item.id], { crop: { [edge]: fraction } }),
                );
              }}
            />
          </KeyframeRow>
        ))}
      </div>
      {/*
        The corner radius (SPEC 10 §8.6). A percentage of the cropped window's short side, which
        is the unit the schema stores and the canvas slider speaks, so a value means the same
        shape at any preview zoom. Capped at 50: past that the corners are not rounder, they are
        elliptical, and every renderer draws those differently.
      */}
      <KeyframeRow
        label="Rounded corners (% of short side)"
        accessibleName="Rounded corners"
        path="crop.radius"
        value={item.crop.radius}
        item={item}
        timeline={timeline}
      >
        <Input
          type="number"
          min={0}
          max={50}
          value={Math.round((item.crop.radius ?? 0) * 100)}
          aria-label="Crop radius"
          onChange={(event) => {
            if (event.target.value.trim() === '') return;
            const percent = Number(event.target.value);
            if (!Number.isFinite(percent)) return;
            const fraction = Math.min(50, Math.max(0, percent)) / 100;
            applyAnimatable(timeline, item, 'crop.radius', fraction, () =>
              timeline.setItemProperties([item.id], { crop: { radius: fraction } }),
            );
          }}
        />
      </KeyframeRow>

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Transform</div>
      {/*
        A single Scale field is only honest for a uniformly-scaled clip. When the two
        axes differ it is replaced by one field per axis, so the sidebar never shows
        one axis's value while the picture uses both.
      */}
      {isUniformScale(item.transform) ? (
        <KeyframeRow
          label="Scale"
          path="transform.scaleX"
          alsoPaths={['transform.scaleY']}
          value={displayedScale(item.transform)}
          item={item}
          timeline={timeline}
        >
          <Input
            type="number"
            min={10}
            max={400}
            value={Math.round(displayedScale(item.transform) * 100)}
            aria-label="Scale as a percentage"
            onChange={(event) => {
              if (event.target.value.trim() === '') return;
              const percent = Number(event.target.value);
              if (!Number.isFinite(percent)) return;
              const scale = Math.min(4, Math.max(0.1, percent / 100));
              // Both axes move together here, so the legacy field must be retired at
              // the same time: leaving it set would let it win again once the axes
              // returned to 1.
              applyAnimatablePair(timeline, item, ['transform.scaleX', 'transform.scaleY'], scale, () =>
                timeline.setItemProperties([item.id], {
                  transform: { scaleX: scale, scaleY: scale, scale: 1 },
                }),
              );
            }}
          />
        </KeyframeRow>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-1)' }}>
          <KeyframeRow
            label="Scale X"
            path="transform.scaleX"
            value={item.transform.scaleX}
            item={item}
            timeline={timeline}
          >
            <Input
              type="number"
              min={10}
              max={400}
              value={Math.round(item.transform.scaleX * 100)}
              aria-label="Horizontal scale as a percentage"
              onChange={(event) => {
                if (event.target.value.trim() === '') return;
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent)) return;
                const scale = Math.min(4, Math.max(0.1, percent / 100));
                applyAnimatable(timeline, item, 'transform.scaleX', scale, () =>
                  timeline.setItemProperties([item.id], { transform: { scaleX: scale } }),
                );
              }}
            />
          </KeyframeRow>
          <KeyframeRow
            label="Scale Y"
            path="transform.scaleY"
            value={item.transform.scaleY}
            item={item}
            timeline={timeline}
          >
            <Input
              type="number"
              min={10}
              max={400}
              value={Math.round(item.transform.scaleY * 100)}
              aria-label="Vertical scale as a percentage"
              onChange={(event) => {
                if (event.target.value.trim() === '') return;
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent)) return;
                const scale = Math.min(4, Math.max(0.1, percent / 100));
                applyAnimatable(timeline, item, 'transform.scaleY', scale, () =>
                  timeline.setItemProperties([item.id], { transform: { scaleY: scale } }),
                );
              }}
            />
          </KeyframeRow>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-1)' }}>
        {(['x', 'y'] as const).map((axis) => (
          <KeyframeRow
            key={axis}
            label={axis === 'x' ? 'Position X' : 'Position Y'}
            path={`transform.${axis}`}
            value={item.transform[axis]}
            item={item}
            timeline={timeline}
          >
            <Input
              type="number"
              min={-100}
              max={100}
              value={Math.round(item.transform[axis] * 100)}
              // A percentage of the canvas side: the stored value is a fraction so it
              // means the same thing at proxy size and at export size, and showing it
              // raw would put a range of −1…1 in front of the user.
              aria-label={`${axis === 'x' ? 'Horizontal' : 'Vertical'} position as a percentage of the canvas`}
              onChange={(event) => {
                if (event.target.value.trim() === '') return;
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent)) return;
                const fraction = Math.min(1, Math.max(-1, percent / 100));
                applyAnimatable(timeline, item, `transform.${axis}`, fraction, () =>
                  timeline.setItemProperties([item.id], { transform: { [axis]: fraction } }),
                );
              }}
            />
          </KeyframeRow>
        ))}
      </div>

      {/*
        The anchor grid (SPEC 10 §4, §8.2). `transform.anchorX/anchorY` are the pivot
        the picture rotates about, as a fraction of the picture — 0.5,0.5 is the
        middle and 0,0 is its top-left corner. Dragging the crosshair on the canvas is
        the nicer control and is not built yet; this field pair is what makes the
        property reachable at all, and the same command backs both.
      */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-1)' }}>
        {(['anchorX', 'anchorY'] as const).map((axis) => (
          <KeyframeRow
            key={axis}
            label={axis === 'anchorX' ? 'Anchor X' : 'Anchor Y'}
            path={`transform.${axis}`}
            value={item.transform[axis]}
            item={item}
            timeline={timeline}
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={Math.round(item.transform[axis] * 100)}
              aria-label={`${axis === 'anchorX' ? 'Horizontal' : 'Vertical'} anchor as a percentage of the picture`}
              onChange={(event) => {
                if (event.target.value.trim() === '') return;
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent)) return;
                // 0–1 of the picture: 0 is the top/left edge, 100 the bottom/right.
                const fraction = Math.min(1, Math.max(0, percent / 100));
                applyAnimatable(timeline, item, `transform.${axis}`, fraction, () =>
                  timeline.setItemProperties([item.id], { transform: { [axis]: fraction } }),
                );
              }}
            />
          </KeyframeRow>
        ))}
      </div>

      <KeyframeRow
        label="Rotation"
        path="transform.rotation"
        value={item.transform.rotation}
        item={item}
        timeline={timeline}
      >
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
            const clamped = Math.min(180, Math.max(-180, degrees));
            applyAnimatable(timeline, item, 'transform.rotation', clamped, () =>
              timeline.setItemProperties([item.id], { transform: { rotation: clamped } }),
            );
          }}
        />
      </KeyframeRow>

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
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <Button
              size={28}
              variant="secondary"
              onClick={() => timeline.copyEffects(item.id)}
              disabled={!item.effects || item.effects.length === 0}
            >
              Copy effects
            </Button>
            <Button
              size={28}
              variant="secondary"
              onClick={() => timeline.pasteEffects(item.id)}
              // Disabled rather than silent: pasting with nothing copied would be a
              // no-op the user cannot distinguish from a broken button.
              disabled={timeline.effectClipboardSize === 0}
            >
              Paste effects
            </Button>
          </div>

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
              {/*
                Chain order is user-controlled (§3.1) and the acceptance list
                requires it to be reorderable. Two arrows rather than drag-and-drop:
                the inspector is a narrow column and a drag target a few pixels tall
                is worse than a button for the common case of nudging one effect past
                its neighbour.
              */}
              <IconButton
                label={`Move ${effectDefinition(effect.effectId)?.name ?? effect.effectId} earlier`}
                size={28}
                icon={<ChevronUp size={12} />}
                onClick={() =>
                  timeline.moveEffect(item.id, effect.effectId, (item.effects ?? []).indexOf(effect) - 1)
                }
              />
              <IconButton
                label={`Move ${effectDefinition(effect.effectId)?.name ?? effect.effectId} later`}
                size={28}
                icon={<ChevronDown size={12} />}
                onClick={() =>
                  timeline.moveEffect(item.id, effect.effectId, (item.effects ?? []).indexOf(effect) + 1)
                }
              />
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
  // A dissolve switches whole pixels between the clips through a noise field, so
  // it reads as grain rather than as a fade. Calling it "fades in over the old"
  // described the fade it used to be — the two types were indistinguishable.
  { value: 'dissolve', label: 'Dissolve — grainy, pixel-by-pixel switch' },
  { value: 'fade-black', label: 'Fade through black' },
  { value: 'dip-color', label: 'Dip to colour' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
];

/*
  Two lists, not one, because the same word means opposite things in the two
  transitions (SPEC 12 §4.2): a wipe's direction is where the reveal *starts*, and a
  slide's is which way the picture *travels*. One shared list would label one of them
  wrongly — and an earlier version did exactly that, disagreeing with the engine.
*/
const WIPE_DIRECTION_OPTIONS = [
  { value: 'left', label: 'Revealed from the left' },
  { value: 'right', label: 'Revealed from the right' },
  { value: 'up', label: 'Revealed from the top' },
  { value: 'down', label: 'Revealed from the bottom' },
  { value: 'diagonal-up', label: 'Revealed diagonally ↗' },
  { value: 'diagonal-down', label: 'Revealed diagonally ↘' },
];

const SLIDE_DIRECTION_OPTIONS = [
  { value: 'left', label: 'Travels left' },
  { value: 'right', label: 'Travels right' },
  { value: 'up', label: 'Travels up' },
  { value: 'down', label: 'Travels down' },
];

/*
  `mode` is the slide's second axis and it is not a synonym for direction: it says
  *who moves*. Push travels both pictures as one strip, cover slides the incoming
  clip over a still outgoing one, and reveal slides the outgoing clip away from a
  still incoming one — the last is the one people reach for when they want the
  outgoing shot to clear off the screen.
*/
const SLIDE_MODE_OPTIONS = [
  { value: 'push', label: 'Both pictures travel' },
  { value: 'cover', label: 'Incoming slides over the outgoing' },
  { value: 'reveal', label: 'Outgoing slides away' },
];

/** The mode list a given transition type should offer, if any. */
function modeOptionsFor(type: string) {
  if (type === 'slide') return SLIDE_MODE_OPTIONS;
  return null;
}

/** The direction list a given transition type should offer, if any. */
function directionOptionsFor(type: string) {
  if (type === 'wipe') return WIPE_DIRECTION_OPTIONS;
  if (type === 'slide') return SLIDE_DIRECTION_OPTIONS;
  return null;
}

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
