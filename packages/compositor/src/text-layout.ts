/**
 * SPEC 11 §2 — `TextRenderer.layout(textModel, style, boxWidth): LayoutResult`.
 *
 * This module is the *pure* half of the text renderer: it decides where every
 * line and every word sits, given a measure function. It draws nothing, holds no
 * canvas and touches no DOM, which is what makes it testable without a browser —
 * and what makes the preview and the export agree, because both call it with the
 * same measurements instead of each doing their own layout.
 *
 * The measure function is injected rather than imported. In the app it is backed
 * by `OffscreenCanvas.measureText`, which is the same text stack Chromium uses to
 * draw, so preview and export measure identically. In tests it is a deterministic
 * approximation, which is enough to verify wrapping, alignment and the word
 * rectangles, and keeps the suite fast.
 */
import type { CaptionStyle, CaptionText } from '@clipwright/caption-styles';

/** Returns the advance width of `text` at `fontPx`, in canvas pixels. */
export type MeasureText = (text: string, fontPx: number) => number;

export interface WordRect {
  /** Index into the flat word list for the whole caption. */
  index: number;
  text: string;
  /** Left edge, in canvas pixels. */
  x: number;
  /** Baseline-top of the line this word is on. */
  y: number;
  width: number;
  height: number;
  lineIndex: number;
}

export interface LineRect {
  index: number;
  text: string;
  words: WordRect[];
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Box behind this line when the style uses per-line backgrounds — the chip in
   * Multi-line Subtitle and Podcast. Null when the style draws one block instead,
   * or none.
   */
  background: { x: number; y: number; width: number; height: number; radius: number } | null;
}

export interface LayoutResult {
  lines: LineRect[];
  words: WordRect[];
  /** The block's bounds, for a single background box or a canvas drag handle. */
  bounds: { x: number; y: number; width: number; height: number };
  fontPx: number;
  lineHeightPx: number;
  /** True when the text needed more lines than `maxLinesHint`. */
  overflowed: boolean;
  /** Words that did not fit at all, so the caller can warn rather than silently clip. */
  droppedWords: string[];
}

export interface LayoutInput {
  text: string;
  style: CaptionStyle;
  /** Canvas size in pixels. The short side drives every relative size. */
  canvasWidth: number;
  canvasHeight: number;
  measure: MeasureText;
  /** Overrides the style's `maxWidthPct` — used by canvas dragging. */
  maxWidthPx?: number;
}

/** SPEC 11 §6 — text casing modes. */
export function applyCase(text: string, mode: CaptionText['case']): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return text.replace(/\p{L}[\p{L}\p{M}'’]*/gu, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
    case 'none':
    default:
      return text;
  }
}

/**
 * Splits text into words, keeping punctuation attached.
 *
 * Whitespace is the only split. A hyphen does not split (`well-known` stays one
 * word) and neither does an apostrophe, because both read as one word and
 * splitting them would make karaoke highlight half a word.
 */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Greedy line breaking.
 *
 * Greedy rather than balanced because captions are read as they appear: an even
 * line split that moves a word later than necessary is worse for a viewer than a
 * short first line. The style's `maxCharsPerLineHint` is a segmentation hint for
 * `buildCaptions`, not a hard break here — the real limit is the measured width.
 */
