import { describe, it, expect, vi } from 'vitest';
// The palette search now lives beside the component; the shortcut helpers are
// still main-process concerns (Spec 02 §2.6) and stay in main/ipc.ts.
import { fuzzySearch, type CommandPaletteItem } from '../components/command-palette-search.js';
import { parseShortcut, createShortcutHandler, DEFAULT_SHORTCUTS } from '../../main/ipc.js';

function item(label: string, category = 'Test'): CommandPaletteItem {
  return { id: label.toLowerCase().replace(/\s+/g, '-'), label, category, action: () => {} };
}

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => {},
    ...init,
  } as KeyboardEvent;
}

describe('fuzzySearch', () => {
  const items = [item('Open project'), item('New project'), item('Model manager'), item('Settings — Models')];

  it('returns every item for an empty query', () => {
    expect(fuzzySearch('', items)).toHaveLength(items.length);
  });

  it('matches in-order characters regardless of case', () => {
    const results = fuzzySearch('mdl', items);
    expect(results.map((r) => r.label)).toContain('Model manager');
  });

  it('excludes items that cannot be matched', () => {
    const results = fuzzySearch('zzz', items);
    expect(results).toHaveLength(0);
  });

  it('ranks stronger matches first', () => {
    const results = fuzzySearch('project', items);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].label.toLowerCase()).toContain('project');
  });
});

describe('parseShortcut', () => {
  it('normalises Ctrl+K', () => {
    expect(parseShortcut(key({ key: 'k', ctrlKey: true }))).toBe('Ctrl+K');
  });

  it('treats Cmd the same as Ctrl', () => {
    expect(parseShortcut(key({ key: 'k', metaKey: true }))).toBe('Ctrl+K');
  });

  it('includes modifiers in a stable order', () => {
    expect(parseShortcut(key({ key: 'S', ctrlKey: true, shiftKey: true, altKey: true }))).toBe('Ctrl+Alt+Shift+S');
  });

  it('handles punctuation keys', () => {
    expect(parseShortcut(key({ key: ',', ctrlKey: true }))).toBe('Ctrl+,');
  });
});

describe('createShortcutHandler', () => {
  it('fires the handler for the matching shortcut and prevents the default', () => {
    const handler = vi.fn();
    const preventDefault = vi.fn();
    const dispatch = createShortcutHandler([{ key: 'K', ctrl: true, handler }]);

    dispatch(key({ key: 'k', ctrlKey: true, preventDefault }));

    expect(handler).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('does nothing when the modifiers differ', () => {
    const handler = vi.fn();
    const dispatch = createShortcutHandler([{ key: 'K', ctrl: true, handler }]);

    dispatch(key({ key: 'k' }));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('DEFAULT_SHORTCUTS', () => {
  it('binds the documented shortcuts', () => {
    const keys = DEFAULT_SHORTCUTS.map((s) => `${s.ctrl ? 'Ctrl+' : ''}${s.key}`);
    expect(keys).toEqual(['Ctrl+K', 'Ctrl+N', 'Ctrl+O', 'Ctrl+,', 'Ctrl+/', 'Ctrl+S']);
  });
});
