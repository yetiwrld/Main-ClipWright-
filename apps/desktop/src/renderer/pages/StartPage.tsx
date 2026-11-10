import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Route } from '../App.js';
import { api, describeError, isDesktop } from '../api.js';
import type { ProjectRecord } from '../global.js';
import {
  startSettings,
  type StartClipLength,
  type StartChoices,
} from '@clipwright/project-schema/start-settings';

interface Props {
  onNavigate: (r: Route) => void;
}

interface SourceSummary {
  name: string;
  path: string;
  size: number;
  duration: number;
}

const ASPECT_RATIOS = [
  { id: '9:16', label: '9:16', w: 9, h: 16 },
  { id: '16:9', label: '16:9', w: 16, h: 9 },
  { id: '1:1', label: '1:1', w: 1, h: 1 },
  { id: '4:5', label: '4:5', w: 4, h: 5 },
  { id: '4:3', label: '4:3', w: 4, h: 3 },
  { id: '21:9', label: '21:9', w: 21, h: 9 },
  { id: 'original', label: 'Original', w: 16, h: 9 },
  { id: 'custom', label: 'Custom', w: 16, h: 9 },
];

const CAPTION_STYLES = [
  { id: 'bold-creator', label: 'Bold creator' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'word-by-word', label: 'Word by word' },
  { id: 'title-card', label: 'Title card' },
  { id: 'subtitle', label: 'Subtitle' },
  { id: 'none', label: 'None' },
];

const CLIP_LENGTHS = [
  { id: 'short', label: 'Short 15–30s', min: 15, max: 30 },
  { id: 'medium', label: 'Medium 30–60s', min: 30, max: 60 },
  { id: 'long', label: 'Long 60–90s', min: 60, max: 90 },
  { id: 'extended', label: 'Extended 90–180s', min: 90, max: 180 },
  { id: 'custom', label: 'Custom', min: 10, max: 600 },
];

const CLIP_COUNTS = [
  { id: 'auto', label: 'Auto' },
  { id: '3', label: '3' },
  { id: '5', label: '5' },
  { id: '10', label: '10' },
  { id: '15', label: '15' },
  { id: '20', label: '20' },
  { id: 'custom', label: 'Custom' },
];

/**
 * A small numeric field for the two Custom popovers.
 *
 * Clamped as it is typed rather than on blur: the spec gives each of these a hard range (1–32 for a
 * ratio, 10 s–10 min for a length), and letting a 900 through until blur means the value in the
 * store depends on whether the user clicked away before pressing the button.
 */
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  min: number;
  max: number;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        if (!Number.isFinite(parsed)) {
          onChange(String(min));
          return;
        }
        onChange(String(Math.min(max, Math.max(min, Math.round(parsed)))));
      }}
      style={{
        width: 64,
        padding: '6px 8px',
        border: '1px solid var(--line-default)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-raised)',
        color: 'var(--text-primary)',
        fontSize: 'var(--fs-xs)',
      }}
    />
  );
}

