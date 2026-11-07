import React, { useState, useEffect } from 'react';
import type { Route } from '../App.js';
import { api, isDesktop } from '../api.js';

// Electron drag regions are valid CSS but missing from React's CSSProperties type
export const DRAG_REGION = { WebkitAppRegion: 'drag' } as unknown as React.CSSProperties;
export const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as unknown as React.CSSProperties;

interface Props {
  route: Route;
  isInProject: boolean;
  onNavigate: (r: Route) => void;
}

export function TopBar({ route, isInProject, onNavigate }: Props) {
  const [saveStatus, setSaveStatus] = useState<'Saved' | 'Saving…' | 'Recovered'>('Saved');
  const [bgTaskCount, setBgTaskCount] = useState(0);

  // Poll the persisted job list so the badge reflects real background work.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const jobs = (await api.listJobs()) as Array<{ status?: string }>;
        if (cancelled) return;
        const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused');
        setBgTaskCount(active.length);
        setSaveStatus(active.length > 0 ? 'Saving…' : 'Saved');
      } catch {
        if (!cancelled) setSaveStatus('Saved');
      }
    };

    void refresh();
    const id = setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <header
      style={{
        height: 40,
        background: 'var(--surface-app)',
        borderBottom: '1px solid var(--line-subtle)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 12,
        flexShrink: 0,
        ...DRAG_REGION,
      }}
    >
      {/* Logo */}
      <button
        onClick={() => onNavigate({ name: 'home' })}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          ...NO_DRAG_REGION,
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="var(--brand)" />
          <path d="M10 8l6 4-6 4z" fill="var(--surface-app)" />
        </svg>
      </button>

      {/* Breadcrumb / Project name */}
      {isInProject && route.name === 'project' && (
        <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-sm)', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {route.id}
        </span>
      )}

      {/* Stepper */}
      {isInProject && route.name === 'project' && (
        <Stepper stage={route.stage} onNavigate={() => {}} />
      )}

      {/* Background tasks button */}
      {bgTaskCount > 0 && (
        <button
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            position: 'relative',
            ...NO_DRAG_REGION,
            color: 'var(--text-muted)',
          }}
          title="Background tasks"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span style={{
            position: 'absolute',
            top: -4,
            right: -4,
            background: 'var(--brand)',
            color: 'var(--on-brand)',
            fontSize: 10,
            borderRadius: 'var(--radius-full)',
            padding: '0 4px',
            minWidth: 14,
            textAlign: 'center',
            lineHeight: '14px',
          }}>{bgTaskCount}</span>
        </button>
      )}

      {/* Save status */}
      {isInProject && (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', ...NO_DRAG_REGION }}>
          {saveStatus}
        </span>
      )}

      {/* Export button (editor only) */}
      {isInProject && route.name === 'project' && route.stage === 'editor' && (
        <button
          onClick={() => {}}
          style={{
            padding: '4px 12px',
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: 'var(--brand)',
            color: 'var(--on-brand)',
            fontSize: 'var(--fs-sm)',
            fontWeight: 500,
            cursor: 'pointer',
            ...NO_DRAG_REGION,
          }}
        >
          Export
        </button>
      )}
    </header>
  );
}

function Stepper({ stage, onNavigate }: { stage: string; onNavigate: () => void }) {
  const stages = ['Import', 'Transcribe', 'Moments', 'Editor'];
  const currentIndex = stages.indexOf(stage);
  const statuses = ['completed', 'active', 'running', 'not-reached'];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flex: 1, justifyContent: 'center' }}>
      {stages.map((s, i) => {
        const isActive = i === currentIndex;
        const isCompleted = i < currentIndex;
        const status = isActive ? 'active' : isCompleted ? 'completed' : i > currentIndex ? 'not-reached' : 'pending';
        return (
          <React.Fragment key={s}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px',
                borderRadius: 'var(--radius-pill)',
                background: status === 'active' ? 'var(--brand-tint)' : 'transparent',
                color: status === 'active' ? 'var(--text-brand)' : status === 'completed' ? 'var(--text-primary)' : 'var(--text-muted)',
                fontSize: 'var(--fs-xs)',
                cursor: status === 'completed' || status === 'active' ? 'pointer' : 'default',
                opacity: status === 'not-reached' ? 0.4 : 1,
              }}
              onClick={() => status !== 'not-reached' && onNavigate()}
            >
              {isCompleted && <span style={{ fontSize: 12 }}>✓</span>}
              {s}
            </div>
            {i < stages.length - 1 && (
              <span style={{ color: 'var(--line-default)', fontSize: 12 }}>·</span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
