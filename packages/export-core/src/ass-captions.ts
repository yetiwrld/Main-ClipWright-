/**
 * SPEC 14 §4.3, SPEC 11 §3 — styled caption burn-in as an ASS script.
 *
 * The export path feeds raw yuv420p frames into ffmpeg's stdin from the main
 * process, where there is no canvas. Rather than build one (and a second, subtly
 * different text renderer to go with it), the captions are handed to ffmpeg as an
 * Advanced SubStation Alpha script and the `subtitles` filter burns them in. ffmpeg
 * renders ASS itself, with the bundled font, at the output resolution.
 *
 * ASS was chosen over SRT because it is the only subtitle format that carries what
 * a `.cwstyle` actually specifies: font family and weight, fill colour, outline
 * width and join, shadow offset, and per-word karaoke timing. An SRT burn-in would
 * have to throw all of that away and would not look like the preview.
 *
 * Everything here is a pure string transformation, so it is testable without
 * ffmpeg and diffable when a style changes.
 */
import type { CaptionStyle } from '@clipwright/caption-styles';
import {
  ICON_LIBRARY,
  drawsAsOutline,
  iconStrokeInBox,
  resolveIconItem,
  shapeBoxAt,
  shapeGeometry,
  type IconShape,
  type ShapeSubpath,
} from '@clipwright/compositor';
import { assIconOverride, assShapeDrawing, assShapeOverride } from './ass-shapes.js';

/** One word with its timing, as ASS karaoke needs it. */
export interface AssWord {
  text: string;
  startUs: number;
  endUs: number;
}

/** One caption cue on the timeline, in absolute composition time. */
export interface AssCue {
  startUs: number;
  endUs: number;
  /** The text to display. May contain line breaks from the caption's own wrapping. */
  text: string;
  /**
   * A shape drawn in ASS drawing mode instead of text (SPEC 11 §12).
   *
   * Present only on a `shape` cue. `text` is then a placeholder that must not be
   * escaped into the dialogue body — drawing mode interprets digits as coordinates, so
   * a stray label would render as a scribble.
   */
  shape?: {
    /*
      The geometry itself, not a kind to look up later. An icon item (SPEC 11 §12) has no
      `shapeKind` — its geometry comes from the icon library — and carrying a kind meant the
      exporter had to know how to resolve one, then silently dropped the item when it could
      not. Resolving where the cue is *made* means this serialiser has exactly one input shape
      and cannot be the place where an icon goes missing from a render.
    */
    geometry: ShapeSubpath[];
    /** Box in percent of frame, from the item's transform. */
    box: { x: number; y: number; width: number; height: number };
    /**
     * Whether this drawing is an icon, and so is stroked rather than filled.
     *
     * Carried on the cue rather than recomputed in the serialiser, because the serialiser
     * never sees the item — only the cue — and the preview decides the same question from the
     * item with the same function.
     */
    outline: boolean;
    /** Stroke width in `ShapeSubpath` units, already converted from the icon's 24-box. */
    strokeInBox: number;
  };
  words?: AssWord[];
  styleId?: string;
  speaker?: string;
}

export interface AssScriptOptions {
  /** Output resolution. ASS positioning is in these pixels. */
  width: number;
  height: number;
  /**
   * Styles by id, so each cue can be burnt with the style it was edited with.
   * A cue naming a style that is not here falls back to `defaultStyleId`.
   */
  styles: Readonly<Record<string, CaptionStyle>>;
  defaultStyleId: string;
  /** Extra time a caption stays up past its last word (SPEC 11 §5). */
  holdMs?: number;
}

/**
 * The ASS style name for a caption style.
 *
 * ASS style names cannot contain commas and are compared case-sensitively by
 * libass, so the id is sanitised rather than used raw. Style ids are user-editable
 * in `.cwstyle` files, which means an id with a comma is a real possibility and
 * would silently break every `Dialogue` line that referenced it.
 */
/**
 * Geometry for a shape-or-icon item, or `null` when this build cannot draw it.
 *
 * One function so the preview and the export ask the identical question. The preview calls
 * `resolveIconItem` too; if the two had their own idea of whether an icon draws, one of them
 * would show a tile the other dropped.
 */
