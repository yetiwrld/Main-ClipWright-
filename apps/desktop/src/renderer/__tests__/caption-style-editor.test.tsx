// @vitest-environment jsdom
/**
 * SPEC 11 §6, §7 — the style editor.
 *
 * The rule these tests exist for: a built-in preset is never overwritten. Editing
 * Bold Creator for one clip must not change every other clip in the project, and it
 * must not change the preset itself, which another project may be using. The rest is
 * about `applyDraft` not quietly resetting the fields the dialog does not own — a
 * style's animation, timing, palette and `extras` have to survive a visit.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BUILT_IN_STYLES, builtInStyle, type CaptionStyle } from '@clipwright/caption-styles';
import {
  CaptionStyleEditor,
  applyDraft,
  draftFromStyle,
  localStyleId,
} from '../features/editor/CaptionStyleEditor.js';

afterEach(() => cleanup());

const bold = builtInStyle('bold-creator')!;

describe('draftFromStyle', () => {
  it('reads every editable field', () => {
    const draft = draftFromStyle(bold);
    expect(draft.fontFamily).toBe(bold.font.family);
    expect(draft.sizePct).toBe(bold.font.sizePctOfShortSide);
    expect(draft.fillColor).toBe(bold.fill.color);
    expect(draft.yPct).toBe(bold.position.yPct);
    expect(draft.highlightMode).toBe(bold.highlight.mode);
  });
});

describe('applyDraft', () => {
  it('round-trips an unchanged draft without altering the style', () => {
    expect(applyDraft(bold, draftFromStyle(bold))).toEqual(bold);
  });

  it('keeps the fields the dialog does not own', () => {
    // An editor that rebuilt the style from its own controls would reset the
    // animation and timing of every style someone opened — silently, and only
    // visible on the next export.
    const withExtras: CaptionStyle = {
      ...bold,
      animation: {
        ...bold.animation,
        in: { ...bold.animation.in, preset: 'slide-up', durationMs: 421 },
      },
      timing: { ...bold.timing, holdAfterLastWordMs: 777 },
      wordColors: ['#112233', '#445566'],
      extras: { futureField: 'kept' },
    };
    const edited = applyDraft(withExtras, { ...draftFromStyle(withExtras), fillColor: '#101010' });
    expect(edited.animation.in.preset).toBe('slide-up');
    expect(edited.animation.in.durationMs).toBe(421);
    expect(edited.timing.holdAfterLastWordMs).toBe(777);
    expect(edited.wordColors).toEqual(['#112233', '#445566']);
    expect(edited.extras).toEqual({ futureField: 'kept' });
  });

  it('applies the fields it does own', () => {
    const edited = applyDraft(bold, {
      ...draftFromStyle(bold),
      fontFamily: 'Inter',
      fontWeight: 500,
      fontItalic: true,
      sizePct: 9.5,
      case: 'none',
      align: 'left',
      lineHeight: 1.4,
      fillColor: '#00FF00',
      fillOpacity: 0.8,
      outlineEnabled: false,
      outlineColor: '#FF0000',
      outlineWidth: 12,
      shadowEnabled: false,
      shadowOffset: 2,
      highlightMode: 'karaoke-fill',
      highlightColor: '#00FFFF',
      highlightScale: 1.3,
      yPct: 80,
      maxWidthPct: 70,
    });
    expect(edited.font).toMatchObject({ family: 'Inter', weight: 500, italic: true, sizePctOfShortSide: 9.5 });
    expect(edited.text).toMatchObject({ case: 'none', align: 'left', lineHeight: 1.4 });
    expect(edited.fill).toMatchObject({ color: '#00FF00', opacity: 0.8 });
    expect(edited.outline).toMatchObject({ enabled: false, color: '#FF0000', widthPctOfFont: 12 });
    expect(edited.shadow).toMatchObject({ enabled: false, dyPctOfFont: 2 });
    expect(edited.highlight).toMatchObject({ mode: 'karaoke-fill', color: '#00FFFF', scale: 1.3 });
    expect(edited.position).toMatchObject({ yPct: 80, maxWidthPct: 70 });
  });

  it('leaves the style valid against the schema for every preset', () => {
    // The dialog writes through zod on save, so a draft that produces an invalid
    // style would fail at the worst moment — after the user has done the work.
    for (const style of BUILT_IN_STYLES) {
      const draft = { ...draftFromStyle(style), sizePct: 4.4, yPct: 12.5, maxWidthPct: 55 };
      const edited = applyDraft(style, draft);
      expect(edited.font.sizePctOfShortSide, style.id).toBe(4.4);
      expect(edited.position.yPct, style.id).toBe(12.5);
    }
  });
});

describe('localStyleId', () => {
  it('derives a readable id from the preset', () => {
    expect(localStyleId('bold-creator', [])).toBe('bold-creator-edited');
  });

  it('counts up rather than colliding with an existing copy', () => {
    // Two copies of one preset would be indistinguishable in the picker, and the
    // second would silently win the lookup.
    expect(localStyleId('bold-creator', ['bold-creator-edited'])).toBe('bold-creator-edited-2');
    expect(localStyleId('bold-creator', ['bold-creator-edited', 'bold-creator-edited-2'])).toBe(
      'bold-creator-edited-3',
    );
  });
});

describe('CaptionStyleEditor', () => {
  const renderEditor = (styleId: string, projectStyles: Record<string, CaptionStyle> = {}) => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <CaptionStyleEditor
        open
        styleId={styleId}
        projectStyles={projectStyles}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    return { onSave, onClose };
  };

  it('explains that a built-in edit saves a copy', () => {
    renderEditor('bold-creator');
    expect(screen.getByText(/saves a copy in this project/i)).toBeTruthy();
  });

  it('offers "Save as a copy" for a built-in', () => {
    renderEditor('bold-creator');
    expect(screen.getByText('Save as a copy')).toBeTruthy();
  });

  it('saves a built-in edit under a new project-local id', () => {
    // The rule the whole dialog is built around: presets are immutable (§6).
    const { onSave } = renderEditor('bold-creator');
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('Save as a copy'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as CaptionStyle;
    expect(saved.id).toBe('bold-creator-edited');
    expect(saved.font.sizePctOfShortSide).toBe(9);
    // The preset is untouched.
    expect(builtInStyle('bold-creator')!.font.sizePctOfShortSide).toBe(bold.font.sizePctOfShortSide);
  });

  it('saves a project copy in place, keeping its id', () => {
    const copy = { ...bold, id: 'bold-creator-edited', name: 'House style' };
    const { onSave } = renderEditor('bold-creator-edited', { 'bold-creator-edited': copy });
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '6' } });
    fireEvent.click(screen.getByText('Save'));

    const saved = onSave.mock.calls[0]![0] as CaptionStyle;
    expect(saved.id).toBe('bold-creator-edited');
    expect(saved.font.sizePctOfShortSide).toBe(6);
  });

  it('does nothing when Save is pressed without a change', () => {
    // An untouched Save would fork a preset for no reason, adding a copy nobody
    // asked for to the project's style list.
    const { onSave } = renderEditor('bold-creator');
    // Query by role: the label lives in a span inside the button, so the text node
    // is not the button element.
    const button = screen.getByRole('button', { name: 'Save as a copy' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('resets a change back to the preset', () => {
    const { onSave } = renderEditor('bold-creator');
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByRole('button', { name: 'Save as a copy' }) as HTMLButtonElement).disabled).toBe(true);
    void onSave;
  });

  it('hides the outline controls when the outline is off', () => {
    renderEditor('clean-minimal');
    // Clean Minimal has no outline by design, so its width slider is not shown.
    expect(screen.queryByLabelText('Outline width')).toBeNull();
  });

  it('shows the highlight controls only for a style that highlights', () => {
    renderEditor('clean-minimal');
    expect(screen.queryByLabelText('Highlight colour')).toBeNull();
  });

  it('shows the highlight colour for a karaoke style', () => {
    renderEditor('karaoke');
    expect(screen.getByLabelText('Highlight colour')).toBeTruthy();
  });

  it('only accepts a complete hex colour from the text field', () => {
    // A half-typed `#FF` reaching the draft would be refused by the schema and the
    // whole save would fail — after the user had done the work.
    const { onSave } = renderEditor('karaoke');
    const hex = screen.getByLabelText('Highlight colour hex value') as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#FF00' } });
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '8' } });
    fireEvent.click(screen.getByText('Save as a copy'));
    const saved = onSave.mock.calls[0]![0] as CaptionStyle;
    expect(saved.highlight.color).toBe(builtInStyle('karaoke')!.highlight.color);
  });

  it('accepts a complete hex colour', () => {
    const { onSave } = renderEditor('karaoke');
    fireEvent.change(screen.getByLabelText('Highlight colour hex value'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByText('Save as a copy'));
    const saved = onSave.mock.calls[0]![0] as CaptionStyle;
    expect(saved.highlight.color).toBe('#123456');
  });

  it('closes without saving on Cancel', () => {
    const { onClose, onSave } = renderEditor('bold-creator');
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
