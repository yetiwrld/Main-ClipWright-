import React, { useState, useEffect, useCallback } from 'react';
import type { Route } from '../App.js';
import { api, describeError, isDesktop } from '../api.js';
import type { ProjectRecord } from '../global.js';

interface Props {
  onNavigate: (r: Route) => void;
}

type SortKey = 'updated' | 'name' | 'created';

export function ProjectsPage({ onNavigate }: Props) {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      setError('Projects live in the Clipwright desktop app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = projects
    .filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'created') return b.createdAt.localeCompare(a.createdAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Projects</h1>
        <button onClick={() => onNavigate({ name: 'home' })} style={primaryBtnStyle}>
          New project
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects…"
          style={{
            flex: '1 1 240px',
            padding: '8px 14px',
            border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-sm)',
          }}
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          style={{
            padding: '8px 12px',
            border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-sm)',
          }}
        >
          <option value="updated">Last edited</option>
          <option value="created">Recently created</option>
          <option value="name">Name</option>
        </select>
        <div style={{ display: 'flex', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <button onClick={() => setView('grid')} style={viewBtnStyle(view === 'grid')}>Grid</button>
          <button onClick={() => setView('list')} style={viewBtnStyle(view === 'list')}>List</button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{
          padding: '10px 14px', marginBottom: 16, borderRadius: 'var(--radius-md)',
          background: 'var(--danger-tint)', border: '1px solid var(--danger)',
          color: 'var(--text-primary)', fontSize: 'var(--fs-sm)',
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          Loading projects…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <p style={{ fontSize: 'var(--fs-md)', marginBottom: 16 }}>
            {projects.length === 0 ? 'No projects yet' : 'No projects match that search'}
          </p>
          {projects.length === 0 && (
            <button onClick={() => onNavigate({ name: 'home' })} style={{ color: 'var(--text-brand)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-sm)' }}>
              Start your first project →
            </button>
          )}
        </div>
      ) : view === 'grid' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => onNavigate({ name: 'project', id: p.id, stage: stageFor(p) })}
              style={{
                textAlign: 'left',
                background: 'var(--surface-card)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--line-subtle)',
                overflow: 'hidden',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <div style={{
                height: 140,
                background: 'var(--surface-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
              }}>
                <ThumbIcon />
              </div>
              <div style={{ padding: 16 }}>
                <div style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                  {p.name}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <StageChip stage={p.stage} />
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{formatRelative(p.updatedAt)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => onNavigate({ name: 'project', id: p.id, stage: stageFor(p) })}
              style={{
                display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left',
                padding: '12px 16px', borderRadius: 'var(--radius-md)',
                background: 'var(--surface-card)', border: '1px solid var(--line-subtle)',
                cursor: 'pointer', width: '100%',
              }}
            >
              <div style={{ width: 48, height: 27, background: 'var(--surface-raised)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ThumbIcon />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{p.name}</div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{formatRelative(p.updatedAt)}</div>
              </div>
              <StageChip stage={p.stage} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stageFor(p: ProjectRecord): 'import' | 'transcribe' | 'moments' | 'editor' {
  if (p.stage === 'exported') return 'editor';
  if (p.stage === 'editor') return 'editor';
  if (p.stage === 'moments') return 'moments';
  if (p.stage === 'transcribe') return 'transcribe';
  return 'import';
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 20px',
  border: 'none',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--brand)',
  color: 'var(--on-brand)',
  cursor: 'pointer',
  fontSize: 'var(--fs-sm)',
  fontWeight: 500,
};

function viewBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    border: 'none',
    background: active ? 'var(--brand-tint)' : 'transparent',
    color: active ? 'var(--text-brand)' : 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 'var(--fs-sm)',
  };
}

function StageChip({ stage }: { stage: string }) {
  const colors: Record<string, string> = {
    import: 'var(--text-muted)',
    transcribe: 'var(--brand-amber)',
    moments: 'var(--brand-strong)',
    editor: 'var(--brand)',
    exported: 'var(--success)',
  };
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 'var(--radius-full)',
      background: 'var(--surface-raised)',
      color: colors[stage] || 'var(--text-muted)',
      fontSize: 'var(--fs-xs)', fontWeight: 500,
      textTransform: 'capitalize',
    }}>
      {stage}
    </span>
  );
}

function ThumbIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}
