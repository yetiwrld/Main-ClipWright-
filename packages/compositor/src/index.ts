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

/**
 * SPEC 10 §2/§6 — what a frame looks like when more than one item is on it.
 *
 * The preview drew one item and the export wrote one item; an overlay track was
 * invisible in the first and silently won in the second. Both now ask this module
 * which layers contribute, at what opacity, with what blend mode.
 */
export {
  ffmpegBlendMode,
  layerBlendFilter,
  needsCompositing,
  visibleLayers,
  type BlendMode,
  type LayerItem,
  type VisibleLayer,
} from './layers.js';

/**
 * SPEC 10 §2/§6 — software compositing of decoded frames.
 *
 * The export has raw `yuv420p` frames rather than a DOM, so the same layer stack
 * the preview paints with CSS has to be applied by hand here. Kept in this package
 * next to `layers` so the two cannot disagree about what `multiply` means.
 */
export {
  compositeLayers,
  compositeRgb,
  compositeRgbMasked,
  compositeRgbShifted,
  compositeRgbScaled,
  compositeRgbScaledShifted,
  joinYuv,
  rgbToYuv,
  splitYuv,
  yuvFrameBytes,
  yuvToRgb,
  type ColorMatrix,
  type RgbFrame,
  type YuvFrame,
} from './composite.js';

/**
 * SPEC 12 §4 — transitions.
 *
 * The command layer could always create them; nothing evaluated them, so a
 * crossfade existed in the project file and nowhere else. Both renderers read the
 * timing from here so they cannot disagree about when a transition happens.
 */
export {
  easeWithBezier,
  transitionAt,
  transitionBezier,
  transitionProgress,
  transitionState,
  wipeAlphaAt,
  wipeDirection,
  dissolveAlphaAt,
  dissolveNoiseAt,
  DISSOLVE_SEED,
  type DissolveShape,
  type WipeShape,
  transitionWindow,
  type TransitionAlignment,
  type TransitionState,
  type TransitionWindow,
} from './transitions.js';

/**
 * SPEC 12 §3 — the effect catalogue and the colour maths behind it.
 *
 * Effects were storable, listable and toggleable and applied by nothing. This is
 * the shared implementation both renderers call, so a brightness of +0.2 cannot
 * mean two different things on screen and in the file.
 */
export {
  activeEffects,
  applyEffectsToFrame,
  applyPixelEffects,
  EFFECTS,
  effectDefinition,
  effectParams,
  effectPassCount,
  gaussianBlur,
  isPixelwise,
  linearToSrgb,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  MID_GREY,
  scaleRadiusForFrame,
  srgbToLinear,
  unsharpMask,
  vignette,
  type ActiveEffect,
  type EffectDefinition,
  type LinearRgb,
  type ParamSpec,
} from './effects.js';

/**
 * SPEC 12 §3.1 — adjustment layers.
 *
 * An item with no picture that grades every layer below it. The schema carried the
 * type and the chain; nothing resolved one to the layers it affects.
 */
export {
  activeAdjustmentLayers,
  effectsForLayer,
  isAdjustmentItem,
  type AdjustmentItem,
  type AdjustmentLayer,
} from './adjustment-layers.js';

/**
 * SPEC 11 §12 — shape geometry, shared by the preview's SVG serialiser and the
 * export's ASS drawing serialiser.
 */
export {
  SHAPE_KINDS,
  shapeBoxAt,
  shapeGeometry,
  shapePath,
  type ShapeBoxPercent,
  type ShapeKind,
  type ShapeSegment,
  type ShapeSubpath,
} from './shapes';
