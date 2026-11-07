/**
 * SPEC 15 §9 — Settings → Updates → yt-dlp.
 *
 * yt-dlp is updated on its own schedule because it breaks on its own schedule:
 * a site changes, downloads stop working, and nothing about the app looks wrong.
 * This row therefore shows the version, where it came from, and when it was last
 * checked — and offers the two actions that fix the situation: check now, and go
 * back to the bundled copy.
 *
 * Failures are shown in the words `update-core` produced, which always say what
 * still works ("Link downloads use the version that came with Clipwright")
 * rather than only what went wrong.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Chip } from '@clipwright/design-system';
import { api, isDesktop } from '../../api.js';
import type { YtDlpCheckPayload, YtDlpStatePayload } from '../../global.js';

export function YtDlpSection() {
  const [state, setState] = useState<YtDlpStatePayload | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      setState(await api.getYtDlpStatus());
    } catch {
      // A missing bridge is not worth an error panel; the row simply stays empty.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = async () => {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const result: YtDlpCheckPayload = await api.checkYtDlpUpdate();
      if (result.kind === 'available') {
        setNotice(`Version ${result.version} is available.`);
      } else if (result.kind === 'current') {
        setNotice('yt-dlp is up to date.');
      } else if (result.kind === 'error') {
        setError(result.message);
      } else if (result.kind === 'blocked') {
        setNotice(result.reason);
      }
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setChecking(false);
    }
  };

  const update = async () => {
    if (!state?.available) return;
    setWorking(true);
    setError(null);
    try {
      const result = await api.updateYtDlp({
        downloadUrl: state.available.downloadUrl,
        // The checksum comes from the check result in main, not from the URL.
        expectedSha256: await expectedShaFor(state.available.version),
        version: state.available.version,
      });
      if (!result.ok) setError(result.error ?? 'The update could not be installed.');
      else setNotice(`yt-dlp ${state.available.version} installed.`);
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setWorking(false);
    }
  };

  const restore = async () => {
    setWorking(true);
    setError(null);
    try {
      const result = await api.restoreBundledYtDlp();
      if (!result.ok) setError(result.reason ?? 'The bundled version could not be restored.');
      else setNotice('Using the version that came with Clipwright.');
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setWorking(false);
    }
  };

  const canRestore = state?.source === 'user';
  const busy = checking || working;

  return (
    <div className="flex flex-col gap-3" data-testid="ytdlp-section">
      <div className="flex flex-wrap items-center gap-2">
        <span className={TEXT} data-testid="ytdlp-status">
          {state?.message ?? 'Reading the yt-dlp version…'}
        </span>
        {state?.source === 'user' && <Chip variant="neutral">Downloaded separately</Chip>}
      </div>

      {notice && (
        <p className={MUTED} data-testid="ytdlp-notice">
          {notice}
        </p>
      )}

      {(error ?? state?.error) && (
        <p className={ERROR} role="alert" data-testid="ytdlp-error">
          {error ?? state?.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={check} disabled={busy}>
          {checking ? 'Checking…' : 'Check now'}
        </Button>
        {state?.available && (
          <Button variant="primary" onClick={update} disabled={busy}>
            {working ? 'Updating…' : `Update to ${state.available.version}`}
          </Button>
        )}
        {canRestore && (
          <Button variant="ghost" onClick={restore} disabled={busy}>
            Restore bundled version
          </Button>
        )}
      </div>

      <p className={MUTED}>
        yt-dlp changes often because the sites do. Updates are checked weekly and kept separate from
        Clipwright updates.
      </p>
    </div>
  );
}

/**
 * The checksum for a version we already checked.
 *
 * `updateYtDlp` needs the digest, and the state payload deliberately does not
 * carry it: a digest is only trustworthy when it comes from the same check that
 * read the release. Asking main for it again keeps that property, so this reads
 * the check result rather than trusting anything cached in the renderer.
 */
async function expectedShaFor(version: string): Promise<string> {
  const result = await api.checkYtDlpUpdate();
  if (result.kind === 'available' && result.version === version) return result.expectedSha256;
  if (result.kind === 'available') return result.expectedSha256;
  throw new Error('The release could not be checked again, so the update was not installed.');
}

const TEXT = 'text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const MUTED = 'text-[length:var(--fs-xs)] text-[var(--text-secondary)]';
const ERROR =
  'rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-tint)] p-[var(--space-3)] text-[length:var(--fs-sm)] text-[var(--text-primary)]';
