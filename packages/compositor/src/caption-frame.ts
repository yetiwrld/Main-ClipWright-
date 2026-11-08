/**
 * SPEC 11 §3, §5, §7 — what a caption looks like at one instant.
 *
 * The preview and the export must agree frame for frame, and the only reliable
 * way to get that is for both to ask the same pure function. Everything here is
 * therefore a decision, never a drawing: the result says which words are visible,
 * what colour each is, how far its karaoke fill has run and how big it is. Filling
 * a rectangle is left to the caller, because that is the part that needs a canvas.
 *
 * The highlight modes are not variations on one idea — they disagree about what
 * the word "visible" even means. `word-by-word` shows exactly one word and the
 * rest must vanish; `karaoke-fill` shows the whole line at reduced opacity and
 * sweeps a colour across the spoken word; `keywords` ignores the clock entirely
 * and lights whatever the user marked. Collapsing those into a single "highlight
 * the current word" branch is how a style gallery ends up with three presets that
 * look the same.
 */
import type { CaptionStyle } from '@clipwright/caption-styles';
import {
  currentWordIndex,
  layoutText,
  wordProgress,
  type LayoutResult,
  type MeasureText,
  type WordRect,
} from './text-layout.js';

/** Per-word overrides that change appearance but not timing (SPEC 11 §7). */
export interface CaptionWordOverride {
  emphasis?: boolean;
  color?: string;
  scale?: number;
}

/** A word as one rendered frame should draw it. */
export interface CaptionFrameWord {
  /** Index into the caption's own word list — what overrides are keyed by position. */
  index: number;
  text: string;
  /** Where to draw it, in canvas pixels. `width` is the unwrapped word width. */
  rect: WordRect;
  /**
   * False when the style shows only the current word and this is not it. The
   * caller must not draw invisible words at zero opacity — a `word-by-word` style
   * would still reserve their space and centre the line wrongly.
   */
  visible: boolean;
  /** Multiply into the painter's global alpha. */
  opacity: number;
  /** Colour to draw in, or `null` to use the style's `fill.color`. */
  color: string | null;
  /**
   * How far a karaoke fill has swept this word, 0–1. The caller draws the word in
   * `fill.color` then clips a copy in `color` to `rect.x + rect.width * fillFraction`.
   * A single colour cannot express a half-swept word, which is why this exists.
   */
  fillFraction: number;
  /** Colour of the swept part of the word, or `null` when nothing has swept. */
  fillColor: string | null;
  /** A chip to paint behind the word, or `null`. */
  background: string | null;
  /** > 1 for an emphasised word the style scales up. */
  scale: number;
}

export interface CaptionFrame {
  layout: LayoutResult;
  words: CaptionFrameWord[];
  /** Opacity of the whole block, from the `in`/`out` animation. */
  opacity: number;
  /** Vertical offset in pixels, from a slide animation. */
  translateYPx: number;
  /** Words the layout could not fit. Non-empty means the caption is being clipped. */
  droppedWords: string[];
}

export interface CaptionWordTiming {
  startUs: number;
  endUs: number;
}

export interface CaptionFrameInput {
  /** The caption's visible text, already resolved from its word refs. */
  text: string;
  style: CaptionStyle;
  /** Timings for the words of `text`, in the same order. */
  wordTimings: ReadonlyArray<CaptionWordTiming>;
  /**
   * Word ids in `text` order, parallel to `wordTimings`. Overrides are keyed by
   * id so a re-timed caption keeps its emphasis.
   */
  wordIds?: ReadonlyArray<string>;
  overrides?: Readonly<Record<string, CaptionWordOverride>>;
  /** The caption segment's own bounds; the in/out animation is relative to them. */
  segment: { startUs: number; endUs: number };
  timeUs: number;
  canvasWidth: number;
  canvasHeight: number;
  measure: MeasureText;
}

/**
 * Builds one frame.
 *
 * Text is laid out once, then decorated: wrapping is a property of the words and
 * the box, while highlight and animation are properties of the clock. Doing them
 * in the other order would mean laying out the visible subset, and a
 * `word-by-word` caption would jump around as each word took its turn.
 */
