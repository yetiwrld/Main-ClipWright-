/**
 * The transport's master peak meter (SPEC 12 §6.3, `10 §3.2`).
 *
 * Three things the spec is specific about, and each is a decision rather than a style:
 *
 * - **Stereo.** Two bars, left over right, because a mono bar cannot show the one thing a
 *   stereo meter is for: which channel is hot.
 * - **A −60…0 dB scale.** Labels at the ends rather than a ruler, since the bars are 40 px
 *   tall and a tick every 6 dB would be noise at that size.
 * - **A peak hold and a latching clip light.** The hold is the marker; the light stays lit
 *   until it is clicked, so a clip cannot scroll past unnoticed.
 *
 * The arithmetic is in `audio-meter.ts` and the graph in `use-audio-meter.ts`; this file
 * only draws. It is deliberately given its state rather than reading a context, so a test
 * can drive any reading it likes without an `AudioContext`.
 */

import { meterFraction, clampDb, METER_FLOOR_DB, type MeterState } from './audio-meter.js';

export interface LevelMeterProps {
  meter: MeterState;
  onClearClip: () => void;
  /** Width of the meter in pixels; the transport is tight, so it is a prop. */
  width?: number;
}

/** The colour of a bar at a given level: safe, hot, and clipping. */
function barColour(db: number): string {
  /*
    Two thresholds, not one. A single "red at 0" bar gives no warning before the clip, and
    the point of a meter is to be watched *before* the light comes on. −6 is the warn line
    most editors use, and it is where the colour changes here.
  */
  if (db >= 0) return 'var(--danger)';
  if (db >= -6) return 'var(--warning)';
  return 'var(--success)';
}

export function LevelMeter({ meter, onClearClip, width = 96 }: LevelMeterProps) {
  const channels: Array<{ key: string; label: string; db: number; peakDb: number }> = [
    { key: 'left', label: 'L', db: meter.leftDb, peakDb: meter.peakLeftDb },
    { key: 'right', label: 'R', db: meter.rightDb, peakDb: meter.peakRightDb },
  ];

  return (
    <div
      /*
        `role="meter"` rather than `progressbar`: the element reports a bounded measurement
        of an ongoing process, and a screen reader announces it on change. The label carries
        the reading, because the bars carry it only visually.
      */
      role="meter"
      aria-label="Master audio level"
      aria-valuemin={METER_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={Math.max(clampDb(meter.leftDb), clampDb(meter.rightDb))}
      aria-valuetext={`Left ${meter.leftDb.toFixed(0)} dB, right ${meter.rightDb.toFixed(0)} dB`}
      data-testid="level-meter"
      style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-1)' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {channels.map((channel) => (
          <div
            key={channel.key}
            data-testid={`meter-${channel.key}`}
            style={{
              position: 'relative',
              width,
              height: 6,
              // The trough is the full scale, so an empty meter still reads as a scale
              // rather than as a missing control.
              background: 'var(--surface-sunken, var(--surface-2))',
              borderRadius: 'var(--radius-xs)',
              overflow: 'hidden',
            }}
          >
            <div
              data-testid={`meter-${channel.key}-bar`}
              /*
                The bar's width *is* the level, expressed through the one function that
                knows the scale. A percentage written here instead would be a second
                definition of where the floor is.
              */
              style={{
                width: `${meterFraction(channel.db) * 100}%`,
                height: '100%',
                background: barColour(channel.db),
                /*
                  No CSS transition, deliberately. The meter is redrawn at 30 Hz by the
                  analyser loop, so a transition would be a second, slower animation on top
                  of the real readings — it would lag the level and hold peaks below where
                  they happened. The `--dur-*` tokens are the wrong tool here: the fastest
                  is 120 ms, four frames of the meter's own cadence.
                */
              }}
            />
            {/*
              The hold marker. Positioned from the left by the same fraction, and rendered
              even at the floor so the bar never changes its structure — a marker that
              appears and disappears makes the meter twitch.
            */}
            <div
              data-testid={`meter-${channel.key}-peak`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${meterFraction(channel.peakDb) * 100}%`,
                width: 2,
                background: 'var(--text-primary)',
                opacity: meterFraction(channel.peakDb) > 0 ? 0.9 : 0,
                transform: 'translateX(-1px)',
              }}
            />
          </div>
        ))}
      </div>
      {/*
        The clip light. It is a control, not an indicator, because clicking it is the only
        way it clears — so it is a button with an accessible name that says whether it is
        currently reporting a clip.
      */}
      <button
        type="button"
        onClick={onClearClip}
        data-testid="meter-clip"
        aria-label={meter.clipped ? 'Clipping detected, click to clear' : 'No clipping, click to clear'}
        aria-pressed={meter.clipped}
        title={meter.clipped ? 'Clipping detected — click to clear' : 'Clip indicator'}
        style={{
          width: 8,
          height: 14,
          padding: 0,
          border: 'none',
          borderRadius: 'var(--radius-xs)',
          cursor: 'pointer',
          background: meter.clipped ? 'var(--danger)' : 'var(--surface-2)',
          /*
            Dim rather than invisible when clear: an unlit lamp that is not there at all
            leaves the user unsure whether the meter has a clip light.
          */
          opacity: meter.clipped ? 1 : 0.5,
        }}
      />
    </div>
  );
}
