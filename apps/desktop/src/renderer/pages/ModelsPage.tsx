import React, { useState, useEffect, useCallback } from 'react';
import { api, describeError, isDesktop } from '../api.js';
import type { WhisperModelEntry } from '../global.js';

export function ModelsPage() {
  const [models, setModels] = useState<WhisperModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      setError('Models are managed inside the Clipwright desktop app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setModels(await api.listModels());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return api.onModelProgress(({ modelName, percent }) => {
      setProgress((prev) => ({ ...prev, [modelName]: percent }));
    });
  }, []);

  const handleInstall = useCallback(async (name: string) => {
    setBusy(name);
    setError('');
    setProgress((prev) => ({ ...prev, [name]: 0 }));
    try {
      await api.installModel(name);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
      setProgress((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }, [load]);

  const handleDelete = useCallback(async (name: string) => {
    setBusy(name);
    setError('');
    try {
      await api.deleteModel(name);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }, [load]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
      <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
        Model Manager
      </h1>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', margin: '0 0 24px 0' }}>
        Whisper transcription models are stored in your workspace at <code>Models/whisper/</code>.
      </p>

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
        <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          Checking installed models…
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {models.map((m) => {
            const pct = progress[m.name];
            const isBusy = busy === m.name;
            return (
              <div key={m.name} style={{
                background: 'var(--surface-card)', borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--line-subtle)', padding: 20,
                display: 'flex', flexDirection: 'column', gap: 12,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>{m.label}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                      {formatBytes(m.installed ? m.bytes : m.expectedBytes)} · {m.speed}
                    </div>
                  </div>
                  {m.installed && (
                    <span style={{
                      padding: '2px 10px', borderRadius: 'var(--radius-full)',
                      background: 'var(--success-tint)', color: 'var(--success)',
                      fontSize: 'var(--fs-xs)', fontWeight: 500,
                    }}>Installed</span>
                  )}
                </div>

                {typeof pct === 'number' && (
                  <div>
                    <div style={{
                      height: 6, borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-raised)', overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${pct}%`, height: '100%',
                        background: 'var(--brand)', transition: 'width var(--dur-fast)',
                      }} />
                    </div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                      Downloading… {pct}%
                    </div>
                  </div>
                )}

                <div>
                  {m.installed ? (
                    <button
                      onClick={() => handleDelete(m.name)}
                      disabled={isBusy}
                      style={{
                        padding: '6px 16px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--danger)', background: 'transparent',
                        color: 'var(--danger)', cursor: isBusy ? 'not-allowed' : 'pointer',
                        fontSize: 'var(--fs-sm)', opacity: isBusy ? 0.6 : 1,
                      }}
                    >Delete</button>
                  ) : (
                    <button
                      onClick={() => handleInstall(m.name)}
                      disabled={isBusy}
                      style={{
                        padding: '6px 16px', borderRadius: 'var(--radius-sm)',
                        border: 'none', background: 'var(--brand)',
                        color: 'var(--on-brand)', cursor: isBusy ? 'not-allowed' : 'pointer',
                        fontSize: 'var(--fs-sm)', fontWeight: 500, opacity: isBusy ? 0.6 : 1,
                      }}
                    >{isBusy ? 'Installing…' : 'Install'}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return 'unknown size';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