export function captionFrameAt(input: CaptionFrameInput): CaptionFrame {
  const { style, timeUs, segment } = input;

  const layout = layoutText({
    text: input.text,
    style,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    measure: input.measure,
  });

  const index = currentWordIndex(input.wordTimings, timeUs, style);
  const last = input.wordTimings[input.wordTimings.length - 1];
  // The last word stays up for `holdAfterLastWordMs` after it is spoken. Without
  // it the caption vanishes on the final syllable, which reads as a glitch and
  // gives the viewer no time to finish the sentence.
  const holding = Boolean(last) && timeUs > last!.endUs && timeUs <= last!.endUs + style.timing.holdAfterLastWordMs * 1000;

  const words = layout.words.map((rect): CaptionFrameWord => {
    const wordIndex = rect.index;
    const timing = input.wordTimings[wordIndex];
    const wordId = input.wordIds?.[wordIndex];
    const override = wordId ? input.overrides?.[wordId] : undefined;

    const spoken = Boolean(timing) ? timeUs >= timing!.startUs : wordIndex <= index;
    const isCurrent = wordIndex === index;
    const visible = wordVisible(style, wordIndex, index, input.wordTimings.length, holding);
    const color = wordColor(style, wordIndex, isCurrent, spoken, override);
    const fill = karaokeFill(style, timing, timeUs, isCurrent, override);

    return {
      index: wordIndex,
      text: rect.text,
      rect,
      visible,
      opacity: wordOpacity(style, visible, override, isCurrent, timing, timeUs),
      color: override?.color ?? color,
      fillFraction: fill.fraction,
      fillColor: fill.color,
      background: background(style, isCurrent, override),
      scale: override?.scale ?? wordScale(style, isCurrent, timing, timeUs, override),
    };
  });

  const animation = blockAnimation(style, timeUs, segment);

  return {
    layout,
    words,
    opacity: animation.opacity,
    translateYPx: animation.translateYPx,
    droppedWords: layout.droppedWords,
  };
}

/**
 * Whether a word is drawn at all, before opacity is applied.
 *
 * `word-by-word` is the one mode that hides rather than dims: its whole appeal is
 * that the line does not exist yet. Everything else keeps every word on screen so
 * the text does not re-wrap mid-sentence.
 */
function wordVisible(
  style: CaptionStyle,
  wordIndex: number,
  current: number,
  totalWords: number,
  holding: boolean
): boolean {
  if (style.highlight.mode === 'word-by-word') {
    // `current` is -1 once the last word has finished, and during the hold the
    // frame must keep the *last* word up rather than every word the caption has
    // ever spoken — the whole point of the preset is that only one shows.
    if (current < 0) return holding && wordIndex === totalWords - 1;
    return wordIndex === current;
  }
  return true;
}

/**
 * Base colour when no override wins.
 *
 * `sequence` cycles `wordColors` and leaves unspoken words on the plain fill, so
 * the colour arrives with the word rather than being visible from the start.
 * `karaoke-fill` also keeps unspoken words plain — the sweep supplies the colour.
 * `keywords` is driven purely by emphasis overrides (`13` supplies them, or the
 * user marks a word), so it contributes no colour of its own; an unmarked word
 * stays on the fill and a marked one is caught by the override path.
 */
function wordColor(
  style: CaptionStyle,
  wordIndex: number,
  isCurrent: boolean,
  spoken: boolean,
  override: CaptionWordOverride | undefined
): string | null {
  if (override?.color) return override.color;

  // In `keywords` the emphasis *is* the highlight: the preset's spec is a marked
  // word in the highlight colour at 130%, with no clock involved. A marker who sets
  // only `emphasis` therefore still gets the colour, which is what makes Ctrl+B
  // feel like it does something.
  if (style.highlight.mode === 'keywords' && override?.emphasis) return style.highlight.color;

  switch (style.highlight.mode) {
    case 'karaoke-fill':
    case 'keywords':
    case 'none':
      return style.fill.color;
    case 'sequence':
      if (style.wordColors.length > 0) {
        return spoken ? style.wordColors[wordIndex % style.wordColors.length]! : style.fill.color;
      }
      return spoken ? style.highlight.color : style.fill.color;
    case 'word-by-word':
    case 'current-word':
    default:
      return isCurrent ? style.highlight.color : style.fill.color;
  }
}

