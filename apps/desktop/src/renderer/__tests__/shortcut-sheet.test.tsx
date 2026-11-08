// @vitest-environment jsdom
/**
 * Spec 02 §2.6 — the Ctrl+/ cheat sheet.
 *
 * The point of these tests is the honesty rule: a shortcut listed without a
 * working implementation has to say so, because the alternative is a user
 * pressing Ctrl+O, seeing nothing happen, and concluding the app is broken.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutSheet } from '../components/ShortcutSheet.js';

afterEach(cleanup);

describe('ShortcutSheet', () => {
  it('lists the shortcuts the app implements', () => {
    render(<ShortcutSheet onClose={vi.fn()} />);
    const text = screen.getByTestId('shortcut-sheet').textContent ?? '';
    for (const keys of ['Ctrl+K', 'Ctrl+N', 'Ctrl+,', 'Ctrl+/', 'Esc']) {
      expect(text, keys).toContain(keys);
    }
  });

  it('says which listed shortcuts do nothing, rather than implying they work', () => {
    render(<ShortcutSheet onClose={vi.fn()} />);
    expect(screen.getByTestId('shortcut-unavailable-Ctrl+O').textContent).toContain('Start a project');
    expect(screen.getByTestId('shortcut-unavailable-Ctrl+S').textContent).toContain('continuous');
  });

  it('does not mark implemented shortcuts as unavailable', () => {
    render(<ShortcutSheet onClose={vi.fn()} />);
    expect(screen.queryByTestId('shortcut-unavailable-Ctrl+K')).toBeNull();
    expect(screen.queryByTestId('shortcut-unavailable-Ctrl+,')).toBeNull();
  });

  it('closes on request', () => {
    const onClose = vi.fn();
    render(<ShortcutSheet onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalled();
  });
});
