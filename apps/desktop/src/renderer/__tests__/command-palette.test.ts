import { describe, it, expect, vi } from 'vitest';
// Both now live in the renderer, where they are used.
import { fuzzySearch, type CommandPaletteItem } from '../components/command-palette-search.js';
import { parseShortcut, createShortcutHandler, type ShortcutDef } from '../components/shortcuts.js';

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

describe('createShortcutHandler', () => {
  // The old DEFAULT_SHORTCUTS test compared a list of keys against a constant
  // whose handlers were all empty — it asserted the shape of something that did
  // nothing. These drive a real handler and check the handler runs.
  const makeEvent = (init: Partial<KeyboardEvent>) =>
    ({ preventDefault: vi.fn(), ...init }) as unknown as KeyboardEvent;

  it('runs the handler for a matching shortcut', () => {
    const palette = vi.fn();
    const settings = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: 'k', ctrl: true, handler: palette },
      { key: ',', ctrl: true, handler: settings },
    ];
    const dispatch = createShortcutHandler(shortcuts);

    const handled = dispatch(makeEvent({ key: 'k', ctrlKey: true }));
    expect(handled).toBe(true);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
  });

  it('prevents the browser default only when it handles the key', () => {
    const dispatch = createShortcutHandler([{ key: 'k', ctrl: true, handler: vi.fn() }]);
    const matched = makeEvent({ key: 'k', ctrlKey: true });
    dispatch(matched);
    expect(matched.preventDefault).toHaveBeenCalled();

    const unmatched = makeEvent({ key: 'q', ctrlKey: true });
    dispatch(unmatched);
    expect(unmatched.preventDefault).not.toHaveBeenCalled();
  });

  it('does not fire a Ctrl shortcut when Ctrl is not held', () => {
    const handler = vi.fn();
    const dispatch = createShortcutHandler([{ key: 'k', ctrl: true, handler }]);
    expect(dispatch(makeEvent({ key: 'k' }))).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('distinguishes Ctrl+K from Ctrl+Shift+K', () => {
    const plain = vi.fn();
    const shifted = vi.fn();
    const dispatch = createShortcutHandler([
      { key: 'k', ctrl: true, handler: plain },
      { key: 'k', ctrl: true, shift: true, handler: shifted },
    ]);

    dispatch(makeEvent({ key: 'K', ctrlKey: true, shiftKey: true }));
    expect(shifted).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
  });
});