/**
 * The left-to-right karaoke sweep.
 *
 * Only the currently spoken word sweeps; with `keepLit` the words already spoken
 * stay fully filled, and without it they fall back to the plain fill the instant
 * the next word starts. A word with no timing (a manually edited caption) never
 * sweeps, which is right: there is no duration to sweep across.
 */
function karaokeFill(
  style: CaptionStyle,
  timing: CaptionWordTiming | undefined,
  timeUs: number,
  isCurrent: boolean,
  override: CaptionWordOverride | undefined
): { fraction: number; color: string | null } {
  if (style.highlight.mode !== 'karaoke-fill' || !timing) return { fraction: 0, color: null };
  // An explicit colour means the user replaced the highlight for this word, so
  // sweeping the style's colour over it would undo their choice.
  if (override?.color) return { fraction: 0, color: null };

  const color = style.highlight.color;

  if (timeUs >= timing.endUs) {
    return style.highlight.keepLit ? { fraction: 1, color } : { fraction: 0, color: null };
  }
  if (!isCurrent) return { fraction: 0, color: null };
  return { fraction: wordProgress(timing, timeUs), color };
}

/**
 * Multiplier for an emphasised word.
 *
 * The scale belongs to the highlight mode, not to the animation: `keywords` pops a
 * marked word by the style's `highlight.scale` for the whole time it is on screen,
 * while the other modes scale only the word being spoken.
 */
function wordScale(
  style: CaptionStyle,
  isCurrent: boolean,
  timing: CaptionWordTiming | undefined,
  timeUs: number,
  override: CaptionWordOverride | undefined
): number {
  if (style.highlight.mode === 'keywords') {
    return override?.emphasis ? style.highlight.scale : 1;
  }
  if (!isCurrent || !timing) return 1;

  // A pop scales the word up from `params.from` as it arrives. The style's
  // highlight scale still applies on top, so a marker that both pops and enlarges
  // gets both rather than one silently winning.
  const perWord = style.animation.perWord;
  if (perWord.preset === 'pop') {
    const raw = perWord.params['from'];
    const from = typeof raw === 'number' ? raw : 0.8;
    const elapsedUs = timeUs - timing.startUs;
    if (elapsedUs < 0) return style.highlight.scale * from;
    if (elapsedUs < perWord.durationMs * 1000) {
      const t = elapsedUs / (perWord.durationMs * 1000);
      return style.highlight.scale * (from + (1 - from) * ease(t, perWord.easing));
    }
  }

  return style.highlight.scale;
}

/**
 * A chip behind one word, if the style asks for one.
 *
 * `highlight.background` is a per-word chip and is independent of the block
 * background in `style.background`, which the caller paints per line or per block.
 */
function background(
  style: CaptionStyle,
  isCurrent: boolean,
  override: CaptionWordOverride | undefined
): string | null {
  if (!style.highlight.background) return null;
  if (style.highlight.mode === 'keywords') return override?.emphasis ? style.highlight.background : null;
  return isCurrent ? style.highlight.background : null;
}

/**
 * Opacity for a word that is being drawn.
 *
 * Only `word-by-word`'s per-word pop changes this; every other style animates the
 * block as a whole. When a style sets `perWord` it is because the entrance is
 * meant to be read word by word, and fading the block as well would multiply the
 * two and leave the caption too faint to read.
 */
function wordOpacity(
  style: CaptionStyle,
  visible: boolean,
  override: CaptionWordOverride | undefined,
  isCurrent: boolean,
  timing: CaptionWordTiming | undefined,
  timeUs: number
): number {
  if (!visible) return 0;
  // The emphasis *is* the style's highlight look; keeping the user's tint at full
  // strength is what makes a marked word readable at the base opacity of 0.6.
  const base = override?.emphasis ? 1 : style.fill.opacity;

  const perWord = style.animation.perWord;
  if (perWord.preset === 'none' || !isCurrent || !timing) return base;

  // A word fades in over `durationMs`, offset by `staggerMs` for the words after
  // it, so a fast caption does not show four words arriving at once.
  const elapsedUs = timeUs - timing.startUs - perWord.staggerMs * 1000;
  if (elapsedUs >= perWord.durationMs * 1000) return base;
  if (elapsedUs <= 0) return 0;
  return base * (elapsedUs / (perWord.durationMs * 1000));
}

