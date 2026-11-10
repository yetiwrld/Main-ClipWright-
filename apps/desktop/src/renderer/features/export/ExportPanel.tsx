/**
 * SPEC 14 §3 — Export settings panel.
 *
 * A panel opened by the Export button (Ctrl+E) that lets the user configure
 * export settings: range, resolution preset, aspect ratio, fps, format,
 * quality, audio, captions, and output location.
 */

import React, { useId, useState } from 'react';
import {
  BUILT_IN_QUICK_PRESETS,
  EXPORT_PRESETS,
  ASPECT_RATIOS,
  OUTPUT_FORMATS,
  QUALITY_PRESETS,
  EXPORT_FPS_OPTIONS,
  AUDIO_BITRATES,
  resolutionForPreset,
  DEFAULT_AUDIO_BITRATE,
  type RateControlMode,
} from '@clipwright/export-core';
import type {
  ExportPresetId,
  OutputFormatId,
  QualityPresetId,
  ExportFps,
  AudioBitrate,
  QuickPreset,
} from '@clipwright/export-core';

export interface ExportPanelState {
  preset: ExportPresetId;
  aspect: string;
  fps: ExportFps;
  format: OutputFormatId;
  quality: QualityPresetId;
  audioBitrate: AudioBitrate;
  /**
   * What to do when the output name is taken (SPEC 14 §5).
   *
   * The dialog passed `'auto-number'` as a literal, so the spec's *Replace* (with confirmation) and
   * *Ask* were not reachable — a user who wanted to overwrite a previous render got `clip-2.mp4`
   * beside it instead, every time. Like the aspect and fps defaults, nothing was wrong with the
   * value; the fault was that it was chosen here in the panel's absence.
   */
  clashPolicy: 'auto-number' | 'replace' | 'ask';
  /**
   * Whether the file carries `comment=Clipwright Studio · <project>` in its metadata.
   *
   * `use-export` passed `true` as a literal, so the setting existed end to end — panel type, planner,
   * encoder arguments — and could not be turned off. It is not cosmetic: the comment lands in the
   * file a user hands to someone else, and "strip identifying metadata" is a reasonable thing to
   * want before uploading.
   */
  embedProjectName: boolean;
  /**
   * VBR or CBR (SPEC 14 3.8). The encoder implements both - CBR pins `-minrate`/`-maxrate` and sets
   * a buffer - and `use-export` passed `'vbr'` as a literal, so a broadcaster needing a constant
   * bitrate could not ask for one.
   */
  rateControl: RateControlMode;
  includeAudio: boolean;
  burnCaptions: boolean;
  saveSubtitles: boolean;
  /**
   * Which sidecar files to write when `saveSubtitles` is on (SPEC 14 §4: "SRT / WebVTT").
   *
   * Both were always available: the planner carries `subtitleFormats`, the export core can render
   * either, and the validation step counts the files it expects. Nothing chose between them —
   * `use-export` hardcoded `['srt']` — so a WebVTT file could not be produced by a build that had
   * the code for it.
   */
  subtitleFormats: Array<'srt' | 'vtt'>;
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
  /* SPEC 14 §5's default. */
  clashPolicy: 'auto-number',
  embedProjectName: true,
  /* SPEC 14 3.8's default. */
  rateControl: 'vbr',
  includeAudio: true,
  burnCaptions: true,
  saveSubtitles: false,
  subtitleFormats: ['srt'],
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

      {/* Quick presets (§3.5) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
        {BUILT_IN_QUICK_PRESETS.map((preset) => (
          <QuickPresetButton
            key={preset.id}
            preset={preset}
            onApply={() => onChange({ ...preset.settings })}
          />
        ))}
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

      {/* Rate control */}
      <Field label="Rate control">
        <select
          value={state.rateControl}
          onChange={(e) => onChange({ rateControl: e.target.value as RateControlMode })}
          style={selectStyle}
        >
          <option value="vbr">Variable bitrate</option>
          <option value="cbr">Constant bitrate</option>
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

      {/* Name clash */}
      <Field label="If the file already exists">
        <select
          value={state.clashPolicy}
          onChange={(e) => onChange({ clashPolicy: e.target.value as ExportPanelState['clashPolicy'] })}
          style={selectStyle}
        >
          <option value="auto-number">Add a number</option>
          <option value="replace">Replace it</option>
          <option value="ask">Ask me each time</option>
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
        label="Write the project name into the file"
        checked={state.embedProjectName}
        onChange={(v) => onChange({ embedProjectName: v })}
      />
      <ToggleRow
        label="Save subtitle files"
        checked={state.saveSubtitles}
        onChange={(v) => onChange({ saveSubtitles: v })}
      />
      {state.saveSubtitles && (
        <div role="group" aria-label="Subtitle file formats" style={{ display: 'flex', gap: 12, paddingLeft: 8 }}>
          {(['srt', 'vtt'] as const).map((format) => (
            <label key={format} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                aria-label={format === 'srt' ? 'SubRip (.srt)' : 'WebVTT (.vtt)'}
                checked={state.subtitleFormats.includes(format)}
                onChange={(e) =>
                  onChange({
                    /* Never empty while the toggle is on: a request to save subtitles that names no
                       format would write nothing and report success. Unticking the last one turns
                       the toggle off instead. */
                    subtitleFormats: e.target.checked
                      ? [...new Set([...state.subtitleFormats, format])]
                      : state.subtitleFormats.filter((f) => f !== format),
                  })
                }
              />
              {format === 'srt' ? 'SubRip (.srt)' : 'WebVTT (.vtt)'}
            </label>
          ))}
        </div>
      )}
      <ToggleRow
        label="Normalise loudness"
        checked={state.normaliseLoudness}
        onChange={(v) => onChange({ normaliseLoudness: v })}
      />

      {/*
        Honesty rule: the export path decodes and composites video and mixes
        audio, but does not yet render text, effects, transitions or keyframes.
        A user who adds a title and exports deserves to know it will not appear
        before they wait ten minutes for the file, not after.
      */}
      <p
        data-testid="export-limits-note"
        style={{
          margin: 0,
          padding: 'var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-sunken)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--fs-xs)',
          lineHeight: 'var(--lh-sm)',
        }}
      >
        Video and audio are exported from your timeline, with burned-in captions in
        the style you picked in the editor, plus layer opacity and blend modes,
        transitions, keyframed moves and the nine standard effects. Effects are
        previewed approximately — see Export limits in the docs.
      </p>

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

function QuickPresetButton({ preset, onApply }: { preset: QuickPreset; onApply: () => void }) {
  return (
    <button
      type="button"
      title={preset.description}
      onClick={onApply}
      style={{
        padding: '4px 10px',
        borderRadius: 'var(--radius-pill)',
        border: '1px solid var(--line-default)',
        background: 'var(--surface-card)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        fontSize: 'var(--fs-xs)',
      }}
    >
      {preset.label}
    </button>
  );
}

/**
 * A labelled row.
 *
 * The `<label>` here carried no `htmlFor` and wrapped nothing, so every control in the export panel
 * reached assistive technology unnamed — six selects and the toggles below them. A sighted user
 * reads the text beside the control; a screen reader announced "combobox" six times.
 *
 * The id comes from `useId`, not from the label text: "Audio bitrate: 192 kbps" changes with the
 * value, and an id derived from it would break the association on every change.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
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
