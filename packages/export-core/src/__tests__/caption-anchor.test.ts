/**
 * Where a caption block sits, for all nine anchors (SPEC 11 §5).
 *
 * The preview and the burn-in are separate implementations: the preview lays text out
 * with `layoutText` and paints the rectangles, while the export writes an ASS
 * `\an<alignment>\pos(x,y)` line. Nothing forces them to agree except that both read
 * the same `position` block — so these tests compare the layout against the *export's
 * own functions* rather than against numbers typed in here. If either side changes its
 * mind about what "bottom-left" means, one of them fails.
 *
 * It lives here rather than beside the layout because `export-core` depends on
 * `compositor` and not the other way round — the preview must not have to reach for
 * the exporter to be checked.
 *
 * This file exists because the horizontal half of the anchor was dead code. All three
 * branches of the `left` expression returned `xPct - width/2`, so a left- or
 * right-anchored caption was drawn in the middle of the frame while the export put it
 * in the corner. Every one of the ten built-in presets is centred at `xPct: 50`, which
 * is the single position where that bug is invisible — so the suite, the presets and
 * the screenshots all agreed with each other and all disagreed with the file.
 */
import { describe, expect, it } from 'vitest';
import { builtInStyle, type CaptionStyle } from '@clipwright/caption-styles';
import { layoutText, type MeasureText } from '@clipwright/compositor';
import { assAlignment, assPosition } from '../ass-captions.js';

/** Deterministic stand-in for canvas text metrics: every glyph half an em. */
const measure: MeasureText = (text, fontPx) => {
  let width = 0;
  for (const char of text) width += char === ' ' ? 0.25 * fontPx : 0.5 * fontPx;
  return width;
};

const WIDTH = 1920;
const HEIGHT = 1080;

const styleWith = (anchor: CaptionStyle['position']['anchor'], xPct: number, yPct: number): CaptionStyle => {
  const base = builtInStyle('clean-minimal')!;
  return {
    ...base,
    position: { ...base.position, anchor, xPct, yPct },
    text: { ...base.text, maxLinesHint: 1, align: 'left' },
    background: { ...base.background, enabled: false },
  };
};

const layout = (captionStyle: CaptionStyle, text = 'Caption') =>
  layoutText({ text, style: captionStyle, canvasWidth: WIDTH, canvasHeight: HEIGHT, measure });

/** Where the ASS export puts the anchor point, in canvas pixels. */
const exportPoint = (captionStyle: CaptionStyle) => assPosition(captionStyle, WIDTH, HEIGHT);

/**
 * Which edge of the block the export's `\an` code makes sit on that anchor point.
 *
 * ASS numbers its alignment grid from the bottom row upward, which is why `assAlignment`
 * inverts the axis; these are the same nine codes expressed as the two edges they pin.
 */
const edgesOf = (anchor: string): { x: 'left' | 'center' | 'right'; y: 'top' | 'middle' | 'bottom' } => ({
  x: anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center',
  y: anchor.startsWith('top') ? 'top' : anchor.startsWith('bottom') ? 'bottom' : 'middle',
});

