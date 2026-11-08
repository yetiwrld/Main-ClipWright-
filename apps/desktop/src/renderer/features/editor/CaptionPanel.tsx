/**
 * SPEC 11 §7 — the caption list and per-word editor.
 *
 * Two halves, because they answer different questions. The list is "what does this
 * clip say, in order" — the thing a captionist reads down while checking a
 * transcript. The word view is "what does this one caption look like" — where
 * emphasis is toggled and text is corrected.
 *
 * Every edit goes through an engine command. Nothing here touches `captionSegment`
 * directly, which is what keeps an edit undoable and the autosave honest.
 */
import React, { useMemo, useState } from 'react';
import { Captions, Pencil, Sparkles, Type, Wand2 } from 'lucide-react';
import { Button, Card, Chip, EmptyState, IconButton, Input, TextArea } from '@clipwright/design-system';
import { BUILT_IN_STYLES, DEFAULT_STYLE_ID, builtInStyle } from '@clipwright/caption-styles';
import type { TimelineItem } from '@clipwright/project-schema/schemas';
import { formatTimecode, type TimelineState } from '@clipwright/timeline-engine';
import { playheadStore } from './playhead-store.js';
import type { TimelineApi } from './use-timeline.js';

interface CaptionRow {
  item: TimelineItem;
  text: string;
  wordCount: number;
  handEdited: boolean;
}

/** Caption items on the caption tracks, in timeline order. */
export function captionRows(state: TimelineState): CaptionRow[] {
  return Object.values(state.items)
    .filter((item) => item.type === 'caption' && item.captionSegment)
    .sort((a, b) => a.startUs - b.startUs)
    .map((item) => ({
      item,
      text: (item.captionSegment?.text ?? '').trim(),
      wordCount: item.captionSegment?.wordRefs.length ?? 0,
      // `manualText` is the marker the regeneration command respects. Surfacing it
      // in the list means a captionist can see which lines are safe from a re-run.
      handEdited: Boolean(item.captionSegment?.manualText),
    }));
}

/** The caption under the playhead, which the word view edits. */
export function activeCaptionRow(rows: CaptionRow[], timeUs: number): CaptionRow | null {
  let best: CaptionRow | null = null;
  for (const row of rows) {
    if (timeUs < row.item.startUs || timeUs >= row.item.startUs + row.item.durationUs) continue;
    if (!best || row.item.startUs > best.item.startUs) best = row;
  }
  return best;
}

