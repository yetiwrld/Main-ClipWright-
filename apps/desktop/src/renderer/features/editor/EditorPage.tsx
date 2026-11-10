import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LayoutPanelLeft, PanelRight, ScrollText, Upload } from 'lucide-react';
import { Button, Chip, Dialog, IconButton, PanelHeader } from '@clipwright/design-system';
import { api, describeError, isDesktop } from '../../api.js';
import type { TimelineApi } from './use-timeline.js';
import { useTimeline } from './use-timeline.js';
import { TimelinePanel } from './TimelinePanel.js';
import { CurveEditor } from './CurveEditor.js';
import { projectDurationUs, type TimelineState } from '@clipwright/timeline-engine';
import { PreviewPane } from './PreviewPane.js';
import { ItemInspector, MediaLibrary, type MediaAsset } from './Inspector.js';
import { CaptionPanel, CaptionWordView } from './CaptionPanel.js';
import { ExportDialog } from '../export/ExportDialog.js';
import { CaptionStyleEditor } from './CaptionStyleEditor.js';
import { playheadStore } from './playhead-store.js';
import { BrandKitPanel } from './BrandKitPanel.js';
import { useBrandKits } from './use-brand-kits.js';
import { useCaptionStyles } from './use-caption-styles.js';
import { mediaAwaitingProxy, type PreviewJobLike } from './preview-quality.js';
import { BUILT_IN_STYLES, DEFAULT_STYLE_ID, resolveStyle } from '@clipwright/caption-styles';
import type { CapturableItem } from '@clipwright/brand-kits';

