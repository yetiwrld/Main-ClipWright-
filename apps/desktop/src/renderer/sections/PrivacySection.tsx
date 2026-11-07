import React, { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Toggle, useToast } from '@clipwright/design-system';
import { api, describeError, isDesktop } from '../api.js';
import type { AppSettings, PrivacyOverviewPayload } from '../global.js';

/**
 * SPEC 06 §8 — Settings → Privacy.
 *
 * Two lists and one honest table: what you have allowed, what has actually been
 * sent (metadata only), and the four outbound calls the app can make.
 */
export function PrivacySection({
  settings,
  onUpdateSettings,
}: {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { pushToast } = useToast();
  const [overview, setOverview] = useState<PrivacyOverviewPayload | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setError('Privacy details live inside the Clipwright desktop app.');
      return;
    }
    try {
      setOverview(await api.privacyOverview());
      setError('');
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (providerId: string, category: string) => {
    try {
      await api.revokeConsent(providerId, category);
      await load();
      pushToast({ message: 'Permission revoked. Nothing more will be sent to that provider.', tone: 'neutral' });
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 980 }}>
      {error && (
        <div style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--error-tint)', color: 'var(--error)', fontSize: 'var(--fs-sm)' }}>
          {error}
        </div>
      )}

      <section>
        <h2 style={heading}>What may leave this computer</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {overview?.consents.length === 0 && (
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              Nothing. Until you allow a provider, Clipwright never sends anything anywhere.
            </p>
          )}
          {overview?.consents.map((consent) => (
            <div key={consent.id} style={rowStyle}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 'var(--fs-md)', color: 'var(--text-primary)' }}>
                  {consent.providerName ?? consent.providerId}
                </span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginLeft: 8 }}>
                  may receive {consent.category === 'audio' ? 'compressed audio chunks' : consent.category === 'transcript' ? 'transcript text' : 'a test payload'}
                  {' · '}
                  {consent.scope === 'always' ? 'always' : 'once'} · granted {new Date(consent.grantedAt).toLocaleString()}
                </span>
              </div>
              <Button size={28} variant="ghost" onClick={() => void revoke(consent.providerId, consent.category)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h2 style={{ ...heading, marginBottom: 0 }}>Data sent to providers</h2>
          <span style={{ flex: 1 }} />
          <Button
            size={28}
            onClick={() =>
              void api
                .exportDataSentLog()
                .then((path) => path && pushToast({ message: `Saved to ${path}`, tone: 'success' }))
                .catch((err) => pushToast({ message: describeError(err), tone: 'error' }))
            }
          >
            Export CSV
          </Button>
          <Button
            size={28}
            variant="ghost"
            onClick={() =>
              void api
                .clearDataSentLog()
                .then((removed) => {
                  pushToast({ message: `${removed} entries cleared.`, tone: 'neutral' });
                  return load();
                })
                .catch((err) => pushToast({ message: describeError(err), tone: 'error' }))
            }
          >
            Clear
          </Button>
        </div>
        <p style={{ margin: '0 0 8px 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Metadata only — Clipwright never stores the text or audio it sends.
        </p>
        {overview?.dataSent.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>Nothing has been sent yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-xs)' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                <th style={cell}>Time</th>
                <th style={cell}>Provider host</th>
                <th style={cell}>Task</th>
                <th style={cell}>Data</th>
                <th style={cell}>Approx. size</th>
              </tr>
            </thead>
            <tbody>
              {overview?.dataSent.map((entry, index) => (
                <tr key={`${entry.ts}-${index}`} style={{ color: 'var(--text-secondary)' }}>
                  <td style={cell}>{new Date(entry.ts).toLocaleString()}</td>
                  <td style={cell}>{entry.providerHost}</td>
                  <td style={cell}>{entry.task.replace(/_/g, ' ')}</td>
                  <td style={cell}>{entry.category}</td>
                  <td style={cell}>{formatBytes(entry.approxBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={heading}>Outbound connections</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {overview?.backgroundCalls.map((call) => (
            <div key={call.id} style={rowStyle}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--fs-md)', color: 'var(--text-primary)' }}>{call.label}</div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{call.detail}</div>
              </div>
              {call.toggleKey ? (
                <Toggle
                  checked={Boolean(call.enabled)}
                  onChange={(checked) =>
                    void onUpdateSettings({
                      privacy: { ...settings.privacy, [call.toggleKey as 'updateCheck' | 'ytDlpUpdate']: checked },
                    }).then(load)
                  }
                  ariaLabel={call.label}
                />
              ) : (
                <Chip variant="neutral">Only when you ask</Chip>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const heading: React.CSSProperties = {
  margin: '0 0 8px 0',
  fontSize: 'var(--fs-lg)',
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--surface-card)',
  border: '1px solid var(--line-subtle)',
  borderRadius: 'var(--radius-md)',
};

const cell: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid var(--line-faint)',
  verticalAlign: 'top',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
