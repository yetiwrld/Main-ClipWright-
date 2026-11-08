/**
 * Spec 02 §2.5–§2.7 — shortcut parsing and dispatch.
 *
 * These two functions used to live in `main/ipc.ts`, a module no production file
 * imported: its `DEFAULT_SHORTCUTS` list paired six shortcuts with empty
 * handlers, so it proved nothing. They are pure functions over a KeyboardEvent,
 * which means they belong in the renderer — where the shortcuts are actually
 * handled — rather than next to the IPC layer they have nothing to do with.
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
        s.key.toUpperCase(),
      ].join('+');
      if (shortcut === expected) {
        event.preventDefault();
        s.handler();
        return true;
      }
    }
    return false;
  };
}
