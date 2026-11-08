/**
 * SPEC 15 §4.2 — the update dialog.
 *
 * Shows the new version, the notes, the download size and the unsigned notice,
 * then follows the download through to "Install and restart".
 *
 * §6.4 honesty rule: an unsigned installer says so here, every time, rather than
 * letting SmartScreen be the first thing that mentions it.
 */
import React, { useMemo } from 'react';
import { Button, Chip, Dialog, ProgressLinear } from '@clipwright/design-system';
import { formatDownloadSize } from '@clipwright/update-core/browser';
import type { UpdateStatePayload } from '../../global.js';

export interface UpdateDialogProps {
  open: boolean;
  state: UpdateStatePayload | null;
  progressLine: string | null;
  onClose: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onInstall: () => void;
  onSkip: () => void;
  onRemindLater: () => void;
  onViewOnGitHub: () => void;
}

export function UpdateDialog({
  open,
  state,
  progressLine,
  onClose,
  onDownload,
  onCancelDownload,
  onInstall,
  onSkip,
  onRemindLater,
  onViewOnGitHub,
}: UpdateDialogProps) {
  if (!state?.release) {
    return (
      <Dialog open={open} onClose={onClose} title="Update">
        <p className={TEXT}>There is no update to show right now.</p>
      </Dialog>
    );
  }

  const { release, status, progress, error } = state;
  const downloading = status === 'downloading';
  const verifying = status === 'verifying';
  const ready = status === 'ready';
  const installing = status === 'installing';

  return (
    <Dialog open={open} onClose={closeDuringErrorsOnly(status, onClose)} title="Update available">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={HEADING}>Version {release.version}</span>
          <span className={MUTED}>You have {state.currentVersion}</span>
          {release.prerelease && <Chip variant="warning">Pre-release</Chip>}
        </div>

        <dl className={META_GRID}>
          <dt className={MUTED}>Released</dt>
          <dd className={TEXT}>{formatDate(release.releasedAt)}</dd>
          <dt className={MUTED}>Download</dt>
          <dd className={TEXT}>{formatDownloadSize(release.downloadBytes)}</dd>
        </dl>

        {state.notice && <p className={NOTICE}>{state.notice}</p>}

        {!release.signed && (
          <p className={UNSIGNED}>
            <strong>Unsigned installer.</strong> Windows SmartScreen may warn that the publisher
            is unknown. Verify the SHA-256 listed on the release page.
          </p>
        )}

        {release.summary && <p className={TEXT}>{release.summary}</p>}

        <details className="rounded-[var(--radius-md)] border border-[var(--line-subtle)] p-[var(--space-3)]">
          <summary className={`${TEXT} cursor-pointer select-none`}>Full release notes</summary>
          <div className={`${NOTES} mt-2`}>{renderNotes(release.full)}</div>
        </details>

        {(downloading || verifying || ready) && (
          <div className="flex flex-col gap-2">
            <ProgressLinear
              value={verifying || ready ? 100 : (progress?.percent ?? 0)}
              ariaLabel={verifying ? 'Verifying update' : ready ? 'Update ready' : 'Downloading update'}
            />
            <p className={MUTED}>
              {verifying
                ? 'Checking the signature and hashes…'
                : ready
                  ? 'Downloaded and verified.'
                  : (progressLine ?? 'Starting…')}
            </p>
          </div>
        )}

        {error && (
          <div className={ERROR} role="alert">
            <p>{error.message}</p>
            {error.retryable && <p className={MUTED}>You can try again.</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onViewOnGitHub}>
            View on GitHub
          </Button>

          {downloading ? (
            <Button variant="secondary" onClick={onCancelDownload}>
              Cancel
            </Button>
          ) : ready ? (
            <>
              <Button variant="ghost" onClick={onRemindLater}>
                Later
              </Button>
              <Button variant="primary" onClick={onInstall} disabled={installing}>
                {installing ? 'Installing…' : 'Install and restart'}
              </Button>
            </>
          ) : error ? (
            <>
              <Button variant="ghost" onClick={onRemindLater}>
                Remind me later
              </Button>
              <Button variant="primary" onClick={onDownload}>
                Try again
              </Button>
            </>
          ) : verifying ? (
            <Button variant="secondary" disabled>
              Verifying…
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onSkip}>
                Skip this version
              </Button>
              <Button variant="ghost" onClick={onRemindLater}>
                Remind me later
              </Button>
              <Button variant="primary" onClick={onDownload}>
                Download
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** §4.2: the dialog is not dismissible mid-install. */
function closeDuringErrorsOnly(status: UpdateStatePayload['status'], onClose: () => void) {
  return status === 'installing' ? () => undefined : onClose;
}

/**
 * Release notes are rendered as plain text on purpose.
 *
 * §4.2 requires sanitised Markdown with no raw HTML, scripts or remote images.
 * Rendering the notes as pre-wrapped text satisfies that by construction: there
 * is no HTML sink here at all, so a malicious release note has nothing to
 * exploit. Formatting can be layered on later without weakening that.
 */
function renderNotes(markdown: string): React.ReactNode {
  const lines = markdown.split('\n').slice(0, 400);
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <span key={index} className="h-2" />;
        if (trimmed.startsWith('#')) {
          return (
            <span key={index} className={`${TEXT} font-semibold`}>
              {trimmed.replace(/^#+\s*/, '')}
            </span>
          );
        }
        if (trimmed.startsWith('- ')) {
          return (
            <span key={index} className={BULLET}>
              • {trimmed.slice(2)}
            </span>
          );
        }
        return (
          <span key={index} className={TEXT}>
            {trimmed}
          </span>
        );
      })}
    </div>
  );
}

function formatDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'unknown';
  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/* Design tokens only: no hard-coded colours, radii or durations (§01). */
const TEXT = 'text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const HEADING = 'text-[length:var(--fs-lg)] font-semibold text-[var(--text-primary)]';
const MUTED = 'text-[length:var(--fs-xs)] text-[var(--text-secondary)]';
const NOTICE =
  'rounded-[var(--radius-md)] bg-[var(--surface-raised)] p-[var(--space-3)] text-[length:var(--fs-xs)] text-[var(--text-secondary)]';
const UNSIGNED =
  'rounded-[var(--radius-md)] border border-[var(--brand-amber)] bg-[var(--brand-tint)] p-[var(--space-3)] text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const ERROR =
  'rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-tint)] p-[var(--space-3)] text-[length:var(--fs-sm)] text-[var(--text-primary)]';
const NOTES = 'max-h-64 overflow-y-auto pr-[var(--space-2)]';
const BULLET = 'text-[length:var(--fs-sm)] text-[var(--text-secondary)]';
const META_GRID = 'grid grid-cols-[auto_1fr] gap-x-[var(--space-4)] gap-y-[var(--space-1)]';
