/**
 * SPEC 13 §8 — brand kits as data.
 *
 * Public surface of the package: the `.cwbrand` schema, import/export with unknown-field
 * preservation, and the pure functions that turn a kit into a plan. Nothing here draws,
 * opens a file or touches a timeline — the caller runs the commands — so every part is
 * testable without a canvas, a store or an ffmpeg binary.
 */
export {
  BRAND_KIT_MAX_CUSTOM_COLOURS,
  CwbrandFormat,
  DEFAULT_KIT_COLOURS,
  CwbrandFormatVersion,
  brandKitSchema,
  collectUnknownKitFields,
  exportBrandKit,
  importBrandKit,
  tryParseBrandKit,
  type BrandKit,
  type BrandKitPlacement,
  type ParseKitResult,
} from './schema.js';

export {
  ArchiveError,
  KIT_ENTRY_NAME,
  assetEntryName,
  extensionFor,
  kitAssetIds,
  readArchive,
  readBrandKitArchive,
  writeArchive,
  writeBrandKitArchive,
  type ArchiveEntry,
  type ImportedKitArchive,
  type KitArchiveResult,
  type KitAssetFetcher,
  type ParsedArchive,
} from './archive.js';
export { crc32 } from './crc32.js';

export {
  captureKitFromClip,
  type CapturableItem,
  type CapturableStyle,
  type CaptureReport,
  type CaptureSource,
} from './capture.js';

export {
  ALL_KIT_PARTS,
  diagnoseKit,
  findKitAppliedItems,
  kitProvenance,
  kitSwatches,
  planKitApplication,
  resolvePlacement,
  safeAreaBandsFor,
  type SafeAreaBands,
  type SafeAreaPreset,
  resolveVisibility,
  type KitApplicationPlan,
  type KitApplyParts,
  type KitAvailability,
  type KitDiagnosis,
  type KitProvenance,
  type KitTarget,
  type PlacedBox,
} from './apply.js';
