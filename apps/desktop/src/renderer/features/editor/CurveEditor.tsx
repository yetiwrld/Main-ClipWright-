/**
 * The curve editor (SPEC 12 §2.6) — a bottom drawer of the timeline that graphs
 * the selected item's keyframed properties over time.
 *
 * Why this is a drawer and not a panel: the spec asks for "a graph of the selected
 * properties — X time, Y value", and until now keyframes could be created, moved
 * and deleted on the timeline lane but never *shaped*. A keyframe's easing could be
 * picked from a dropdown, which covers the eleven named presets and nothing else;
 * the `bezier` field the schema and the evaluator have always supported was
 * unreachable from the UI, because no command could write it. This is that surface.
 *
 * What it deliberately does not do yet is listed honestly in `docs/limitations.md`
 * rather than pretended: there is no multi-property overlay beyond drawing each
 * property in its own colour, and the numeric transform tools (mirror, reverse,
 * scale-time, scale-value) are not built.
 */
import React, { useMemo, useRef, useState } from 'react';
import type { Keyframe } from '@clipwright/project-schema/schemas';
import type { TimelineState } from '@clipwright/timeline-engine';
import { Button, IconButton } from '@clipwright/design-system';
import type { TimelineApi } from './use-timeline.js';

/**
 * Colours for the graphed properties, cycled by index.
 *
 * The spec asks for "per-property colours (muted, never orange)" — orange is the
 * brand colour, so using it for a series would make a data line read as a control.
 * These are the existing `--track-*` tokens rather than new hexes, both because the
 * design-token lint forbids literals in renderer UI and because reusing them keeps
 * the graph's palette consistent with the tracks it describes.
 */
export const SERIES_COLOURS = [
  'var(--track-main)',
  'var(--track-overlay)',
  'var(--track-graphic)',
  'var(--track-voice)',
  'var(--track-audio)',
  'var(--track-music)',
  'var(--track-sfx)',
  'var(--track-caption)',
] as const;

export function seriesColour(index: number): string {
  return SERIES_COLOURS[Math.abs(index) % SERIES_COLOURS.length]!;
}

/** One graphed property and its keys, already resolved for display. */
export interface CurveSeries {
  property: string;
  colour: string;
  keyframes: Keyframe[];
}

/**
 * The keyframed properties of one item, as series ready to graph.
 *
 * Only numeric values are graphed. A colour property's value is an RGBA tuple and
 * has no single y position; drawing it would need four curves or a colour ramp, and
 * silently plotting the red channel would be worse than not offering it.
 */
export function curveSeriesFor(item: TimelineState['items'][string] | undefined): CurveSeries[] {
  if (!item?.keyframes) return [];
  const series: CurveSeries[] = [];
  const properties = Object.keys(item.keyframes).sort();
  for (const property of properties) {
    const keyframes = (item.keyframes[property] ?? [])
      .filter((keyframe) => typeof keyframe.value === 'number')
      .slice()
      .sort((a, b) => a.timeUs - b.timeUs);
    if (keyframes.length === 0) continue;
    series.push({ property, colour: seriesColour(series.length), keyframes });
  }
  return series;
}

