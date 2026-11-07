/**
 * Spec 02 §2.5 — the Ctrl+K command palette's types and search.
 *
 * These used to live in `main/ipc.ts`, which meant the renderer imported a
 * main-process module to score a list of strings. Nothing here touches Electron;
 * moving it keeps the renderer bundle free of main-process code, which is the
 * boundary the rest of the app already respects.
 */

export interface CommandPaletteItem {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

export function fuzzySearch(query: string, items: CommandPaletteItem[]): CommandPaletteItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  const scored = items.map((item) => {
    const label = item.label.toLowerCase();
    let score = 0;
    let qi = 0;
    for (let i = 0; i < label.length && qi < q.length; i++) {
      if (label[i] === q[qi]) {
        score++;
        qi++;
      }
    }
    return { item, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}
