// @vitest-environment node
/**
 * SPEC 15 §2, §4, §5 — the update service against a fake GitHub and real keys.
 *
 * Every test here drives the real service: real Ed25519 signatures, real
 * sha256/sha512 digests, real manifests. Only the network and the
 * `electron-updater` handle are fakes, which is exactly the boundary we want to
 * be able to swap in a test.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serialiseManifest, signManifest } from '@clipwright/update-core';
import {
  UpdateService,
  parseLatestYml,
  pickInstaller,
  type FetchLike,
  type UpdaterLike,
} from '../updater/update-service.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const OTHER = generateKeyPairSync('ed25519');
const OTHER_PRIVATE = OTHER.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const INSTALLER = 'Clipwright-Studio-Setup-1.3.0-x64.exe';
const INSTALLER_BYTES = Buffer.from('pretend-this-is-a-120MB-installer');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const sha512 = (data: Buffer | string) => createHash('sha512').update(data).digest('hex');

interface Fixture {
  version?: string;
  channel?: 'stable' | 'beta';
  signWith?: string;
  tamperAfterSigning?: (text: string) => string;
  omitSignature?: boolean;
  installer?: Buffer;
  latestOverride?: string | null;
  releaseNotes?: string;
  noUpdaterUpdate?: boolean;
}

/** Build a signed release, then serve it through a fake fetch. */
function makeRelease(fixture: Fixture = {}) {
  const version = fixture.version ?? '1.3.0';
  const installer = fixture.installer ?? INSTALLER_BYTES;
  const name = `Clipwright-Studio-Setup-${version}-x64.exe`;

  const manifestText = serialiseManifest({
    version,
    channel: fixture.channel ?? 'stable',
    summary: 'Exports are twice as fast.',
    files: [{ name, size: installer.byteLength, sha256: sha256(installer), sha512: sha512(installer) }],
    generatedAt: '2026-11-01T10:00:00.000Z',
  });
  const signature = signManifest(manifestText, fixture.signWith ?? PRIVATE_KEY);
  const published = fixture.tamperAfterSigning
    ? fixture.tamperAfterSigning(manifestText)
    : manifestText;

  const latestYml: string =
    fixture.latestOverride !== undefined && fixture.latestOverride !== null
      ? fixture.latestOverride
      : [
          `version: ${version}`,
          'files:',
          `  - url: ${name}`,
          `    sha512: ${Buffer.from(sha512(installer), 'hex').toString('base64')}`,
          `    size: ${installer.byteLength}`,
          `path: ${name}`,
          `sha512: ${Buffer.from(sha512(installer), 'hex').toString('base64')}`,
        ].join('\n');

  return { version, name, installer, manifestText: published, signature, latestYml };
}

function fakeFetch(routes: {
  manifest?: string;
  signature?: string;
  latest?: string | null;
  installer?: Buffer;
  releaseNotes?: string;
  status?: Record<string, number>;
  redirectTo?: string;
}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const respond = (body: string | Buffer, status = 200, url?: string) => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => (Buffer.isBuffer(body) ? body.toString('utf8') : body),
    arrayBuffer: async () =>
      Buffer.isBuffer(body)
        ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        : new TextEncoder().encode(body).buffer,
  });

  const fetcher = (async (url: string) => {
    calls.push(url);
    const forced = routes.status?.[url];
    if (forced) return respond('', forced);

    if (url.endsWith('release-manifest.json')) {
      if (routes.manifest === undefined) return respond('', 404);
      return respond(routes.manifest);
    }
    if (url.endsWith('release-manifest.json.sig')) {
      if (routes.signature === undefined) return respond('', 404);
      return respond(routes.signature);
    }
    if (url.endsWith('latest.yml')) {
      if (routes.latest === null) return respond('', 404);
      return respond(routes.latest ?? '', routes.latest === null ? 404 : 200);
    }
    if (url.includes('api.github.com')) {
      return respond(JSON.stringify({ body: routes.releaseNotes ?? '', published_at: '2026-11-01T10:05:00.000Z' }));
    }
    if (url.endsWith('.exe')) {
      return respond(routes.installer ?? INSTALLER_BYTES, 200, routes.redirectTo);
    }
    return respond('', 404);
  }) as FetchLike & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

