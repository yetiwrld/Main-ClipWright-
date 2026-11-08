/**
 * SPEC 15 §4 — the update flow as data.
 *
 * The renderer only ever sees `UpdateState` (§2.3), and that state can only be
 * changed through the transitions here. Keeping it pure means the whole flow —
 * including the parts that are awkward to click through by hand, like "remind me
 * later" expiring or a download being cancelled mid-flight — is testable without
 * Electron, a network or a clock.
 *
 * Guiding rules from the spec that show up as code below:
 *   - `autoDownload = false`, `autoInstallOnAppQuit = false` (§2.2): reaching
 *     `ready` requires an explicit `download` event.
 *   - Installing requires an explicit click (§2.2): `install` is only accepted
 *     from `ready`.
 *   - Automatic failures are silent and logged; manual ones are explained (§3).
 */

import type { ReleaseManifest } from './manifest.js';
import type { UpdateChannel } from './version.js';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error';

export interface UpdateProgress {
  /** 0–100, derived from bytes actually received (never a guess). */
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  /** Bytes per second, measured over a window. */
  bytesPerSecond: number;
  /** Seconds remaining, or null until the rate is stable. */
  etaSec: number | null;
}

export interface ReleaseNotes {
  version: string;
  /** First paragraph, shown before the full notes (§4.2). */
  summary: string;
  /** Markdown; the UI must render it sanitised. */
  full: string;
  releasedAt: string;
  prerelease: boolean;
  downloadBytes: number;
  /** `false` when the installer carries no Authenticode signature, so the
   *  dialog shows the "Unsigned installer" notice (§6.4). */
  signed: boolean;
  htmlUrl: string;
}

export interface UpdateState {
  status: UpdateStatus;
  /** Version of the running app. */
  currentVersion: string;
  channel: UpdateChannel;
  /** Epoch ms of the last completed check (success or failure), or null. */
  lastCheckedAt: number | null;
  /** Present in `available`/`downloading`/`ready`/`installing`. */
  release: ReleaseNotes | null;
  /** Present in `downloading`. */
  progress: UpdateProgress | null;
  /** Present in `error`. */
  error: UpdateError | null;
  /** §4.2 "Skip this version" — remembered so the dialog does not nag. */
  skippedVersion: string | null;
  /** §4.2 "Remind me later" — the dialog stays quiet until this time. */
  snoozedUntil: number | null;
  /** Advisory shown under the version, e.g. a stale manifest (§5). */
  notice: string | null;
}

/**
 * Errors the user can be shown (§4.1: "plain reason … never a stack trace").
 */
export type UpdateErrorKind =
  | 'offline'
  | 'rate-limited'
  | 'unverified'
  | 'damaged'
  | 'not-enough-space'
  | 'quarantined'
  | 'no-signature'
  /** §6.3: the portable build cannot replace itself; the user swaps the file. */
  | 'portable-self-update'
  | 'unknown';

export interface UpdateError {
  kind: UpdateErrorKind;
  /** The sentence shown to the user. */
  message: string;
  /** True when the cause may go away on its own, so we offer a retry. */
  retryable: boolean;
  /** Full detail for the log only. */
  detail?: string;
}

const ERROR_TEXT: Record<UpdateErrorKind, { message: string; retryable: boolean }> = {
  offline: {
    message: "Couldn't reach GitHub. Check your internet connection.",
    retryable: true,
  },
  'rate-limited': {
    message: 'GitHub is limiting requests. Try again later.',
    retryable: true,
  },
  unverified: {
    message: "This update couldn't be verified, so it was not installed.",
    retryable: false,
  },
  damaged: {
    message: 'The download was damaged and has been removed.',
    retryable: true,
  },
  'not-enough-space': {
    message: 'There is not enough free space to download this update.',
    retryable: true,
  },
  'portable-self-update': {
    // §6.3: actionable rather than apologetic — the user's next step is a file
    // swap, and saying so is the whole value of this error.
    message:
      'This is the portable version, so it cannot install updates itself. ' +
      'Download the new version, close Clipwright Studio, and replace the .exe.',
    retryable: false,
  },
  quarantined: {
    message: 'The downloaded file was removed by your security software.',
    retryable: false,
  },
  'no-signature': {
    message: "This update couldn't be verified, so it was not installed.",
    retryable: false,
  },
  unknown: {
    message: "The update couldn't be completed.",
    retryable: true,
  },
};

/** Build a user-facing error with the standard wording for its kind. */
export function createUpdateError(kind: UpdateErrorKind, detail?: string): UpdateError {
  const entry = ERROR_TEXT[kind];
  if (!entry) {
    // An unknown kind must still produce something renderable rather than crash
    // while the app is already telling the user about a failure.
    return { kind: 'unknown', message: ERROR_TEXT.unknown.message, retryable: true };
  }
  const { message, retryable } = entry;
  return detail ? { kind, message, retryable, detail } : { kind, message, retryable };
}

