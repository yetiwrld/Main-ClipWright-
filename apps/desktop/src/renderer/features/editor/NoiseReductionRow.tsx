/**
 * The inspector's noise-reduction row (SPEC 12 §6.8).
 *
 * The spec asks for four things and this draws exactly those: a **strength** control, a **Reduce
 * noise** button that starts a background job, an **A/B toggle** once a copy exists, and a
 * **Revert**. Every control is absent rather than disabled when it cannot do anything — a greyed
 * button teaches nothing and invites a click.
 *
 * The state and the sentences are decided in `noise-reduction-panel.ts`; this file is the drawing.
 */
import { useCallback, useState } from 'react';
import {
  canRevert,
  describeNoiseReductionRow,
  planReduceNoise,
  STRENGTH_OPTIONS,
  type ComparisonSide,
  type NoiseReductionFields,
  type Strength,
} from './noise-reduction-panel.js';

export interface NoiseReductionRowProps {
  item: NoiseReductionFields;
  /** True while a job for this item is running. */
  running?: boolean;
  /** Called with the chosen strength to start a job. */
  onReduce?: (strength: Strength) => void;
  /** Called to clear the item's field — the original is untouched, so this *is* the revert. */
  onRevert?: () => void;
  /** Called when the user auditions the other file. View state only; see the module doc. */
  onCompare?: (side: ComparisonSide) => void;
}

export function NoiseReductionRow({
  item,
  running = false,
  onReduce,
  onRevert,
  onCompare,
}: NoiseReductionRowProps): React.JSX.Element | null {
  const row = describeNoiseReductionRow(item);
  const [strength, setStrength] = useState<Strength>(row.strength);
  const [side, setSide] = useState<ComparisonSide>(() => (row.applied ? 'cleaned' : 'original'));

  const reduce = useCallback(() => {
    const plan = planReduceNoise({ strength, running });
    if ('reason' in plan) return;
    onReduce?.(plan.strength);
  }, [onReduce, running, strength]);

  const compare = useCallback(() => {
    /*
      The toggle flips *view* state and calls back so the preview can follow. It never touches the
      item: an audition that dirtied the project would turn comparing into an edit.
    */
    const next: ComparisonSide = side === 'cleaned' ? 'original' : 'cleaned';
    setSide(next);
    onCompare?.(next);
  }, [onCompare, side]);

  if (!row.visible) return null;

  return (
    <section aria-label="Noise reduction" className="noise-reduction-row">
      <header className="noise-reduction-row__header">
        <span>Noise reduction</span>
      </header>

      <div className="noise-reduction-row__strength" role="group" aria-label="Strength">
        {STRENGTH_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={strength === option.value}
            onClick={() => setStrength(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <button type="button" onClick={reduce} disabled={running} aria-busy={running}>
        {running ? 'Reducing noise…' : 'Reduce noise'}
      </button>

      <p className="noise-reduction-row__status">{row.status}</p>

      {row.canCompare ? (
        <div className="noise-reduction-row__compare" role="group" aria-label="Compare">
          <button
            type="button"
            aria-pressed={side === 'original'}
            onClick={() => {
              setSide('original');
              onCompare?.('original');
            }}
          >
            Original
          </button>
          <button type="button" aria-pressed={side === 'cleaned'} onClick={compare}>
            Cleaned
          </button>
        </div>
      ) : null}

      {row.warning ? (
        <p className="noise-reduction-row__warning" role="note">
          {row.warning}
        </p>
      ) : null}

      {canRevert(item) && onRevert ? (
        <button type="button" onClick={onRevert}>
          Revert to the original
        </button>
      ) : null}
    </section>
  );
}
