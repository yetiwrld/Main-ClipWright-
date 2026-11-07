/**
 * Spec 02 §2.5 — Ctrl+K Command Palette
 * Spec 02 §2.6 — Global Shortcuts
 * Spec 02 §2.7 — First Run Setup
 */

export interface ShortcutDef {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: () => void;
}

export function parseShortcut(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.key.toUpperCase());
  return parts.join('+');
}

export function createShortcutHandler(shortcuts: ShortcutDef[]) {
  return (event: KeyboardEvent) => {
    const shortcut = parseShortcut(event);
    for (const s of shortcuts) {
      const expected = [
        ...(s.ctrl ? ['Ctrl'] : []),
        ...(s.alt ? ['Alt'] : []),
        ...(s.shift ? ['Shift'] : []),
        s.key,
      ].join('+');
      if (shortcut === expected) {
        s.handler();
        event.preventDefault();
        return;
      }
    }
  };
}

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { key: 'K', ctrl: true, handler: () => {} },
  { key: 'N', ctrl: true, handler: () => {} },
  { key: 'O', ctrl: true, handler: () => {} },
  { key: ',', ctrl: true, handler: () => {} },
  { key: '/', ctrl: true, handler: () => {} },
  { key: 'S', ctrl: true, handler: () => {} },
];
