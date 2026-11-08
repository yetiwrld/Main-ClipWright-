import React, { useState, useCallback, useEffect } from 'react';
import { TopBar } from './components/TopBar.js';
import { NavigationRail } from './components/NavigationRail.js';
import { StartPage } from './pages/StartPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { ProjectRoutes } from './pages/ProjectRoutes.js';
import { CommandPalette } from './components/CommandPalette.js';
import { SetupDialog } from './components/SetupDialog.js';
import { RecoveryDialog } from './features/updates/RecoveryDialog.js';
import { UpdateNotice } from './features/updates/UpdateNotice.js';
import { ShortcutSheet } from './components/ShortcutSheet.js';
import { api, isDesktop } from './api.js';
import type { RecoveryStatePayload } from './global.js';

/** Where an unsigned build's releases live; used when a rollback is not possible. */
const RELEASES_URL = 'https://github.com/yetiwrld/Main-ClipWright-/releases';

export type Route =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'settings'; section: string }
  | { name: 'models' }
  | { name: 'project'; id: string; stage: 'import' | 'transcribe' | 'moments' | 'editor'; compId?: string };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [isInProject, setIsInProject] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryStatePayload | null>(null);
  // Bumping this tells the update notice to open its dialog (SPEC 15 §3).
  const [showUpdateDialog, setShowUpdateDialog] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    setIsInProject(r.name === 'project');
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (!cancelled) setSetupDialogOpen(!s.firstRunCompleted);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // SPEC 15 §7.3: ask once at startup whether the previous update failed. This
  // runs before anything else so the window is not left looking broken.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void api
      .getRecoveryState()
      .then((state) => {
        if (!cancelled && state) setRecovery(state);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Spec 02 §2.6 — global shortcuts.
   *
   * Handled in the renderer because every one of them is navigation or a dialog,
   * and the renderer owns both. Ctrl+O and Ctrl+S deliberately do nothing here:
   * opening a video needs a project to open it into, and saving is continuous
   * (the top bar reports it), so a manual-save shortcut would be theatre. The
   * cheat sheet lists them honestly rather than pretending otherwise.
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;

      switch (e.key) {
        case 'k':
        case 'K':
          e.preventDefault();
          setPaletteOpen((open) => !open);
          break;
        case ',':
          e.preventDefault();
          navigate({ name: 'settings', section: 'general' });
          break;
        case 'n':
        case 'N':
          // Start a project: the panel that asks for a name and a source, not a
          // silently-created empty project the user then has to rename.
          e.preventDefault();
          navigate({ name: 'home' });
          break;
        case '/':
          e.preventDefault();
          setShortcutsOpen((open) => !open);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  const isOutsideProject = route.name !== 'project';

  return (
    <div className="app-root" style={{
      display: 'flex',
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      background: 'var(--surface-app)',
      color: 'var(--text-primary)',
      fontFamily: 'var(--font-ui)',
      margin: 0,
      padding: 0,
      boxSizing: 'border-box',
    }}>
      {isOutsideProject && <NavigationRail active={route.name} onNavigate={navigate} />}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}>
        <TopBar
          route={route}
          isInProject={isInProject}
          onNavigate={navigate}
          updateChip={
            <UpdateNotice showChip openRequest={showUpdateDialog} />
          }
        />
        <div style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {route.name === 'home' && <StartPage onNavigate={navigate} />}
          {route.name === 'projects' && <ProjectsPage onNavigate={navigate} />}
          {route.name === 'settings' && (
            <SettingsPage
              section={route.section}
              onNavigate={navigate}
              onShowUpdateDialog={() => setShowUpdateDialog((value) => value + 1)}
            />
          )}
          {route.name === 'models' && <ModelsPage />}
          {route.name === 'project' && (
            <ProjectRoutes
              projectId={route.id}
              stage={route.stage}
              compId={route.compId}
              onNavigate={navigate}
            />
          )}
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNavigate={navigate}
        />
      )}

      {setupDialogOpen && (
        <SetupDialog
          onComplete={() => setSetupDialogOpen(false)}
          onNavigate={navigate}
        />
      )}

      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}

      <RecoveryDialog
        open={recovery !== null}
        state={recovery}
        onRestorePrevious={() => api.restorePreviousVersion()}
        onDismiss={() => {
          setRecovery(null);
          void api.dismissRecovery().catch(() => undefined);
        }}
        onOpenReleasesPage={() => {
          window.open(RELEASES_URL, '_blank', 'noopener');
        }}
      />
    </div>
  );
}
