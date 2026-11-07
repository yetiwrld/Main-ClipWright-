import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  Dialog,
  Input,
  ProgressLinear,
  Tabs,
  useToast,
} from '@clipwright/design-system';
import { CheckCircle2, Download, FolderOpen, HardDrive, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { api, describeError, isDesktop } from '../api.js';
import type {
  AppSettings,
  ModelCardPayload,
  ModelDownloadProgressPayload,
  ModelSnapshotPayload,
  OllamaOverviewPayload,
} from '../global.js';

type TabId = 'speech' | 'language' | 'vision' | 'storage';

/**
 * SPEC 06 §7 — the Local Model Manager.
 *
 * Every status shown here is derived from the disk and from live probes: a model
 * is "Installed ✓ verified" only when its file size matches the catalogue *and*
 * a digest was checked. Nothing claims a speed or a quality we have not measured.
 */
export function ModelsPage() {
  const { pushToast } = useToast();
  const [tab, setTab] = useState<TabId>('speech');
  const [snapshot, setSnapshot] = useState<ModelSnapshotPayload | null>(null);
  const [ollama, setOllama] = useState<OllamaOverviewPayload | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string; kind: 'whisper' | 'ollama' } | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setError('Local models are managed inside the Clipwright desktop app.');
      return;
    }
    try {
      const [next, ollamaNext, appSettings] = await Promise.all([
        api.modelSnapshot(),
        api.ollamaOverview().catch(() => null),
        api.getSettings(),
      ]);
      setSnapshot(next);
      setOllama(ollamaNext);
      setSettings(appSettings);
      setError('');
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live download progress: the card is patched in place so the list does not jump.
  useEffect(() => {
    return api.onModelDownloadProgress((event: ModelDownloadProgressPayload) => {
      setSnapshot((prev) => {
        if (!prev) return prev;
        const patch = (cards: ModelCardPayload[]) =>
          cards.map((card) =>
            card.id === event.id
              ? {
                  ...card,
                  status: event.status,
                  progress: event.percent ?? card.progress,
                  bytesPerSecond: event.bytesPerSecond,
                  etaSeconds: event.etaSeconds,
                  installedBytes: event.bytesReceived,
                  verified: event.verified ?? card.verified,
                  error: event.error,
                }
              : card
          );
        return { ...prev, whisper: patch(prev.whisper), onnx: patch(prev.onnx) };
      });
      if (event.status === 'installed' || event.error) {
        void load();
      }
    });
  }, [load]);

  const download = async (modelId: string) => {
    setBusy(modelId);
    try {
      const result = await api.downloadModel(modelId);
      if (!result.queued) pushToast({ message: 'That download is already running.', tone: 'neutral' });
      else pushToast({ message: 'Download started. You can keep working.', tone: 'info' });
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (modelId: string) => {
    await api.cancelModelDownload(modelId);
    await load();
  };

  const verify = async (modelId: string) => {
    try {
      const result = await api.verifyModel(modelId);
      pushToast({ message: result.message, tone: result.ok ? 'success' : 'error' });
      await load();
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.kind === 'whisper') await api.deleteSpeechModel(confirmDelete.id);
      else await api.deleteOllamaModel(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const installedWhisper = snapshot?.whisper.filter((card) => card.status === 'installed') ?? [];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Local models</h1>
        <p style={{ margin: '4px 0 0 0', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          Everything here runs on this computer. Downloads are resumable and verified against a published checksum
          where one exists.
        </p>
      </header>

      {error && (
        <div
          style={{
            padding: 'var(--space-3)',
            marginBottom: 16,
            borderRadius: 'var(--radius-md)',
            background: 'var(--error-tint)',
            color: 'var(--error)',
            fontSize: 'var(--fs-sm)',
          }}
        >
          {error}
        </div>
      )}

      <CapabilityCard snapshot={snapshot} ollama={ollama} onGoToModels={() => setTab('speech')} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '24px 0 12px 0', flexWrap: 'wrap' }}>
        <Tabs
          ariaLabel="Model categories"
          activeId={tab}
          onChange={(id) => setTab(id as TabId)}
          tabs={[
            { id: 'speech', label: 'Speech (Whisper)' },
            { id: 'language', label: 'Language (Ollama)' },
            { id: 'vision', label: 'Vision/detection' },
            { id: 'storage', label: 'Storage' },
          ]}
        />
        <span style={{ flex: 1 }} />
        <Button size={28} icon={<RefreshCw size={14} />} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {snapshot && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--surface-panel)',
            border: '1px solid var(--line-subtle)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 16,
            flexWrap: 'wrap',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-muted)',
          }}
        >
          <FolderOpen size={14} />
          <span style={{ fontFamily: 'var(--font-mono)' }}>{snapshot.folders.whisper}</span>
          <span style={{ flex: 1 }} />
          <span>
            {formatBytes(snapshot.disk.whisperBytes + snapshot.disk.onnxBytes)} used ·{' '}
            {snapshot.disk.freeGb.toFixed(1)} GB free
          </span>
          <Button size={28} onClick={() => void api.openModelsFolder()}>
            Open folder
          </Button>
        </div>
      )}

      {tab === 'speech' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!snapshot && <p style={muted}>Reading the models folder…</p>}
          {snapshot?.whisper.map((card) => (
            <WhisperCard
              key={card.id}
              card={card}
              isDefault={settings?.defaultWhisperModel === card.id}
              busy={busy === card.id}
              onDownload={() => void download(card.id)}
              onCancel={() => void cancel(card.id)}
              onVerify={() => void verify(card.id)}
              onDelete={() => setConfirmDelete({ id: card.id, label: card.label, kind: 'whisper' })}
              onSetDefault={() =>
                void api
                  .setDefaultModel(card.id)
                  .then((next) => {
                    setSettings(next);
                    pushToast({ message: `${card.label} is now the default for new projects.`, tone: 'success' });
                  })
                  .catch((err) => pushToast({ message: describeError(err), tone: 'error' }))
              }
            />
          ))}
          {installedWhisper.length === 0 && snapshot && (
            <p style={muted}>
              No speech model installed yet. Transcription needs one of these; Small is the usual starting
              point for captions.
            </p>
          )}
        </div>
      )}

      {tab === 'language' && (
        <OllamaTab
          overview={ollama}
          onRefresh={() => void load()}
          onSetAddress={async (url) => {
            await api.setOllamaBaseUrl(url);
            await load();
          }}
          onSetDefault={(modelName) =>
            void api
              .setDefaultProvider('moment_analysis', null)
              .then(() => pushToast({ message: `${modelName} will be used for moment analysis.`, tone: 'success' }))
              .catch((err) => pushToast({ message: describeError(err), tone: 'error' }))
          }
          onDelete={(modelName) => setConfirmDelete({ id: modelName, label: modelName, kind: 'ollama' })}
        />
      )}

      {tab === 'vision' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {snapshot?.onnx.map((card) => (
            <Card key={card.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 'var(--fs-md)', color: 'var(--text-primary)' }}>{card.label}</strong>
                <Chip variant={card.status === 'installed' ? 'success' : 'neutral'}>
                  {card.bundled ? 'Bundled' : card.status === 'installed' ? 'Installed' : 'Not installed'}
                </Chip>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{formatBytes(card.expectedBytes)}</span>
              </div>
              <p style={{ margin: '6px 0 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{card.notes}</p>
            </Card>
          ))}
          {!snapshot && <p style={muted}>Reading the models folder…</p>}
        </div>
      )}

      {tab === 'storage' && snapshot && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card>
            <h2 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
              Disk usage
            </h2>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--fs-sm)' }}>
              <StorageRow label="Speech models" bytes={snapshot.disk.whisperBytes} />
              <StorageRow label="Vision models" bytes={snapshot.disk.onnxBytes} />
              <StorageRow label="Free on this drive" bytes={snapshot.disk.freeGb * 1024 ** 3} />
            </div>
          </Card>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)' }}>Models folder</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                  {snapshot.folders.whisper}
                </div>
              </div>
              <Button size={28} onClick={() => void api.openModelsFolder()}>
                Open folder
              </Button>
            </div>
          </Card>
        </div>
      )}

      <Dialog
        open={Boolean(confirmDelete)}
        title={`Delete ${confirmDelete?.label ?? 'model'}?`}
        onClose={() => setConfirmDelete(null)}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          The file is removed from this computer. You can download it again later, which takes the same time as before.
        </p>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------ capability */

