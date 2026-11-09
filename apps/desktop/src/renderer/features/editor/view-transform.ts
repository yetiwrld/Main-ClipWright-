/**
 * View zoom and pan for the preview (SPEC 10 §4, §3.1).
 *
 * The preview draws the composition into whatever space the panel gives it — a 1080×1920
 * frame in a 400 px-wide panel is already a fifth of its size. *Zoom* is the user asking
 * for something other than "as big as fits": 100% to inspect a pixel, 800% to see the
 * pixel grid, 25% to see the whole composition on a small screen.
 *
 * ## Why this is a transform and not a layout
 *
 * The zoom is applied as a CSS `transform: scale()` on the canvas element, and the reason
 * is not convenience — it is that every gesture in `use-canvas-drag` measures
 * `getBoundingClientRect()` and divides a *client-pixel* delta by it. A transformed element
 * reports its **transformed** rectangle, so a drag at 200% correctly moves the picture half
 * as far per screen pixel with no change to any of that code. Making zoom a layout change
 * (setting an explicit width) would have left all of it dividing by the wrong number, and
 * it would have failed as "drags are twice as fast when zoomed" rather than as a missing
 * conversion.
 *
 * The one thing that must stay in *screen* pixels regardless of zoom is the hit area of a
 * handle, and that is why the scale factors here are also handed to the handle sizing.
 *
 * ## The three spaces
 *
 * - **Canvas space** — the composition's own pixels, origin top-left.
 * - **Fitted space** — canvas space scaled so the frame fits the panel. This is what the
 *   preview has always drawn, and it is `scale = 1` in the transform.
 * - **Screen space** — DOM/CSS pixels.
 *
 * `zoom` is expressed against *canvas* pixels, which is what makes "100%" mean "one canvas
 * pixel is one device pixel" — see `devicePixelsPerCanvasPixel`.
 */

/** The zoom presets the toolbar offers (SPEC 10 §3.1), plus *Fit* and *Fill*. */
export const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4] as const;

/**
 * The bounds of a continuous zoom.
 *
 * The maximum is 1600% rather than the 400% the dropdown lists, because the *pixel grid*
 * appears at 800% (§9) — a preset list that stopped at 400 would make the grid
 * unreachable except by dragging a wheel to exactly the right place. The minimum allows a
 * 4K composition to be seen whole in a small panel.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;

/** The zoom at which the pixel grid becomes visible (SPEC 10 §9). */
export const PIXEL_GRID_ZOOM = 8;

/**
 * The zoom the user has chosen.
 *
 * `fit` and `fill` are *relative to the panel* — they change when the window does — while
 * a number is absolute, because that is what the user meant by typing 100%: this many
 * canvas pixels per device pixel, whatever the window is doing.
 */
export type ZoomChoice = 'fit' | 'fill' | number;

export const ZOOM_FIT: ZoomChoice = 'fit';

/** A zoom clamped into the range, or `null` when it is not a number at all. */
export function clampZoom(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numeric));
}

/**
 * The fitted and filled scales for a canvas in a panel, both in CSS pixels per canvas pixel.
 *
 * `fit` is the smaller ratio — the whole frame visible, letterboxed. `fill` is the larger —
 * the frame covering the panel, cropped. A degenerate panel (before layout, or a zero-sized
 * one) returns 0 for both, which callers treat as "do not scale rather than divide by zero".
 */
export function fitAndFill(
  canvas: { width: number; height: number },
  panel: { width: number; height: number },
): { fit: number; fill: number } {
  const valid =
    Number.isFinite(canvas.width) && canvas.width > 0 &&
    Number.isFinite(canvas.height) && canvas.height > 0 &&
    Number.isFinite(panel.width) && panel.width > 0 &&
    Number.isFinite(panel.height) && panel.height > 0;
  if (!valid) return { fit: 0, fill: 0 };
  return {
    fit: Math.min(panel.width / canvas.width, panel.height / canvas.height),
    fill: Math.max(panel.width / canvas.width, panel.height / canvas.height),
  };
}

/**
 * How many device pixels one canvas pixel covers at this zoom.
 *
 * SPEC 10 §4 asks for the frame to be drawn 1:1 with *device* pixels at 100% — so on a
 * 200% Windows scaling a 1080-wide composition is 540 CSS pixels wide and 1080 physical
 * ones. Dividing by `devicePixelRatio` is the whole of that requirement; treating 100% as
 * "one CSS pixel per canvas pixel" would draw it at half the intended size on exactly the
 * displays where the user is most likely to be checking sharpness.
 */
export function devicePixelsPerCanvasPixel(zoom: number, devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return zoom * ratio;
}

/**
 * The `scale()` a `ZoomChoice` works out to, measured against the **fitted** size.
 *
 * The preview's untransformed layout is already fit-to-panel, so `scale = 1` *is* fit. That
 * is why this returns a ratio rather than a size: the transform only ever deviates from the
 * layout the panel gave us, and at `fit` it is exactly 1, which keeps every existing
 * measurement in the app — and in its tests — unchanged.
 *
 * A numeric zoom is converted through canvas pixels: at `zoom = 1` one canvas pixel should
 * be one device pixel, so the target CSS width is `canvasWidth / dpr`, and the scale is
 * that over the fitted CSS width the panel actually produced.
 */
