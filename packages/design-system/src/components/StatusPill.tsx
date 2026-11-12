import React from 'react';
import clsx from 'clsx';

export type StatusTone = 'default' | 'success' | 'info' | 'warning' | 'error';

export function StatusPill({ tone = 'default', children, className }: { tone?: StatusTone; children: React.ReactNode; className?: string }) {
  const color = {
    default: 'var(--text-secondary)', success: 'var(--success)', info: 'var(--info)',
    warning: 'var(--warning)', error: 'var(--error)',
  }[tone];
  return (
    <span
      className={clsx('cw-status-pill', className)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px',
        borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-xs)', color,
        background: 'var(--surface-card)', border: '1px solid var(--line-default)',
        fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {children}
    </span>
  );
}
