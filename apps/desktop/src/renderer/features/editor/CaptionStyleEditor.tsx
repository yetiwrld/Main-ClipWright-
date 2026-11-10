/**
 * SPEC 11 §7 — the caption style editor.
 *
 * Editing a *preset* is not allowed: built-ins can be reset but never overwritten
 * (§6), so the first change forks the style into a project-local copy with a new id.
 * That rule is the whole reason this dialog works on a copy rather than on the item
 * — a user who tweaks Bold Creator's outline for one clip must not find every other
 * clip in the project changed too.
 *
 * The controls here are the subset that can be edited safely without a preview
 * canvas beside them: font, case, alignment, size, fill, outline, shadow, position
 * and highlight. Dragging on the canvas (SPEC 10 §8) and the eyedropper are not
 * built, and the layout says so rather than offering a control that does nothing.
 */
import React, { useMemo, useState } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import {
  Button,
  ColourPicker,
  Dialog,
  Input,
  SegmentedControl,
  Slider,
  Toggle,
  addRecentColour,
} from '@clipwright/design-system';
import {
  BUILT_IN_STYLES,
  DEFAULT_STYLE_ID,
  builtInStyle,
  type CaptionStyle,
} from '@clipwright/caption-styles';

/** The editable subset, as a flat patch against a style. */
export interface StyleDraft {
  fontFamily: string;
  fontWeight: number;
  fontItalic: boolean;
  sizePct: number;
  case: CaptionStyle['text']['case'];
  align: CaptionStyle['text']['align'];
  lineHeight: number;
  fillColor: string;
  fillOpacity: number;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidth: number;
  shadowEnabled: boolean;
  shadowOffset: number;
  highlightMode: CaptionStyle['highlight']['mode'];
  highlightColor: string;
  highlightScale: number;
  yPct: number;
  xPct: number;
  anchor: CaptionStyle['position']['anchor'];
  maxWidthPct: number;
}

/** Reads a style into the flat draft the controls bind to. */
export function draftFromStyle(style: CaptionStyle): StyleDraft {
  return {
    fontFamily: style.font.family,
    fontWeight: style.font.weight,
    fontItalic: style.font.italic,
    sizePct: style.font.sizePctOfShortSide,
    case: style.text.case,
    align: style.text.align,
    lineHeight: style.text.lineHeight,
    fillColor: style.fill.color,
    fillOpacity: style.fill.opacity,
    outlineEnabled: style.outline.enabled,
    outlineColor: style.outline.color,
    outlineWidth: style.outline.widthPctOfFont,
    shadowEnabled: style.shadow.enabled,
    shadowOffset: style.shadow.dyPctOfFont,
    highlightMode: style.highlight.mode,
    highlightColor: style.highlight.color,
    highlightScale: style.highlight.scale,
    yPct: style.position.yPct,
    xPct: style.position.xPct,
    anchor: style.position.anchor,
    maxWidthPct: style.position.maxWidthPct,
  };
}

/**
 * Applies a draft to a style.
 *
 * Only the fields the draft owns are written, so a style's timing, animation,
 * `wordColors`, `seed` and `extras` survive an edit in this dialog — an editor that
 * rebuilt the object from its own fields would quietly reset the animation of every
 * style someone opened.
 */
export function applyDraft(style: CaptionStyle, draft: StyleDraft): CaptionStyle {
  return {
    ...style,
    font: {
      ...style.font,
      family: draft.fontFamily,
      weight: draft.fontWeight,
      italic: draft.fontItalic,
      sizePctOfShortSide: draft.sizePct,
    },
    text: { ...style.text, case: draft.case, align: draft.align, lineHeight: draft.lineHeight },
    fill: { ...style.fill, color: draft.fillColor, opacity: draft.fillOpacity },
    outline: {
      ...style.outline,
      enabled: draft.outlineEnabled,
      color: draft.outlineColor,
      widthPctOfFont: draft.outlineWidth,
    },
    shadow: {
      ...style.shadow,
      enabled: draft.shadowEnabled,
      dyPctOfFont: draft.shadowOffset,
    },
    highlight: {
      ...style.highlight,
      mode: draft.highlightMode,
      color: draft.highlightColor,
      scale: draft.highlightScale,
    },
    position: {
      ...style.position,
      anchor: draft.anchor,
      xPct: draft.xPct,
      yPct: draft.yPct,
      maxWidthPct: draft.maxWidthPct,
    },
  };
}

/**
 * A project-local id for an edited copy.
 *
 * Derived from the source id and made unique against the styles already in the
 * project, because two copies of the same preset would be indistinguishable in the
 * list and the second would silently win.
 */
