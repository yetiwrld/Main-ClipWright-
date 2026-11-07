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

// Update journal, boot marking and recovery (SPEC 15 §7)
export {
  createJournal,
  advanceJournal,
  confirmBoot,
  decideBootAction,
  isJournalExpired,
  backupFolderName,
  previousInstallerPath,
  recoveryMessage,
  BOOT_CONFIRM_MS,
  MAX_BOOT_FAILURES,
  JOURNAL_RETENTION_DAYS,
  UPDATES_DIR_NAME,
} from './journal.js';
export type {
  JournalStatus,
  UpdateJournal,
  BootDecision,
  RecoveryContext,
} from './journal.js';

// Privacy line shared by main and renderer (SPEC 15 §3, §10)
export { UPDATE_PRIVACY_NOTE } from './state.js';

// The yt-dlp updater, separate from app updates (SPEC 15 §9)
export {
  YTDLP_CHECK_INTERVAL_MS,
  YTDLP_USER_DIR,
  parseYtDlpVersion,
  compareYtDlpVersions,
  chooseYtDlpBinary,
  findChecksum,
  evaluateYtDlpUpdate,
  planYtDlpInstall,
  shouldRestoreBundled,
  describeYtDlpStatus,
} from './ytdlp.js';
export type {
  YtDlpSource,
  YtDlpVersion,
  YtDlpUpdateCheck,
  YtDlpCheckInput,
  YtDlpInstallPlan,
} from './ytdlp.js';