function fakeUpdater(version: string | null): UpdaterLike & { installed: boolean } {
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    logger: null,
    installed: false,
    on: () => updater,
    checkForUpdates: async () => (version ? { updateInfo: { version } } : null),
    downloadUpdate: async () => undefined,
    quitAndInstall: () => {
      updater.installed = true;
    },
  };
  return updater;
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cw-update-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function makeService(options: {
  fetch: FetchLike;
  updater?: UpdaterLike | null;
  version?: string;
  channel?: 'stable' | 'beta';
  keys?: { current: string; next?: string };
}) {
  return new UpdateService({
    currentVersion: options.version ?? '1.2.0',
    channel: options.channel ?? 'stable',
    keys: options.keys ?? { current: PUBLIC_KEY },
    getUpdater: () => (options.updater === undefined ? fakeUpdater('1.3.0') : options.updater),
    fetch: options.fetch,
    cacheDir,
  });
}

describe('checking', () => {
  it('reports an available, verified release', async () => {
    const release = makeRelease();
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
    });

    const result = await service.check({ manual: true });
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.release.version).toBe('1.3.0');
      expect(result.release.downloadBytes).toBe(INSTALLER_BYTES.byteLength);
      expect(result.release.signed).toBe(false);
    }
    expect(service.snapshot().status).toBe('available');
  });

  it('reports up-to-date when the updater has nothing', async () => {
    const service = makeService({ fetch: fakeFetch({}), updater: fakeUpdater(null) });
    const result = await service.check({ manual: true });
    expect(result).toEqual({ status: 'up-to-date', version: '1.2.0' });
  });

  it('ignores an update that is not actually newer', async () => {
    const release = makeRelease({ version: '1.1.0' });
    const service = makeService({
      fetch: fakeFetch({ manifest: release.manifestText, signature: release.signature, latest: release.latestYml }),
      updater: fakeUpdater('1.1.0'),
    });
    expect((await service.check({ manual: true })).status).toBe('up-to-date');
  });

  it('turns the updater\'s auto-download flags off every time (§2.2)', async () => {
    const updater = fakeUpdater('1.3.0');
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    const release = makeRelease();
    const service = makeService({
      fetch: fakeFetch({ manifest: release.manifestText, signature: release.signature, latest: release.latestYml }),
      updater,
    });
    await service.check({ manual: true });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('sets allowPrerelease from the channel', async () => {
    const updater = fakeUpdater(null);
    const service = makeService({ fetch: fakeFetch({}), updater, channel: 'beta' });
    await service.check({ manual: true });
    expect(updater.allowPrerelease).toBe(true);
  });

  it('records the last checked time', async () => {
    let recorded: number | null = null;
    const service = new UpdateService({
      currentVersion: '1.2.0',
      channel: 'stable',
      keys: { current: PUBLIC_KEY },
      getUpdater: () => fakeUpdater(null),
      fetch: fakeFetch({}),
      cacheDir,
      now: () => 1234,
      setLastCheckedAt: (at) => {
        recorded = at;
      },
    });
    await service.check({ manual: true });
    expect(recorded).toBe(1234);
  });
});

