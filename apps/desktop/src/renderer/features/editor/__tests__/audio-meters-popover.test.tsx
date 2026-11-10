// @vitest-environment jsdom
/**
 * The Audio meters popover (SPEC 12 §6.3).
 *
 * The interesting cases are all about *honesty* rather than layout: a provisional reading must
 * say it is provisional, silence and "not measured yet" are the same number and different facts,
 * and the comparison must name the target it is comparing against. Each of those is a place a
 * meter quietly misleads a user into normalising against something that is not what they think.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LOUDNESS_FLOOR_LUFS, type LoudnessReading } from '@clipwright/audio-core';
import { AudioMetersPopover, formatLoudness, LOUDNESS_TARGET } from '../AudioMetersPopover.js';
import { SILENT_METER, type MeterState } from '../audio-meter.js';

afterEach(cleanup);

const reading = (overrides: Partial<LoudnessReading> = {}): LoudnessReading => ({
  lufs: -16,
  complete: true,
  samples: 19_200,
  ...overrides,
});

const meter = (overrides: Partial<MeterState> = {}): MeterState => ({
  ...SILENT_METER,
  leftDb: -12.5,
  rightDb: -11,
  peakLeftDb: -6.25,
  peakRightDb: -5,
  ...overrides,
});

const open = (props: { loudness?: LoudnessReading; meter?: MeterState; onClose?: () => void } = {}) =>
  render(
    <AudioMetersPopover
      meter={props.meter ?? meter()}
      loudness={props.loudness ?? reading()}
      onClose={props.onClose ?? vi.fn()}
    />,
  );

describe('the Audio meters popover', () => {
  it('shows the momentary loudness and both peak figures', () => {
    // Two measurements, deliberately side by side: the peak is what the transport shows and the
    // loudness is why this popover exists, and seeing them together is what teaches the
    // difference — a mix can be far under the clip line and still far too quiet.
    open();
    expect(screen.getByText('−16.0 LUFS'.replace('−', '-'))).toBeTruthy();
    expect(screen.getByText('-6.3 dB')).toBeTruthy();
    expect(screen.getByText('-5.0 dB')).toBeTruthy();
  });

  it('names the target it is comparing against', () => {
    /*
      "5 LU quieter" is only useful if the user knows quieter *than what*. The default lives in
      the module so the popover's prose and its comparison cannot drift apart.
    */
    open({ loudness: reading({ lufs: -21.2 }) });
    expect(screen.getByText(`5 LU quieter than ${LOUDNESS_TARGET} LUFS.`)).toBeTruthy();
  });

  it('says the reading is provisional while the 400 ms gate fills', () => {
    /*
      The gate takes 400 ms of audio to fill, and until it does the figure is a partial average
      that climbs. A number shown without that caveat is one a user can normalise against and
      then find the finished clip quieter than they aimed for.
    */
    open({ loudness: reading({ complete: false, samples: 2048 }) });
    expect(screen.getByRole('status').textContent).toMatch(/400 ms/i);
  });

  it('stops apologising once the gate is full', () => {
    // A permanent caveat reads as a broken meter, and a panel that never stops qualifying its
    // own numbers is one nobody trusts when it matters.
    open({ loudness: reading({ complete: true }) });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('draws no comparison while the reading is still filling', () => {
    // A delta against a partial reading is a comparison against a number that is still moving.
    open({ loudness: reading({ complete: false, samples: 2048, lufs: -30 }) });
    expect(screen.queryByText(/quieter than|louder than|On target/)).toBeNull();
  });

  it('tells silence apart from “nothing measured yet”', () => {
    /*
      Both are the floor and they are different facts. Before playback the meter has read
      nothing at all; during a silent passage it has read silence. Printing "−70 LUFS" for both
      makes an empty project look like a silent one.
    */
    expect(formatLoudness(reading({ lufs: LOUDNESS_FLOOR_LUFS, samples: 0 }))).toBe('No audio yet');
    expect(formatLoudness(reading({ lufs: LOUDNESS_FLOOR_LUFS, samples: 19_200 }))).toBe('Silence');
  });

  it('shows a peak at or below the floor as a floor, not as a large negative number', () => {
    /*
      `clampDb` floors the *value*, and "-60.0 dB" then reads as a measurement — a quiet one,
      but a measurement. Nothing in the window is the truth, and the popover says so.
    */
    open({ meter: meter({ peakLeftDb: -60, peakRightDb: -80 }) });
    expect(screen.getAllByText('below -60 dB')).toHaveLength(2);
  });

  it('closes from its own button', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(screen.getByRole('button', { name: /close audio meters/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
