import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  Input,
  Select,
  Slider,
  useToast,
} from '@clipwright/design-system';
import { Film, Plus, RefreshCw, Search, Sparkles, Star } from 'lucide-react';
import type { Route } from '../App.js';
import { api, describeError, isDesktop } from '../api.js';
import { StageProgressScreen, type SubStep } from '../components/StageProgressScreen.js';
import { MomentCard } from '../components/moments/MomentCard.js';
import { PreviewPanel } from '../components/moments/PreviewPanel.js';
import { ConsentDialog } from '../components/ConsentDialog.js';
import type {
  AnalyzeMomentsResultPayload,
  MomentPayload,
  MomentsProgressPayload,
  ProjectRecord,
  TranscriptPayload,
} from '../global.js';

type SortId = 'score' | 'time' | 'duration';

const CONTENT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'podcast', label: 'Podcast / interview' },
  { value: 'talking_head', label: 'Talking head' },
  { value: 'tutorial', label: 'Tutorial' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'lecture', label: 'Lecture' },
  { value: 'other', label: 'Other' },
];

const STAGE_ORDER: Array<MomentsProgressPayload['stage']> = ['candidates', 'features', 'scoring', 'dedupe', 'ranking'];

const STAGE_LABELS: Record<MomentsProgressPayload['stage'], string> = {
  candidates: 'Preparing candidates',
  features: 'Analysing audio and text',
  scoring: 'Scoring',
  dedupe: 'Removing duplicates',
  ranking: 'Ranking',
};

/**
 * SPEC 07 §9 — the Moments screen.
 *
 * Two panes, honest mode labelling, and one rule that never bends: the score the
 * user sees is the score the pipeline computed, with its weights, or the words
 * "Manual — not scored".
 */