/**
 * The nine anchors in reading order, so the grid's cells follow the frame.
 *
 * Typed as the schema's own union rather than as strings, so a value the schema would
 * reject cannot be rendered here.
 */
const ANCHOR_CELLS: ReadonlyArray<CaptionStyle['position']['anchor']> = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export function localStyleId(baseId: string, taken: ReadonlyArray<string>): string {
  let index = 1;
  let candidate = `${baseId}-edited`;
  while (taken.includes(candidate)) {
    index += 1;
    candidate = `${baseId}-edited-${index}`;
  }
  return candidate;
}

const CASES = [
  { value: 'none', label: 'As typed' },
  { value: 'upper', label: 'UPPER' },
  { value: 'lower', label: 'lower' },
  { value: 'title', label: 'Title' },
] as const;

const ALIGNMENTS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
] as const;

const HIGHLIGHTS = [
  { value: 'none', label: 'None' },
  { value: 'current-word', label: 'Current' },
  { value: 'keywords', label: 'Keywords' },
  { value: 'karaoke-fill', label: 'Karaoke' },
  { value: 'word-by-word', label: 'Word' },
  { value: 'sequence', label: 'Sequence' },
] as const;

const FONT_FAMILIES = [
  'Manrope',
  'Inter',
  'Montserrat',
  'Poppins',
  'Anton',
  'Playfair Display',
  'Barlow Condensed',
];

