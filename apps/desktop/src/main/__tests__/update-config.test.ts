// @vitest-environment node
/**
 * SPEC 15 §5, §6 — which public key the updater trusts, and where updates may
 * come from.
 *
 * `resolveTrustedKeys` had no tests, and it is the function that decides whether
 * a signature is even checked against the right key. The two rules worth
 * protecting: a build with no key must fail closed, and a shipped build must not
 * be steerable by an environment variable.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPDATE_HOSTS,
  EMBEDDED_UPDATE_KEYS,
  UPDATE_PRIVACY_NOTE,
  UPDATE_REPO,
  hasUsableKeys,
  isAllowedUpdateUrl,
  resolveTrustedKeys,
  updateUserAgent,
} from '../updater/update-config.js';

const REAL_KEY = 'A'.repeat(43) + '=';

describe('resolveTrustedKeys', () => {
  it('uses the embedded key when nothing is supplied', () => {
    expect(resolveTrustedKeys({})).toEqual({ current: EMBEDDED_UPDATE_KEYS.current });
  });

  it('fails closed: the shipped placeholder is empty, so there are no usable keys', () => {
    // The app refuses every update until a real key is embedded. This is the
    // intended behaviour, not an oversight — see docs/release.md.
    const keys = resolveTrustedKeys({});
    expect(keys.current).toBe('');
    expect(hasUsableKeys(keys)).toBe(false);
  });

  it('accepts an injected key when overrides are allowed', () => {
    const keys = resolveTrustedKeys({ UPDATE_PUBLIC_KEY_B64: REAL_KEY }, { allowOverride: true });
    expect(keys.current).toBe(REAL_KEY);
    expect(hasUsableKeys(keys)).toBe(true);
  });

  it('ignores the environment in a packaged build', () => {
    // An env var must not be able to point a shipped app at a different signer.
    const keys = resolveTrustedKeys({ UPDATE_PUBLIC_KEY_B64: REAL_KEY }, { allowOverride: false });
    expect(keys.current).toBe(EMBEDDED_UPDATE_KEYS.current);
  });

  it('ignores the rotation key in a packaged build too', () => {
    const keys = resolveTrustedKeys(
      { UPDATE_PUBLIC_KEY_NEXT_B64: REAL_KEY },
      { allowOverride: false },
    );
    expect(keys.next).toBeUndefined();
  });

  it('trims whitespace, because a trailing newline in a secret is common', () => {
    const keys = resolveTrustedKeys({ UPDATE_PUBLIC_KEY_B64: `  ${REAL_KEY}\n` }, { allowOverride: true });
    expect(keys.current).toBe(REAL_KEY);
  });

  it('treats an empty environment variable as absent', () => {
    // An unset secret in Actions arrives as "", not undefined.
    const keys = resolveTrustedKeys({ UPDATE_PUBLIC_KEY_B64: '   ' }, { allowOverride: true });
    expect(keys.current).toBe(EMBEDDED_UPDATE_KEYS.current);
  });

  it('carries a rotation key through when one is configured', () => {
    const keys = resolveTrustedKeys(
      { UPDATE_PUBLIC_KEY_B64: REAL_KEY, UPDATE_PUBLIC_KEY_NEXT_B64: 'B'.repeat(43) },
      { allowOverride: true },
    );
    expect(keys).toMatchObject({ current: REAL_KEY, next: 'B'.repeat(43) });
  });
});

describe('hasUsableKeys', () => {
  it('is false for a blank key, not merely an undefined one', () => {
    expect(hasUsableKeys({ current: '   ' })).toBe(false);
  });

  it('is true when only the rotation key is present', () => {
    expect(hasUsableKeys({ current: '', next: REAL_KEY })).toBe(true);
  });
});

describe('isAllowedUpdateUrl', () => {
  it('allows GitHub release hosts', () => {
    expect(isAllowedUpdateUrl('https://github.com/yetiwrld/Main-ClipWright-/releases')).toBe(true);
    expect(
      isAllowedUpdateUrl('https://objects.githubusercontent.com/some-asset.exe'),
    ).toBe(true);
  });

  it('refuses any other host, so a redirect cannot move the download', () => {
    expect(isAllowedUpdateUrl('https://evil.example.com/update.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://github.com.evil.example/update.exe')).toBe(false);
  });

  it('refuses plain HTTP', () => {
    expect(isAllowedUpdateUrl('http://github.com/release')).toBe(false);
  });

  it('refuses a malformed URL instead of throwing', () => {
    expect(isAllowedUpdateUrl('not a url')).toBe(false);
  });
});

describe('identity constants', () => {
  it('names the repository the app will accept releases from', () => {
    expect(UPDATE_REPO.owner).toBe('yetiwrld');
    expect(UPDATE_REPO.repo).toBe('Main-ClipWright-');
  });

  it('allows only the hosts the updater actually needs', () => {
    expect([...ALLOWED_UPDATE_HOSTS]).toContain('github.com');
    expect(ALLOWED_UPDATE_HOSTS).not.toContain('raw.githubusercontent.com');
  });

  it('sends nothing identifying in the user agent (§3, §10)', () => {
    const agent = updateUserAgent('1.2.3', 'win32');
    expect(agent).toBe('ClipwrightStudio/1.2.3 (win32)');
    // No machine name, no install id, no UUID.
    expect(agent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('states plainly where update checks go', () => {
    expect(UPDATE_PRIVACY_NOTE).toContain('github.com');
    expect(UPDATE_PRIVACY_NOTE).toContain('Nothing about you or your projects is sent');
  });
});
