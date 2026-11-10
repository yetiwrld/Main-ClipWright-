/**
 * The *Audio meters* popover (SPEC 12 §6.3).
 *
 * The spec puts momentary LUFS here rather than in the transport, and the reason is space: the
 * transport is a row of controls and a loudness number beside a peak meter invites the reading
 * that they are the same measurement. They are not — a peak says "will this clip?" and a
 * loudness says "how loud does this sit?" — and the popover has room to say so.
 *
 * Three decisions in this file, all of them about honesty rather than layout:
 *
 * 1. **A provisional reading says it is provisional.** The 400 ms gate takes 400 ms to fill, so
 *    for the first moments of playback the figure is partial. A popover that showed a climbing
 *    number with no caveat would let a user normalise against it and then wonder why the finished
 *    clip is quieter than the number they aimed at.
 * 2. **The peak figures are repeated here, not duplicated.** They come from the same `MeterState`
 *    the transport draws, so the two can never disagree — the popover is a second *view* of one
 *    reading, not a second reading.
 * 3. **The target is shown when there is one.** `describeLoudness` compares against −16 LUFS,
 *    which is this project's house default for speech-led short-form (SPEC 12 §6.6). Comparing
 *    against a number the popover does not name would be the panel telling a user they are
 *    "5 LU quiet" relative to a secret.
 */
import React from 'react';
import { Card } from '@clipwright/design-system';
import { describeLoudness, LOUDNESS_FLOOR_LUFS } from '@clipwright/audio-core';
import { clampDb, METER_FLOOR_DB, type MeterState } from './audio-meter.js';
import type { LoudnessReading } from '@clipwright/audio-core';

/**
 * The default loudness target. SPEC 12 §6.6 names −16 LUFS for speech-led short-form; the
 * popover states it rather than silently comparing against it.
 */
export const LOUDNESS_TARGET = -16;

export interface AudioMetersPopoverProps {
  meter: MeterState;
  loudness: LoudnessReading;
  /** Closes the popover; the transport's meter is the toggle. */
  onClose: () => void;
}

/** A LUFS reading as text, with the floor shown as silence rather than as a number. */
export function formatLoudness(reading: LoudnessReading): string {
  /*
    The floor means two different things — "silent" and "not measured yet" — and the popover has
    to say which, because a user who sees "−70 LUFS" on an empty project and then again mid-play
    would reasonably conclude the meter is broken. `complete` is what tells them apart.
  */
  if (reading.lufs <= LOUDNESS_FLOOR_LUFS) {
    return reading.samples === 0 ? 'No audio yet' : 'Silence';
  }
  return `${reading.lufs.toFixed(1)} LUFS`;
}

export function AudioMetersPopover({ meter, loudness, onClose }: AudioMetersPopoverProps) {
  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        padding: 'var(--space-2)',
        minWidth: 232,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, flex: 1 }}>Audio meters</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close audio meters"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 'var(--fs-sm)',
          }}
        >
          ✕
        </button>
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px var(--space-2)', fontSize: 'var(--fs-sm)' }}
      >
        <span style={{ color: 'var(--text-muted)' }}>Peak L</span>
        <span>{formatDb(meter.peakLeftDb)}</span>
        <span style={{ color: 'var(--text-muted)' }}>Peak R</span>
        <span>{formatDb(meter.peakRightDb)}</span>
        <span style={{ color: 'var(--text-muted)' }}>Momentary</span>
        <span>{formatLoudness(loudness)}</span>
      </div>

      {/*
        The caveat, only while it is true. A permanent "this reading is partial" would be read as
        a broken meter once the gate fills, and a popover that never stops apologising is one
        nobody believes.
      */}
      {!loudness.complete && loudness.samples > 0 && (
        <p role="status" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          Filling the 400 ms average — the figure settles as playback continues.
        </p>
      )}

      {/*
        Compared against a named target. ±1 LU is "on target" because no platform's
        normalisation acts on less (SPEC 12 §6.6).
      */}
      {loudness.complete && loudness.lufs > LOUDNESS_FLOOR_LUFS && (
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          {describeLoudness(loudness.lufs, LOUDNESS_TARGET)}
        </p>
      )}

      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
        Peak is the loudest sample; LUFS averages over 400 ms with the ear’s own weighting. A mix
        can be well under the clip line and still far too quiet for a platform.
      </p>
    </Card>
  );
}

/** A peak figure with its floor shown as a floor, never as a large negative number. */
function formatDb(db: number): string {
  const clamped = clampDb(db);
  return clamped <= METER_FLOOR_DB ? `below ${METER_FLOOR_DB} dB` : `${clamped.toFixed(1)} dB`;
}
