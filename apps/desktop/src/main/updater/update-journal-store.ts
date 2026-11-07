/**
 * SPEC 15 §7 — file I/O for the update journal, backups and rollback.
 *
 * The pure rules live in `@clipwright/update-core/journal`. This is the part that
 * touches the disk: reading and writing `update-journal.json`, taking the small
 * backups §7.1 asks for, and cleaning up after a successful update.
 *
 * Everything here is defensive. It runs at startup, before the window exists, and
 * a damaged journal must never stop the app from opening — the journal exists to
 * help in exactly the situation where something is already wrong.
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPDATES_DIR_NAME,
  advanceJournal,
  backupFolderName,
  createJournal,
  isJournalExpired,
  type UpdateJournal,
} from '@clipwright/update-core';

export const JOURNAL_FILE = 'update-journal.json';

export interface JournalStoreOptions {
  /** The user's workspace root; backups live under `<workspace>/Updates`. */
  workspaceDir: string;
  /** `%APPDATA%\Clipwright Studio` — holds `app-state.json` and `secrets.bin`. */
  userDataDir: string;
  now?: () => Date;
}

export interface BackupResult {
  folder: string;
  copied: string[];
  /** Files that could not be copied, with the reason. Never fatal. */
  failed: Array<{ file: string; reason: string }>;
}

export class UpdateJournalStore {
  private readonly options: JournalStoreOptions;
  private readonly now: () => Date;

  constructor(options: JournalStoreOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /** `<workspace>/Updates` — created on demand. */
  get updatesDir(): string {
    return join(this.options.workspaceDir, UPDATES_DIR_NAME);
  }

  get journalPath(): string {
    return join(this.updatesDir, JOURNAL_FILE);
  }

  /**
   * Read the journal, or null when there is none.
   *
   * A corrupt file is renamed to `update-journal.corrupt.json` and reported as
   * absent: keeping the broken file would make every future launch take the
   * "something is wrong" path for a reason nobody can see.
   */
  async read(): Promise<UpdateJournal | null> {
    const path = this.journalPath;
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<UpdateJournal>;
      if (
        typeof parsed.from !== 'string' ||
        typeof parsed.to !== 'string' ||
        typeof parsed.startedAt !== 'string' ||
        typeof parsed.status !== 'string'
      ) {
        throw new Error('journal is missing required fields');
      }
      return parsed as UpdateJournal;
    } catch {
      await rename(path, join(this.updatesDir, 'update-journal.corrupt.json')).catch(() => undefined);
      return null;
    }
  }

