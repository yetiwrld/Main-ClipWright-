import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CircleDashed, Loader2, XCircle, RotateCcw } from 'lucide-react';
import { Button, ProgressBar, StatusPill } from '@clipwright/design-system';
import { api, type ProjectRecord } from '../api.js';
import { useAppStore } from '../stores.js';
import { fmtBytes, fmtDuration, jobPhaseLabel } from '../format.js';
import type { Job } from '@clipwright/project-schema';

const TRANSCRIBE_STEPS = [
  { id: 'audio', label: 'Extracting clean audio' },
  { id: 'whisper', label: 'Transcribing speech' },
  { id: 'captions', label: 'Building captions' },
] as const;

export const ImportStage = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const autoStart = searchParams.get('stage') === 'importing';
  const navigate = useNavigate();
  const toast = useAppStore((s) => s.toast);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const [p, jobList] = await Promise.all([api.projects.get(projectId), api.jobs.list()]);
      setProject(p);
      setJobs([...jobList.active, ...jobList.recent].filter((j) => (j as Job & { projectId?: string }).projectId === projectId || true));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load the project.', 'error');
    }
  }, [projectId, toast]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const t = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const startTranscription = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      await api.transcribeStart(projectId);
      toast('Transcription started.');
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription could not start.');
    }
  }, [projectId, toast, refresh]);

  // once the media copy finishes, kick off transcription automatically
  useEffect(() => {
    if (!autoStart || started.current || !project?.sourceMediaId) return;
    if (project.stage === 'created' || project.stage === 'importing' || project.stage === 'import-failed') {
      started.current = true;
      // give the copy/probe jobs a moment to register before queueing transcription
      const t = window.setTimeout(() => void startTranscription(), 800);
      return () => window.clearTimeout(t);
    }
  }, [autoStart, project?.sourceMediaId, project?.stage, startTranscription]);

  const stage = project?.stage ?? 'created';
  const transcribeJob = jobs.find((j) => j.type === 'transcribe');
  const copyJob = jobs.find((j) => j.type === 'copy' || j.type === 'download');
  const active = transcribeJob ?? copyJob;
  const progress = active?.progress ?? 0;
  const failed = stage.endsWith('failed') || active?.status === 'failed';
  const errorMessage = active?.error ?? null;

  // poll: once a project reaches 'transcribed' or 'moments-ready', move on
  useEffect(() => {
    if (!project) return;
    if (project.stage === 'transcribed' || project.stage === 'moments-ready' || project.stage === 'editor') {
      navigate(`/moments/${project.id}`, { replace: true });
    }
  }, [project, navigate]);



  return (
    <div className="page" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 className="page-title">{failed ? 'Something needs attention' : 'Setting up your project'}</h1>
      <p className="page-sub">{project?.name ?? 'Loading…'}</p>

      <div className="stage-card">
        {failed ? (
          <>
            <XCircle size={40} strokeWidth={1.5} color="var(--error)" aria-hidden />
            <div className="hero-metric" style={{ fontSize: 28, color: 'var(--error)' }}>Failed</div>
            <p className="reason-line">{errorMessage ?? error ?? 'The last step didn’t finish. Check that the source file still exists and try again.'}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <Button variant="primary" onClick={() => void startTranscription()}><RotateCcw size={16} aria-hidden /> Retry transcription</Button>
              <Button variant="ghost" onClick={() => navigate('/')}>Back to home</Button>
            </div>
          </>
        ) : (
          <>
            <Loader2 size={36} className="spin" aria-hidden style={{ color: 'var(--brand)' }} />
            <div className="hero-metric">{Math.round(progress * 100)}<span style={{ fontSize: '0.4em', color: 'var(--text-muted)' }}>%</span></div>
            <p className="reason-line">{active ? jobPhaseLabel(active) : stage === 'moments-ready' ? 'Moments are ready' : 'Preparing…'}</p>
            <div style={{ maxWidth: 420, margin: '16px auto 0' }}>
              <ProgressBar fraction={progress} />
            </div>
            <div className="substeps" aria-label="Progress steps">
              {TRANSCRIBE_STEPS.map((step, i) => {
                const activeIdx = transcribeJob ? Math.min(2, Math.floor(progress * 3)) : stage === 'transcribed' ? 3 : -1;
                const done = activeIdx > i || stage === 'transcribed';
                const current = activeIdx === i;
                const Icon = done ? CheckCircle2 : current ? Loader2 : CircleDashed;
                return (
                  <div key={step.id} className={`substep${current ? ' substep--active' : done ? ' substep--done' : ''}`}>
                    <Icon size={18} strokeWidth={1.75} aria-hidden className={current ? 'spin' : undefined} />
                    {step.label}
                  </div>
                );
              })}
            </div>
            <p className="honesty" style={{ marginTop: 24 }}>Your video isn’t filtered or uploaded anywhere — processing happens on this PC.</p>
          </>
        )}
      </div>

      {project && (
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <StatusPill tone={failed ? 'error' : 'info'}>{stage}</StatusPill>
          <Button variant="ghost" onClick={() => navigate(`/moments/${project.id}`)}>Skip to moments</Button>
        </div>
      )}
    </div>
  );
};
