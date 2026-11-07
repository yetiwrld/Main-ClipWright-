import React, { useState, useEffect } from 'react';

export type StageState = 'running' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'complete';

export interface SubStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface StageProgressConfig {
  title: string;
  reasonLine: string;
  state: StageState;
  percent: number;
  detail?: string;
  etaSec?: number | null;
  elapsedSec?: number;
  subSteps?: SubStep[];
  errorMessage?: string;
  onCancel?: () => void;
  onContinue?: () => void;
  onRetry?: () => void;
}

export function StageProgressScreen(config: StageProgressConfig) {
  const [displayPercent, setDisplayPercent] = useState(0);

  useEffect(() => {
    const id = requestAnimationFrame(() => setDisplayPercent(config.percent));
    return () => cancelAnimationFrame(id);
  }, [config.percent]);

  const isComplete = config.state === 'complete';
  const isFailed = config.state === 'failed';
  const isCancelled = config.state === 'cancelled';
  const isCancelling = config.state === 'cancelling';
  const isPaused = config.state === 'paused';

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 24px',
    }}>
      <div style={{
        maxWidth: 720,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 24,
      }}>
        {/* Title */}
        <h2 style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          {config.title}
        </h2>

        {/* Hero percentage + ring/bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div style={{ position: 'relative', width: 96, height: 96 }}>
            <svg width="96" height="96" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="42" fill="none" stroke="var(--surface-raised)" strokeWidth="6" />
              <circle
                cx="48" cy="48" r="42" fill="none"
                strokeWidth="6"
                strokeDasharray={`${2 * Math.PI * 42}`}
                strokeDashoffset={`${2 * Math.PI * 42 * (1 - displayPercent / 100)}`}
                strokeLinecap="round"
                transform="rotate(-90 48 48)"
                stroke={isComplete ? 'var(--success)' : isFailed ? 'var(--danger)' : 'var(--brand-strong)'}
                style={{ transition: 'stroke-dashoffset var(--dur-slow)' }}
              />
            </svg>
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--fs-xl)', fontWeight: 700,
              color: isFailed ? 'var(--danger)' : isComplete ? 'var(--success)' : 'var(--text-primary)',
            }}>
              {Math.round(displayPercent)}%
            </div>
          </div>

          {/* Wide bar alternative for running */}
          {!isComplete && !isFailed && (
            <div style={{ width: 200, height: 8, background: 'var(--surface-raised)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
              <div style={{
                width: `${displayPercent}%`, height: '100%',
                background: 'linear-gradient(90deg, var(--brand-strong), var(--brand-amber))',
                transition: 'width var(--dur-slow)',
              }} />
            </div>
          )}
        </div>

        {/* Reason line */}
        <p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-secondary)', margin: 0, textAlign: 'center' }}>
          {config.reasonLine}
        </p>

        {/* Stage illustration */}
        <div style={{
          width: 128, height: 128,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--brand)',
        }}>
          {config.title.includes('Download') && <DownloadIcon />}
          {config.title.includes('Transcribe') && <TranscribeIcon />}
          {config.title.includes('Moment') && <ScanIcon />}
          {config.title.includes('Load') && <LoadIcon />}
        </div>

        {/* Detail row */}
        {!isComplete && !isFailed && !isCancelled && (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', textAlign: 'center' }}>
            {config.detail || ''}
            {config.etaSec !== undefined && config.etaSec !== null && (
              <span> · ETA {formatEta(config.etaSec)}</span>
            )}
            {config.elapsedSec !== undefined && (
              <span> · Elapsed {formatEta(config.elapsedSec)}</span>
            )}
          </div>
        )}

        {/* Sub-steps */}
        {config.subSteps && config.subSteps.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            {config.subSteps.map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                {step.status === 'done' && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
                {step.status === 'running' && <span className="spinner" style={{ width: 14, height: 14, border: '2px solid var(--line-default)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite', display: 'inline-block' }} />}
                {step.status === 'pending' && <span style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--line-default)', display: 'inline-block' }} />}
                {step.status === 'failed' && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>}
                <span style={{ color: step.status === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)' }}>{step.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Complete state */}
        {isComplete && (
          <div style={{ textAlign: 'center', color: 'var(--success)', fontSize: 'var(--fs-md)', fontWeight: 500 }}>
            ✓ Done
          </div>
        )}

        {/* Failed state */}
        {isFailed && (
          <div style={{
            width: '100%', padding: 20, borderRadius: 'var(--radius-lg)',
            background: 'var(--danger-tint)', border: '1px solid var(--danger)',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-primary)', margin: 0 }}>
              {config.errorMessage || 'Something went wrong.'}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {config.onRetry && (
                <button onClick={config.onRetry} style={btnStyle('secondary')}>Retry</button>
              )}
              <button onClick={config.onCancel} style={btnStyle('ghost')}>Details</button>
            </div>
          </div>
        )}

        {/* Cancelled state */}
        {isCancelled && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 'var(--fs-md)' }}>
            Cancelled — partial work saved
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              {config.onRetry && <button onClick={config.onRetry} style={btnStyle('primary')}>Resume</button>}
              <button style={btnStyle('secondary')}>Start over</button>
            </div>
          </div>
        )}

        {/* Actions */}
        {!isComplete && !isCancelled && (
          <div style={{ display: 'flex', gap: 8 }}>
            {config.onCancel && (
              <button onClick={config.onCancel} disabled={isCancelling} style={btnStyle('secondary', isCancelling)}>
                {isCancelling ? 'Stopping…' : 'Cancel'}
              </button>
            )}
            {config.onContinue && (
              <button onClick={config.onContinue} style={btnStyle('ghost')}>Continue in background</button>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function btnStyle(variant: 'primary' | 'secondary' | 'ghost', disabled = false): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '8px 20px',
    borderRadius: 'var(--radius-pill)',
    fontSize: 'var(--fs-sm)',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: 'none',
    opacity: disabled ? 0.5 : 1,
  };
  if (variant === 'primary') return { ...base, background: 'var(--brand)', color: 'var(--on-brand)' };
  if (variant === 'secondary') return { ...base, background: 'var(--surface-raised)', color: 'var(--text-primary)', border: '1px solid var(--line-default)' };
  return { ...base, background: 'transparent', color: 'var(--text-muted)' };
}

function formatEta(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function DownloadIcon() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M48 8v40" />
      <polyline points="32 28 48 44 64 28" />
      <path d="M20 68v8a4 4 0 0 0 4 4h48a4 4 0 0 0 4-4v-8" />
    </svg>
  );
}

function TranscribeIcon() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 50c0-10 8-18 18-18s18 8 18 18" />
      <path d="M26 50c0-10 8-18 18-18s18 8 18 18" />
      <path d="M44 50c0-10 8-18 18-18s18 8 18 18" />
      <path d="M8 68c0-8 6-14 14-14s14 6 14 14" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="16" y="20" width="64" height="56" rx="4" />
      <path d="M16 32h64" />
      <path d="M24 44h32M24 52h40M24 60h24" />
    </svg>
  );
}

function LoadIcon() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="48" cy="48" r="36" />
      <polyline points="36 48 48 60 60 48" />
    </svg>
  );
}
