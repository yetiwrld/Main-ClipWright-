/**
 * SPEC 15 §4.1 — the top-bar "Update available" chip.
 *
 * Deliberately quiet: a filled dot rather than a bouncing badge, because an
 * update is never urgent enough to interrupt editing. It is a button, not a
 * link, so it is reachable by keyboard like everything else on the bar.
 */
import React from 'react';
import { NO_DRAG_REGION } from '../../components/TopBar.js';

export interface UpdateChipProps {
  label: string;
  onSelect: () => void;
}

export function UpdateChip({ label, onSelect }: UpdateChipProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="update-chip"
      title="An update is available"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 10px',
        borderRadius: 'var(--radius-full)',
        border: '1px solid var(--brand)',
        background: 'var(--brand-tint)',
        color: 'var(--text-primary)',
        fontSize: 'var(--fs-xs)',
        fontWeight: 500,
        cursor: 'pointer',
        ...NO_DRAG_REGION,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 'var(--radius-full)',
          background: 'var(--brand)',
          flexShrink: 0,
        }}
      />
      {label}
    </button>
  );
}
