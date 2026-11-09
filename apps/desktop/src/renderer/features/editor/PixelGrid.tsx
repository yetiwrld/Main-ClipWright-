/**
 * The pixel grid (SPEC 10 §9): one line per canvas pixel, at 800% zoom and above.
 *
 * ## Why this is drawn as a canvas and not as elements
 *
 * An 800% view of a 1080×1920 composition shows roughly 50×90 canvas pixels, so the grid is
 * about 140 lines — but a 400% view of a small composition, or a wide one, reaches the
 * multiple-thousands. Two thousand absolutely-positioned `div`s is a layout thrash on every
 * scroll, and the existing grid overlay gets away with elements only because a divisor pair
 * caps its lines at eleven. A single `<canvas>` is one node however many lines are on it.
 *
 * ## Why screen space
 *
 * A 1 *canvas* pixel line at 800% is 8 screen pixels wide, which is a bar chart rather than
 * a grid, so the lines are drawn one *screen* pixel wide and spaced by the zoom factor.
 * That also means this layer sits outside the transformed canvas: it is the viewport that
 * knows the zoom, and drawing inside the scale would require dividing everything back out.
 */
import { memo, useEffect, useRef } from 'react';

export interface PixelGridProps {
  /** One canvas pixel, in screen pixels — this is the line spacing. */
  spacing: number;
  /** The frame's drawn size in screen pixels. */
  width: number;
  height: number;
  /** Canvas pixels, so the lines can be aligned to the composition's own pixel edges. */
  canvas: { width: number; height: number };
}

/**
 * The colour the pixel grid draws.
 *
 * `--brand` at a quarter the opacity of the composition lines, because these lines are
 * already the brightest thing on screen at 800% — there is one every eight screen pixels —
 * and matching the overlay's 25% would replace the picture with a coloured mesh.
 */
const GRID_COLOUR = 'rgba(255, 140, 60, 0.18)';

export const PixelGrid = memo(function PixelGrid({
  spacing,
  width,
  height,
  canvas,
}: PixelGridProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
    const pxWidth = Math.max(1, Math.round(width));
    const pxHeight = Math.max(1, Math.round(height));
    element.width = Math.round(pxWidth * dpr);
    element.height = Math.round(pxHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, pxWidth, pxHeight);

    if (!Number.isFinite(spacing) || spacing <= 0) return;
    ctx.fillStyle = GRID_COLOUR;

    /*
      Every line lands on a *composition* pixel boundary, and the offset of the frame within
      the viewport does not enter into it: this canvas is positioned over the frame, so
      `x = 0` here is the composition's column 0. An earlier version took the frame's offset
      as a prop and folded it into a modulo, which put every line a few pixels off the
      composition's own pixel edges — the frame is centred by the panel and sits on a
      fractional offset, so there is no alignment to gain from it and a great deal to lose.

      Each line is then rounded to a whole CSS pixel: one at 3.4 px is drawn as two half-lit
      columns and reads as a smudge rather than as a grid.
    */
    for (let x = 0; x <= pxWidth; x += spacing) {
      ctx.fillRect(Math.round(x), 0, 1, pxHeight);
    }
    for (let y = 0; y <= pxHeight; y += spacing) {
      ctx.fillRect(0, Math.round(y), pxWidth, 1);
    }
  }, [spacing, width, height, canvas.width, canvas.height]);

  return (
    <canvas
      ref={ref}
      data-testid="pixel-grid"
      data-spacing={spacing}
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    />
  );
});