function CapabilityCard({
  snapshot,
  ollama,
  onGoToModels,
}: {
  snapshot: ModelSnapshotPayload | null;
  ollama: OllamaOverviewPayload | null;
  onGoToModels: () => void;
}) {
  const whisper = snapshot?.whisper.find((card) => card.status === 'installed');
  const ollamaReady = ollama?.status.state === 'running' && ollama.models.length > 0;

  const rows: Array<{ label: string; state: 'yes' | 'no' | 'setup'; needs: string; action?: React.ReactNode }> = [
    { label: 'Import and edit', state: 'yes', needs: 'Built in' },
    { label: 'Save projects', state: 'yes', needs: 'Built in' },
    { label: 'Export', state: 'yes', needs: 'Built in' },
    {
      label: 'Transcription',
      state: whisper ? 'yes' : 'setup',
      needs: whisper ? whisper.label : 'A Whisper model',
      action: !whisper ? <Button size={28} onClick={onGoToModels}>Choose a model</Button> : undefined,
    },
    {
      label: 'Moment analysis',
      state: ollamaReady ? 'yes' : 'setup',
      needs: ollamaReady ? `Ollama ${ollama?.models[0]?.name ?? ''}` : 'Ollama with a model, or Basic scoring works now',
    },
    {
      label: 'AI editing tools',
      state: ollamaReady ? 'yes' : 'setup',
      needs: ollamaReady ? 'Ollama' : 'A language model (Ollama)',
    },
    { label: 'URL download', state: 'setup', needs: 'Needs internet' },
  ];

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <HardDrive size={16} />
        <h2 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>What works offline</h2>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '180px 110px 1fr auto', gap: 12, alignItems: 'center', fontSize: 'var(--fs-xs)' }}>
            <span style={{ color: 'var(--text-primary)' }}>{row.label}</span>
            <span>
              {row.state === 'yes' ? (
                <Chip variant="success">Works now</Chip>
              ) : row.state === 'no' ? (
                <Chip variant="error">No</Chip>
              ) : (
                <Chip variant="warning">Needs setup</Chip>
              )}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>{row.needs}</span>
            <span>{row.action}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- whisper */

