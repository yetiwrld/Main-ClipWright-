import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  Home as HomeIcon, FolderOpen, Settings, Minus, Square, X, Search, Minimize2, Check, Loader2,
} from 'lucide-react';
import { Button, ErrorBoundary, ToastStack } from '@clipwright/design-system';
import { Home } from './pages/Home.js';
import { useAppStore } from './stores.js';
import { api } from './api.js';
import clipwrightLogo from './assets/logo.png';
import './styles.css';

const ImportStage = lazy(() => import('./pages/ImportStage.js').then((m) => ({ default: m.ImportStage })));
const MomentsStage = lazy(() => import('./pages/MomentsStage.js').then((m) => ({ default: m.MomentsStage })));
const EditorPage = lazy(() => import('./pages/EditorPage.js').then((m) => ({ default: m.EditorPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage.js').then((m) => ({ default: m.ProjectsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })));
const DesignShowcase = import.meta.env.DEV
  ? lazy(() => import('./pages/DesignShowcase.js').then((m) => ({ default: m.DesignShowcase })))
  : null;

const RAIL = [
  { to: '/', icon: HomeIcon, label: 'Home' },
  { to: '/projects', icon: FolderOpen, label: 'Projects' },
] as const;

const TopBar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const boot = useAppStore((s) => s.boot);
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const activeJobs = useAppStore((s) => s.activeJobs);
  const [isMax, setIsMax] = useState(false);
  const projectMatch = /^\/project\/([^/]+)$/.exec(location.pathname) || /^\/editor\/([^/]+)/.exec(location.pathname);
  const projectId = projectMatch?.[1];
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) { setProjectName(null); return; }
    api.projects.get(projectId).then((p) => setProjectName(p?.name ?? null)).catch(() => setProjectName(null));
  }, [projectId]);

  useEffect(() => {
    void api.windowChrome.isMaximized().then(setIsMax).catch(() => setIsMax(false));
    const off = window.setInterval(() => { void api.windowChrome.isMaximized().then(setIsMax).catch(() => undefined); }, 2000);
    return () => window.clearInterval(off);
  }, []);

  const onRename = async (name: string) => {
    if (!projectId) return;
    setProjectName(name);
    try { await api.projects.update(projectId, { name }); } catch { /* rename is best-effort */ }
  };

  const exportSplit = activeJobs.find((j) => j.type === 'export');

  return (
    <header className="topbar">
      <button className="topbar__logo" onClick={() => navigate('/')} aria-label="Clipwright Studio — home">
        <img src={clipwrightLogo} alt="" width={22} height={22} />
        <span>CLIPWRIGHT</span>
      </button>

      {projectId && projectName != null && (
        <input
          className="topbar__project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          onBlur={(e) => void onRename(e.target.value.trim() || 'Untitled project')}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          aria-label="Project name"
        />
      )}

      <div className="topbar__spacer" />

      <div className="topbar__group">
        {exportSplit ? (
          <span className="topbar__save-status"><Loader2 size={12} aria-hidden className="spin" /> Exporting {Math.round((exportSplit.progress ?? 0) * 100)}%</span>
        ) : (
          <span className="topbar__save-status"><Check size={12} aria-hidden /> Saved</span>
        )}
      </div>

      <button className="topbar__logo" onClick={() => navigate('/settings')} aria-label="Open search and settings" style={{ padding: 6 }}>
        <Search size={16} aria-hidden />
      </button>

      <div className="window-controls" role="group" aria-label="Window controls">
        <button aria-label="Minimise" onClick={() => void api.windowChrome.minimize()}><Minus size={14} aria-hidden /></button>
        <button aria-label={isMax ? 'Restore' : 'Maximise'} onClick={() => void api.windowChrome.toggleMaximize().then(setIsMax)}>
          {isMax ? <Minimize2 size={13} aria-hidden /> : <Square size={12} aria-hidden />}
        </button>
        <button className="close" aria-label="Close" onClick={() => void api.windowChrome.close()}><X size={15} aria-hidden /></button>
      </div>

      <ToastStack toasts={toasts.map((t) => ({ id: t.id, message: t.message, tone: t.tone }))} onDismiss={dismissToast} />
    </header>
  );
};

const Rail = () => {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <nav className="rail" aria-label="Main navigation">
      {RAIL.map(({ to, icon: Icon, label }) => {
        const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
        return (
          <button key={to} className={`rail__btn${active ? ' rail__btn--active' : ''}`} onClick={() => navigate(to)} aria-current={active ? 'page' : undefined} aria-label={label}>
            <Icon size={20} strokeWidth={1.75} aria-hidden />
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      <button
        className={`rail__btn${location.pathname.startsWith('/settings') ? ' rail__btn--active' : ''}`}
        onClick={() => navigate('/settings')}
        aria-label="Settings" aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
      >
        <Settings size={20} strokeWidth={1.75} aria-hidden />
      </button>
    </nav>
  );
};

export const App = () => {
  const init = useAppStore((s) => s.init);
  const boot = useAppStore((s) => s.boot);
  const bootError = useAppStore((s) => s.bootError);
  const refreshJobs = useAppStore((s) => s.refreshJobs);
  const toast = useAppStore((s) => s.toast);

  useEffect(() => {
    void init();
    void refreshJobs();
  }, [init, refreshJobs]);

  useEffect(() => {
    const offProgress = api.jobs.onProgress(() => void refreshJobs());
    const offDone = api.jobs.onDone(() => void refreshJobs());
    const offFailed = api.jobs.onFailed(() => void refreshJobs());
    return () => { offProgress(); offDone(); offFailed(); };
  }, [refreshJobs]);

  useEffect(() => {
    const handler = (e: ErrorEvent) => { void api.logRendererError(`${e.message} @ ${e.filename}:${e.lineno}`); };
    const rejection = (e: PromiseRejectionEvent) => { void api.logRendererError(`unhandledrejection: ${String(e.reason)}`); };
    window.addEventListener('error', handler);
    window.addEventListener('unhandledrejection', rejection);
    return () => { window.removeEventListener('error', handler); window.removeEventListener('unhandledrejection', rejection); };
  }, []);

  if (bootError) {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h1 className="page-title">Clipwright couldn’t start</h1>
          <p className="page-sub">{bootError}</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <img src={clipwrightLogo} alt="Clipwright Studio" width={72} height={72} style={{ borderRadius: 16 }} />
          <span style={{ fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>CLIPWRIGHT STUDIO</span>
        </span>
      </div>
    );
  }

  return (
    <HashRouter>
      <ErrorBoundary>
        <div className="app-shell">
          {boot.secretsMemoryOnly && (
            <div role="status" style={{ background: 'var(--warning-tint)', color: 'var(--text-primary)', fontSize: 'var(--fs-xs)', padding: '4px 12px', textAlign: 'center' }}>
              Your system keychain isn’t available, so API keys are held in memory for this session only and will not be saved.
            </div>
          )}
          <TopBar />
          <div className="body-row">
            <Rail />
            <main className="main-pane" role="main">
              <Suspense fallback={<div className="page"><p className="empty-hint">Loading…</p></div>}>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  {DesignShowcase && <Route path="/__design" element={<DesignShowcase />} />}
                  <Route path="/project/:projectId" element={<ImportStage />} />
                  <Route path="/moments/:projectId" element={<MomentsStage />} />
                  <Route path="/editor/:projectId/:compId?" element={<EditorPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </main>
          </div>
        </div>
      </ErrorBoundary>
    </HashRouter>
  );
};
