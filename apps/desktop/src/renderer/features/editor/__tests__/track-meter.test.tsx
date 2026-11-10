/**
 * @vitest-environment jsdom
 *
 * A track header's level meter (SPEC 12 §6.3).
 *
 * The arithmetic is `audio-meter.ts`'s and is tested there; what is tested here is what this
 * component says, which is mostly the *accessible* reading. A 3 px bar carries nothing to a
 * screen reader and very little to an eye at a glance, so the `aria-valuetext` is not decoration —
 * it is the meter as far as anything but a sighted user looking straight at it is concerned.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackMeter } from '../TrackMeter';
import { METER_FLOOR_DB, SILENT_METER, type MeterState } from '../audio-meter';

afterEach(() => cleanup());

const meter = (overrides: Partial<MeterState> = {}): MeterState => ({
  ...SILENT_METER,
  ...overrides,
});

const widthOf = (channel: 'left' | 'right'): string => {
  const bar = document.querySelector(`[data-testid="track-meter-${channel}"] > div`) as HTMLElement;
  return bar.style.width;
};

describe('TrackMeter', () => {
  it('draws two bars, because a stereo meter has two channels', () => {
    render(<TrackMeter meter={meter()} trackName="Music" />);
    expect(document.querySelector('[data-testid="track-meter-left"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="track-meter-right"]')).not.toBeNull();
  });

  it('draws an empty bar at the floor and a full one at full scale', () => {
    const { rerender } = render(
      <TrackMeter meter={meter({ leftDb: METER_FLOOR_DB })} trackName="Music" />,
    );
    expect(widthOf('left')).toBe('0%');

    rerender(<TrackMeter meter={meter({ leftDb: 0 })} trackName="Music" />);
    expect(widthOf('left')).toBe('100%');
  });

  it('reads each channel independently', () => {
    /*
      A single bar computed from the louder channel would be half the size and half the point:
      the reason to draw two is that a track can be hot on one side — a hard-panned guitar, a
      voice taken from one channel of a stereo camera.
    */
    render(<TrackMeter meter={meter({ leftDb: 0, rightDb: METER_FLOOR_DB })} trackName="Music" />);
    expect(widthOf('left')).toBe('100%');
    expect(widthOf('right')).toBe('0%');
  });

  it('turns hot and then red at the same thresholds the master meter uses', () => {
    const colourOf = (): string =>
      (document.querySelector('[data-testid="track-meter-left"] > div') as HTMLElement).style
        .background;
    const { rerender } = render(<TrackMeter meter={meter({ leftDb: -20 })} trackName="M" />);
    expect(colourOf()).toBe('var(--success)');

    rerender(<TrackMeter meter={meter({ leftDb: -3 })} trackName="M" />);
    expect(colourOf()).toBe('var(--warning)');

    rerender(<TrackMeter meter={meter({ leftDb: 0 })} trackName="M" />);
    expect(colourOf()).toBe('var(--danger)');
  });

  it('names the track in its label, so two meters are not both "level"', () => {
    /* A screen reader moving through a header panel meets these one after another. */
    render(<TrackMeter meter={meter()} trackName="Voiceover" />);
    const region = document.querySelector('[role="meter"]')!;
    expect(region.getAttribute('aria-label')).toBe('Voiceover level');
  });

  it('reports the louder channel as the value, with the reading spelled out', () => {
    /*
      `aria-valuenow` is one number by the ARIA contract, so the louder channel is what it
      carries; `aria-valuetext` is what actually gets announced and can say more, so the
      distinction costs nothing and naming both channels would be a lie about `valuenow`.
    */
    render(<TrackMeter meter={meter({ leftDb: -6, rightDb: -30 })} trackName="Music" />);
    const region = document.querySelector('[role="meter"]')!;
    expect(region.getAttribute('aria-valuenow')).toBe('-6');
    expect(region.getAttribute('aria-valuetext')).toBe('-6 dB');
  });

  it('says nothing when the level is below the scale the meter draws', () => {
    /*
      A reading of −80 dB is real and meaningless on a 3 px bar: it is silence as far as anyone
      looking at the header is concerned, and it must not be reported as a level.
    */
    render(<TrackMeter meter={meter({ leftDb: -120, rightDb: -120 })} trackName="Music" />);
    expect(widthOf('left')).toBe('0%');
    expect(document.querySelector('[role="meter"]')!.getAttribute('aria-valuenow')).toBe(
      String(METER_FLOOR_DB),
    );
  });

  it('is not focusable and not a control', () => {
    /*
      It is a readout, not something to click: a meter that took focus would sit in the tab order
      between the mute button and the solo button, which is where a user's hand is not.
    */
    render(<TrackMeter meter={meter()} trackName="Music" />);
    const region = document.querySelector('[role="meter"]')!;
    expect(region.getAttribute('tabindex')).toBeNull();
    expect(region.tagName).not.toBe('BUTTON');
  });
});