export function EditorPage({
  projectId,
  compId,
  onBack,
}: {
  projectId: string;
  compId?: string;
  onBack: () => void;
}) {
  const timeline = useTimeline(projectId, compId);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState('');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [curveOpen, setCurveOpen] = useState(false);
  const [timelineShare, setTimelineShare] = useState(0.42);
  const [resizing, setResizing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [leftTab, setLeftTab] = useState<'media' | 'captions' | 'kits'>('media');
  const captionStyles = useCaptionStyles(projectId);
  const brandKits = useBrandKits(projectId);
  /*
    What the project can actually supply, so a kit's apply dialog reports a missing logo
    instead of promising one. Built from the two libraries the editor already holds — the
    media list and the style presets plus this project's copies — rather than asked of the
    kit, which knows nothing about either.
  */
  const captionStyleIds = useMemo(
    () => new Set([...BUILT_IN_STYLES.map((style) => style.id), ...Object.keys(captionStyles.styles)]),
    [captionStyles.styles],
  );
  const assetIds = useMemo(() => new Set(media.map((item) => item.id)), [media]);
  /*
    The style a capture reads its colours and font from: the first caption on the timeline with
    a style, resolved through the same path the preview uses. Resolved here rather than inside
    the panel because the panel would otherwise need the style store, the presets and the
    project copies — three things it has no other use for.
  */
  const captureStyle = useMemo(() => {
    const captionStyleId = Object.values(timeline.state?.items ?? {}).find(
      (item) => item.type === 'caption' && item.captionStyleId,
    )?.captionStyleId;
    if (!captionStyleId) return undefined;
    const resolved = resolveStyle(captionStyleId, captionStyles.styles);
    return resolved
      ? { font: resolved.font, fill: resolved.fill, outline: resolved.outline, highlight: resolved.highlight, background: resolved.background }
      : undefined;
  }, [timeline.state, captionStyles.styles]);
  /*
    What a capture may look at: every item in the composition, as the structural shape the
    capture package declares. A cast is honest here — the shape is a subset of a timeline item
    and the field names are the schema's.
  */
  const captureItems = useMemo(
    () => Object.values(timeline.state?.items ?? {}) as unknown as CapturableItem[],
    [timeline.state],
  );
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  /*
    The `useProxyPreview` setting, for the preview's quality chip (SPEC 10 §5.1, SPEC 04 §6.3).

    Read here rather than in the preview so the preview stays a pure function of its props, and
    defaulted to `true` — main's own default — so the chip cannot claim proxies were switched off
    before the settings have arrived.
  */
  const [useProxyPreview, setUseProxyPreview] = useState(true);
  /*
    The background jobs, for the same chip: a `proxy` job for a clip is what makes
    "Preparing smoother preview…" true, and nothing else in the renderer can see one (SPEC 04
    §6.2). An import is the only thing that creates them, so this polls — but only while some
    media still needs a proxy and has none, which is a few seconds on a cold import and never
    again after the file exists. Polling wholesale would be a timer running for the life of the
    editor to answer a question nobody is asking.
  */
  const [jobs, setJobs] = useState<PreviewJobLike[]>([]);
  const awaitingProxy = mediaAwaitingProxy(media);

  useEffect(() => {
    if (!isDesktop()) {
      setMediaLoading(false);
      setMediaError('The editor runs inside the Clipwright desktop app.');
      return;
    }
    let cancelled = false;
    void api
      .listMedia()
      .then((list) => {
        if (cancelled) return;
        setMedia(list as MediaAsset[]);
        setMediaLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setMediaError(describeError(err));
        setMediaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
    Settings load separately from the media list, and a failure here is not worth surfacing: the
    only consumer is a chip, and a chip that cannot be computed is simply not drawn.
  */
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const record = settings as { useProxyPreview?: boolean } | null;
        setUseProxyPreview(record?.useProxyPreview !== false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isDesktop() || !awaitingProxy) return;
    let cancelled = false;
    const load = () =>
      void api
        .listJobs()
        .then((list) => {
          if (cancelled) return;
          setJobs(list as unknown as PreviewJobLike[]);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [awaitingProxy]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      const height = window.innerHeight - 56;
      const share = 1 - (event.clientY - 56) / Math.max(200, height);
      setTimelineShare(Math.min(0.7, Math.max(0.18, share)));
    };
    const onUp = () => setResizing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [resizing]);

  // Panel shortcuts (SPEC 08 §3.3).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        setLeftOpen((value) => !value);
      }
      if (key === 'b' && event.shiftKey) {
        event.preventDefault();
        setRightOpen((value) => !value);
      }
      if (key === 'j') {
        event.preventDefault();
        setTimelineShare((value) => (value > 0.5 ? 0.42 : 0.66));
      }
      // SPEC 12 §2.6: the curve editor toggles with Ctrl+Shift+C.
      if (key === 'c' && event.shiftKey) {
        event.preventDefault();
        setCurveOpen((value) => !value);
      }
      // SPEC 14 §3: Export opens with Ctrl+E.
      if (key === 'e' && !event.shiftKey) {
        event.preventDefault();
        setExportOpen(true);
      }
      /*
        SPEC 10 §8.5: the fill lock toggles with Ctrl+L. Written through the same command
        the toolbar chip uses, so the shortcut and the button cannot disagree — and so the
        setting lands on the undo stack like every other document change.
      */
      if (key === 'l' && !event.shiftKey) {
        event.preventDefault();
        // Flipped inside the command, not from the value this listener closed over.
        timeline.toggleFlag('coverLock');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const { state, record } = timeline;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--line-subtle)',
        }}
      >
        <IconButton label="Back to moments" size={28} icon={<ArrowLeft size={14} />} onClick={onBack} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)', fontWeight: 600 }}>
            {record?.name ?? 'Clip'}
          </span>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {state ? `${state.tracks.length} tracks · ${Object.keys(state.items).length} clips` : 'Loading…'}
          </span>
        </div>
        <SaveBadge saveState={timeline.saveState} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <IconButton
            label="Export"
            shortcut="Ctrl+E"
            size={28}
            icon={<Upload size={14} />}
            onClick={() => setExportOpen(true)}
          />
          <IconButton
            label="Toggle media panel"
            shortcut="Ctrl+B"
            size={28}
            active={leftOpen}
            icon={<LayoutPanelLeft size={14} />}
            onClick={() => setLeftOpen((value) => !value)}
          />
          <IconButton
            label="Toggle inspector"
            shortcut="Ctrl+Shift+B"
            size={28}
            active={rightOpen}
            icon={<PanelRight size={14} />}
            onClick={() => setRightOpen((value) => !value)}
          />
          <IconButton
            label="Reset timeline height"
            size={28}
            icon={<ScrollText size={14} />}
            onClick={() => setTimelineShare(0.42)}
          />
        </div>
      </header>

      <Dialog
        open={Boolean(timeline.recovery)}
        title="Unsaved edits were found"
        onClose={timeline.dismissRecovery}
        footer={
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" onClick={timeline.dismissRecovery}>
              Not now
            </Button>
            <Button variant="primary" onClick={() => void timeline.recover()}>
              Recover them
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          The previous session ended before this clip was saved. {timeline.recovery?.entries ?? 0} unsaved
          edit{(timeline.recovery?.entries ?? 0) === 1 ? '' : 's'} can be replayed from the journal. The
          saved version is kept until you recover.
        </p>
      </Dialog>

      {timeline.loadError && (
        <div style={{ padding: 'var(--space-3)', color: 'var(--error)', fontSize: 'var(--fs-sm)' }}>
          {timeline.loadError}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 'var(--space-2)' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 'var(--space-2)' }}>
          {leftOpen && (
            <section
              style={{
                width: 320,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                background: 'var(--surface-card)',
                border: '1px solid var(--line-subtle)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}
            >
              <PanelHeader title="Library" onToggleCollapse={() => setLeftOpen(false)} />
              <div
                role="tablist"
                aria-label="Library sections"
                style={{ display: 'flex', gap: 'var(--space-1)', padding: '0 var(--space-2) var(--space-1)' }}
              >
                <Button
                  size={28}
                  variant={leftTab === 'media' ? 'secondary' : 'ghost'}
                  role="tab"
                  aria-selected={leftTab === 'media'}
                  onClick={() => setLeftTab('media')}
                >
                  Media
                </Button>
                <Button
                  size={28}
                  variant={leftTab === 'captions' ? 'secondary' : 'ghost'}
                  role="tab"
                  aria-selected={leftTab === 'captions'}
                  onClick={() => setLeftTab('captions')}
                >
                  Captions
                </Button>
                <Button
                  size={28}
                  variant={leftTab === 'kits' ? 'secondary' : 'ghost'}
                  role="tab"
                  aria-selected={leftTab === 'kits'}
                  onClick={() => setLeftTab('kits')}
                >
                  Kits
                </Button>
              </div>
              {leftTab === 'media' ? (
                <MediaLibrary
                  media={media}
                  timeline={timeline}
                  loading={mediaLoading}
                  error={mediaError}
                />
              ) : leftTab === 'kits' && state ? (
                <BrandKitPanel
                  state={state}
                  timeline={timeline}
                  brandKits={brandKits}
                  canvas={{ widthPx: state.canvas.width, heightPx: state.canvas.height }}
                  captionStyleIds={captionStyleIds}
                  assetIds={assetIds}
                  media={media.map((entry) => ({ id: entry.id, label: entry.originalName, kind: entry.kind }))}
                  captionStyle={captureStyle}
                  captureItems={captureItems}
                />
              ) : state ? (
                <CaptionPanel
                  state={state}
                  timeline={timeline}
                  projectStyles={captionStyles.styles}
                  onEditStyle={() => setStyleEditorOpen(true)}
                />
              ) : (
                <div style={{ padding: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
                  Loading…
                </div>
              )}
            </section>
          )}

          <section
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              background: 'var(--surface-card)',
              border: '1px solid var(--line-subtle)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}
          >
            {state ? (
              <PreviewPane
                state={state}
                fps={timeline.fps}
                captionStyles={captionStyles.styles}
                timeline={timeline}
                media={media}
                jobs={jobs}
                useProxyPreview={useProxyPreview}
              />
            ) : (
              <div style={{ padding: 'var(--space-3)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
                {timeline.loadError || 'Loading the preview…'}
              </div>
            )}
          </section>

          {rightOpen && (
            <section
              style={{
                width: 300,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                background: 'var(--surface-card)',
                border: '1px solid var(--line-subtle)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}
            >
              <PanelHeader title="Inspector" onToggleCollapse={() => setRightOpen(false)} />
              {state ? (
                <>
                  <ItemInspector state={state} timeline={timeline} />
                  {timeline.selection.length === 1 &&
                    state.items[timeline.selection[0]!]?.type === 'caption' && (
                      <>
                        <div
                          style={{
                            borderTop: '1px solid var(--line-subtle)',
                            fontSize: 'var(--fs-xs)',
                            color: 'var(--text-muted)',
                            padding: 'var(--space-2) var(--space-2) 0',
                            textTransform: 'uppercase',
                            letterSpacing: '0.02em',
                          }}
                        >
                          Words
                        </div>
                        <CaptionWordView state={state} timeline={timeline} itemId={timeline.selection[0]!} />
                      </>
                    )}
                </>
              ) : (
                <div style={{ padding: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
                  Loading…
                </div>
              )}
            </section>
          )}
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize timeline"
          onPointerDown={() => setResizing(true)}
          style={{
            height: 6,
            margin: 'var(--space-1) 0',
            cursor: 'row-resize',
            borderRadius: 'var(--radius-xs)',
            background: resizing ? 'var(--brand-tint)' : 'transparent',
          }}
        />

        <section
          style={{
            height: `${Math.round(timelineShare * 100)}%`,
            minHeight: 180,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--surface-card)',
            border: '1px solid var(--line-subtle)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <TimelinePanel timeline={timeline} />
          {/*
            SPEC 12 §2.6 wants the curve editor as a bottom drawer of the timeline.
            It sits inside the timeline section rather than beside it so the drawer
            shrinks the timeline instead of stealing width from the preview.
          */}
          {curveOpen && (
            <CurveEditor
              state={state}
              timeline={timeline}
              itemId={timeline.selection.length === 1 ? timeline.selection[0]! : null}
              fps={timeline.fps}
              onClose={() => setCurveOpen(false)}
            />
          )}
        </section>
      </div>

      {/* SPEC 14 §3/§6 — export panel and queue */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        projectId={projectId}
        compositionId={timeline.record?.id ?? compId ?? ''}
        compositionName={record?.name ?? 'Clip'}
        state={state}
        fps={timeline.fps}
        workAreaUs={state?.workArea ? [state.workArea.inUs, state.workArea.outUs] : null}
        durationUs={state ? projectDurationUs(state) : 0}
        captionStyles={captionStyles.styles}
      />

      <CaptionStyleEditor
        open={styleEditorOpen}
        styleId={editingStyleId(state, timeline.selection) ?? DEFAULT_STYLE_ID}
        projectStyles={captionStyles.styles}
        onClose={() => setStyleEditorOpen(false)}
        onSave={(style) => {
          void captionStyles.save(style);
          setStyleEditorOpen(false);
        }}
      />
    </div>
  );
}

function SaveBadge({ saveState }: { saveState: TimelineApi['saveState'] }) {
  const label =
    saveState === 'saved'
      ? 'Saved'
      : saveState === 'saving'
        ? 'Saving…'
        : saveState === 'dirty'
          ? 'Unsaved changes'
          : 'Not saved';
  const variant = saveState === 'error' ? 'error' : saveState === 'saved' ? 'success' : 'neutral';
  return <Chip variant={variant}>{label}</Chip>;
}

/**
 * The style the style editor opens on: the selected caption's, else the caption
 * under the playhead. Editing "the current look" is what a user means by opening
 * the style editor, and picking the first caption in the timeline instead would
 * silently edit a different clip's look.
 */
export function editingStyleId(
  state: TimelineState | null,
  selection: readonly string[],
): string | null {
  if (!state) return null;
  for (const id of selection) {
    const item = state.items[id];
    if (item?.type === 'caption' && item.captionStyleId) return item.captionStyleId;
  }
  const us = playheadStore.get();
  const under = Object.values(state.items)
    .filter((item) => item.type === 'caption' && item.captionStyleId)
    .filter((item) => us >= item.startUs && us < item.startUs + item.durationUs)
    .sort((a, b) => b.startUs - a.startUs)[0];
  return under?.captionStyleId ?? null;
}