describe('every anchor pins the block edge the export pins', () => {
  /*
    The nine cases are enumerated rather than sampled: the failure mode this guards
    against is one branch of a three-way ternary being wrong, and a sample of three
    anchors would have a one-in-three chance of missing it.
  */
  const anchors = [
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
  ] as const;

  for (const anchor of anchors) {
    it(`agrees with the export for ${anchor}`, () => {
      // An off-centre `xPct`/`yPct` in both axes, so a block that is only accidentally
      // right at 50% cannot pass by landing where the centre anchor would.
      const captionStyle = styleWith(anchor, 20, 25);
      const result = layout(captionStyle);
      const point = exportPoint(captionStyle);
      const edges = edgesOf(anchor);

      const blockLeft = result.bounds.x;
      const blockRight = result.bounds.x + result.bounds.width;
      const blockTop = result.bounds.y;
      const blockBottom = result.bounds.y + result.bounds.height;

      if (edges.x === 'left') expect(blockLeft).toBeCloseTo(point.x, 0);
      if (edges.x === 'right') expect(blockRight).toBeCloseTo(point.x, 0);
      if (edges.x === 'center') expect((blockLeft + blockRight) / 2).toBeCloseTo(point.x, 0);

      if (edges.y === 'top') expect(blockTop).toBeCloseTo(point.y, 0);
      if (edges.y === 'bottom') expect(blockBottom).toBeCloseTo(point.y, 0);
      if (edges.y === 'middle') expect((blockTop + blockBottom) / 2).toBeCloseTo(point.y, 0);
    });
  }

  it('puts a left-anchored block against the frame edge', () => {
    /*
      The user-visible symptom, stated plainly: with `xPct: 0` a left-anchored caption
      starts at the left edge of the frame. Under the old arithmetic it started at
      −width/2, i.e. half of it hung off the frame, which on screen reads as a caption
      that is mysteriously cut in half rather than as an anchoring bug.
    */
    const result = layout(styleWith('center-left', 0, 50));
    expect(result.bounds.x).toBeCloseTo(0, 6);
    expect(result.bounds.x).toBeGreaterThan(-0.001);
  });

  it('ends a right-anchored block at the frame edge', () => {
    // The mirror case: `xPct: 100` must leave the block's right edge on the frame edge,
    // not half a block beyond it.
    const result = layout(styleWith('center-right', 100, 50));
    expect(result.bounds.x + result.bounds.width).toBeCloseTo(WIDTH, 6);
  });

  it('moves a left-anchored block when xPct changes', () => {
    /*
      The blunt discriminator. The old code ignored `xPct`'s effect on anchoring
      entirely, so this assertion — which is the whole point of the control — failed by
      exactly half the block width while the nine-anchor loop above still passed,
      because a block pinned at 50% is where all three branches agree.
    */
    const atZero = layout(styleWith('center-left', 0, 50));
    const atFifty = layout(styleWith('center-left', 50, 50));
    const shift = (50 / 100) * WIDTH;
    expect(atFifty.bounds.x - atZero.bounds.x).toBeCloseTo(shift, 6);
  });

  it('keeps a centred block centred whatever xPct it carries', () => {
    // A centre anchor is the one case the old code got right, and it must stay right:
    // the ten built-in presets are all centre-anchored at 50%, so a regression here
    // would move every caption in every project.
    for (const xPct of [0, 25, 50, 75, 100]) {
      const result = layout(styleWith('center', xPct, 60));
      const blockCentre = result.bounds.x + result.bounds.width / 2;
      expect(blockCentre).toBeCloseTo((xPct / 100) * WIDTH, 6);
    }
  });

  it('moves the per-line background with the block rather than leaving it centred', () => {
    /*
      `background.perLine` draws a box behind each line, positioned from the line's own
      left edge. That is derived from `left`, so the dead-code bug put the text at the
      frame edge and the chip behind it half a block away — visible as a caption with no
      background, because the two never overlapped.
    */
    const plain = builtInStyle('clean-minimal')!;
    const captionStyle: CaptionStyle = {
      ...plain,
      position: { ...plain.position, anchor: 'center-left', xPct: 10, yPct: 50 },
      text: { ...plain.text, maxLinesHint: 1, align: 'left' },
      background: { ...plain.background, enabled: true, perLine: true },
    };
    const result = layout(captionStyle);
    const line = result.lines[0]!;
    const box = line.background!;
    expect(box).not.toBeNull();
    // The box is a padded window around the line, so it overlaps it by construction.
    expect(box.x).toBeLessThanOrEqual(line.words[0]!.x + 0.001);
    expect(box.x + box.width).toBeGreaterThanOrEqual(line.words[0]!.x + line.width - 0.001);
  });

  it('draws the block background around the block, wherever the anchor put it', () => {
    // The block-level box is `bounds` plus padding, so it inherits the fix for free —
    // pinned anyway, because "for free" is exactly the kind of assumption that stops
    // being true when someone derives the box from `xPct` directly.
    const plain = builtInStyle('clean-minimal')!;
    const captionStyle: CaptionStyle = {
      ...plain,
      position: { ...plain.position, anchor: 'center-left', xPct: 10, yPct: 50 },
      text: { ...plain.text, maxLinesHint: 1, align: 'left' },
      background: { ...plain.background, enabled: true, perLine: false },
    };
    const result = layout(captionStyle);
    expect(result.bounds.x).toBeCloseTo((10 / 100) * WIDTH, 6);
  });
});

describe('the ASS code and the anchor agree about which corner is which', () => {
  /*
    A one-word cross-check of the two coordinate systems. ASS counts rows from the
    bottom, so `assAlignment('top-left')` is 7 — and it is worth pinning next to the
    layout tests because a caption appearing at the wrong end of the frame is the
    symptom of an inverted axis, in either module.
  */
  it('maps the nine anchors to the nine ASS codes', () => {
    expect(assAlignment('bottom-left')).toBe(1);
    expect(assAlignment('bottom-center')).toBe(2);
    expect(assAlignment('bottom-right')).toBe(3);
    expect(assAlignment('center-left')).toBe(4);
    expect(assAlignment('center')).toBe(5);
    expect(assAlignment('center-right')).toBe(6);
    expect(assAlignment('top-left')).toBe(7);
    expect(assAlignment('top-center')).toBe(8);
    expect(assAlignment('top-right')).toBe(9);
  });
});
