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
  nextId,
  projectDurationUs,
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
  setKeyframesAt,
  removeKeyframe,
  updateKeyframe,
  setBezierHandles,
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
  moveEffect,
  setEffectChain,
  updateMarker,
  deleteMarker,
  setViewState,
  setToggles,
  renameTrack,
  toggleItemDisabled,
  addTrack,
  addAdjustmentLayer,
  addShapeItem,
  addTextItem,
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

/**
 * The effect clipboard — separate from the clip clipboard on purpose (SPEC 09 §12).
 *
 * "Copy effects" and "copy clips" are different intents: one duplicates a clip,
 * the other transfers a grade onto a clip that is already framed. Sharing a buffer
 * would make the paste command ambiguous.
 */
let sessionEffectClipboard: Array<{
  effectId: string;
  enabled?: boolean;
  params?: Record<string, number | boolean | string>;
}> = [];

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
  /**
   * Runs a command as one undo step.
   *
   * A command may return `null` to say it decided there was nothing to do — that is not a
   * failure and must not push an undo step or light up the notes, which is why it is a
   * separate answer from a `CommandResult` whose `ok` is false.
   */
  run: (label: string, command: (state: TimelineState) => CommandResult | null) => boolean;
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
  updateTransition: (
    itemId: string,
    patch: {
      durationUs?: number;
      alignment?: 'center' | 'start' | 'end';
      type?: 'crossfade' | 'dissolve' | 'fade-black' | 'dip-color' | 'wipe' | 'slide' | 'zoom';
      /**
       * Type-specific parameters (SPEC 12 §4.2). Merged, so setting a wipe's
       * direction keeps its softness. Only sent when a control is actually used,
       * which is what lets the engine skip the parameter work entirely otherwise.
       */
      params?: Record<string, number | boolean | string | undefined>;
    },
  ) => boolean;
  removeTransition: (itemId: string) => boolean;
  setWorkArea: (edge: 'in' | 'out', timeUs: number) => boolean;
  clearWorkArea: () => boolean;
  addKeyframe: (itemId: string, property: string, timeUs: number, value: number | [number, number, number, number]) => boolean;
  /**
   * Write several properties at one instant as **one** undo step (SPEC 10 §8.6).
   *
   * The reframe gesture needs this: a framing is a position and a scale, and four separate
   * `addKeyframe` calls would leave four entries in the undo stack for one drag, so `Ctrl+Z`
   * after framing a shot would undo a quarter of the framing.
   */
  setKeyframesAt: (itemId: string, timeUs: number, values: Readonly<Record<string, number>>) => boolean;
  removeKeyframe: (itemId: string, property: string, timeUs: number) => boolean;
  updateKeyframe: (itemId: string, property: string, timeUs: number, patch: { value?: number | [number, number, number, number]; interpolation?: 'linear' | 'hold' | 'bezier' | 'preset'; easing?: { preset: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'easeInCubic' | 'easeOutCubic' | 'easeInOutCubic' | 'easeInBack' | 'easeOutBack' | 'easeOutBounce' | 'easeOutElastic' } }) => boolean;
  /**
   * Set a keyframe's bezier control handles, making its outgoing segment a bezier
   * (SPEC 12 §2.6). `outX`/`inX` are clamped to 0–1 by the command; `outY`/`inY`
   * may overshoot, which is what makes ease-back curves expressible.
   */
  setBezierHandles: (
    itemId: string,
    property: string,
    timeUs: number,
    bezier: { outX: number; outY: number; inX: number; inY: number },
  ) => boolean;
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
  moveEffect: (itemId: string, effectId: string, toIndex: number) => boolean;
  /** Replace a clip's whole effect chain, for paste. */
  setEffectChain: (itemId: string, chain: Array<{ effectId: string; enabled?: boolean; params?: Record<string, number | boolean | string> }>) => boolean;
  /** Copy a clip's effect chain, or paste the copied one onto a clip. */
  copyEffects: (itemId: string) => number;
  pasteEffects: (itemId: string) => boolean;
  /** How many effects are on the effect clipboard, for enabling the paste control. */
  effectClipboardSize: number;
  updateEffectParams: (itemId: string, effectId: string, params: Record<string, number | boolean | string>) => boolean;
  updateMarker: (markerId: string, patch: { name?: string; note?: string; color?: string }) => boolean;
  deleteMarker: (markerId: string) => boolean;
  setViewState: (patch: { pxPerSecond?: number; scrollX?: number; scrollY?: number; headerWidthPx?: number }) => boolean;
  renameTrack: (trackId: string, name: string) => boolean;
  addTrack: (kind: 'video' | 'audio' | 'text' | 'caption', aboveTrackId?: string) => boolean;
  /**
   * Add an adjustment layer over the picture tracks (SPEC 12 §3.1). The layer
   * spans the whole visible range so the user can see it grade something
   * immediately, and can be trimmed or moved like any other item afterwards.
   */
  addAdjustmentLayer: () => boolean;
  /** Add a text item at the playhead (SPEC 11 §7). */
  addText: (text: string) => boolean;
  /** Add a shape at the playhead (SPEC 11 §12). */
  addShape: (kind: NonNullable<TimelineItem['shapeKind']>) => boolean;
  /** Toggle one editing flag on the composition (SPEC 09 §9.6). */
  setToggle: (patch: Partial<NonNullable<TimelineState['toggles']>>) => boolean;
  /** Whether linked items travel together; defaults to on, as the schema does. */
  linkedSelection: boolean;
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
  const [effectClipboardSize, setEffectClipboardSize] = useState(sessionEffectClipboard.length);

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
    (label: string, command: (current: TimelineState) => CommandResult | null) => {
      const history = historyRef.current;
      if (!history) return false;
      const result = command(history.state);
      // `null` is the command's own no-op: nothing changed, so nothing to undo.
      if (!result) return false;
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
      updateTransition: (itemId, patch) =>
        run('Update transition', (s) => updateTransition(s, { itemId, patch, fps })),
      removeTransition: (itemId: string) =>
        run('Remove transition', (s) => removeTransition(s, { itemId })),
      setWorkArea: (edge, timeUs) =>
        run('Set work area', (s) => setWorkArea(s, { edge, timeUs, fps })),
      clearWorkArea: () =>
        run('Clear work area', (s) => clearWorkArea(s)),
      addKeyframe: (itemId, property, timeUs, value) =>
        run('Add keyframe', (s) => addKeyframe(s, { itemId, property, timeUs, value, fps })),
      setKeyframesAt: (itemId, timeUs, values) =>
        run('Set framing', (s) => setKeyframesAt(s, { itemId, timeUs, values, fps })),
      removeKeyframe: (itemId, property, timeUs) =>
        run('Remove keyframe', (s) => removeKeyframe(s, { itemId, property, timeUs, fps })),
      updateKeyframe: (itemId, property, timeUs, patch) =>
        run('Update keyframe', (s) => updateKeyframe(s, { itemId, property, timeUs, patch, fps })),
      setBezierHandles: (itemId, property, timeUs, bezier) =>
        run('Adjust curve', (s) =>
          setBezierHandles(s, { itemId, property, timeUs, bezier, fps }),
        ),
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
      moveEffect: (itemId, effectId, toIndex) =>
        run('Reorder effect', (s) => moveEffect(s, { itemId, effectId, toIndex })),
      setEffectChain: (itemId, chain) =>
        run('Paste effects', (s) => setEffectChain(s, { itemId, chain })),
      copyEffects: (itemId) => {
        const item = state?.items[itemId];
        if (!item) return 0;
        // Copied by value, and without the instance ids: the ids address effects
        // on *that* clip, so carrying them across would make the pasted chain a
        // duplicate rather than an equivalent.
        sessionEffectClipboard = (item.effects ?? []).map((effect) => ({
          effectId: effect.effectId,
          enabled: effect.enabled,
          params: { ...effect.params },
        }));
        setEffectClipboardSize(sessionEffectClipboard.length);
        setNotes([
          sessionEffectClipboard.length === 0
            ? 'That clip has no effects to copy.'
            : 'Effects copied.',
        ]);
        return sessionEffectClipboard.length;
      },
      pasteEffects: (itemId) => {
        if (sessionEffectClipboard.length === 0) {
          setNotes(['No effects have been copied.']);
          return false;
        }
        return run('Paste effects', (s) =>
          setEffectChain(s, { itemId, chain: sessionEffectClipboard }),
        );
      },
      effectClipboardSize,
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
      addAdjustmentLayer: () =>
        run('Add adjustment layer', (s) => {
          // The layer has to cover something to be useful, so it spans the project.
          // A zero-length timeline would make the command fail with `too_short`,
          // which is the honest answer — there is nothing to grade yet.
          const durationUs = Math.max(projectDurationUs(s), Math.round(1_000_000 / fps));
          return addAdjustmentLayer(s, {
            id: nextId('adj'),
            startUs: 0,
            durationUs,
            fps,
          });
        }),
      /*
        A title is added at the playhead rather than at zero: the user is looking at a
        moment and wants text on it, and dropping every title at the start would make
        them drag it to where they already were.
      */
      addText: (text) => {
        const id = nextId('txt');
        return run('Add text', (s) =>
          addTextItem(s, { id, text, startUs: playheadStore.get(), fps })
        );
      },
      addShape: (kind) => {
        const id = nextId('shp');
        return run('Add shape', (s) =>
          addShapeItem(s, { id, shapeKind: kind, startUs: playheadStore.get(), fps })
        );
      },
      /*
        The linked-selection flag is document state, so it is written through a command
        rather than held in component state: it is saved with the project and undoes like
        everything else. Reading it from the document is what makes the toolbar show the
        project's real value rather than a guess that resets on reload.
      */
      setToggle: (patch) => run('Change setting', (s) => setToggles(s, { patch })),
      linkedSelection: state?.toggles?.linkedSelection !== false,
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
