/**
 * SPEC 11 §3 — painting a caption frame onto a 2D canvas.
 *
 * This is the only place in the caption system that touches a canvas. Everything
 * it needs has already been decided by `captionFrameAt`: the rectangles, the
 * colours, the sweep fractions. So this file is a straightforward sequence of
 * `fillRect`s and `fillText`s, and the interesting logic stays testable.
 *
 * Coordinates are the frame's own — the caller sets a transform that maps canvas
 * pixels onto whatever is on screen, so the same numbers work at 1080p, at 4K and
 * in a 300 px preview.
 */
import { blockBackground, type CaptionFrame } from '@clipwright/compositor';
import type { CaptionStyle } from '@clipwright/caption-styles';

export interface PaintOptions {
  /**
   * Canvas short side, used to scale the only absolute values in a style — the
   * background radius and padding, which are specified against a 1080-px side.
   */
  canvasShortSide: number;
  /**
   * Rounding for the karaoke sweep's clip rectangle. On a scaled-down preview a
   * fractional word width is fine; on export the clip must not leave a one-pixel
   * sliver of the underlying colour, hence `ceil`.
   */
  devicePixelRatio?: number;
}

/** Builds the CSS `font` shorthand for a style at a given size. */
export function fontString(style: CaptionStyle, fontPx: number): string {
  const italic = style.font.italic ? 'italic ' : '';
  return `${italic}${style.font.weight} ${fontPx}px "${style.font.family}", sans-serif`;
}

/**
 * Measures text the way the layout engine will.
 *
 * Exported because the same measurement has to back both the layout and the
 * preview's hit-testing: if the two disagree, a word's highlight lands on its
 * neighbour.
 */
