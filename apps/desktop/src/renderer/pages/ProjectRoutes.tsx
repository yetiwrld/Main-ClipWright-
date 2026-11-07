import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Route } from '../App.js';
import { StageProgressScreen, type SubStep } from '../components/StageProgressScreen.js';
import { TranscriptEditor } from '../components/TranscriptEditor.js';
import { EditorPage } from '../features/editor/EditorPage.js';
import { MomentsPage } from './MomentsPage.js';
import { api, describeError, isDesktop } from '../api.js';
import type {
  IngestResultPayload,
  JobProgressPayload,
  ProjectRecord,
  TranscribeResultPayload,
  TranscriptPayload,
} from '../global.js';

interface Props {
  projectId: string;
  stage: 'import' | 'transcribe' | 'moments' | 'editor';
  compId?: string;
  onNavigate: (r: Route) => void;
}

export function ProjectRoutes({ projectId, stage, compId, onNavigate }: Props) {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!isDesktop()) {
      setLoadError('Projects open inside the Clipwright desktop app.');
      return;
    }
    let cancelled = false;
    void api
      .getProject(projectId)
      .then((p) => {
        if (cancelled) return;
        if (!p) setLoadError('This project could not be found. It may have been deleted.');
        else setProject(p);
      })
      .catch((err) => !cancelled && setLoadError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loadError) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-md)', marginBottom: 12 }}>{loadError}</p>
          <button onClick={() => onNavigate({ name: 'projects' })} style={secondaryBtn}>Back to projects</button>
        </div>
      </div>
    );
  }

  if (stage === 'import') {
    return <ImportStage projectId={projectId} project={project} onNavigate={onNavigate} />;
  }
  if (stage === 'transcribe') {
    return <TranscribeStage projectId={projectId} project={project} onNavigate={onNavigate} />;
  }
  if (stage === 'moments') {
    return <MomentsStage projectId={projectId} onNavigate={onNavigate} />;
  }
  return <EditorStage projectId={projectId} compId={compId} onNavigate={onNavigate} />;
}

/* ------------------------------------------------------------------ import */

type ImportPhase = 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';

const IMPORT_STEPS = [
  { key: 'link', label: 'Checking link' },
  { key: 'copy', label: 'Bringing the video in' },
  { key: 'probe', label: 'Inspecting' },
  { key: 'thumb', label: 'Generating thumbnail' },
  { key: 'audio', label: 'Extracting audio' },
  { key: 'proxy', label: 'Preparing preview' },
  { key: 'index', label: 'Indexing audio' },
  { key: 'hash', label: 'Finishing up' },
];

function stepsFor(phase: string, percent: number): SubStep[] {
  const thresholds: Record<string, number> = {
    link: 1, copy: 8, probe: 62, thumb: 70, audio: 78, proxy: 86, index: 93, hash: 97,
  };
  let runningAssigned = false;
  return IMPORT_STEPS.map((s) => {
    const threshold = thresholds[s.key];
    if (percent >= threshold + (s.key === 'hash' ? 3 : 8)) return { label: s.label, status: 'done' };
    if (!runningAssigned && percent >= threshold) {
      runningAssigned = true;
      return { label: s.label, status: 'running' };
    }
    if (phase === 'failed' && percent >= threshold) return { label: s.label, status: 'failed' };
    return { label: s.label, status: 'pending' };
  });
}

