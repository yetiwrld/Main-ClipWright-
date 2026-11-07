import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CompositionPayloadSchema,
  type CompositionRecord,
  type TimelineItem,
} from '@clipwright/project-schema/schemas';
import {
  TimelineHistory,
  addItem,
  addMarker,
  createMediaItem,
  deleteItems,
  duplicateItems,
  moveItems,
  setTrackMuted,
  splitItems,
  trimItem,
  groupItems,
  pasteItems,
  ungroupItems,
  type CommandResult,
  type EditMode,
  type Fps,
  type TimelineState,
} from '@clipwright/timeline-engine';
import { api, describeError, isDesktop } from '../../api.js';
import { playheadStore } from './playhead-store.js';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface ClipboardEntry {
  item: TimelineItem;
  trackId: string;
}

/** One clipboard for the whole session, shared between clips (SPEC 09 §12). */
let sessionClipboard: ClipboardEntry[] = [];

interface RecoveryInfo {
  entries: number;
}

export interface TimelineApi {
  state: TimelineState | null;
  fps: Fps;
  record: CompositionRecord | null;
  loadError: string;
  saveState: SaveState;
  selection: string[];
  notes: string[];
  canUndo: boolean;
  canRedo: boolean;
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  run: (label: string, command: (state: TimelineState) => CommandResult) => boolean;
  undo: () => void;
  redo: () => void;
  move: (moves: Array<{ itemId: string; startUs: number; trackId?: string }>, mode?: EditMode) => boolean;
  trim: (itemId: string, edge: 'start' | 'end', toUs: number, ripple?: boolean) => boolean;
  split: (atUs: number) => boolean;
  splitAt: (itemIds: string[], atUs: number) => boolean;
  remove: (ripple?: boolean) => boolean;
  duplicate: () => boolean;
  addMarkerAt: (atUs: number) => boolean;
  toggleMute: (trackId: string) => boolean;
  placeMedia: (input: {
    mediaId: string;
    label: string;
    type: 'video' | 'audio' | 'image';
    durationUs: number;
    sourceDurationUs: number;
    startUs: number;
  }) => boolean;
  dismissNotes: () => void;
  copy: () => number;
  cut: () => boolean;
  paste: (atUs: number) => boolean;
  group: () => boolean;
  ungroup: () => boolean;
  clipboardSize: number;
  /** Unsaved edits found in the journal after a crash (SPEC 03 §5). */
  recovery: RecoveryInfo | null;
  recover: () => Promise<void>;
  dismissRecovery: () => void;
}

/**
 * One composition's editing session: the pure engine state plus its undo stack,
 * journal entries for crash recovery and a debounced autosave (SPEC 09 §24, §25).
 */
