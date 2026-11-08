import React, { useEffect, useState } from 'react';
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
import { useCaptionStyles } from './use-caption-styles.js';
import { DEFAULT_STYLE_ID } from '@clipwright/caption-styles';

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
  const [leftTab, setLeftTab] = useState<'media' | 'captions'>('media');
  const captionStyles = useCaptionStyles(projectId);
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);

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
              </div>
              {leftTab === 'media' ? (
                <MediaLibrary
                  media={media}
                  timeline={timeline}
                  loading={mediaLoading}
                  error={mediaError}
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
              <PreviewPane state={state} fps={timeline.fps} captionStyles={captionStyles.styles} />
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