function itemGeometry(item: { shapeKind?: string; iconName?: string; iconShapes?: readonly IconShape[] }): ShapeSubpath[] | null {
  if (item.iconName || (item.iconShapes && item.iconShapes.length > 0)) {
    const resolved = resolveIconItem(item, ICON_LIBRARY);
    return resolved.status === 'drawn' ? resolved.subpaths : null;
  }
  return shapeGeometry(item.shapeKind);
}

export function assStyleName(styleId: string): string {
  return `cw-${styleId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** `#RRGGBB` → ASS `&HBBGGRR&`. Alpha is handled separately: ASS is `&HAABBGGRR`. */
export function assColour(hex: string): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return '&H00FFFFFF&';
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const hexPart = [b, g, r].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `&H00${hexPart}&`;
}

/** ASS timestamps are `H:MM:SS.cc`, centiseconds, hours not zero-padded. */
export function assTimestamp(us: number): string {
  const totalCs = Math.max(0, Math.round(us / 10_000));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * ASS alignment codes.
 *
 * 1–3 bottom, 4–6 middle, 7–9 top; 1/4/7 left, 2/5/8 centre, 3/6/9 right. The
 * style's `position.anchor` gives both axes, and libass positions from the chosen
 * edge, so the mapping has to pair anchor-vertical with anchor-horizontal rather
 * than defaulting to bottom-centre.
 */
export function assAlignment(anchor: string): number {
  // ASS counts rows from the *bottom*: 1–3 bottom, 4–6 middle, 7–9 top. Every other
  // coordinate system in this project counts from the top, so this is the one place
  // the axis is inverted — and getting it backwards is silent, because a caption
  // simply appears at the other end of the frame.
  const vertical = anchor.includes('bottom') ? 0 : anchor.includes('top') ? 2 : 1;
  const horizontal = anchor.includes('left') ? 0 : anchor.includes('right') ? 2 : 1;
  return vertical * 3 + horizontal + 1;
}

/**
 * `\pos` for a style.
 *
 * `xPct`/`yPct` are percentages of the frame, which is what ASS `\pos` takes once
 * multiplied out. The preview places the block by its anchor, so this is the same
 * point in both renderers.
 */
export function assPosition(style: CaptionStyle, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.round((style.position.xPct / 100) * width),
    y: Math.round((style.position.yPct / 100) * height),
  };
}

/**
 * The `Style:` line for one caption style.
 *
 * Fields in order: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,
 * OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY,
 * Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR,
 * MarginV, Encoding.
 *
 * `BackColour` is the shadow colour *and* the box colour depending on
 * `BorderStyle`, which is the one genuinely confusing part of the format: with
 * `BorderStyle=3` (opaque box) the box is drawn in `BackColour` and `Outline` is
 * the padding. The style's own background is drawn per line, so this uses
 * `BorderStyle=1` and puts the shadow in `BackColour`.
 *
 * Sizes are percentages of the *canvas short side* in the style, and ASS font size
 * is in script pixels, so the same expression applies at any output resolution.
 */
