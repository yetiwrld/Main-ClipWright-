import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardCopy,
  ClipboardPaste,
  ChevronDown,
  ChevronUp,
  Diamond,
  Copy,
  Flag,
  Lock,
  Magnet,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Scissors,
  Shuffle,
  Trash2,
  Users,
  Eye,
  EyeOff,
  Unlink,
  Power,
  Folder,
  Settings,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  Button,
  ContextMenu,
  IconButton,
  type MenuItem,
  SegmentedControl,
  Slider,
  TimecodeField,
} from '@clipwright/design-system';
import {
  contentDurationUs,
  frameDurationUs,
  formatTimecode,
  itemEndUs,
  parseTimecode,
  projectDurationUs,
  quantizeUs,
  snapPoints,
  snapUs,
  tracksInDrawOrder,
  type EditMode,
  type TimelineState,
} from '@clipwright/timeline-engine';
import type { TimelineApi } from './use-timeline.js';
import { playheadStore, usePlayheadUs } from './playhead-store.js';

const HEADER_WIDTH = 184;
const MIN_PX_PER_SECOND = 0.25;
const MAX_PX_PER_SECOND = 960;

type DragState =
  | { kind: 'scrub' }
  | { kind: 'move'; itemId: string; startUs: number; pointerStartUs: number }
  | { kind: 'trim'; itemId: string; edge: 'start' | 'end' }
  | { kind: 'roll'; leftItemId: string; rightItemId: string }
  | null;

