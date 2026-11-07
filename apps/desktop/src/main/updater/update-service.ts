/**
 * SPEC 15 §2 — `UpdateService`.
 *
 * The renderer never touches `electron-updater`; it sees `UpdateState` and calls
 * methods on this service over IPC. Two rules decide the shape of everything
 * here:
 *
 *   §2.2 — `autoDownload = false`, `autoInstallOnAppQuit = false`. Nothing is
 *           downloaded or installed without an explicit user action.
 *   §5   — the signed manifest gates the download. A release whose signature we
 *           cannot verify is never offered, and a file whose hash disagrees with
 *           the signed manifest is deleted.
 *
 * Everything that talks to the outside world (the updater, the network) is
 * injected, so the whole flow runs in tests against fakes and real keys.
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SNOOZE_MS,
  classifyUpdateError,
  createUpdateError,
  createUpdateState,
  decideUpdate,
  evaluateVerification,
  formatDownloadSize,
  isValidVersion,
  isNewerVersion,
  parseReleaseManifest,
  reduceUpdateState,
  summariseReleaseNotes,
  verifyDownloadedFile,
  verifyManifestSignature,
  type LatestYml,
  type ReleaseManifest,
  type ReleaseNotes,
  type UpdateChannel,
  type UpdateError,
  type UpdateEvent,
  type UpdateProgress,
  type UpdateState,
} from '@clipwright/update-core';
import {
  ALLOWED_UPDATE_HOSTS,
  UPDATE_REPO,
  hasUsableKeys,
  isAllowedUpdateUrl,
  releaseAssetBaseUrl,
  updateUserAgent,
} from './update-config.js';

/** The subset of electron-updater's `AppUpdater` this service uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  downloadPromise?: Promise<unknown> | null;
}

/** Minimal fetch surface, so tests can answer with plain objects. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' | 'manual' },
) => Promise<{
  ok: boolean;
  status: number;
  url?: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface UpdateServiceOptions {
  currentVersion: string;
  channel: UpdateChannel;
  /** Trusted Ed25519 public keys (§5). */
  keys: { current: string; next?: string };
  /** `null` when no automatic scheduling is wanted (tests, or no updater). */
  getUpdater: () => UpdaterLike | null;
  fetch: FetchLike;
  /** Where downloads and the manifest are cached. */
  cacheDir: string;
  /** Persisted last-check time, so a restart does not re-check (§3). */
  getLastCheckedAt?: () => number | null;
  setLastCheckedAt?: (at: number) => void;
  onStateChange?: (state: UpdateState) => void;
  logger?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
  /** Overridable for tests; both default to the real clock. */
  now?: () => number;
  /** Installer authenticity, for the "Unsigned installer" notice (§6.4). */
  isInstallerSigned?: () => boolean;
}

export type CheckResult =
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; release: ReleaseNotes }
  | { status: 'error'; error: UpdateError };

export interface DownloadResult {
  ok: boolean;
  filePath?: string;
  error?: UpdateError;
}

/** §4.1: manual checks time out after 15 s. */
export const CHECK_TIMEOUT_MS = 15_000;