export function CaptionPanel({
  state,
  timeline,
}: {
  state: TimelineState;
  timeline: TimelineApi;
}) {
  const rows = useMemo(() => captionRows(state), [state]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (rows.length === 0) {
    return (
      <div style={{ padding: 'var(--space-2)' }}>
        <EmptyState
          icon={<Captions size={20} />}
          title="No captions yet"
          explanation="Transcribe a clip and its captions appear here, in order, ready to edit."
        />
      </div>
    );
  }

  const active = activeCaptionRow(rows, playheadStore.get());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: 'var(--space-2)',
          borderBottom: '1px solid var(--line-subtle)',
          position: 'sticky',
          top: 0,
          background: 'var(--surface-card)',
          zIndex: 1,
        }}
      >
        <span style={{ flex: 1, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {rows.length} caption{rows.length === 1 ? '' : 's'}
        </span>
        <Button
          size={28}
          variant="secondary"
          icon={<Type size={12} />}
          aria-label="Apply a style to every caption"
          onClick={() => {
            // Styling every caption at once is the common case — a project picks one
            // look for its captions — and doing it one at a time is what makes an
            // editor feel unfinished.
            const ids = rows.map((row) => row.item.id);
            timeline.applyCaptionStyle(ids, activeStyleId(rows) ?? DEFAULT_STYLE_ID, true);
          }}
        >
          Restyle all
        </Button>
      </div>

      {rows.map((row) => (
        <CaptionRowView
          key={row.item.id}
          row={row}
          active={active?.item.id === row.item.id}
          editing={editing === row.item.id}
          draft={draft}
          fps={timeline.fps}
          onSelect={() => {
            timeline.select([row.item.id]);
            playheadStore.set(row.item.startUs);
          }}
          onStartEdit={() => {
            setEditing(row.item.id);
            setDraft(row.text);
          }}
          onDraftChange={setDraft}
          onCommit={() => {
            if (draft.trim() !== row.text) timeline.editCaptionText(row.item.id, draft);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
          onStyle={(styleId) => timeline.applyCaptionStyle([row.item.id], styleId, true)}
        />
      ))}
    </div>
  );
}

/** The style most captions already use, so "Restyle all" does not silently change it. */
function activeStyleId(rows: CaptionRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row.item.captionStyleId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function CaptionRowView({
  row,
  active,
  editing,
  draft,
  fps,
  onSelect,
  onStartEdit,
  onDraftChange,
  onCommit,
  onCancel,
  onStyle,
}: {
  row: CaptionRow;
  active: boolean;
  editing: boolean;
  draft: string;
  fps: 30 | 60;
  onSelect: () => void;
  onStartEdit: () => void;
  onDraftChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onStyle: (styleId: string) => void;
}) {
  const styleId = row.item.captionStyleId ?? DEFAULT_STYLE_ID;
  const styleName = builtInStyle(styleId)?.name ?? styleId;

  return (
    <Card
      style={{
        margin: '0 var(--space-2) var(--space-1)',
        borderColor: active ? 'var(--brand)' : undefined,
        background: active ? 'var(--brand-tint)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <Button
          size={28}
          variant="ghost"
          onClick={onSelect}
          aria-label={`Jump to caption at ${formatTimecode(row.item.startUs, fps)}`}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', padding: '0 var(--space-1)' }}
        >
          {formatTimecode(row.item.startUs, fps)}
        </Button>
        <span style={{ flex: 1 }} />
        {row.handEdited && (
          <Chip variant="warning" aria-label="This caption was edited by hand and a regeneration will keep it">
            edited
          </Chip>
        )}
        <IconButton label="Edit caption text" size={28} icon={<Pencil size={12} />} onClick={onStartEdit} />
      </div>

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
          <TextArea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            rows={2}
            aria-label="Caption text"
            autoFocus
            onKeyDown={(event) => {
              // Enter commits and Shift+Enter makes a line break — the opposite of
              // most text areas, because a caption's line breaks are usually
              // computed rather than typed.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onCommit();
              }
              if (event.key === 'Escape') onCancel();
            }}
          />
          <div style={{ display: 'flex', gap: 'var(--space-1)', justifyContent: 'flex-end' }}>
            <Button size={28} variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size={28} variant="primary" onClick={onCommit}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-primary)',
            lineHeight: 1.4,
          }}
        >
          {row.text || <span style={{ color: 'var(--text-muted)' }}>(empty caption)</span>}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {row.wordCount} word{row.wordCount === 1 ? '' : 's'} · {styleName}
        </span>
        <span style={{ flex: 1 }} />
        <select
          aria-label="Caption style"
          value={styleId}
          onChange={(event) => onStyle(event.target.value)}
          style={{
            fontSize: 'var(--fs-xs)',
            padding: '2px 4px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--line-default)',
            background: 'var(--surface-raised)',
            color: 'var(--text-primary)',
          }}
        >
          {BUILT_IN_STYLES.map((style) => (
            <option key={style.id} value={style.id}>
              {style.name}
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}

/**
 * The word view: every word of one caption, click to emphasise.
 *
 * This is the half that makes per-word styling usable — `wordOverrides` are keyed
 * by word id, so a word stays emphasised when the caption is retimed or the style
 * is swapped, and this is the only place where choosing *which* word is practical.
 */
export function CaptionWordView({
  state,
  timeline,
  itemId,
}: {
  state: TimelineState;
  timeline: TimelineApi;
  itemId: string;
}) {
  const item = state.items[itemId];
  const segment = item?.captionSegment;
  if (!item || !segment) {
    return (
      <div style={{ padding: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
        Select a caption on the timeline to edit its words.
      </div>
    );
  }

  const refs = segment.wordRefs;
  const words = (segment.text ?? '').trim().split(/\s+/u).slice(0, refs.length);

  if (refs.length === 0) {
    return (
      <div style={{ padding: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
        This caption has no word timings, so individual words cannot be emphasised.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <Sparkles size={12} />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Click a word to emphasise it. Styles keep your emphasis when swapped.
        </span>
      </div>
      <div role="list" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
        {words.map((word, index) => {
          const ref = refs[index]!;
          const override = segment.wordOverrides?.[ref.wordId];
          const emphasised = Boolean(override?.emphasis);
          return (
            <button
              key={ref.wordId}
              type="button"
              role="listitem"
              aria-pressed={emphasised}
              aria-label={`Word ${index + 1}: ${word}${emphasised ? ', emphasised' : ''}`}
              onClick={() => timeline.setWordEmphasis(itemId, index, !emphasised)}
              title={`${formatTimecode(ref.startUs, timeline.fps)} → ${formatTimecode(ref.endUs, timeline.fps)}`}
              style={{
                padding: '2px 6px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${emphasised ? 'var(--brand)' : 'var(--line-default)'}`,
                background: emphasised ? 'var(--brand-tint)' : 'var(--surface-raised)',
                color: emphasised ? 'var(--text-brand)' : 'var(--text-primary)',
                fontWeight: emphasised ? 700 : 400,
                fontSize: 'var(--fs-sm)',
                cursor: 'pointer',
              }}
            >
              {word}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {segment.manualText ? 'Edited by hand — regeneration will not replace this caption.' : 'Generated from the transcript.'}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
        <Button
          size={28}
          variant="secondary"
          icon={<Wand2 size={12} />}
          onClick={() => timeline.trimCaptionWordsToRange(itemId)}
        >
          Trim words to caption
        </Button>
      </div>
    </div>
  );
}
