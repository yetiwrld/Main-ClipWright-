/**
 * SPEC 15 §9 — the yt-dlp updater's file work.
 *
 * The rules live in `@clipwright/update-core/ytdlp`; this reads and writes.
 *
 * The order of operations is the whole design:
 *
 *   1. download to a temporary file
 *   2. verify the digest against yt-dlp's own SHA2-256SUMS
 *   3. only then move the current binary to `yt-dlp.previous`
 *   4. only then move the new one into place
 *
 * A failure at any step leaves a working binary where it was. Nothing is deleted
 * until its replacement is known good on disk, because "download a new one" must
 * never mean "and now there isn't an old one either".
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  YTDLP_USER_DIR,
  chooseYtDlpBinary,
  evaluateYtDlpUpdate,
  planYtDlpInstall,
  shouldRestoreBundled,
  type YtDlpUpdateCheck,
} from '@clipwright/update-core';

export interface YtDlpServiceOptions {
  /** `%APPDATA%\Clipwright Studio` — user-writable, never the install directory. */
  userDataDir: string;
  /** The shipped binaries, read-only. */
  bundledDir: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Reads the version a binary reports, or null when it cannot run. */
  readVersion?: (path: string) => Promise<string | null>;
}

export interface YtDlpState {
  /** Version in use, or null when nothing works. */
  version: string | null;
  source: 'bundled' | 'user' | null;
  /** Where that binary is. */
  path: string | null;
  /** A newer version is available, if it has been checked. */
  available: { version: string; downloadUrl: string } | null;
  lastCheckedAt: number | null;
  /** Plain sentence for Settings → Updates. */
  message: string;
  /** Set when an update could not be installed. */
  error: string | null;
}

const RELEASE_PAGE = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
/** §9: the standalone Windows asset and the checksum list beside it. */
const ASSET_NAMES: Record<string, string> = {
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux',
  darwin: 'yt-dlp_macos',
};

export class YtDlpService {
  private readonly options: YtDlpServiceOptions;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private lastCheckedAt: number | null = null;
  private lastError: string | null = null;
  private available: { version: string; downloadUrl: string } | null = null;

