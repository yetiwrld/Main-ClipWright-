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
import type { CaptionStyle } from '@clipwright/caption-styles';
import { aspectFromCanvas, presetForShortSide } from '@clipwright/export-core';
import type { ExportJobPayload } from '../../global.js';
import { isDesktop } from '../../api.js';
import { DEFAULT_EXPORT_STATE, ExportPanel, type ExportPanelState } from './ExportPanel.js';
import { ExportQueuePanel, formatRemaining } from './ExportQueuePanel.js';
import { useExport, type StartExportInput, type StartExportResult } from './use-export.js';

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
  /**
   * The composition's canvas. The export panel starts from defaults, and its aspect decides the
   * output frame — a 16:9 composition exported from a panel that started at 9:16 produces a
   * portrait file unless the user notices. The canvas is the composition's own truth.
   *
   * Optional because the dialog is also rendered from places that have no composition yet; without
   * it the panel keeps its documented default.
   */
  canvas?: { width: number; height: number };
  /**
   * Project-local caption styles. Without these a burn-in falls back to the preset
   * each caption's style started from, silently ignoring every edit made in the
   * style editor (SPEC 11 §6).
   */
  captionStyles?: Readonly<Record<string, CaptionStyle>>;
  /**
   * The export runner. Injectable so the dialog's own behaviour — the clash question, in
   * particular — can be exercised without a main process.
   *
   * `useExport` reaches IPC directly, so every existing test of this dialog mocks `api` away and
   * stops before the interesting branch. SPEC 14 §5's *Ask* is a conversation between the two: the
   * service reports the clash, the dialog asks, the answer re-runs. That cannot be tested from
   * either side alone — which is how it came to be implemented in neither.
   */
  startExport?: (input: StartExportInput) => Promise<StartExportResult>;
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
  canvas,
  captionStyles,
  startExport: injectedStartExport,
}: ExportDialogProps) {
  const [panel, setPanel] = useState<ExportPanelState>(() => ({
    ...DEFAULT_EXPORT_STATE,
    /*
      SPEC 14 §4.3's "Match project" is the panel's default, and it is expressed by seeding rather
      than by an extra option: the control offers 30 and 60, and starting on the composition's own
      value *is* matching it until the user says otherwise. A 60 fps composition used to export at
      30 — half the frames, dropped silently — because the default was a constant.
    */
    fps: fps === 60 ? 60 : 30,
    ...(canvas
      ? {
          aspect: aspectFromCanvas(canvas.width, canvas.height),
          /* The shortest side is what a resolution preset means, so a 1080p portrait canvas and a
             1080p landscape one want the same preset id. */
          preset: presetForShortSide(Math.min(canvas.width, canvas.height)),
        }
      : {}),
  }));
  const [rangeChoice, setRangeChoice] = useState<RangeChoice>(workAreaUs ? 'work-area' : 'whole');
  const [message, setMessage] = useState('');
  /** The path a clash stopped, when the policy is "ask me". Empty when there is nothing to ask. */
  const [clash, setClash] = useState('');
  const [detailsFor, setDetailsFor] = useState<ExportJobPayload | null>(null);
  const exports = useExport(projectId);
  /* The injected runner replaces only the start call; the queue around it is still the real one. */
  const startExport = injectedStartExport ?? exports.startExport;

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

  const handleExport = useCallback(async (policyOverride?: ExportPanelState['clashPolicy']) => {
    setMessage('');
    setClash('');
    const result = await startExport({
      panel,
      name: compositionName || 'Clip',
      projectId,
      compositionId,
      rangeUs,
      compositionDurationUs: durationUs,
      compositionFps: fps,
      items,
      backgroundColor: state?.canvas?.backgroundColor,
      clashPolicy: policyOverride ?? panel.clashPolicy,
      fullDecode: true,
      captionStyles,
    });
    if (!result.ok) {
      /*
        SPEC 14 §5's *Ask what to do*. The service reports the path it would have written, so the
        question is concrete — "Replace clip.mp4?" rather than "a file exists". Answering re-runs the
        export with an explicit policy, so `ask` never reaches main a second time.
      */
      if (result.action === 'resolve-clash') {
        setClash(result.error);
        return;
      }
      setMessage(result.error);
      return;
    }
    setMessage('Export queued. Rendering starts now and the editor stays usable.');
  }, [exports, panel, compositionName, projectId, compositionId, rangeUs, durationUs, fps, items, captionStyles, state?.canvas?.backgroundColor]);

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

        {clash && (
          /*
            SPEC 14 §5's *Ask*. Shown with the path so the choice is about a file the user can
            picture; the answer re-runs the export with that policy so `ask` is never sent twice.
          */
          <div
            role="alertdialog"
            aria-label="File already exists"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              padding: 'var(--space-2)',
              border: '1px solid var(--line-default)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-raised)',
            }}
          >
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
              {clash} already exists.
            </span>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button size={28} onClick={() => void handleExport('replace')}>
                Replace it
              </Button>
              <Button size={28} onClick={() => void handleExport('auto-number')}>
                Keep both
              </Button>
              <Button size={28} onClick={() => setClash('')}>
                {/* Named apart from the panel's own Cancel: two buttons with one accessible name is
                    ambiguous to a screen reader and to a test. */}
                Don’t replace
              </Button>
            </div>
          </div>
        )}

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
  /*
    Solo silences every *other* audio-bearing track, and only while at least one
    track is soloed (SPEC 12 §4.2, §12 item 8). The preview has always resolved it
    this way; the export did not, so a soloed project previewed with one track and
    exported with all of them. Computed here rather than in the planner because it
    is a property of the composition's track flags, which is exactly what this
    function already reduces.
  */
  const anySolo = state.tracks.some((track) => track.solo);
  const silencedBySolo = new Set(
    anySolo ? state.tracks.filter((track) => !track.solo).map((track) => track.id) : [],
  );
  const items: Array<Record<string, unknown>> = [];
  /*
    One lookup per item rather than a map built up front: a project has tens of tracks and
    thousands of items, and `find` over a track list is cheaper than the allocation. Named so the
    two ducking lines below read as one thing.
  */
  const trackOf = (trackId: string) => state.tracks.find((track) => track.id === trackId);
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
      muted:
        Boolean(item.muted) ||
        mutedTracks.has(item.trackId) ||
        // A non-soloed track is silent, but its video still renders: solo is an
        // audio decision, and hiding the picture would be a different feature.
        silencedBySolo.has(item.trackId) ||
        !hasAudioSource,
      hasAudio: hasAudioSource,
      captionSegment: item.captionSegment,
      // Without this every caption burns in with the project default style, so a
      // composition whose captions are Karaoke exports in Bold Creator's look —
      // present, but not the look that was designed (SPEC 11 §6).
      captionStyleId: item.captionStyleId,
      // The plan carries the item's look so the file matches the preview; without
      // this the export renders every clip whole and centred however it was
      // cropped, scaled or rotated in the editor (SPEC 10 §8.4–8.6).
      geometry: { crop: item.crop, transform: item.transform },
      // Keyframes travel to the decoder so an animated item is rendered in segments
      // (SPEC 12 §2.2). Without them the export freezes the clip at its static
      // values, which is the one thing a keyframed move must not do.
      keyframes: item.keyframes,
      // Layering (SPEC 10 §2/§6): without opacity and blend mode the export
      // paints every clip solid and normally, so a faded or multiplied overlay
      // arrives in the file as an opaque rectangle.
      opacity: item.opacity,
      blendMode: item.blendMode,
      // The export needs to know which clip is on top, and the item itself does
      // not store that — the track's order does.
      trackOrder: state.tracks.find((track) => track.id === item.trackId)?.order ?? 0,
      /*
        The track's auto-duck settings (SPEC 12 §6.7), which until now lived only in the project
        file: six validated parameters — `enabled`, `triggerTrackIds`, `reductionDb`,
        `thresholdDb`, `attackMs`, `releaseMs` — that no renderer read, so the control would have
        been a control over nothing. Carried with the item because that is how the plan and the
        mixer are structured; the mixer then ducks a *track* under the tracks it names.
      */
      ...(trackOf(item.trackId)?.ducking !== undefined
        ? { trackDucking: trackOf(item.trackId)!.ducking }
        : {}),
      // Transitions travel too (SPEC 12 §4); without them the export cuts hard
      // where the preview fades, which is the difference a user notices first.
      transitionIn: item.transitionIn,
      // The effect chain travels to the decoder so a graded clip exports graded
      // (SPEC 12 §3). Without it the export renders the ungraded original.
      effects: item.effects,
    });
  }
  return items;
}
