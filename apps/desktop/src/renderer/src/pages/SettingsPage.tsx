import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, KeyRound, Trash2, Plug, CloudOff, Cloud, Cpu, RefreshCw, CheckCircle2 } from 'lucide-react';
import { Button, Field, Input, Select, Toggle, StatusPill } from '@clipwright/design-system';
import { api, type OllamaStatus, type ProviderRow, type WhisperStatus } from '../api.js';
import { useAppStore } from '../stores.js';

const SECTIONS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'processing', label: 'Processing' },
  { id: 'models', label: 'Models' },
  { id: 'providers', label: 'AI providers' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'advanced', label: 'Advanced' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

export const SettingsPage = () => {
  const boot = useAppStore((s) => s.boot);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const toast = useAppStore((s) => s.toast);
  const [section, setSection] = useState<Section>('workspace');
  const [whisper, setWhisper] = useState<WhisperStatus | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o-mini');
  const [label, setLabel] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

  const settings = boot?.settings;

  const refreshAsync = useCallback(async (forceDetect = false) => {
    const [w, o, p] = await Promise.allSettled([api.whisper.listModels(forceDetect), api.ollama.status(), api.providers.list()]);
    if (w.status === 'fulfilled') setWhisper(w.value);
    if (o.status === 'fulfilled') setOllama(o.value);
    if (p.status === 'fulfilled') setProviders(p.value);
  }, []);

  useEffect(() => { void refreshAsync(); }, [refreshAsync]);

  const pickWorkspace = async () => {
    try {
      const picked = await api.pickWorkspaceFolder();
      if (picked) {
        await updateSettings({ workspaceFolder: picked });
        toast('Workspace moved.');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the workspace.', 'error');
    }
  };

  const addProvider = async () => {
    if (!baseUrl.trim() || apiKey.trim().length < 8 || !model.trim()) {
      toast('Base URL, a key of at least 8 characters and a model name are required.', 'error');
      return;
    }
    try {
      await api.providers.saveOpenAiCompatible({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), label: label.trim() || undefined });
      setApiKey(''); setLabel('');
      toast('Provider saved. The key is stored encrypted on this device.');
      void refreshAsync();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The provider could not be saved.', 'error');
    }
  };

  const testProvider = async (id: string) => {
    setTesting(id);
    try {
      const res = await api.providers.test(id);
      toast(`Provider replied: “${res.reply}”`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The test failed.', 'error');
    } finally { setTesting(null); }
  };

  if (!settings) return <div className="page"><p className="empty-hint">Loading settings…</p></div>;

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Everything lives in this workspace. Nothing leaves unless you switch it on.</p>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} aria-current={section === s.id ? 'true' : undefined} onClick={() => setSection(s.id)}>{s.label}</button>
          ))}
        </nav>

        <div>
          {section === 'workspace' && (
            <div className="settings-section">
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Workspace folder</div>
                  <div className="settings-row__hint">{settings.workspaceFolder ?? 'Not set'}</div>
                </div>
                <Button variant="secondary" onClick={() => void pickWorkspace()}><FolderOpen size={16} aria-hidden /> Change…</Button>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Default import</div>
                  <div className="settings-row__hint">Copy keeps originals inside the workspace; Reference uses the file where it lives.</div>
                </div>
                <Select
                  value={settings.lastUsed.storageMode ?? 'copy'}
                  onChange={(e) => void updateSettings({ lastUsed: { ...settings.lastUsed, storageMode: e.target.value === 'reference' ? 'reference' : 'copy' } })}
                  aria-label="Default import mode"
                >
                  <option value="copy">Copy into workspace</option>
                  <option value="reference">Reference in place</option>
                </Select>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Autosave</div>
                  <div className="settings-row__hint">Journal flushes continuously; a full checkpoint every {settings.autoSaveSeconds}s.</div>
                </div>
                <Select value={String(settings.autoSaveSeconds)} onChange={(e) => void updateSettings({ autoSaveSeconds: Number(e.target.value) })} aria-label="Autosave interval">
                  {[15, 30, 60, 120].map((n) => <option key={n} value={n}>{n}s</option>)}
                </Select>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Daily backup</div>
                  <div className="settings-row__hint">Keeps one copy of workspace.db per day in the Backup folder.</div>
                </div>
                <Toggle checked={settings.dailyAutoBackup} onChange={(v) => void updateSettings({ dailyAutoBackup: v })} aria-label="Daily backup" />
              </div>
            </div>
          )}

          {section === 'processing' && (
            <div className="settings-section">
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Processing mode</div>
                  <div className="settings-row__hint">Offline never contacts the network. Online uses the providers you add. Automatic tries local first.</div>
                </div>
                <Select value={settings.processingMode} onChange={(e) => void updateSettings({ processingMode: e.target.value as typeof settings.processingMode })} aria-label="Processing mode">
                  <option value="offline">Offline — everything on this PC</option>
                  <option value="online">Online — providers only</option>
                  <option value="automatic">Automatic — local first, then online</option>
                </Select>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Whisper model</div>
                  <div className="settings-row__hint">Default for transcription. Larger is slower but more accurate.</div>
                </div>
                <Select value={settings.transcriptionModel} onChange={(e) => void updateSettings({ transcriptionModel: e.target.value })} aria-label="Transcription model">
                  <option value="auto">Automatic (small)</option>
                  {whisper?.models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.installed ? '' : ' (not downloaded)'}</option>)}
                  {whisper?.fasterWhisper?.models.map((m) => <option key={`faster-whisper:${m.id}`} value={`faster-whisper:${m.id}`}>{m.name} (faster-whisper · detected)</option>)}
                </Select>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Ollama model</div>
                  <div className="settings-row__hint">{ollama?.available ? `Ollama ${ollama.version ?? ''} detected with ${ollama.models.length} model(s).` : 'Ollama not detected on localhost:11434.'}</div>
                </div>
                {ollama?.models?.length ? (
                  <Select value={settings.ollamaModel} onChange={(e) => void updateSettings({ ollamaModel: e.target.value })} aria-label="Ollama model">
                    {ollama.models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                ) : (
                  <Input value={settings.ollamaModel} onChange={(e) => void updateSettings({ ollamaModel: e.target.value })} aria-label="Ollama model tag" style={{ width: 160 }} />
                )}
              </div>
            </div>
          )}

          {section === 'models' && (
            <div className="settings-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="settings-row__label">Offline transcription models</div>
                <Button variant="ghost" size="28" onClick={() => void refreshAsync(true)}><RefreshCw size={14} aria-hidden /> Refresh</Button>
              </div>
              {!whisper?.binaryFound && !whisper?.fasterWhisper?.pythonPath && (
                <div className="notice notice--warning" role="status" style={{ marginBottom: 12 }}>
                  Neither whisper.cpp nor faster-whisper was detected in this build, so offline transcription will fail. Online transcription works regardless. Set CLIPWRIGHT_PYTHON to a Python that has faster-whisper installed to enable offline transcription.
                </div>
              )}
              {!whisper?.binaryFound && whisper?.fasterWhisper?.pythonPath && (
                <div className="notice" role="status" style={{ marginBottom: 12 }}>
                  whisper.cpp isn’t available in this build, but faster-whisper was detected (Python {whisper.fasterWhisper.version}{whisper.fasterWhisper.pythonLabel ? ` via ${whisper.fasterWhisper.pythonLabel}` : ''}). Select one of the detected faster-whisper models below to transcribe offline.
                </div>
              )}
              <div className="models-grid">
                {whisper?.models.map((m) => (
                  <div key={m.id} className="model-row">
                    <Cpu size={18} aria-hidden style={{ color: 'var(--text-muted)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{m.name}</div>
                      <div className="settings-row__hint">{(m.sizeBytes / 1024 ** 2).toFixed(0)} MB</div>
                    </div>
                    <StatusPill tone={m.installed ? 'success' : 'default'}>{m.installed ? 'Downloaded' : 'Not downloaded'}</StatusPill>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                <div className="settings-row__label" style={{ marginBottom: 6 }}>faster-whisper models detected on this PC</div>
                <p className="settings-row__hint" style={{ marginBottom: 8 }}>
                  Loaded from your Hugging Face hub cache: <code>{whisper?.fasterWhisper?.hubCache ?? ''}</code>
                  {whisper?.fasterWhisper?.pythonPath ? ` — via Python ${whisper.fasterWhisper.version ?? ''} (${whisper.fasterWhisper.pythonLabel ?? whisper.fasterWhisper.pythonPath}).` : ' — no Python with faster-whisper was found, so these cannot be used yet.'}
                </p>
                {!whisper?.fasterWhisper?.pythonPath && (whisper?.fasterWhisper?.models.length ?? 0) > 0 && (
                  <div className="notice notice--warning" role="status" style={{ marginBottom: 8 }}>
                    Faster-whisper models were found, but no working Python interpreter has the faster-whisper package. Install it with <code>pip install faster-whisper</code>, or set the <code>CLIPWRIGHT_PYTHON</code> environment variable to the right python.exe and press Refresh.
                  </div>
                )}
                <div className="models-grid">
                  {(whisper?.fasterWhisper?.models ?? []).map((m) => (
                    <div key={m.id} className="model-row">
                      <Cpu size={18} aria-hidden style={{ color: 'var(--text-muted)' }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{m.name}</div>
                        <div className="settings-row__hint">{(m.sizeBytes / 1024 ** 3).toFixed(2)} GB · CT2 · selectable in the Transcription model dropdown</div>
                      </div>
                      <StatusPill tone="success">Detected</StatusPill>
                    </div>
                  ))}
                  {(whisper?.fasterWhisper?.models?.length ?? 0) === 0 && (
                    <p className="empty-hint">No faster-whisper (CT2) models found in the Hugging Face hub cache. This scan is read-only and happens at startup or on Refresh.</p>
                  )}
                </div>
              </div>
              <p className="honesty" style={{ marginTop: 12 }}>whisper.cpp models come from the whisper.cpp releases on Hugging Face over HTTPS; checksums are verified when the official build ships them. faster-whisper detection is a read-only scan of your cache — the first transcription run loads the model for real.</p>
            </div>
          )}

          {section === 'providers' && (
            <>
              <div className="settings-section">
                <div className="settings-row__label" style={{ marginBottom: 8 }}>Your providers</div>
                {providers.length === 0 && <p className="empty-hint">No providers added. Moment analysis falls back to offline heuristics.</p>}
                {providers.map((p) => (
                  <div key={p.id} className="settings-row">
                    <div>
                      <div className="settings-row__label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {settings.preferredOnlineProviderId === p.id ? <Cloud size={14} aria-hidden /> : <CloudOff size={14} aria-hidden />}
                        {p.displayName}
                      </div>
                      <div className="settings-row__hint">{p.baseUrl} · {p.model}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Button variant="ghost" size="28" onClick={() => void updateSettings({ preferredOnlineProviderId: settings.preferredOnlineProviderId === p.id ? null : p.id })}>
                        {settings.preferredOnlineProviderId === p.id ? 'Preferred' : 'Make preferred'}
                      </Button>
                      <Button variant="secondary" size="28" onClick={() => void testProvider(p.id)} loading={testing === p.id}><Plug size={14} aria-hidden /> Test</Button>
                      <Button variant="ghost" size="28" aria-label="Delete provider" onClick={() => { if (window.confirm(`Remove “${p.displayName}”? The stored key is also deleted.`)) void api.providers.delete(p.id).then(refreshAsync); }}>
                        <Trash2 size={14} aria-hidden />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-section">
                <div className="settings-row__label" style={{ marginBottom: 8 }}>Add an OpenAI-compatible provider</div>
                <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                  <Field label="Base URL" hint="Any OpenAI-compatible endpoint, e.g. https://api.openai.com/v1">
                    <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
                  </Field>
                  <Field label="Model">
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
                  </Field>
                  <Field label="Label" hint="Optional — shown in the app">
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My provider" />
                  </Field>
                  <Field label="API key" hint="Stored encrypted with your OS keychain (safeStorage). Never written to logs.">
                    <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
                  </Field>
                  <div><Button variant="primary" onClick={() => void addProvider()}><KeyRound size={16} aria-hidden /> Save provider</Button></div>
                </div>
              </div>
            </>
          )}

          {section === 'privacy' && (
            <div className="settings-section">
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">All processing stays on this PC</div>
                  <div className="settings-row__hint">Offline mode makes no network calls except update checks, which you control. Transcripts and media never leave your device.</div>
                </div>
                <StatusPill tone="success"><CheckCircle2 size={12} aria-hidden /> On</StatusPill>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">API keys</div>
                  <div className="settings-row__hint">{boot?.secretsMemoryOnly ? 'Your system keychain is unavailable, so keys live in memory only for this session.' : 'Keys are encrypted at rest with the OS keychain.'}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Diagnostics log</div>
                  <div className="settings-row__hint">Stored in the workspace Logs folder. API keys and file contents are never written to it.</div>
                </div>
                <Button variant="ghost" size="28" onClick={() => settings.workspaceFolder && void api.revealPath(settings.workspaceFolder)}>Open folder</Button>
              </div>
            </div>
          )}

          {section === 'advanced' && (
            <div className="settings-section">
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Target loudness</div>
                  <div className="settings-row__hint">Exported audio is normalised to this level.</div>
                </div>
                <Select value={String(settings.loudnessTargetLufs)} onChange={(e) => void updateSettings({ loudnessTargetLufs: Number(e.target.value) })} aria-label="Loudness target">
                  {[-23, -20, -16, -14].map((n) => <option key={n} value={n}>{n} LUFS</option>)}
                </Select>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Audio ducking</div>
                  <div className="settings-row__hint">Lower music under speech while editing and on export.</div>
                </div>
                <Toggle checked={settings.duckingEnabled} onChange={(v) => void updateSettings({ duckingEnabled: v })} aria-label="Ducking" />
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Restore points</div>
                  <div className="settings-row__hint">Save a snapshot at most every few minutes while you edit.</div>
                </div>
                <Toggle checked={settings.restorePoints} onChange={(v) => void updateSettings({ restorePoints: v })} aria-label="Restore points" />
              </div>
              <p className="honesty" style={{ marginTop: 12 }}>Clipwright Studio {boot?.version} · workspace schema v1 · No telemetry.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
