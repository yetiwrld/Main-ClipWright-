// @vitest-environment node
/**
 * SPEC 15 §7 — the journal on disk.
 *
 * The startup path is the one place in the app that must work when everything
 * else is broken, so these tests lean on the awkward cases: a corrupt journal, a
 * missing backup source, an atomic write, and cleanup that keeps the one backup
 * it is supposed to keep.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL_FILE, UpdateJournalStore } from '../updater/update-journal-store.js';

const TMP = join(process.cwd(), '.tmp-update-journal');
const WORKSPACE = join(TMP, 'workspace');
const USER_DATA = join(TMP, 'userData');

let clockOffset = 0;
const fixedNow = () => new Date(Date.parse('2026-11-07T10:00:00.000Z') + clockOffset);

function makeStore() {
  return new UpdateJournalStore({ workspaceDir: WORKSPACE, userDataDir: USER_DATA, now: fixedNow });
}

beforeEach(() => {
  clockOffset = 0;
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(USER_DATA, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('reading and writing', () => {
  it('returns null when there is no journal', async () => {
    expect(await makeStore().read()).toBeNull();
  });

  it('round-trips a journal', async () => {
    const store = makeStore();
    const written = await store.beginInstall('1.2.0', '1.3.0');
    const read = await store.read();

    expect(read).toEqual(written);
    expect(read).toMatchObject({ from: '1.2.0', to: '1.3.0', status: 'installing' });
  });

  it('writes a valid JSON file with a trailing newline', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    const raw = readFileSync(store.journalPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('moves a corrupt journal aside instead of failing every launch', async () => {
    const store = makeStore();
    mkdirSync(store.updatesDir, { recursive: true });
    writeFileSync(store.journalPath, '{ truncated');

    expect(await store.read()).toBeNull();
    expect(existsSync(join(store.updatesDir, 'update-journal.corrupt.json'))).toBe(true);
    expect(existsSync(store.journalPath)).toBe(false);
  });

  it('rejects a journal missing required fields', async () => {
    const store = makeStore();
    mkdirSync(store.updatesDir, { recursive: true });
    writeFileSync(store.journalPath, JSON.stringify({ status: 'ok' }));
    expect(await store.read()).toBeNull();
  });
});

describe('backupBeforeInstall (§7.1)', () => {
  it('copies the small files that exist and skips the rest', async () => {
    writeFileSync(join(WORKSPACE, 'workspace.db'), 'fake sqlite');
    // No secrets.bin on an install with no providers configured.
    writeFileSync(join(USER_DATA, 'app-state.json'), '{"window":{}}');

    const result = await makeStore().backupBeforeInstall('1.2.0', '2026-11-07T10:00:00.000Z');

    expect(result.copied.sort()).toEqual(['app-state.json', 'workspace.db']);
    expect(result.failed).toEqual([]);
    expect(readFileSync(join(result.folder, 'workspace.db'), 'utf8')).toBe('fake sqlite');
  });

  it('puts the backup where §7.1 says and uses a path-safe name', async () => {
    const store = makeStore();
    const result = await store.backupBeforeInstall('1.2.0', '2026-11-07T10:00:00.000Z');
    expect(result.folder).toContain(join('Updates', 'backup-1.2.0-'));
    expect(result.folder).not.toContain(':');
  });

  it('copies secrets.bin when it exists', async () => {
    writeFileSync(join(USER_DATA, 'secrets.bin'), 'encrypted');
    const result = await makeStore().backupBeforeInstall('1.2.0', '2026-11-07T10:00:00.000Z');
    expect(result.copied).toContain('secrets.bin');
  });

  it('never throws when a source cannot be read', async () => {
    // A directory where a file is expected: copyFile fails, and the update must
    // still be allowed to proceed with whatever it did manage to save.
    mkdirSync(join(WORKSPACE, 'workspace.db'));
    const result = await makeStore().backupBeforeInstall('1.2.0', '2026-11-07T10:00:00.000Z');
    expect(result.failed.some((entry) => entry.file === 'workspace.db')).toBe(true);
  });
});

describe('previous installer (§7.1c)', () => {
  it('caches an installer that is plausibly an installer', async () => {
    const installer = join(TMP, 'Setup-1.2.0.exe');
    writeFileSync(installer, Buffer.alloc(2 * 1024 * 1024));

    const store = makeStore();
    expect(await store.cachePreviousInstaller('1.2.0', installer)).toBe(true);
    expect(await store.findPreviousInstaller('1.2.0')).toContain('Setup-1.2.0.exe');
  });

  it('refuses to cache a truncated file', async () => {
    // A short file is a failed download, not a rollback path.
    const installer = join(TMP, 'Setup-1.2.0.exe');
    writeFileSync(installer, 'short');
    expect(await makeStore().cachePreviousInstaller('1.2.0', installer)).toBe(false);
  });

  it('reports honestly when there is no previous installer', async () => {
    expect(await makeStore().findPreviousInstaller('1.2.0')).toBeNull();
  });
});

describe('boot marking (§7.3)', () => {
  it('records a launch for the version that was installed', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    const journal = await store.recordLaunch('1.3.0');
    expect(journal?.status).toBe('launched');
    expect((await store.read())?.status).toBe('launched');
  });

  it('ignores a launch of a different version', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordLaunch('1.2.0');
    expect((await store.read())?.status).toBe('installing');
  });

  it('confirms after the boot window', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordLaunch('1.3.0');
    clockOffset = 60_000;
    const journal = await store.recordConfirmed();
    expect(journal?.status).toBe('ok');
    expect(journal?.confirmedAt).toBeTruthy();
  });

  it('does not confirm a journal that never launched', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordConfirmed();
    expect((await store.read())?.status).toBe('installing');
  });

  it('enters the crashed state after two workspace failures', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordLaunch('1.3.0');

    expect((await store.recordWorkspaceFailure('first'))?.status).toBe('launched');
    const journal = await store.recordWorkspaceFailure('second');

    expect(journal?.status).toBe('crashed');
    expect(journal?.failureReason).toBe('second');
  });

  it('persists the crashed state so the next launch sees it', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordLaunch('1.3.0');
    await store.recordWorkspaceFailure();
    await store.recordWorkspaceFailure();

    // A fresh store reading the same files — i.e. the next process.
    const nextLaunch = await makeStore().read();
    expect(nextLaunch?.status).toBe('crashed');
  });

  it('does nothing when there is no journal at all', async () => {
    const store = makeStore();
    expect(await store.recordLaunch('1.3.0')).toBeNull();
    expect(await store.recordWorkspaceFailure()).toBeNull();
  });
});

describe('cleanup (§7.6)', () => {
  it('keeps everything while the update is unconfirmed', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordLaunch('1.3.0');
    await store.backupBeforeInstall('1.1.0', '2026-01-01T00:00:00.000Z');

    const removed = await store.cleanup(Date.parse('2026-12-31T00:00:00.000Z'));
    expect(removed).toEqual([]);
    expect(existsSync(store.journalPath)).toBe(true);
  });

  it('removes expired journals and stale backups but keeps the newest', async () => {
    const store = makeStore();
    await store.beginInstall('1.2.0', '1.3.0');
    await store.recordLaunch('1.3.0');
    clockOffset = 120_000;
    await store.recordConfirmed();

    // Two backups, the newer one must survive.
    await store.backupBeforeInstall('1.0.0', '2026-01-01T00:00:00.000Z');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    await store.backupBeforeInstall('1.1.0', '2026-02-01T00:00:00.000Z');

    const fortyDaysLater = Date.parse('2026-11-07T10:00:00.000Z') + 40 * 24 * 60 * 60 * 1000;
    const removed = await store.cleanup(fortyDaysLater);

    expect(removed).toContain(JOURNAL_FILE);
    expect(removed.some((name) => name.includes('backup-1.0.0'))).toBe(true);
    expect(removed.some((name) => name.includes('backup-1.1.0'))).toBe(false);
  });
});
