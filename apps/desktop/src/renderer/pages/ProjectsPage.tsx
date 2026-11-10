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
  /** The project whose ⋯ menu is open, by id — one at a time, so two menus cannot both be up. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** What the user is being asked to confirm, if anything. */
  const [confirming, setConfirming] = useState<
    | { kind: 'delete'; project: ProjectRecord }
    | { kind: 'rename'; project: ProjectRecord }
    | null
  >(null);
  const [renameTo, setRenameTo] = useState('');
  const [deleteMedia, setDeleteMedia] = useState(false);
  const [busy, setBusy] = useState(false);

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

  /*
    SPEC 03 §10: the project actions. All of them were implemented in `StorageService` and tested
    there; none was reachable from the window, so an app with code for renaming, duplicating,
    archiving and deleting could do none of them.
  */
  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError('');
      try {
        await action();
        setMenuFor(null);
        setConfirming(null);
        await load();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const handleRename = useCallback(() => {
    const project = confirming?.kind === 'rename' ? confirming.project : null;
    const name = renameTo.trim();
    if (!project) return;
    if (!name) {
      setError('A project needs a name.');
      return;
    }
    void runAction(async () => {
      await api.updateProject(project.id, { name });
    });
  }, [confirming, renameTo, runAction]);

  const handleDuplicate = useCallback(
    (project: ProjectRecord) => {
      void runAction(async () => {
        await api.duplicateProject(project.id);
      });
    },
    [runAction],
  );

  const handleArchive = useCallback(
    (project: ProjectRecord) => {
      /*
        Archive is a value, not a one-way door: §8's "hides from Home; read-only until unarchived"
        means the same action restores it. The list shows archived projects greyed, so the way back
        is visible rather than a hidden state.
      */
      void runAction(async () => {
        await api.archiveProject(project.id, !project.archived);
      });
    },
    [runAction],
  );

  const handleReveal = useCallback(
    (project: ProjectRecord) => {
      /*
        Closes the menu before the OS takes focus — a menu left open behind a file manager is a
        stray click waiting to happen when the user comes back.
      */
      setMenuFor(null);
      void runAction(async () => {
        await api.revealProject(project.id);
      });
    },
    [runAction],
  );

  const handleDelete = useCallback(() => {
    const project = confirming?.kind === 'delete' ? confirming.project : null;
    if (!project) return;
    void runAction(async () => {
      await api.deleteProject(project.id, { deleteMedia });
    });
  }, [confirming, deleteMedia, runAction]);

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
            /*
              The card is a plain container and the *title area* is the button. A button cannot
              contain another button, and the ⋯ menu has to sit inside the card — nesting one would
              make the menu unclickable in some browsers and would make the whole card read as a
              single control to a screen reader.
            */
            <div
              key={p.id}
              style={{
                position: 'relative',
                background: 'var(--surface-card)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--line-subtle)',
                overflow: 'hidden',
                opacity: p.archived ? 0.6 : 1,
              }}
            >
              <ProjectMenu
                project={p}
                open={menuFor === p.id}
                busy={busy}
                onToggle={() => setMenuFor(menuFor === p.id ? null : p.id)}
                onOpen={() => onNavigate({ name: 'project', id: p.id, stage: stageFor(p) })}
                onRename={() => {
                  setRenameTo(p.name);
                  setMenuFor(null);
                  setConfirming({ kind: 'rename', project: p });
                }}
                onDuplicate={() => handleDuplicate(p)}
                onArchive={() => handleArchive(p)}
                onReveal={() => handleReveal(p)}
                onDelete={() => {
                  setDeleteMedia(false);
                  setMenuFor(null);
                  setConfirming({ kind: 'delete', project: p });
                }}
              />
              <button
                onClick={() => onNavigate({ name: 'project', id: p.id, stage: stageFor(p) })}
                style={{
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  width: '100%',
                  display: 'block',
                  color: 'inherit',
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
                  {p.archived && (
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Archived</span>
                  )}
                </div>
              </div>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((p) => (
            <div
              key={p.id}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-card)', border: '1px solid var(--line-subtle)',
                opacity: p.archived ? 0.6 : 1,
              }}
            >
              <ProjectMenu
                project={p}
                open={menuFor === p.id}
                busy={busy}
                onToggle={() => setMenuFor(menuFor === p.id ? null : p.id)}
                onOpen={() => onNavigate({ name: 'project', id: p.id, stage: stageFor(p) })}
                onRename={() => {
                  setRenameTo(p.name);
                  setMenuFor(null);
                  setConfirming({ kind: 'rename', project: p });
                }}
                onDuplicate={() => handleDuplicate(p)}
                onArchive={() => handleArchive(p)}
                onReveal={() => handleReveal(p)}
                onDelete={() => {
                  setDeleteMedia(false);
                  setMenuFor(null);
                  setConfirming({ kind: 'delete', project: p });
                }}
              />
              <button
                onClick={() => onNavigate({ name: 'project', id: p.id, stage: stageFor(p) })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left',
                  padding: '12px 16px', background: 'transparent', border: 'none',
                  cursor: 'pointer', width: '100%', color: 'inherit',
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
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.kind === 'delete' ? 'Delete this project?' : 'Rename project'}
          busy={busy}
          confirmLabel={confirming.kind === 'delete' ? 'Delete' : 'Rename'}
          destructive={confirming.kind === 'delete'}
          onCancel={() => {
            setConfirming(null);
            setError('');
          }}
          onConfirm={confirming.kind === 'delete' ? handleDelete : handleRename}
        >
          {confirming.kind === 'delete' ? (
            <>
              {/*
                SPEC 03 §8: deleting a project never deletes referenced originals, and managed
                media goes only when the box is ticked. Both sentences are shown rather than
                assumed — this is the one action in the list that cannot be undone.
              */}
              <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{confirming.project.name}</strong> and its
                edits will be removed. Originals you linked to stay where they are.
              </p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={deleteMedia}
                  onChange={(e) => setDeleteMedia(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  Also delete this project's copied media
                  {confirming.project.sourceMediaIds.length > 0
                    ? ` (${confirming.project.sourceMediaIds.length} item${confirming.project.sourceMediaIds.length === 1 ? '' : 's'})`
                    : ''}
                  . Copies another project still uses are kept.
                </span>
              </label>
            </>
          ) : (
            <input
              autoFocus
              aria-label="Project name"
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
              }}
              maxLength={200}
              style={{
                width: '100%', padding: '8px 12px', border: '1px solid var(--line-default)',
                borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)',
                color: 'var(--text-primary)', fontSize: 'var(--fs-sm)',
              }}
            />
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * SPEC 02 §6 / SPEC 03 §10 — the ⋯ menu on a project.
 *
 * A plain absolutely-positioned list rather than a portal: the card is the only thing that needs to
 * stay above it, and a portal would have to be repositioned on scroll for no gain here.
 */
function ProjectMenu({
  project,
  open,
  busy,
  onToggle,
  onOpen,
  onRename,
  onDuplicate,
  onArchive,
  onReveal,
  onDelete,
}: {
  project: ProjectRecord;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  /* SPEC 03 §10's order: Open, Rename, Duplicate, Archive, Show in folder, Delete. */
  const items: Array<{ label: string; onSelect: () => void; danger?: boolean }> = [
    { label: 'Open', onSelect: onOpen },
    { label: 'Rename', onSelect: onRename },
    { label: 'Duplicate', onSelect: onDuplicate },
    { label: project.archived ? 'Unarchive' : 'Archive', onSelect: onArchive },
    { label: 'Show in folder', onSelect: onReveal },
    { label: 'Delete', onSelect: onDelete, danger: true },
  ];
  return (
    <>
      <button
        /* `aria-haspopup`/`aria-expanded` so the menu announces itself; the label names the project
           so a screen reader hears *which* card's menu this is among several identical ⋯s. */
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${project.name}`}
        disabled={busy}
        onClick={onToggle}
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 2,
          width: 28, height: 28, padding: 0,
          border: '1px solid var(--line-subtle)', borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-raised)', color: 'var(--text-secondary)',
          cursor: busy ? 'progress' : 'pointer', fontSize: 'var(--fs-md)', lineHeight: '20px',
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${project.name}`}
          style={{
            position: 'absolute', top: 40, right: 8, zIndex: 3, minWidth: 160,
            display: 'flex', flexDirection: 'column', padding: 4,
            background: 'var(--surface-overlay)', border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-menu)',
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={item.onSelect}
              disabled={busy}
              style={{
                textAlign: 'left', padding: '6px 10px', border: 'none', background: 'transparent',
                borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--fs-sm)',
                color: item.danger ? 'var(--danger)' : 'var(--text-primary)',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'var(--surface-overlay)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: '100%', maxWidth: 440, padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
          background: 'var(--surface-card)', border: '1px solid var(--line-default)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-dialog)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)', color: 'var(--text-primary)' }}>{title}</h2>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '8px 16px', border: '1px solid var(--line-default)',
              borderRadius: 'var(--radius-pill)', background: 'transparent',
              color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 'var(--fs-sm)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: '8px 16px', border: 'none', borderRadius: 'var(--radius-pill)',
              background: destructive ? 'var(--danger)' : 'var(--brand)',
              color: destructive ? 'var(--text-primary)' : 'var(--on-brand)',
              cursor: busy ? 'progress' : 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 500,
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
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
