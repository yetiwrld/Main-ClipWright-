import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Play, Pause, SkipBack, Scissors, Copy, Trash2, Bookmark, Type, Undo2, Redo2,
  ZoomIn, ZoomOut, Magnet, Lock, Unlock, Eye, EyeOff, Volume2, VolumeX, Film, ChevronRight, Download, X,
} from 'lucide-react';
import { Button, IconButton, Dialog, Select, StatusPill, EmptyState } from '@clipwright/design-system';
import { api, type Composition, type ProjectRecord } from '../api.js';
import { mediaUrl } from '../mediaUrl.js';
import { useAppStore } from '../stores.js';
import { fmtDuration } from '../format.js';
import type { Item, Track, Job } from '@clipwright/project-schema';
import { newId } from '@clipwright/project-schema';
import { tokens } from '@clipwright/design-system/tokens.js';

const MIN_ITEM_US = 100_000;
const TRACK_COLORS: Record<string, string> = {
  video: 'var(--track-video)', overlay: 'var(--track-overlay)', image: 'var(--track-image)',
  voiceover: 'var(--track-voiceover)', audio: 'var(--track-audio)', music: 'var(--track-music)',
  sfx: 'var(--track-sfx)', caption: 'var(--track-caption)', text: 'var(--track-text)', adjustment: 'var(--track-adjustment)',
};

const aspectOf = (w: number, h: number): string => {
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.01) return '9:16';
  if (Math.abs(r - 16 / 9) < 0.01) return '16:9';
  if (Math.abs(r - 1) < 0.01) return '1:1';
  if (Math.abs(r - 4 / 5) < 0.01) return '4:5';
  return 'original';
};

interface DragState {
  itemId: string;
  mode: 'move' | 'trim-left' | 'trim-right';
  pointerStartX: number;
  origStartUs: number;
  origDurationUs: number;
  origInUs: number;
  moved: boolean;
}

