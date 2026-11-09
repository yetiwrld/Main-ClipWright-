/**
 * The composition grid controls (SPEC 10 §8.8).
 *
 * Two ways to say the same thing: the spec's default (the thirds) or any N×M the user
 * wants. Presented as a *setting* rather than as a second toggle, because the spec
 * describes one overlay with two options — so this picks what `Ctrl+'` will draw, and
 * turning the grid back on after this restores the choice rather than the default.
 *
 * The dialog edits a draft. Nothing is applied until *Apply*, so typing `1` on the way to
 * `12` does not flash a grid with one column — and a value that cannot be used is refused
 * with a reason rather than clamped behind the user's back, because a grid silently
 * becoming 2×2 is a mystery and a message is not.
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, Input } from '@clipwright/design-system';
import { GRID_MAX, GRID_MIN, clampDivisor, effectiveGrid, type GridChoice } from './grid.js';

export interface GridDialogProps {
  open: boolean;
  /** The setting in force when the dialog opened — the draft starts from it. */
  value: GridChoice;
  onClose: () => void;
  onApply: (next: GridChoice) => void;
}

/** One number field, with the validity of what is currently typed. */
function DivisorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>{label}</span>
      <Input
        aria-label={label}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function GridDialog({ open, value, onClose, onApply }: GridDialogProps) {
  const current = effectiveGrid(value);
  const [columns, setColumns] = useState(String(current.columns));
  const [rows, setRows] = useState(String(current.rows));

  /*
    Re-seed the draft whenever the dialog opens, from whatever is in force then. Without
    this the fields would keep the last edit even if it was cancelled, and *Apply* would
    then look like it did nothing.
  */
  useEffect(() => {
    if (!open) return;
    const spec = effectiveGrid(value);
    setColumns(String(spec.columns));
    setRows(String(spec.rows));
  }, [open, value]);

  const nextColumns = clampDivisor(columns);
  const nextRows = clampDivisor(rows);
  const valid = nextColumns !== null && nextRows !== null;

  return (
    <Dialog
      open={open}
      title="Composition grid"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              // Straight to the spec's default, which is also how the dialog resets.
              onApply({ preset: 'thirds' });
            }}
          >
            Use thirds
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (nextColumns === null || nextRows === null) return;
              /*
                Choosing 3×3 *is* the thirds, so it is stored as the preset rather than as a
                custom 3×3: the two draw identically, and keeping the preset means the menu
                can still say "default" about it instead of implying the user configured
                something they did not.
              */
              onApply(
                nextColumns === 3 && nextRows === 3
                  ? { preset: 'thirds' }
                  : { preset: 'custom', spec: { columns: nextColumns, rows: nextRows } },
              );
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={{ margin: 0 }}>
          The grid divides the frame into equal cells. Its lines are snap targets while it
          is showing, on <kbd>Ctrl</kbd>+<kbd>'</kbd>.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <DivisorField label="Columns" value={columns} onChange={setColumns} />
          <DivisorField label="Rows" value={rows} onChange={setRows} />
        </div>
        {/*
          The range is stated rather than only enforced. The fields are free text because a
          number input that silently refuses keystrokes is worse than one that says why —
          `2.5` and `99` are both things someone will type.
        */}
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          {GRID_MIN}–{GRID_MAX} each. A grid of one would be the frame edge, which is
          already a snap target.
        </p>
      </div>
    </Dialog>
  );
}
