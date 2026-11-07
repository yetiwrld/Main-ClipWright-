import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  Input,
  Select,
  useToast,
} from '@clipwright/design-system';
import { Cpu } from 'lucide-react';
import { api, describeError, isDesktop } from '../api.js';
import type {
  AiTask,
  AppSettings,
  Capability,
  ProviderListPayload,
  ProviderPresetPayload,
  ProviderRecordPayload,
  ProviderSaveInput,
  TestStepPayload,
} from '../global.js';
import { ModePanel } from '../components/ai/ModePanel.js';

const TASK_LABELS: Record<AiTask, string> = {
  transcription: 'Transcription',
  moment_analysis: 'Moment analysis',
  titles: 'Titles',
  editor_ai: 'Editor AI',
};

/**
 * SPEC 06 §4 — Settings → AI providers.
 *
 * Everything destructive is confirmed, keys are never shown, and "Test" reports
 * the individual steps it actually ran rather than a green tick it cannot back up.
 */
export function AiProvidersSection({
  settings,
  onUpdateSettings,
}: {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { pushToast } = useToast();
  const [data, setData] = useState<ProviderListPayload | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ProviderSaveInput | null>(null);
  const [removing, setRemoving] = useState<ProviderRecordPayload | null>(null);
  const [testState, setTestState] = useState<{ providerId: string; steps: TestStepPayload[]; ok: boolean } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setError('AI providers are configured inside the Clipwright desktop app.');
      return;
    }
    try {
      setData(await api.listProviders());
      setError('');
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = async (providerId: string) => {
    setTesting(providerId);
    try {
      const result = await api.testProvider(providerId);
      setTestState({ providerId, steps: result.result.steps, ok: result.result.ok });
      await load();
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    } finally {
      setTesting(null);
    }
  };

  const save = async (input: ProviderSaveInput) => {
    try {
      const saved = await api.saveProvider(input);
      setEditing(null);
      await load();
      pushToast({ message: `${saved.name} saved. Test it to check the connection.`, tone: 'success' });
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.removeProvider(removing.id);
      setRemoving(null);
      await load();
      pushToast({ message: `${removing.name} removed.`, tone: 'neutral' });
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const setDefault = async (task: AiTask, providerId: string | null) => {
    try {
      await api.setDefaultProvider(task, providerId);
      await onUpdateSettings({ defaultProviders: { ...settings.defaultProviders, [task]: providerId ?? undefined } });
      await load();
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 980 }}>
      {error && <InlineError message={error} />}

      <section>
        <SectionTitle
          title="Processing mode"
          hint="Offline never sends anything. Automatic only uses a provider you have allowed."
        />
        <ModePanel
          mode={settings.processingMode}
          onChange={(mode) => void onUpdateSettings({ processingMode: mode })}
        />
      </section>

      <section>
        <SectionTitle
          title="Providers"
          hint="A provider is an endpoint that can transcribe audio or read text. Keys stay in the Windows credential store."
          action={
            <Button variant="primary" onClick={() => setEditing(emptyProvider())}>
              Add provider
            </Button>
          }
        />
        {!data && <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>Loading providers…</p>}
        {data?.providers.length === 0 && (
          <EmptyState
            icon={<Cpu size={20} />}
            title="No providers yet"
            explanation="Clipwright works offline with a Whisper model. Add a provider only if you want cloud transcription or a language model."
            actionLabel="Add your first provider"
            onAction={() => setEditing(emptyProvider())}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data?.providers.map((provider) => (
            <ProviderRow
              key={provider.record.id}
              record={provider.record}
              keyAvailable={provider.keyAvailable}
              testing={testing === provider.record.id}
              onTest={() => void runTest(provider.record.id)}
              onEdit={() =>
                setEditing({
                  id: provider.record.id,
                  name: provider.record.name,
                  kind: provider.record.kind,
                  baseUrl: provider.record.baseUrl,
                  locality: provider.record.locality,
                  models: provider.record.models,
                  capabilities: provider.record.capabilities,
                  timeoutMs: provider.record.timeoutMs,
                  maxConcurrent: provider.record.maxConcurrent,
                  numCtx: provider.record.numCtx,
                })
              }
              onRemove={() => setRemoving(provider.record)}
              onDuplicate={() =>
                void api
                  .duplicateProvider(provider.record.id)
                  .then(() => {
                    pushToast({ message: 'Copy created — add its key and test it.', tone: 'success' });
                    return load();
                  })
                  .catch((err) => pushToast({ message: describeError(err), tone: 'error' }))
              }
            />
          ))}
        </div>
        {testState && <TestSteps state={testState} onClose={() => setTestState(null)} />}
      </section>

      <section>
        <SectionTitle title="Ollama" hint="A free app that runs language models on this computer." />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: 'var(--space-3)',
            background: 'var(--surface-card)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--line-subtle)',
            flexWrap: 'wrap',
          }}
        >
          <Chip variant={data?.ollama.state === 'running' ? 'success' : data?.ollama.state === 'error' ? 'error' : 'warning'}>
            {data?.ollama.state === 'running'
              ? `Running${data.ollama.version ? ` · v${data.ollama.version}` : ''}`
              : data?.ollama.state === 'error'
                ? 'Error'
                : 'Not found'}
          </Chip>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{data?.ollama.host ?? settings.ollamaBaseUrl}</span>
          <span style={{ flex: 1 }} />
          <Button
            size={28}
            onClick={() => {
              void (async () => {
                try {
                  const url = window.prompt('Ollama address', settings.ollamaBaseUrl);
                  if (!url) return;
                  await api.setOllamaBaseUrl(url);
                  await onUpdateSettings({ ollamaBaseUrl: url.trim() });
                  await load();
                } catch (err) {
                  pushToast({ message: describeError(err), tone: 'error' });
                }
              })();
            }}
          >
            Use another address
          </Button>
          <Button size={28} onClick={() => void load()}>
            Retry
          </Button>
        </div>
        <p style={{ margin: '8px 0 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Context size for local models:{' '}
          <Select
            value={String(settings.llmNumCtx)}
            onChange={(value) => void onUpdateSettings({ llmNumCtx: Number(value) as AppSettings['llmNumCtx'] })}
            options={[
              { value: '4096', label: '4096 tokens' },
              { value: '8192', label: '8192 tokens (default)' },
              { value: '16384', label: '16384 tokens' },
              { value: '32768', label: '32768 tokens (needs more RAM)' },
            ]}
          />{' '}
          — moment batches are sized from this.
        </p>
      </section>

      <section>
        <SectionTitle
          title="Which provider runs each task"
          hint="Leave a task on Automatic unless you want to force a particular endpoint."
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(Object.keys(TASK_LABELS) as AiTask[]).map((task) => {
            const capable = (data?.providers ?? []).filter((provider) =>
              provider.record.capabilities.includes((task === 'transcription' ? 'transcription' : 'text') as Capability)
            );
            return (
              <div key={task} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>{TASK_LABELS[task]}</span>
                <Select
                  value={settings.defaultProviders[task] ?? ''}
                  onChange={(value) => void setDefault(task, value || null)}
                  options={[
                    { value: '', label: 'Automatic' },
                    ...capable.map((provider) => ({
                      value: provider.record.id,
                      label: `${provider.record.name} (${hostOf(provider.record.baseUrl)})`,
                    })),
                  ]}
                />
              </div>
            );
          })}
        </div>
      </section>

      <ProviderDialog
        input={editing}
        presets={data?.presets ?? []}
        onClose={() => setEditing(null)}
        onSave={(input) => void save(input)}
      />

      <Dialog
        open={Boolean(removing)}
        title={`Remove ${removing?.name ?? 'provider'}?`}
        onClose={() => setRemoving(null)}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Remove provider
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          Its stored key and any permissions you granted will be deleted. Tasks set to this provider go back to Automatic.
        </p>
      </Dialog>
    </div>
  );
}

function emptyProvider(): ProviderSaveInput {
  return { name: '', kind: 'openai-compatible', baseUrl: 'https://', capabilities: ['text'] };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
      <div style={{ flex: 1 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h2>
        {hint && <p style={{ margin: '2px 0 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--error-tint)',
        color: 'var(--error)',
        fontSize: 'var(--fs-sm)',
      }}
    >
      {message}
    </div>
  );
}

function ProviderRow({
  record,
  keyAvailable,
  testing,
  onTest,
  onEdit,
  onRemove,
  onDuplicate,
}: {
  record: ProviderRecordPayload;
  keyAvailable: boolean;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const statusTone =
    record.status === 'connected' ? 'success' : record.status === 'key_missing' ? 'warning' : record.status === 'error' ? 'error' : 'neutral';
  const statusLabel =
    record.status === 'connected'
      ? 'Connected'
      : record.status === 'key_missing'
        ? 'Key missing'
        : record.status === 'error'
          ? 'Error'
          : 'Not tested';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--surface-card)',
        border: '1px solid var(--line-subtle)',
        borderRadius: 'var(--radius-md)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 220, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>{record.name}</span>
          <Chip variant={statusTone}>{statusLabel}</Chip>
          <Chip variant="neutral">
            {record.locality === 'local' ? 'On this computer' : record.locality === 'network' ? 'On your network' : 'Internet'}
          </Chip>
        </div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
          {hostOf(record.baseUrl)} · {record.capabilities.join(' + ') || 'no capabilities'}
          {record.hasKey ? ` · key ${record.maskedKeySuffix ?? '••••'}` : ''}
        </div>
        {record.lastError && (
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--error)', marginTop: 2 }}>{record.lastError}</div>
        )}
      </div>
      <Button size={28} loading={testing} onClick={onTest}>
        Test
      </Button>
      <Button size={28} onClick={onEdit}>
        {keyAvailable ? 'Edit' : 'Add key'}
      </Button>
      <Button size={28} onClick={onDuplicate}>
        Duplicate
      </Button>
      <Button size={28} variant="ghost" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

function TestSteps({
  state,
  onClose,
}: {
  state: { steps: TestStepPayload[]; ok: boolean };
  onClose: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 8,
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-panel)',
        border: '1px solid var(--line-default)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Chip variant={state.ok ? 'success' : 'error'}>{state.ok ? 'Connection works' : 'Connection failed'}</Chip>
        <span style={{ flex: 1 }} />
        <Button size={28} variant="ghost" onClick={onClose}>
          Hide
        </Button>
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {state.steps.map((step, index) => (
          <li key={`${step.step}-${index}`} style={{ fontSize: 'var(--fs-sm)', color: step.ok ? 'var(--text-secondary)' : 'var(--danger)' }}>
            <strong style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{labelForStep(step.step)}</strong>
            {' — '}
            {step.message}
            {typeof step.latencyMs === 'number' ? ` (${step.latencyMs} ms)` : ''}
          </li>
        ))}
      </ol>
    </div>
  );
}

function labelForStep(step: TestStepPayload['step']): string {
  switch (step) {
    case 'reach':
      return 'Reachable';
    case 'authenticate':
      return 'Key accepted';
    case 'model':
      return 'Model available';
    case 'capability':
      return 'Capability check';
  }
}

function ProviderDialog({
  input,
  presets,
  onClose,
  onSave,
}: {
  input: ProviderSaveInput | null;
  presets: ProviderPresetPayload[];
  onClose: () => void;
  onSave: (input: ProviderSaveInput) => void;
}) {
  const [form, setForm] = useState<ProviderSaveInput>(input ?? emptyProvider());
  const [key, setKey] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setForm(input ?? emptyProvider());
    setKey('');
    setShowAdvanced(false);
  }, [input]);

  const applyPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setForm((prev) => ({
      ...prev,
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      locality: preset.locality,
      capabilities: preset.capabilities,
    }));
  };

  return (
    <Dialog
      open={Boolean(input)}
      title={input?.id ? 'Edit provider' : 'Add a provider'}
      onClose={onClose}
      maxWidth={600}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              onSave({
                ...form,
                apiKey: key.trim() || undefined,
                models: {
                  text: form.models?.text?.trim() || undefined,
                  transcription: form.models?.transcription?.trim() || undefined,
                },
              })
            }
          >
            Save provider
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={labelStyle}>
          Preset
          <Select
            value=""
            onChange={(value) => applyPreset(value)}
            options={[
              { value: '', label: 'Choose a starting point…' },
              ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
            ]}
          />
        </label>
        <label style={labelStyle}>
          Name
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My provider" />
        </label>
        <label style={labelStyle}>
          Base URL
          <Input
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label style={labelStyle}>
          Endpoint type
          <Select
            value={form.kind}
            onChange={(value) => setForm({ ...form, kind: value as ProviderSaveInput['kind'] })}
            options={[
              { value: 'openai-compatible', label: 'OpenAI-compatible' },
              { value: 'ollama', label: 'Ollama' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'gemini', label: 'Google Gemini' },
            ]}
          />
        </label>
        <label style={labelStyle}>
          API key
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={input?.id ? 'Leave blank to keep the current key' : 'Paste the key'}
            autoComplete="off"
          />
        </label>
        <label style={labelStyle}>
          Text model
          <Input
            value={form.models?.text ?? ''}
            onChange={(e) => setForm({ ...form, models: { ...form.models, text: e.target.value } })}
            placeholder="Type the model name exactly as the provider lists it"
          />
        </label>
        {form.capabilities?.includes('transcription') && (
          <label style={labelStyle}>
            Transcription model
            <Input
              value={form.models?.transcription ?? ''}
              onChange={(e) => setForm({ ...form, models: { ...form.models, transcription: e.target.value } })}
              placeholder="e.g. whisper-1"
            />
          </label>
        )}
        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={form.capabilities?.includes('transcription') ?? false}
            onChange={(e) =>
              setForm({
                ...form,
                capabilities: e.target.checked
                  ? [...(form.capabilities ?? []), 'transcription']
                  : (form.capabilities ?? []).filter((c) => c !== 'transcription'),
              })
            }
          />
          <span>This endpoint can transcribe audio</span>
        </label>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-brand)',
            fontSize: 'var(--fs-xs)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {showAdvanced ? 'Hide advanced' : 'Advanced'}
        </button>
        {showAdvanced && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={labelStyle}>
              Timeout (seconds)
              <Input
                type="number"
                min={15}
                max={300}
                value={Math.round((form.timeoutMs ?? 60000) / 1000)}
                onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) * 1000 })}
              />
            </label>
            <label style={labelStyle}>
              Requests at once
              <Input
                type="number"
                min={1}
                max={4}
                value={form.maxConcurrent ?? 2}
                onChange={(e) => setForm({ ...form, maxConcurrent: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Model names are never guessed: test the connection and pick from what the provider reports.
        </p>
      </div>
    </Dialog>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-secondary)',
};