/** Map a value range to the graph's 0–1 vertical axis, padded so a flat line is not on an edge. */
export function valueRange(keyframes: readonly Keyframe[]): { min: number; max: number } {
  const numbers = keyframes
    .map((keyframe) => keyframe.value)
    .filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  if (max - min < 1e-9) {
    // A single value, or several identical ones: give it a window so the line sits
    // mid-graph instead of collapsing onto an axis.
    const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

export interface CurveEditorProps {
  state: TimelineState | null;
  timeline: TimelineApi;
  /** Item whose curves are shown; the inspector's selection. */
  itemId: string | null;
  fps: number;
  onClose: () => void;
}

/**
 * A cubic-bezier handle pair, editable.
 *
 * The handle's x is measured across the segment and clamped to 0–1 by the command;
 * y is free. Dragging is expressed as a proportion of the graph box so the same
 * numbers mean the same thing at any zoom — the editor draws a fixed window rather
 * than supporting wheel-zoom, and pretending otherwise would put a zoom control in
 * the UI that no gesture reaches.
 */
export function CurveEditor({ state, timeline, itemId, onClose }: CurveEditorProps): React.ReactElement | null {
  const item = itemId && state ? state.items[itemId] : undefined;
  const series = useMemo(() => curveSeriesFor(item), [item]);
  const [activeProperty, setActiveProperty] = useState<string | null>(null);
  const [selectedKeyTime, setSelectedKeyTime] = useState<number | null>(null);
  const dragRef = useRef<'out' | 'in' | null>(null);

  const active = series.find((entry) => entry.property === activeProperty) ?? series[0];
  const selectedKey = active?.keyframes.find((keyframe) => keyframe.timeUs === selectedKeyTime);

  // After the guard below these are all present; TypeScript cannot see that through
  // the early return, so the identity is taken once rather than asserted at each use.
  const owner = itemId && item ? { id: itemId, item } : null;

  if (!owner || !active) {
    return (
      <section
        aria-label="Curve editor"
        style={{
          borderTop: '1px solid var(--line-subtle)',
          background: 'var(--surface-panel)',
          padding: 'var(--space-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          fontSize: 'var(--fs-sm)',
          color: 'var(--text-muted)',
        }}
      >
        {/*
          An empty curve editor is a real state, not an error: a clip with no
          keyframes has no curve to edit. Saying so is better than a blank graph,
          which reads as a bug.
        */}
        <span>
          {itemId
            ? 'This clip has no keyframed properties yet. Add a keyframe in the inspector or on the timeline.'
            : 'Select a clip to edit its animation curves.'}
        </span>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </section>
    );
  }

  const range = valueRange(active.keyframes);
  const durationUs = Math.max(1, owner.item.durationUs);
  const graphWidth = 100;
  const graphHeight = 100;
  const xFor = (timeUs: number) => (timeUs / durationUs) * graphWidth;
  const yFor = (value: number) =>
    graphHeight - ((value - range.min) / (range.max - range.min)) * graphHeight;

  const path = active.keyframes
    .map((keyframe, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command} ${xFor(keyframe.timeUs).toFixed(3)} ${yFor(keyframe.value as number).toFixed(3)}`;
    })
    .join(' ');

  /*
    Handle geometry. The outgoing handle of the selected key sits at
    `(outX, outY)` in segment space: x across the segment to the next key, y between
    this key's value and the next one. Both handles are drawn for the *selected*
    key only — drawing every key's handles at once turns the graph into a thicket
    at any realistic key count, and the spec's multi-property overlay makes that
    worse rather than better.
  */
  const nextKey = selectedKey
    ? active.keyframes[active.keyframes.indexOf(selectedKey) + 1]
    : undefined;
  const handleGeometry =
    selectedKey && nextKey && typeof selectedKey.value === 'number' && typeof nextKey.value === 'number'
      ? (() => {
          const bezier = selectedKey.bezier ?? { outX: 0.42, outY: 0, inX: 0.58, inY: 1 };
          const fromX = xFor(selectedKey.timeUs);
          const toX = xFor(nextKey.timeUs);
          const spanX = toX - fromX;
          const fromY = yFor(selectedKey.value);
          const toY = yFor(nextKey.value);
          const spanY = toY - fromY;
          return {
            bezier,
            out: { x: fromX + bezier.outX * spanX, y: fromY + bezier.outY * spanY },
            in: { x: fromX + bezier.inX * spanX, y: fromY + bezier.inY * spanY },
            from: { x: fromX, y: fromY },
            to: { x: toX, y: toY },
            spanX,
            spanY,
          };
        })()
      : null;

  /*
    Dragging writes the handle as a proportion of the segment, which is what the
    model stores. The write happens on release (`onPointerUp`) so a drag is one undo
    step rather than one per pixel, which is what §2.6 asks for — "edits are
    transactions on release".
  */
  const commitHandle = (which: 'out' | 'in', ratioX: number, ratioY: number) => {
    if (!selectedKey || !handleGeometry) return;
    const current = handleGeometry.bezier;
    const next = {
      ...current,
      ...(which === 'out'
        ? { outX: Math.min(1, Math.max(0, ratioX)), outY: ratioY }
        : { inX: Math.min(1, Math.max(0, ratioX)), inY: ratioY }),
    };
    timeline.setBezierHandles(owner.id, active.property, selectedKey.timeUs, next);
  };

  return (
    <section
      aria-label="Curve editor"
      style={{
        borderTop: '1px solid var(--line-subtle)',
        background: 'var(--surface-panel)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        padding: 'var(--space-2)',
        minHeight: 0,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <strong style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)' }}>Curves</strong>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flex: 1, flexWrap: 'wrap' }}>
          {series.map((entry) => {
            const isActive = entry.property === active.property;
            return (
              <button
                key={entry.property}
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  setActiveProperty(entry.property);
                  setSelectedKeyTime(null);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: isActive ? 'var(--brand-tint)' : 'transparent',
                  border: '1px solid var(--line-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--fs-xs)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: entry.colour,
                    flexShrink: 0,
                  }}
                />
                {entry.property}
              </button>
            );
          })}
        </div>
        <IconButton label="Close the curve editor" icon="×" onClick={onClose} />
      </header>

      <svg
        viewBox={`0 0 ${graphWidth} ${graphHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Curve for ${active.property}`}
        style={{
          height: 140,
          width: '100%',
          background: 'var(--surface-app)',
          border: '1px solid var(--line-subtle)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <path d={path} fill="none" stroke={active.colour} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {handleGeometry ? (
          <g>
            {/* Handles as straight leaders from the key, the way a bezier editor draws them. */}
            {(['out', 'in'] as const).map((which) => (
              <line
                key={which}
                x1={handleGeometry.from.x}
                y1={handleGeometry.from.y}
                x2={handleGeometry[which].x}
                y2={handleGeometry[which].y}
                stroke="var(--text-muted)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {(['out', 'in'] as const).map((which) => (
              <circle
                key={`handle-${which}`}
                data-testid={`handle-${which}`}
                cx={handleGeometry[which].x}
                cy={handleGeometry[which].y}
                r={2.5}
                fill="var(--surface-panel)"
                stroke="var(--brand)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'grab' }}
                onPointerDown={() => {
                  dragRef.current = which;
                }}
                onPointerUp={(event) => {
                  /*
                    The pointer's position is read from the SVG's own box rather than
                    from the event's coordinates: `preserveAspectRatio="none"` means
                    the viewBox is stretched, so a pixel delta is not a graph delta.
                  */
                  const box = (event.currentTarget.ownerSVGElement as SVGSVGElement | null)
                    ?.getBoundingClientRect();
                  if (!box || !handleGeometry) {
                    dragRef.current = null;
                    return;
                  }
                  const xInGraph = ((event.clientX - box.left) / box.width) * graphWidth;
                  const yInGraph = ((event.clientY - box.top) / box.height) * graphHeight;
                  const ratioX =
                    handleGeometry.spanX === 0 ? 0 : (xInGraph - handleGeometry.from.x) / handleGeometry.spanX;
                  const ratioY =
                    handleGeometry.spanY === 0 ? 0 : (yInGraph - handleGeometry.from.y) / handleGeometry.spanY;
                  dragRef.current = null;
                  commitHandle(which, ratioX, ratioY);
                }}
              />
            ))}
          </g>
        ) : null}
        {active.keyframes.map((keyframe) => (
          <rect
            key={keyframe.timeUs}
            data-testid={`curve-key-${keyframe.timeUs}`}
            x={xFor(keyframe.timeUs) - 2}
            y={yFor(keyframe.value as number) - 2}
            width={4}
            height={4}
            // §2.5's diamond, as a rotated square.
            transform={`rotate(45 ${xFor(keyframe.timeUs)} ${yFor(keyframe.value as number)})`}
            fill={keyframe.timeUs === selectedKeyTime ? 'var(--brand)' : 'var(--text-secondary)'}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedKeyTime(keyframe.timeUs)}
          />
        ))}
      </svg>

      <footer style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-xs)' }}>
        <span style={{ color: 'var(--text-muted)' }}>
          {selectedKey
            ? `${selectedKey.interpolation} · ${(selectedKey.timeUs / 1_000_000).toFixed(3)} s`
            : 'Select a key to edit its handles'}
        </span>
        {selectedKey && !nextKey ? (
          // A key with no successor governs nothing: easing describes the segment
          // *leaving* it, so the last key on a property has no curve to shape.
          <span style={{ color: 'var(--text-muted)' }}>the last key has no following segment</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-muted)' }}>
          {active.keyframes.length} key{active.keyframes.length === 1 ? '' : 's'}
        </span>
      </footer>
    </section>
  );
}