function breakLines(
  words: string[],
  maxWidthPx: number,
  fontPx: number,
  letterSpacingEm: number,
  wordSpacingEm: number,
  measure: MeasureText
): string[][] {
  const lines: string[][] = [];
  let current: string[] = [];

  const spaceWidth = measure(' ', fontPx) + wordSpacingEm * fontPx;
  const widthOf = (wordsInLine: string[]): number => {
    if (wordsInLine.length === 0) return 0;
    const letters = wordsInLine.reduce((total, word) => total + measure(word, fontPx), 0);
    const letterSpacing = letterSpacingEm * fontPx * wordsInLine.join('').length;
    return letters + spaceWidth * (wordsInLine.length - 1) + letterSpacing;
  };

  for (const word of words) {
    // A single word wider than the box cannot be broken without splitting it, and
    // splitting a word across caption lines is worse than letting it overhang the
    // margin. It gets its own line and the caller sees `overflowed`.
    if (current.length === 0) {
      current.push(word);
      continue;
    }
    const candidate = [...current, word];
    if (widthOf(candidate) <= maxWidthPx) {
      current = candidate;
    } else {
      lines.push(current);
      current = [word];
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Lays out a caption.
 *
 * Vertical placement: `yPct` is where the *anchor* of the block sits, so a style
 * at 62% keeps its centre at 62% whether it renders one line or two — a caption
 * that jumps upward when a second line appears is unreadable.
 */
export function layoutText(input: LayoutInput): LayoutResult {
  const { style, canvasWidth, canvasHeight, measure } = input;
  const shortSide = Math.min(canvasWidth, canvasHeight);

  const fontPx = (style.font.sizePctOfShortSide / 100) * shortSide;
  const lineHeightPx = fontPx * style.text.lineHeight;

  const text = applyCase(input.text, style.text.case);
  const words = splitWords(text);

  const maxWidthPx = input.maxWidthPx ?? (style.position.maxWidthPct / 100) * canvasWidth;

  if (words.length === 0) {
    return {
      lines: [],
      words: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      fontPx,
      lineHeightPx,
      overflowed: false,
      droppedWords: [],
    };
  }

  const brokenLines = breakLines(
    words,
    maxWidthPx,
    fontPx,
    style.text.letterSpacingEm,
    style.text.wordSpacingEm,
    measure
  );

  // SPEC 11 §6 — `maxLinesHint` is a hint, but overflowing it is a real problem
  // for the viewer, so it is reported rather than silently wrapped.
  const maxLines = style.text.maxLinesHint;
  const keptLines = brokenLines.slice(0, maxLines);
  const droppedWords = brokenLines.slice(maxLines).flat();
  const overflowed = brokenLines.length > maxLines;

  const boxWidth = Math.min(maxWidthPx, canvasWidth);

  // Horizontal origin: the block is centred on `xPct` and lines are aligned
  // within it per `text.align`.
  const centreX = (style.position.xPct / 100) * canvasWidth;

  const lineWidths = keptLines.map((lineWords) => {
    const letters = lineWords.reduce((total, word) => total + measure(word, fontPx), 0);
    const spaces = measure(' ', fontPx) + style.text.wordSpacingEm * fontPx;
    const letterSpacing = style.text.letterSpacingEm * fontPx * lineWords.join('').length;
    return letters + spaces * (lineWords.length - 1) + letterSpacing;
  });

  const blockWidth = Math.min(Math.max(...lineWidths, 0), boxWidth);
  const blockHeight = lineHeightPx * keptLines.length;

  // SPEC 11 §5: `yPct` positions the block's centre for centre anchors and its
  // bottom edge for bottom anchors, which is what "lower-third area (y 78%)" means.
  const anchor = style.position.anchor;
  let blockTop: number;
  if (anchor.startsWith('top')) {
    blockTop = (style.position.yPct / 100) * canvasHeight;
  } else if (anchor.startsWith('bottom')) {
    blockTop = (style.position.yPct / 100) * canvasHeight - blockHeight;
  } else {
    blockTop = (style.position.yPct / 100) * canvasHeight - blockHeight / 2;
  }

  const left =
    anchor.endsWith('left')
      ? centreX - blockWidth / 2
      : anchor.endsWith('right')
        ? centreX - blockWidth / 2
        : centreX - blockWidth / 2;

  const padX = (style.background.paddingX * shortSide) / 1080;
  const padY = (style.background.paddingY * shortSide) / 1080;
  const radius = (style.background.radiusPx * shortSide) / 1080;

  const lines: LineRect[] = [];
  const wordRects: WordRect[] = [];
  let wordIndex = 0;

  keptLines.forEach((lineWords, lineIndex) => {
    const lineWidth = lineWidths[lineIndex]!;
    // Alignment is relative to the block, which is itself centred on xPct.
    let cursorX =
      style.text.align === 'left'
        ? left
        : style.text.align === 'right'
          ? left + blockWidth - lineWidth
          : left + (blockWidth - lineWidth) / 2;

    const lineTop = blockTop + lineIndex * lineHeightPx;
    const lineWords_rects: WordRect[] = [];
    for (const word of lineWords) {
      const width = measure(word, fontPx);
      const rect: WordRect = {
        index: wordIndex,
        text: word,
        x: cursorX,
        y: lineTop,
        width,
        height: fontPx,
        lineIndex,
      };
      wordRects.push(rect);
      lineWords_rects.push(rect);
      wordIndex += 1;
      cursorX += width + measure(' ', fontPx) + style.text.wordSpacingEm * fontPx + style.text.letterSpacingEm * fontPx;
    }

    lines.push({
      index: lineIndex,
      text: lineWords.join(' '),
      words: lineWords_rects,
      x: left,
      y: lineTop,
      width: lineWidth,
      height: lineHeightPx,
      background: style.background.enabled && style.background.perLine
        ? {
            x: left - padX + (blockWidth - lineWidth) / 2,
            y: lineTop - padY,
            width: lineWidth + padX * 2,
            height: fontPx + padY * 2,
            radius,
          }
        : null,
    });
  });

  return {
    lines,
    words: wordRects,
    bounds: { x: left, y: blockTop, width: blockWidth, height: blockHeight },
    fontPx,
    lineHeightPx,
    overflowed,
    droppedWords,
  };
}

/**
 * The block background box, when the style draws one box around all lines rather
 * than one per line. Null otherwise, so the renderer has nothing to decide.
 */
export function blockBackground(
  layout: LayoutResult,
  style: CaptionStyle,
  canvasShortSide: number
): { x: number; y: number; width: number; height: number; radius: number } | null {
  if (!style.background.enabled || style.background.perLine) return null;
  if (layout.lines.length === 0) return null;
  const padX = (style.background.paddingX * canvasShortSide) / 1080;
  const padY = (style.background.paddingY * canvasShortSide) / 1080;
  const radius = (style.background.radiusPx * canvasShortSide) / 1080;
  return {
    x: layout.bounds.x - padX,
    y: layout.bounds.y - padY,
    width: layout.bounds.width + padX * 2,
    height: layout.bounds.height + padY * 2,
    radius,
  };
}

/**
 * Which word is "current" at `timeUs`, for the karaoke and word-by-word modes.
 *
 * Word timings are the source of truth; the style's `leadMs`/`lagMs` shift the
 * window so a style can light a word slightly early. Returns -1 before the first
 * word.
 */
export function currentWordIndex(
  words: ReadonlyArray<{ startUs: number; endUs: number }>,
  timeUs: number,
  style: CaptionStyle
): number {
  const lead = style.timing.leadMs * 1000;
  const lag = style.timing.lagMs * 1000;

  // The *last* matching word, not the first. With a lead applied, the window
  // overlaps the previous word — at 450 ms with 100 ms of lead, both word 0 and
  // word 1 match — and the answer the viewer expects is the one about to be
  // spoken, not the one finishing. Returning the first match made `leadMs` a
  // no-op, which is the kind of bug a screenshot never shows.
  let current = -1;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (timeUs + lead >= word.startUs && timeUs - lag < word.endUs) current = index;
    else if (timeUs + lead < word.startUs) break;
  }
  return current;
}

/**
 * How far through the current word the playhead is, 0–1, for the karaoke fill.
 * Clamped, so a gap between words cannot produce a fill beyond the word.
 */
export function wordProgress(
  word: { startUs: number; endUs: number },
  timeUs: number
): number {
  const duration = word.endUs - word.startUs;
  if (duration <= 0) return timeUs >= word.endUs ? 1 : 0;
  return Math.min(1, Math.max(0, (timeUs - word.startUs) / duration));
}