export function assStyleLine(style: CaptionStyle, width: number, height: number): string {
  const shortSide = Math.min(width, height);
  const fontPx = Math.round((style.font.sizePctOfShortSide / 100) * shortSide);
  const outlinePx = style.outline.enabled ? (style.outline.widthPctOfFont / 100) * fontPx : 0;
  // ASS's `Shadow` field is an offset with no direction and no blur, so the style's
  // dy is the only part of it that can be expressed. A blurred shadow would need a
  // bitmap; this is the honest approximation and it is what the presets ask for.
  const shadowPx = style.shadow.enabled ? (style.shadow.dyPctOfFont / 100) * fontPx : 0;

  // ASS alpha is inverted: 00 is opaque, FF is transparent.
  const primaryAlpha = Math.round((1 - style.fill.opacity) * 255);
  const unspoken = assColour(style.fill.color).replace('&H00', `&H${hex2(primaryAlpha)}`);
  // `\k` reveals text in PrimaryColour and leaves the rest in SecondaryColour —
  // not the other way round, which is the natural guess and is wrong. So a karaoke
  // style puts its *highlight* in Primary and its base text in Secondary, and an
  // unspoken word is drawn in Secondary. Every other mode has no karaoke timing, so
  // both are set to the fill and the distinction never shows.
  const isKaraoke = style.highlight.mode === 'karaoke-fill';
  const primary = isKaraoke ? assColour(style.highlight.color) : unspoken;
  const secondary = isKaraoke ? unspoken : assColour(style.highlight.color);
  const outlineColour = assColour(style.outline.color);
  const backAlpha = style.shadow.enabled ? Math.round((1 - style.shadow.opacity) * 255) : 255;
  const back = assColour(style.shadow.color).replace('&H00', `&H${hex2(backAlpha)}`);

  const bold = style.font.weight >= 700 ? -1 : 0;
  const italic = style.font.italic ? -1 : 0;
  // ASS letter spacing is in pixels; the style expresses it in ems of the font.
  const spacing = (style.text.letterSpacingEm * fontPx).toFixed(1);

  const alignment = assAlignment(style.position.anchor);
  // Margins are zero: placement is done with `\pos` on every dialogue line, which
  // is absolute and needs no margin. Leaving a vertical margin here as well would
  // shift the block by the style's own y position a second time.
  const marginV = 0;
  void height;

  return [
    'Style: ' + assStyleName(style.id),
    style.font.family.replace(/,/g, ' '),
    String(fontPx),
    primary,
    secondary,
    outlineColour,
    back,
    String(bold),
    String(italic),
    '0',
    '0',
    '100',
    '100',
    spacing,
    '0',
    // BorderStyle 1 = outline + drop shadow, which is what every preset describes.
    '1',
    outlinePx.toFixed(1),
    shadowPx.toFixed(1),
    String(alignment),
    '0',
    '0',
    String(marginV),
    '1',
  ].join(',');
}

