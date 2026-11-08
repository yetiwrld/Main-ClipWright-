/**
 * SPEC 11 — caption styles as data.
 *
 * Public surface of the package: the `.cwstyle` schema, the ten built-in presets,
 * and style resolution. Nothing here draws anything — rendering lives in
 * `@clipwright/compositor` — so every part of this package is a pure function and
 * every part is testable without a canvas.
 */
export {
  CWSTYLE_FORMAT,
  CWSTYLE_FORMAT_VERSION,
  STYLE_MIGRATIONS,
  captionStyleSchema,
  collectUnknownFields,
  exportStyle,
  importStyle,
  migrateStyle,
  parseStyle,
  tryParseStyle,
  type CaptionAnimation,
  type CaptionFont,
  type CaptionHighlightMode,
  type CaptionPosition,
  type CaptionStyle,
  type CaptionText,
  type FontSource,
  type MigrationResult,
  type ParseStyleResult,
} from './schema.js';

export {
  BUILT_IN_STYLES,
  DEFAULT_STYLE,
  DEFAULT_STYLE_ID,
  builtInStyle,
  resolveStyle,
  styleBackgroundColor,
  styleTextColor,
  type StyleOverrides,
} from './presets.js';