export const EditorPage = () => {
  const { projectId, compId } = useParams<{ projectId: string; compId?: string }>();
  const navigate = useNavigate();
  const toast = useAppStore((s) => s.toast);
  const activeJobs = useAppStore((s) => s.activeJobs);

  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [comps, setComps] = useState<Composition[]>([]);
  const [comp, setComp] = useState<Composition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaPath, setMediaPath] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [playUs, setPlayUs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(90);
  const [snapOn, setSnapOn] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [past, setPast] = useState<Composition[]>([]);
  const [future, setFuture] = useState<Composition[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'mp4' | 'webm'>('mp4');
  const [exportAspect, setExportAspect] = useState<string>('9:16');
  const [exportQuality, setExportQuality] = useState<'draft' | 'standard' | 'high' | 'maximum'>('high');
  const [exportFps, setExportFps] = useState<'match' | 30 | 60>('match');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const playUsRef = useRef(0);
  playUsRef.current = playUs;
  const compRef = useRef<Composition | null>(null);
  compRef.current = comp;

  /* ---------------------------------------------------------- loading */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await api.projects.get(projectId);
        if (cancelled) return;
        setProject(p);
        const list = await api.composition.list(projectId);
        if (cancelled) return;
        setComps(list);
        const targetId = compId ?? list[0]?.id;
        if (!targetId) { setComp(null); return; }
        const loaded = await api.composition.load(projectId, targetId);
        if (cancelled) return;
        setComp(loaded);
        setExportAspect(loaded ? aspectOf(loaded.width, loaded.height) : '9:16');
        if (p?.sourceMediaId) {
          const media = await api.media.get(p.sourceMediaId);
          if (!cancelled) setMediaPath(media?.path ?? null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load the editor.');
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, compId]);

  /* ------------------------------------------------------- autosave */
  const dirtyComp = useRef<Composition | null>(null);
  useEffect(() => {
    dirtyComp.current = comp;
    if (saveState !== 'dirty') return;
    const t = window.setTimeout(() => {
      const c = dirtyComp.current;
      if (!c || !projectId) return;
      setSaveState('saving');
      api.composition.save(projectId, c)
        .then(() => setSaveState('saved'))
        .catch((err) => {
          setSaveState('dirty');
          toast(err instanceof Error ? err.message : 'Autosave failed.', 'error');
        });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [comp, saveState, projectId, toast]);

  const mutate = useCallback((fn: (c: Composition) => Composition) => {
    setComp((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      setPast((p) => [...p.slice(-99), prev]);
      setFuture([]);
      setSaveState('dirty');
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1]!;
      setFuture((f) => [...f, compRef.current!]);
      setComp(prev);
      setSaveState('dirty');
      return p.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1]!;
      setPast((p) => [...p, compRef.current!]);
      setComp(next);
      setSaveState('dirty');
      return f.slice(0, -1);
    });
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<Item>) => {
    mutate((c) => ({ ...c, items: c.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  }, [mutate]);

  const deleteSelected = useCallback(() => {
    if (!selection) return;
    mutate((c) => ({ ...c, items: c.items.filter((it) => it.id !== selection) }));
    setSelection(null);
  }, [selection, mutate]);

  const duplicateSelected = useCallback(() => {
    mutate((c) => {
      const item = c.items.find((it) => it.id === selection);
      if (!item) return c;
      const copy = { ...item, id: newId(), startUs: item.startUs + item.durationUs + 100_000, name: `${item.name} copy` };
      return { ...c, items: [...c.items, copy] };
    });
  }, [selection, mutate]);

  const splitAtPlayhead = useCallback(() => {
    mutate((c) => {
      const item = c.items.find((it) => it.id === selection);
      if (!item) return c;
      const t = playUsRef.current;
      const rel = t - item.startUs;
      if (rel < MIN_ITEM_US || item.durationUs - rel < MIN_ITEM_US) return c;
      const left: Item = { ...item, durationUs: rel };
      const right: Item = { ...item, id: newId(), startUs: t, durationUs: item.durationUs - rel, inUs: item.inUs + rel, name: `${item.name} 2` };
      return { ...c, items: c.items.flatMap((it) => (it.id === item.id ? [left, right] : [it])) };
    });
  }, [selection, mutate]);

  const addMarker = useCallback(() => {
    mutate((c) => ({ ...c, markers: [...c.markers, { id: newId(), timeUs: playUsRef.current, label: `Marker ${c.markers.length + 1}`, color: tokens.color.brandAmber }] }));
  }, [mutate]);

  const addTextItem = useCallback(() => {
    mutate((c) => {
      const textTrack = c.tracks.find((t) => t.type === 'text') ?? c.tracks[c.tracks.length - 1];
      if (!textTrack) return c;
      const item: Item = {
        id: newId(), trackId: textTrack.id, kind: 'text', name: 'Text',
        startUs: playUsRef.current, durationUs: 3_000_000, inUs: 0,
        transform: { x: 0, y: -200, scale: 1, rotationDeg: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false },
        volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false, text: 'YOUR TEXT', fontSize: 72,
        effects: [],
      };
      return { ...c, items: [...c.items, item] };
    });
  }, [mutate]);

  /* --------------------------------------------------- track toggles */
  const toggleTrackFlag = useCallback((trackId: string, flag: 'locked' | 'hidden') => {
    mutate((c) => ({ ...c, tracks: c.tracks.map((t) => (t.id === trackId ? { ...t, [flag]: !t[flag] } : t)) }));
  }, [mutate]);

  /* ------------------------------------------------- playback engine */
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (videoRef.current) videoRef.current.pause();
      return;
    }
    lastTickRef.current = performance.now();
    const tick = () => {
      const v = videoRef.current;
      const now = performance.now();
      const deltaUs = (now - lastTickRef.current) * 1000;
      lastTickRef.current = now;
      setPlayUs((t) => {
        const end = Math.max(compRef.current ? compRef.current.items.reduce((e, it) => Math.max(e, it.startUs + it.durationUs), 0) : 0, 5_000_000);
        const next = Math.min(t + deltaUs, end);
        if (v && next >= end) { setPlaying(false); v.pause(); }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing]);

  // keep the <video> element in sync when playhead is scrubbed while paused
  useEffect(() => {
    const v = videoRef.current;
    if (!v || playing || !comp) return;
    const item = activeVideoItem(comp, playUs);
    if (item) {
      const t = ((item.inUs + (playUs - item.startUs)) / 1e6);
      if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
    }
  }, [playUs, playing, comp]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !comp) return;
    const item = activeVideoItem(comp, playUsRef.current);
    if (!item) return;
    const t = (item.inUs + Math.max(0, playUs - item.startUs)) / 1e6;
    v.currentTime = t;
    v.volume = Math.min(1, item.volume);
    v.muted = item.muted;
    if (playing) void v.play().catch(() => setPlaying(false));
  }, [playing, comp]);

  /* ------------------------------------------------------- keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return;
      const frame = 1_000_000 / (comp?.fps ?? 30);
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'ArrowLeft') setPlayUs((t2) => Math.max(0, t2 - (e.shiftKey ? 1_000_000 : frame)));
      else if (e.key === 'ArrowRight') setPlayUs((t2) => t2 + (e.shiftKey ? 1_000_000 : frame));
      else if (e.key === 'Home') setPlayUs(0);
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); splitAtPlayhead(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const c = compRef.current;
        if (c && projectId) {
          setSaveState('saving');
          api.composition.save(projectId, c).then(() => setSaveState('saved')).catch(() => setSaveState('dirty'));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [comp?.fps, deleteSelected, undo, redo, duplicateSelected, splitAtPlayhead, projectId]);

  /* --------------------------------------------------- drag & trim */
  const snapTargets = useCallback((excludeId: string): number[] => {
    if (!comp) return [0];
    const targets = [0, ...comp.markers.map((m) => m.timeUs)];
    for (const it of comp.items) {
      if (it.id === excludeId) continue;
      targets.push(it.startUs, it.startUs + it.durationUs);
    }
    targets.push(playUsRef.current);
    return targets;
  }, [comp]);

  const applySnap = useCallback((value: number, excludeId: string): number => {
    if (!snapOn) return value;
    const threshold = (8 / pxPerSec) * 1_000_000;
    let best = value; let bestDist = threshold;
    for (const t of snapTargets(excludeId)) {
      const d = Math.abs(t - value);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    return best;
  }, [snapOn, pxPerSec, snapTargets]);

  const onClipPointerDown = (e: React.PointerEvent, item: Item, mode: DragState['mode']) => {
    e.stopPropagation();
    if (!comp) return;
    const track = comp.tracks.find((t) => t.id === item.trackId);
    if (track?.locked) { toast('That track is locked.', 'error'); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { itemId: item.id, mode, pointerStartX: e.clientX, origStartUs: item.startUs, origDurationUs: item.durationUs, origInUs: item.inUs, moved: false };
    setSelection(item.id);
  };

  const onClipPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaUs = ((e.clientX - drag.pointerStartX) / pxPerSec) * 1_000_000;
    if (Math.abs(deltaUs) > 50_000) drag.moved = true;
    setComp((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((it) => {
          if (it.id !== drag.itemId) return it;
          if (drag.mode === 'move') {
            return { ...it, startUs: Math.max(0, Math.round(applySnap(drag.origStartUs + deltaUs, it.id))) };
          }
          if (drag.mode === 'trim-left') {
            const newStart = Math.min(drag.origStartUs + deltaUs, drag.origStartUs + drag.origDurationUs - MIN_ITEM_US);
            const snapped = applySnap(Math.max(0, newStart), it.id);
            const shift = snapped - drag.origStartUs;
            return { ...it, startUs: Math.max(0, Math.round(snapped)), durationUs: Math.round(drag.origDurationUs - shift), inUs: Math.max(0, Math.round(drag.origInUs + shift)) };
          }
          const newDur = Math.max(MIN_ITEM_US, drag.origDurationUs + deltaUs);
          const end = applySnap(drag.origStartUs + newDur, it.id) - drag.origStartUs;
          return { ...it, durationUs: Math.round(Math.max(MIN_ITEM_US, end)) };
        }),
      };
    });
  };

  const onClipPointerUp = () => {
    const drag = dragRef.current;
    if (drag?.moved) { setFuture([]); setSaveState('dirty'); }
    dragRef.current = null;
  };

  /* ---------------------------------------------------------- export */
  const doExport = async () => {
    if (!comp || !projectId) return;
    setExportBusy(true);
    try {
      const settings = {
        preset: '1080p' as const, aspect: exportAspect, fps: exportFps, format: exportFormat,
        quality: exportQuality, audioBitrateKbps: 192, loudnessTargetLufs: -16,
        burnCaptions: true, subtitleSidecar: false, draft: false,
      };
      const jobId = await api.exportStart(projectId, comp.id, settings);
      setExportJobId(jobId);
      toast('Export started.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export could not start.', 'error');
    } finally { setExportBusy(false); }
  };

  useEffect(() => {
    const off = api.jobs.onDone((p) => {
      if (exportJobId && p.id === exportJobId) {
        toast('Export finished. Check the Exports folder in your workspace.');
        setExportJobId(null);
        setExportOpen(false);
      }
    });
    const offFail = api.jobs.onFailed((p) => {
      if (exportJobId && p.id === exportJobId) {
        toast(`Export failed: ${p.error}`, 'error');
        setExportJobId(null);
      }
    });
    return () => { off(); offFail(); };
  }, [exportJobId, toast]);

  const exportJob = activeJobs.find((j) => j.id === exportJobId);

  /* ---------------------------------------------------------- view */
  if (loadError) return <div className="page"><p className="notice notice--warning" role="alert">{loadError}</p><Button variant="ghost" onClick={() => navigate('/')}>Back to home</Button></div>;
  if (!projectId) return null;
  if (project && !comp) {
    return (
      <div className="page">
        <EmptyState title="No clip yet" icon={<Film size={40} strokeWidth={1.5} />}>
          Create a clip from one of this project’s moments — your editor will open here.
          <div style={{ marginTop: 16 }}><Button variant="primary" onClick={() => navigate(`/moments/${projectId}`)}>Find moments <ChevronRight size={16} aria-hidden /></Button></div>
        </EmptyState>
      </div>
    );
  }
  if (!comp) return <div className="page"><p className="empty-hint">Loading editor…</p></div>;

  const durationUs = comp.items.reduce((e, it) => Math.max(e, it.startUs + it.durationUs), 0);
  const timelineWidth = (Math.max(durationUs, playUs + 10_000_000) / 1e6) * pxPerSec + 240;
  const selected = comp.items.find((it) => it.id === selection) ?? null;
  const sortedTracks = [...comp.tracks].sort((a, b) => a.order - b.order);
  const activeItems = comp.items.filter((it) => playUs >= it.startUs && playUs < it.startUs + it.durationUs);
  const captionItem = activeItems.find((it) => it.kind === 'caption' || it.kind === 'text');
  const videoItem = activeItems.find((it) => it.kind === 'video');
  const aspectRatio = `${comp.width}/${comp.height}`;

  return (
    <div className="editor">
      {/* toolbar */}
      <div className="editor-toolbar">
        <IconButton aria-label="Back to moments" size="20" onClick={() => navigate(`/moments/${projectId}`)}><ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} /></IconButton>
        <span style={{ fontWeight: 600, fontSize: 'var(--fs-sm)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{comp.name}</span>
        <div style={{ flex: 1 }} />
        <IconButton aria-label="Undo" size="20" onClick={undo} disabled={past.length === 0}><Undo2 size={16} /></IconButton>
        <IconButton aria-label="Redo" size="20" onClick={redo} disabled={future.length === 0}><Redo2 size={16} /></IconButton>
        <IconButton aria-label="Split at playhead" size="20" onClick={splitAtPlayhead}><Scissors size={16} /></IconButton>
        <IconButton aria-label="Duplicate item" size="20" onClick={duplicateSelected} disabled={!selection}><Copy size={16} /></IconButton>
        <IconButton aria-label="Delete item" size="20" onClick={deleteSelected} disabled={!selection}><Trash2 size={16} /></IconButton>
        <IconButton aria-label="Add marker" size="20" onClick={addMarker}><Bookmark size={16} /></IconButton>
        <IconButton aria-label="Add text" size="20" onClick={addTextItem}><Type size={16} /></IconButton>
        <span className={`topbar__save-status${saveState === 'dirty' ? ' topbar__save-status--error' : ''}`}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Unsaved'}
        </span>
        <Button variant="primary" size="28" onClick={() => setExportOpen(true)}><Download size={16} aria-hidden /> Export</Button>
      </div>

      <div className="editor-body">
        {/* left: library */}
        <aside className="editor-side" aria-label="Clips in this project">
          <div className="cw-panel-header" style={{ padding: '8px 12px' }}><span>CLIPS IN PROJECT</span></div>
          <div style={{ overflowY: 'auto', padding: '0 12px' }}>
            {comps.map((c) => (
              <button key={c.id} className="library-item" style={{ width: '100%', border: c.id === comp.id ? '1px solid var(--brand)' : '1px solid transparent', borderRadius: 8, background: 'transparent', color: 'inherit', textAlign: 'left' }}
                onClick={() => navigate(`/editor/${projectId}/${c.id}`)}>
                <span className="library-item__thumb"><Film size={18} strokeWidth={1.5} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtDuration(c.items.reduce((e, it) => Math.max(e, it.startUs + it.durationUs), 0))}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="cw-panel-header" style={{ padding: '8px 12px' }}><span>SOURCE</span></div>
          <div style={{ padding: '0 12px 12px', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
            {project?.name ?? 'Untitled project'}
            {mediaPath && <div className="honesty" style={{ marginTop: 4, wordBreak: 'break-all' }}>{mediaPath}</div>}
          </div>
        </aside>

        {/* center: preview */}
        <div className="editor-center">
          <div className="preview-stage">
            <div className="preview-frame" style={{ width: 'auto', height: '100%', maxHeight: 480, aspectRatio, position: 'relative', boxShadow: 'var(--shadow-menu)' }}>
              {videoItem && mediaPath ? (
                <video
                  ref={videoRef}
                  className="preview-video"
                  src={mediaUrl(mediaPath)}
                  style={{
                    transform: `translate(${(videoItem.transform.x / comp.width) * 100}%, ${(videoItem.transform.y / comp.height) * 100}%) scale(${videoItem.transform.scale}) rotate(${videoItem.transform.rotationDeg}deg) scaleX(${videoItem.transform.flipH ? -1 : 1}) scaleY(${videoItem.transform.flipV ? -1 : 1})`,
                    opacity: videoItem.transform.opacity,
                  }}
                  onEnded={() => setPlaying(false)}
                />
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--surface-card)', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                  {activeItems.length === 0 ? 'Nothing on the timeline at the playhead' : 'Audio only'}
                </div>
              )}
              {captionItem && (
                <div className="moment-caption-overlay" style={{ bottom: '16%', fontSize: Math.max(14, Math.round((captionItem.fontSize ?? 64) * 0.28)), textShadow: '0 2px 8px rgba(0,0,0,.85)' }}>
                  {captionItem.text ?? ''}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 16px 10px', fontVariantNumeric: 'tabular-nums' }}>
            <IconButton aria-label="Back to start" size="20" onClick={() => setPlayUs(0)}><SkipBack size={16} /></IconButton>
            <IconButton aria-label={playing ? 'Pause' : 'Play'} size="24" active={playing} onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </IconButton>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{fmtDuration(playUs)} / {fmtDuration(durationUs)}</span>
          </div>

          {/* timeline */}
          <div className="timeline-area">
            <div className="timeline-toolbar">
              <IconButton aria-label="Snap" size="16" active={snapOn} onClick={() => setSnapOn((v) => !v)}><Magnet size={14} /></IconButton>
              <IconButton aria-label="Zoom out" size="16" onClick={() => setPxPerSec((z) => Math.max(20, z / 1.4))}><ZoomOut size={14} /></IconButton>
              <IconButton aria-label="Zoom in" size="16" onClick={() => setPxPerSec((z) => Math.min(360, z * 1.4))}><ZoomIn size={14} /></IconButton>
              <span className="honesty" style={{ marginLeft: 8 }}>{comp.fps} fps · {sortedTracks.length} tracks</span>
              <div style={{ flex: 1 }} />
              <span className="honesty">Ctrl+Z undo · Ctrl+B split · Del remove · Space play</span>
            </div>
            <div className="timeline-scroll" ref={timelineRef}>
              <div style={{ width: timelineWidth, position: 'relative' }}>
                {/* ruler */}
                <div className="timeline-ruler" style={{ width: timelineWidth }} onPointerDown={(e) => {
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  setPlayUs(Math.max(0, ((e.clientX - rect.left) / pxPerSec) * 1_000_000));
                }} role="presentation">
                  {Array.from({ length: Math.ceil(timelineWidth / pxPerSec) + 1 }, (_, i) => (
                    <span key={i} style={{ position: 'absolute', left: i * pxPerSec + 2, top: 4, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{i}s</span>
                  ))}
                </div>
                {/* tracks */}
                <div className="timeline-tracks">
                  {sortedTracks.map((track) => (
                    <div className="track-row" key={track.id} style={{ height: track.height }}>
                      <div className="track-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</span>
                          <span style={{ display: 'flex', gap: 2 }}>
                            <button aria-label={track.hidden ? 'Show track' : 'Hide track'} onClick={() => toggleTrackFlag(track.id, 'hidden')} style={trackIconStyle}>{track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                            <button aria-label={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => toggleTrackFlag(track.id, 'locked')} style={trackIconStyle}>{track.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
                          </span>
                        </div>
                      </div>
                      <div className="track-lane">
                        {comp.items.filter((it) => it.trackId === track.id && !track.hidden).map((item) => {
                          const left = (item.startUs / 1e6) * pxPerSec;
                          const width = Math.max(12, (item.durationUs / 1e6) * pxPerSec);
                          return (
                            <div
                              key={item.id}
                              className={`timeline-clip${item.id === selection ? ' timeline-clip--selected' : ''}`}
                              style={{ left, width, background: TRACK_COLORS[track.type] ?? 'var(--surface-card)', opacity: item.muted ? 0.5 : 1, touchAction: 'none' }}
                              role="button" tabIndex={0} aria-label={item.name || item.kind}
                              onPointerDown={(e) => onClipPointerDown(e, item, 'move')}
                              onPointerMove={onClipPointerMove}
                              onPointerUp={onClipPointerUp}
                              onClick={() => setSelection(item.id)}
                            >
                              <span className="timeline-clip__handle timeline-clip__handle--left" onPointerDown={(e) => onClipPointerDown(e, item, 'trim-left')} onPointerMove={onClipPointerMove} onPointerUp={onClipPointerUp} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name || item.kind}</span>
                              <span className="timeline-clip__handle timeline-clip__handle--right" onPointerDown={(e) => onClipPointerDown(e, item, 'trim-right')} onPointerMove={onClipPointerMove} onPointerUp={onClipPointerUp} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {/* markers */}
                {comp.markers.map((m) => (
                  <div key={m.id} title={m.label} style={{ position: 'absolute', left: (m.timeUs / 1e6) * pxPerSec, top: 24, bottom: 0, width: 2, background: 'var(--brand-amber)', zIndex: 4, pointerEvents: 'none' }} />
                ))}
                {/* playhead */}
                <div className="playhead" style={{ left: (playUs / 1e6) * pxPerSec, top: 0 }} />
              </div>
            </div>
          </div>
        </div>

        {/* right: inspector */}
        <aside className="editor-side editor-side--right" aria-label="Inspector">
          <div className="cw-panel-header" style={{ padding: '8px 12px' }}><span>INSPECTOR</span></div>
          <div style={{ padding: '0 12px 12px', overflowY: 'auto' }}>
            {!selected && <p className="empty-hint">Select a clip on the timeline to edit it.</p>}
            {selected && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <label className="settings-row__hint">Name
                  <input className="cw-input" style={{ width: '100%', marginTop: 4 }} value={selected.name} onChange={(e) => updateItem(selected.id, { name: e.target.value })} />
                </label>
                <div className="detail-row" style={{ justifyContent: 'flex-start' }}>
                  <span>{(selected.startUs / 1e6).toFixed(2)}s</span>
                  <span>{(selected.durationUs / 1e6).toFixed(2)}s long</span>
                </div>
                {(selected.kind === 'video' || selected.kind === 'audio' || selected.kind === 'adjustment' || selected.kind === 'graphics') && (
                  <>
                    <label className="settings-row__hint">Volume ({Math.round(selected.volume * 100)}%)
                      <input type="range" min={0} max={1} step={0.01} value={Math.min(1, selected.volume)} onChange={(e) => updateItem(selected.id, { volume: Number(e.target.value) })} style={{ width: '100%' }} aria-label="Volume" />
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                      <input type="checkbox" checked={selected.muted} onChange={(e) => updateItem(selected.id, { muted: e.target.checked })} /> Muted
                    </label>
                  </>
                )}
                {selected.kind === 'video' && (
                  <>
                    <label className="settings-row__hint">Scale ({selected.transform.scale.toFixed(2)})
                      <input type="range" min={0.2} max={3} step={0.01} value={selected.transform.scale} onChange={(e) => updateItem(selected.id, { transform: { ...selected.transform, scale: Number(e.target.value) } })} style={{ width: '100%' }} aria-label="Scale" />
                    </label>
                    <label className="settings-row__hint">Position X ({selected.transform.x.toFixed(0)}px)
                      <input type="range" min={-comp.width / 2} max={comp.width / 2} step={1} value={selected.transform.x} onChange={(e) => updateItem(selected.id, { transform: { ...selected.transform, x: Number(e.target.value) } })} style={{ width: '100%' }} aria-label="Position X" />
                    </label>
                    <label className="settings-row__hint">Position Y ({selected.transform.y.toFixed(0)}px)
                      <input type="range" min={-comp.height / 2} max={comp.height / 2} step={1} value={selected.transform.y} onChange={(e) => updateItem(selected.id, { transform: { ...selected.transform, y: Number(e.target.value) } })} style={{ width: '100%' }} aria-label="Position Y" />
                    </label>
                    <label className="settings-row__hint">Opacity ({Math.round(selected.transform.opacity * 100)}%)
                      <input type="range" min={0} max={1} step={0.01} value={selected.transform.opacity} onChange={(e) => updateItem(selected.id, { transform: { ...selected.transform, opacity: Number(e.target.value) } })} style={{ width: '100%' }} aria-label="Opacity" />
                    </label>
                  </>
                )}
                {typeof selected.text === 'string' && (
                  <label className="settings-row__hint">Text
                    <textarea className="cw-textarea" style={{ width: '100%', marginTop: 4, minHeight: 72 }} value={selected.text} onChange={(e) => updateItem(selected.id, { text: e.target.value })} />
                  </label>
                )}
                {typeof selected.fontSize === 'number' && (
                  <label className="settings-row__hint">Size ({selected.fontSize}px)
                    <input type="range" min={16} max={220} step={2} value={selected.fontSize} onChange={(e) => updateItem(selected.id, { fontSize: Number(e.target.value) })} style={{ width: '100%' }} aria-label="Font size" />
                  </label>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* export dialog */}
      <Dialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export video"
        actions={(
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void doExport()} loading={exportBusy} disabled={!!exportJobId}>
              {exportJobId ? 'Exporting…' : 'Export'}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 380 }}>
          <label className="settings-row__hint">Aspect ratio
            <Select value={exportAspect} onChange={(e) => setExportAspect(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
              {['9:16', '16:9', '1:1', '4:5'].map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </label>
          <label className="settings-row__hint">Format
            <Select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as 'mp4' | 'webm')} style={{ width: '100%', marginTop: 4 }}>
              <option value="mp4">MP4 · H.264</option>
              <option value="webm">WebM · VP9</option>
            </Select>
          </label>
          <label className="settings-row__hint">Quality (short side 1080)
            <Select value={exportQuality} onChange={(e) => setExportQuality(e.target.value as typeof exportQuality)} style={{ width: '100%', marginTop: 4 }}>
              <option value="draft">Fast preview (CRF 26)</option>
              <option value="standard">Standard (CRF 22)</option>
              <option value="high">High (CRF 19)</option>
              <option value="maximum">Master (CRF 16)</option>
            </Select>
          </label>
          <label className="settings-row__hint">Frame rate
            <Select value={String(exportFps)} onChange={(e) => setExportFps(e.target.value === 'match' ? 'match' : (Number(e.target.value) as 30 | 60))} style={{ width: '100%', marginTop: 4 }}>
              <option value="match">Match source ({comp.fps} fps)</option>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </Select>
          </label>
          <p className="honesty">Rendering happens in the background with FFmpeg — the export is never a capture of this preview. The file is validated (duration, streams, faststart) before it appears in Exports.</p>
          {exportJob && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', marginBottom: 4 }}>
                <span>Exporting…</span><span>{Math.round((exportJob.progress ?? 0) * 100)}%</span>
              </div>
              <div className="cw-progress"><div style={{ width: `${(exportJob.progress ?? 0) * 100}%` }} /></div>
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
};

const trackIconStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, border: 'none', background: 'transparent',
  color: 'var(--text-muted)', cursor: 'pointer', borderRadius: 4,
};

const activeVideoItem = (comp: Composition, t: number): Item | undefined =>
  comp.items.find((it) => it.kind === 'video' && t >= it.startUs && t < it.startUs + it.durationUs);