describe('verification failures (§5)', () => {
  const expectRefused = async (service: UpdateService, fragment = "couldn't be verified") => {
    const result = await service.check({ manual: true });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.message).toContain(fragment);
    }
    expect(service.snapshot().release).toBeNull();
  };

  it('refuses a release with no signature', async () => {
    const release = makeRelease({ omitSignature: true });
    const service = makeService({
      fetch: fakeFetch({ manifest: release.manifestText, latest: release.latestYml }),
    });
    await expectRefused(service);
  });

  it('refuses a release signed by an unknown key', async () => {
    const release = makeRelease({ signWith: OTHER_PRIVATE });
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
    });
    await expectRefused(service);
  });

  it('refuses a manifest tampered with after signing', async () => {
    // The signature is genuine, but the bytes changed: this is the attack the
    // signature exists to stop.
    const release = makeRelease({
      tamperAfterSigning: (text) => text.replace(INSTALLER, 'Evil-Setup.exe'),
    });
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
    });
    await expectRefused(service);
  });

  it('refuses when latest.yml disagrees with the signed manifest', async () => {
    const release = makeRelease();
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml.replace(/sha512: .*/, 'sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
    });
    await expectRefused(service);
  });

  it('refuses everything when the build has no public key (fails closed)', async () => {
    const release = makeRelease();
    const service = makeService({
      fetch: fakeFetch({ manifest: release.manifestText, signature: release.signature, latest: release.latestYml }),
      keys: { current: '' },
    });
    const result = await service.check({ manual: true });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      // The user gets the standard refusal; the reason stays in the log detail so
      // a broken build does not leak its internals into the dialog.
      expect(result.error.message).toContain("couldn't be verified");
      expect(result.error.detail).toContain('cannot verify updates');
    }
  });

  it('accepts a release signed with the next key during rotation', async () => {
    const release = makeRelease({ signWith: OTHER_PRIVATE });
    const nextPublic = OTHER.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
      keys: { current: PUBLIC_KEY, next: nextPublic },
    });
    expect((await service.check({ manual: true })).status).toBe('available');
  });

  it('refuses to fetch from a host that is not GitHub (§5 transport)', async () => {
    const fetcher = fakeFetch({});
    // The updater claims a version, but the release asset URLs are built by us,
    // so a bad host can only come from a redirect. Simulate one.
    const redirecting: FetchLike = async (url, init) => {
      const response = await fetcher(url, init);
      return { ...response, url: 'https://evil.example.com/payload.exe' };
    };
    const service = makeService({ fetch: redirecting });
    await expectRefused(service);
  });
});

describe('channel handling', () => {
  it('does not offer a beta to a stable user', async () => {
    const release = makeRelease({ version: '1.3.0-beta.1', channel: 'beta' });
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
      updater: fakeUpdater('1.3.0-beta.1'),
      channel: 'stable',
    });
    expect((await service.check({ manual: true })).status).toBe('up-to-date');
  });

  it('offers a beta to a beta user', async () => {
    const release = makeRelease({ version: '1.3.0-beta.1', channel: 'beta' });
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
      updater: fakeUpdater('1.3.0-beta.1'),
      channel: 'beta',
      version: '1.2.0',
    });
    expect((await service.check({ manual: true })).status).toBe('available');
  });

  it('offers the stable release to a beta user on a prerelease', async () => {
    const release = makeRelease({ version: '1.3.0' });
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
      }),
      updater: fakeUpdater('1.3.0'),
      channel: 'beta',
      version: '1.3.0-beta.4',
    });
    const result = await service.check({ manual: true });
    expect(result.status).toBe('available');
  });
});

describe('failures are explained, never dumped (§4.1)', () => {
  it('explains a rate limit in words, not a status code', async () => {
    const release = makeRelease();
    const manifestUrl = `https://github.com/yetiwrld/Main-ClipWright-/releases/download/v1.3.0/release-manifest.json`;
    const service = makeService({
      fetch: fakeFetch({
        manifest: release.manifestText,
        signature: release.signature,
        latest: release.latestYml,
        status: { [manifestUrl]: 429 },
      }),
    });
    const result = await service.check({ manual: true });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.message).toBe('GitHub is limiting requests. Try again later.');
      expect(result.error.message).not.toContain('429');
    }
  });

  it('keeps an automatic failure out of the UI', async () => {
    const service = makeService({ fetch: fakeFetch({}) });
    const result = await service.check({ manual: false });
    expect(result.status).toBe('error');
    expect(service.snapshot().status).toBe('error');
    // Silent: no error object for the renderer to show.
    expect(service.snapshot().error).toBeNull();
  });

  it('explains a manual failure', async () => {
    const service = makeService({ fetch: fakeFetch({}) });
    await service.check({ manual: true });
    expect(service.snapshot().error).toBeTruthy();
  });
});