export function useTimeline(projectId: string, compId: string | undefined): TimelineApi {
  const [record, setRecord] = useState<CompositionRecord | null>(null);
  const [state, setState] = useState<TimelineState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [selection, setSelection] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null);
  const [clipboardSize, setClipboardSize] = useState(sessionClipboard.length);

  const historyRef = useRef<TimelineHistory | null>(null);
  const seqRef = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRecord = useRef<CompositionRecord | null>(null);

  const fps: Fps = (record?.payload.fps as Fps | undefined) ?? 30;

  useEffect(() => {
    if (!compId) return;
    if (!isDesktop()) {
      setLoadError('The editor runs inside the Clipwright desktop app.');
      return;
    }
    let cancelled = false;
    void api
      .getComposition(projectId, compId)
      .then((raw) => {
        if (cancelled) return;
        if (!raw) {
          setLoadError('That clip could not be found. It may have been deleted.');
          return;
        }
        const parsed = CompositionPayloadSchema.parse(raw.payload);
        const nextRecord = { ...raw, payload: parsed } as unknown as CompositionRecord;
        const history = new TimelineHistory(parsed);
        historyRef.current = history;
        pendingRecord.current = nextRecord;
        setRecord(nextRecord);
        setState(parsed);
        playheadStore.set(parsed.playheadUs ?? 0);
        setSelection([]);
      })
      .catch((err) => !cancelled && setLoadError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId, compId]);

  const loadComposition = useCallback(async () => {
    if (!compId) return null;
    const raw = await api.getComposition(projectId, compId);
    if (!raw) return null;
    const parsed = CompositionPayloadSchema.parse(raw.payload);
    const nextRecord = { ...raw, payload: parsed } as unknown as CompositionRecord;
    historyRef.current = new TimelineHistory(parsed);
    pendingRecord.current = nextRecord;
    setRecord(nextRecord);
    setState(parsed);
    playheadStore.set(parsed.playheadUs ?? 0);
    return parsed;
  }, [compId, projectId]);

  // A journal with unapplied entries means the last session ended abruptly.
  useEffect(() => {
    if (!compId || !isDesktop()) return;
    let cancelled = false;
    void api
      .checkRecovery(projectId)
      .then((result) => {
        if (cancelled) return;
        // Journal sequence numbers must keep climbing across sessions, or a
        // checkpoint would truncate entries it never wrote.
        for (const entry of result.entries as Array<{ seq?: number }>) {
          if (typeof entry.seq === 'number') seqRef.current = Math.max(seqRef.current, entry.seq);
        }
        if (result.needsRecovery && result.entries.length > 0) {
          setRecovery({ entries: result.entries.length });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [compId, projectId]);

  const recover = useCallback(async () => {
    try {
      await api.replayRecovery(projectId);
      await loadComposition();
      setSaveState('dirty');
      setRecovery(null);
      setNotes(['Unsaved edits were recovered from the journal.']);
    } catch (err) {
      setNotes([describeError(err)]);
    }
  }, [loadComposition, projectId]);

  /** Persist the latest state in one debounced transaction (SPEC 09 §25). */
  const flushSave = useCallback(async () => {
    const pending = pendingRecord.current;
    if (!pending) return;
    setSaveState('saving');
    try {
      await api.saveComposition(projectId, pending);
      // A checkpoint also truncates the journal, so a clean save leaves no
      // "unsaved edits" behind for the next session to replay (SPEC 03 §5.2).
      await api.checkpoint(projectId, [pending], seqRef.current).catch(() => undefined);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [projectId]);

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushSave();
    }, 2000);
  }, [flushSave]);

  // A closed window must not lose the last two seconds of work.
  useEffect(() => {
    const onHide = () => {
      if (pendingRecord.current) void api.saveComposition(projectId, pendingRecord.current);
    };
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [projectId]);

  const persist = useCallback(
    (next: TimelineState) => {
      pendingRecord.current = pendingRecord.current
        ? {
            ...pendingRecord.current,
            payload: next,
            version: (pendingRecord.current.version ?? 1) + 1,
            updatedAt: new Date().toISOString(),
          }
        : pendingRecord.current;
      scheduleSave();
    },
    [scheduleSave],
  );

  const run = useCallback(
    (label: string, command: (current: TimelineState) => CommandResult) => {
      const history = historyRef.current;
      if (!history) return false;
      const result = command(history.state);
      if (!result.ok) {
        setNotes([result.message]);
        return false;
      }
      history.commit(label, result);
      seqRef.current += 1;
      // Journal first: a crash between here and the autosave replays these patches.
      void api
        .appendJournal(projectId, {
          seq: seqRef.current,
          compId: history.state.id,
          ts: new Date().toISOString(),
          commandName: label,
          forwardPatch: result.patches,
          inversePatch: result.inverse,
        })
        .catch(() => undefined);

      const next = history.state;
      setState(next);
      setNotes(result.notes);
      persist(next);
      setHistoryTick((tick) => tick + 1);
      return true;
    },
    [persist, projectId],
  );

  const undo = useCallback(() => {
    const history = historyRef.current;
    if (!history) return;
    const result = history.undo();
    if (!result) return;
    setState(result.state);
    setSelection(result.step.affectedItemIds);
    persist(result.state);
    setHistoryTick((tick) => tick + 1);
  }, [persist]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    if (!history) return;
    const result = history.redo();
    if (!result) return;
    setState(result.state);
    setSelection(result.step.affectedItemIds);
    persist(result.state);
    setHistoryTick((tick) => tick + 1);
  }, [persist]);

  const select = useCallback((ids: string[], additive = false) => {
    setSelection((current) => {
      if (!additive) return ids;
      const next = new Set(current);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return [...next];
    });
  }, []);

  const clearSelection = useCallback(() => setSelection([]), []);

  const api_: TimelineApi = useMemo(
    () => ({
      state,
      fps,
      record,
      loadError,
      saveState,
      selection,
      notes,
      canUndo: Boolean(historyRef.current?.canUndo) && historyTick >= 0,
      canRedo: Boolean(historyRef.current?.canRedo) && historyTick >= 0,
      select,
      clearSelection,
      run,
      undo,
      redo,
      move: (moves, mode) => run(mode ? `Move (${mode})` : 'Move', (s) => moveItems(s, { moves, fps, mode })),
      trim: (itemId, edge, toUs, ripple) => run('Trim', (s) => trimItem(s, { itemId, edge, toUs, fps, ripple })),
      split: (atUs) => run('Split', (s) => splitItems(s, { itemIds: selection, atUs, fps })),
      splitAt: (itemIds, atUs) => run('Split', (s) => splitItems(s, { itemIds, atUs, fps })),
      remove: (ripple) => run(ripple ? 'Ripple delete' : 'Delete', (s) => deleteItems(s, { itemIds: selection, fps, ripple })),
      duplicate: () => run('Duplicate', (s) => duplicateItems(s, { itemIds: selection, fps })),
      addMarkerAt: (atUs) => run('Add marker', (s) => addMarker(s, { timeUs: atUs, fps })),
      toggleMute: (trackId) =>
        run('Mute track', (s) => setTrackMuted(s, { trackId, muted: !s.tracks.find((t) => t.id === trackId)?.muted })),
      placeMedia: (input) => {
        return run('Add clip', (s) => {
          const mainTrack = s.tracks.find((track) => track.role === 'main');
          if (!mainTrack) return { ok: false, code: 'not_found', message: 'No main track.' };
          const item = createMediaItem({
            trackId: mainTrack.id,
            label: input.label,
            mediaId: input.mediaId,
            type: input.type,
            startUs: input.startUs,
            durationUs: Math.min(input.durationUs, input.sourceDurationUs),
            sourceDurationUs: input.sourceDurationUs,
          });
          return addItem(s, { fps, trackId: mainTrack.id, startUs: input.startUs, item });
        });
      },
      dismissNotes: () => setNotes([]),
      copy: () => {
        if (!state) return 0;
        sessionClipboard = selection
          .map((id) => state.items[id])
          .filter((item): item is TimelineItem => Boolean(item))
          .map((item) => ({ item, trackId: item.trackId }));
        setClipboardSize(sessionClipboard.length);
        setNotes(
          sessionClipboard.length
            ? [`Copied ${sessionClipboard.length} clip${sessionClipboard.length === 1 ? '' : 's'}.`]
            : ['Nothing selected to copy.'],
        );
        return sessionClipboard.length;
      },
      cut: () => {
        if (!state || selection.length === 0) return false;
        sessionClipboard = selection
          .map((id) => state.items[id])
          .filter((item): item is TimelineItem => Boolean(item))
          .map((item) => ({ item, trackId: item.trackId }));
        setClipboardSize(sessionClipboard.length);
        return run('Cut', (s) => deleteItems(s, { itemIds: selection, fps }));
      },
      paste: (atUs) => {
        if (!sessionClipboard.length) {
          setNotes(['The clipboard is empty.']);
          return false;
        }
        const pasted = run('Paste', (s) =>
          pasteItems(s, { items: sessionClipboard, atUs, fps }),
        );
        return pasted;
      },
      group: () => run('Group', (s) => groupItems(s, { itemIds: selection })),
      ungroup: () => {
        const groupId = state?.items[selection[0] ?? '']?.groupId;
        if (!groupId) {
          setNotes(['Those clips are not grouped.']);
          return false;
        }
        return run('Ungroup', (s) => ungroupItems(s, { groupId }));
      },
      clipboardSize,
      recovery,
      recover,
      dismissRecovery: () => setRecovery(null),
    }),
    [
      state,
      fps,
      record,
      loadError,
      saveState,
      selection,
      notes,
      historyTick,
      select,
      clearSelection,
      run,
      undo,
      redo,
      recovery,
      recover,
      clipboardSize,
    ],
  );

  return api_;
}
