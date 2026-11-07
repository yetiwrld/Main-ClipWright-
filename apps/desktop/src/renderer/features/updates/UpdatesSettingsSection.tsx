/**
 * SPEC 15 §3 — Settings → Updates.
 *
 * Current version, last checked, a manual check, the automatic-check schedule,
 * the channel, and the privacy note. Nothing here downloads anything: §2.2 says
 * the app never fetches an update the user did not ask for.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Select, Toggle } from '@clipwright/design-system';
import { UPDATE_PRIVACY_NOTE } from '@clipwright/update-core';
import { YtDlpSection } from './YtDlpSection.js';
import { getBridge } from '../../api.js';
import { useUpdates } from './use-updates.js';

type AutoCheck = 'startup' | '6h' | '1d' | '1w' | 'never';

const AUTO_CHECK_OPTIONS: Array<{ value: AutoCheck; label: string }> = [
  { value: 'startup', label: 'On startup' },
  { value: '6h', label: 'Every 6 hours' },
  { value: '1d', label: 'Every day' },
  { value: '1w', label: 'Every week' },
  { value: 'never', label: 'Never' },
];

export interface UpdatesSettingsSectionProps {
  /** Called when the user asks to see the dialog for a found update. */
  onShowDialog: () => void;
}

export function UpdatesSettingsSection({ onShowDialog }: UpdatesSettingsSectionProps) {
  const updates = useUpdates();
  const [autoCheck, setAutoCheck] = useState<AutoCheck>('1d');
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    void bridge
      .getSettings()
      .then((settings) => {
        const value = settings as { autoCheckUpdates?: AutoCheck; updateChannel?: 'stable' | 'beta' };
        if (value.autoCheckUpdates) setAutoCheck(value.autoCheckUpdates);
        if (value.updateChannel) setChannel(value.updateChannel);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const persist = useCallback(
    async (patch: { autoCheckUpdates?: AutoCheck; updateChannel?: 'stable' | 'beta' }) => {
      const bridge = getBridge();
      if (!bridge) return;
      await bridge.updateSettings(patch);
    },
    [],
  );

  const state = updates.state;
  const available = state?.status === 'available' || state?.status === 'ready';

  return (
    <section className="flex flex-col gap-[var(--space-4)]" aria-labelledby="updates-heading">
      <h3 id="updates-heading" className={HEADING}>
        Updates
      </h3>

      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <span className={TEXT}>
          Version <strong>{state?.currentVersion ?? '—'}</strong> ({channel})
        </span>
        <Chip variant={available ? 'warning' : 'neutral'}>
          {available ? 'Update available' : 'Up to date'}
        </Chip>
      </div>

      <p className={MUTED}>{updates.statusLine}</p>
      <p className={MUTED}>Last checked: {updates.lastCheckedLabel}</p>

      {state?.error && (
        <div className={ERROR} role="alert">
          <p>{state.error.message}</p>
          {state.error.retryable && (
            <Button variant="secondary" size={28} onClick={() => void updates.check({ manual: true })}>
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <Button
          variant="secondary"
          onClick={() => void updates.check({ manual: true })}
          disabled={updates.checking}
        >
          {updates.checking ? 'Checking…' : 'Check for updates now'}
        </Button>
        {available && (
          <Button variant="primary" onClick={onShowDialog}>
            Show update
          </Button>
        )}
      </div>

      <div className={ROW}>
        <div>
          <p className={TEXT}>Automatic checks</p>
          <p className={MUTED}>Checks run in the background and never download anything.</p>
        </div>
        <Select
          value={autoCheck}
          onChange={(next) => {
            const value = next as AutoCheck;
            setAutoCheck(value);
            void persist({ autoCheckUpdates: value });
          }}
          options={AUTO_CHECK_OPTIONS}
          disabled={!loaded}
          ariaLabel="Automatic update checks"
        />
      </div>

      <div className={ROW}>
        <div>
          <p className={TEXT}>Beta channel</p>
          <p className={MUTED}>
            Pre-releases can be unstable and may change before the final version.
          </p>
        </div>
        <Toggle
          checked={channel === 'beta'}
          onChange={(next) => {
            const value = next ? 'beta' : 'stable';
            setChannel(value);
            void persist({ updateChannel: value });
          }}
          disabled={!loaded}
          ariaLabel="Use the beta channel"
        />
      </div>

      {/* SPEC 15 §9: yt-dlp is updated separately from the app. */}
      <div className="mt-[var(--space-4)] border-t border-[var(--line-subtle)] pt-[var(--space-4)]">
        <h3 className={HEADING}>yt-dlp</h3>
        <YtDlpSection />
      </div>

      <p className={MUTED}>{UPDATE_PRIVACY_NOTE}</p>
    </section>
  );
}

const HEADING = 'text-[length:var(--fs-lg)] font-semibold text-[var(--text-primary)]';
const TEXT = 'text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const MUTED = 'text-[length:var(--fs-xs)] text-[var(--text-secondary)]';
const ROW = 'flex items-center justify-between gap-[var(--space-4)]';
const ERROR =
  'flex flex-col gap-[var(--space-2)] rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-tint)] p-[var(--space-3)] text-[length:var(--fs-sm)] text-[var(--text-primary)]';
