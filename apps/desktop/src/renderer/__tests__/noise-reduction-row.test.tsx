// @vitest-environment jsdom
/**
 * The noise-reduction row (SPEC 12 §6.8).
 *
 * The spec's four requirements, each asserted as behaviour rather than as markup: the strength
 * reaches the job, the button starts one, the A/B toggle writes nothing to the project, and Revert
 * clears the item. Plus the omission rule — a control that cannot act is not drawn.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoiseReductionRow } from '../features/editor/NoiseReductionRow.js';
import {
  NOISE_WARNING,
  STRENGTH_OPTIONS,
  canRevert,
  comparisonSide,
  describeNoiseReductionRow,
  planReduceNoise,
} from '../features/editor/noise-reduction-panel.js';

afterEach(() => cleanup());

const APPLIED = {
  noiseReduction: {
    strength: 'high',
    path: '/media/a/derived/enhanced/abc.wav',
    method: 'afftdn',
  },
  hasAudio: true,
};

describe('the row, as decisions', () => {
  it('shows nothing for a clip with no audio', () => {
    /*
      Not a disabled row: there is no audio to reduce, so a section offering to reduce it would be
      a promise the clip cannot keep. The same reasoning SPEC 28 applies to mute on a silent clip.
    */
    const row = describeNoiseReductionRow({ hasAudio: false });
    expect(row.visible).toBe(false);
    expect(row.canCompare).toBe(false);
  });

  it('offers no comparison before a copy exists', () => {
    /* A toggle with nothing to toggle between is the control this project omits. */
    const row = describeNoiseReductionRow({ hasAudio: true });
    expect(row.visible).toBe(true);
    expect(row.applied).toBe(false);
    expect(row.canCompare).toBe(false);
    expect(row.warning).toBeNull();
  });

  it('carries the spec’s warning, word for word, once a copy is applied', () => {
    const row = describeNoiseReductionRow(APPLIED);
    expect(row.warning).toBe(NOISE_WARNING);
    expect(NOISE_WARNING).toBe('Noise reduction can affect voice quality; compare before using.');
  });

  it('says which method made the copy, so the user can explain what they hear', () => {
    expect(describeNoiseReductionRow(APPLIED).status).toContain('spectral denoising');
    expect(
      describeNoiseReductionRow({
        ...APPLIED,
        noiseReduction: { ...APPLIED.noiseReduction, method: 'arnndn' },
      }).status,
    ).toContain('RNNoise');
  });

  it('falls back to the strength the control understands', () => {
    /* A stored value this build does not know must not leave the control with nothing selected. */
    const row = describeNoiseReductionRow({
      hasAudio: true,
      noiseReduction: { strength: 'galactic', path: '/x.wav' },
    });
    expect(row.strength).toBe('medium');
  });

  it('offers exactly the three strengths the spec names', () => {
    expect(STRENGTH_OPTIONS.map((option) => option.value)).toEqual(['low', 'medium', 'high']);
  });

  it('refuses to start a second job while one is running', () => {
    const plan = planReduceNoise({ strength: 'low', running: true });
    expect(plan).toEqual({ reason: 'Noise reduction is already running for this clip.' });
  });

  it('refuses an unknown strength rather than choosing one', () => {
    expect(planReduceNoise({ strength: 'ludicrous', running: false })).toEqual({
      reason: 'Choose a strength first.',
    });
  });

  it('passes the chosen strength through when it can', () => {
    expect(planReduceNoise({ strength: 'high', running: false })).toEqual({ strength: 'high' });
  });

  it('offers revert only when there is a copy', () => {
    expect(canRevert({ hasAudio: true })).toBe(false);
    expect(canRevert(APPLIED)).toBe(true);
  });

  it('opens the comparison on the file the project actually plays', () => {
    /*
      An A/B switch that opened on "Original" while the export used the cleaned copy would make the
      user judge the wrong file — and the mistake is invisible, because both play.
    */
    expect(comparisonSide(APPLIED, null)).toBe('cleaned');
    expect(comparisonSide({ hasAudio: true }, null)).toBe('original');
    expect(comparisonSide(APPLIED, 'original')).toBe('original');
  });
});

describe('the row, on screen', () => {
  it('starts a job with the strength that is selected', () => {
    const onReduce = vi.fn();
    render(<NoiseReductionRow item={{ hasAudio: true }} onReduce={onReduce} />);
    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reduce noise' }));
    expect(onReduce).toHaveBeenCalledWith('high');
  });

  it('says it is working and cannot be pressed again while it is', () => {
    const onReduce = vi.fn();
    render(<NoiseReductionRow item={{ hasAudio: true }} running onReduce={onReduce} />);
    const button = screen.getByRole('button', { name: /Reducing noise/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onReduce).not.toHaveBeenCalled();
  });

  it('shows the warning and the A/B toggle only once a copy is applied', () => {
    const { rerender } = render(<NoiseReductionRow item={{ hasAudio: true }} />);
    expect(screen.queryByText(NOISE_WARNING)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Compare' })).toBeNull();

    rerender(<NoiseReductionRow item={APPLIED} />);
    /*
      Both appear together and only together: a warning about a copy that does not exist, or a
      comparison of one thing with itself, would each be a control describing a state the item is
      not in.
    */
    expect(screen.getByText(NOISE_WARNING)).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Compare' })).not.toBeNull();
  });

  it('reports the comparison to the caller without touching the project', () => {
    /*
      The toggle is a callback and nothing more. If this ever started writing to the document, the
      test would need a store — its absence is the assertion that auditioning is not an edit.
    */
    const onCompare = vi.fn();
    render(<NoiseReductionRow item={APPLIED} onCompare={onCompare} />);
    fireEvent.click(screen.getByRole('button', { name: 'Original' }));
    expect(onCompare).toHaveBeenCalledWith('original');
    /* The cleaned copy is still what the project uses. */
    expect(APPLIED.noiseReduction.path).toBe('/media/a/derived/enhanced/abc.wav');
  });

  it('calls revert without asking the user to confirm', () => {
    /*
      Nothing is destroyed by reverting: the original was never written to. A confirmation dialog
      here would imply a risk that does not exist, and train the user to dismiss the ones that do.
    */
    const onRevert = vi.fn();
    render(<NoiseReductionRow item={APPLIED} onRevert={onRevert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revert to the original' }));
    expect(onRevert).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all for a clip with no audio', () => {
    const { container } = render(<NoiseReductionRow item={{ hasAudio: false }} />);
    expect(container.childElementCount).toBe(0);
  });
});
