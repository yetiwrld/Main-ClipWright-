/**
 * A track header's level meter (SPEC 12 §6.3).
 *
 * > **per-track meters** in the track headers when headers are wide enough
 *
 * Deliberately not `LevelMeter`. The transport's master meter is 96 px with labelled channels,
 * a −60…0 scale and a latching clip light, because it is the thing you look at when you are
 * judging a mix. A header is 184 px wide and shared with a name, a lock, a magnetic toggle, a
 * mute and a solo button; a meter that carried the scale and the clip light would either not fit
 * or push the controls a user presses off the row. So this draws one thing: **two thin bars**,
 * left over right, on the same −60…0 dB scale and in the same colours, so the two meters cannot
 * disagree about what "hot" looks like.
 *
 * Two decisions worth stating:
 *
 * - **A track with nothing audible draws nothing** rather than an empty bar. An always-present,
 *   always-dark meter is indistinguishable from a broken one, and the caller already knows which
 *   tracks have a node (the graph publishes exactly those).
 * - **No peak hold.** The hold is what makes the master meter readable at a glance; at 6 px tall
 *   a hold marker would cover the bar it is marking. The hold belongs where there is room for it.
 *
 * The arithmetic is `audio-meter.ts`'s — the same module the master meter uses — so this file
 * draws and nothing else.
 */
import { METER_FLOOR_DB, clampDb, meterFraction, type MeterState } from './audio-meter.js';

export interface TrackMeterProps {
  meter: MeterState;
  /** The track's name, for the accessible label. */
  trackName: string;
  /** Width in pixels. The header passes what is left of its row; defaults to a thin bar. */
  width?: number;
}

export function TrackMeter({ meter, trackName, width = 44 }: TrackMeterProps) {
  const value = Math.max(clampDb(meter.leftDb), clampDb(meter.rightDb));
  return (
    <div
      /*
        `role="meter"` with the reading in `aria-valuetext`: the bars are 3 px tall and carry
        nothing to a screen reader, while "Music, −12 dB" is the whole of what the meter says.
      */
      role="meter"
      aria-label={`${trackName} level`}
      aria-valuemin={METER_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={value}
      aria-valuetext={`${value.toFixed(0)} dB`}
      data-testid="track-meter"
      data-track-level={value.toFixed(0)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
        width,
        flexShrink: 0,
      }}
    >
      {(['left', 'right'] as const).map((channel) => {
        const db = channel === 'left' ? meter.leftDb : meter.rightDb;
        return (
          <div
            key={channel}
            aria-hidden="true"
            data-testid={`track-meter-${channel}`}
            style={{
              position: 'relative',
              height: 3,
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--radius-pill)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                width: `${Math.round(meterFraction(db) * 100)}%`,
                /*
                  The same three colours as the master meter, from the same thresholds in
                  `audio-meter.ts` — a second set of numbers here is how the two meters start
                  disagreeing about what counts as hot.
                */
                background: db >= 0 ? 'var(--danger)' : db >= -6 ? 'var(--warning)' : 'var(--success)',
                borderRadius: 'var(--radius-pill)',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
