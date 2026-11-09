import React, { useState, useEffect, useCallback } from 'react';
import type { Route } from '../App.js';
import { Button } from '@clipwright/design-system';
import { api, describeError, isDesktop } from '../api.js';
import type { AppSettings, AppInfo } from '../global.js';
import { AiProvidersSection } from '../sections/AiProvidersSection.js';
import { PrivacySection } from '../sections/PrivacySection.js';
import { UpdatesSettingsSection } from '../features/updates/UpdatesSettingsSection.js';

interface Props {
  section: string;
  onNavigate: (r: Route) => void;
  /** SPEC 15 §3 — opens the update dialog from the Settings row. */
  onShowUpdateDialog: () => void;
}

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'performance', label: 'Performance & proxies' },
  { id: 'providers', label: 'AI providers' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'updates', label: 'Updates' },
  { id: 'storage', label: 'Storage' },
  { id: 'about', label: 'About' },
];

export function SettingsPage({ section, onNavigate, onShowUpdateDialog }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setError('Settings are managed inside the Clipwright desktop app.');
      return;
    }
    try {
      setSettings(await api.getSettings());
      setError('');
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveState('saving');
    try {
      const saved = await api.updateSettings(patch as Record<string, unknown>);
      setSettings(saved);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 1500);
    } catch (err) {
      setSaveState('error');
      setError(describeError(err));
    }
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar active={section} onNavigate={(s) => onNavigate({ name: 'settings', section: s })} />
      <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            {SECTIONS.find((s) => s.id === section)?.label ?? 'Settings'}
          </h1>
          {saveState !== 'idle' && (
            <span style={{ fontSize: 'var(--fs-xs)', color: saveState === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Not saved'}
            </span>
          )}
        </div>

        {error && (
          <div role="alert" style={{
            padding: '10px 14px', margin: '12px 0', borderRadius: 'var(--radius-md)',
            background: 'var(--danger-tint)', border: '1px solid var(--danger)',
            color: 'var(--text-primary)', fontSize: 'var(--fs-sm)',
          }}>
            {error}
          </div>
        )}

        {!settings ? (
          <div style={{ padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>Loading settings…</div>
        ) : (
          <div>
            {section === 'general' && <GeneralSection settings={settings} update={update} />}
            {section === 'models' && (
              <ModelsSection settings={settings} update={update} onOpenModels={() => onNavigate({ name: 'models' })} />
            )}
            {section === 'performance' && <PerformanceSection settings={settings} update={update} />}
            {section === 'providers' && (
              <AiProvidersSection settings={settings} onUpdateSettings={async (patch) => update(patch)} />
            )}
            {section === 'privacy' && (
              <PrivacySection settings={settings} onUpdateSettings={async (patch) => update(patch)} />
            )}
            {section === 'updates' && <UpdatesSettingsSection onShowDialog={onShowUpdateDialog} />}
            {section === 'storage' && <StorageSection settings={settings} />}
            {section === 'about' && <AboutSection />}
          </div>
        )}
      </div>
    </div>
  );
}

type UpdateFn = (patch: Partial<AppSettings>) => void;

function Sidebar({ active, onNavigate }: { active: string; onNavigate: (s: string) => void }) {
  return (
    <nav style={{
      width: 200, borderRight: '1px solid var(--line-subtle)',
      padding: '16px 0', flexShrink: 0,
    }}>
      {SECTIONS.map((s) => (
        <button key={s.id} onClick={() => onNavigate(s.id)}
          style={{
            width: '100%', textAlign: 'left', padding: '10px 20px',
            border: 'none', background: active === s.id ? 'var(--brand-tint)' : 'transparent',
            color: active === s.id ? 'var(--text-brand)' : 'var(--text-secondary)',
            cursor: 'pointer', fontSize: 'var(--fs-sm)',
          }}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0', borderBottom: '1px solid var(--line-subtle)' }}>
      <div>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
        {desc && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 24, borderRadius: 'var(--radius-full)',
        border: 'none', cursor: 'pointer',
        background: value ? 'var(--brand)' : 'var(--surface-raised)',
        position: 'relative', transition: 'background var(--dur-fast)',
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: value ? 22 : 2,
        width: 20, height: 20, borderRadius: '50%',
        background: 'var(--surface-card)',
        transition: 'left var(--dur-fast)',
      }} />
    </button>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line-default)',
  background: 'var(--surface-raised)',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-sm)',
};

function GeneralSection({ settings, update }: { settings: AppSettings; update: UpdateFn }) {
  return (
    <>
      <SettingRow label="Auto-continue" desc="Move to the next stage automatically when a task finishes">
        <Toggle
          label="Auto-continue"
          value={Boolean(settings.autoContinueStages)}
          onChange={(v) => update({ autoContinueStages: v })}
        />
      </SettingRow>
      <SettingRow label="Processing mode" desc="Where transcription and analysis run">
        <select
          value={String(settings.processingMode ?? 'automatic')}
          onChange={(e) => update({ processingMode: e.target.value as 'offline' | 'online' | 'automatic' })}
          style={selectStyle}
        >
          <option value="automatic">Automatic</option>
          <option value="offline">Offline only</option>
          <option value="online">Online AI</option>
        </select>
      </SettingRow>
      <SettingRow label="Autosave interval" desc="How often the open composition is written to disk">
        <select
          value={String(settings.autosaveIntervalSec ?? 30)}
          onChange={(e) => update({ autosaveIntervalSec: Number(e.target.value) })}
          style={selectStyle}
        >
          <option value="10">Every 10 seconds</option>
          <option value="30">Every 30 seconds</option>
          <option value="60">Every minute</option>
          <option value="120">Every 2 minutes</option>
        </select>
      </SettingRow>
      <SettingRow label="Audio scrubbing" desc="Play short audio bursts while dragging the playhead">
        <Toggle
          label="Audio scrubbing"
          value={Boolean(settings.audioScrubbing)}
          onChange={(v) => update({ audioScrubbing: v })}
        />
      </SettingRow>
      <SettingRow label="Click empty timeline moves playhead" desc="Otherwise clicking empty space deselects">
        <Toggle
          label="Click empty timeline moves playhead"
          value={Boolean(settings.clickEmptyMovesPlayhead)}
          onChange={(v) => update({ clickEmptyMovesPlayhead: v })}
        />
      </SettingRow>
    </>
  );
}

function ModelsSection({
  settings,
  update,
  onOpenModels,
}: {
  settings: AppSettings;
  update: UpdateFn;
  onOpenModels: () => void;
}) {
  return (
    <>
      <SettingRow
        label="Default speech model"
        desc="Used for new projects. 'Automatic' picks the best model that is installed and fits this computer."
      >
        <select
          value={settings.defaultWhisperModel}
          onChange={(e) => update({ defaultWhisperModel: e.target.value })}
          style={selectStyle}
        >
          <option value="auto">Automatic</option>
          {['tiny', 'tiny.en', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'].map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Download and manage models" desc="Sizes, RAM needs, verification and resumable downloads">
        <Button variant="secondary" onClick={onOpenModels}>
          Open the model manager
        </Button>
      </SettingRow>
    </>
  );
}

function PerformanceSection({ settings, update }: { settings: AppSettings; update: UpdateFn }) {
  return (
    <>
      <SettingRow label="Proxy quality" desc="Resolution of proxy files used for smooth editing">
        <select
          value={String(settings.proxyQuality ?? 'medium')}
          onChange={(e) => update({ proxyQuality: e.target.value as 'low' | 'medium' | 'high' })}
          style={selectStyle}
        >
          <option value="low">Low — 360p</option>
          <option value="medium">Medium — 540p</option>
          <option value="high">High — 720p</option>
        </select>
      </SettingRow>
      <SettingRow label="Always create proxies" desc="Create proxies even when the source is already editing-friendly">
        <Toggle
          label="Always create proxies"
          value={Boolean(settings.alwaysCreateProxies)}
          onChange={(v) => update({ alwaysCreateProxies: v })}
        />
      </SettingRow>
      <SettingRow
        label="Use proxies in the preview"
        desc="Play the lighter proxy while editing. Exports always use the original file."
      >
        <Toggle
          label="Use proxies in the preview"
          value={settings.useProxyPreview !== false}
          onChange={(v) => update({ useProxyPreview: v })}
        />
      </SettingRow>
    </>
  );
}


function StorageSection({ settings }: { settings: AppSettings }) {
  return (
    <>
      <SettingRow label="Workspace folder" desc="Every project, model and cache file lives here">
        <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {String(settings.workspacePath ?? '')}
        </code>
      </SettingRow>
    </>
  );
}

function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    void api.getAppInfo().then(setInfo).catch(() => undefined);
  }, []);

  return (
    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
        Clipwright Studio
      </div>
      {info ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 'var(--fs-xs)' }}>
          <span style={{ color: 'var(--text-muted)' }}>Version</span><span>{info.version}</span>
          <span style={{ color: 'var(--text-muted)' }}>Electron</span><span>{info.electron}</span>
          <span style={{ color: 'var(--text-muted)' }}>Chromium</span><span>{info.chrome}</span>
          <span style={{ color: 'var(--text-muted)' }}>Node</span><span>{info.node}</span>
          <span style={{ color: 'var(--text-muted)' }}>Platform</span><span>{info.platform} · {info.arch}</span>
        </div>
      ) : (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Version details are available in the desktop app.</div>
      )}
      <p style={{ marginTop: 16, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        Turn long videos into captioned short clips, and edit multitrack video offline.
      </p>
    </div>
  );
}
