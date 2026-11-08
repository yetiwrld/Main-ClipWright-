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