export class UpdateService {
  private readonly options: UpdateServiceOptions;
  private readonly events = new EventEmitter();
  private state: UpdateState;
  private readonly now: () => number;
  private abort: AbortController | null = null;
  /** Bytes needed before the dialog can promise an exact percentage. */
  private lastProgressAt = 0;
  private lastProgressBytes = 0;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.state = createUpdateState({
      currentVersion: options.currentVersion,
      channel: options.channel,
      lastCheckedAt: options.getLastCheckedAt?.() ?? null,
    });
  }

  /** Current state, for the initial render and the IPC getter. */
  snapshot(): UpdateState {
    return this.state;
  }

  /** Subscribe to state changes (the IPC layer forwards these to the window). */
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.events.on('state', listener);
    return () => this.events.off('state', listener);
  }

  private apply(event: UpdateEvent): void {
    const next = reduceUpdateState(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.options.onStateChange?.(next);
    this.events.emit('state', next);
  }

  /* ------------------------------------------------------------------ *
   * Checking for updates
   * ------------------------------------------------------------------ */

  /**
   * Check GitHub for a release.
   *
   * `manual` decides only how failures are reported: an automatic check logs and
   * stays silent (§3), a manual one explains itself (§4.1).
   */
  async check(options: { manual: boolean }): Promise<CheckResult> {
    this.apply({ type: 'check-started' });

    try {
      const release = await this.fetchCandidate(options.manual);
      const at = this.now();
      this.options.setLastCheckedAt?.(at);

      if (release === null) {
        this.apply({ type: 'check-up-to-date', at });
        return { status: 'up-to-date', version: this.options.currentVersion };
      }

      this.apply({ type: 'check-found', release, notice: release.notice ?? null });
      return { status: 'available', release };
    } catch (error) {
      const classified = this.toUpdateError(error);
      const at = this.now();
      this.options.setLastCheckedAt?.(at);
      this.apply({ type: 'check-failed', error: classified, at, manual: options.manual });
      if (!options.manual) {
        // §3: automatic failures are silent, but logged.
        this.options.logger?.warn('Automatic update check failed', { detail: classified.detail });
      }
      return { status: 'error', error: classified };
    }
  }

  /**
   * Find, verify and describe a candidate release.
   *
   * Returns `null` when there is nothing newer. Throws an `UpdateVerificationError`
   * (turned into the "couldn't be verified" message) when a release exists but
   * cannot be trusted — we do not fall back to "no update is available", because
   * that would hide a genuine problem from the user.
   */
  private async fetchCandidate(manual: boolean): Promise<(ReleaseNotes & { notice?: string | null }) | null> {
    const keys = this.options.keys;
    if (!hasUsableKeys(keys)) {
      // §5: fail closed. A build with no key refuses rather than trusting.
      throw new UpdateVerificationError('This build cannot verify updates.');
    }

    const updater = this.options.getUpdater();
    if (!updater) throw new UpdateUnavailableError('The updater is not available in this build.');

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = this.options.channel === 'beta';

    const result = await this.withTimeout(updater.checkForUpdates(), CHECK_TIMEOUT_MS);
    const version = result?.updateInfo?.version;
    if (!version) return null;

    if (!isValidVersion(version)) {
      throw new UpdateVerificationError(`Unrecognised version ${version}.`);
    }
    if (!isNewerVersion(version, this.options.currentVersion)) return null;

    // Fetch the signed manifest for exactly this version and verify it before the
    // user is even told a release exists (§5).
    const tag = version.startsWith('v') ? version : `v${version}`;
    const base = releaseAssetBaseUrl(tag);
    const manifestText = await this.fetchText(`${base}/release-manifest.json`);
    const parsed = parseReleaseManifest(manifestText);
    if (!parsed.ok) {
      this.options.logger?.warn('Release manifest rejected', { problem: parsed.problem });
      throw new UpdateVerificationError('The release manifest is malformed.');
    }
    const manifest = parsed.manifest;

    // §5 downgrade protection, now against the signed document rather than the
    // updater's word.
    if (!isNewerVersion(manifest.version, this.options.currentVersion)) {
      return null;
    }

    const signature = await this.fetchText(`${base}/release-manifest.json.sig`).catch(() => '');
    const signatureCheck = verifyManifestSignature(manifestText, signature, keys);

    const latest = await this.fetchLatestYml().catch(() => null);
    const verification = evaluateVerification({
      manifest,
      signatureValid: signatureCheck.ok,
      signaturePresent: Boolean(signature.trim()),
      latest,
      now: this.now(),
    });

    if (!verification.ok) {
      this.options.logger?.warn('Update refused', {
        stage: verification.stage,
        reason: signatureCheck.ok ? undefined : signatureCheck.reason,
      });
      throw new UpdateVerificationError(verification.message);
    }

    // §2.5: channel rules, applied to the *verified* release.
    const decision = decideUpdate({
      currentVersion: this.options.currentVersion,
      releaseVersion: manifest.version,
      channel: this.options.channel,
      prerelease: manifest.channel === 'beta',
      minimumSupportedVersion: manifest.minimumSupportedVersion,
    });
    if (decision.action !== 'update') return null;

    const notes = await this.fetchReleaseNotes(manifest.version).catch(() => null);
    const installer = pickInstaller(manifest);
    const signed = this.options.isInstallerSigned?.() ?? false;

    return {
      version: manifest.version,
      summary: manifest.summary || summariseReleaseNotes(notes?.body ?? ''),
      full: notes?.body ?? manifest.summary,
      releasedAt: notes?.publishedAt ?? manifest.generatedAt,
      prerelease: manifest.channel === 'beta',
      downloadBytes: installer?.size ?? 0,
      signed,
      htmlUrl: `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/${tag}`,
      notice: verification.stale
        ? 'This release information is more than a year old.'
        : manual
          ? null
          : null,
    };
  }

  /** Release notes from the GitHub API, when it answers; the manifest is enough otherwise. */
  private async fetchReleaseNotes(
    version: string,
  ): Promise<{ body: string; publishedAt: string } | null> {
    const tag = version.startsWith('v') ? version : `v${version}`;
    const url = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tags/${tag}`;
    const response = await this.options.fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': updateUserAgent(this.options.currentVersion, process.platform),
      },
      signal: this.abortSignal(),
    });
    if (!response.ok) return null;
    const json = JSON.parse(await response.text()) as { body?: string; published_at?: string };
    return { body: json.body ?? '', publishedAt: json.published_at ?? '' };
  }

  /**
   * §11: fetch `latest.yml` from the release rather than the API where possible,
   * to stay clear of unauthenticated rate limits.
   */
  private async fetchLatestYml(): Promise<LatestYml | null> {
    const url = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest/download/latest.yml`;
    const text = await this.fetchText(url);
    return parseLatestYml(text);
  }

  private async fetchText(url: string): Promise<string> {
    this.assertAllowed(url);
    const response = await this.options.fetch(url, {
      headers: { 'user-agent': updateUserAgent(this.options.currentVersion, process.platform) },
      signal: this.abortSignal(),
    });
    if (!response.ok) {
      if (response.status === 429) throw new UpdateRateLimitError();
      if (response.status === 404) throw new UpdateNotFoundError(url);
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }
    // §5: redirects must not lead off the allow-listed hosts.
    if (response.url) this.assertAllowed(response.url);
    return response.text();
  }

  private assertAllowed(url: string): void {
    if (!isAllowedUpdateUrl(url)) {
      throw new UpdateVerificationError(
        `Refused to contact ${safeHost(url)}: updates only come from ${ALLOWED_UPDATE_HOSTS[0]}.`,
      );
    }
  }

  private abortSignal(): AbortSignal | undefined {
    return this.abort?.signal;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError()), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ *
   * Downloading (§4.2)
   * ------------------------------------------------------------------ */

  /**
   * Download the verified installer, then verify the file against the signed
   * manifest (§5 layer 2). Resolves `ok` only when both steps passed.
   */
  async download(): Promise<DownloadResult> {
    const release = this.state.release;
    if (!release || this.state.status !== 'available') {
      return { ok: false, error: createUpdateError('unknown', 'No update is available.') };
    }

    this.abort = new AbortController();
    this.lastProgressAt = this.now();
    this.lastProgressBytes = 0;

    try {
      const tag = release.version.startsWith('v') ? release.version : `v${release.version}`;
      const base = releaseAssetBaseUrl(tag);
      const manifestText = await this.fetchText(`${base}/release-manifest.json`);
      const parsed = parseReleaseManifest(manifestText);
      if (!parsed.ok) throw new UpdateVerificationError('The release manifest is malformed.');
      const manifest = parsed.manifest;

      const installer = pickInstaller(manifest);
      if (!installer) throw new UpdateVerificationError('The release has no installer.');
      this.assertAllowed(`${base}/${installer.name}`);

      this.apply({ type: 'download-started', totalBytes: installer.size });

      const filePath = join(this.options.cacheDir, installer.name);
      const bytes = await this.downloadFile(`${base}/${installer.name}`, filePath, installer.size);

      this.apply({ type: 'download-verifying' });

      const digest = createHash('sha256').update(bytes).digest('hex');
      const check = verifyDownloadedFile({
        manifest,
        fileName: installer.name,
        sha256: digest,
        sizeBytes: bytes.byteLength,
      });
      if (!check.ok) {
        await rm(filePath, { force: true });
        this.apply({ type: 'download-failed', error: createUpdateError('damaged') });
        return { ok: false, error: createUpdateError('damaged') };
      }

      this.apply({ type: 'download-finished', notice: null });
      return { ok: true, filePath };
    } catch (error) {
      const classified = this.toUpdateError(error);
      this.apply({ type: 'download-failed', error: classified });
      return { ok: false, error: classified };
    } finally {
      this.abort = null;
    }
  }

  /**
   * Stream a file to disk, reporting progress from bytes actually written.
   *
   * Kept whole-file in memory only for the digest: installers are ~150 MB, which
   * is fine, and it avoids a second pass over the disk to hash it.
   */
  private async downloadFile(url: string, filePath: string, expectedBytes: number): Promise<Buffer> {
    await mkdir(dirname(filePath), { recursive: true });
    // §11: a partial file from a previous run is not resumed (an HTTP Range would
    // need the server's cooperation and a verified prefix); it is replaced.
    await rm(filePath, { force: true });

    const response = await this.options.fetch(url, {
      headers: { 'user-agent': updateUserAgent(this.options.currentVersion, process.platform) },
      signal: this.abortSignal(),
    });
    if (!response.ok) {
      if (response.status === 429) throw new UpdateRateLimitError();
      throw new Error(`HTTP ${response.status} while downloading`);
    }
    if (response.url) this.assertAllowed(response.url);

    const buffer = Buffer.from(await response.arrayBuffer());

    // Report progress from the real byte count. A single-shot fetch cannot give
    // per-chunk events, so we report the completed transfer honestly rather than
    // animating a bar that is not backed by bytes received.
    const total = expectedBytes > 0 ? expectedBytes : buffer.byteLength;
    this.apply({
      type: 'download-progress',
      transferredBytes: buffer.byteLength,
      totalBytes: total,
      bytesPerSecond: 0,
      etaSec: null,
    });

    await writeFile(filePath, buffer);
    return buffer;
  }

  /** §4.2: Cancel during download returns to "available". */
  cancelDownload(): void {
    if (this.state.status !== 'downloading' && this.state.status !== 'verifying') return;
    this.abort?.abort();
    this.abort = null;
    this.apply({ type: 'download-cancelled' });
  }

  /* ------------------------------------------------------------------ *
   * Installing (§2.2, §7)
   * ------------------------------------------------------------------ */

  /**
   * Install and restart. Only reachable from `ready`, which is only reachable
   * after a verified download that the user started.
   */
  async installAndRestart(): Promise<{ ok: boolean; error?: UpdateError }> {
    if (this.state.status !== 'ready') {
      return { ok: false, error: createUpdateError('unknown', 'The update is not ready yet.') };
    }
    this.apply({ type: 'install-started' });
    try {
      const updater = this.options.getUpdater();
      if (!updater) throw new UpdateUnavailableError('The updater is not available in this build.');
      // `isSilent = false`: NSIS shows its normal progress UI, never a hidden
      // install (§7.2).
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      const classified = this.toUpdateError(error);
      this.apply({ type: 'install-failed', error: classified });
      return { ok: false, error: classified };
    }
  }

  /* ------------------------------------------------------------------ *
   * User actions from the dialog (§4.2)
   * ------------------------------------------------------------------ */

  skip(): void {
    const version = this.state.release?.version;
    if (!version) return;
    this.apply({ type: 'skip', version });
  }

  remindLater(): void {
    this.apply({ type: 'remind-later', until: this.now() + SNOOZE_MS });
  }

  dismiss(): void {
    this.apply({ type: 'dismiss' });
  }

  /* ------------------------------------------------------------------ *
   * Automatic checks (§3)
   * ------------------------------------------------------------------ */

  /**
   * Run an automatic check if one is due. Never throws and never surfaces a
   * failure to the user; returns whether a check actually ran.
   *
   * The caller owns the *schedule* (that is `shouldAutoCheck` from update-core);
   * this method only guarantees the silence.
   */
  async autoCheckIfDue(shouldCheck: boolean): Promise<boolean> {
    if (!shouldCheck) return false;
    if (this.state.status === 'downloading' || this.state.status === 'verifying') return false;
    await this.check({ manual: false });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Errors
   * ------------------------------------------------------------------ */

  private toUpdateError(error: unknown): UpdateError {
    if (error instanceof UpdateVerificationError) {
      return createUpdateError('unverified', error.message);
    }
    if (error instanceof UpdateRateLimitError) return createUpdateError('rate-limited');
    if (error instanceof UpdateNotFoundError) return createUpdateError('unverified', error.message);
    if (error instanceof TimeoutError) return createUpdateError('offline', 'The check timed out.');
    if (error instanceof UpdateUnavailableError) return createUpdateError('unknown', error.message);
    return classifyUpdateError(error);
  }

  /** Test seam: replace state without going through the network. */
  _setStateForTest(state: UpdateState): void {
    this.state = state;
  }
}

/* ---------------------------------------------------------------------- *
 * Internal error kinds, so the wording stays in update-core.
 * ---------------------------------------------------------------------- */

class UpdateVerificationError extends Error {}
class UpdateRateLimitError extends Error {}
class UpdateNotFoundError extends Error {}
class UpdateUnavailableError extends Error {}
class TimeoutError extends Error {}

/* ---------------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------------- */

/** The installer in a manifest: the setup exe, never the portable one (§5). */
export function pickInstaller(manifest: ReleaseManifest): { name: string; size: number } | null {
  const setup = manifest.files.find((file) => /-Setup-.*-x64\.exe$/i.test(file.name));
  const chosen = setup ?? manifest.files[0];
  return chosen ? { name: chosen.name, size: chosen.size } : null;
}

/**
 * Parse `latest.yml` without a YAML dependency: electron-builder writes a
 * predictable shape, and only `version` and the file entries matter here.
 */
export function parseLatestYml(text: string): LatestYml | null {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
  const files: LatestYml['files'] = [];
  // Each `- url`/`path:` entry under `files:` carries sha512 and size.
  const blocks = text.split(/\n\s*-\s+/).slice(1);
  for (const block of blocks) {
    const path =
      /(?:url|path):\s*['"]?([^'"\s]+)['"]?/.exec(block)?.[1] ??
      /name:\s*['"]?([^'"\s]+)['"]?/.exec(block)?.[1];
    const sha512 = /sha512:\s*['"]?([^'"\s]+)['"]?/.exec(block)?.[1];
    const sizeRaw = /size:\s*(\d+)/.exec(block)?.[1];
    if (!path || !sha512) continue;
    files.push({ path, sha512, size: sizeRaw ? Number(sizeRaw) : undefined });
  }
  if (!version || files.length === 0) return null;
  return { version, files };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'that address';
  }
}

/** §4.2: the dialog shows "142 MB" before the download starts. */
export function describeDownloadSize(bytes: number): string {
  return formatDownloadSize(bytes);
}

/** Exposed for the IPC layer, which needs the same progress formatting. */
export type { UpdateProgress, UpdateState };