/**
 * Map a network/fs failure onto an error kind. Deliberately conservative: an
 * unrecognised failure becomes `unknown` with its message kept in `detail` only.
 */
export function classifyUpdateError(error: unknown): UpdateError {
  if (!error) return createUpdateError('unknown');
  const message = error instanceof Error ? error.message : String(error);
  // Node hides the real reason inside `cause`: an offline machine produces
  // `TypeError: fetch failed` with `cause.code === 'ENOTFOUND'`. Classifying on
  // the message alone told the user "The update couldn't be completed" when the
  // answer was "there is no internet connection".
  const cause = (error as { cause?: unknown })?.cause;
  const causeCode =
    typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  const lower = `${message} ${causeCode}`.toLowerCase();

  // Offline / DNS / TLS-shaped failures.
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('eai_again') ||
    lower.includes('network') ||
    lower.includes('offline') ||
    lower.includes('getaddrinfo') ||
    // The generic undici failure: when `fetch` cannot reach the network at all it
    // throws exactly this, with the specific reason in `cause`.
    lower.includes('fetch failed')
  ) {
    return createUpdateError('offline', message);
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return createUpdateError('rate-limited', message);
  }
  if (lower.includes('enospc') || lower.includes('no space')) {
    return createUpdateError('not-enough-space', message);
  }
  if (
    lower.includes('eperm') ||
    lower.includes('eacces') ||
    lower.includes('virus') ||
    // §11: "the downloaded file was removed by your security software". On
    // Windows a scanner holding the file open produces EBUSY or ENOENT on the
    // downloaded installer, not a message that mentions security.
    lower.includes('ebusy')
  ) {
    return createUpdateError('quarantined', message);
  }
  if (lower.includes('signature') || lower.includes('sha512') || lower.includes('checksum')) {
    return createUpdateError('unverified', message);
  }
  return createUpdateError('unknown', message);
}

/** Events that can move the machine. */
export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'check-found'; release: ReleaseNotes; notice?: string | null }
  | { type: 'check-up-to-date'; at: number }
  | { type: 'check-failed'; error: UpdateError; at: number; manual: boolean }
  | { type: 'download-started'; totalBytes: number }
  | { type: 'download-progress'; transferredBytes: number; totalBytes: number; bytesPerSecond: number; etaSec: number | null }
  | { type: 'download-verifying' }
  | { type: 'download-finished'; notice?: string | null }
  | { type: 'download-failed'; error: UpdateError }
  | { type: 'download-cancelled' }
  | { type: 'install-started' }
  | { type: 'install-failed'; error: UpdateError }
  | { type: 'skip'; version: string }
  | { type: 'remind-later'; until: number }
  | { type: 'dismiss' };

/**
 * Apply an event. Returns the next state.
 *
 * Transitions that would break a §2.2 rule are ignored rather than throwing: the
 * main process may emit a late progress event after a cancel, and that must not
 * resurrect a download or wedge the UI.
 */
export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case 'check-started':
      // A check while downloading would throw away real progress.
      if (state.status === 'downloading' || state.status === 'verifying' || state.status === 'ready') {
        return state;
      }
      return { ...state, status: 'checking', error: null, notice: null };

    case 'check-found':
      return {
        ...state,
        status: 'available',
        release: event.release,
        progress: null,
        error: null,
        notice: event.notice ?? null,
        // A new version supersedes a previous skip.
        skippedVersion:
          state.skippedVersion && state.skippedVersion !== event.release.version
            ? null
            : state.skippedVersion,
      };

    case 'check-up-to-date':
      return {
        ...state,
        status: 'up-to-date',
        lastCheckedAt: event.at,
        release: null,
        error: null,
        notice: null,
      };

    case 'check-failed':
      return {
        ...state,
        status: 'error',
        lastCheckedAt: event.at,
        // An automatic check must not interrupt the user (§3); the caller logs it
        // and can pass manual:false to keep the status quiet.
        error: event.manual ? event.error : null,
        release: null,
      };

    case 'download-started':
      if (state.status !== 'available') return state;
      return {
        ...state,
        status: 'downloading',
        progress: {
          percent: 0,
          transferredBytes: 0,
          totalBytes: event.totalBytes,
          bytesPerSecond: 0,
          etaSec: null,
        },
      };

    case 'download-progress': {
      if (state.status !== 'downloading') return state;
      const percent =
        event.totalBytes > 0
          ? Math.min(100, Math.max(0, (event.transferredBytes / event.totalBytes) * 100))
          : 0;
      return {
        ...state,
        progress: {
          percent,
          transferredBytes: event.transferredBytes,
          totalBytes: event.totalBytes,
          bytesPerSecond: event.bytesPerSecond,
          etaSec: event.etaSec,
        },
      };
    }

    case 'download-verifying':
      if (state.status !== 'downloading') return state;
      return { ...state, status: 'verifying' };

    case 'download-finished':
      if (state.status !== 'verifying' && state.status !== 'downloading') return state;
      return {
        ...state,
        status: 'ready',
        notice: event.notice ?? state.notice,
        progress: state.progress ? { ...state.progress, percent: 100 } : null,
      };

    case 'download-failed':
      return { ...state, status: 'error', error: event.error, progress: null };

    case 'download-cancelled':
      return { ...state, status: 'available', progress: null };

    case 'install-started':
      if (state.status !== 'ready') return state;
      return { ...state, status: 'installing' };

    case 'install-failed':
      return { ...state, status: 'error', error: event.error };

    case 'skip':
      return {
        ...state,
        skippedVersion: event.version,
        status: state.release?.version === event.version ? 'idle' : state.status,
        release: state.release?.version === event.version ? null : state.release,
        progress: null,
      };

    case 'remind-later':
      return {
        ...state,
        snoozedUntil: event.until,
        status: state.release ? 'idle' : state.status,
      };

    case 'dismiss':
      return { ...state, status: state.release ? 'idle' : state.status };

    default:
      return state;
  }
}