export function TimelinePanel({ timeline }: { timeline: TimelineApi }) {
  const { state, fps, selection } = timeline;

  const [pxPerSecond, setPxPerSecond] = useState(state?.viewState?.pxPerSecond ?? 80);
  const [scrollX, setScrollX] = useState(state?.viewState?.scrollX ?? 0);
  const [snapping, setSnapping] = useState(true);
  const [rippleAllTracks, setRippleAllTracks] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>('normal');
  const [tool, setTool] = useState<'select' | 'razor'>('select');
  const [showKeyframes, setShowKeyframes] = useState(false);
  const [marquee, setMarquee] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    additive: boolean;
  } | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [dragPreview, setDragPreview] = useState<{ itemId: string; startUs: number } | null>(null);
  // Trim is previewed locally and committed once on release (one undo step).
  const [trimPreview, setTrimPreview] = useState<{
    itemId: string;
    edge: 'start' | 'end';
    us: number;
  } | null>(null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  // Rolling edit preview: the junction position under the pointer.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    type: 'clip' | 'track' | 'empty' | 'ruler' | 'marker';
    targetId?: string;
  } | null>(null);
  const [rollPreview, setRollPreview] = useState<{
    leftItemId: string;
    rightItemId: string;
    us: number;
  } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const pxPerSecondRef = useRef(pxPerSecond);
  pxPerSecondRef.current = pxPerSecond;

  const durationUs = state ? projectDurationUs(state) : 1_000_000;
  const pxPerUs = pxPerSecond / 1_000_000;

  const usToX = useCallback((us: number) => us * pxPerSecondRef.current / 1_000_000, []);
  const xToUs = useCallback((x: number) => (x / pxPerSecondRef.current) * 1_000_000, []);

  const points = useMemo(() => (state ? snapPoints(state, 0) : [0]), [state]);

  const applySnap = useCallback(
    (us: number, bypass: boolean) => {
      if (!snapping || bypass) return { us: quantizeUs(us, fps), snappedTo: null };
      return snapUs(us, [...points, playheadStore.get()], pxPerSecondRef.current, fps);
    },
    [fps, points, snapping],
  );

  /* ------------------------------------------------------------ zoom + scroll */

  const clampScroll = useCallback(
    (value: number) => Math.max(0, value),
    [],
  );

  const zoomBy = useCallback(
    (factor: number, anchorX?: number) => {
      const current = pxPerSecondRef.current;
      const next = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, current * factor));
      if (next === current) return;
      const anchor = anchorX ?? 0;
      // Keep the time under the anchor pinned while the scale changes.
      const timeAtAnchor = (scrollX + anchor) / current;
      setPxPerSecond(next);
      setScrollX(clampScroll(timeAtAnchor * next - anchor));
    },
    [clampScroll, scrollX],
  );

  const fitProject = useCallback(() => {
    const width = canvasRef.current?.clientWidth ?? 900;
    const usable = Math.max(120, width - 24);
    const seconds = Math.max(1, (state ? contentDurationUs(state) : 0) / 1_000_000);
    setPxPerSecond(Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, usable / seconds)));
    setScrollX(0);
  }, [state]);

  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = node.getBoundingClientRect();
        zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left);
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        setScrollX((value) => clampScroll(value + event.deltaY));
      } else {
        setScrollX((value) => clampScroll(value + event.deltaX + event.deltaY));
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [clampScroll, zoomBy]);

  /* ------------------------------------------------------------------ ruler */

  useEffect(() => {
    const canvas = rulerRef.current;
    if (!canvas || !state) return;
    const width = canvas.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(28 * dpr);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, 28);

    const styles = getComputedStyle(document.documentElement);
    const lineColour = styles.getPropertyValue('--line-default').trim() || 'currentColor';
    const labelColour = styles.getPropertyValue('--text-muted').trim() || 'currentColor';
    const brand = styles.getPropertyValue('--brand').trim() || 'currentColor';

    const candidates = [
      1 / fps,
      2 / fps,
      5 / fps,
      10 / fps,
      0.5,
      1,
      2,
      5,
      10,
      15,
      30,
      60,
      120,
      300,
      600,
      1800,
      3600,
    ];
    const major = candidates.find((seconds) => seconds * pxPerSecondRef.current >= 80) ?? 3600;
    const minorCount = [0.5, 1, 2, 15, 30, 60, 120, 300, 600, 1800, 3600].includes(major) ? 4 : 5;
    const minor = major / minorCount;

    context.strokeStyle = lineColour;
    context.fillStyle = labelColour;
    context.font = 'var(--fs-xs)';
    context.textBaseline = 'top';

    const startUs = (scrollX / pxPerSecondRef.current) * 1_000_000;
    const endUs = ((scrollX + width) / pxPerSecondRef.current) * 1_000_000;
    const firstMinor = Math.floor(startUs / (minor * 1_000_000)) * minor * 1_000_000;

    for (let us = firstMinor; us <= endUs; us += minor * 1_000_000) {
      const x = usToX(us) - scrollX;
      const isMajor = Math.abs((us / 1_000_000) % major) < 1e-6;
      context.globalAlpha = isMajor ? 1 : 0.45;
      context.beginPath();
      context.moveTo(x, isMajor ? 8 : 18);
      context.lineTo(x, 28);
      context.stroke();
      if (isMajor) {
        context.globalAlpha = 1;
        const seconds = us / 1_000_000;
        const label =
          major < 1
            ? `${String(Math.floor(seconds)).padStart(2, '0')}:${String(Math.round((seconds % 1) * fps)).padStart(2, '0')}`
            : major < 60
              ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
              : `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
        context.fillText(label, x + 4, 2);
      }
    }

    // Work area band (SPEC 09 §18).
    if (state.workArea) {
      const inX = usToX(state.workArea.inUs) - scrollX;
      const outX = usToX(state.workArea.outUs) - scrollX;
      context.fillStyle = 'rgba(0, 122, 255, 0.12)';
      context.fillRect(Math.max(0, inX), 0, Math.max(0, outX - inX), 28);
    }

    // Markers as small flags on the ruler.
    context.fillStyle = brand;
    for (const marker of state.markers) {
      const x = usToX(marker.timeUs) - scrollX;
      if (x < -4 || x > width + 4) continue;
      context.fillRect(x - 3, 0, 6, 6);
    }
    context.globalAlpha = 1;
  }, [state, fps, pxPerSecond, scrollX, usToX]);

  /* ------------------------------------------------------------- pointer drag */

  const timeAtPointer = useCallback(
    (clientX: number) => {
      const node = canvasRef.current;
      if (!node) return 0;
      const rect = node.getBoundingClientRect();
      return Math.max(0, xToUs(clientX - rect.left + scrollX));
    },
    [scrollX, xToUs],
  );

  const endDrag = useCallback(() => {
    setDrag(null);
    setDragPreview(null);
    setTrimPreview(null);
    setRollPreview(null);
    setSnapGuide(null);
    setMenu(null);
  }, []);

  useEffect(() => {
    if (!marquee) return;
    const onMove = (event: PointerEvent) => {
      const node = canvasRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setMarquee((current) =>
        current
          ? {
              ...current,
              x2: event.clientX - rect.left + scrollX,
              y2: event.clientY - rect.top,
            }
          : current,
      );
    };
    const onUp = () => {
      if (state && marquee) {
        const left = Math.min(marquee.x1, marquee.x2);
        const right = Math.max(marquee.x1, marquee.x2);
        const top = Math.min(marquee.y1, marquee.y2);
        const bottom = Math.max(marquee.y1, marquee.y2);
        let rowTop = 0;
        const hits: string[] = [];
        for (const track of tracksInDrawOrder(state)) {
          const rowBottom = rowTop + track.heightPx;
          const rowHit = bottom >= rowTop && top <= rowBottom;
          rowTop = rowBottom;
          if (!rowHit || track.locked || track.hidden) continue;
          for (const id of track.itemIds) {
            const item = state.items[id];
            if (!item) continue;
            const itemLeft = usToX(item.startUs) - scrollX;
            const itemRight = itemLeft + usToX(item.durationUs);
            if (itemRight >= left && itemLeft <= right) hits.push(id);
          }
        }
        timeline.select(hits, marquee.additive);
      }
      setMarquee(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [marquee, scrollX, state, timeline, usToX]);

  useEffect(() => {
    if (!drag) return;

    const onMove = (event: PointerEvent) => {
      const raw = timeAtPointer(event.clientX);
      const snapped = applySnap(raw, event.altKey);
      setSnapGuide(snapped.snappedTo);

      if (drag.kind === 'scrub') {
        playheadStore.set(snapped.us);
        return;
      }
      if (drag.kind === 'move') {
        const deltaUs = raw - drag.pointerStartUs;
        const target = applySnap(drag.startUs + deltaUs, event.altKey);
        setDragPreview({ itemId: drag.itemId, startUs: Math.max(0, target.us) });
        setSnapGuide(target.snappedTo);
        return;
      }
      if (drag.kind === 'trim') {
        setTrimPreview({ itemId: drag.itemId, edge: drag.edge, us: snapped.us });
      }
      if (drag.kind === 'roll') {
        setRollPreview({ leftItemId: drag.leftItemId, rightItemId: drag.rightItemId, us: snapped.us });
      }
    };

    const onUp = (event: PointerEvent) => {
      if (drag.kind === 'move' && dragPreview) {
        timeline.move([{ itemId: drag.itemId, startUs: dragPreview.startUs }], editMode);
      }
      if (drag.kind === 'trim' && trimPreview) {
        timeline.trim(drag.itemId, drag.edge, trimPreview.us, event.shiftKey);
      }
      if (drag.kind === 'roll' && rollPreview) {
        timeline.roll(rollPreview.leftItemId, rollPreview.rightItemId, rollPreview.us);
      }
      endDrag();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [applySnap, drag, dragPreview, editMode, endDrag, rollPreview, timeAtPointer, timeline, trimPreview]);

  /** Drag on empty timeline area selects every clip the rectangle touches. */
  const beginMarquee = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMarquee({
      x1: event.clientX - rect.left + scrollX,
      y1: event.clientY - rect.top,
      x2: event.clientX - rect.left + scrollX,
      y2: event.clientY - rect.top,
      additive: event.shiftKey,
    });
  };

  const beginScrub = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const snapped = applySnap(timeAtPointer(event.clientX), event.altKey);
    playheadStore.set(snapped.us);
    setDrag({ kind: 'scrub' });
  };

  /* --------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      const meta = event.ctrlKey || event.metaKey;
      const current = playheadStore.get();
      const frame = 1_000_000 / fps;
      const duration = state ? projectDurationUs(state) : 0;

      if (event.code === 'Space') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('clipwright:toggle-play'));
        return;
      }
      if (meta && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        timeline.undo();
        return;
      }
      if ((meta && event.key.toLowerCase() === 'y') || (meta && event.shiftKey && event.key.toLowerCase() === 'z')) {
        event.preventDefault();
        timeline.redo();
        return;
      }
      if (event.key.toLowerCase() === 's' && !meta) {
        event.preventDefault();
        timeline.split(current);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        timeline.remove(event.shiftKey, rippleAllTracks);
        return;
      }
      if (event.key === 'q' || event.key === 'Q') {
        event.preventDefault();
        timeline.trimToPlayhead('start', current, event.shiftKey);
        return;
      }
      if (event.key === 'w' || event.key === 'W') {
        event.preventDefault();
        timeline.trimToPlayhead('end', current, event.shiftKey);
        return;
      }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        timeline.moveSelectionToTrack(event.key === 'ArrowUp' ? 'up' : 'down');
        return;
      }
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        timeline.copy();
        return;
      }
      if (meta && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        timeline.cut();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        timeline.paste(current);
        return;
      }
      if (meta && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) timeline.ungroup();
        else timeline.group();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        timeline.duplicate();
        return;
      }
      if (event.key.toLowerCase() === 'm' && !meta) {
        event.preventDefault();
        timeline.addMarkerAt(current);
        return;
      }
      if (event.key.toLowerCase() === 'i' && !meta) {
        event.preventDefault();
        timeline.setWorkArea('in', current);
        return;
      }
      if (event.key.toLowerCase() === 'o' && !meta) {
        event.preventDefault();
        timeline.setWorkArea('out', current);
        return;
      }
      if (event.altKey && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        timeline.clearWorkArea();
        return;
      }
      if (event.key.toLowerCase() === 'k' && !meta && !event.altKey) {
        event.preventDefault();
        setShowKeyframes((value) => !value);
        return;
      }
      if (event.key.toLowerCase() === 'n' && !meta) {
        event.preventDefault();
        setSnapping((value) => !value);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const dir = event.key === 'ArrowLeft' ? -1 : 1;
        if (event.altKey && selection.length) {
          const step = event.shiftKey ? 10 * frame : frame;
          timeline.move(
            selection.map((id) => ({
              itemId: id,
              startUs: Math.max(0, (state?.items[id]?.startUs ?? 0) + dir * step),
            })),
            editMode,
          );
          return;
        }
        const step = event.shiftKey ? 1_000_000 : frame;
        const next = Math.min(duration, Math.max(0, current + dir * step));
        playheadStore.set(quantizeUs(next, fps));
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        playheadStore.set(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        playheadStore.set(duration);
        return;
      }
      if (meta && event.key === '0') {
        event.preventDefault();
        fitProject();
        return;
      }
      if (meta && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        zoomBy(1.25);
        return;
      }
      if (meta && event.key === '-') {
        event.preventDefault();
        zoomBy(1 / 1.25);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editMode, fps, rippleAllTracks, selection, state, timeline]);

  if (!state) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        {timeline.loadError || 'Loading the timeline…'}
      </div>
    );
  }

  const tracks = tracksInDrawOrder(state);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar (SPEC 09 §5.1) */}
      <div
        style={{
          height: 36,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: '0 var(--space-2)',
          borderBottom: '1px solid var(--line-subtle)',
          flexWrap: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <IconButton
          label="Select tool"
          shortcut="V"
          active={tool === 'select'}
          size={28}
          icon={<MousePointer2 size={14} />}
          onClick={() => setTool('select')}
        />
        <IconButton
          label="Razor tool"
          shortcut="C"
          active={tool === 'razor'}
          size={28}
          icon={<Scissors size={14} />}
          onClick={() => setTool('razor')}
        />
        <IconButton
          label="Show keyframes"
          shortcut="K"
          size={28}
          active={showKeyframes}
          icon={<Diamond size={14} />}
          onClick={() => setShowKeyframes((value) => !value)}
        />
        <IconButton
          label="Split at playhead"
          shortcut="S"
          size={28}
          icon={<Scissors size={14} />}
          onClick={() => timeline.split(playheadStore.get())}
        />
        <IconButton
          label="Undo"
          shortcut="Ctrl+Z"
          size={28}
          icon={<ChevronUp size={14} style={{ transform: 'rotate(-90deg)' }} />}
          onClick={timeline.undo}
          disabled={!timeline.canUndo}
        />
        <IconButton
          label="Redo"
          shortcut="Ctrl+Shift+Z"
          size={28}
          icon={<ChevronDown size={14} style={{ transform: 'rotate(-90deg)' }} />}
          onClick={timeline.redo}
          disabled={!timeline.canRedo}
        />
        <IconButton
          label="Delete"
          shortcut="Del"
          size={28}
          icon={<Trash2 size={14} />}
          onClick={() => timeline.remove(false)}
          disabled={!selection.length}
        />
        <IconButton
          label="Duplicate"
          shortcut="Ctrl+D"
          size={28}
          icon={<Copy size={14} />}
          onClick={timeline.duplicate}
          disabled={!selection.length}
        />
        <IconButton
          label="Copy"
          shortcut="Ctrl+C"
          size={28}
          icon={<ClipboardCopy size={14} />}
          onClick={() => timeline.copy()}
          disabled={!selection.length}
        />
        <IconButton
          label="Paste at playhead"
          shortcut="Ctrl+V"
          size={28}
          icon={<ClipboardPaste size={14} />}
          onClick={() => timeline.paste(playheadStore.get())}
          disabled={timeline.clipboardSize === 0}
        />
        <IconButton
          label="Add marker"
          shortcut="M"
          size={28}
          icon={<Flag size={14} />}
          onClick={() => timeline.addMarkerAt(playheadStore.get())}
        />
        <IconButton
          label={snapping ? 'Snapping on' : 'Snapping off'}
          shortcut="N"
          active={snapping}
          size={28}
          icon={<Magnet size={14} />}
          onClick={() => setSnapping((value) => !value)}
        />
        <IconButton
          label={rippleAllTracks ? 'Ripple all tracks: on' : 'Ripple all tracks: off'}
          shortcut="Shift+Del"
          active={rippleAllTracks}
          size={28}
          icon={<Shuffle size={14} />}
          onClick={() => setRippleAllTracks((value) => !value)}
        />
        <div style={{ width: 1, height: 18, background: 'var(--line-subtle)' }} />
        <SegmentedControl<EditMode>
          value={editMode}
          onChange={setEditMode}
          size="dense"
          ariaLabel="Edit mode"
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'insert', label: 'Insert' },
            { value: 'overwrite', label: 'Overwrite' },
          ]}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <PlayheadReadout durationUs={durationUs} fps={fps} />
          <IconButton label="Zoom out" size={28} icon={<Minus size={14} />} onClick={() => zoomBy(1 / 1.25)} />
          <div style={{ width: 96 }}>
            <Slider
              value={Math.round(pxPerSecond * 10)}
              min={Math.round(MIN_PX_PER_SECOND * 10)}
              max={Math.round(MAX_PX_PER_SECOND * 10)}
              onChange={(value) => setPxPerSecond(value / 10)}
              ariaLabel="Timeline zoom"
            />
          </div>
          <IconButton label="Zoom in" size={28} icon={<Plus size={14} />} onClick={() => zoomBy(1.25)} />
          <IconButton label="Fit project" shortcut="Ctrl+0" size={28} icon={<Maximize2 size={14} />} onClick={fitProject} />
        </div>
      </div>

      {/* Ruler row */}
      <div style={{ display: 'flex', height: 28, borderBottom: '1px solid var(--line-subtle)' }}>
        <div
          style={{
            width: HEADER_WIDTH,
            flexShrink: 0,
            borderRight: '1px solid var(--line-subtle)',
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 'var(--space-2)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-muted)',
          }}
        >
          {state.tracks.length} tracks
        </div>
        <div
          style={{ position: 'relative', flex: 1, overflow: 'hidden' }}
          onPointerDown={beginScrub}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, type: 'ruler' });
          }}
        >
          <canvas ref={rulerRef} style={{ width: '100%', height: 28, display: 'block' }} />
        </div>
      </div>

      {/* Track area */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div
          style={{
            width: HEADER_WIDTH,
            flexShrink: 0,
            borderRight: '1px solid var(--line-subtle)',
            overflow: 'hidden',
          }}
        >
          {tracks.map((track) => (
            <div
              key={track.id}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, type: 'track', targetId: track.id });
              }}
              style={{
                height: track.heightPx,
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '0 var(--space-2)',
                borderBottom: '1px solid var(--line-subtle)',
                background: track.role === 'main' ? 'var(--surface-card)' : 'transparent',
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 'var(--fs-xs)',
                  color: track.locked ? 'var(--text-muted)' : 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {track.name}
              </span>
              {track.locked && <Lock size={11} color="var(--text-muted)" />}
              {track.role === 'main' && (
                <IconButton
                  label={track.magnetic ? `Magnetic ${track.name}: on` : `Magnetic ${track.name}: off`}
                  size={28}
                  active={track.magnetic === true}
                  icon={<Magnet size={12} />}
                  onClick={() => timeline.toggleMagnetic(track.id)}
                />
              )}
              {(track.kind === 'audio' || track.kind === 'video') && (
                <IconButton
                  label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                  size={28}
                  active={track.muted}
                  icon={track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  onClick={() => timeline.toggleMute(track.id)}
                />
              )}
            </div>
          ))}
        </div>

        <div
          ref={canvasRef}
          data-testid="timeline-canvas"
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            cursor:
              drag?.kind === 'scrub'
                ? 'col-resize'
                : tool === 'razor'
                  ? 'crosshair'
                  : 'default',
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && event.button === 0) {
              beginMarquee(event);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            event.preventDefault();
            const raw = event.dataTransfer.getData('application/x-clipwright-media');
            if (!raw) return;
            try {
              const parsed = JSON.parse(raw) as {
                mediaId: string;
                label: string;
                type: 'video' | 'audio' | 'image';
                durationUs: number;
                sourceDurationUs: number;
              };
              const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
              const x = event.clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0);
              const timeUs = timeAtPointer(event.clientX);
              timeline.placeMedia({
                mediaId: parsed.mediaId,
                label: parsed.label,
                type: parsed.type,
                durationUs: parsed.durationUs,
                sourceDurationUs: parsed.sourceDurationUs,
                startUs: timeUs,
              });
            } catch {
              // Invalid drop data — ignore
            }
          }}
        >
          {marquee && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: Math.min(marquee.x1, marquee.x2) - scrollX,
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
                border: '1px solid var(--brand)',
                background: 'var(--brand-tint)',
                pointerEvents: 'none',
              }}
            />
          )}
          {tracks.map((track) => (
            <div
              key={track.id}
              style={{
                position: 'relative',
                height: track.heightPx,
                borderBottom: '1px solid var(--line-subtle)',
                background: track.role === 'main' ? 'var(--surface-raised)' : 'transparent',
                overflow: 'hidden',
              }}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget && event.button === 0) {
                  timeline.clearSelection();
                }
              }}
            >
              {track.itemIds.map((itemId) => {
                const item = state.items[itemId];
                if (!item) return null;
                // Live gesture preview: a drag or trim never commits until release.
                let previewStart = item.startUs;
                let previewDuration = item.durationUs;
                if (dragPreview?.itemId === itemId) previewStart = dragPreview.startUs;
                if (trimPreview?.itemId === itemId) {
                  if (trimPreview.edge === 'start') {
                    const endUs = item.startUs + item.durationUs;
                    previewStart = Math.min(trimPreview.us, endUs - 33_333);
                    previewDuration = endUs - previewStart;
                  } else {
                    previewDuration = Math.max(33_333, trimPreview.us - item.startUs);
                  }
                }
                const left = usToX(previewStart) - scrollX;
                const width = Math.max(6, usToX(previewDuration));
                const selected = selection.includes(item.id);
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${item.label} clip`}
                    aria-pressed={selected}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      timeline.select([item.id]);
                      setMenu({ x: event.clientX, y: event.clientY, type: 'clip', targetId: item.id });
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (event.button !== 0) return;
                      if (tool === 'razor') {
                        timeline.splitAt([item.id], applySnap(timeAtPointer(event.clientX), event.altKey).us);
                        return;
                      }
                      // Selecting any member of a group selects the whole group.
                      const members = item.groupId
                        ? Object.values(state.items)
                            .filter((candidate) => candidate.groupId === item.groupId)
                            .map((candidate) => candidate.id)
                        : [item.id];
                      timeline.select(members, event.ctrlKey || event.metaKey);
                      setDrag({
                        kind: 'move',
                        itemId: item.id,
                        startUs: item.startUs,
                        pointerStartUs: timeAtPointer(event.clientX),
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      left,
                      width,
                      borderRadius: 'var(--radius-sm)',
                      background: selected ? 'var(--brand-tint)' : 'var(--surface-card)',
                      border: `1px solid ${selected ? 'var(--brand)' : 'var(--line-default)'}`,
                      outline: selected ? '2px solid var(--brand)' : 'none',
                      outlineOffset: -2,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      paddingLeft: 6,
                      paddingRight: 8,
                      overflow: 'hidden',
                      cursor: 'grab',
                      userSelect: 'none',
                    }}
                  >
                    <span
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setDrag({ kind: 'trim', itemId: item.id, edge: 'start' });
                      }}
                      style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }}
                    />
                    <span
                      style={{
                        fontSize: 'var(--fs-xs)',
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        overflow: 'hidden',
                      }}
                    >
                      {item.type === 'caption' && item.captionSegment?.text
                        ? item.captionSegment.text
                        : item.label}
                    </span>
                    <span
                      data-testid={`${item.id}-right-handle`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        // Ctrl+drag at a junction starts a rolling edit (SPEC 09 §13.3).
                        if ((event.ctrlKey || event.metaKey) || (event.nativeEvent as MouseEvent)?.ctrlKey || (event.nativeEvent as MouseEvent)?.metaKey) {
                          const index = track.itemIds.indexOf(itemId);
                          const nextId = track.itemIds[index + 1];
                          const next = nextId ? state.items[nextId] : undefined;
                          if (
                            next &&
                            Math.abs(next.startUs - itemEndUs(item)) <= frameDurationUs(fps)
                          ) {
                            setDrag({ kind: 'roll', leftItemId: item.id, rightItemId: next.id });
                            return;
                          }
                        }
                        setDrag({ kind: 'trim', itemId: item.id, edge: 'end' });
                      }}
                      style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize' }}
                    />
                    {item.keyframes && Object.keys(item.keyframes).length > 0 && (selected || showKeyframes) && (
                      <div
                        data-testid={`${item.id}-keyframe-lane`}
                        style={{
                          position: 'absolute',
                          bottom: 0,
                          left: 0,
                          right: 0,
                          height: 12,
                          borderTop: '1px solid var(--line-subtle)',
                          display: 'flex',
                          alignItems: 'center',
                          pointerEvents: 'none',
                        }}
                      >
                        {Object.entries(item.keyframes).flatMap(([property, kfs]) =>
                          kfs.map((kf) => (
                            <div
                              key={`${property}-${kf.timeUs}`}
                              data-testid={`${item.id}-kf-${property}-${kf.timeUs}`}
                              title={`${property} @ ${kf.timeUs}us`}
                              style={{
                                position: 'absolute',
                                left: `${(kf.timeUs / item.durationUs) * 100}%`,
                                transform: 'translateX(-50%)',
                                width: 8,
                                height: 8,
                                background: 'var(--brand)',
                                clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                              }}
                            />
                          )),
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {track.itemIds.length === 0 && (
                <div
                  data-testid={`empty-area-${track.id}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, type: 'empty', targetId: track.id });
                  }}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 'var(--space-2)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--text-muted)',
                    opacity: 0.7,
                  }}
                >
                  {track.role === 'main' ? 'Drop media here' : 'Empty'}
                </div>
              )}
            </div>
          ))}

          {rollPreview && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: usToX(rollPreview.us) - scrollX,
                top: 0,
                bottom: 0,
                width: 2,
                background: 'var(--brand)',
                pointerEvents: 'none',
              }}
            />
          )}
          {snapGuide !== null && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: usToX(snapGuide) - scrollX,
                width: 1,
                background: 'var(--brand)',
                pointerEvents: 'none',
              }}
            />
          )}

          <PlayheadMarker pxPerSecond={pxPerSecond} scrollX={scrollX} />
          {state.markers.map((marker) => (
            <div
              key={marker.id}
              data-testid={`marker-${marker.id}`}
              title={marker.name}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({ x: event.clientX, y: event.clientY, type: 'marker', targetId: marker.id });
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const name = window.prompt('Marker name', marker.name);
                if (name !== null) timeline.updateMarker(marker.id, { name });
              }}
              style={{
                position: 'absolute',
                top: 0,
                left: usToX(marker.timeUs) - scrollX,
                width: 2,
                height: 8,
                background: marker.color ?? 'var(--brand)',
                pointerEvents: 'auto',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={menu.type === 'clip' && menu.targetId
            ? clipMenuItems(menu.targetId, timeline, state, fps, selection)
            : menu.type === 'track' && menu.targetId
              ? trackMenuItems(menu.targetId, timeline, state)
              : menu.type === 'ruler'
                ? rulerMenuItems(timeline, state, fps)
                : menu.type === 'marker' && menu.targetId
                  ? markerMenuItems(menu.targetId, timeline, state)
                  : emptyMenuItems(timeline)}
        />
      )}

      {timeline.notes.length > 0 && (
        <div
          role="status"
          style={{
            padding: 'var(--space-2)',
            borderTop: '1px solid var(--line-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ flex: 1 }}>{timeline.notes.join(' ')}</span>
          <Button size={28} variant="ghost" onClick={timeline.dismissNotes}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/** Clip context menu items (SPEC 09 §21). */
function clipMenuItems(
  itemId: string,
  timeline: TimelineApi,
  state: TimelineState,
  fps: number,
  selection: string[],
): MenuItem[] {
  const item = state.items[itemId];
  if (!item) return [];
  const hasSelection = selection.length > 0;
  const isLinked = !!item.linkId;
  const canDetach = item.type === 'video';

  return [
    { id: 'cut', label: 'Cut', icon: <ClipboardCopy size={14} />, shortcut: 'Ctrl+X', onSelect: () => timeline.cut() },
    { id: 'copy', label: 'Copy', icon: <ClipboardCopy size={14} />, shortcut: 'Ctrl+C', onSelect: () => timeline.copy() },
    { id: 'paste', label: 'Paste', icon: <ClipboardPaste size={14} />, shortcut: 'Ctrl+V', onSelect: () => timeline.paste(playheadStore.get()) },
    { id: 'sep1', label: '', onSelect: () => {} },
    { id: 'duplicate', label: 'Duplicate', icon: <Copy size={14} />, shortcut: 'Ctrl+D', onSelect: () => timeline.duplicate() },
    { id: 'delete', label: 'Delete', icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onSelect: () => timeline.remove(false, false) },
    { id: 'ripple', label: 'Ripple delete', icon: <Trash2 size={14} />, shortcut: 'Shift+Del', danger: true, onSelect: () => timeline.remove(true, false) },
    { id: 'split', label: 'Split at playhead', icon: <Scissors size={14} />, onSelect: () => timeline.split(playheadStore.get()) },
    { id: 'sep2', label: '', onSelect: () => {} },
    { id: 'detach', label: 'Detach audio', icon: <Volume2 size={14} />, disabled: !canDetach, disabledReason: 'Only video items have audio to detach', onSelect: () => timeline.detachAudio(itemId) },
    { id: 'unlink', label: 'Unlink', icon: <Unlink size={14} />, disabled: !isLinked, disabledReason: 'This item is not linked', onSelect: () => timeline.unlink(itemId) },
    { id: 'group', label: 'Group', icon: <Users size={14} />, disabled: selection.length < 2, disabledReason: 'Select two or more clips to group', onSelect: () => timeline.group() },
    { id: 'ungroup', label: 'Ungroup', icon: <Users size={14} />, disabled: !item.groupId, disabledReason: 'This clip is not in a group', onSelect: () => timeline.ungroup() },
    { id: 'sep3', label: '', onSelect: () => {} },
    { id: 'toggle-disabled', label: item.disabled ? 'Enable' : 'Disable', icon: <Power size={14} />, onSelect: () => timeline.toggleDisabled(itemId) },
  ];
}

/** Track header context menu items (SPEC 09 §9.1). */
function trackMenuItems(
  trackId: string,
  timeline: TimelineApi,
  state: TimelineState,
): MenuItem[] {
  const track = state.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return [];

  return [
    { id: 'mute', label: track.muted ? 'Unmute' : 'Mute', icon: track.muted ? <Volume2 size={14} /> : <VolumeX size={14} />, onSelect: () => timeline.toggleMute(trackId) },
    { id: 'lock', label: track.locked ? 'Unlock' : 'Lock', icon: <Lock size={14} />, onSelect: () => timeline.toggleTrackLock(trackId) },
    { id: 'hide', label: track.hidden ? 'Show' : 'Hide', icon: track.hidden ? <Eye size={14} /> : <EyeOff size={14} />, onSelect: () => timeline.toggleTrackHidden(trackId) },
    { id: 'sep1', label: '', onSelect: () => {} },
    { id: 'add-track', label: 'Add track above', icon: <Plus size={14} />, onSelect: () => timeline.addTrack('video', trackId) },
    { id: 'add-track-below', label: 'Add track below', icon: <Plus size={14} />, onSelect: () => timeline.addTrack('video') },
    { id: 'sep2', label: '', onSelect: () => {} },
    { id: 'delete-track', label: 'Delete track', icon: <Trash2 size={14} />, danger: true, disabled: track.role === 'main', disabledReason: 'The main track cannot be deleted', onSelect: () => timeline.deleteTrack(trackId) },
  ];
}

/** Ruler context menu items (SPEC 09 §21). */
function rulerMenuItems(
  timeline: TimelineApi,
  state: TimelineState,
  fps: number,
): MenuItem[] {
  const duration = projectDurationUs(state);
  return [
    { id: 'add-marker', label: 'Add marker', icon: <Flag size={14} />, onSelect: () => timeline.addMarkerAt(playheadStore.get()) },
    { id: 'set-in', label: 'Set work-area in', icon: <ChevronDown size={14} />, onSelect: () => timeline.setWorkArea('in', playheadStore.get()) },
    { id: 'set-out', label: 'Set work-area out', icon: <ChevronUp size={14} />, onSelect: () => timeline.setWorkArea('out', playheadStore.get()) },
    { id: 'clear-work', label: 'Clear work area', icon: <Trash2 size={14} />, disabled: !state.workArea, disabledReason: 'No work area set', onSelect: () => timeline.clearWorkArea() },
    { id: 'sep1', label: '', onSelect: () => {} },
    { id: 'fit', label: 'Fit project', icon: <Maximize2 size={14} />, onSelect: () => timeline.run('Fit project', (s) => ({ ok: true, state: s, patches: [], inverse: [], affectedItemIds: [], notes: ['Fit to project.'] })) },
  ];
}

/** Marker context menu items (SPEC 09 §18, §21). */
function markerMenuItems(
  markerId: string,
  timeline: TimelineApi,
  state: TimelineState,
): MenuItem[] {
  const marker = state.markers.find((m) => m.id === markerId);
  if (!marker) return [];
  return [
    { id: 'rename', label: 'Rename', icon: <Flag size={14} />, onSelect: () => {
      const name = window.prompt('Marker name', marker.name);
      if (name !== null) timeline.updateMarker(markerId, { name });
    } },
    { id: 'sep1', label: '', onSelect: () => {} },
    { id: 'delete', label: 'Delete marker', icon: <Trash2 size={14} />, danger: true, onSelect: () => timeline.deleteMarker(markerId) },
  ];
}

/** Empty track area context menu items (SPEC 09 §21). */
function emptyMenuItems(
  timeline: TimelineApi,
): MenuItem[] {
  return [
    { id: 'paste', label: 'Paste', icon: <ClipboardPaste size={14} />, onSelect: () => timeline.paste(playheadStore.get()) },
    { id: 'marker', label: 'Add marker here', icon: <Flag size={14} />, onSelect: () => timeline.addMarkerAt(playheadStore.get()) },
    { id: 'add-track', label: 'Add track', icon: <Plus size={14} />, onSelect: () => timeline.addTrack('video') },
  ];
}

/**
 * The playhead subscribes to the store on its own, so a playback tick moves one
 * absolutely-positioned element instead of re-rendering clips, tracks or ruler
 * (SPEC 09 §2.4, §27).
 */
function PlayheadMarker({ pxPerSecond, scrollX }: { pxPerSecond: number; scrollX: number }) {
  const us = usePlayheadUs();
  return (
    <div
      aria-hidden
      data-testid="playhead"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: (us * pxPerSecond) / 1_000_000 - scrollX,
        width: 1,
        background: 'var(--brand)',
        pointerEvents: 'none',
      }}
    />
  );
}

function PlayheadReadout({ durationUs, fps }: { durationUs: number; fps: 30 | 60 }) {
  const us = usePlayheadUs();
  return (
    <TimecodeField
      valueText={formatTimecode(us, fps)}
      totalDurationText={formatTimecode(durationUs, fps)}
      onCommit={(input) => {
        const parsed = parseTimecode(input, fps, us);
        if (!parsed) return false;
        playheadStore.set(Math.min(durationUs, parsed.us));
        return true;
      }}
    />
  );
}
