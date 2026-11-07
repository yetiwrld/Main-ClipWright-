/**
 * SPEC 15 §2.4, §5 — one place that says which repository updates come from and
 * which public keys are trusted.
 *
 * `electron-builder.yml` reads `UPDATE_REPO` from here via the build script, so
 * the app and the published `latest.yml` cannot drift apart.
 */

/** §2.4: the single source of truth for the update repository. */
export const UPDATE_REPO = {
  owner: 'yetiwrld',
  repo: 'Main-ClipWright-',
} as const;

/** Base URL for releases; assets live under `/releases/download/<tag>/<file>`. */
export function releaseAssetBaseUrl(tag: string): string {
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/download/${tag}`;
}

/** §5: HTTPS only, and redirects may only go to these hosts. */
export const ALLOWED_UPDATE_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const;

export interface UpdateFeedConfig {
  owner: string;
  repo: string;
  channel: 'stable' | 'beta';
  currentVersion: string;
}

/**
 * §5: the embedded Ed25519 public keys. `current` is used for every release;
 * `next` is populated only while a key rotation is in flight.
 *
 * These are *public* keys — safe to commit. The matching private key never
 * exists in this repository: it is generated once (`scripts/release/
 * gen-update-key.mjs`), stored as the GitHub Actions secret
 * `UPDATE_SIGNING_KEY`, and used only by `release.yml` to sign
 * `release-manifest.json`.
 *
 * A build with a placeholder key **refuses every update** rather than trusting
 * an unverified one — see `hasUsableKeys`.
 */
export const EMBEDDED_UPDATE_KEYS: { current: string; next?: string } = {
  // Replace with the base64 SPKI public key printed by gen-update-key.mjs.
  // Until a real key is embedded, updates fail closed (refused, never installed).
  current: '',
};

/**
 * Allow CI or a test build to inject the key without editing this file.
 * Returns the embedded keys when nothing is supplied.
 */
export function resolveTrustedKeys(
  env: Record<string, string | undefined> = {},
): { current: string; next?: string } {
  const current = env.UPDATE_PUBLIC_KEY_B64?.trim() || EMBEDDED_UPDATE_KEYS.current;
  const next = env.UPDATE_PUBLIC_KEY_NEXT_B64?.trim() || EMBEDDED_UPDATE_KEYS.next;
  return next ? { current, next } : { current };
}

/**
 * True when at least one non-placeholder key is present. Callers must treat
 * `false` as "this build cannot verify updates" and refuse, not as "skip the
 * check" — an unverifiable update must never be offered (§5).
 */
export function hasUsableKeys(keys: { current: string; next?: string }): boolean {
  return Boolean(keys.current?.trim() || keys.next?.trim());
}

/** §5: redirects are followed only when they stay on an allow-listed host. */
export function isAllowedUpdateUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return (ALLOWED_UPDATE_HOSTS as readonly string[]).includes(url.hostname);
}

/**
 * §3: the privacy line shown in Settings → Updates, also listed in Privacy.
 * Defined in update-core so the renderer can show the same string without
 * importing main-process code; re-exported here for existing call sites.
 */
export { UPDATE_PRIVACY_NOTE } from '@clipwright/update-core';

/**
 * User-Agent for update requests. §3: it may include the app version and OS and
 * nothing else — no identifiers, no machine name, no install id.
 */
export function updateUserAgent(appVersion: string, platform: string): string {
  return `ClipwrightStudio/${appVersion} (${platform})`;
}