/** The initial state before any check has run. */
export function createUpdateState(options: {
  currentVersion: string;
  channel: UpdateChannel;
  lastCheckedAt?: number | null;
}): UpdateState {
  return {
    status: 'idle',
    currentVersion: options.currentVersion,
    channel: options.channel,
    lastCheckedAt: options.lastCheckedAt ?? null,
    release: null,
    progress: null,
    error: null,
    skippedVersion: null,
    snoozedUntil: null,
    notice: null,
  };
}

/**
 * Should this release interrupt the user right now?
 *
 * Covers both "skip this version" and "remind me later" (§4.2). The top-bar chip
 * (§4.2) uses `shouldShowChip` instead, which ignores the snooze but honours the
 * skip — a deliberate difference: the chip is passive, the dialog is not.
 */
export function shouldPrompt(state: UpdateState, now: number): boolean {
  // `idle` still runs through here because "remind me later" parks the release in
  // idle: once the snooze expires the dialog has to come back, otherwise
  // "Remind me later" would silently mean "never".
  if (!state.release) return false;
  if (state.status !== 'available' && state.status !== 'idle') return false;
  if (state.skippedVersion === state.release.version) return false;
  if (state.snoozedUntil !== null && now < state.snoozedUntil) return false;
  return true;
}

export function shouldShowChip(state: UpdateState): boolean {
  if (!state.release) return false;
  if (state.skippedVersion === state.release.version) return false;
  return state.status === 'available' || state.status === 'idle';
}

/** §4.2: "Remind me later" snoozes for 24 hours. */
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** Human status line for the Settings row (§3). */
export function describeUpdateStatus(state: UpdateState, now: number): string {
  switch (state.status) {
    case 'idle':
      return state.lastCheckedAt ? `Last checked ${formatCheckedAt(state.lastCheckedAt, now)}.` : 'Not checked yet.';
    case 'checking':
      return 'Checking…';
    case 'up-to-date':
      return `You're on the latest version (${state.currentVersion}).`;
    case 'available':
      return state.release ? `Version ${state.release.version} is available.` : 'An update is available.';
    case 'downloading':
      return state.progress ? `Downloading… ${Math.round(state.progress.percent)}%` : 'Downloading…';
    case 'verifying':
      return 'Verifying…';
    case 'ready':
      return state.release ? `Version ${state.release.version} is ready to install.` : 'Ready to install.';
    case 'installing':
      return 'Installing…';
    case 'error':
      return state.error ? state.error.message : "The update couldn't be completed.";
  }
}

/** `2 minutes ago` / `yesterday` / a date, for "Last checked" (§3). */
export function formatCheckedAt(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Progress as the dialog shows it (§4.2): true percentage, speed, ETA.
 * Returns null when there is nothing honest to show.
 */
export function formatDownloadProgress(progress: UpdateProgress | null): string | null {
  if (!progress) return null;
  const parts: string[] = [`${Math.floor(progress.percent)}%`];
  if (progress.bytesPerSecond > 0) {
    const mbps = progress.bytesPerSecond / (1024 * 1024);
    parts.push(`${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} MB/s`);
  }
  if (progress.etaSec !== null && progress.etaSec > 0) {
    parts.push(formatEta(progress.etaSec));
  }
  return parts.join(' · ');
}

function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s left`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m left`;
}

/** The manifest's version, if a release is loaded — used by the resume check. */
export function releaseVersionOf(state: UpdateState): string | null {
  return state.release?.version ?? null;
}

/** Re-exported so the main process can type its job without importing manifest. */
export type { ReleaseManifest };

/**
 * SPEC 15 §3, §10 — the privacy line shown in Settings → Updates and again under
 * Privacy.
 *
 * Lives here rather than beside the updater config so the renderer can show it
 * without importing main-process code into its bundle. The wording is a promise
 * from §10 (no telemetry), so it is covered by the test suite alongside the rest.
 */
export const UPDATE_PRIVACY_NOTE =
  'Checking for updates contacts github.com. Nothing about you or your projects is sent.';
