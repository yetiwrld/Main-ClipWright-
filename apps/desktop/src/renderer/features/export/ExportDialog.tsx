/**
 * SPEC 14 §3 / §6 — the export dialog.
 *
 * Holds the open/closed state, the panel's settings, the queue and the export
 * action together, so the editor only needs to render `<ExportDialog>`.
 *
 * Deliberately plain: the dialog shows what will be produced and what actually
 * happened, and refuses to pretend an export is running when the desktop app is
 * not available.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Button, Dialog } from '@clipwright/design-system';
import type { TimelineState } from '@clipwright/timeline-engine';
import type { ExportJobPayload } from '../../global.js';
import { isDesktop } from '../../api.js';
import { DEFAULT_EXPORT_STATE, ExportPanel, type ExportPanelState } from './ExportPanel.js';
import { ExportQueuePanel, formatRemaining } from './ExportQueuePanel.js';
import { useExport } from './use-export.js';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  compositionId: string;
  compositionName: string;
  /** Timeline state used to snapshot the items being exported. */
  state: TimelineState | null;
  fps: 30 | 60;
  /** Work area in microseconds, when the user set one (`09 §18`). */
  workAreaUs?: [number, number] | null;
  /** Duration of the whole composition. */
  durationUs: number;
}

/** Range choices offered by §3.1. */
export type RangeChoice = 'whole' | 'work-area';

export function ExportDialog({
  open,
  onClose,
  projectId,
  compositionId,
  compositionName,
  state,
  fps,
  workAreaUs,
  durationUs,
}: ExportDialogProps) {
  const [panel, setPanel] = useState<ExportPanelState>(DEFAULT_EXPORT_STATE);
  const [rangeChoice, setRangeChoice] = useState<RangeChoice>(workAreaUs ? 'work-area' : 'whole');
  const [message, setMessage] = useState('');
  const [detailsFor, setDetailsFor] = useState<ExportJobPayload | null>(null);
  const exports = useExport(projectId);

  const onChange = useCallback((patch: Partial<ExportPanelState>) => {
    setPanel((current) => ({ ...current, ...patch }));
  }, []);

  const rangeUs = useMemo<[number, number]>(() => {
    if (rangeChoice === 'work-area' && workAreaUs) return workAreaUs;
    return [0, durationUs];
  }, [rangeChoice, workAreaUs, durationUs]);

  const items = useMemo(() => collectExportItems(state), [state]);

  const running = exports.jobs.filter(
    (job) => job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled',
  );

  const handleExport = useCallback(async () => {
    setMessage('');
    const result = await exports.startExport({
      panel,
      name: compositionName || 'Clip',
      projectId,
      compositionId,
      rangeUs,
      compositionDurationUs: durationUs,
      compositionFps: fps,
      items,
      clashPolicy: 'auto-number',
      fullDecode: true,
    });
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    setMessage('Export queued. Rendering starts now and the editor stays usable.');
  }, [exports, panel, compositionName, projectId, compositionId, rangeUs, durationUs, fps, items]);

  const activeRunning = running.length > 0;
  const etaLine = useMemo(() => {
    const first = running.find((job) => job.status !== 'queued');
    if (!first) return null;
    if (first.etaSec === null) return 'Estimating…';
    return formatRemaining(first.etaSec);
  }, [running]);

  return (
    <Dialog open={open} title="Export" onClose={onClose} maxWidth={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {!isDesktop() && (
          <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--brand-amber)' }}>
            Exporting needs the Clipwright desktop app.
          </p>
        )}

        {/* Range and content (§3.1) */}
        <fieldset
          style={{
            border: '1px solid var(--line-subtle)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-2)',
            margin: 0,
          }}
        >
          <legend style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', padding: '0 4px' }}>
            What to export
          </legend>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <label style={radioRow}>
              <input
                type="radio"
                name="export-range"
                value="whole"
                checked={rangeChoice === 'whole'}
                onChange={() => setRangeChoice('whole')}
              />
              Whole clip
            </label>
            <label style={{ ...radioRow, opacity: workAreaUs ? 1 : 0.5 }}>
              <input
                type="radio"
                name="export-range"
                value="work-area"
                checked={rangeChoice === 'work-area'}
                onChange={() => setRangeChoice('work-area')}
                disabled={!workAreaUs}
              />
              Work area
            </label>
          </div>
          <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            Exporting {formatSeconds(rangeUs[1] - rangeUs[0])} of clip.
          </p>
        </fieldset>

        <ExportPanel
          state={panel}
          onChange={onChange}
          onExport={() => void handleExport()}
          onCancel={onClose}
          showHeading={false}
        />

        {message && (
          <p
            data-testid="export-message"
            style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}
          >
            {message}
          </p>
        )}

        {activeRunning && (
          <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {running.length} export{running.length === 1 ? '' : 's'} in progress{etaLine ? ` · ${etaLine}` : ''}
          </p>
        )}

        {exports.error && (
          <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--error)' }}>{exports.error}</p>
        )}

        {/* Queue (§6) */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <h4 style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', fontWeight: 600 }}>
            Queue
          </h4>
          <ExportQueuePanel
            jobs={exports.jobs}
            onCancel={(jobId) => void exports.cancel(jobId)}
            onRetry={(jobId) => void exports.retry(jobId)}
            onDismiss={(jobId) => void exports.dismiss(jobId)}
            onOpenFolder={(path) => void exports.openFolder(path)}
            onReexport={() => void handleExport()}
            onShowDetails={(job) => setDetailsFor(job)}
          />
        </section>

        {detailsFor && (
          <section
            data-testid="export-details"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: 'var(--space-2)',
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <strong style={{ fontSize: 'var(--fs-xs)' }}>Details — {detailsFor.name}</strong>
              <Button variant="ghost" size={28} onClick={() => setDetailsFor(null)}>
                Close
              </Button>
            </div>
            <dl style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              <dt>Status</dt>
              <dd style={{ margin: '0 0 4px' }}>{detailsFor.message || detailsFor.status}</dd>
              {detailsFor.error && (
                <>
                  <dt>Reason</dt>
                  <dd style={{ margin: '0 0 4px', color: 'var(--error)' }}>{detailsFor.error}</dd>
                </>
              )}
              <dt>Output</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all' }}>{detailsFor.outputPath || '—'}</dd>
            </dl>
          </section>
        )}
      </div>
    </Dialog>
  );
}

const radioRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
};

function formatSeconds(us: number): string {
  const total = Math.max(0, Math.round(us / 1_000_000));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

/**
 * Reduce the timeline to the item list the planner needs.
 *
 * Hidden tracks are excluded outright (SPEC 14 §4.2 "disabled/hidden/muted items
 * and tracks are excluded per their flags"). Muted audio tracks stay in the list
 * but are marked muted, so the planner keeps their video and drops their sound
 * rather than silently deleting a whole item.
 */
export function collectExportItems(state: TimelineState | null): Array<Record<string, unknown>> {
  if (!state) return [];
  const hiddenTracks = new Set(state.tracks.filter((track) => track.hidden).map((track) => track.id));
  const mutedTracks = new Set(state.tracks.filter((track) => track.muted).map((track) => track.id));
  const items: Array<Record<string, unknown>> = [];
  for (const item of Object.values(state.items)) {
    if (!item) continue;
    if (hiddenTracks.has(item.trackId)) continue;
    const hasAudioSource = item.type === 'audio' || item.type === 'video';
    items.push({
      id: item.id,
      trackId: item.trackId,
      type: item.type,
      mediaId: item.mediaId,
      startUs: item.startUs,
      durationUs: item.durationUs,
      sourceInUs: item.sourceInUs ?? 0,
      sourceDurationUs: item.sourceDurationUs,
      disabled: item.disabled ?? false,
      muted: Boolean(item.muted) || mutedTracks.has(item.trackId) || !hasAudioSource,
      hasAudio: hasAudioSource,
      captionSegment: item.captionSegment,
    });
  }
  return items;
}
