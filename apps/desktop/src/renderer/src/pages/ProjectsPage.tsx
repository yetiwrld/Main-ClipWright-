import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileVideo, Trash2, Copy, Archive, ArchiveRestore, Search } from 'lucide-react';
import { Button, IconButton, EmptyState, StatusPill } from '@clipwright/design-system';
import { api, type ProjectRecord } from '../api.js';
import { useAppStore } from '../stores.js';
import { fmtRelativeTime } from '../format.js';

export const ProjectsPage = () => {
  const toast = useAppStore((s) => s.toast);
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.projects.list().then(setProjects).catch(() => setProjects([]));
  }, [tick]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try { await fn(); setTick((n) => n + 1); }
    catch (err) { toast(err instanceof Error ? err.message : 'That didn’t work.', 'error'); }
  }, [toast]);

  const q = query.trim().toLowerCase();
  const filtered = projects
    .filter((p) => (showArchived ? true : !p.archived))
    .filter((p) => !q || p.name.toLowerCase().includes(q));

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
        <div style={{ flex: 1 }}>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>{projects.length} project{projects.length === 1 ? '' : 's'} in this workspace</p>
        </div>
        <label style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={16} aria-hidden style={{ position: 'absolute', left: 10, color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            className="cw-input" style={{ paddingLeft: 34, width: 260 }}
            placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects"
          />
        </label>
        <Button variant={showArchived ? 'primary' : 'secondary'} onClick={() => setShowArchived((v) => !v)} aria-pressed={showArchived}>
          {showArchived ? 'Showing archived' : 'Show archived'}
        </Button>
      </div>

      {filtered.length === 0 && (
        <EmptyState
          icon={<FileVideo size={40} strokeWidth={1.5} />}
          title={q ? 'No projects match' : 'No projects yet'}
        >
          {q ? 'Try a different search.' : 'Projects you create from the Home screen will show up here.'}
        </EmptyState>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {filtered.map((p) => (
          <div
            key={p.id}
            className="moment-card"
            role="button" tabIndex={0}
            onClick={() => navigate(p.stage === 'moments-ready' || p.stage === 'editor' || p.stage === 'exported' ? `/editor/${p.id}` : `/project/${p.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/project/${p.id}`); }}
            style={{ justifyContent: 'space-between' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
              <div className="library-item__thumb"><FileVideo size={20} strokeWidth={1.5} /></div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420 }}>{p.name}</div>
                <div className="moment-card__meta"><span>Updated {fmtRelativeTime(p.updatedAt)}</span>{p.archived && <span>· archived</span>}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }} onClick={(e) => e.stopPropagation()}>
              <StatusPill tone={p.stage === 'exported' ? 'success' : p.stage.endsWith('failed') ? 'error' : 'info'}>
                {p.stage === 'moments-ready' ? 'Moments ready' : p.stage.endsWith('failed') ? 'Failed' : p.stage === 'exported' ? 'Exported' : 'In progress'}
              </StatusPill>
              <IconButton aria-label="Duplicate project" size="20" onClick={() => void act(() => api.projects.duplicate(p.id))}><Copy size={16} /></IconButton>
              <IconButton aria-label={p.archived ? 'Unarchive' : 'Archive'} size="20" onClick={() => void act(() => api.projects.update(p.id, { archived: !p.archived }))}>
                {p.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
              </IconButton>
              <IconButton aria-label="Delete project" size="20" onClick={() => {
                if (window.confirm(`Delete “${p.name}”? This moves its files to the trash and cannot be undone.`)) void act(() => api.projects.delete(p.id));
              }}>
                <Trash2 size={16} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
