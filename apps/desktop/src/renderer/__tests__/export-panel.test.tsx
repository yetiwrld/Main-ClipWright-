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

  it('tells the user what is rendered and what is still missing', () => {
    // SPEC 16's honesty rule: a user who adds a title must find out before the
    // export runs, not after waiting for a file with no title in it. Captions are
    // now rendered, so claiming otherwise would be the same failure in reverse.
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const note = screen.getByTestId('export-limits-note').textContent ?? '';
    // The note has to stay *true*, which means it changes as features land. It used
    // to say transitions were not rendered, and this test used to assert that — so
    // the test itself was holding a false claim in place. Each feature that lands
    // moves a phrase from "not rendered" to "rendered".
    expect(note).toContain('captions');
    expect(note).toContain('transitions');
    expect(note).toContain('keyframed');
    expect(note).toContain('effects');
    expect(note).not.toContain('not rendered yet');
    // The old wording said text was missing; captions are burnt in, so repeating
    // that would be the same failure pointed the other way.
    expect(note).not.toContain('Text, effects');
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
    /*
      Queried by its label, not by its position.

      These two tests used `getAllByRole('combobox')[n]`, and adding the rate-control select moved
      every index after it — both failed with a message about the *value* rather than about the
      position, which reads like a broken panel. The labels only became queryable when `Field` was
      given a `htmlFor`; before that this was the only way to reach a control, which is how the
      brittleness got in.
    */
    const onChange = vi.fn();
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={onChange}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: '16:9' } });
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
    /* The label carries the current value, so it is matched by prefix. */
    fireEvent.change(screen.getByLabelText(/^Audio bitrate/), { target: { value: '256' } });
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

describe('subtitle formats', () => {
  function renderPanel(state: ExportPanelState, onChange: (patch: Partial<ExportPanelState>) => void) {
    render(
      <ExportPanel state={state} onChange={onChange} onExport={() => {}} onCancel={() => {}} />,
    );
  }

  it('offers no format choice until saving subtitle files is on', () => {
    /* The formats only matter if a file is being written; showing them beside an off toggle
       invites a user to set something that will be ignored. */
    renderPanel({ ...DEFAULT_EXPORT_STATE, saveSubtitles: false }, () => {});
    expect(screen.queryByLabelText('SubRip (.srt)')).toBeNull();
  });

  it('offers both formats the spec names, with SRT on by default', () => {
    renderPanel({ ...DEFAULT_EXPORT_STATE, saveSubtitles: true }, () => {});
    const srt = screen.getByLabelText('SubRip (.srt)') as HTMLInputElement;
    const vtt = screen.getByLabelText('WebVTT (.vtt)') as HTMLInputElement;
    expect(srt.checked).toBe(true);
    expect(vtt.checked).toBe(false);
  });

  it('adds and removes a format without disturbing the other', () => {
    const patches: Array<Partial<ExportPanelState>> = [];
    renderPanel(
      { ...DEFAULT_EXPORT_STATE, saveSubtitles: true, subtitleFormats: ['srt'] },
      (patch) => patches.push(patch),
    );
    fireEvent.click(screen.getByLabelText('WebVTT (.vtt)'));
    expect(patches.at(-1)?.subtitleFormats).toEqual(['srt', 'vtt']);

    cleanup();
    const removals: Array<Partial<ExportPanelState>> = [];
    renderPanel(
      { ...DEFAULT_EXPORT_STATE, saveSubtitles: true, subtitleFormats: ['srt', 'vtt'] },
      (patch) => removals.push(patch),
    );
    fireEvent.click(screen.getByLabelText('SubRip (.srt)'));
    expect(removals.at(-1)?.subtitleFormats).toEqual(['vtt']);
  });
});

describe('every control can be found by name, not by position', () => {
  /*
    Two tests in this file used `getAllByRole('combobox')[n]`. Adding one select moved every index
    after it and both failed with a message about the *value* — which reads like a broken panel
    rather than a broken test. Positional queries are a standing hazard in a form that grows, and
    the fix for the labelling (§61) is what makes the alternative possible.
  */
  it('finds every select by its label', () => {
    render(
      <ExportPanel
        state={DEFAULT_EXPORT_STATE}
        onChange={() => {}}
        onExport={() => {}}
        onCancel={() => {}}
      />,
    );
    const labels: Array<string | RegExp> = [
      'Resolution',
      'Aspect ratio',
      'Frame rate',
      'Format',
      'Quality',
      'Rate control',
      'If the file already exists',
      /* The bitrate label carries its value, so it is matched by prefix. */
      /^Audio bitrate/,
    ];
    for (const label of labels) {
      expect(screen.getByLabelText(label).tagName).toBe('SELECT');
    }
  });
});