function ImportStage({
  projectId,
  project,
  onNavigate,
}: {
  projectId: string;
  project: ProjectRecord | null;
  onNavigate: (r: Route) => void;
}) {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState('Waiting to start');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<IngestResultPayload | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const jobIdRef = useRef(`ingest_${projectId}_${Date.now()}`);

  useEffect(() => {
    return api.onJobProgress((p: JobProgressPayload) => {
      if (p.jobId !== jobIdRef.current) return;
      if (p.failed) {
        setPhase('failed');
        setError(p.message ?? 'Import failed.');
        return;
      }
      if (typeof p.percent === 'number') setPercent(p.percent);
      if (p.phase) setPhaseLabel(p.phase);
      if (p.detail) setDetail(p.detail);
      if (p.result) {
        setResult(p.result as IngestResultPayload);
        setPhase('complete');
      }
    });
  }, []);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const source = project?.settings as Record<string, unknown> | undefined;
  const sourcePath = typeof source?.sourcePath === 'string' ? source.sourcePath : '';
  const isUrl = /^https?:\/\//i.test(sourcePath);

  const start = useCallback(async () => {
    if (!sourcePath) {
      setPhase('failed');
      setError('This project has no source attached. Start a new project and choose a video.');
      return;
    }
    setPhase('running');
    setError('');
    setPercent(0);
    setElapsed(0);
    jobIdRef.current = `ingest_${projectId}_${Date.now()}`;
    try {
      const res = await api.startIngest(jobIdRef.current, {
        projectId,
        sourcePath: isUrl ? undefined : sourcePath,
        sourceUrl: isUrl ? sourcePath : undefined,
        quality: '1080p',
        storageMode: 'managed',
      });
      setResult(res);
      setPercent(100);
      setPhase('complete');
    } catch (err) {
      setError(describeError(err));
      setPhase(signalAborted(err) ? 'cancelled' : 'failed');
    }
  }, [projectId, sourcePath, isUrl]);

  const cancel = useCallback(async () => {
    await api.cancelJob(jobIdRef.current);
  }, []);

  if (phase === 'idle') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ maxWidth: 560, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h2 style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Ready to import
          </h2>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', margin: 0, wordBreak: 'break-all' }}>
            {sourcePath || 'No source attached to this project.'}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={start} disabled={!sourcePath} style={primaryBtn(!sourcePath)}>
              Import video
            </button>
            <button onClick={() => onNavigate({ name: 'home' })} style={secondaryBtn}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <StageProgressScreen
      title="Importing your video"
      reasonLine={phase === 'complete' ? 'Import finished. The transcript is next.' : phaseLabel}
      state={phase === 'running' ? 'running' : phase === 'complete' ? 'complete' : phase === 'cancelled' ? 'cancelled' : 'failed'}
      percent={percent}
      detail={detail || (result ? `${result.kind} · ${formatDuration(result.durationUs)}` : undefined)}
      elapsedSec={elapsed}
      errorMessage={error}
      subSteps={stepsFor(phase, percent)}
      onCancel={phase === 'running' ? cancel : undefined}
      onRetry={phase === 'failed' || phase === 'cancelled' ? start : undefined}
      onContinue={phase === 'complete' ? () => onNavigate({ name: 'project', id: projectId, stage: 'transcribe' }) : undefined}
    />
  );
}

/* -------------------------------------------------------------- transcribe */

