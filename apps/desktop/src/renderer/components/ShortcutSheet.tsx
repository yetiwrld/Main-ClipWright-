/**
 * Spec 02 §2.6 — the Ctrl+/ shortcut cheat sheet.
 *
 * Lists exactly what the app implements, and says plainly which shortcuts do
 * nothing yet. A cheat sheet that lists shortcuts that do not work is worse than
 * no cheat sheet: the user presses Ctrl+O a few times, concludes the app is
 * broken, and stops trusting the rest of it.
 */
import React from 'react';
import { Dialog } from '@clipwright/design-system';

interface Row {
  keys: string;
  action: string;
  /** Set when the shortcut is listed by the spec but not implemented yet. */
  unavailable?: string;
}

const ROWS: Row[] = [
  { keys: 'Ctrl+K', action: 'Command palette — every action and page' },
  { keys: 'Ctrl+N', action: 'Start a new project' },
  { keys: 'Ctrl+,', action: 'Settings' },
  { keys: 'Ctrl+/', action: 'This list' },
  { keys: 'Esc', action: 'Close the open dialog' },
  { keys: 'Ctrl+O', action: 'Open a video file', unavailable: 'Start a project and drop the file in instead' },
  { keys: 'Ctrl+S', action: 'Save', unavailable: 'Saving is continuous, so there is nothing to trigger' },
];

export interface ShortcutSheetProps {
  onClose: () => void;
}

export function ShortcutSheet({ onClose }: ShortcutSheetProps) {
  return (
    <Dialog open onClose={onClose} title="Keyboard shortcuts">
      <dl className="flex flex-col gap-[var(--space-2)]" data-testid="shortcut-sheet">
        {ROWS.map((row) => (
          <div key={row.keys} className="flex items-baseline justify-between gap-[var(--space-4)]">
            <dt className="shrink-0">
              <kbd className={KBD}>{row.keys}</kbd>
            </dt>
            <dd className="flex flex-col items-end text-right">
              <span className={TEXT}>{row.action}</span>
              {row.unavailable && (
                <span className={MUTED} data-testid={`shortcut-unavailable-${row.keys}`}>
                  {row.unavailable}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

const KBD =
  'rounded-[var(--radius-sm)] border border-[var(--line-subtle)] bg-[var(--surface-raised)] px-[var(--space-2)] py-[var(--space-1)] font-mono text-[length:var(--fs-xs)] text-[var(--text-primary)]';
const TEXT = 'text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const MUTED = 'text-[length:var(--fs-xs)] text-[var(--text-secondary)]';