function hex2(value: number): string {
  return Math.min(255, Math.max(0, value)).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * The header and `[Events]` preamble.
 *
 * `PlayResX`/`PlayResY` are set to the output size so every style value — font
 * size, outline, margins — is in output pixels and needs no further scaling by
 * libass.
 */
export function assHeader(options: AssScriptOptions): string {
  const styles = Object.values(options.styles)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((style) => assStyleLine(style, options.width, options.height))
    .join('\n');

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    // The default is 384x288; leaving it there makes libass rescale every size by a
    // factor nobody asked for.
    `PlayResX: ${options.width}`,
    `PlayResY: ${options.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

/**
 * The `Dialogue:` line for one cue.
 *
 * A cue with word timings becomes a karaoke line: each word is preceded by
 * `\k<centiseconds>`, which makes libass light the word's `SecondaryColour` to
 * `PrimaryColour` as it is spoken — the same left-to-right sweep the preview
 * draws, done by the renderer that is already there. A cue without timings is
 * plain text for its whole span, which is what a hand-typed caption is.
 */
export function assDialogue(cue: AssCue, options: AssScriptOptions): string {
  const style = options.styles[cue.styleId ?? options.defaultStyleId] ?? options.styles[options.defaultStyleId]!;

  /*
    A shape cue is a drawing, not text. It returns before the text path for a reason
    that is easy to miss: everything below this point escapes the body and prefixes the
    style's `\an`/`\pos`, and both are wrong for a drawing. Escaping would mangle the
    drawing commands, and the style's position would move a shape that already carries
    absolute coordinates.
  */
  if (cue.shape) {
    const geometry = cue.shape.geometry;
    // No geometry means the caller already decided nothing can be drawn, and a rectangle
    // substitute would be a lie about the file's content.
    if (geometry.length === 0) return '';
    const box = {
      x: (cue.shape.box.x / 100) * options.width,
      y: (cue.shape.box.y / 100) * options.height,
      width: (cue.shape.box.width / 100) * options.width,
      height: (cue.shape.box.height / 100) * options.height,
    };
    /*
      An icon is outlined, a shape is filled — the same distinction the preview makes, read
      from the same flag. `\bord` is in script pixels, so the stroke width is scaled from the
      100-box by the same factor `assShapeDrawing` uses for the coordinates: the mean of the
      two axes, because a box that is not square would otherwise stroke one axis thicker.
    */
    const strokeColour = assColour(style.fill.color);
    const override = cue.shape.outline
      ? assIconOverride(
          (cue.shape.strokeInBox * ((box.width + box.height) / 2)) / 100,
          strokeColour,
        )
      : assShapeOverride(box, strokeColour);
    return [
      'Dialogue: ' + '0',
      assTimestamp(cue.startUs),
      assTimestamp(cue.endUs),
      assStyleName(style.id),
      '',
      '0',
      '0',
      '0',
      '',
      `${override}${assShapeDrawing(geometry, box, { square: cue.shape.outline })}`,
    ].join(',');
  }

  const holdUs = (options.holdMs ?? style.timing.holdAfterLastWordMs) * 1000;
  // The style's own lead and lag shift when a word is considered current, so the
  // karaoke clocks have to start from the shifted word starts; otherwise the
  // export lights words at a different moment from the preview.
  const endUs = cue.endUs + holdUs;

  const { x, y } = assPosition(style, options.width, options.height);
  // `\an` and `\pos` together: `\pos` alone centres on the point for every
  // alignment, so the anchor has to be restated.
  const prefix = `{\\an${assAlignment(style.position.anchor)}\\pos(${x},${y})}`;

  const speaker = cue.speaker ? `${escapeAssText(cue.speaker)}\\N` : '';

  let body: string;
  if (cue.words && cue.words.length > 0) {
    // `\kf` sweeps the colour across the word over its duration; plain `\k` jumps
    // the whole word to the new colour at once. The preview animates the sweep, so
    // `\kf` is what matches it — `\k` would look like a different caption.
    const tag = style.highlight.mode === 'karaoke-fill' ? 'kf' : 'k';
    body = cue.words
      .map((word) => {
        const durationCs = Math.max(0, Math.round((word.endUs - word.startUs) / 10_000));
        return `{\\${tag}${durationCs}}${escapeAssText(word.text)}`;
      })
      .join(' ');
  } else {
    body = escapeAssText(cue.text).replace(/\n/g, '\\N');
  }

  return [
    'Dialogue: ' + '0',
    assTimestamp(cue.startUs + Math.min(0, style.timing.leadMs * 1000)),
    assTimestamp(endUs),
    assStyleName(style.id),
    '',
    '0',
    '0',
    '0',
    '',
    `${prefix}${speaker}${body}`,
  ].join(',');
}

/**
 * Escapes the characters ASS gives special meaning.
 *
 * A literal `\N` in a caption would otherwise be read as a line break, and a brace
 * would start an override block — a caption containing `{\fs200}` would render at
 * a size the user never chose.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/**
 * A complete ASS script for a set of cues.
 *
 * Cues are sorted and written in timeline order. Empty cues are dropped rather
 * than emitted as blank dialogues, because an empty `Dialogue` still occupies the
 * renderer's time.
 */
export function buildAssScript(cues: ReadonlyArray<AssCue>, options: AssScriptOptions): string {
  /*
    A cue is kept when it has anything to *draw*, which is three cases and not two. Text and
    karaoke words were the only two considered, so every shape cue was dropped here — after
    `assCuesFromPlan` had carefully built its geometry — and a rectangle or an icon was absent
    from every render. The geometry check is what makes the drawing pass reachable; without it
    the serialiser was dead code that its own tests could not see, because they asserted the
    cue list rather than the script.
  */
  const ordered = [...cues].filter(
    (cue) =>
      cue.text.trim().length > 0 ||
      (cue.words?.length ?? 0) > 0 ||
      (cue.shape?.geometry.length ?? 0) > 0,
  );
  ordered.sort((a, b) => a.startUs - b.startUs);
  return [assHeader(options), ...ordered.map((cue) => assDialogue(cue, options)), ''].join('\n');
}

/**
 * Turns an export plan's caption items into ASS cues (SPEC 14 §4.3).
 *
 * The plan already carries each caption's segment and its style choice, so this
 * needs nothing else. Two conversions matter:
 *
 * - Times are shifted by the range start. The plan's items are in composition time,
 *   but the burned-in script is in *output* time: exporting 10 s–20 s must put the
 *   caption that starts at 12 s at 2 s into the file.
 * - Text comes from the segment, and the words come from its refs. A segment whose
 *   text is empty but whose refs are not still produces a cue, because the text may
 *   be resolved from the words at render time.
 */
export function assCuesFromPlan(
  plan: {
    rangeStartUs: number;
    items: ReadonlyArray<{
      type: string;
      startUs: number;
      durationUs: number;
      captionText?: string;
      captionSegment?: {
        text?: string;
        words?: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
        wordRefs?: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>;
        speaker?: string;
      } | null;
      captionStyleId?: string;
      /** Set on a `text` item: the whole string, with no word timings. */
      textContent?: string;
      /** Set on a `shape` item: which geometry to draw (SPEC 11 §12). */
      shapeKind?: string;
      /** Set on an icon item instead of `shapeKind`: a Lucide name, or stored children. */
      iconName?: string;
      iconShapes?: readonly IconShape[];
      iconStrokeWidth?: number;
      /** The item's resolved geometry, for a shape's box. */
      geometry?: {
        transform?: { x?: number; y?: number; scaleX?: number; scaleY?: number };
      };
    }>;
  },
  /** Words for each caption, from the transcript, keyed by word id. */
  resolveWordText?: (wordId: string) => string | undefined
): AssCue[] {
  const cues: AssCue[] = [];
  for (const item of plan.items) {
    /*
      Text items burn in the same way captions do (SPEC 11 §7, §12). A title is text on
      the canvas, and the burn-in is what draws text on the canvas in the file — so a
      text item that produced no cue would exist in the editor and vanish from the
      export, which is the divergence this whole module is arranged to prevent.

      They differ in one way only: a text item has no word timings, so it carries no
      karaoke list. Its text is the whole string.
    */
    if (item.type === 'text') {
      const text = (item.textContent ?? '').trim();
      if (text.length === 0) continue;
      cues.push({
        startUs: item.startUs - plan.rangeStartUs,
        endUs: item.startUs - plan.rangeStartUs + item.durationUs,
        text,
        styleId: item.captionStyleId,
      });
      continue;
    }
    /*
      A shape burns in as an ASS drawing (SPEC 11 §12). Without this a rectangle over a
      clip existed in the editor and not in the file, and nothing said so.

      A shape has no colour of its own, so it borrows its style's fill — the same style a
      text item would use, which keeps one answer to "what colour is this" instead of a
      field the style editor does not know about.
    */
    if (item.type === 'shape') {
      const geometry = itemGeometry(item);
      /*
        An item whose geometry does not resolve is skipped *silently* here, which needs the
        reason written down. It is not silence: `itemGeometry` is the same resolution the
        preview paints with, so an icon that cannot draw is absent from the editor too — the
        user sees it missing where they added it rather than discovering it in the export. A
        burn-in that invented a placeholder would hide the problem instead.
      */
      if (!geometry) continue;
      cues.push({
        startUs: item.startUs - plan.rangeStartUs,
        endUs: item.startUs - plan.rangeStartUs + item.durationUs,
        // Drawing mode treats every character as geometry, so the body is empty.
        text: '',
        styleId: item.captionStyleId,
        shape: {
          geometry,
          box: shapeBoxAt(item.geometry?.transform),
          outline: drawsAsOutline(item),
          strokeInBox: iconStrokeInBox(item.iconStrokeWidth),
        },
      });
      continue;
    }
    if (item.type !== 'caption') continue;
    const segment = item.captionSegment;
    // `captionText` is the plan's own copy and survives a segment whose `text` was
    // emptied by an edit; checking only the segment would drop a caption that the
    // sidecar generator still writes out.
    const text = (segment?.text?.trim() || item.captionText?.trim() || '').trim();
    const refs = segment?.wordRefs ?? segment?.words ?? [];

    // A ref's own text wins (it is a per-caption edit); otherwise the transcript
    // supplies it. Without either, the word has no text and cannot be karaoke'd.
    const words: AssWord[] = [];
    for (const ref of refs) {
      const wordText = ref.textOverride ?? resolveWordText?.(ref.wordId);
      if (!wordText) continue;
      words.push({
        text: wordText,
        startUs: ref.startUs - plan.rangeStartUs,
        endUs: ref.endUs - plan.rangeStartUs,
      });
    }

    if (text.length === 0 && words.length === 0) continue;

    cues.push({
      startUs: item.startUs - plan.rangeStartUs,
      endUs: item.startUs - plan.rangeStartUs + item.durationUs,
      text,
      // Karaoke only makes sense when every word has text; a partial list would
      // silently drop words from the burn-in.
      words: words.length === refs.length && words.length > 0 ? words : undefined,
      speaker: segment?.speaker,
      // Without this every caption burns in with the default style, so a
      // composition using Karaoke exports in Bold Creator's look — the caption is
      // there, just not the one that was designed.
      styleId: item.captionStyleId,
    });
  }
  return cues;
}
