/**
 * SPEC 14 §3 — Export settings panel.
 *
 * A panel opened by the Export button (Ctrl+E) that lets the user configure
 * export settings: range, resolution preset, aspect ratio, fps, format,
 * quality, audio, captions, and output location.
 */

import React, { useState } from 'react';
import {
  EXPORT_PRESETS,
  ASPECT_RATIOS,
  OUTPUT_FORMATS,
  QUALITY_PRESETS,
  EXPORT_FPS_OPTIONS,
  AUDIO_BITRATES,
  resolutionForPreset,
  DEFAULT_AUDIO_BITRATE,
} from '@clipwright/export-core';
import type { ExportPresetId, OutputFormatId, QualityPresetId, ExportFps, AudioBitrate } from '@clipwright/export-core';

export interface ExportPanelState {
  preset: ExportPresetId;
  aspect: string;
  fps: ExportFps;
  format: OutputFormatId;
  quality: QualityPresetId;
  audioBitrate: AudioBitrate;
  includeAudio: boolean;
  burnCaptions: boolean;
  saveSubtitles: boolean;
  normaliseLoudness: boolean;
  targetLufs: number;
}

export const DEFAULT_EXPORT_STATE: ExportPanelState = {
  preset: '1080p',
  aspect: '9:16',
  fps: 30,
  format: 'mp4',
  quality: 'standard',
  audioBitrate: DEFAULT_AUDIO_BITRATE,
  includeAudio: true,
  burnCaptions: true,
  saveSubtitles: false,
  normaliseLoudness: false,
  targetLufs: -16,
};

export function ExportPanel({
  state,
  onChange,
  onExport,
  onCancel,
  showHeading = true,
}: {
  state: ExportPanelState;
  onChange: (patch: Partial<ExportPanelState>) => void;
  onExport: () => void;
  onCancel: () => void;
  /** Off when a dialog already provides the title (avoids duplicate headings). */
  showHeading?: boolean;
}) {
  const resolution = resolutionForPreset(state.preset, state.aspect);
  const estimatedSizeMb = estimateFileSize(state, resolution);

  return (
    <div
      role="dialog"
      aria-label="Export settings"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        background: 'var(--surface-raised)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--line-default)',
      }}
    >
      {showHeading && <h3 style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, margin: 0 }}>Export</h3>}

      {/* Summary line */}
      <div
        style={{
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-secondary)',
          padding: 'var(--space-2)',
          background: 'var(--surface-sunken)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {resolution.width}×{resolution.height} · {state.fps} fps · {state.format.toUpperCase()} · ≈ {estimatedSizeMb} MB
      </div>

      {/* Resolution preset */}
      <Field label="Resolution">
        <select
          value={state.preset}
          onChange={(e) => onChange({ preset: e.target.value as ExportPresetId })}
          style={selectStyle}
        >
          {EXPORT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </Field>

      {/* Aspect ratio */}
      <Field label="Aspect ratio">
        <select
          value={state.aspect}
          onChange={(e) => onChange({ aspect: e.target.value })}
          style={selectStyle}
        >
          {ASPECT_RATIOS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </Field>

      {/* Frame rate */}
      <Field label="Frame rate">
        <select
          value={state.fps}
          onChange={(e) => onChange({ fps: Number(e.target.value) as ExportFps })}
          style={selectStyle}
        >
          {EXPORT_FPS_OPTIONS.map((f) => (
            <option key={f} value={f}>{f} fps</option>
          ))}
        </select>
      </Field>

      {/* Format */}
      <Field label="Format">
        <select
          value={state.format}
          onChange={(e) => onChange({ format: e.target.value as OutputFormatId })}
          style={selectStyle}
        >
          {OUTPUT_FORMATS.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
      </Field>

      {/* Quality */}
      <Field label="Quality">
        <select
          value={state.quality}
          onChange={(e) => onChange({ quality: e.target.value as QualityPresetId })}
          style={selectStyle}
        >
          {QUALITY_PRESETS.map((q) => (
            <option key={q.id} value={q.id}>{q.label}</option>
          ))}
        </select>
      </Field>

      {/* Audio bitrate */}
      <Field label={`Audio bitrate: ${state.audioBitrate} kbps`}>
        <select
          value={state.audioBitrate}
          onChange={(e) => onChange({ audioBitrate: Number(e.target.value) as AudioBitrate })}
          style={selectStyle}
        >
          {AUDIO_BITRATES.map((b) => (
            <option key={b} value={b}>{b} kbps</option>
          ))}
        </select>
      </Field>

      {/* Toggles */}
      <ToggleRow
        label="Include audio"
        checked={state.includeAudio}
        onChange={(v) => onChange({ includeAudio: v })}
      />
      <ToggleRow
        label="Burn captions into video"
        checked={state.burnCaptions}
        onChange={(v) => onChange({ burnCaptions: v })}
      />
      <ToggleRow
        label="Save subtitle files"
        checked={state.saveSubtitles}
        onChange={(v) => onChange({ saveSubtitles: v })}
      />
      <ToggleRow
        label="Normalise loudness"
        checked={state.normaliseLoudness}
        onChange={(v) => onChange({ normaliseLoudness: v })}
      />

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: 'var(--space-1) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--line-default)',
            background: 'var(--surface-card)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontSize: 'var(--fs-xs)',
          }}
        >
          Cancel
        </button>
        <button
          data-testid="export-button"
          onClick={onExport}
          style={{
            padding: 'var(--space-1) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: 'var(--brand)',
            color: 'var(--on-brand)',
            cursor: 'pointer',
            fontSize: 'var(--fs-xs)',
          }}
        >
          Export
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>{label}</label>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16 }}
      />
      {label}
    </label>
  );
}

const selectStyle: React.CSSProperties = {
  padding: 'var(--space-1)',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line-default)',
  background: 'var(--surface-card)',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-xs)',
};

/** Estimate file size in MB from bitrate and duration. */
function estimateFileSize(state: ExportPanelState, _resolution: { width: number; height: number }): number {
  // Rough estimate: video bitrate ~ quality-based, audio at selected bitrate.
  const qualityBitrates: Record<QualityPresetId, number> = {
    draft: 3,
    standard: 8,
    high: 15,
    maximum: 25,
  };
  const videoMbps = qualityBitrates[state.quality];
  const audioKbps = state.audioBitrate;
  const totalKbps = videoMbps * 1000 + audioKbps;
  // Assume 1 minute duration for estimate.
  const seconds = 60;
  const bytes = (totalKbps * 1000 * seconds) / 8;
  return Math.round(bytes / (1024 * 1024));
}
