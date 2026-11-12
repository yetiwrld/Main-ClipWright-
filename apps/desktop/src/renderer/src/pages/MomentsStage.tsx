import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Star, ThumbsDown, Check, ChevronRight, Loader2, AlertCircle, Clapperboard } from 'lucide-react';
import { Button, ScoreRing, EmptyState, ProgressBar } from '@clipwright/design-system';
import { api, type Moment, type ProjectRecord } from '../api.js';
import { useAppStore } from '../stores.js';
import { fmtDuration } from '../format.js';
import type { Job } from '@clipwright/project-schema';

const BARS: Array<{ key: keyof Moment['breakdown']; label: string; max: number }> = [
  { key: 'hook', label: 'Hook', max: 20 },
  { key: 'standalone', label: 'Standalone', max: 20 },
  { key: 'emotion', label: 'Emotion', max: 15 },
  { key: 'interest', label: 'Interest', max: 15 },
  { key: 'story', label: 'Story', max: 10 },
  { key: 'value', label: 'Value', max: 10 },
  { key: 'pacing', label: 'Pacing', max: 5 },
  { key: 'social', label: 'Social', max: 5 },
];

export const MomentsStage = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useAppStore((s) => s.toast);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<'score' | 'time'>('score');
  const [filter, setFilter] = useState<'all' | 'favourites'>('all');

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const [p, list, jobList] = await Promise.all([api.projects.get(projectId), api.moments.load(projectId), api.jobs.list()]);
      setProject(p);
      setMoments(list);
      setJobs([...jobList.active, ...jobList.recent]);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load moments.', 'error');
    }
  }, [projectId, toast]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const active = jobs.some((j) => j.type === 'moments' && j.status === 'running');
    if (!active) return;
    const t = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(t);
  }, [jobs, refresh]);

  // auto-run analysis once if nothing is loaded and no job is running
  useEffect(() => {
    if (!projectId || !project) return;
    const running = jobs.some((j) => j.type === 'moments' && (j.status === 'running' || j.status === 'queued'));
    if (moments.length === 0 && !running && project.stage !== 'moments-ready') {
      api.moments.run(projectId).then(() => void refresh()).catch(() => undefined);
    }
  }, [projectId, project, moments.length, jobs, refresh]);

  const momentsJob = jobs.find((j) => j.type === 'moments');
  const running = momentsJob?.status === 'running' || momentsJob?.status === 'queued';
  const progress = momentsJob?.progress ?? 0;


  const sorted = useMemo(() => {
    let list = [...moments];
    if (filter === 'favourites') list = list.filter((m) => m.status === 'favourite');
    list.sort((a, b) => (sort === 'score' ? (b.score ?? 0) - (a.score ?? 0) : (a.startUs ?? 0) - (b.startUs ?? 0)));
    return list;
  }, [moments, sort, filter]);

  const selected = moments.find((m) => m.id === selectedId) ?? null;

  const toggle = (id: string) =>
    setChecked((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const setStatus = async (id: string, status: Moment['status']) => {
    if (!projectId) return;
    try {
      await api.moments.setStatus(projectId, id, status);
      setMoments((list) => list.map((m) => (m.id === id ? { ...m, status } : m)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the moment.', 'error');
    }
  };

  const createClips = async () => {
    if (!projectId || checked.size === 0) return;
    setCreating(true);
    try {
      const res = await api.moments.createClips(projectId, [...checked]);
      if (res.created.length > 0) toast(`${res.created.length} clip${res.created.length > 1 ? 's' : ''} created.`);
      if (res.errors.length > 0) toast(`${res.errors.length} clip${res.errors.length > 1 ? 's' : ''} failed: ${res.errors[0]!.error}`, 'error');
      const first = res.created[0];
      if (first) navigate(`/editor/${projectId}/${first.compId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The clips could not be created.', 'error');
    } finally { setCreating(false); }
  };

  if (!projectId) return null;

  return (
    <div className="moments-layout">
      <aside className="moments-list" aria-label="Moments">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-1) var(--space-1) 0' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className={`num-tile${sort === 'score' ? ' num-tile--selected' : ''}`} style={{ width: 64, height: 28 }} onClick={() => setSort('score')}>Score</button>
            <button className={`num-tile${sort === 'time' ? ' num-tile--selected' : ''}`} style={{ width: 64, height: 28 }} onClick={() => setSort('time')}>Time</button>
          </div>
          <button className={`num-tile${filter === 'favourites' ? ' num-tile--selected' : ''}`} style={{ width: 96, height: 28 }} onClick={() => setFilter(filter === 'all' ? 'favourites' : 'all')} aria-pressed={filter === 'favourites'}>
            <Star size={12} aria-hidden style={{ verticalAlign: -1 }} /> Favourites
          </button>
        </div>

        {running && (
          <div className="stage-card" style={{ padding: 'var(--space-4)', textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Loader2 size={16} className="spin" aria-hidden />
              <strong style={{ fontSize: 'var(--fs-sm)' }}>Finding moments…</strong>
            </div>
            <ProgressBar fraction={progress} />
            <p className="honesty" style={{ marginTop: 8 }}>Scoring candidate moments with {project?.settings.processingMode === 'offline' ? 'on-device Ollama' : project?.settings.processingMode === 'online' ? 'your online provider' : 'Ollama, then online, then offline heuristics'}.</p>
          </div>
        )}

        {!running && moments.length === 0 && (
          <EmptyState
            icon={<Clapperboard size={36} strokeWidth={1.5} />}
            title="No moments yet"
          >
            {project?.stage === 'transcribe-failed'
              ? 'Transcription failed for this project. Go back and retry it from the project page.'
              : 'Analysis will appear here once the transcript is ready.'}
            <div style={{ marginTop: 12 }}>
              <Button variant="primary" onClick={() => void api.moments.run(projectId).then(refresh)}>Run analysis</Button>
            </div>
          </EmptyState>
        )}

        {sorted.map((m) => {
          const selectedCard = selectedId === m.id;
          const rejected = m.status === 'rejected';
          return (
            <div
              key={m.id}
              role="button" tabIndex={0}
              className={`moment-card${selectedCard ? ' moment-card--selected' : ''}${rejected ? ' moment-card--rejected' : ''}`}
              onClick={() => setSelectedId(m.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedId(m.id); }}
              aria-pressed={selectedCard}
            >
              <input
                type="checkbox" checked={checked.has(m.id)} onChange={() => toggle(m.id)}
                onClick={(e) => e.stopPropagation()} aria-label="Select moment for clipping"
                style={{ width: 18, height: 18, accentColor: 'var(--brand)' }}
              />
              <ScoreRing score={m.score ?? 0} size={48} stroke={4} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="moment-card__title">{m.title}</p>
                <p className="moment-card__reason">{m.reasons[0] ?? ''}</p>
                <div className="moment-card__meta">
                  <span>{fmtDuration(m.startUs)}–{fmtDuration(m.endUs)}</span>
                  <span>{Math.round((m.endUs - m.startUs) / 1_000_000)}s</span>
                  {m.status === 'favourite' && <Star size={12} aria-label="Favourite" />}
                  {m.status === 'clip-created' && <Check size={12} aria-label="Clip created" />}
                </div>
              </div>
            </div>
          );
        })}
      </aside>

      <section className="preview-pane" aria-label="Moment preview">
        {selected ? (
          <>
            <div className="preview-frame" style={{ width: 320, height: 568 }}>
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--surface-card)' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', textAlign: 'center', padding: 16 }}>
                  Preview appears here after the clip is created<br />(source seeking comes with the editor)
                </span>
              </div>
              <div className="moment-caption-overlay" style={{ bottom: '18%', fontSize: 18 }}>
                {(selected.excerpt || selected.title || '').toUpperCase().slice(0, 42)}
              </div>
            </div>

            <div style={{ maxWidth: 560, width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <h1 className="page-title" style={{ fontSize: 'var(--fs-xl)', margin: 0, flex: 1 }}>{selected.title}</h1>
                <ScoreRing score={selected.score ?? 0} size={56} stroke={5} />
              </div>
              <p className="page-sub" style={{ marginBottom: 12 }}>{selected.reasons[0] ?? ''}</p>
              <div className="detail-row" style={{ justifyContent: 'flex-start', margin: 0 }}>
                <span>{fmtDuration(selected.startUs)} → {fmtDuration(selected.endUs)}</span>
                <span>{Math.round((selected.endUs - selected.startUs) / 1_000_000)}s long</span>
                <span>Hook in first {Math.min(3, Math.round((selected.endUs - selected.startUs) / 1_000_000))}s</span>
              </div>
              <div className="moment-score-bars">
                {BARS.map(({ key, label, max }) => {
                  const v = Number((selected.breakdown as Record<string, number>)[key] ?? 0);
                  return (
                    <div key={key} className="score-bar">
                      <span>{label}</span>
                      <div className="score-bar__track"><div className="score-bar__fill" style={{ width: `${Math.min(100, (v / max) * 100)}%` }} /></div>
                      <span>{Math.round(v)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <Button variant={selected.status === 'favourite' ? 'primary' : 'secondary'} onClick={() => void setStatus(selected.id, selected.status === 'favourite' ? 'candidate' : 'favourite')} aria-pressed={selected.status === 'favourite'}>
                  <Star size={16} aria-hidden /> {selected.status === 'favourite' ? 'Favourited' : 'Favourite'}
                </Button>
                <Button variant={selected.status === 'rejected' ? 'danger' : 'secondary'} onClick={() => void setStatus(selected.id, selected.status === 'rejected' ? 'candidate' : 'rejected')} aria-pressed={selected.status === 'rejected'}>
                  <ThumbsDown size={16} aria-hidden /> {selected.status === 'rejected' ? 'Rejected' : 'Reject'}
                </Button>
                <div style={{ flex: 1 }} />
                <Button variant="primary" size="36" onClick={() => { setChecked(new Set([selected.id])); }}>
                  Create clip from this <ChevronRight size={16} aria-hidden />
                </Button>
              </div>
              <p className="honesty" style={{ marginTop: 8 }}>Scores blend a model’s judgment with offline heuristics when available — verify before you publish; AI can miss.</p>
            </div>
          </>
        ) : (
          <EmptyState title="Select a moment">Pick a moment on the left to see its score breakdown.</EmptyState>
        )}
      </section>

      <footer className="action-bar" style={{ gridColumn: '1 / -1' }}>
        <span className="honesty">{checked.size} selected · {sorted.filter((m) => m.status !== 'rejected').length} usable moments</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={() => navigate(`/project/${projectId}`)}>Back</Button>
          <Button variant="primary" size="36" disabled={checked.size === 0 || creating} loading={creating} onClick={() => void createClips()}>
            Create {checked.size > 0 ? checked.size : ''} clip{checked.size === 1 ? '' : 's'}
          </Button>
        </div>
      </footer>
    </div>
  );
};
