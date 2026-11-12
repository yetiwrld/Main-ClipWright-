import React from 'react';
import clsx from 'clsx';

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('cw-card', className)} {...rest} />;
}

export type ChipTone = 'default' | 'brand' | 'success' | 'info' | 'warning' | 'error';
export function Chip({ tone = 'default', className, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone }) {
  return <span className={clsx('cw-chip', tone !== 'default' && `cw-chip--${tone}`, className)} {...rest} />;
}

/** 0-100 score ring. <50 muted, 50-74 info, 75-89 brand, >=90 amber. */
export function ScoreRing({ score, size = 64, stroke = 5, label }: { score: number; size?: number; stroke?: number; label?: string }) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (s / 100) * circ;
  const color = s < 50 ? 'var(--text-muted)' : s < 75 ? 'var(--info)' : s < 90 ? 'var(--brand)' : 'var(--brand-amber)';
  return (
    <span className="cw-score-ring" style={{ width: size, height: size }} role="img" aria-label={`Score ${s} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--surface-pressed)" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="cw-score-ring__value" style={{ fontSize: size * 0.28 }}>{s}</span>
      {label && <span className="cw-score-ring__label">{label}</span>}
    </span>
  );
}

export function ProgressBar({ fraction }: { fraction: number }) {
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <div className="cw-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
      <div style={{ width: `${f * 100}%` }} />
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={clsx('cw-skeleton', className)} style={style} aria-hidden="true" />;
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="cw-empty-state">
      {icon && <div aria-hidden="true" style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }}>{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function PanelHeader({ title, right }: { title: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="cw-panel-header">
      <span>{title}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{right}</span>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="cw-kbd">{children}</kbd>;
}
