export const UPDATE_CORE_VERSION = '1.0.0';

// Versions, channels and the update decision
export {
  parseVersion,
  isValidVersion,
  compareVersions,
  isNewerVersion,
  isReleaseVisible,
  decideUpdate,
  autoCheckIntervalMs,
  shouldAutoCheck,
  formatVersionLabel,
  installerFileName,
  STARTUP_CHECK_DELAY_MS,
} from './version.js';
export type { ParsedVersion, UpdateChannel, UpdateDecision } from './version.js';

// Release manifest, verification and cross-checks
export {
  ReleaseFileSchema,
  ReleaseManifestSchema,
  LatestYmlSchema,
  parseReleaseManifest,
  crossCheckLatestYml,
  normaliseSha512,
  normaliseSha256,
  isManifestStale,
  filesMatchVersion,
  evaluateVerification,
  verifyDownloadedFile,
  formatDownloadSize,
  summariseReleaseNotes,
  MANIFEST_MAX_AGE_MS,
} from './manifest.js';
export type {
  ReleaseFile,
  ReleaseManifest,
  LatestYml,
  LatestYmlFile,
  ManifestProblem,
  ManifestCheck,
  VerifyUpdateResult,
} from './manifest.js';

// Signing
export {
  isValidPublicKey,
  verifyManifestSignature,
  signManifest,
  serialiseManifest,
} from './signing.js';
export type { TrustedKeys, SignatureCheck } from './signing.js';

// State machine and user-facing wording
export {
  createUpdateState,
  reduceUpdateState,
  createUpdateError,
  classifyUpdateError,
  shouldPrompt,
  shouldShowChip,
  describeUpdateStatus,
  formatCheckedAt,
  formatDownloadProgress,
  releaseVersionOf,
  SNOOZE_MS,
} from './state.js';
export type {
  UpdateStatus,
  UpdateProgress,
  ReleaseNotes,
  UpdateState,
  UpdateError,
  UpdateErrorKind,
  UpdateEvent,
} from './state.js';
