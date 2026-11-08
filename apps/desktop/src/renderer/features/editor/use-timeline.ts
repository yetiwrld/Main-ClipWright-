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
  setTrackMagnetic,
  splitItems,
  trimItem,
  trimItems,
  moveItemsToTrack,
  rollAt,
  detachAudio,
  unlink,
  addTransition,
  updateTransition,
  removeTransition,
  setWorkArea,
  clearWorkArea,
  addKeyframe,
  removeKeyframe,
  updateKeyframe,
  moveKeyframe,
  duplicateKeyframe,
  splitCaptionSegment,
  mergeCaptionSegments,
  trimCaptionSegment,
  setItemProperties,
  editCaptionText,
  retimeCaption,
  trimCaptionWordsToRange,
  applyCaptionStyle,
  setWordEmphasis,
  regenerateCaptions,
  syncCaptionsWithTranscript,
  applyEffect,
  removeEffect,
  toggleEffectEnabled,
  updateEffectParams,
  updateMarker,
  deleteMarker,
  setViewState,
  renameTrack,
  toggleItemDisabled,
  addTrack,
  toggleTrackLock,
  toggleTrackHidden,
  deleteTrack,
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
  roll: (leftItemId: string, rightItemId: string, atUs: number) => boolean;
  split: (atUs: number) => boolean;
  splitAt: (itemIds: string[], atUs: number) => boolean;
  /** Trim the selection's start/end edge to the playhead (SPEC 09 §12 Q/W). */
  trimToPlayhead: (edge: 'start' | 'end', atUs: number, ripple: boolean) => boolean;
  /** Move the selection to the adjacent track (SPEC 09 §12 Alt+Up/Down). */
  moveSelectionToTrack: (direction: 'up' | 'down') => boolean;
  remove: (ripple: boolean, rippleAll?: boolean) => boolean;
  duplicate: () => boolean;
  addMarkerAt: (atUs: number) => boolean;
  toggleMute: (trackId: string) => boolean;
  toggleMagnetic: (trackId: string) => boolean;
  detachAudio: (itemId: string) => boolean;
  unlink: (itemId: string) => boolean;
  toggleDisabled: (itemId: string) => boolean;
  addTransition: (trackId: string, leftItemId: string, rightItemId: string, type: 'crossfade' | 'dissolve' | 'fade-black' | 'dip-color' | 'wipe' | 'slide' | 'zoom', durationUs?: number, alignment?: 'center' | 'start' | 'end') => boolean;
  updateTransition: (itemId: string, patch: { durationUs?: number; alignment?: 'center' | 'start' | 'end'; type?: 'crossfade' | 'dissolve' | 'fade-black' | 'dip-color' | 'wipe' | 'slide' | 'zoom' }) => boolean;
  removeTransition: (itemId: string) => boolean;
  setWorkArea: (edge: 'in' | 'out', timeUs: number) => boolean;
  clearWorkArea: () => boolean;
  addKeyframe: (itemId: string, property: string, timeUs: number, value: number | [number, number, number, number]) => boolean;
  removeKeyframe: (itemId: string, property: string, timeUs: number) => boolean;
  updateKeyframe: (itemId: string, property: string, timeUs: number, patch: { value?: number | [number, number, number, number]; interpolation?: 'linear' | 'hold' | 'bezier' | 'preset'; easing?: { preset: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'easeInCubic' | 'easeOutCubic' | 'easeInOutCubic' | 'easeInBack' | 'easeOutBack' | 'easeOutBounce' | 'easeOutElastic' } }) => boolean;
  moveKeyframe: (itemId: string, property: string, fromTimeUs: number, toTimeUs: number) => boolean;
  duplicateKeyframe: (itemId: string, property: string, fromTimeUs: number, toTimeUs: number) => boolean;
  splitCaptionSegment: (itemId: string, timeUs: number) => boolean;
  mergeCaptionSegments: (leftItemId: string, rightItemId: string) => boolean;
  trimCaptionSegment: (itemId: string, edge: 'start' | 'end', timeUs: number) => boolean;
  /** Edit opacity, level, pan, speed, fades, crop or transform (SPEC 09 §17). */
  setItemProperties: (
    itemIds: string[],
    patch: Parameters<typeof setItemProperties>[1]['patch'],
  ) => boolean;
  editCaptionText: (itemId: string, text: string, maxCharsPerLine?: number, maxLines?: number) => boolean;
  retimeCaption: (itemId: string, startUs?: number, endUs?: number) => boolean;
  trimCaptionWordsToRange: (itemId: string) => boolean;
  applyCaptionStyle: (itemIds: string[], styleId: string, keepOverrides?: boolean) => boolean;
  setWordEmphasis: (itemId: string, wordIndex: number, emphasis: boolean, color?: string, scale?: number) => boolean;
  applyEffect: (itemId: string, effectId: string, params?: Record<string, number | boolean | string>) => boolean;
  removeEffect: (itemId: string, effectId: string) => boolean;
  toggleEffectEnabled: (itemId: string, effectId: string) => boolean;
  setEffectParams: (itemId: string, effectId: string, params: Record<string, number | boolean | string>) => boolean;
  updateEffectParams: (itemId: string, effectId: string, params: Record<string, number | boolean | string>) => boolean;
  updateMarker: (markerId: string, patch: { name?: string; note?: string; color?: string }) => boolean;
  deleteMarker: (markerId: string) => boolean;
  setViewState: (patch: { pxPerSecond?: number; scrollX?: number; scrollY?: number; headerWidthPx?: number }) => boolean;
  renameTrack: (trackId: string, name: string) => boolean;
  addTrack: (kind: 'video' | 'audio' | 'text' | 'caption', aboveTrackId?: string) => boolean;
  toggleTrackLock: (trackId: string) => boolean;
  toggleTrackHidden: (trackId: string) => boolean;
  deleteTrack: (trackId: string) => boolean;
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
      roll: (leftItemId, rightItemId, atUs) =>
        run('Rolling edit', (s) => rollAt(s, { leftItemId, rightItemId, atUs, fps })),
      split: (atUs) => run('Split', (s) => splitItems(s, { itemIds: selection, atUs, fps })),
      splitAt: (itemIds, atUs) => run('Split', (s) => splitItems(s, { itemIds, atUs, fps })),
      trimToPlayhead: (edge, atUs, ripple) =>
        run(`Trim ${edge} to playhead`, (s) =>
          trimItems(s, { itemIds: selection, edge, toUs: atUs, fps, ripple }),
        ),
      moveSelectionToTrack: (direction) =>
        run('Move track', (s) => moveItemsToTrack(s, { itemIds: selection, direction, fps })),
      remove: (ripple, rippleAll) =>
        run(ripple ? 'Ripple delete' : 'Delete', (s) =>
          deleteItems(s, { itemIds: selection, fps, ripple, rippleAll }),
        ),
      duplicate: () => run('Duplicate', (s) => duplicateItems(s, { itemIds: selection, fps })),
      addMarkerAt: (atUs) => run('Add marker', (s) => addMarker(s, { timeUs: atUs, fps })),
      toggleMute: (trackId) =>
        run('Mute track', (s) => setTrackMuted(s, { trackId, muted: !s.tracks.find((t) => t.id === trackId)?.muted })),
      toggleMagnetic: (trackId) =>
        run('Toggle magnetic', (s) =>
          setTrackMagnetic(s, {
            trackId,
            magnetic: !s.tracks.find((t) => t.id === trackId)?.magnetic,
          }),
        ),
      detachAudio: (itemId) => run('Detach audio', (s) => detachAudio(s, { videoItemId: itemId, fps })),
      unlink: (itemId) => run('Unlink', (s) => unlink(s, { itemId })),
      toggleDisabled: (itemId) => run('Toggle disabled', (s) => toggleItemDisabled(s, { itemId })),
      addTransition: (trackId: string, leftItemId: string, rightItemId: string, type: 'crossfade' | 'dissolve' | 'fade-black' | 'dip-color' | 'wipe' | 'slide' | 'zoom', durationUs?: number, alignment?: 'center' | 'start' | 'end') =>
        run('Add transition', (s) => addTransition(s, { trackId, leftItemId, rightItemId, type, durationUs, alignment, fps })),
      updateTransition: (itemId: string, patch: { durationUs?: number; alignment?: 'center' | 'start' | 'end'; type?: 'crossfade' | 'dissolve' | 'fade-black' | 'dip-color' | 'wipe' | 'slide' | 'zoom' }) =>
        run('Update transition', (s) => updateTransition(s, { itemId, patch, fps })),
      removeTransition: (itemId: string) =>
        run('Remove transition', (s) => removeTransition(s, { itemId })),
      setWorkArea: (edge, timeUs) =>
        run('Set work area', (s) => setWorkArea(s, { edge, timeUs, fps })),
      clearWorkArea: () =>
        run('Clear work area', (s) => clearWorkArea(s)),
      addKeyframe: (itemId, property, timeUs, value) =>
        run('Add keyframe', (s) => addKeyframe(s, { itemId, property, timeUs, value, fps })),
      removeKeyframe: (itemId, property, timeUs) =>
        run('Remove keyframe', (s) => removeKeyframe(s, { itemId, property, timeUs, fps })),
      updateKeyframe: (itemId, property, timeUs, patch) =>
        run('Update keyframe', (s) => updateKeyframe(s, { itemId, property, timeUs, patch, fps })),
      moveKeyframe: (itemId, property, fromTimeUs, toTimeUs) =>
        run('Move keyframe', (s) => moveKeyframe(s, { itemId, property, fromTimeUs, toTimeUs, fps })),
      duplicateKeyframe: (itemId, property, fromTimeUs, toTimeUs) =>
        run('Duplicate keyframe', (s) => duplicateKeyframe(s, { itemId, property, fromTimeUs, toTimeUs, fps })),
      splitCaptionSegment: (itemId, timeUs) =>
        run('Split caption', (s) => splitCaptionSegment(s, { itemId, timeUs, fps })),
      mergeCaptionSegments: (leftItemId, rightItemId) =>
        run('Merge captions', (s) => mergeCaptionSegments(s, { leftItemId, rightItemId, fps })),
      trimCaptionSegment: (itemId, edge, timeUs) =>
        run('Trim caption', (s) => trimCaptionSegment(s, { itemId, edge, timeUs, fps })),
      setItemProperties: (itemIds, patch) =>
        run('Edit clip properties', (s) => setItemProperties(s, { itemIds, patch, fps })),
      editCaptionText: (itemId, text, maxCharsPerLine, maxLines) =>
        run('Edit caption', (s) =>
          editCaptionText(s, { itemId, text, maxCharsPerLine, maxLines }),
        ),
      retimeCaption: (itemId, startUs, endUs) =>
        run('Retime caption', (s) => retimeCaption(s, { itemId, startUs, endUs, fps })),
      trimCaptionWordsToRange: (itemId) =>
        run('Trim caption words', (s) => trimCaptionWordsToRange(s, { itemId })),
      applyCaptionStyle: (itemIds, styleId, keepOverrides) =>
        run('Apply caption style', (s) =>
          applyCaptionStyle(s, { itemIds, styleId, keepOverrides }),
        ),
      setWordEmphasis: (itemId, wordIndex, emphasis, color, scale) =>
        run(emphasis ? 'Emphasise word' : 'Remove emphasis', (s) =>
          setWordEmphasis(s, { itemId, wordIndex, emphasis, color, scale }),
        ),
      applyEffect: (itemId, effectId, params) =>
        run('Apply effect', (s) => applyEffect(s, { itemId, effectId, params })),
      removeEffect: (itemId, effectId) =>
        run('Remove effect', (s) => removeEffect(s, { itemId, effectId })),
      toggleEffectEnabled: (itemId, effectId) =>
        run('Toggle effect', (s) => toggleEffectEnabled(s, { itemId, effectId })),
      setEffectParams: (itemId, effectId, params) =>
        run('Change effect', (s) => updateEffectParams(s, { itemId, effectId, params })),
      updateEffectParams: (itemId, effectId, params) =>
        run('Update effect params', (s) => updateEffectParams(s, { itemId, effectId, params })),
      updateMarker: (markerId, patch) =>
        run('Update marker', (s) => updateMarker(s, { markerId, patch })),
      deleteMarker: (markerId) =>
        run('Delete marker', (s) => deleteMarker(s, { markerId })),
      setViewState: (patch) =>
        run('Set view state', (s) => setViewState(s, patch)),
      renameTrack: (trackId, name) =>
        run('Rename track', (s) => renameTrack(s, { trackId, name })),
      addTrack: (kind, aboveTrackId) => run('Add track', (s) => addTrack(s, { kind, aboveTrackId })),
      toggleTrackLock: (trackId) => run('Toggle lock', (s) => toggleTrackLock(s, { trackId })),
      toggleTrackHidden: (trackId) => run('Toggle hide', (s) => toggleTrackHidden(s, { trackId })),
      deleteTrack: (trackId) => run('Delete track', (s) => deleteTrack(s, { trackId })),
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