  /** Write the journal atomically: a half-written journal is worse than none. */
  async write(journal: UpdateJournal): Promise<void> {
    await mkdir(this.updatesDir, { recursive: true });
    const temporary = `${this.journalPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    await rename(temporary, this.journalPath);
  }

  /**
   * §7.1: take the small backups before installing.
   *
   * Only small files: `workspace.db`, `app-state.json` and `secrets.bin`. Media
   * and project databases are protected by the migration backups in SPEC 03 §9,
   * and copying them here would turn a 30-second update into a multi-gigabyte
   * one.
   */
  async backupBeforeInstall(fromVersion: string, startedAt: string): Promise<BackupResult> {
    const folder = join(this.updatesDir, backupFolderName(fromVersion, startedAt));
    await mkdir(folder, { recursive: true });

    const sources: Array<{ from: string; name: string }> = [
      { from: join(this.options.workspaceDir, 'workspace.db'), name: 'workspace.db' },
      { from: join(this.options.userDataDir, 'app-state.json'), name: 'app-state.json' },
      { from: join(this.options.userDataDir, 'secrets.bin'), name: 'secrets.bin' },
    ];

    const copied: string[] = [];
    const failed: Array<{ file: string; reason: string }> = [];

    for (const source of sources) {
      if (!existsSync(source.from)) {
        // Not every install has a secrets file (no providers configured yet).
        continue;
      }
      try {
        await copyFile(source.from, join(folder, source.name));
        copied.push(source.name);
      } catch (error) {
        failed.push({ file: source.name, reason: (error as Error)?.message ?? 'unknown error' });
      }
    }

    return { folder, copied, failed };
  }

  /**
   * §7.1(c): cache the installer we just ran, so the previous version can be
   * restored. Silently does nothing when the file is not available — first
   * installs never have it, and the UI says so.
   */
  async cachePreviousInstaller(fromVersion: string, installerPath: string): Promise<boolean> {
    if (!existsSync(installerPath)) return false;
    const target = join(this.updatesDir, 'previous', `Setup-${fromVersion}.exe`);
    try {
      await mkdir(join(this.updatesDir, 'previous'), { recursive: true });
      const info = await stat(installerPath);
      // Refuse to cache something implausibly small: a truncated download is not
      // a rollback path.
      if (info.size < 1024 * 1024) return false;
      await copyFile(installerPath, target);
      return true;
    } catch {
      return false;
    }
  }

  /** Path of the cached installer for a version, or null. */
  async findPreviousInstaller(fromVersion: string): Promise<string | null> {
    const path = join(this.updatesDir, 'previous', `Setup-${fromVersion}.exe`);
    return existsSync(path) ? path : null;
  }

  /**
   * §7.1(d) and §7.3: record a workspace-open failure and return the journal so
   * the caller can react to a `crashed` status.
   */
  async recordWorkspaceFailure(reason?: string): Promise<UpdateJournal | null> {
    const journal = await this.read();
    if (!journal) return null;
    const next = advanceJournal(journal, {
      type: 'workspace-failed',
      at: this.now().toISOString(),
      reason,
    });
    await this.write(next);
    return next;
  }

  /** Record that the new version has started. */
  async recordLaunch(runningVersion: string): Promise<UpdateJournal | null> {
    const journal = await this.read();
    if (!journal) return null;
    if (journal.to !== runningVersion) return journal;
    const next = advanceJournal(journal, { type: 'launched', at: this.now().toISOString() });
    if (next !== journal) await this.write(next);
    return next;
  }

  /** Record that the app has run for the boot window. */
  async recordConfirmed(): Promise<UpdateJournal | null> {
    const journal = await this.read();
    if (!journal) return null;
    if (journal.status !== 'launched') return journal;
    const next: UpdateJournal = {
      ...journal,
      status: 'ok',
      confirmedAt: this.now().toISOString(),
    };
    await this.write(next);
    return next;
  }

  /** §7.1(d): write the entry that says an install is about to happen. */
  async beginInstall(fromVersion: string, toVersion: string): Promise<UpdateJournal> {
    const journal = createJournal(fromVersion, toVersion, this.now().toISOString());
    await this.write(journal);
    return journal;
  }

  /**
   * §7.6: remove expired journals and their backups.
   *
   * Keeps the most recent backup until the next update succeeds, as the spec
   * requires; only confirmed (`ok`) journals older than the retention window go.
   */
  async cleanup(nowMs = this.now().getTime()): Promise<string[]> {
    const removed: string[] = [];
    const journal = await this.read();
    if (journal && !isJournalExpired(journal, nowMs)) return removed;

    const entries = await readdir(this.updatesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('backup-')) continue;
      // Everything except the newest backup; the newest is kept until the next
      // successful update, per §7.6.
      const withTimes = await Promise.all(
        entries
          .filter((candidate) => candidate.isDirectory() && candidate.name.startsWith('backup-'))
          .map(async (candidate) => ({
            name: candidate.name,
            mtime: (await stat(join(this.updatesDir, candidate.name)).catch(() => ({ mtimeMs: 0 })))
              .mtimeMs,
          })),
      );
      withTimes.sort((left, right) => right.mtime - left.mtime);
      const newest = withTimes[0]?.name;
      if (entry.name === newest) continue;
      await rm(join(this.updatesDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }

    if (journal && isJournalExpired(journal, nowMs)) {
      await rm(this.journalPath, { force: true });
      removed.push(JOURNAL_FILE);
    }

    return removed;
  }
}

/**
 * §7.3: the boot confirmation timer. Extracted so the 60-second rule is visible
 * in one place and can be tested with a fake clock.
 */
export function scheduleBootConfirmation(options: {
  delayMs: number;
  onConfirm: () => Promise<void>;
  timer?: (callback: () => void, ms: number) => { unref?: () => void };
}): () => void {
  const schedule = options.timer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const handle = schedule(() => {
    void options.onConfirm().catch(() => undefined);
  }, options.delayMs);
  handle?.unref?.();
  return () => {
    // The caller does not normally cancel; the timer is unref'd so it never holds
    // the process open.
  };
}
