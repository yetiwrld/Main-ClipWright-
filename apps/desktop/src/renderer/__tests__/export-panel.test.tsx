// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ExportPanel,
  DEFAULT_EXPORT_STATE,
  type ExportPanelState,
} from '../features/export/ExportPanel.js';

afterEach(() => cleanup());

describe('ExportPanel', () => {
  it('renders with default settings', () => {
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Export' })).toBeTruthy();
    expect(screen.getByTestId('export-button')).toBeTruthy();
  });

  it('tells the user that text and effects are not rendered yet', () => {
    // SPEC 16's honesty rule: a user who adds a title must find out before the
    // export runs, not after waiting for a file with no title in it.
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const note = screen.getByTestId('export-limits-note');
    expect(note.textContent).toContain('Text, effects');
    expect(note.textContent).toContain('transitions');
    expect(note.textContent).toContain('not rendered yet');
  });

  it('shows resolution summary', () => {
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    // 1080p preset with 9:16 aspect = 1080×1920
    expect(screen.getByText(/1080×1920/)).toBeTruthy();
  });

  it('calls onExport when export button is clicked', () => {
    const onExport = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={onExport}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('export-button'));
    expect(onExport).toHaveBeenCalled();
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onChange when preset is changed', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={onChange}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: '720p' } });
    expect(onChange).toHaveBeenCalledWith({ preset: '720p' });
  });

  it('calls onChange when aspect ratio is changed', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={onChange}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: '16:9' } });
    expect(onChange).toHaveBeenCalledWith({ aspect: '16:9' });
  });

  it('calls onChange when audio bitrate is changed', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={onChange}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const selects = screen.getAllByRole('combobox');
    // Audio bitrate is the 6th select (index 5)
    fireEvent.change(selects[5], { target: { value: '256' } });
    expect(onChange).toHaveBeenCalledWith({ audioBitrate: 256 });
  });

  it('calls onChange when include audio toggle is changed', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={onChange}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(onChange).toHaveBeenCalledWith({ includeAudio: false });
  });

  it('calls onChange when burn captions toggle is changed', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={onChange}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    expect(onChange).toHaveBeenCalledWith({ burnCaptions: false });
  });

  it('offers the five built-in quick presets', () => {
    render(
      <ExportPanel state={DEFAULT_EXPORT_STATE} onChange={() => {}} onExport={() => {}} onCancel={() => {}} />,
    );
    for (const label of [
      'Short-form vertical',
      'Landscape 1080p',
      'High quality 4K',
      'Small file for sharing',
      'Square 1080',
    ]) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
  });

  it('applies a quick preset through onChange', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel state={DEFAULT_EXPORT_STATE} onChange={onChange} onExport={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByText('Landscape 1080p'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ preset: '1080p', aspect: '16:9', fps: 30, quality: 'standard' }),
    );
  });

  it('applies the small-file preset with draft quality', () => {
    const onChange = vi.fn();
    render(
      <ExportPanel state={DEFAULT_EXPORT_STATE} onChange={onChange} onExport={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByText('Small file for sharing'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ preset: '720p', quality: 'draft', audioBitrate: 128 }),
    );
  });

  it('shows 4K resolution for 4K preset', () => {
    const state: ExportPanelState = { ...DEFAULT_EXPORT_STATE, preset: '4k-uhd', aspect: '16:9' };
    render(
      <ExportPanel
        state={state}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/3840×2160/)).toBeTruthy();
  });

  it('shows 720×1280 for 720p portrait', () => {
    const state: ExportPanelState = { ...DEFAULT_EXPORT_STATE, preset: '720p', aspect: '9:16' };
    render(
      <ExportPanel
        state={state}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/720×1280/)).toBeTruthy();
  });
});