function WhisperCard({
  card,
  isDefault,
  busy,
  onDownload,
  onCancel,
  onVerify,
  onDelete,
  onSetDefault,
}: {
  card: ModelCardPayload;
  isDefault: boolean;
  busy: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onVerify: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const downloading = card.status === 'downloading' || card.status === 'verifying';
  const installed = card.status === 'installed';
  const paused = card.status === 'paused';

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 240, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-md)', color: 'var(--text-primary)' }}>{card.label}</strong>
            <Chip variant={installed ? 'success' : card.status === 'corrupt' ? 'error' : 'neutral'}>
              {installed
                ? card.verified === true
                  ? 'Installed · verified'
                  : 'Installed · unverified'
                : card.status === 'corrupt'
                  ? 'Corrupt — re-download'
                  : paused
                    ? `Paused at ${card.progress}%`
                    : downloading
                      ? `Downloading ${card.progress}%`
                      : 'Not installed'}
            </Chip>
            <CompatibilityChip compatibility={card.compatibility} />
            {isDefault && <Chip variant="brand">Default</Chip>}
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            {card.languages} · {accuracyLabel(card.accuracy)} · {formatBytes(card.expectedBytes)} · about{' '}
            {card.ramGb} GB RAM
            {card.speedFactor ? ` · measured ${card.speedFactor.toFixed(1)}× real time here` : ' · speed unknown until first run'}
          </div>
          {card.notes && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>{card.notes}</div>
          )}
          {card.checksumMissing && installed && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning)', marginTop: 2 }}>
              No published checksum for this file yet, so its bytes cannot be verified.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!installed && !downloading && (
            <Button size={28} variant={paused ? 'secondary' : 'primary'} loading={busy} onClick={onDownload} icon={<Download size={14} />}>
              {paused ? 'Resume' : card.status === 'corrupt' ? 'Re-download' : 'Download'}
            </Button>
          )}
          {downloading && (
            <Button size={28} onClick={onCancel}>
              Cancel
            </Button>
          )}
          {installed && !isDefault && (
            <Button size={28} onClick={onSetDefault}>
              Set as default
            </Button>
          )}
          {installed && card.verified !== true && !card.checksumMissing && (
            <Button size={28} icon={<CheckCircle2 size={14} />} onClick={onVerify}>
              Verify
            </Button>
          )}
          {(installed || paused || card.status === 'corrupt') && (
            <Button size={28} variant="ghost" icon={<Trash2 size={14} />} onClick={onDelete}>
              Delete
            </Button>
          )}
        </div>
      </div>
      {downloading && (
        <div style={{ marginTop: 12 }}>
          <ProgressLinear value={card.progress} />
          <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            <span>
              {formatBytes(card.installedBytes)} of {formatBytes(card.expectedBytes)}
            </span>
            {card.bytesPerSecond ? <span>{formatBytes(card.bytesPerSecond)}/s</span> : null}
            {typeof card.etaSeconds === 'number' ? <span>{formatEta(card.etaSeconds)}</span> : null}
          </div>
        </div>
      )}
      {paused && (
        <div style={{ marginTop: 12 }}>
          <ProgressLinear value={card.progress} />
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            {formatBytes(card.installedBytes)} already downloaded — Resume continues from there.
          </div>
        </div>
      )}
      {card.error && (
        <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--error)' }}>{card.error}</div>
      )}
    </Card>
  );
}