export function previewScale(
  choice: ZoomChoice,
  fitted: { widthCss: number; heightCss: number },
  canvas: { width: number; height: number },
  panel: { width: number; height: number },
  devicePixelRatio: number,
): number {
  if (choice === 'fit') return 1;
  const { fit, fill } = fitAndFill(canvas, panel);
  if (choice === 'fill') {
    // Both are CSS pixels per canvas pixel, so the ratio is dimensionless and correct even
    // when the panel is degenerate (0/0 would be NaN, hence the guard).
    return fit > 0 ? fill / fit : 1;
  }
  const zoom = clampZoom(choice);
  if (zoom === null) return 1;
  /*
    Measured against the fitted width the DOM actually produced rather than against
    `fitAndFill`'s prediction: the panel's padding, the frame's 1 px hairline and any
    rounding in layout all make the real fitted width a little smaller than the ideal, and
    using the ideal would put "100%" a pixel or two off the composition's true size.
  */
  if (!Number.isFinite(fitted.widthCss) || fitted.widthCss <= 0) return 1;
  const targetCss = (canvas.width * zoom) / (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1);
  return targetCss / fitted.widthCss;
}

/**
 * The next zoom for a wheel notch or a keyboard step.
 *
 * A constant *ratio* per step rather than a constant amount: zooming from 5% to 6% and from
 * 400% to 800% should feel the same, and an additive step makes one of them useless and the
 * other violent. The result is clamped, so holding the wheel settles at the limit rather
 * than running away and coming back through a huge range.
 */
export function stepZoom(zoom: number, notches: number, ratio = 1.2): number {
  const current = clampZoom(zoom) ?? 1;
  if (!Number.isFinite(notches) || notches === 0) return current;
  if (!Number.isFinite(ratio) || ratio <= 1) return current;
  return clampZoom(current * ratio ** notches) ?? current;
}

/** Pan offset in screen pixels — the translation applied before the scale. */
export interface Pan {
  x: number;
  y: number;
}

export const NO_PAN: Pan = { x: 0, y: 0 };

/**
 * Where the pan must move to keep one point still while the scale changes.
 *
 * This is what makes `Ctrl`+wheel zoom *about the cursor* (§4) rather than about the middle
 * of the panel: the user is pointing at the thing they want to look at, and zooming about
 * the centre would slide it away from the pointer.
 *
 * With `transform: translate(pan) scale(k)` and `transform-origin: center`, a point at `p`
 * (measured in the *fitted* layout, in pixels right of the frame's centre) appears on screen
 * at `pan + k·p`. Holding that fixed as `k` goes from `k₀` to `k₁`:
 *
 *     pan₀ + k₀·p = pan₁ + k₁·p   ⇒   pan₁ = pan₀ + (k₀ − k₁)·p
 *
 * Note `p` is *not* divided by `k₀`: it is already a position in the laid-out frame, which
 * is what `scale` multiplies. Dividing it scales the correction by the current zoom, so the
 * point drifts further the further in you are — and the sign is the opposite of the
 * intuitive one, because zooming *in* on something to the right of centre requires the
 * picture to slide *left*.
 *
 * Both mistakes were in the first version of this function. The invariant in the tests
 * (`pan + k·p` unchanged) is what caught them.
 */
export function panToKeepPoint(
  pan: Pan,
  fromScale: number,
  toScale: number,
  pointFromCentre: { x: number; y: number },
): Pan {
  if (!Number.isFinite(fromScale) || !Number.isFinite(toScale) || fromScale === 0) return pan;
  const delta = fromScale - toScale;
  return {
    x: pan.x + delta * pointFromCentre.x,
    y: pan.y + delta * pointFromCentre.y,
  };
}

/**
 * Bound the pan so the frame cannot be thrown out of sight.
 *
 * The limit is the frame's own on-screen size: at 200% you may look at any part of the
 * frame, and you cannot drag it entirely off the panel and lose it. Expressed against the
 * scaled size rather than a fixed number of pixels because that is the only extent that
 * means anything — at fit the frame is exactly the panel and there is nothing to pan to.
 */
export function clampPan(pan: Pan, scaled: { width: number; height: number }): Pan {
  const limitX = Number.isFinite(scaled.width) && scaled.width > 0 ? scaled.width / 2 : 0;
  const limitY = Number.isFinite(scaled.height) && scaled.height > 0 ? scaled.height / 2 : 0;
  const bound = (value: number, limit: number) => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(limit, Math.max(-limit, value));
  };
  return { x: bound(pan.x, limitX), y: bound(pan.y, limitY) };
}

/** Whether the frame is bigger than the panel, which is the only case panning means anything. */
export function canPan(scale: number): boolean {
  return Number.isFinite(scale) && scale > 1.0001;
}

/**
 * The pixel grid's line spacing in **screen** pixels, or `null` when it must not be drawn.
 *
 * Returns screen rather than canvas pixels because the grid is drawn in the viewport layer
 * rather than inside the canvas: a line that is 1 *canvas* pixel wide is 8 screen pixels at
 * 800% zoom, which is a bar chart rather than a grid. Sub-pixel spacing is refused for the
 * same reason — below 800% the cells are too small to see and the whole layer is a moiré.
 */
export function pixelGridSpacing(screenPixelsPerCanvasPixel: number): number | null {
  /*
    `Number.isFinite` rather than `isNaN`: an infinite spacing passes a `< 8` test, and the
    drawing loop then runs exactly once — placing a single line at the frame's origin, which
    looks like a stray border rather than like no grid.
  */
  if (!Number.isFinite(screenPixelsPerCanvasPixel)) return null;
  if (screenPixelsPerCanvasPixel < PIXEL_GRID_ZOOM) return null;
  return screenPixelsPerCanvasPixel;
}

/** How the zoom reads in the toolbar: `Fit`, `Fill`, or a percentage. */
export function zoomLabel(choice: ZoomChoice): string {
  if (choice === 'fit') return 'Fit';
  if (choice === 'fill') return 'Fill';
  return `${Math.round(choice * 100)}%`;
}