/**
 * The whole-block entrance and exit.
 *
 * The block animation is independent of the per-word one: Animated Slide slides its
 * lines up *and* fades its words in, and Word by Word asks for neither (its `in`
 * preset is `none`), so it needs no special case to avoid a block fade. Only the
 * opacity of the words themselves is per-word; see `wordOpacity`.
 */
function blockAnimation(
  style: CaptionStyle,
  timeUs: number,
  segment: { startUs: number; endUs: number }
): { opacity: number; translateYPx: number } {
  let opacity = 1;
  let translateYPx = 0;

  const enter = style.animation.in;
  const enterUs = enter.durationMs * 1000;
  if (enter.preset !== 'none' && enterUs > 0 && timeUs < segment.startUs + enterUs) {
    const t = clamp01((timeUs - segment.startUs) / enterUs);
    const eased = ease(t, enter.easing);
    opacity = enter.preset === 'wipe' || enter.preset === 'typewriter' ? 1 : eased;
    translateYPx = slideOffset(style, enter, t, eased);
  }

  const exit = style.animation.out;
  const exitUs = exit.durationMs * 1000;
  if (exit.preset !== 'none' && exitUs > 0 && timeUs > segment.endUs - exitUs) {
    const t = clamp01((segment.endUs - timeUs) / exitUs);
    const eased = ease(t, exit.easing);
    opacity = Math.min(opacity, exit.preset === 'wipe' || exit.preset === 'typewriter' ? 1 : eased);
    translateYPx += slideOffset(style, exit, t, eased) * -1;
  }

  return { opacity, translateYPx };
}

/**
 * Slide distance, expressed as a percentage of the font size by the style.
 *
 * `distancePctOfFont` is in the preset's `params` rather than in the schema
 * proper, so a style that omits it gets a sensible fraction of the font instead of
 * a silent zero — a slide that does not move is the kind of bug that looks like a
 * rendering failure.
 */
function slideOffset(
  style: CaptionStyle,
  step: CaptionStyle['animation']['in'],
  t: number,
  eased: number
): number {
  if (step.preset !== 'slide-up' && step.preset !== 'slide-down') return 0;
  const raw = step.params['distancePctOfFont'];
  const pct = typeof raw === 'number' ? raw : 40;
  // `t` (not `eased`) supplies the direction so both ends of the animation travel
  // the same distance; the easing shapes the speed, not the geometry.
  const offset = (1 - eased) * (pct / 100) * style.font.sizePctOfShortSide;
  void t;
  return step.preset === 'slide-up' ? offset : -offset;
}

/**
 * Easing curves, shared by every animation in the caption system.
 *
 * `spring` is an overshooting cubic rather than a simulated spring: the overshoot
 * is the part the eye reads, and a real spring needs a stiffness and a mass that
 * the style does not carry.
 */
function ease(t: number, easing: CaptionStyle['animation']['in']['easing']): number {
  const x = clamp01(t);
  switch (easing) {
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - (1 - x) ** 3;
    case 'spring': {
      const c = 1.70158;
      return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
    }
    case 'linear':
      return x;
    case 'easeInOut':
    default:
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The caption item visible at a moment, if any.
 *
 * The engine refuses overlapping captions on one track, but a file from another
 * build might hold them; the later-starting one wins, which is what a viewer
 * reads as the newest thing said.
 */
export function captionItemAt<T extends { type: string; startUs: number; durationUs: number }>(
  items: ReadonlyArray<T>,
  timeUs: number
): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (item.type !== 'caption') continue;
    if (timeUs < item.startUs || timeUs >= item.startUs + item.durationUs) continue;
    if (!best || item.startUs > best.startUs) best = item;
  }
  return best;
}