export function CaptionStyleEditor({
  open,
  styleId,
  projectStyles,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The style the selected caption currently uses. */
  styleId: string;
  /** Project-local copies, so the dialog edits the copy when one exists. */
  projectStyles: Readonly<Record<string, CaptionStyle>>;
  onClose: () => void;
  onSave: (style: CaptionStyle) => void;
}) {
  const base = useMemo(
    () => projectStyles[styleId] ?? builtInStyle(styleId) ?? builtInStyle(DEFAULT_STYLE_ID)!,
    [styleId, projectStyles],
  );

  const [draft, setDraft] = useState<StyleDraft>(() => draftFromStyle(base));
  const [name, setName] = useState(base.name);
  const [editing, setEditing] = useState(false);
  /*
    Recent colours for **this dialog session**, shared by the three colour rows: a user who picks
    a fill then wants an outline a shade darker can click back to the fill instead of retyping it.
    Deliberately not persisted — SPEC 01 asks for "recent colours" and says nothing about where
    they live, and a list that survived a restart would be a preference the user never set.
  */
  const [recents, setRecents] = useState<readonly string[]>([]);
  const onCommitColour = (hex: string) => setRecents((current) => addRecentColour(current, hex));

  // Re-seed when the dialog opens on a different style, so a second open does not
  // show the previous style's values.
  const [seededFor, setSeededFor] = useState(`${styleId}:${open}`);
  const current = `${styleId}:${open}`;
  if (current !== seededFor) {
    setSeededFor(current);
    setDraft(draftFromStyle(base));
    setName(base.name);
    setEditing(false);
  }

  const isBuiltIn = Boolean(builtInStyle(styleId)) && !projectStyles[styleId];
  const patch = (changes: Partial<StyleDraft>) => {
    setDraft((previous) => ({ ...previous, ...changes }));
    setEditing(true);
  };

  const save = () => {
    const edited = applyDraft(base, draft);
    if (isBuiltIn) {
      // A built-in is never overwritten (SPEC 11 §6). The edit becomes a
      // project-local copy with its own id, which is also what keeps the change
      // local to this project.
      const id = localStyleId(styleId, Object.keys(projectStyles));
      onSave({ ...edited, id, name: name.trim() || `${base.name} (edited)` });
      return;
    }
    onSave({ ...edited, name: name.trim() || base.name });
  };

  return (
    <Dialog
      open={open}
      title="Caption style"
      onClose={onClose}
      maxWidth={620}
      footer={
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', width: '100%' }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!editing}>
            {isBuiltIn ? 'Save as a copy' : 'Save'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {isBuiltIn
            ? `Editing ${base.name} saves a copy in this project. The built-in preset stays as it was.`
            : 'Editing this project copy affects every caption that uses it.'}
        </p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Name</span>
          <Input
            value={name}
            aria-label="Style name"
            onChange={(event) => {
              setName(event.target.value);
              setEditing(true);
            }}
          />
        </label>

        <Section title="Font">
          <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Family</span>
            <select
              aria-label="Font family"
              value={draft.fontFamily}
              onChange={(event) => patch({ fontFamily: event.target.value })}
              style={selectStyle}
            >
              {FONT_FAMILIES.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          </label>
          <Labelled label={`Size — ${draft.sizePct.toFixed(1)}% of the short side`}>
            <Slider
              value={draft.sizePct}
              min={2}
              max={20}
              step={0.1}
              ariaLabel="Font size"
              formatValue={(value) => `${value.toFixed(1)}%`}
              onChange={(value) => patch({ sizePct: value })}
            />
          </Labelled>
          <Labelled label={`Weight — ${draft.fontWeight}`}>
            <Slider
              value={draft.fontWeight}
              min={100}
              max={900}
              step={100}
              ariaLabel="Font weight"
              formatValue={(value) => String(value)}
              onChange={(value) => patch({ fontWeight: value })}
            />
          </Labelled>
          <Toggle
            checked={draft.fontItalic}
            onChange={(checked) => patch({ fontItalic: checked })}
            label="Italic"
          />
        </Section>

        <Section title="Text">
          <SegmentedControl
            ariaLabel="Letter case"
            options={[...CASES]}
            value={draft.case}
            onChange={(value) => patch({ case: value as StyleDraft['case'] })}
          />
          <SegmentedControl
            ariaLabel="Alignment"
            options={[...ALIGNMENTS]}
            value={draft.align}
            onChange={(value) => patch({ align: value as StyleDraft['align'] })}
          />
          <Labelled label={`Line height — ${draft.lineHeight.toFixed(2)}`}>
            <Slider
              value={draft.lineHeight}
              min={0.8}
              max={2}
              step={0.05}
              ariaLabel="Line height"
              formatValue={(value) => value.toFixed(2)}
              onChange={(value) => patch({ lineHeight: value })}
            />
          </Labelled>
        </Section>

        <Section title="Fill and outline">
          <ColourRow
            label="Fill"
            value={draft.fillColor}
            onChange={(value) => patch({ fillColor: value })}
            ariaLabel="Fill colour"
            recents={recents}
            onCommit={onCommitColour}
          />
          <Labelled label={`Fill opacity — ${Math.round(draft.fillOpacity * 100)}%`}>
            <Slider
              value={Math.round(draft.fillOpacity * 100)}
              min={0}
              max={100}
              step={1}
              ariaLabel="Fill opacity"
              formatValue={(value) => `${value}%`}
              onChange={(value) => patch({ fillOpacity: value / 100 })}
            />
          </Labelled>
          <Toggle
            checked={draft.outlineEnabled}
            onChange={(checked) => patch({ outlineEnabled: checked })}
            label="Outline"
          />
          {draft.outlineEnabled && (
            <>
              <ColourRow
                label="Outline colour"
                value={draft.outlineColor}
                onChange={(value) => patch({ outlineColor: value })}
                ariaLabel="Outline colour"
                recents={recents}
                onCommit={onCommitColour}
              />
              <Labelled label={`Outline width — ${draft.outlineWidth.toFixed(0)}% of the font`}>
                <Slider
                  value={draft.outlineWidth}
                  min={0}
                  max={30}
                  step={1}
                  ariaLabel="Outline width"
                  formatValue={(value) => `${value}%`}
                  onChange={(value) => patch({ outlineWidth: value })}
                />
              </Labelled>
            </>
          )}
        </Section>

        <Section title="Shadow">
          <Toggle
            checked={draft.shadowEnabled}
            onChange={(checked) => patch({ shadowEnabled: checked })}
            label="Drop shadow"
          />
          {draft.shadowEnabled && (
            <Labelled label={`Offset — ${draft.shadowOffset.toFixed(0)}% of the font`}>
              <Slider
                value={draft.shadowOffset}
                min={0}
                max={30}
                step={1}
                ariaLabel="Shadow offset"
                formatValue={(value) => `${value}%`}
                onChange={(value) => patch({ shadowOffset: value })}
              />
            </Labelled>
          )}
        </Section>

        <Section title="Highlight">
          <SegmentedControl
            ariaLabel="Highlight mode"
            options={[...HIGHLIGHTS]}
            value={draft.highlightMode}
            onChange={(value) => patch({ highlightMode: value as StyleDraft['highlightMode'] })}
          />
          {draft.highlightMode !== 'none' && (
            <>
              <ColourRow
                label="Highlight colour"
                value={draft.highlightColor}
                onChange={(value) => patch({ highlightColor: value })}
                ariaLabel="Highlight colour"
                recents={recents}
                onCommit={onCommitColour}
              />
              <Labelled label={`Highlight scale — ${Math.round(draft.highlightScale * 100)}%`}>
                <Slider
                  value={Math.round(draft.highlightScale * 100)}
                  min={100}
                  max={300}
                  step={5}
                  ariaLabel="Highlight scale"
                  formatValue={(value) => `${value}%`}
                  onChange={(value) => patch({ highlightScale: value / 100 })}
                />
              </Labelled>
            </>
          )}
        </Section>

        <Section title="Position">
          {/*
            The anchor grid (SPEC 11 §6): nine cells, and the one that is lit decides
            which corner of the block the percentage fields measure from. It has to be a
            control rather than a fixed value, because `xPct`/`yPct` mean different
            points depending on it — the same 10% is 10% from the left for a left anchor
            and 10% from the right for a right one.
          */}
          <div
            role="group"
            aria-label="Anchor point"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, width: 96 }}
          >
            {ANCHOR_CELLS.map((cell) => {
              const selected = draft.anchor === cell;
              return (
                <button
                  key={cell}
                  type="button"
                  aria-label={`Anchor ${cell}`}
                  aria-pressed={selected}
                  data-testid={`anchor-cell-${cell}`}
                  title={`Anchor ${cell}`}
                  onClick={() => patch({ anchor: cell })}
                  style={{
                    width: 30,
                    height: 30,
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    border: `1px solid ${selected ? 'var(--brand)' : 'var(--line-default)'}`,
                    borderRadius: 'var(--radius-sm)',
                    background: selected ? 'var(--brand-tint)' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 1,
                      background: selected ? 'var(--brand)' : 'var(--text-muted)',
                    }}
                  />
                </button>
              );
            })}
          </div>
          <Labelled label={`Horizontal — ${Math.round(draft.xPct)}%`}>
            <Slider
              value={draft.xPct}
              min={0}
              max={100}
              step={1}
              ariaLabel="Horizontal position"
              formatValue={(value) => `${value}%`}
              onChange={(value) => patch({ xPct: value })}
            />
          </Labelled>
          <Labelled label={`Vertical — ${Math.round(draft.yPct)}%`}>
            <Slider
              value={draft.yPct}
              min={0}
              max={100}
              step={1}
              ariaLabel="Vertical position"
              formatValue={(value) => `${value}%`}
              onChange={(value) => patch({ yPct: value })}
            />
          </Labelled>
          <Labelled label={`Maximum width — ${Math.round(draft.maxWidthPct)}% of the frame`}>
            <Slider
              value={draft.maxWidthPct}
              min={20}
              max={100}
              step={1}
              ariaLabel="Maximum width"
              formatValue={(value) => `${value}%`}
              onChange={(value) => patch({ maxWidthPct: value })}
            />
          </Labelled>
        </Section>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Palette size={14} />
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            Colours are hex values, or picked from anywhere on screen with the eyedropper beside
            each swatch.
          </span>
          <span style={{ flex: 1 }} />
          <Button
            size={28}
            variant="ghost"
            icon={<RotateCcw size={12} />}
            onClick={() => {
              setDraft(draftFromStyle(base));
              setName(base.name);
              setEditing(false);
            }}
          >
            Reset
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The built-in presets, for a picker that does not need project copies. */
export const builtInStyleOptions = BUILT_IN_STYLES.map((style) => ({
  id: style.id,
  label: style.name,
}));

const selectStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-2)',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line-default)',
  background: 'var(--surface-raised)',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-sm)',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <legend
        style={{
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
          padding: 0,
        }}
      >
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

/**
 * A labelled colour field.
 *
 * This used to be its own input pair, duplicating the shared `ColourPicker` — which is why the
 * style editor was the screen that said "there is no eyedropper yet". It is now the shared
 * control, so the eyedropper (SPEC 01, §11 §8.2) and the recent colours arrive here with it.
 *
 * The one rule kept from the old version is at the call site: a caption style's colour goes into
 * the project's schema, and that schema refuses a partial hex — so `onChange` is only called with
 * a complete colour, and a half-typed `#FF` leaves the style alone instead of failing its save.
 */
function ColourRow({
  label,
  value,
  onChange,
  ariaLabel,
  recents,
  onCommit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  recents: readonly string[];
  onCommit: (hex: string) => void;
}) {
  /*
    The draft is the picker's own; this wrapper only decides what counts as a colour. `ColourRow`
    keeps its `minWidth` label so the three colour rows line up with the sliders beside them.
  */
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 96 }}>{label}</span>
      <ColourPicker
        value={value}
        ariaLabel={ariaLabel}
        recents={recents}
        onCommit={onCommit}
        onChange={(next) => {
          if (/^#[0-9A-Fa-f]{6}$/.test(next)) onChange(next.toUpperCase());
        }}
      />
    </div>
  );
}
