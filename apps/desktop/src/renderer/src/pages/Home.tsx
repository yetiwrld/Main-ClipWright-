import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Link2, FileVideo, Search, AlertTriangle, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { api, type ProjectRecord } from '../api.js';
import { useAppStore } from '../stores.js';
import { fmtBytes, fmtRelativeTime, fmtDuration } from '../format.js';
import { Button, Input, ProgressBar, StatusPill } from '@clipwright/design-system';

type Source = { kind: 'file'; path: string; name: string; sizeBytes: number; durationUs?: number; width?: number; height?: number; thumbPath?: string }
           | { kind: 'url'; url: string }
           | null;

const RATIOS = [
  { id: '9:16', label: '9:16', shape: { width: 18, height: 32 } },
  { id: '1:1', label: '1:1', shape: { width: 28, height: 28 } },
  { id: '16:9', label: '16:9', shape: { width: 32, height: 18 } },
  { id: '4:5', label: '4:5', shape: { width: 23, height: 28 } },
] as const;

const STYLE_NAMES = ['Karaoke', 'Hormozi', 'Minimal', 'Podcast', 'Documentary', 'Quote', 'News', 'Kids'] as const;
const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|webm|avi|m4v|ts|mts)$/i;

export const Home = () => {
  const boot = useAppStore((s) => s.boot);
  const toast = useAppStore((s) => s.toast);
  const refreshJobs = useAppStore((s) => s.refreshJobs);
  const navigate = useNavigate();
  const [source, setSource] = useState<Source>(null);
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [ratio, setRatio] = useState<'9:16' | '1:1' | '16:9' | '4:5'>('9:16');
  const [clipCount, setClipCount] = useState<number>(0); // 0 = Auto
  const [clipLength, setClipLength] = useState<'short' | 'medium' | 'long' | 'extended'>('medium');
  const [styleIdx, setStyleIdx] = useState(0);
  const [language, setLanguage] = useState('auto');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [recentTick, setRecentTick] = useState(0);
  const dropRef = useRef<HTMLDivElement>(null);

  const defaults = boot?.settings;
  useEffect(() => {
    if (!defaults) return;
    setRatio((defaults.lastUsed.aspectRatio ?? '9:16') as typeof ratio);
    setClipLength((defaults.lastUsed.clipLength ?? 'medium') as typeof clipLength);
    setLanguage(defaults.lastUsed.language ?? 'auto');
  }, [defaults]);

  useEffect(() => {
    api.projects.list().then(setProjects).catch(() => setProjects([]));
  }, [recentTick]);

  useEffect(() => {
    const t = window.setInterval(() => setRecentTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const acceptFile = useCallback(async (path: string) => {
    setError(null); setProbing(true); setSource(null);
    try {
      const info = await api.media.probePath(path);
      const v0 = info.video;
      if (!v0) throw new Error('This file has no video track — it doesn’t look like a video. Choose a different file.');
      setSource({ kind: 'file', path, name: path.split(/[\\/]/).pop() ?? path, sizeBytes: info.sizeBytes, durationUs: info.durationUs, width: v0.width, height: v0.height });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read.');
    } finally { setProbing(false); }
  }, []);

  const pickFile = useCallback(async () => {
    const path = await api.media.pickVideoFile();
    if (path) void acceptFile(path);
  }, [acceptFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // Electron exposes the absolute path on File objects
    const path = (file as File & { path?: string }).path;
    if (!path) { setError('That file could not be read from disk.'); return; }
    if (!VIDEO_EXTENSIONS.test(path)) { setError('That doesn’t look like a video file. Supported: MP4, MOV, MKV, WebM, AVI.'); return; }
    void acceptFile(path);
  }, [acceptFile]);

  const buildCreateInput = () => ({
    name: 'New project',
    settings: {
      aspectRatio: ratio,
      clipLength,
      language,
      captionStyleId: (STYLE_NAMES[styleIdx] ?? 'Hormozi').toLowerCase(),
      numClips: clipCount === 0 ? 'auto' : clipCount,
    },
  });

  const urlDownload = useCallback(async () => {
    const trimmed = url.trim();
    if (!/^https?:\/\//.test(trimmed)) { setError('Paste a full http(s) link first.'); return; }
    setUrlBusy(true); setError(null);
    try {
      const created = await api.projects.create(buildCreateInput());
      await api.downloadStart(created.id, trimmed, defaults?.downloadQuality ?? '1080p');
      toast('Download started. You can keep working while it runs.');
      await refreshJobs();
      navigate(`/project/${created.id}?stage=importing`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download could not start.');
    } finally { setUrlBusy(false); }
  }, [url, ratio, clipLength, language, styleIdx, clipCount, defaults?.downloadQuality, navigate, toast, refreshJobs]);

  const findClips = useCallback(async () => {
    if (source?.kind !== 'file') return;
    setImporting(true); setError(null);
    try {
      const created = await api.projects.create({
        ...buildCreateInput(),
        name: source.name.replace(VIDEO_EXTENSIONS, ''),
      });
      await api.media.importFile({ path: source.path, projectId: created.id, storageMode: defaults?.lastUsed.storageMode === 'reference' ? 'reference' : 'managed' });
      navigate(`/project/${created.id}?stage=importing`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import could not start.');
    } finally { setImporting(false); }
  }, [source, ratio, clipLength, language, styleIdx, clipCount, defaults?.lastUsed.storageMode, navigate]);

  const deleteProject = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`Delete “${name}” and its clips? This cannot be undone.`)) return;
    try { await api.projects.delete(id); setRecentTick((n) => n + 1); } catch (err) { toast(err instanceof Error ? err.message : 'Could not delete the project.', 'error'); }
  }, [toast]);

  const promoProjects = projects.slice(0, 6);
  const storageUsed = 0; // reclaimed by Windows storage sense; shown only if known

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="home-hero">
        <h1 className="home-headline">Turn one video into<br />many great clips.</h1>
        <p className="home-subline">{boot?.settings.downloadQuality ? `Downloads default to ${boot.settings.downloadQuality}. ` : ''}Drop in a long video — Clipwright finds the moments.</p>
      </div>

      <div className="source-grid">
        <div
          ref={dropRef}
          className={`dropzone${dragging ? ' dropzone--drag' : ''}${error ? ' dropzone--error' : ''}`}
          role="button" aria-label="Choose a video file" tabIndex={0}
          onClick={() => void pickFile()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void pickFile(); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {probing ? (
            <><div className="hero-metric" style={{ fontSize: 28 }}>…</div><div>Reading video details</div></>
          ) : source?.kind === 'file' ? (
            <div className="source-summary">
              <div className="source-summary__thumb"><FileVideo size={40} strokeWidth={1.5} /></div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.name}</div>
                <div className="detail-row" style={{ justifyContent: 'flex-start', margin: '4px 0' }}>
                  {source.durationUs != null && <span>{fmtDuration(source.durationUs)}</span>}
                  {source.width != null && <span>{source.width}×{source.height}</span>}
                  <span>{fmtBytes(source.sizeBytes)}</span>
                </div>
                <button className="advanced-toggle" onClick={(e) => { e.stopPropagation(); setSource(null); }}>Choose a different file</button>
              </div>
            </div>
          ) : (
            <>
              <Upload size={36} strokeWidth={1.5} aria-hidden />
              <div style={{ fontWeight: 600 }}>Drop a video here or choose one</div>
              <div className="dropzone__hint">MP4, MOV, MKV, WebM, AVI — files over 2 hours may take a while</div>
            </>
          )}
        </div>

        <div className="link-card" aria-label="Paste a video link">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            <Link2 size={16} aria-hidden /> Paste a video link
          </label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            aria-label="Video URL"
            onKeyDown={(e) => { if (e.key === 'Enter') void urlDownload(); }}
          />
          <Button variant="secondary" onClick={() => void urlDownload()} disabled={urlBusy || !url.trim()}>
            {urlBusy ? 'Starting…' : 'Download'}
          </Button>
          <p className="honesty">Only download videos you have the right to use. Protected (DRM) videos can’t be downloaded.</p>
        </div>
      </div>

      {error && (
        <div className="notice notice--warning" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
          <AlertTriangle size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{error}</span>
        </div>
      )}

      <div className="setting-cards">
        <div className="setting-card">
          <h3>ASPECT RATIO</h3>
          <div className="ratio-grid">
            {RATIOS.map((r) => (
              <button key={r.id} className={`ratio-tile${ratio === r.id ? ' ratio-tile--selected' : ''}`} onClick={() => setRatio(r.id as typeof ratio)} aria-pressed={ratio === r.id} aria-label={r.label}>
                <div className="ratio-shape" style={{ width: r.shape.width, height: r.shape.height }} />
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-card">
          <h3>CLIP LENGTH</h3>
          <select className="cw-select" value={clipLength} onChange={(e) => setClipLength(e.target.value as typeof clipLength)} aria-label="Clip length" style={{ width: '100%', height: 36 }}>
            <option value="short">Short (15–30s)</option>
            <option value="medium">Medium (30–60s)</option>
            <option value="long">Long (60–90s)</option>
            <option value="extended">Extended (90–180s)</option>
          </select>
        </div>

        <div className="setting-card">
          <h3>NUMBER OF CLIPS</h3>
          <div className="num-grid">
            {[0, 5, 10, 20].map((n) => (
              <button key={n} className={`num-tile${clipCount === n ? ' num-tile--selected' : ''}`} onClick={() => setClipCount(n)} aria-pressed={clipCount === n}>
                {n === 0 ? 'Auto' : n}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-card">
          <h3>OUTPUT</h3>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            MP4 · {ratio === '16:9' ? '1920×1080' : ratio === '1:1' ? '1080×1080' : ratio === '4:5' ? '1080×1350' : '1080×1920'}<br />{boot?.settings.processingMode === 'offline' ? 'Offline mode' : 'AI-assisted'}
          </div>
        </div>
      </div>

      <div className="setting-card" style={{ marginBottom: 'var(--space-4)' }}>
        <h3>CAPTION STYLE</h3>
        <div className="style-scroller" role="listbox" aria-label="Caption style">
          {STYLE_NAMES.map((name, i) => (
            <button key={name} className={`style-tile${styleIdx === i ? ' style-tile--selected' : ''}`} onClick={() => setStyleIdx(i)} aria-selected={styleIdx === i} role="option">
              <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)', textTransform: 'uppercase' }}>{name.slice(0, 2)}</span>
              <span className="name">{name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="find-clips-row">
        <span className="find-clips-hint">
          {defaults?.processingMode === 'offline' ? 'Offline mode — moments scored on-device' : 'Uses your AI settings for moment scoring'}
        </span>
        <Button
          size="44"
          onClick={() => void findClips()}
          disabled={source?.kind !== 'file' || importing || probing}
        >
          {importing ? 'Starting…' : <><Search size={18} aria-hidden /> Find Clips</>}
        </Button>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="section-title" style={{ marginTop: 0 }}>RECENT PROJECTS</h2>
          {storageUsed > 0 && <span className="honesty">{fmtBytes(storageUsed)} in workspace</span>}
        </div>
        <div className="recent-row">
          {promoProjects.length === 0 && <p className="empty-hint">Projects you create will appear here.</p>}
          {promoProjects.map((p) => (
            <button key={p.id} className="recent-card" onClick={() => navigate(`/project/${p.id}`)} aria-label={`Open ${p.name}`}>
              <div className="recent-card__thumb">{p.sourceMediaId ? <FileVideo size={28} strokeWidth={1.5} /> : <FileVideo size={28} strokeWidth={1.5} />}</div>
              <div className="recent-card__body">
                <div className="recent-card__name" title={p.name}>{p.name}</div>
                <div className="recent-card__meta">
                  <StatusPill tone={p.stage === 'exported' ? 'success' : p.stage.endsWith('failed') ? 'error' : 'default'}>
                    {p.stage === 'exported' ? 'Exported' : p.stage.endsWith('failed') ? 'Failed' : p.stage === 'moments-ready' ? 'Ready' : p.stage === 'transcribed' ? 'Transcribed' : 'New'}
                  </StatusPill>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {fmtRelativeTime(p.updatedAt)}
                    <span
                      role="button" tabIndex={0} aria-label="Delete project"
                      onClick={(e) => { e.stopPropagation(); void deleteProject(p.id, p.name); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void deleteProject(p.id, p.name); } }}
                      style={{ display: 'inline-flex', padding: 4, borderRadius: 4, cursor: 'pointer' }}
                    >
                      <Trash2 size={13} aria-hidden />
                    </span>
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <button className="advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)} aria-expanded={advancedOpen}>
          {advancedOpen ? <ChevronDown size={14} aria-hidden style={{ verticalAlign: -2 }} /> : <ChevronRight size={14} aria-hidden style={{ verticalAlign: -2 }} />} Advanced settings
        </button>
        {advancedOpen && (
          <div className="advanced-grid">
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Language
              <select className="cw-select" value={language} onChange={(e) => setLanguage(e.target.value)} style={{ width: '100%', height: 34, marginTop: 4 }}>
                <option value="auto">Auto-detect</option>
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="pt">Portuguese</option>
                <option value="hi">Hindi</option>
                <option value="ar">Arabic</option>
                <option value="yo">Yoruba</option>
              </select>
            </label>
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Speakers
              <select className="cw-select" defaultValue="unknown" style={{ width: '100%', height: 34, marginTop: 4 }}>
                <option value="unknown">Auto-detect</option>
                <option value="1">Single speaker</option>
                <option value="2">Two speakers</option>
                <option value="many">Multiple speakers</option>
              </select>
            </label>
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Content
              <select className="cw-select" defaultValue="mixed" style={{ width: '100%', height: 34, marginTop: 4 }}>
                <option value="mixed">Mixed</option>
                <option value="talking-head">Talking head</option>
                <option value="interview">Interview</option>
                <option value="podcast">Podcast</option>
                <option value="tutorial">Tutorial</option>
                <option value="commentary">Commentary</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {importing && <div style={{ marginTop: 'var(--space-4)' }}><ProgressBar fraction={0.15} /></div>}
    </div>
  );
};
