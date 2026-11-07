// @vitest-environment node
/**
 * SPEC 15 §9 — the yt-dlp updater's file work, against a real filesystem.
 *
 * The decision rules have their own tests in update-core. These cover the part
 * that can destroy a working binary: the order of the moves, and what is left
 * behind when a download is refused.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YtDlpService } from '../updater/ytdlp-service.js';

const TMP = join(process.cwd(), '.tmp-ytdlp');
const USER_DATA = join(TMP, 'userData');
const BUNDLED = join(TMP, 'bundled');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const NEW_BYTES = Buffer.from('a brand new yt-dlp binary');
const NEW_BODY = new Uint8Array(NEW_BYTES);
const NEW_SHA = sha256(NEW_BYTES);

function makeService(overrides: Partial<ConstructorParameters<typeof YtDlpService>[0]> = {}) {
  return new YtDlpService({
    userDataDir: USER_DATA,
    bundledDir: BUNDLED,
    platform: 'win32',
    now: () => Date.parse('2026-11-07T12:00:00Z'),
    readVersion: async (path) => (existsSync(path) ? (path.includes('userData') ? '2026.11.07' : '2026.10.01') : null),
    ...overrides,
  });
}

function fakeFetch(handlers: { release?: unknown; sums?: string; asset?: Uint8Array; failRelease?: boolean }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/releases/latest')) {
      if (handlers.failRelease) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(handlers.release), { status: 200 });
    }
    if (url.endsWith('SHA2-256SUMS')) {
      return new Response(handlers.sums ?? '', { status: 200 });
    }
    // A Blob accepts any ArrayBufferView; Buffer and Uint8Array are not BodyInit.
    return new Response(new Blob([new Uint8Array(handlers.asset ?? new Uint8Array())]), { status: 200 });
  }) as typeof fetch;
}

const release = {
  tag_name: '2026.11.07',
  assets: [
    { name: 'yt-dlp.exe', browser_download_url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.07/yt-dlp.exe' },
    { name: 'SHA2-256SUMS', browser_download_url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.07/SHA2-256SUMS' },
  ],
};

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(USER_DATA, { recursive: true });
  mkdirSync(BUNDLED, { recursive: true });
  writeFileSync(join(BUNDLED, 'yt-dlp.exe'), 'the bundled one');
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('describe()', () => {
  it('reports the bundled binary when there is no user copy', async () => {
    const state = await makeService().describe();
    expect(state).toMatchObject({ version: '2026.10.01', source: 'bundled' });
  });

  it('prefers a newer user copy', async () => {
    mkdirSync(join(USER_DATA, 'bin'), { recursive: true });
    writeFileSync(join(USER_DATA, 'bin', 'yt-dlp.exe'), 'newer');
    const state = await makeService().describe();
    expect(state).toMatchObject({ version: '2026.11.07', source: 'user' });
  });

  it('says so when nothing is available', async () => {
    rmSync(join(BUNDLED, 'yt-dlp.exe'));
    const state = await makeService().describe();
    expect(state.version).toBeNull();
    expect(state.message).toContain('not found');
  });
});

describe('check()', () => {
  it('finds an update and keeps the expected checksum', async () => {
    const service = makeService({
      fetch: fakeFetch({ release, sums: `${NEW_SHA}  yt-dlp.exe\n`, asset: NEW_BODY }),
    });
    const result = await service.check({ manual: true });
    expect(result).toMatchObject({ kind: 'available', version: '2026.11.07', expectedSha256: NEW_SHA });
  });

  it('turns a network failure into a sentence, not a stack trace', async () => {
    const service = makeService({ fetch: fakeFetch({ failRelease: true }) });
    const result = await service.check({ manual: true });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('Link downloads use the version that came with Clipwright');
      // A stack trace would name the file and line; the message must not.
      expect(result.message).not.toMatch(/\.ts:\d+/);
      expect(result.message).not.toContain('    at ');
    }
  });

  it('does not call the network when the week has not passed', async () => {
    const fetcher = vi.fn(fakeFetch({ release, sums: `${NEW_SHA}  yt-dlp.exe\n` }));
    const service = makeService({ fetch: fetcher as unknown as typeof fetch });

    await service.check({ manual: true }); // first check sets the timestamp
    fetcher.mockClear();
    const second = await service.check(); // automatic, within the week

    expect(second.kind).toBe('not-due');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does call the network for a manual check inside the week', async () => {
    // "Check now" is the user spending the call on purpose.
    const fetcher = vi.fn(fakeFetch({ release, sums: `${NEW_SHA}  yt-dlp.exe\n` }));
    const service = makeService({ fetch: fetcher as unknown as typeof fetch });

    await service.check({ manual: true });
    fetcher.mockClear();
    await service.check({ manual: true });

    expect(fetcher).toHaveBeenCalled();
  });
});

describe('update()', () => {
  async function ready() {
    mkdirSync(join(USER_DATA, 'bin'), { recursive: true });
    writeFileSync(join(USER_DATA, 'bin', 'yt-dlp.exe'), 'the old downloaded one');
    return makeService({ fetch: fakeFetch({ release, sums: `${NEW_SHA}  yt-dlp.exe\n`, asset: NEW_BODY }) });
  }

  it('installs a verified binary and keeps the old one', async () => {
    const service = await ready();
    const result = await service.update({
      downloadUrl: 'https://example.test/yt-dlp.exe',
      expectedSha256: NEW_SHA,
      version: '2026.11.07',
    });

    expect(result.ok).toBe(true);
    const installed = join(USER_DATA, 'bin', 'yt-dlp.exe');
    expect(readFileSync(installed)).toEqual(NEW_BYTES);
    // The old one is still there, as the rollback path.
    expect(readFileSync(join(USER_DATA, 'bin', 'yt-dlp.previous.exe'), 'utf8')).toBe('the old downloaded one');
  });

  it('leaves a working binary untouched when the download is wrong', async () => {
    const service = await ready();
    const result = await service.update({
      downloadUrl: 'https://example.test/yt-dlp.exe',
      expectedSha256: 'f'.repeat(64), // does not match
      version: '2026.11.07',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('checksum');
    // The critical assertion: the existing binary is exactly as it was.
    expect(readFileSync(join(USER_DATA, 'bin', 'yt-dlp.exe'), 'utf8')).toBe('the old downloaded one');
    // And no partial file is left lying around.
    expect(existsSync(join(USER_DATA, 'bin', 'yt-dlp.exe.part'))).toBe(false);
  });

  it('does not leave a .part file after a network failure', async () => {
    const failing = makeService({
      fetch: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    const result = await failing.update({
      downloadUrl: 'https://example.test/yt-dlp.exe',
      expectedSha256: NEW_SHA,
      version: '2026.11.07',
    });

    expect(result.ok).toBe(false);
    expect(existsSync(join(USER_DATA, 'bin', 'yt-dlp.exe.part'))).toBe(false);
  });

  it('creates the user bin folder on a first-ever update', async () => {
    const service = makeService({
      fetch: fakeFetch({ release, sums: `${NEW_SHA}  yt-dlp.exe\n`, asset: NEW_BODY }),
    });
    const result = await service.update({
      downloadUrl: 'https://example.test/yt-dlp.exe',
      expectedSha256: NEW_SHA,
      version: '2026.11.07',
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(USER_DATA, 'bin', 'yt-dlp.exe'))).toEqual(NEW_BYTES);
  });

  it('writes into the user data folder, never the bundled one (§9)', async () => {
    const service = makeService({
      fetch: fakeFetch({ release, sums: `${NEW_SHA}  yt-dlp.exe\n`, asset: NEW_BODY }),
    });
    await service.update({
      downloadUrl: 'https://example.test/yt-dlp.exe',
      expectedSha256: NEW_SHA,
      version: '2026.11.07',
    });

    // The shipped binary must be exactly as shipped: it lives under Program
    // Files in a real install and writing there either fails or needs admin.
    expect(readFileSync(join(BUNDLED, 'yt-dlp.exe'), 'utf8')).toBe('the bundled one');
  });
});

describe('restoreBundled()', () => {
  it('moves the downloaded copy out of the way', async () => {
    mkdirSync(join(USER_DATA, 'bin'), { recursive: true });
    writeFileSync(join(USER_DATA, 'bin', 'yt-dlp.exe'), 'downloaded');

    const result = await makeService().restoreBundled();
    expect(result.ok).toBe(true);
    expect(existsSync(join(USER_DATA, 'bin', 'yt-dlp.exe'))).toBe(false);
    expect((await result.state).source).toBe('bundled');
  });

  it('refuses when there is nothing to remove', async () => {
    const result = await makeService().restoreBundled();
    expect(result.ok).toBe(false);
  });

  it('refuses to remove the only binary when the bundled one is missing', async () => {
    rmSync(join(BUNDLED, 'yt-dlp.exe'));
    mkdirSync(join(USER_DATA, 'bin'), { recursive: true });
    writeFileSync(join(USER_DATA, 'bin', 'yt-dlp.exe'), 'the only one');

    const result = await makeService().restoreBundled();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Reinstall');
    expect(existsSync(join(USER_DATA, 'bin', 'yt-dlp.exe'))).toBe(true);
  });
});
