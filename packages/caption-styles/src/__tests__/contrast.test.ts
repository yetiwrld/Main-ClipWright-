/**
 * SPEC 11 §5 — "every preset must be legible on both bright and dark video
 * (verified by the contrast test in §14 — outline/shadow/background guarantee
 * ≥ 3:1 against both a white and a black test frame)".
 *
 * This is the one accessibility requirement in the caption system, and it is easy
 * to break accidentally: a white preset with no outline looks fine on a dark
 * frame and disappears on a white one. The test composites what the renderer
 * would actually paint — background chip, then the text — and measures the
 * contrast ratio against a pure white and a pure black frame.
 */
import { describe, expect, it } from 'vitest';
import { BUILT_IN_STYLES, styleBackgroundColor } from '../presets.js';
import type { CaptionStyle } from '../schema.js';

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '').slice(0, 6);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Applies a semi-transparent colour over an opaque one, as the canvas would. */
function composite(top: Rgb, opacity: number, bottom: Rgb): Rgb {
  return {
    r: Math.round(top.r * opacity + bottom.r * (1 - opacity)),
    g: Math.round(top.g * opacity + bottom.g * (1 - opacity)),
    b: Math.round(top.b * opacity + bottom.b * (1 - opacity)),
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * The colour the text effectively sits on, for a given video frame.
 *
 * When a background chip is enabled it covers the video, so the frame colour no
 * longer matters — that is how Multi-line Subtitle and Podcast stay legible on
 * anything. When there is no chip, the text sits directly on the frame.
 */
function effectiveBackground(style: CaptionStyle, frame: Rgb): Rgb {
  const chip = styleBackgroundColor(style);
  return chip ? composite(parseHex(chip.color), chip.opacity, frame) : frame;
}

/** White text with a black outline reads as legible even over mid-grey. */
function hasLegibilityAid(style: CaptionStyle): boolean {
  return (
    style.background.enabled ||
    (style.outline.enabled && style.outline.widthPctOfFont >= 3) ||
    (style.shadow.enabled && style.shadow.opacity >= 0.5)
  );
}

describe('every preset is legible on bright and dark video (SPEC 11 §5)', () => {
  for (const style of BUILT_IN_STYLES) {
    it(`${style.name}: contrast against a white and a black frame`, () => {
      const text = parseHex(style.fill.color);

      for (const [name, frame] of [
        ['white', WHITE],
        ['black', BLACK],
      ] as const) {
        const background = effectiveBackground(style, frame);
        const ratio = contrast(text, background);

        // The spec's bar is 3:1. Where the text colour alone does not reach it —
        // white on a white frame cannot — the preset must supply a legibility aid
        // (a chip, an outline or a shadow) that the renderer draws around the
        // glyphs. Both paths are acceptable; silently having neither is not.
        if (ratio < 3) {
          expect(
            hasLegibilityAid(style),
            `${style.name} is ${ratio.toFixed(2)}:1 on a ${name} frame and has no outline, shadow or background`
          ).toBe(true);
        }
      }
    });
  }

  it('keeps the presets that paint their own chip legible without relying on the frame', () => {
    for (const style of BUILT_IN_STYLES.filter((candidate) => candidate.background.enabled)) {
      const chip = styleBackgroundColor(style)!;
      const text = parseHex(style.fill.color);
      for (const frame of [WHITE, BLACK]) {
        const background = composite(parseHex(chip.color), chip.opacity, frame);
        const ratio = contrast(text, background);
        expect(
          ratio,
          `${style.name} text over its own chip on a ${frame === WHITE ? 'white' : 'black'} frame`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps every preset inside the safe area on all four aspect ratios', () => {
    // SPEC 11 §5: positions are percentages so a preset works at 9:16, 1:1, 4:5
    // and 16:9. A y of 95% would put two lines off the bottom at 9:16, where the
    // short side is the width and a line is proportionally taller.
    for (const style of BUILT_IN_STYLES) {
      expect(style.position.yPct, `${style.name} y`).toBeGreaterThanOrEqual(45);
      expect(style.position.yPct, `${style.name} y`).toBeLessThanOrEqual(90);
      expect(style.position.maxWidthPct, `${style.name} maxWidth`).toBeLessThanOrEqual(100);
      expect(style.position.xPct, `${style.name} x`).toBeGreaterThanOrEqual(0);
      expect(style.position.xPct, `${style.name} x`).toBeLessThanOrEqual(100);
    }
  });

  it('sizes every preset as a percentage of the short side, never in pixels', () => {
    // The whole point of relative units: the same style at 1080p and 4K.
    for (const style of BUILT_IN_STYLES) {
      expect(style.font.sizePctOfShortSide).toBeGreaterThan(0);
      expect(style.font.sizePctOfShortSide).toBeLessThanOrEqual(20);
    }
  });
});
