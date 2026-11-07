import React, { useState, useEffect, useCallback } from 'react';
import type { Route } from '../App.js';
import { api, describeError, isDesktop } from '../api.js';

interface Props {
  onComplete: () => void;
  onNavigate: (r: Route) => void;
}

export function SetupDialog({ onComplete, onNavigate }: Props) {
  const [workspace, setWorkspace] = useState('');
  const [processingMode, setProcessingMode] = useState<'offline' | 'online' | 'automatic'>('automatic');
  const [downloadModel, setDownloadModel] = useState(true);
  const [modelPercent, setModelPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState<'idle' | 'moving' | 'finishing'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isDesktop()) return;
    void api
      .getAppInfo()
      .then((info) => setWorkspace(info.workspaceDir ?? ''))
      .catch(() => undefined);
    void api
      .getSettings()
      .then((s) => setProcessingMode(s.processingMode))
      .catch(() => undefined);
    return api.onModelProgress(({ modelName, percent }) => {
      if (modelName === 'small') setModelPercent(percent);
    });
  }, []);

  const chooseFolder = useCallback(async () => {
    setError('');
    try {
      const folders = await api.pickFolder();
      const target = folders[0];
      if (!target) return;
      setBusy('moving');
      const result = (await api.relocateWorkspaceTo(target)) as { movedTo?: string };
      if (result?.movedTo) setWorkspace(result.movedTo);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy('idle');
    }
  }, []);

  const finish = useCallback(async (skipModel: boolean) => {
    setError('');
    setBusy('finishing');
    try {
      await api.updateSettings({ processingMode, firstRunCompleted: true });
      if (!skipModel && downloadModel) {
        setModelPercent(0);
        await api.installModel('small').catch((err) => {
          setError(`The model download did not finish: ${describeError(err)}`);
        });
      }
      onComplete();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy('idle');
      setModelPercent(null);
    }
  }, [downloadModel, onComplete, processingMode]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--surface-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Clipwright Studio"
        style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--line-default)',
          borderRadius: 'var(--radius-lg)',
          width: 560,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 32,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h2 style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
          Welcome to Clipwright Studio
        </h2>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', margin: '0 0 24px 0' }}>
          Two choices now, everything else can be changed later in Settings.
        </p>

        {error && (
          <div role="alert" style={{
            padding: '8px 12px', marginBottom: 16, borderRadius: 'var(--radius-md)',
            background: 'var(--danger-tint)', border: '1px solid var(--danger)',
            fontSize: 'var(--fs-xs)', color: 'var(--text-primary)',
          }}>
            {error}
          </div>
        )}

        {/* Workspace folder */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: 8 }}>
            Workspace folder
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{
              flex: 1,
              padding: '10px 14px',
              border: '1px solid var(--line-default)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-raised)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--fs-xs)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {workspace || 'Documents/Clipwright Studio'}
            </div>
            <button
              onClick={chooseFolder}
              disabled={busy !== 'idle' || !isDesktop()}
              style={secondaryBtn(busy !== 'idle' || !isDesktop())}
            >
              {busy === 'moving' ? 'Moving…' : 'Change…'}
            </button>
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            Projects, models and cache files live in this folder.
          </div>
        </div>

        {/* Processing mode */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: 8 }}>
            Processing mode
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {([
              { id: 'offline', label: 'Offline', desc: 'Everything runs on this computer. Nothing is uploaded.' },
              { id: 'online', label: 'Online AI', desc: 'Uses the cloud providers you configure.' },
              { id: 'automatic', label: 'Automatic', desc: 'Online when configured and available, otherwise offline.' },
            ] as const).map((opt) => (
              <button
                key={opt.id}
                onClick={() => setProcessingMode(opt.id)}
                aria-pressed={processingMode === opt.id}
                style={{
                  textAlign: 'left',
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  border: processingMode === opt.id ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                  background: processingMode === opt.id ? 'var(--brand-tint)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: processingMode === opt.id ? 'var(--text-brand)' : 'var(--text-primary)' }}>
                  {opt.label}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                  {opt.desc}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Model download */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 24, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={downloadModel}
            onChange={(e) => setDownloadModel(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)' }}>
              Download the recommended transcription model now (Whisper small, ~488 MB)
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              Best balance of speed and accuracy on a typical computer. You can install other models later.
            </div>
            {modelPercent !== null && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                Downloading… {modelPercent}%
              </div>
            )}
          </div>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={() => finish(true)} disabled={busy !== 'idle'} style={secondaryBtn(busy !== 'idle')}>
            Skip
          </button>
          <button onClick={() => finish(false)} disabled={busy !== 'idle'} style={primaryBtn(busy !== 'idle')}>
            {busy === 'finishing' ? 'Setting up…' : 'Get started'}
          </button>
        </div>

        <button
          onClick={() => onNavigate({ name: 'models' })}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', cursor: 'pointer', marginTop: 12, padding: 0 }}
        >
          View all models
        </button>
      </div>
    </div>
  );
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 24px',
    border: 'none',
    borderRadius: 'var(--radius-pill)',
    background: 'var(--brand)',
    color: 'var(--on-brand)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'var(--fs-sm)',
    fontWeight: 500,
    opacity: disabled ? 0.6 : 1,
  };
}

function secondaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 20px',
    border: '1px solid var(--line-default)',
    borderRadius: 'var(--radius-pill)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'var(--fs-sm)',
    opacity: disabled ? 0.6 : 1,
  };
}
