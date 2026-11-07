import React, { useState } from 'react';
import { Checkbox, Chip, IconButton, ScoreRing } from '@clipwright/design-system';
import { MoreHorizontal, Star, X } from 'lucide-react';
import type { MomentPayload } from '../../global.js';

const DIMENSION_LABELS: Array<[keyof MomentPayload['scores'], string]> = [
  ['hook', 'Hook'],
  ['standalone', 'Standalone'],
  ['emotion', 'Emotion'],
  ['interest', 'Interest'],
  ['story', 'Story'],
  ['value', 'Value'],
  ['pacing', 'Pacing'],
  ['social', 'Social'],
];

/**
 * SPEC 07 §9.2 — one moment card.
 *
 * The score ring, the reason and the eight-bar breakdown are the whole point:
 * the user should be able to see *why* this clip was suggested.
 */
export function MomentCard({
  moment,
  active,
  selected,
  stale,
  onSelect,
  onToggleSelected,
  onFavourite,
  onReject,
  onRegenerate,
  onShowInTranscript,
  alternateCount = 0,
  onCycleAlternate,
}: {
  moment: MomentPayload;
  active: boolean;
  selected: boolean;
  stale: boolean;
  onSelect: () => void;
  onToggleSelected: () => void;
  onFavourite: () => void;
  onReject: () => void;
  onRegenerate: () => void;
  onShowInTranscript: () => void;
  alternateCount?: number;
  onCycleAlternate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{
        position: 'relative',
        display: 'flex',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-lg)',
        background: active ? 'var(--surface-hover)' : 'var(--surface-card)',
        border: `1px solid ${active ? 'var(--brand)' : 'var(--line-subtle)'}`,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <Checkbox checked={selected} onChange={() => onToggleSelected()} ariaLabel={`Select ${moment.title}`} />
        <ScoreRing score={moment.score} lowConfidence={moment.confidence === 'low'} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h3
            style={{
              margin: 0,
              fontSize: 'var(--fs-md)',
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={moment.title}
          >
            {moment.title}
          </h3>
          {moment.manual && <Chip variant="neutral">Manual — not scored</Chip>}
        </div>

        <p
          style={{
            margin: '2px 0 6px 0',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={moment.reason}
        >
          {moment.reason}
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {formatTimecode(moment.startUs)}–{formatTimecode(moment.endUs)} · {formatDuration(moment.durationUs)}
          </span>
          {moment.status === 'favourite' && <Chip variant="brand">Favourite</Chip>}
          {moment.needsContext && <Chip variant="warning">Needs context</Chip>}
          {moment.confidence === 'low' && <Chip variant="error">Low confidence</Chip>}
          {alternateCount > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCycleAlternate?.();
              }}
              style={{
                background: 'var(--surface-panel)',
                border: '1px solid var(--line-subtle)',
                borderRadius: 'var(--radius-pill)',
                color: 'var(--text-secondary)',
                fontSize: 'var(--fs-xs)',
                padding: '2px 8px',
                cursor: 'pointer',
              }}
              title="Show the alternate cut of this moment"
            >
              Alternate ({alternateCount})
            </button>
          )}
          {stale && <Chip variant="warning">Transcript edited</Chip>}
          {moment.userEdited && <Chip variant="info">Edited — score may differ</Chip>}
          {moment.basis === 'llm' && moment.model && <Chip variant="neutral">{moment.model}</Chip>}
        </div>

        <p style={{ margin: '6px 0 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--text-brand)' }}>{moment.hookSentence}</span>
        </p>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((v) => !v);
          }}
          style={{
            marginTop: 6,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-brand)',
            fontSize: 'var(--fs-xs)',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide score breakdown' : 'Why this score'}
        </button>

        {expanded && <ScoreBreakdown moment={moment} />}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
        <IconButton
          label="Favourite"
          icon={<Star size={14} color={moment.status === 'favourite' ? 'var(--brand)' : 'currentColor'} />}
          active={moment.status === 'favourite'}
          onClick={(event) => {
            event.stopPropagation();
            onFavourite();
          }}
        />
        <IconButton
          label="Reject"
          size={28}
          icon={<X size={14} />}
          onClick={(event) => {
            event.stopPropagation();
            onReject();
          }}
        />
        <IconButton
          label="More actions"
          size={28}
          icon={<MoreHorizontal size={14} />}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        />
        {menuOpen && (
          <div
            style={{
              position: 'absolute',
              right: 12,
              top: 96,
              zIndex: 5,
              background: 'var(--surface-raised)',
              border: '1px solid var(--line-default)',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-menu)',
              padding: 4,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 180,
            }}
          >
            <MenuItem
              label="Re-score this moment"
              onClick={() => {
                setMenuOpen(false);
                onRegenerate();
              }}
            />
            <MenuItem
              label="Show in transcript"
              onClick={() => {
                setMenuOpen(false);
                onShowInTranscript();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        textAlign: 'left',
        padding: '6px 8px',
        background: 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-xs)',
        color: 'var(--text-primary)',
        fontSize: 'var(--fs-sm)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function ScoreBreakdown({ moment }: { moment: MomentPayload }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {DIMENSION_LABELS.map(([key, label]) => {
        const value = moment.scores[key] ?? 0;
        const weight = moment.weightsUsed[key] ?? 0;
        return (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 64px', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>{label}</span>
            <div style={{ height: 4, borderRadius: 'var(--radius-pill)', background: 'var(--surface-pressed)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, value))}%`,
                  height: '100%',
                  background: 'var(--brand)',
                  borderRadius: 'var(--radius-pill)',
                }}
              />
            </div>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {value} · ×{weight}
            </span>
          </div>
        );
      })}
      {moment.flags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
          {moment.flags.map((flag) => (
            <Chip key={flag} variant="neutral">
              {flag}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

export function formatTimecode(us: number): string {
  const totalSeconds = Math.max(0, Math.round(us / 1_000_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(us: number): string {
  const seconds = Math.max(0, Math.round(us / 1_000_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
