/**
 * Safe areas, platform UI zones and composition guides (SPEC 10 §9).
 *
 * Rendered as a sibling layer *above* the video stack and below the selection handles,
 * so an overlay never intercepts a pointer and never appears in an export — the latter
 * structurally, because the exporter composites frames from the decoder and never
 * renders this component at all.
 *
 * The guide lines are `--brand` at 40% or less and the dim bands 12% black, per the
 * spec's styling rule. Values live in `safe-areas.json`; this file only draws them.
 */
import { memo } from 'react';
import {
  platformBands,
  safeAreaRect,
  type OverlayState,
  type PlatformZone,
  type SafeAreaData,
} from './safe-areas.js';
import { effectiveGrid, gridLines } from './grid.js';

/** The colour every guide shares, kept in one place so the four agree. */
const GUIDE = 'var(--brand)';

const lineStyle = (extra: Record<string, unknown>) => ({
  position: 'absolute' as const,
  background: GUIDE,
  /*
    25% rather than the spec's ceiling of 40%: a guide is something you look *past* at
    the picture, and the ceiling is where a faintly-visible line starts competing with
    the frame.
  */
  opacity: 0.25,
  pointerEvents: 'none' as const,
  ...extra,
});

const BAND_STYLE = {
  position: 'absolute' as const,
  background: 'var(--surface-app)',
  opacity: 0.12,
  pointerEvents: 'none' as const,
};

export interface PreviewOverlaysProps {
  state: OverlayState;
  /**
   * The parsed `safe-areas.json`.
   *
   * Passed in rather than imported here so the numbers have exactly one definition:
   * the file. An overlay with its own copy of 0.9 would keep drawing the old safe area
   * after the data was tuned, which is the whole reason the spec asks for data.
   */
  data: SafeAreaData;
  /** The platform zone for this canvas, or `null` when it has none. */
  zone: PlatformZone | null;
}

export const PreviewOverlays = memo(function PreviewOverlays({
  state,
  data,
  zone,
}: PreviewOverlaysProps) {
  const { areas, thirds, centreCross } = state;
  /*
    The grid's lines, computed once. A custom grid is the same overlay as the thirds with
    another pair of divisors, so there is nothing below that knows which one it is drawing
    — which is the point: one code path, one set of snap targets, no way for the drawing and
    the snapping to disagree about where a line is.
  */
  const grid = thirds ? effectiveGrid(thirds) : null;
  const gridX = grid ? gridLines(grid.columns) : [];
  const gridY = grid ? gridLines(grid.rows) : [];
  const showSafe = areas === 'title-safe' || areas === 'action-safe';
  const showPlatform = areas === 'platform-zones' && zone !== null;
  /** The safe area being drawn, computed once rather than per style property. */
  const safe = showSafe
    ? safeAreaRect(areas === 'title-safe' ? data.titleSafe : data.actionSafe)
    : null;

  return (
    <div
      data-testid="preview-overlays"
      data-area={areas}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}
    >
      {/* Safe areas: a centred inset rectangle at 90% (title) or 93% (action). */}
      {showSafe ? (
        <div
          data-testid="overlay-safe-area"
          style={{
            position: 'absolute',
            left: `${(safe?.x ?? 0) * 100}%`,
            top: `${(safe?.y ?? 0) * 100}%`,
            width: `${(safe?.width ?? 0) * 100}%`,
            height: `${(safe?.height ?? 0) * 100}%`,
            border: `1px solid ${GUIDE}`,
            opacity: 0.25,
            pointerEvents: 'none',
          }}
        />
      ) : null}

      {/*
        Platform chrome. Three separate bands, because that is the shape the chrome
        covers — a single rectangle would dim the *safe* middle instead.
      */}
      {showPlatform && zone ? (
        <>
          {(['top', 'bottom', 'right'] as const).map((band) => {
            const rect = platformBands(zone)[band];
            return (
              <div
                key={band}
                data-testid={`overlay-platform-${band}`}
                style={{
                  ...BAND_STYLE,
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                }}
              />
            );
          })}
        </>
      ) : null}

      {/*
        The composition grid: the columns give the verticals, the rows the horizontals.
        The edges are excluded by `gridLines`, because the canvas border is already visible
        and already a snap target — a line on top of it would be a second target in exactly
        the same place for the tie-break to pick between.
      */}
      {grid ? (
        <>
          {gridX.map((at, index) => (
            <div
              key={`v-${index}`}
              data-testid={`overlay-grid-v-${index}`}
              style={lineStyle({ left: `${at * 100}%`, top: 0, width: 1, height: '100%' })}
            />
          ))}
          {gridY.map((at, index) => (
            <div
              key={`h-${index}`}
              data-testid={`overlay-grid-h-${index}`}
              style={lineStyle({ top: `${at * 100}%`, left: 0, height: 1, width: '100%' })}
            />
          ))}
        </>
      ) : null}

      {/*
        Centre cross. Drawn as two short ticks rather than two full lines: a full-width
        line through the middle is indistinguishable from a third at a glance, and the
        point of the cross is to mark the exact centre.
      */}
      {centreCross ? (
        <>
          <div
            data-testid="overlay-centre-h"
            style={lineStyle({ top: '50%', left: '50%', width: '10%', marginLeft: '-5%', height: 1 })}
          />
          <div
            data-testid="overlay-centre-v"
            style={lineStyle({ left: '50%', top: '50%', height: '10%', marginTop: '-5%', width: 1 })}
          />
        </>
      ) : null}
    </div>
  );
});