function TranscribeStage({
  projectId,
  project,
  onNavigate,
}: {
  projectId: string;
  project: ProjectRecord | null;
  onNavigate: (r: Route) => void;
}) {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [chunk, setChunk] = useState<{ index: number; total: number } | null>(null);
  const [liveText, setLiveText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [eta, setEta] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<TranscribeResultPayload | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('small');
  const jobIdRef = useRef(`transcribe_${projectId}_${Date.now()}`);

  useEffect(() => {
    if (!isDesktop()) return;
    void api
      .listModels()
      .then((list) => {
        const installed = list.filter((m) => m.installed).map((m) => m.name);
        setModels(installed);
        if (installed.length > 0 && !installed.includes('small')) setModel(installed[0]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    return api.onJobProgress((p: JobProgressPayload) => {
      if (p.jobId !== jobIdRef.current) return;
      if (p.failed) {
        setPhase('failed');
        setError(p.message ?? 'Transcription failed.');
        return;
      }
      if (typeof p.percent === 'number') setPercent(p.percent);
      if (typeof p.chunkIndex === 'number' && typeof p.totalChunks === 'number') {
        setChunk({ index: p.chunkIndex, total: p.totalChunks });
      }
      if (typeof p.elapsedSec === 'number') setElapsed(p.elapsedSec);
      if (p.etaSec !== undefined) setEta(p.etaSec);
      if (typeof p.detail === 'string' && p.detail) setLiveText(p.detail);
      if (p.result) {
        setResult(p.result as TranscribeResultPayload);
        setPhase('complete');
      }
    });
  }, []);

  const start = useCallback(async () => {
    const settings = project?.settings as Record<string, unknown> | undefined;
    const sourcePath = typeof settings?.sourcePath === 'string' ? settings.sourcePath : '';
    if (!sourcePath) {
      setPhase('failed');
      setError('No media is attached to this project yet. Import a video first.');
      return;
    }
    setPhase('running');
    setError('');
    setPercent(0);
    setLiveText('');
    jobIdRef.current = `transcribe_${projectId}_${Date.now()}`;
    try {
      const media = await api.probeMedia(sourcePath).catch(() => null);
      const res = await api.startTranscribe(jobIdRef.current, {
        projectId,
        audioPath: sourcePath,
        mediaId: media?.mediaId ?? projectId,
        model,
        language: 'auto',
        engine: 'whisper-local',
        threads: 4,
        chunkDurationSec: 30,
      });
      setResult(res);
      setPhase('complete');
    } catch (err) {
      setError(describeError(err));
      setPhase(signalAborted(err) ? 'cancelled' : 'failed');
    }
  }, [projectId, project, model]);

  if (phase === 'complete' && result) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: 24, overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Transcript ready
          </h2>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {result.wordCount.toLocaleString()} words · {result.language} · {result.model} · {formatDuration(result.durationSec * 1_000_000)}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={() => setPhase('idle')} style={secondaryBtn}>Re-transcribe</button>
            <button onClick={() => onNavigate({ name: 'project', id: projectId, stage: 'moments' })} style={primaryBtn(false)}>
              Continue to Moments →
            </button>
          </div>
        </header>
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--surface-card)', border: '1px solid var(--line-subtle)',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
        }}>
          <TranscriptEditor transcript={result.transcript as TranscriptPayload} />
        </div>
      </div>
    );
  }

  if (phase === 'idle') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'center' }}>
          <h2 style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Transcribe
          </h2>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            {models.length === 0
              ? 'No transcription model is installed yet. Install one from Models, then come back.'
              : 'Speech is transcribed on this computer. Nothing is uploaded.'}
          </p>
          {models.length > 0 && (
            <label style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              Model{' '}
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{
                  padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--line-default)', background: 'var(--surface-raised)',
                  color: 'var(--text-primary)', fontSize: 'var(--fs-sm)',
                }}
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={start} disabled={models.length === 0} style={primaryBtn(models.length === 0)}>
              Start transcription
            </button>
            <button onClick={() => onNavigate({ name: 'models' })} style={secondaryBtn}>
              Manage models
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', padding: 24, gap: 24, overflow: 'auto' }}>
      <div style={{ flex: '1 1 40%', minWidth: 320 }}>
        <StageProgressScreen
          title="Transcribing"
          reasonLine="Turning speech into text so captions and moments can be built from it."
          state={phase === 'running' ? 'running' : phase === 'cancelled' ? 'cancelled' : 'failed'}
          percent={percent}
          detail={
            chunk
              ? `${model} · chunk ${chunk.index} of ${chunk.total}`
              : model
          }
          etaSec={eta}
          elapsedSec={elapsed}
          errorMessage={error}
          subSteps={[
            { label: 'Reading audio', status: percent > 0 ? 'done' : 'running' },
            { label: 'Running Whisper', status: percent >= 100 ? 'done' : percent > 0 ? 'running' : 'pending' },
            { label: 'Building sentences', status: percent >= 100 ? 'done' : 'pending' },
          ]}
          onCancel={phase === 'running' ? () => api.cancelJob(jobIdRef.current) : undefined}
          onRetry={phase === 'failed' || phase === 'cancelled' ? start : undefined}
        />
      </div>
      <div style={{ flex: '1 1 50%', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Live transcript
        </h3>
        <div style={{
          flex: 1, minHeight: 200, background: 'var(--surface-card)', borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--line-subtle)', padding: 16, overflow: 'auto',
          fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', lineHeight: 1.7,
        }}>
          {liveText || 'Words appear here as each chunk finishes.'}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- moments */

function MomentsStage({ projectId, onNavigate }: { projectId: string; onNavigate: (r: Route) => void }) {
  return <MomentsPage projectId={projectId} onNavigate={onNavigate} />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: '12px 18px', borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card)', border: '1px solid var(--line-subtle)',
      minWidth: 120,
    }}>
      <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

function EditorStage({
  projectId,
  compId,
  onNavigate,
}: {
  projectId: string;
  compId?: string;
  onNavigate: (r: Route) => void;
}) {
  return (
    <EditorPage
      projectId={projectId}
      compId={compId}
      onBack={() => onNavigate({ name: 'project', id: projectId, stage: 'moments' })}
    />
  );
}

/* ------------------------------------------------------------------ helpers */

function signalAborted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message);
}

function formatDuration(us: number): string {
  const totalSec = Math.round(us / 1_000_000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 22px',
    border: 'none',
    borderRadius: 'var(--radius-pill)',
    background: 'var(--brand)',
    color: 'var(--on-brand)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontSize: 'var(--fs-sm)',
    fontWeight: 500,
  };
}

const secondaryBtn: React.CSSProperties = {
  padding: '8px 20px',
  border: '1px solid var(--line-default)',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--surface-raised)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: 'var(--fs-sm)',
};
