/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LevelMeter } from '../LevelMeter';
import { METER_FLOOR_DB, SILENT_METER, type MeterState } from '../audio-meter';

/**
 * The transport's peak meter (`10 §3.2`, SPEC 12 §6.3).
 *
 * Every assertion here is about what the component *draws* from a reading, because the
 * reading itself is covered as arithmetic in `audio-meter.test.ts`. The interesting cases
 * are the ones where a plausible implementation looks right and is not: a bar that ignores
 * the scale, a hold that is not drawn, and a clip light that cannot be cleared.
 */
// The repo's renderer tests clean up explicitly; React Testing Library's automatic
// cleanup is not registered in this setup, so a second `render` leaves the first mounted.
afterEach(() => cleanup());

const state = (overrides: Partial<MeterState> = {}): MeterState => ({
  ...SILENT_METER,
  ...overrides,
});

const widthOf = (testId: string): string =>
  (screen.getByTestId(testId).style.width as string) || '';

const leftOf = (testId: string): string =>
  (screen.getByTestId(testId).style.left as string) || '';

describe('LevelMeter', () => {
  it('draws two channels, because a stereo meter has two', () => {
    render(<LevelMeter meter={state()} onClearClip={() => {}} />);
    expect(screen.getByTestId('meter-left-bar')).toBeTruthy();
    expect(screen.getByTestId('meter-right-bar')).toBeTruthy();
  });

  it('draws an empty bar at the floor and a full one at full scale', () => {
    const { rerender } = render(<LevelMeter meter={state()} onClearClip={() => {}} />);
    expect(widthOf('meter-left-bar')).toBe('0%');

    rerender(
      <LevelMeter meter={state({ leftDb: 0, rightDb: 0 })} onClearClip={() => {}} />,
    );
    expect(widthOf('meter-left-bar')).toBe('100%');
  });

  it('scales the bar in dB, so −30 is half the width', () => {
    /*
      The distinguishing case against an amplitude scale: with a linear-in-amplitude bar,
      −30 dB (0.032 amplitude) would be a sliver, and with a linear-in-dB bar it is half.
      The labels are drawn from the same scale, so getting this wrong makes the bar and its
      numbers disagree in a way no screenshot shows.
    */
    render(<LevelMeter meter={state({ leftDb: -30, rightDb: -30 })} onClearClip={() => {}} />);
    expect(widthOf('meter-left-bar')).toBe('50%');
  });

  it('keeps the two channels independent on screen', () => {
    render(<LevelMeter meter={state({ leftDb: -15, rightDb: -45 })} onClearClip={() => {}} />);
    // The one thing a stereo meter is for: seeing which channel is hot.
    expect(widthOf('meter-left-bar')).not.toBe(widthOf('meter-right-bar'));
    expect(widthOf('meter-left-bar')).toBe('75%');
    expect(widthOf('meter-right-bar')).toBe('25%');
  });

  it('marks the held peak where the hold is, not where the level is', () => {
    /*
      The hold is the whole reason a peak meter is readable: a transient is gone in a frame.
      A marker that tracked the level would be a second bar, which is what an implementation
      that forgot the hold looks like.
    */
    render(
      <LevelMeter
        meter={state({ leftDb: -50, peakLeftDb: -10 })}
        onClearClip={() => {}}
      />,
    );
    expect(leftOf('meter-left-peak')).toBe('83.33333333333334%');
    expect(widthOf('meter-left-bar')).toBe('16.666666666666664%');
  });

  it('hides the hold marker when there is no peak to show', () => {
    // At the floor the marker is invisible rather than absent: the element stays, so the
    // meter never changes its structure and cannot twitch.
    render(<LevelMeter meter={state()} onClearClip={() => {}} />);
    expect(screen.getByTestId('meter-left-peak').style.opacity).toBe('0');
  });

  it('shows the clip light and clears it when clicked', () => {
    const onClearClip = vi.fn();
    render(<LevelMeter meter={state({ clipped: true })} onClearClip={onClearClip} />);
    const light = screen.getByTestId('meter-clip');
    expect(light.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(light);
    expect(onClearClip).toHaveBeenCalledTimes(1);
  });

  it('keeps the clip light present but off when nothing has clipped', () => {
    /*
      Dimmed, not removed. An unlit lamp that is not there at all leaves the user unsure
      whether the meter has a clip light, and the spec's latching light is only useful if
      its dark state is visible before something clips.
    */
    render(<LevelMeter meter={state({ clipped: false })} onClearClip={() => {}} />);
    const light = screen.getByTestId('meter-clip');
    expect(light.getAttribute('aria-pressed')).toBe('false');
    expect(light.style.opacity).toBe('0.5');
  });

  it('announces the reading to assistive technology', () => {
    render(<LevelMeter meter={state({ leftDb: -12, rightDb: -24 })} onClearClip={() => {}} />);
    const meter = screen.getByRole('meter');
    // The bars carry the reading visually; without this the control is unlabelled noise.
    expect(meter.getAttribute('aria-valuetext')).toBe('Left -12 dB, right -24 dB');
    expect(meter.getAttribute('aria-valuenow')).toBe('-12');
    expect(meter.getAttribute('aria-valuemin')).toBe(String(METER_FLOOR_DB));
  });
});