export function MomentsPage({ projectId, onNavigate }: { projectId: string; onNavigate: (r: Route) => void }) {
  const { pushToast } = useToast();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null);
  const [mediaId, setMediaId] = useState<string | undefined>(undefined);
  const [moments, setMoments] = useState<MomentPayload[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortId>('score');
  const [minScore, setMinScore] = useState(0);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [contentType, setContentType] = useState('auto');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [alternateIndex, setAlternateIndex] = useState<Record<string, number>>({});

  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<MomentsProgressPayload | null>(null);
  const [runNotes, setRunNotes] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<'llm' | 'heuristic' | null>(null);
  const [runProvider, setRunProvider] = useState<string | null>(null);
  const [scoring, setScoring] = useState<string | null>(null);
  const [showFindMore, setShowFindMore] = useState(false);
  const [focusText, setFocusText] = useState('');
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(false);
  const [playheadUs, setPlayheadUs] = useState(0);

  const loadAll = useCallback(async () => {
    if (!isDesktop()) {
      setError('Moments are computed inside the Clipwright desktop app.');
      setLoading(false);
      return;
    }
    try {
      const [nextProject, nextTranscript, nextMoments, media] = await Promise.all([
        api.getProject(projectId),
        api.getTranscript(projectId).catch(() => null),
        api.listMoments(projectId).catch(() => []),
        api.listMedia().catch(() => []),
      ]);
      setProject(nextProject ?? null);
      setTranscript((nextTranscript as TranscriptPayload) ?? null);
      setMoments(nextMoments ?? []);
      const sourceIds = (nextProject as ProjectRecord | null)?.sourceMediaIds ?? [];
      const records = media as Array<{ id: string }>;
      const primary = sourceIds.find((id) => records.some((record) => record.id === id)) ?? sourceIds[0] ?? records[0]?.id;
      setMediaId(primary);
      setContentType(
        String(((nextProject as ProjectRecord | null)?.settings as { contentType?: string } | undefined)?.contentType ?? 'auto')
      );
      setError('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    return api.onMomentsProgress((next) => setProgress(next));
  }, []);

  /* --------------------------------------------------------------- grouping */

  const groups = useMemo(() => {
    const byGroup = new Map<string, MomentPayload[]>();
    const singles: MomentPayload[][] = [];
    for (const moment of moments) {
      if (moment.groupId) {
        const list = byGroup.get(moment.groupId) ?? [];
        list.push(moment);
        byGroup.set(moment.groupId, list);
      } else {
        singles.push([moment]);
      }
    }
    return [...singles, ...[...byGroup.values()].map((list) => [...list].sort((a, b) => b.score - a.score))];
  }, [moments]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list: Array<{ moment: MomentPayload; alternates: number }> = [];

    for (const group of groups) {
      const index = alternateIndex[group[0].id] ?? 0;
      const moment = group[Math.min(index, group.length - 1)];
      if (!moment) continue;
      if (!showRejected && moment.status === 'rejected') continue;
      if (favouritesOnly && moment.status !== 'favourite') continue;
      if (moment.score < minScore) continue;
      if (needle) {
        const haystack = `${moment.title} ${moment.reason} ${moment.transcriptPreview} ${moment.hookSentence}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      list.push({ moment, alternates: group.length - 1 });
    }

    list.sort((a, b) => {
      if (sort === 'time') return a.moment.startUs - b.moment.startUs;
      if (sort === 'duration') return b.moment.durationUs - a.moment.durationUs;
      return b.moment.score - a.moment.score;
    });
    return list;
  }, [groups, alternateIndex, favouritesOnly, minScore, query, showRejected, sort]);

  const active = visible.find((entry) => entry.moment.id === activeId)?.moment ?? visible[0]?.moment ?? null;

  useEffect(() => {
    if (active && active.id !== activeId) {
      setActiveId(active.id);
      setPlayheadUs(active.startUs);
    }
  }, [active, activeId]);

  /* ---------------------------------------------------------------- actions */

  const analyse = useCallback(
    async (options: { findMore?: boolean } = {}) => {
      setAnalyzing(true);
      setProgress({ stage: 'candidates', percent: 0 });
      setRunNotes([]);
      try {
        const result: AnalyzeMomentsResultPayload = await api.analyzeMoments({
          projectId,
          contentType,
          focus: options.findMore ? focusText || undefined : undefined,
          excludeRanges: options.findMore
            ? moments.map((moment) => ({ startUs: moment.startUs, endUs: moment.endUs }))
            : undefined,
        });

        setRunNotes(result.notes);
        setRunMode(result.mode);
        setRunProvider(result.providerName ?? result.model ?? null);

        if (!result.route.ok && result.route.reason === 'needs_consent') {
          if (result.route.providerId) {
            setConsentFor(result.route.providerId);
          } else {
            setError(result.route.message);
          }
          setAnalyzing(false);
          return;
        }
        if (!result.route.ok && result.route.reason !== 'needs_consent' && result.moments.length === 0) {
          // The service already explained why it fell back; only a run that
          // produced nothing at all is an error worth blocking on.
          setError(result.route.message);
          setAnalyzing(false);
          return;
        }

        await loadAll();
        setShowFindMore(false);
        if (result.moments.length === 0) {
          pushToast({ message: 'No moments fitted your settings. Try a longer target range.', tone: 'warning' });
        }
      } catch (err) {
        setError(describeError(err));
      } finally {
        setAnalyzing(false);
        setProgress(null);
      }
    },
    [contentType, focusText, loadAll, moments, projectId, pushToast]
  );

  const setStatus = async (moment: MomentPayload, status: MomentPayload['status']) => {
    try {
      const updated = await api.updateMoment(projectId, {
        id: moment.id,
        status: moment.status === status ? 'candidate' : status,
      });
      setMoments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const changeRange = async (moment: MomentPayload, startUs: number, endUs: number) => {
    try {
      const updated = await api.updateMoment(projectId, { id: moment.id, startUs, endUs });
      setMoments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const resetRange = async (moment: MomentPayload) => {
    if (moment.aiStartUs === undefined || moment.aiEndUs === undefined) return;
    try {
      const updated = await api.updateMoment(projectId, {
        id: moment.id,
        startUs: moment.aiStartUs,
        endUs: moment.aiEndUs,
        userEdited: false,
      });
      setMoments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  const rescore = async (moment: MomentPayload) => {
    setScoring(moment.id);
    try {
      const updated = await api.rescoreMoment(projectId, moment.id);
      setMoments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      pushToast({ message: 'Re-scored with the current settings.', tone: 'success' });
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    } finally {
      setScoring(null);
    }
  };

  const createClips = async (ids: string[], openFirst: boolean) => {
    if (ids.length === 0) return;
    setCreating(true);
    try {
      const result = await api.createClips(projectId, ids, { openFirst });
      const first = result.created[0];
      if (first) {
        pushToast({
          message: `${result.created.length} clip${result.created.length === 1 ? '' : 's'} created.`,
          tone: 'success',
        });
        onNavigate({ name: 'project', id: projectId, stage: 'editor', compId: first.compId });
      }
      for (const failure of result.errors) {
        pushToast({ message: `${failure.title}: ${failure.message}`, tone: 'error' });
      }
      await loadAll();
      setSelectedIds([]);
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    } finally {
      setCreating(false);
    }
  };

  const addManualRange = async () => {
    const startUs = active ? Math.max(0, active.startUs) : 0;
    const endUs = active ? Math.min(transcript?.durationUs ?? active.endUs, active.endUs) : 30_000_000;
    try {
      const created = await api.addManualMoment(projectId, { startUs, endUs });
      setMoments((prev) => [...prev, created]);
      setActiveId(created.id);
      pushToast({ message: 'Manual range added. Drag the handles to set it.', tone: 'neutral' });
    } catch (err) {
      pushToast({ message: describeError(err), tone: 'error' });
    }
  };

  /* --------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = visible.findIndex((entry) => entry.moment.id === active?.id);
        const next = event.key === 'ArrowDown' ? Math.min(visible.length - 1, index + 1) : Math.max(0, index - 1);
        const moment = visible[next]?.moment;
        if (moment) {
          setActiveId(moment.id);
          setPlayheadUs(moment.startUs);
        }
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying((v) => !v);
        return;
      }
      if (event.key === 'Enter' && active) {
        event.preventDefault();
        void createClips([active.id], true);
        return;
      }
      if ((event.key === 'f' || event.key === 'F') && active) {
        void setStatus(active, 'favourite');
        setPlaying((v) => v);
        return;
      }
      if ((event.key === 'x' || event.key === 'X') && active) {
        void setStatus(active, 'rejected');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        setSelectedIds(visible.map((entry) => entry.moment.id));
        return;
      }
      if (event.key === 'Escape') {
        setSelectedIds([]);
        return;
      }
      if ((event.key === '[' || event.key === ']') && active && transcript) {
        const edge = event.key === '[' ? 'start' : 'end';
        const words = transcript.words;
        const currentUs = edge === 'start' ? active.startUs : active.endUs;
        let nextEdge = edge === 'start' ? active.startUs : active.endUs;
        if (edge === 'start') {
          for (const word of words) {
            if (word.startUs < currentUs) nextEdge = word.startUs;
            else break;
          }
        } else {
          const following = words.find((word) => word.startUs > currentUs);
          if (following) nextEdge = following.endUs;
        }
        void changeRange(
          active,
          edge === 'start' ? nextEdge : active.startUs,
          edge === 'end' ? nextEdge : active.endUs
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, visible, transcript]); // eslint-disable-line react-hooks/exhaustive-deps

  if (creating) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
        Creating clips…
      </div>
    );
  }

  if (analyzing && moments.length === 0) {
    const percent = overallPercent(progress);
    return (
      <StageProgressScreen
        title="Finding moments"
        reasonLine={progress?.detail ?? STAGE_LABELS[progress?.stage ?? 'candidates']}
        state="running"
        percent={percent}
        detail={
          progress?.stage === 'scoring' && progress.batch
            ? `Batch ${progress.batch} of ${progress.batchCount ?? 1}`
            : STAGE_LABELS[progress?.stage ?? 'candidates']
        }
        subSteps={subStepsFor(progress)}
      />
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ width: 520, minWidth: 380, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line-subtle)' }}>
        <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--line-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>
              {project?.name ?? 'Moments'}
            </h1>
            <span style={{ flex: 1 }} />
            <Button size={28} variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void loadAll()}>
              Reload
            </Button>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160, position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search moments"
                style={{ paddingLeft: 26 }}
              />
            </div>
            <Select
              value={sort}
              onChange={(value) => setSort(value as SortId)}
              ariaLabel="Sort moments"
              options={[
                { value: 'score', label: 'Score ↓' },
                { value: 'time', label: 'Time in video' },
                { value: 'duration', label: 'Duration' },
              ]}
            />
            <Button size={32} onClick={() => setFiltersOpen((v) => !v)}>
              Filters
            </Button>
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Content type</span>
            <Select
              value={contentType}
              onChange={(value) => {
                setContentType(value);
                pushToast({ message: 'Content type saved — re-rank to apply the new weights.', tone: 'neutral' });
              }}
              ariaLabel="Content type"
              options={CONTENT_TYPES}
            />
            <span style={{ flex: 1 }} />
            <Button size={28} icon={<Sparkles size={14} />} loading={analyzing} onClick={() => void analyse()}>
              {moments.length ? 'Re-rank' : 'Find moments'}
            </Button>
            <Button size={28} onClick={() => setShowFindMore(true)}>
              Find more
            </Button>
          </div>

          {runMode && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip variant={runMode === 'llm' ? 'brand' : 'neutral'}>
                {runMode === 'llm' ? `Scored by ${runProvider ?? 'your model'}` : 'Basic scoring — no AI model'}
              </Chip>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {runMode === 'llm'
                  ? 'Scores blend the model with local audio and text features (80/20).'
                  : 'Scores come from local heuristics only: words, pauses and audio energy.'}
              </span>
            </div>
          )}
          {runNotes.map((note) => (
            <div key={note} style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning)' }}>
              {note}
            </div>
          ))}
          {analyzing && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-brand)' }}>
              {progress ? `${STAGE_LABELS[progress.stage]} · ${Math.round(overallPercent(progress))}%` : 'Working…'}
            </div>
          )}
          {error && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>{error}</div>}
        </div>

        {filtersOpen && (
          <div
            style={{
              padding: 'var(--space-3) var(--space-4)',
              borderBottom: '1px solid var(--line-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--surface-panel)',
            }}
          >
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              Minimum score: {minScore}
              <Slider value={minScore} min={0} max={100} onChange={setMinScore} ariaLabel="Minimum score" />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              <Checkbox checked={favouritesOnly} onChange={setFavouritesOnly} ariaLabel="Favourites only" />
              Favourites only
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              <Checkbox checked={showRejected} onChange={setShowRejected} ariaLabel="Show rejected" />
              Show rejected
            </label>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading && <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>Loading moments…</p>}
          {!loading && visible.length === 0 && (
            <EmptyState
              icon={<Film size={20} />}
              title={moments.length ? 'Nothing matches these filters' : 'No moments yet'}
              explanation={
                transcript
                  ? moments.length
                    ? 'Loosen the filters to see the moments you already have.'
                    : 'Find moments to score this transcript. Basic scoring works offline with no model at all.'
                  : 'Transcribe the video first — moments come from the words, not the pixels.'
              }
              actionLabel={transcript ? 'Find moments' : undefined}
              onAction={transcript ? () => void analyse() : undefined}
            />
          )}
          {visible.map(({ moment, alternates }) => (
            <MomentCard
              key={moment.id}
              moment={moment}
              active={active?.id === moment.id}
              selected={selectedIds.includes(moment.id)}
              stale={Boolean(transcript && moment.transcriptVersion !== (transcript.version ?? 1))}
              alternateCount={alternates}
              onCycleAlternate={() => {
                const group = groups.find((entries) => entries.some((entry) => entry.id === moment.id));
                if (!group) return;
                const currentIndex = group.findIndex((entry) => entry.id === moment.id);
                const next = group[(currentIndex + 1) % group.length];
                setAlternateIndex((prev) => ({ ...prev, [group[0].id]: (currentIndex + 1) % group.length }));
                setActiveId(next.id);
              }}
              onSelect={() => {
                setActiveId(moment.id);
                setPlayheadUs(moment.startUs);
              }}
              onToggleSelected={() =>
                setSelectedIds((prev) =>
                  prev.includes(moment.id) ? prev.filter((id) => id !== moment.id) : [...prev, moment.id]
                )
              }
              onFavourite={() => void setStatus(moment, 'favourite')}
              onReject={() => void setStatus(moment, 'rejected')}
              onRegenerate={() => void rescore(moment)}
              onShowInTranscript={() => onNavigate({ name: 'project', id: projectId, stage: 'transcribe' })}
            />
          ))}
          <button
            type="button"
            onClick={() => void addManualRange()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '10px',
              borderRadius: 'var(--radius-md)',
              border: '1px dashed var(--line-default)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer',
            }}
          >
            <Plus size={14} /> Add a range you pick yourself
          </button>
        </div>

        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderTop: '1px solid var(--line-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--surface-panel)',
          }}
        >
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
            {selectedIds.length} selected
          </span>
          <span style={{ flex: 1 }} />
          <Button
            size={28}
            variant="ghost"
            disabled={selectedIds.length === 0}
            onClick={() => {
              for (const id of selectedIds) {
                const moment = moments.find((item) => item.id === id);
                if (moment) void setStatus(moment, 'rejected');
              }
              setSelectedIds([]);
            }}
          >
            Reject selected
          </Button>
          <Button
            size={32}
            variant="primary"
            disabled={selectedIds.length === 0 || creating}
            onClick={() => void createClips(selectedIds, false)}
          >
            Create {selectedIds.length > 1 ? `${selectedIds.length} clips` : 'clip'}
          </Button>
          <Button
            size={32}
            disabled={!active || creating}
            onClick={() => active && void createClips([active.id], true)}
          >
            Create &amp; open
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <PreviewPanel
          moment={active}
          transcript={transcript}
          mediaId={mediaId}
          aspect={
            (project?.settings as { aspect?: string } | undefined)?.aspect &&
            (project?.settings as { aspect?: string }).aspect !== 'original' &&
            (project?.settings as { aspect?: string }).aspect !== 'custom'
              ? String((project?.settings as { aspect?: string }).aspect)
              : '9:16'
          }
          captionStyleId={String((project?.settings as { captionStyleId?: string } | undefined)?.captionStyleId ?? 'bold-creator')}
          playheadUs={playheadUs}
          playing={playing}
          loop={loop}
          muted={muted}
          onTogglePlay={() => setPlaying((v) => !v)}
          onToggleLoop={() => setLoop((v) => !v)}
          onToggleMute={() => setMuted((v) => !v)}
          onSeek={(us) => {
            setPlayheadUs(us);
          }}
          onPlayheadChange={setPlayheadUs}
          onRangeChange={(startUs, endUs) => active && void changeRange(active, startUs, endUs)}
          onReset={() => active && void resetRange(active)}
          onRescore={() => active && void rescore(active)}
          scoring={Boolean(active && scoring === active.id)}
        />
      </div>

      <Dialog
        open={showFindMore}
        title="Find more moments"
        onClose={() => setShowFindMore(false)}
        maxWidth={520}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" onClick={() => setShowFindMore(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setShowFindMore(false);
                void analyse({ findMore: true });
              }}
            >
              Find more
            </Button>
          </div>
        }
      >
        <p style={{ margin: '0 0 8px 0', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          Ranges already used by your moments are skipped. Favourites, rejections and your own edits stay exactly as they are.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          What should the new clips be about? (optional)
          <Input
            value={focusText}
            onChange={(event) => setFocusText(event.target.value)}
            placeholder="e.g. mistakes beginners make"
          />
        </label>
      </Dialog>

      <ConsentDialog
        open={Boolean(consentFor)}
        providerId={consentFor}
        category="transcript"
        onClose={() => setConsentFor(null)}
        onGranted={() => {
          setConsentFor(null);
          // Consent is stored by the dialog; the run can now ask again.
          void analyse();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function overallPercent(progress: MomentsProgressPayload | null): number {
  if (!progress) return 0;
  const index = STAGE_ORDER.indexOf(progress.stage);
  const base = STAGE_ORDER.length ? (Math.max(0, index) / STAGE_ORDER.length) * 100 : 0;
  const stageShare = 100 / STAGE_ORDER.length;
  return Math.min(99, Math.round(base + (progress.percent ?? 0) * stageShare));
}

function subStepsFor(progress: MomentsProgressPayload | null): SubStep[] {
  const index = progress ? STAGE_ORDER.indexOf(progress.stage) : -1;
  return STAGE_ORDER.map((stage, i) => ({
    label: STAGE_LABELS[stage],
    status: i < index ? 'done' : i === index ? 'running' : 'pending',
  }));
}