export function canvasMeasure(ctx: CanvasRenderingContext2D, style: CaptionStyle): (text: string, fontPx: number) => number {
  const cache = new Map<string, number>();
  return (text, fontPx) => {
    // Captions re-measure the same handful of words on every frame — at 60 fps
    // that is thousands of identical `measureText` calls a second.
    const key = `${fontPx}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = fontString(style, fontPx);
    const width = ctx.measureText(text).width;
    cache.set(key, width);
    return width;
  };
}

/**
 * Draws one frame.
 *
 * Order is deliberate: shadows go down with the glyphs that cast them, chips go
 * behind the text they belong to, and the karaoke overlay goes last so a sweep is
 * never hidden by a background painted afterwards.
 */
export function paintCaptionFrame(
  ctx: CanvasRenderingContext2D,
  frame: CaptionFrame,
  style: CaptionStyle,
  options: PaintOptions
): void {
  if (frame.words.length === 0) return;

  ctx.save();
  ctx.globalAlpha *= frame.opacity;
  if (frame.translateYPx !== 0) ctx.translate(0, frame.translateYPx);

  paintBackgrounds(ctx, frame, style, options);

  const { fontPx } = frame.layout;
  ctx.font = fontString(style, fontPx);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = style.outline.join;
  ctx.lineCap = 'round';

  for (const word of frame.words) {
    if (!word.visible || word.opacity <= 0) continue;

    const scaled = word.scale !== 1;
    ctx.save();
    ctx.globalAlpha *= word.opacity;

    if (scaled) {
      // Scaling around the word's own centre keeps neighbouring words where the
      // layout put them. Scaling around the block origin would shift the whole
      // line every time a word popped.
      const cx = word.rect.x + word.rect.width / 2;
      const cy = word.rect.y + word.rect.height / 2;
      ctx.translate(cx, cy);
      ctx.scale(word.scale, word.scale);
      ctx.translate(-cx, -cy);
    }

    paintWord(ctx, word, style);

    ctx.restore();
  }

  ctx.restore();
}

/** One word: shadow, outline, fill, then any karaoke sweep over the fill. */
function paintWord(
  ctx: CanvasRenderingContext2D,
  word: CaptionFrame['words'][number],
  style: CaptionStyle
): void {
  const x = word.rect.x;
  // `rect.y` is the top of the line box; the baseline sits a line-height-ish below
  // it. Using `font` metrics keeps the baseline consistent with the measurement
  // rather than depending on where each font's ascender happens to fall.
  const y = word.rect.y + word.rect.height;

  const fill = word.color ?? style.fill.color;

  if (style.outline.enabled && style.outline.widthPctOfFont > 0) {
    ctx.save();
    // A shadow under the outline would be cast twice — once by the stroke, once by
    // the fill — and the two offsets would show as a doubled edge. Only the fill
    // casts one.
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = style.outline.color;
    ctx.lineWidth = (style.outline.widthPctOfFont / 100) * word.rect.height;
    // Stroke *before* the fill so the fill covers the inner half of the stroke;
    // stroking afterwards thins every glyph by half the outline width.
    ctx.strokeText(word.text, x, y);
    ctx.restore();
  }

  if (style.shadow.enabled) {
    ctx.save();
    ctx.shadowColor = hexToRgba(style.shadow.color, style.shadow.opacity);
    ctx.shadowBlur = (style.shadow.blurPctOfFont / 100) * word.rect.height;
    ctx.shadowOffsetX = 0;
    // The shadow offsets are percentages of the *font size*, so derive the font
    // size from the word box the layout produced rather than re-deriving it here.
    ctx.shadowOffsetY = (style.shadow.dyPctOfFont / 100) * word.rect.height;
    ctx.fillStyle = fill;
    ctx.fillText(word.text, x, y);
    ctx.restore();
  } else {
    ctx.fillStyle = fill;
    ctx.fillText(word.text, x, y);
  }

  if (word.fillFraction > 0 && word.fillColor) {
    // Sweep left to right. The clip is snapped outwards so a partially filled word
    // never shows a seam between the two colours.
    const clipWidth = Math.ceil(word.rect.width * word.fillFraction) + 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, word.rect.y - word.rect.height, clipWidth, word.rect.height * 3);
    ctx.clip();
    ctx.fillStyle = word.fillColor;
    ctx.fillText(word.text, x, y);
    ctx.restore();
  }
}

/** Block background, per-line chips and per-word chips, in that order. */
function paintBackgrounds(
  ctx: CanvasRenderingContext2D,
  frame: CaptionFrame,
  style: CaptionStyle,
  options: PaintOptions
): void {
  // A per-word chip belongs to a word and is painted with it, but behind the text.
  for (const word of frame.words) {
    if (!word.background || !word.visible) continue;
    const padX = (style.background.paddingX * options.canvasShortSide) / 1080;
    const padY = (style.background.paddingY * options.canvasShortSide) / 1080;
    const radius = (style.background.radiusPx * options.canvasShortSide) / 1080;
    ctx.globalAlpha = ctx.globalAlpha;
    roundRect(
      ctx,
      word.rect.x - padX * 0.6,
      word.rect.y - padY,
      word.rect.width + padX * 1.2,
      word.rect.height + padY * 2,
      radius
    );
    ctx.fillStyle = word.background;
    ctx.fill();
  }

  if (!style.background.enabled) return;

  const fill = hexToRgba(style.background.color, style.background.opacity);

  if (style.background.perLine) {
    for (const line of frame.layout.lines) {
      const box = line.background;
      if (!box) continue;
      roundRect(ctx, box.x, box.y, box.width, box.height, box.radius);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    return;
  }

  const box = blockBackground(frame.layout, style, options.canvasShortSide);
  if (!box) return;
  roundRect(ctx, box.x, box.y, box.width, box.height, box.radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath();
  // `roundRect` is not in every Electron build's lib.dom types, and a manual path
  // is short enough that a feature test would cost more than it saves.
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * `#RRGGBB` plus an alpha, as a CSS colour.
 *
 * Styles carry colour and opacity as separate fields because the style editor
 * shows them as separate controls; the canvas wants them together.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return `rgba(255,255,255,${alpha})`;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
