/**
 * SPEC 15 §7.3–§7.6 — the Recovery window.
 *
 * Shown at startup when the previous update failed to open the workspace twice.
 * This is the worst moment in the app's life for the user, so the component has
 * one job: say what happened, say the work is safe, and offer the way back.
 *
 * Every sentence comes from the main process (`recoveryMessage` in
 * update-core), not from this file: it needs to mention whether a migration ran
 * and whether a previous installer was kept, and that knowledge lives there.
 * The text is therefore data, and it is tested as data.
 */
import React, { useState } from 'react';
import { Button, Dialog } from '@clipwright/design-system';
import type { RecoveryStatePayload } from '../../global.js';

export interface RecoveryDialogProps {
  open: boolean;
  state: RecoveryStatePayload | null;
  onRestorePrevious: () => Promise<{ ok: boolean; error?: string }>;
  onDismiss: () => void;
  onOpenReleasesPage: () => void;
}

export function RecoveryDialog({
  open,
  state,
  onRestorePrevious,
  onDismiss,
  onOpenReleasesPage,
}: RecoveryDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!state) return null;

  const restore = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await onRestorePrevious();
      if (!result.ok) setFailure(result.error ?? 'The previous version could not be started.');
    } catch (error) {
      setFailure(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onDismiss} title={state.headline}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2" data-testid="recovery-body">
          {state.body.map((sentence) => (
            <p key={sentence} className={TEXT}>
              {sentence}
            </p>
          ))}
        </div>

        <p className={MUTED}>
          {state.fromVersion} → {state.toVersion}
        </p>

        {failure && (
          <p className={ERROR} role="alert" data-testid="recovery-error">
            {failure}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {state.canRestorePrevious ? (
            <Button variant="primary" onClick={restore} disabled={busy} data-testid="restore-previous">
              {busy ? 'Starting the installer…' : `Go back to ${state.fromVersion}`}
            </Button>
          ) : (
            <Button variant="primary" onClick={onOpenReleasesPage}>
              Download {state.fromVersion}
            </Button>
          )}
          <Button variant="secondary" onClick={onDismiss} disabled={busy}>
            Continue anyway
          </Button>
        </div>

        {/*
          "Continue anyway" is offered rather than hidden: the check is a count of
          failures, not a diagnosis, and a version that failed twice may still be
          usable. Telling the user their only option is a downgrade would be a lie.
        */}
        <p className={MUTED}>
          Continuing keeps version {state.toVersion}. If projects still will not open, go back or
          reinstall.
        </p>
      </div>
    </Dialog>
  );
}

const TEXT = 'text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const MUTED = 'text-[length:var(--fs-xs)] text-[var(--text-secondary)]';
// Matches the update dialog's error panel: there is no `--text-danger` token,
// and inventing one would fail the design-token lint.
const ERROR =
  'rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-tint)] p-[var(--space-3)] text-[length:var(--fs-sm)] text-[var(--text-primary)]';
