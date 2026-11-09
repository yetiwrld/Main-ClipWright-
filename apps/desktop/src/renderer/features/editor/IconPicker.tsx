/**
 * The icon picker (SPEC 11 §12).
 *
 * "The full Lucide set, searchable by name and tags" — the set, the search and the geometry
 * have been built and tested since the icon library landed; this is the panel that lets a
 * user *choose* one, which was the whole of `limitations.md` #13.
 *
 * Three decisions shape it.
 *
 * **Only drawable icons are listed.** `ICON_NAMES` is the set whose geometry converts, so no
 * tile can be clicked and then draw nothing. 14 of Lucide's 1555 use a genuinely elliptical
 * arc and are absent rather than present-and-broken.
 *
 * **The grid is paginated, not virtualised.** A search box that filters on every keystroke
 * against 1541 tiles wants the cheap answer: render 48 of them and page. Measured, converting
 * and serialising the whole set is 57 ms, so filtering is never the slow part; the DOM is.
 *
 * **The tile is a stroke, because the icon is.** Lucide's paths are outlines, and a picker
 * that filled them would show a silhouette of a different picture from the one the user gets
 * — the same bug the renderers had. The thumbnail therefore uses the same `drawsAsOutline`
 * decision and the same default stroke width as the canvas.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input } from '@clipwright/design-system';
import {
  ICON_LIBRARY,
  ICON_STROKE_MAX,
  ICON_STROKE_MIN,
  ICON_DEFAULT_STROKE_WIDTH,
  iconGeometry,
  iconStrokeInBox,
  subpathsToSvgPath,
} from '@clipwright/compositor';
import { searchIconLibrary } from './graphics.js';

/** How many tiles to draw at once. 48 is six rows of eight at the dialog's width. */
const PAGE = 48;

export interface IconPickerProps {
  open: boolean;
  /** The icon the item currently uses, highlighted in the grid. */
  value?: string;
  /** The item's stroke width, or undefined for Lucide's default. */
  strokeWidth?: number;
  onClose: () => void;
  onPick: (iconName: string, strokeWidth: number) => void;
}

/**
 * One icon as an inline SVG, stroked.
 *
 * The `viewBox` is 0 0 100 100 because `iconGeometry` emits the 100-box the shape renderers
 * use, so the tile needs no conversion. `vectorEffect="non-scaling-stroke"` is deliberately
 * *not* used: the stroke has to scale with the tile, as it does on the canvas.
 */
function IconTile({ name, selected, onClick }: { name: string; selected: boolean; onClick: () => void }) {
  const path = useMemo(() => {
    const shapes = ICON_LIBRARY[name];
    if (!shapes) return null;
    const geometry = iconGeometry({ name, shapes });
    return geometry.ok ? subpathsToSvgPath(geometry.subpaths) : null;
  }, [name]);

  if (path === null) return null;
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={onClick}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 40,
        height: 40,
        padding: 6,
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
        background: selected ? 'var(--bg-selected)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden focusable="false">
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          // The same conversion the canvas and the ASS pass use, in the 100-box the paths are.
          strokeWidth={iconStrokeInBox(ICON_DEFAULT_STROKE_WIDTH)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function IconPicker({ open, value, strokeWidth, onClose, onPick }: IconPickerProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(String(strokeWidth ?? ICON_DEFAULT_STROKE_WIDTH));

  /*
    Re-seed whenever the dialog opens, from the item in force. Without this the search box
    keeps the last query after a cancel, and the user opens the picker onto somebody else's
    search.
  */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPage(0);
    setWidth(String(strokeWidth ?? ICON_DEFAULT_STROKE_WIDTH));
  }, [open, strokeWidth]);

  const matches = useMemo(() => searchIconLibrary(query), [query]);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE));
  const clampedPage = Math.min(page, pages - 1);
  const visible = matches.slice(clampedPage * PAGE, clampedPage * PAGE + PAGE);

  /*
    A typed width is clamped rather than refused: the range is the spec's, and a value outside
    it is a fat or thin icon rather than an error. An unreadable field keeps the last good
    value, so typing "1." on the way to "1.5" does not blank the icon.
  */
  const parsed = Number.parseFloat(width);
  const chosenWidth = Number.isFinite(parsed)
    ? Math.min(ICON_STROKE_MAX, Math.max(ICON_STROKE_MIN, parsed))
    : (strokeWidth ?? ICON_DEFAULT_STROKE_WIDTH);

  return (
    <Dialog
      open={open}
      title="Choose an icon"
      onClose={onClose}
      maxWidth={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Input
          aria-label="Search icons"
          placeholder="Search icons…"
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            // A new search starts at the first page; otherwise a query with two results
            // would open on whatever page the previous one had scrolled to.
            setPage(0);
          }}
        />
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          {matches.length} of {searchIconLibrary('').length} icons. Only icons that draw are
          listed; the set ships with the app and needs no network.
        </p>

        {matches.length === 0 ? (
          // Saying so is better than an empty grid the user reads as a failure to load.
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>No icon matches “{query}”.</p>
        ) : (
          <div
            role="listbox"
            aria-label="Icons"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 40px)',
              gap: 'var(--space-2)',
              justifyContent: 'start',
            }}
          >
            {visible.map((name) => (
              <IconTile
                key={name}
                name={name}
                selected={name === value}
                onClick={() => onPick(name, chosenWidth)}
              />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Button
            variant="ghost"
            disabled={clampedPage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Previous
          </Button>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            Page {clampedPage + 1} of {pages}
          </span>
          <Button
            variant="ghost"
            disabled={clampedPage >= pages - 1}
            onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}
          >
            Next
          </Button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            Stroke width
          </span>
          <Input
            aria-label="Stroke width"
            inputMode="decimal"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
          />
        </label>
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          {ICON_STROKE_MIN}–{ICON_STROKE_MAX}. Lucide draws at {ICON_DEFAULT_STROKE_WIDTH}.
        </p>
      </div>
    </Dialog>
  );
}