  constructor(options: YtDlpServiceOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => Date.now());
  }

  /** `<userData>/bin` — user-writable, per §9. */
  get userBinDir(): string {
    return join(this.options.userDataDir, YTDLP_USER_DIR);
  }

  private get binaryName(): string {
    return ASSET_NAMES[this.platform] ?? 'yt-dlp';
  }

  private get userPath(): string {
    return join(this.userBinDir, this.binaryName);
  }

  private get bundledPath(): string {
    return join(this.options.bundledDir, this.binaryName);
  }

  private get previousPath(): string {
    return join(this.userBinDir, this.binaryName.replace(/(\.[^.]+)?$/, '.previous$1'));
  }

  /** Decide which binary to run, then describe it (§9). */
  async describe(): Promise<YtDlpState> {
    const readVersion = this.options.readVersion ?? defaultReadVersion;
    const bundledExists = existsSync(this.bundledPath);
    const userExists = existsSync(this.userPath);

    const bundledVersion = bundledExists ? await readVersion(this.bundledPath).catch(() => null) : null;
    const userVersion = userExists ? await readVersion(this.userPath).catch(() => null) : null;

    const chosen = chooseYtDlpBinary({
      bundled: bundledVersion ? { version: bundledVersion, path: this.bundledPath } : null,
      user: userVersion ? { version: userVersion, path: this.userPath, verified: true } : null,
    });

    const daysAgo = this.lastCheckedAt === null ? 'Never checked' : 'Checked recently';
    return {
      version: chosen?.version ?? null,
      source: chosen?.source ?? null,
      path: chosen?.path ?? null,
      available: this.available,
      lastCheckedAt: this.lastCheckedAt,
      message: chosen
        ? `${chosen.version} (${chosen.source === 'user' ? 'downloaded separately' : 'bundled'}). ${daysAgo}.`
        : 'yt-dlp was not found. Reinstall Clipwright Studio to restore it.',
      error: this.lastError,
    };
  }

  /**
   * Check for a newer release. `manual` skips the weekly schedule, because a
   * user pressing "Check now" has already decided to spend the network call.
   */
  async check(options: { manual?: boolean; autoCheckEnabled?: boolean; blocked?: boolean } = {}): Promise<YtDlpUpdateCheck> {
    const state = await this.describe();

    const preliminary = evaluateYtDlpUpdate({
      now: this.now(),
      lastCheckedAt: this.lastCheckedAt,
      autoCheckEnabled: options.manual ? false : options.autoCheckEnabled ?? true,
      updatesBlocked: options.blocked,
      currentVersion: state.version,
      latest: null, // only to learn whether a check is due at all
    });

    // `not-due` and `blocked` are answers in themselves; anything else means the
    // network call is worth making.
    if (preliminary.kind === 'not-due' || preliminary.kind === 'blocked') return preliminary;

    let latest: Parameters<typeof evaluateYtDlpUpdate>[0]['latest'] = null;
    try {
      const fetcher = this.options.fetch ?? fetch;
      const response = await fetcher(RELEASE_PAGE, {
        headers: {
          // §10: a version and platform, nothing identifying.
          'User-Agent': 'ClipwrightStudio-ytdlp-updater',
          Accept: 'application/vnd.github+json',
        },
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

      const release = (await response.json()) as {
        tag_name?: string;
        assets?: Array<{ name: string; browser_download_url: string }>;
      };
      const assetName = this.binaryName;
      const asset = release.assets?.find((candidate) => candidate.name === assetName);
      const sums = release.assets?.find((candidate) => /SHA2-256SUMS$/i.test(candidate.name));

      if (!asset || !sums) throw new Error(`${assetName} is not in this release`);

      const sumsResponse = await fetcher(sums.browser_download_url);
      if (!sumsResponse.ok) throw new Error('the checksum file could not be read');
      const sumsText = await sumsResponse.text();

      latest = {
        version: release.tag_name ?? '',
        assetName,
        downloadUrl: asset.browser_download_url,
        sumsText,
      };
    } catch (error) {
      this.lastError = `The yt-dlp release could not be read (${describeNetworkError(error)}). Link downloads use the version that came with Clipwright.`;
      this.lastCheckedAt = this.now();
      return { kind: 'error', message: this.lastError };
    }

    const decision = evaluateYtDlpUpdate({
      now: this.now(),
      lastCheckedAt: null, // the schedule was already applied above
      autoCheckEnabled: false,
      currentVersion: state.version,
      latest,
    });

    this.lastCheckedAt = this.now();
    this.lastError = decision.kind === 'error' ? decision.message : null;
    this.available = decision.kind === 'available'
      ? { version: decision.version, downloadUrl: decision.downloadUrl }
      : null;

    return decision;
  }

  /**
   * Download, verify and install. Returns the state afterwards so the caller
   * does not have to re-read it.
   */
  async update(input: {
    downloadUrl: string;
    expectedSha256: string;
    version: string;
  }): Promise<{ ok: boolean; error?: string; state: YtDlpState }> {
    await mkdir(this.userBinDir, { recursive: true });
    const temporary = `${this.userPath}.part`;

    try {
      const fetcher = this.options.fetch ?? fetch;
      const response = await fetcher(input.downloadUrl);
      if (!response.ok) throw new Error(`the download failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(temporary, bytes);
    } catch (error) {
      await rm(temporary, { force: true });
      this.lastError = `The yt-dlp update could not be downloaded (${describeNetworkError(error)}). Link downloads use the version that came with Clipwright.`;
      return { ok: false, error: this.lastError, state: await this.describe() };
    }

    // Verify before anything is moved: a bad file must not touch the good one.
    const actualSha256 = await sha256OfFile(temporary);
    const plan = planYtDlpInstall({
      actualSha256,
      expectedSha256: input.expectedSha256,
      hasExisting: existsSync(this.userPath),
    });

    if (!plan.ok) {
      await rm(temporary, { force: true });
      this.lastError = plan.reason ?? 'The downloaded yt-dlp could not be installed.';
      return { ok: false, error: this.lastError, state: await this.describe() };
    }

    try {
      // Step 3 then step 4, so there is never a moment with no binary at all.
      if (plan.keepBackup) await rename(this.userPath, this.previousPath);
      await rename(temporary, this.userPath);
      this.lastError = null;
      this.available = null;
      return { ok: true, state: await this.describe() };
    } catch (error) {
      // Put the old one back if the new one could not be moved into place.
      if (existsSync(this.previousPath) && !existsSync(this.userPath)) {
        await rename(this.previousPath, this.userPath).catch(() => undefined);
      }
      await rm(temporary, { force: true });
      this.lastError = `The yt-dlp update could not be installed: ${(error as Error).message}`;
      return { ok: false, error: this.lastError, state: await this.describe() };
    }
  }

  /** §9 "Restore bundled version" — remove the downloaded copy. */
  async restoreBundled(): Promise<{ ok: boolean; reason?: string; state: YtDlpState }> {
    const verdict = shouldRestoreBundled({
      userExists: existsSync(this.userPath),
      bundledExists: existsSync(this.bundledPath),
    });

    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, state: await this.describe() };
    }

    // Move rather than delete: a user who clicks this by mistake retains a path
    // back, and the file is only a few megabytes.
    await rename(this.userPath, this.previousPath).catch(() => undefined);
    this.available = null;
    return { ok: true, state: await this.describe() };
  }
}

async function sha256OfFile(path: string): Promise<string> {
  // yt-dlp assets are ~30 MB, so reading whole is fine and avoids stream timing.
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function defaultReadVersion(path: string): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const version = stdout.trim();
      return resolve(version.length > 0 ? version : null);
    });
  });
}

/** §4.1/§9: turn a network failure into a sentence, never a stack trace. */
function describeNetworkError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'no internet connection';
  if (/certificate|self.signed|UNABLE_TO_VERIFY/i.test(message)) return 'the connection could not be verified';
  if (/timeout|ETIMEDOUT/i.test(message)) return 'the connection timed out';
  if (/403|rate limit/i.test(message)) return 'GitHub refused the request';
  return message;
}
