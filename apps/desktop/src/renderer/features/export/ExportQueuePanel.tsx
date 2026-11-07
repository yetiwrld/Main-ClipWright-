/**
 * SPEC 14 §6 — the export queue panel.
 *
 * One row per export: name, preset summary, status, a true progress bar
 * (rendered frames ÷ N), elapsed, ETA, speed, Cancel, and on completion Open
 * file / Show in folder / Copy path / Re-export; on failure Retry and Details.
 *
 * Every number shown comes from the main process's measurements — nothing here
 * animates a bar to look busy.
 */

import React, { useState } from 'react';
import { AlertTriangle, Check, Copy, FolderOpen, RotateCcw, X } from 'lucide-react';
import { Button, Chip, IconButton } from '@clipwright/design-system';
import type { ExportJobPayload } from '../../global.js';
import { canCancelJob, describeJob, statusLabel } from './use-export.js';

/** Format seconds as a clock value, or "Estimating…" when unknown. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Estimating…';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s left`;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m left`;
}

/** Format a duration in ms as elapsed time. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}

/** Speed text: "2.4× real time", or nothing before it is measured. */
export function formatSpeed(speedFactor: number): string | null {
  if (!Number.isFinite(speedFactor) || speedFactor <= 0) return null;
  return `${speedFactor.toFixed(1)}× real time`;
}

/** Statuses where work is actually happening. */
export const ACTIVE_JOB_STATUSES: ReadonlyArray<ExportJobPayload['status']> = [
  'rendering',
  'measuring-loudness',
  'encoding',
  'finalising',
  'verifying',
];

export function ExportQueuePanel({
  jobs,
  onCancel,
  onRetry,
  onDismiss,
  onOpenFolder,
  onReexport,
  onShowDetails,
}: {
  jobs: ExportJobPayload[];
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
  onOpenFolder: (path: string) => void;
  onReexport: (job: ExportJobPayload) => void;
  onShowDetails: (job: ExportJobPayload) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div
        data-testid="export-queue-empty"
        style={{ padding: 'var(--space-3)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
      >
        No exports yet.
      </div>
    );
  }

  return (
    <ul
      role="list"
      aria-label="Export queue"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      {jobs.map((job) => (
        <ExportQueueRow
          key={job.id}
          job={job}
          onCancel={onCancel}
          onRetry={onRetry}
          onDismiss={onDismiss}
          onOpenFolder={onOpenFolder}
          onReexport={onReexport}
          onShowDetails={onShowDetails}
        />
      ))}
    </ul>
  );
}

function ExportQueueRow({
  job,
  onCancel,
  onRetry,
  onDismiss,
  onOpenFolder,
  onReexport,
  onShowDetails,
}: {
  job: ExportJobPayload;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
  onOpenFolder: (path: string) => void;
  onReexport: (job: ExportJobPayload) => void;
  onShowDetails: (job: ExportJobPayload) => void;
}) {
  const [copied, setCopied] = useState(false);
  // A queued job is cancellable but has no work to report yet, so it must not
  // show a progress bar (a bar at 0% that never moves reads as a hang).
  const running = ACTIVE_JOB_STATUSES.includes(job.status);
  const active = canCancelJob(job);
  const finished = job.status === 'done';
  const failed = job.status === 'failed';
  const speed = running ? formatSpeed(job.speedFactor) : null;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(job.outputPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the path is visible in Details.
    }
  };

  return (
    <li
      data-testid={`export-job-${job.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        padding: 'var(--space-2)',
        borderBottom: '1px solid var(--line-subtle)',
        background: 'var(--surface-card)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span
          style={{
            fontSize: 'var(--fs-xs)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {job.name}
        </span>
        <JobStatusChip job={job} />
      </div>

      {/* True progress: rendered frames over the plan's frame count. */}
      {running && (
        <>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={job.percent}
            aria-label={`${job.name} progress`}
            style={{
              height: 4,
              borderRadius: 'var(--radius-pill)',
              background: 'var(--surface-sunken)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, job.percent))}%`,
                height: '100%',
                background: 'var(--brand)',
                transition: 'width var(--duration-fast) linear',
              }}
            />
          </div>
          <div
            data-testid={`export-job-summary-${job.id}`}
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-muted)',
              flexWrap: 'wrap',
            }}
          >
            <span>{statusLabel(job.status)}</span>
            <span>{job.totalFrames > 0 ? `${job.framesDone}/${job.totalFrames} frames` : ''}</span>
            {speed && <span>{speed}</span>}
            <span>{formatRemaining(job.etaSec)}</span>
          </div>
        </>
      )}

      {/* Failure and warning copy, in plain language (§8). */}
      {failed && job.error && (
        <span data-testid={`export-job-error-${job.id}`} style={{ fontSize: 'var(--fs-xs)', color: 'var(--error)' }}>
          {job.error}
        </span>
      )}
      {job.status === 'done' && job.validationStatus === 'warnings' && (
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--brand-amber)' }}>{describeJob(job)}</span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginTop: 2 }}>
        {active && (
          <Button variant="ghost" size={28} onClick={() => onCancel(job.id)}>
            {running ? 'Cancel' : 'Cancel (queued)'}
          </Button>
        )}
        {finished && (
          <>
            <Button variant="ghost" size={28} onClick={() => onOpenFolder(job.outputPath)}>
              <FolderOpen size={12} /> Show in folder
            </Button>
            <IconButton
              label={copied ? 'Path copied' : 'Copy path'}
              size={28}
              icon={copied ? <Check size={12} /> : <Copy size={12} />}
              onClick={() => void copyPath()}
            />
            <Button variant="ghost" size={28} onClick={() => onReexport(job)}>
              Re-export
            </Button>
          </>
        )}
        {(failed || job.status === 'cancelled') && (
          <Button variant="ghost" size={28} onClick={() => onRetry(job.id)}>
            <RotateCcw size={12} /> Retry
          </Button>
        )}
        {(failed || job.status === 'cancelled') && (
          <Button variant="ghost" size={28} onClick={() => onShowDetails(job)}>
            Details
          </Button>
        )}
        {!active && (
          <IconButton
            label="Dismiss"
            size={28}
            icon={<X size={12} />}
            onClick={() => onDismiss(job.id)}
          />
        )}
      </div>
    </li>
  );
}

function JobStatusChip({ job }: { job: ExportJobPayload }) {
  if (job.status === 'done') {
    if (job.validationStatus === 'verified') {
      return <Chip variant="success">Done ✓ Verified</Chip>;
    }
    if (job.validationStatus === 'warnings') {
      return <Chip variant="warning">Done with warnings</Chip>;
    }
    return <Chip variant="neutral">Done</Chip>;
  }
  if (job.status === 'failed') {
    return (
      <Chip variant="error">
        <AlertTriangle size={10} /> Failed
      </Chip>
    );
  }
  if (job.status === 'cancelled') return <Chip variant="neutral">Cancelled</Chip>;
  if (job.status === 'queued') return <Chip variant="neutral">Queued</Chip>;
  return <Chip variant="neutral">{statusLabel(job.status)}</Chip>;
}