function CompatibilityChip({ compatibility }: { compatibility: ModelCardPayload['compatibility'] }) {
  switch (compatibility) {
    case 'good_fit':
      return <Chip variant="success">Good fit</Chip>;
    case 'slow':
      return (
        <Chip variant="warning">
          <TriangleAlert size={12} /> Slow here
        </Chip>
      );
    case 'may_run_out':
      return (
        <Chip variant="error">
          <TriangleAlert size={12} /> May run out of memory
        </Chip>
      );
    default:
      return <Chip variant="neutral">Memory unknown</Chip>;
  }
}

/* ---------------------------------------------------------------- ollama */

function OllamaTab({
  overview,
  onRefresh,
  onSetAddress,
  onSetDefault,
  onDelete,
}: {
  overview: OllamaOverviewPayload | null;
  onRefresh: () => void;
  onSetAddress: (url: string) => Promise<void>;
  onSetDefault: (modelName: string) => void;
  onDelete: (modelName: string) => void;
}) {
  const { pushToast } = useToast();
  const [modelName, setModelName] = useState('');
  const [pull, setPull] = useState<{ model: string; status: string; percent: number } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ model: string; ok: boolean; message: string } | null>(null);
  const [address, setAddress] = useState(overview?.baseUrl ?? '');
  const [addressOpen, setAddressOpen] = useState(false);

  useEffect(() => {
    setAddress(overview?.baseUrl ?? '');
  }, [overview?.baseUrl]);

  useEffect(() => {
    return api.onOllamaPullProgress((progress) => {
      setPull(progress);
      if (progress.percent >= 100) {
        setPull(null);
        onRefresh();
      }
    });
  }, [onRefresh]);

  const state = overview?.status.state ?? 'not_found';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Chip variant={state === 'running' ? 'success' : state === 'error' ? 'error' : 'warning'}>
            {state === 'running' ? `Running${overview?.status.version ? ` · v${overview.status.version}` : ''}` : state === 'error' ? 'Error' : 'Not found'}
          </Chip>
          <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {overview?.status.host ?? ''}
          </span>
          <span style={{ flex: 1 }} />
          {state !== 'running' && (
            <Button size={28} onClick={() => void onSetAddress(address || overview?.baseUrl || 'http://localhost:11434')}>
              Retry
            </Button>
          )}
          <Button size={28} onClick={() => setAddressOpen(true)}>
            Use another address
          </Button>
        </div>
        {state === 'not_found' && (
          <p style={{ margin: '8px 0 0 0', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            Ollama is a separate free app that runs language models on your computer. Install it, start it, then press
            Retry. Until then, moment analysis uses Basic scoring and needs no model.
          </p>
        )}
        {state === 'error' && overview?.status.message && (
          <p style={{ margin: '8px 0 0 0', fontSize: 'var(--fs-sm)', color: 'var(--error)' }}>{overview.status.message}</p>
        )}
      </Card>

      {state === 'running' && (
        <Card>
          <h2 style={{ margin: '0 0 8px 0', fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
            Installed models
          </h2>
          {overview?.models.length === 0 && (
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              Ollama is running but has no models yet. Pull one below.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {overview?.models.map((model) => (
              <div
                key={model.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 'var(--space-2) var(--space-3)',
                  background: 'var(--surface-panel)',
                  borderRadius: 'var(--radius-sm)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)' }}>{model.name}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    {[model.parameterSize, model.quantisation, model.sizeBytes ? formatBytes(model.sizeBytes) : null]
                      .filter(Boolean)
                      .join(' · ')}
                    {model.modifiedAt ? ` · modified ${new Date(model.modifiedAt).toLocaleDateString()}` : ''}
                  </div>
                  {overview?.ramWarningFor === model.name && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning)' }}>
                      This model may be slow or fail on this computer — it is larger than 70% of free RAM.
                    </div>
                  )}
                  {testResult?.model === model.name && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: testResult.ok ? 'var(--success)' : 'var(--error)' }}>
                      {testResult.message}
                    </div>
                  )}
                </div>
                <Button
                  size={28}
                  loading={testing === model.name}
                  onClick={() =>
                    void (async () => {
                      setTesting(model.name);
                      try {
                        const result = await api.testOllamaModel(model.name);
                        setTestResult({ model: model.name, ...result });
                      } catch (err) {
                        setTestResult({ model: model.name, ok: false, message: describeError(err) });
                      } finally {
                        setTesting(null);
                      }
                    })()
                  }
                >
                  Test
                </Button>
                <Button size={28} onClick={() => onSetDefault(model.name)}>
                  Set as default
                </Button>
                <Button size={28} variant="ghost" onClick={() => onDelete(model.name)}>
                  Delete
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
          Get a model
        </h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="Model name, exactly as Ollama lists it"
            />
          </div>
          <Button
            variant="primary"
            size={32}
            disabled={!modelName.trim() || Boolean(pull)}
            onClick={() =>
              void api
                .pullOllamaModel(modelName.trim())
                .then(() => {
                  setModelName('');
                  onRefresh();
                })
                .catch((err) => pushToast({ message: describeError(err), tone: 'error' }))
            }
          >
            Pull
          </Button>
          {pull && (
            <Button size={32} onClick={() => void api.cancelOllamaPull(pull.model)}>
              Cancel
            </Button>
          )}
        </div>
        {pull && (
          <div style={{ marginTop: 10 }}>
            <ProgressLinear value={pull.percent} />
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
              {pull.model}: {pull.status} · {pull.percent}%
            </div>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>
            Suggested starting points — suggestions, not recommendations:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {overview?.suggestions.map((suggestion) => (
              <button
                key={suggestion.name}
                type="button"
                onClick={() => setModelName(suggestion.name)}
                title={`${suggestion.notes} · needs about ${suggestion.ramGuidanceGb} GB RAM`}
                style={{
                  background: 'var(--surface-panel)',
                  border: '1px solid var(--line-subtle)',
                  borderRadius: 'var(--radius-pill)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--fs-xs)',
                  padding: '4px 10px',
                  cursor: 'pointer',
                }}
              >
                {suggestion.name} · ~{suggestion.approxSizeGb} GB
              </button>
            ))}
          </div>
        </div>
        <p style={{ margin: '10px 0 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Context size: {overview?.numCtx ?? 8192} tokens (change it in Settings → AI providers).
        </p>
      </Card>

      <Dialog
        open={addressOpen}
        title="Ollama address"
        onClose={() => setAddressOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" onClick={() => setAddressOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                void onSetAddress(address.trim()).then(() => {
                  setAddressOpen(false);
                  onRefresh();
                })
              }
            >
              Save address
            </Button>
          </div>
        }
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          Base URL
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://localhost:11434" />
        </label>
        <p style={{ margin: '8px 0 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          An address on your network means transcript text leaves this computer, so Clipwright will ask for permission
          before the first use.
        </p>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

function StorageRow({ label, bytes }: { label: string; bytes: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)' }}>{formatBytes(bytes)}</span>
    </div>
  );
}

function accuracyLabel(tier?: ModelCardPayload['accuracy']): string {
  switch (tier) {
    case 'fastest':
      return 'Fastest';
    case 'fast':
      return 'Fast';
    case 'balanced':
      return 'Balanced';
    case 'accurate':
      return 'Accurate';
    case 'most_accurate':
      return 'Most accurate';
    default:
      return 'Unrated';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-secondary)',
};