describe('downloading and installing', () => {
  async function readyService() {
    const release = makeRelease();
    const fetcher = fakeFetch({
      manifest: release.manifestText,
      signature: release.signature,
      latest: release.latestYml,
      installer: INSTALLER_BYTES,
    });
    const updater = fakeUpdater('1.3.0');
    const service = makeService({ fetch: fetcher, updater });
    await service.check({ manual: true });
    return { service, updater, release };
  }

  it('downloads, verifies and becomes ready', async () => {
    const { service, release } = await readyService();
    const result = await service.download();
    expect(result.ok).toBe(true);
    expect(service.snapshot().status).toBe('ready');
    const file = readFileSync(join(cacheDir, release.name));
    expect(sha256(file)).toBe(sha256(INSTALLER_BYTES));
  });

  it('will not download before a check', async () => {
    const service = makeService({ fetch: fakeFetch({}) });
    const result = await service.download();
    expect(result.ok).toBe(false);
    expect(service.snapshot().status).toBe('idle');
  });

  it('deletes a corrupted download and says so', async () => {
    const release = makeRelease();
    // The signature covers a good hash, but the bytes served are different.
    const fetcher = fakeFetch({
      manifest: release.manifestText,
      signature: release.signature,
      latest: release.latestYml,
      installer: Buffer.from('tampered bytes'),
    });
    const service = makeService({ fetch: fetcher });
    await service.check({ manual: true });
    const result = await service.download();

    expect(result.ok).toBe(false);
    expect(service.snapshot().status).toBe('error');
    expect(service.snapshot().error?.message).toBe('The download was damaged and has been removed.');
    // The bad file must not be left on disk.
    expect(() => readFileSync(join(cacheDir, release.name))).toThrow();
  });

  it('installs only from ready, and only when asked', async () => {
    const { service, updater } = await readyService();
    // Not ready yet.
    const tooEarly = await service.installAndRestart();
    expect(tooEarly.ok).toBe(false);
    expect(updater.installed).toBe(false);

    await service.download();
    const result = await service.installAndRestart();
    expect(result.ok).toBe(true);
    expect(updater.installed).toBe(true);
  });

  it('refuses to install when preparation fails, and says why (§7.1)', async () => {
    // The backups and journal are written before the installer runs. If that
    // fails, installing anyway would risk the user's data for the sake of an
    // update they can install tomorrow.
    const { service, updater } = await readyService();
    const failing = new UpdateService({
      ...service['options'],
      prepareInstall: async () => ({ ok: false, error: { code: 'disk', message: 'Not enough space to back up.' } as never }),
    } as never);
    await failing.check({ manual: true });
    await failing.download();
    const result = await failing.installAndRestart();

    expect(result.ok).toBe(false);
    expect(updater.installed).toBe(false);
    expect(result.error?.message).toBe('Not enough space to back up.');
    expect(failing.snapshot().status).toBe('error');
  });

  it('does not install when preparation throws', async () => {
    const { service, updater } = await readyService();
    const throwing = new UpdateService({
      ...service['options'],
      prepareInstall: async () => {
        throw new Error('the workspace is read-only');
      },
    } as never);
    await throwing.check({ manual: true });
    await throwing.download();

    const result = await throwing.installAndRestart();
    expect(result.ok).toBe(false);
    expect(updater.installed).toBe(false);
    expect(throwing.snapshot().status).toBe('error');
  });

  it('runs preparation before handing over to the installer (§7.1)', async () => {
    const { service, updater } = await readyService();
    const order: string[] = [];
    const ordered = new UpdateService({
      ...service['options'],
      prepareInstall: async () => {
        order.push('prepare');
        return { ok: true };
      },
      getUpdater: () => {
        order.push('installer');
        return updater;
      },
    } as never);
    await ordered.check({ manual: true });
    await ordered.download();
    order.length = 0; // ignore the calls made while checking and downloading
    await ordered.installAndRestart();

    expect(order).toEqual(['prepare', 'installer']);
  });

  it('cancels a download that is in flight', async () => {
    const { service } = await readyService();
    service.cancelDownload();
    expect(service.snapshot().status).toBe('available');
  });
});

