/**
 * SPEC 11 §2 — text layout, shared by the preview and the export.
 *
 * Everything here is a pure function of the text, the style and a measure
 * callback. The drawing half lives in the Electron renderer, where an
 * `OffscreenCanvas` exists; keeping layout separate is what lets the test suite
 * verify wrapping and word rectangles without a browser, and what stops the
 * preview and the export from drifting apart.
 */
export {
  applyCase,
  blockBackground,
  currentWordIndex,
  layoutText,
  splitWords,
  wordProgress,
  type LayoutInput,
  type LayoutResult,
  type LineRect,
  type MeasureText,
  type WordRect,
} from './text-layout.js';

/**
 * SPEC 11 §5 — the frame builder, shared by preview and export.
 *
 * `layoutText` decides where words go; this decides what they look like at a
 * given instant. Splitting them is what lets one drawing path serve both.
 */
export {
  captionFrameAt,
  captionItemAt,
  type CaptionFrame,
  type CaptionFrameInput,
  type CaptionFrameWord,
  type CaptionWordOverride,
  type CaptionWordTiming,
} from './caption-frame.js';

/**
 * SPEC 10 §8.4–8.6 — where an item's picture sits inside the canvas.
 *
 * The preview and the export both draw a cropped, scaled, rotated picture; this is
 * the one place the stored values are turned into a rectangle and a transform.
 */
export {
  croppedSource,
  effectiveScale,
  itemGeometry,
  type ItemGeometry,
  type ItemGeometryInput,
  type SourceRect,
} from './item-geometry.js';

/**
 * SPEC 12 §2.1 — `evaluate()`, the value of a keyframed property at an instant.
 *
 * Keyframes were drawn on the timeline and read by nothing. This is the piece the
 * preview, the export and the inspector's readout all go through, so a property can
 * no longer mean three different things in three places.
 */
export {
  cubicBezier,
  evaluate,
  evaluateNumber,
  evaluateProperty,
  keyframeTimes,
  type KeyframeValue,
  type PropertyPath,
} from './keyframes.js';