export function StartPage({ onNavigate }: Props) {
  const [source, setSource] = useState<SourceSummary | null>(null);
  /*
    Typed with the shared module's own unions, so a tile the module cannot name is a compile error
    rather than a value that silently falls into a default at runtime.
  */
  const [aspectRatio, setAspectRatio] = useState<StartChoices['aspect']>('9:16');
  /*
    SPEC 02 §4.3: Custom opens a pair of ratio inputs, each 1–32.
    Held as strings so a half-typed number is not coerced to 0 mid-keystroke; resolved on create.
  */
  const [customAspect, setCustomAspect] = useState({ width: '4', height: '5' });
  const [captionStyle, setCaptionStyle] = useState('bold-creator');
  const [clipLength, setClipLength] = useState<StartClipLength>('medium');
  /* SPEC 02 §4.5: Custom is a two-handle range, 10 s to 10 min. Defaults to the Medium preset. */
  const [customLength, setCustomLength] = useState({ min: '30', max: '60' });
  /*
    The tile is held as the tile, not as the number it resolves to.

    `Number('custom')` is NaN, and a NaN count is rejected by the schema's integer check — the same
    shape of failure this page was already making. Keeping the id and resolving it in one place
    means the Custom tile has somewhere to put its value instead of a `NaN` in the store.
  */
  const [clipCountTile, setClipCountTile] = useState('auto');
  const [customClipCount, setCustomClipCount] = useState(5);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [clipFocus, setClipFocus] = useState('');
  const [contentType, setContentType] = useState<StartChoices['contentType']>('auto');
  const [language, setLanguage] = useState('auto');
  const [processingMode, setProcessingMode] = useState<StartChoices['processingMode']>('automatic');
  const [downloadQuality, setDownloadQuality] = useState<StartChoices['downloadQuality']>('1080p');
  const [storageMode, setStorageMode] = useState<StartChoices['storageMode']>('copy');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [recent, setRecent] = useState<ProjectRecord[]>([]);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void api
      .listProjects()
      .then((list) => {
        if (cancelled) return;
        setRecent(
          [...list]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 8)
        );
      })
      .catch(() => {
        /* the recent row stays empty — errors surface on the Projects page */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [urlInput, setUrlInput] = useState('');
  const [urlState, setUrlState] = useState<'idle' | 'checking' | 'ready' | 'failed'>('idle');
  const [urlError, setUrlError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setUrlError('Please drop a video file.');
      return;
    }
    const ext = file.name.split('.').pop() || '';
    if (!['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg'].includes(ext.toLowerCase())) {
      setUrlError('Unsupported video format.');
      return;
    }
    setUrlError('');
    setUrlState('idle');
    setSource({
      name: file.name,
      path: file.path,
      size: file.size,
      duration: 0,
    });
    setProjectName(file.name.replace(/\.[^.]+$/, ''));
  }, []);

  const handleUrlPaste = useCallback(async () => {
    const clipboardText = await navigator.clipboard.readText().catch(() => '');
    if (clipboardText.trim()) {
      setUrlInput(clipboardText.trim());
    }
  }, []);

  const handleUrlChange = useCallback((val: string) => {
    setUrlInput(val);
    setUrlState('idle');
    setUrlError('');
    setSource(null);

    const trimmed = val.trim();
    if (!trimmed) { setUrlState('idle'); return; }

    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      setUrlState('failed');
      setUrlError('URL must start with http:// or https://');
      return;
    }

    setUrlState('checking');
    void (async () => {
      try {
        const info = await api.probeUrl(trimmed);
        const title = 'title' in info && typeof info.title === 'string' ? info.title : urlHost(trimmed);
        setSource({
          name: title,
          path: trimmed,
          size: 'sizeBytes' in info ? Number(info.sizeBytes) || 0 : 0,
          duration: 'durationUs' in info ? Math.round(Number(info.durationUs) / 1_000_000) : 0,
        });
        setProjectName(title);
        setUrlState('ready');
      } catch (err) {
        setUrlState('failed');
        setUrlError(describeError(err));
      }
    })();
  }, []);

  const handleBrowse = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileDrop({ preventDefault: () => {}, dataTransfer: { files: [file] } } as any);
    }
  }, [handleFileDrop]);

  const canCreate = source !== null || (urlState === 'ready' && urlInput.trim());

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setIsCreating(true);
    setCreateError('');
    try {
      /*
        Schema keys, built by the shared module rather than spelled here.

        This page used to send `aspectRatio`, `captionStyle`, `clipLength` and `storageMode: 'copy'`.
        None are settings keys: `copy` is not in the storage enum, so `ProjectRecordSchema.parse`
        threw and **no project could be created at all**; the other three were passed through by the
        schema and read by nobody, so 4:3 or Karaoke or Short were silently ignored. Keeping the
        mapping in `@clipwright/project-schema/start-settings` is what lets it have a test that runs without a
        window — the reason this went unnoticed is that nothing ever checked the two sides agreed.
      */
      const project = await api.createProject({
        name: projectName.trim() || 'Untitled project',
        settings: {
          ...startSettings({
            aspect: aspectRatio,
            ...(aspectRatio === 'custom'
              ? { customAspect: { width: Number(customAspect.width), height: Number(customAspect.height) } }
              : {}),
            captionStyleId: captionStyle,
            clipLength,
            ...(clipLength === 'custom'
              ? { clipLengthRangeSec: [Number(customLength.min), Number(customLength.max)] as [number, number] }
              : {}),
            clipCount:
              clipCountTile === 'auto' ? 'auto' : clipCountTile === 'custom' ? customClipCount : Number(clipCountTile),
            contentType,
            language,
            processingMode,
            downloadQuality,
            storageMode,
            clipFocus: clipFocus.trim(),
          }),
          sourcePath: source?.path ?? urlInput.trim(),
        },
      });
      onNavigate({ name: 'project', id: project.id, stage: 'import' });
    } catch (err) {
      setCreateError(describeError(err));
    } finally {
      setIsCreating(false);
    }
    /*
      Every setting is a dependency.

      The array held only the source and the navigation, so the callback was memoised on the first
      render and closed over the *initial* values: a user could pick 4:3, Karaoke and Short and the
      payload would still say 9:16, bold-creator and medium. With the wrong key names as well, the
      two bugs hid each other — nothing read the values, so nothing noticed they were stale.
    */
  }, [
    canCreate,
    source,
    urlState,
    urlInput,
    onNavigate,
    projectName,
    aspectRatio,
    customAspect,
    captionStyle,
    clipLength,
    customLength,
    clipCountTile,
    customClipCount,
    clipFocus,
    contentType,
    language,
    processingMode,
    downloadQuality,
    storageMode,
  ]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canCreate) {
      handleCreate();
    }
  }, [canCreate, handleCreate]);

  return (
    <div
      onKeyDown={handleKeyDown}
      style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '40px 24px',
        gap: 24,
      }}
    >
      {/* Hero */}
      <div style={{ textAlign: 'center', maxWidth: 1200, width: '100%' }}>
        <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
          Turn a long video into clips.
        </h1>
        <p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-secondary)', margin: 0 }}>
          Drop a video or paste a link.
        </p>
      </div>

      {/* Source area */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleFileDrop}
        style={{
          width: '100%',
          maxWidth: 1200,
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--line-default)',
          padding: 24,
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        {!source ? (
          <>
            {/* Drop zone */}
            <div
              onClick={handleBrowse}
              style={{
                flex: 1,
                minWidth: 300,
                border: '2px dashed var(--line-default)',
                borderRadius: 'var(--radius-md)',
                padding: '32px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                transition: 'border-color var(--dur-fast)',
              }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-md)', fontWeight: 500 }}>
                Drop a video here or <span style={{ color: 'var(--text-brand)' }}>Browse</span>
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                MP4, MOV, MKV, WebM, AVI
              </span>
            </div>

            {/* URL field */}
            <div style={{ flex: 1, minWidth: 300 }}>
              <input
                type="text"
                value={urlInput}
                onChange={(e) => handleUrlChange(e.target.value)}
                onPaste={handleUrlPaste}
                placeholder="Paste a video link"
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  border: '1px solid var(--line-default)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-raised)',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--fs-sm)',
                }}
              />
              {urlState === 'checking' && (
                <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="spinner" style={{ width: 12, height: 12, border: '2px solid var(--line-default)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite', display: 'inline-block' }} />
                  Checking link…
                </div>
              )}
              {urlState === 'failed' && (
                <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'var(--fs-xs)' }}>{urlError}</div>
              )}
              {urlState === 'ready' && (
                <div style={{ marginTop: 8, color: 'var(--success)', fontSize: 'var(--fs-xs)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                  Link ready — {urlHost(urlInput)}
                </div>
              )}
            </div>
          </>
        ) : (
          /* Source summary */
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
            <div style={{
              width: 64,
              height: 36,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--line-default)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: 'var(--fs-xs)',
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-md)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {source.name}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                {source.size > 0 ? formatBytes(source.size) : ''}
                {source.duration > 0 && ` · ${formatDuration(source.duration)}`}
              </div>
            </div>
            <button
              onClick={() => { setSource(null); setUrlInput(''); setUrlState('idle'); }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                fontSize: 18,
                padding: 4,
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Setting cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, width: '100%', maxWidth: 1200 }}>
        <SettingCard title="Aspect ratio">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ASPECT_RATIOS.map((r) => (
              <button
                key={r.id}
                onClick={() => setAspectRatio(r.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: aspectRatio === r.id ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                  background: aspectRatio === r.id ? 'var(--brand-tint)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{
                  width: 24,
                  height: 24 * (r.h / r.w),
                  border: '1px solid var(--text-muted)',
                  borderRadius: 2,
                }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: aspectRatio === r.id ? 'var(--text-brand)' : 'var(--text-secondary)' }}>{r.label}</span>
              </button>
            ))}
          </div>
          {aspectRatio === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <NumberField label="Custom aspect width" value={customAspect.width} onChange={(width) => setCustomAspect((pair) => ({ ...pair, width }))} min={1} max={32} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>:</span>
              <NumberField label="Custom aspect height" value={customAspect.height} onChange={(height) => setCustomAspect((pair) => ({ ...pair, height }))} min={1} max={32} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>1–32 each</span>
            </div>
          )}
        </SettingCard>

        <SettingCard title="Caption style">
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
            {CAPTION_STYLES.map((s) => (
              <button
                key={s.id}
                onClick={() => setCaptionStyle(s.id)}
                style={{
                  flexShrink: 0,
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-pill)',
                  border: captionStyle === s.id ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                  background: captionStyle === s.id ? 'var(--brand-tint)' : 'transparent',
                  color: captionStyle === s.id ? 'var(--text-brand)' : 'var(--text-secondary)',
                  fontSize: 'var(--fs-xs)',
                  cursor: 'pointer',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            Customise in editor
          </div>
        </SettingCard>

        <SettingCard title="Approximate clip length">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CLIP_LENGTHS.map((c) => (
              <button
                key={c.id}
                onClick={() => setClipLength(c.id as StartClipLength)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-pill)',
                  border: clipLength === c.id ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                  background: clipLength === c.id ? 'var(--brand-tint)' : 'transparent',
                  color: clipLength === c.id ? 'var(--text-brand)' : 'var(--text-secondary)',
                  fontSize: 'var(--fs-xs)',
                  cursor: 'pointer',
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          {clipLength === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <NumberField label="Shortest clip in seconds" value={customLength.min} onChange={(min) => setCustomLength((range) => ({ ...range, min }))} min={10} max={600} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>to</span>
              <NumberField label="Longest clip in seconds" value={customLength.max} onChange={(max) => setCustomLength((range) => ({ ...range, max }))} min={10} max={600} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>seconds</span>
            </div>
          )}
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            Target range — detection may exceed by 20%
          </div>
        </SettingCard>

        <SettingCard title="Number of clips">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CLIP_COUNTS.map((c) => (
              <button
                key={c.id}
                onClick={() => setClipCountTile(c.id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-pill)',
                  border: clipCountTile === c.id ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                  background: clipCountTile === c.id ? 'var(--brand-tint)' : 'transparent',
                  color: clipCountTile === c.id ? 'var(--text-brand)' : 'var(--text-secondary)',
                  fontSize: 'var(--fs-xs)',
                  cursor: 'pointer',
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          {clipCountTile === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <input
                type="number"
                min={1}
                max={50}
                value={customClipCount}
                aria-label="Number of clips"
                onChange={(e) => {
                  /* Clamped as it is typed: the schema refuses 0 and 51, and a number field is the
                     one control where a user can reach both. */
                  const next = Math.round(Number(e.target.value));
                  setCustomClipCount(Number.isFinite(next) ? Math.min(50, Math.max(1, next)) : 1);
                }}
                style={{ width: 72, padding: '6px 8px', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)', color: 'var(--text-primary)', fontSize: 'var(--fs-xs)' }}
              />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>1–50 clips</span>
            </div>
          )}
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            You'll still see more moments to choose from
          </div>
        </SettingCard>
      </div>

      {/* Advanced */}
      <div style={{ width: '100%', maxWidth: 1200 }}>
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            fontSize: 'var(--fs-sm)',
            padding: '8px 0',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-fast)' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Advanced
        </button>
        {showAdvanced && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, padding: '8px 0' }}>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Project name</label>
              <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)', color: 'var(--text-primary)', fontSize: 'var(--fs-sm)', marginTop: 4 }} />
            </div>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Clip focus</label>
              <textarea value={clipFocus} onChange={(e) => setClipFocus(e.target.value)} placeholder="e.g. funny moments, business advice" maxLength={300} rows={2}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)', color: 'var(--text-primary)', fontSize: 'var(--fs-sm)', marginTop: 4, resize: 'vertical' }} />
            </div>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Content type</label>
              <select value={contentType} onChange={(e) => setContentType(e.target.value as StartChoices['contentType'])}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)', color: 'var(--text-primary)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>
                <option value="auto">Auto-detect</option>
                <option value="podcast">Podcast/interview</option>
                <option value="talking">Talking head/vlog</option>
                <option value="tutorial">Tutorial/educational</option>
                <option value="gaming">Gaming/stream</option>
                <option value="lecture">Lecture/talk</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)', color: 'var(--text-primary)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>
                <option value="auto">Auto-detect</option>
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="zh">Chinese</option>
                <option value="ja">Japanese</option>
                <option value="ko">Korean</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Processing mode</label>
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                {['offline', 'online', 'automatic'].map((m) => (
                  <button key={m} onClick={() => setProcessingMode(m as StartChoices['processingMode'])}
                    style={{
                      padding: '6px 12px', borderRadius: 'var(--radius-pill)',
                      border: processingMode === m ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                      background: processingMode === m ? 'var(--brand-tint)' : 'transparent',
                      color: processingMode === m ? 'var(--text-brand)' : 'var(--text-secondary)',
                      fontSize: 'var(--fs-xs)', cursor: 'pointer', textTransform: 'capitalize',
                    }}
                  >{m}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Download quality (URL only)</label>
              <select value={downloadQuality} onChange={(e) => setDownloadQuality(e.target.value as StartChoices['downloadQuality'])}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)', color: 'var(--text-primary)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="best">Best available</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Storage</label>
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <button onClick={() => setStorageMode('copy')}
                  style={{
                    padding: '6px 12px', borderRadius: 'var(--radius-pill)',
                    border: storageMode === 'copy' ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                    background: storageMode === 'copy' ? 'var(--brand-tint)' : 'transparent',
                    color: storageMode === 'copy' ? 'var(--text-brand)' : 'var(--text-secondary)',
                    fontSize: 'var(--fs-xs)', cursor: 'pointer',
                  }}
                >Copy into library</button>
                <button onClick={() => setStorageMode('reference')}
                  style={{
                    padding: '6px 12px', borderRadius: 'var(--radius-pill)',
                    border: storageMode === 'reference' ? '2px solid var(--brand)' : '1px solid var(--line-default)',
                    background: storageMode === 'reference' ? 'var(--brand-tint)' : 'transparent',
                    color: storageMode === 'reference' ? 'var(--text-brand)' : 'var(--text-secondary)',
                    fontSize: 'var(--fs-xs)', cursor: 'pointer',
                  }}
                >Reference original</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Primary button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%', maxWidth: 1200 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          {canCreate ? '' : 'Add a video to continue'}
        </span>
        <button
          onClick={handleCreate}
          disabled={!canCreate || isCreating}
          style={{
            marginLeft: 'auto',
            padding: '10px 24px',
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: canCreate ? 'var(--brand)' : 'var(--surface-raised)',
            color: canCreate ? 'var(--on-brand)' : 'var(--text-muted)',
            fontSize: 'var(--fs-md)',
            fontWeight: 500,
            cursor: canCreate ? 'pointer' : 'not-allowed',
            opacity: canCreate ? 1 : 0.6,
            transition: 'opacity var(--dur-fast)',
          }}
        >
          {isCreating ? 'Creating…' : 'Find clips'}
        </button>
      </div>

      {createError && (
        <div
          role="alert"
          style={{
            width: '100%',
            maxWidth: 1200,
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--danger-tint)',
            border: '1px solid var(--danger)',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-sm)',
          }}
        >
          {createError}
        </div>
      )}

      {/* Recent projects */}
      <div style={{ width: '100%', maxWidth: 1200 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 'var(--fs-lg)', color: 'var(--text-primary)', margin: 0 }}>Recent projects</h3>
          <button style={{ background: 'none', border: 'none', color: 'var(--text-brand)', cursor: 'pointer', fontSize: 'var(--fs-sm)' }}
            onClick={() => onNavigate({ name: 'projects' })}>See all</button>
        </div>
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {recent.length === 0 ? (
            <div style={{
              minWidth: 200, height: 120, borderRadius: 'var(--radius-md)',
              background: 'var(--surface-raised)', border: '1px solid var(--line-subtle)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', fontSize: 'var(--fs-sm)',
            }}>
              No recent projects
            </div>
          ) : (
            recent.map((p) => (
              <button
                key={p.id}
                onClick={() => onNavigate({ name: 'project', id: p.id, stage: recentStage(p) })}
                style={{
                  minWidth: 200, height: 120, borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-card)', border: '1px solid var(--line-subtle)',
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center',
                  gap: 6, padding: 14, cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                  {p.name}
                </span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                  {p.stage}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFileInput} style={{ display: 'none' }} />
    </div>
  );
}

function SettingCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--line-default)',
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <h3 style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function urlHost(raw: string): string {
  try {
    return new URL(raw).host.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

function recentStage(p: ProjectRecord): 'import' | 'transcribe' | 'moments' | 'editor' {
  if (p.stage === 'exported' || p.stage === 'editor') return 'editor';
  if (p.stage === 'moments') return 'moments';
  if (p.stage === 'transcribe') return 'transcribe';
  return 'import';
}