describe('user actions', () => {
  it('remembers a skipped version', async () => {
    const release = makeRelease();
    const service = makeService({
      fetch: fakeFetch({ manifest: release.manifestText, signature: release.signature, latest: release.latestYml }),
    });
    await service.check({ manual: true });
    service.skip();
    expect(service.snapshot().skippedVersion).toBe('1.3.0');
    expect(service.snapshot().release).toBeNull();
  });

  it('snoozes for a day', async () => {
    const release = makeRelease();
    const service = new UpdateService({
      currentVersion: '1.2.0',
      channel: 'stable',
      keys: { current: PUBLIC_KEY },
      getUpdater: () => fakeUpdater('1.3.0'),
      fetch: fakeFetch({ manifest: release.manifestText, signature: release.signature, latest: release.latestYml }),
      cacheDir,
      now: () => 1000,
    });
    await service.check({ manual: true });
    service.remindLater();
    expect(service.snapshot().snoozedUntil).toBe(1000 + 24 * 60 * 60 * 1000);
  });
});

describe('automatic checks (§3)', () => {
  it('does nothing when not due', async () => {
    const service = makeService({ fetch: fakeFetch({}) });
    expect(await service.autoCheckIfDue(false)).toBe(false);
    expect(service.snapshot().lastCheckedAt).toBeNull();
  });

  it('runs quietly when due', async () => {
    const service = makeService({ fetch: fakeFetch({}) });
    expect(await service.autoCheckIfDue(true)).toBe(true);
  });

  it('never interrupts a download', async () => {
    const release = makeRelease();
    const service = makeService({
      fetch: fakeFetch({ manifest: release.manifestText, signature: release.signature, latest: release.latestYml }),
    });
    await service.check({ manual: true });
    service._setStateForTest({ ...service.snapshot(), status: 'downloading' });
    expect(await service.autoCheckIfDue(true)).toBe(false);
  });
});

describe('parseLatestYml', () => {
  it('reads version, url, sha512 and size', () => {
    const release = makeRelease();
    const parsed = parseLatestYml(release.latestYml);
    expect(parsed?.version).toBe('1.3.0');
    expect(parsed?.files[0].path).toBe(INSTALLER);
    expect(parsed?.files[0].size).toBe(INSTALLER_BYTES.byteLength);
  });

  it('handles an electron-builder style block with url entries', () => {
    const text = [
      'version: 2.0.0',
      'files:',
      `  - url: ${INSTALLER}`,
      '    sha512: abcdef',
      '    size: 42',
      'path: ' + INSTALLER,
      'sha512: abcdef',
      'releaseDate: 2026-11-07T00:00:00.000Z',
    ].join('\n');
    expect(parseLatestYml(text)).toMatchObject({
      version: '2.0.0',
      files: [{ path: INSTALLER, sha512: 'abcdef', size: 42 }],
    });
  });

  it('returns null for something that is not latest.yml', () => {
    expect(parseLatestYml('')).toBeNull();
    expect(parseLatestYml('version: 1.0.0\n')).toBeNull();
  });
});

describe('pickInstaller', () => {
  it('prefers the setup exe over the portable one', () => {
    const manifest = {
      version: '1.3.0',
      channel: 'stable' as const,
      summary: '',
      generatedAt: '2026-11-01T00:00:00.000Z',
      files: [
        { name: 'Clipwright-Studio-1.3.0-x64-portable.exe', size: 10, sha256: 'a'.repeat(64), sha512: 'b'.repeat(128) },
        { name: INSTALLER, size: 20, sha256: 'c'.repeat(64), sha512: 'd'.repeat(128) },
      ],
    };
    expect(pickInstaller(manifest)?.name).toBe(INSTALLER);
  });
});
