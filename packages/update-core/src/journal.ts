/**
 * SPEC 15 §7 — the update journal.
 *
 * A small file written before an install and updated as the new version starts.
 * If the app crashes or fails to open the workspace twice within 60 s of the
 * first launch, the journal is how the *next* launch knows something went wrong,
 * and it is what drives the Recovery window.
 *
 * The states matter:
 *
 *   installing   the installer was launched; the old version has not come back
 *   launched     the new version started (written on first launch)
 *   ok           it has run for 60 s without a workspace failure
 *   crashed      it failed to open the workspace, twice (written by the counter)
 *   rolled-back  the user restored the previous version
 *
 * Pure: the caller supplies the clock and does the I/O.
 */

export type JournalStatus = 'installing' | 'launched' | 'ok' | 'crashed' | 'rolled-back';

export interface UpdateJournal {
  /** Version that was running before the update. */
  from: string;
  /** Version being installed. */
  to: string;
  /** ISO-8601, when `prepareInstall` wrote the entry. */
  startedAt: string;
  status: JournalStatus;
  /** ISO-8601, set when the new version first launched. */
  launchedAt?: string;
  /** ISO-8601, set once the 60-second boot window passed cleanly. */
  confirmedAt?: string;
  /** Workspace-open failures counted inside the boot window (§7.3 says twice). */
  failures?: number;
  /** Why the recovery state was entered, for the Recovery window text. */
  failureReason?: string;
}

/** §7.3: the app must run this long before the update counts as good. */
export const BOOT_CONFIRM_MS = 60_000;

/** §7.3: this many workspace failures inside the boot window enters recovery. */
export const MAX_BOOT_FAILURES = 2;

/** §7.6: backups and journals older than this are cleaned up after success. */
export const JOURNAL_RETENTION_DAYS = 30;

/** Backups live here, relative to the workspace (§7.1). */
export const UPDATES_DIR_NAME = 'Updates';

export function createJournal(from: string, to: string, now: string): UpdateJournal {
  return { from, to, startedAt: now, status: 'installing' };
}

/**
 * Advance the journal. Returns a new object; the input is never mutated.
 *
 * Unknown transitions return the journal unchanged rather than throwing: this
 * runs during startup, and a malformed journal must not stop the app from
 * opening.
 */
export function advanceJournal(
  journal: UpdateJournal,
  event:
    | { type: 'launched'; at: string }
    | { type: 'workspace-opened'; at: string }
    | { type: 'workspace-failed'; at: string; reason?: string }
    | { type: 'rolled-back'; at: string },
): UpdateJournal {
  switch (event.type) {
    case 'launched':
      // Only the first launch of the new version is recorded.
      if (journal.status !== 'installing') return journal;
      return { ...journal, status: 'launched', launchedAt: event.at };

    case 'workspace-opened':
      // §7.3: opening the workspace is *not* proof the update is good — the app
      // has to keep running for 60 seconds, and that confirmation comes from a
      // timer (`confirmBoot`). This event exists so a caller can record a clean
      // open without advancing the state, and deliberately changes nothing.
      return journal;

    case 'workspace-failed': {
      if (journal.status !== 'launched') return journal;
      const failures = (journal.failures ?? 0) + 1;
      // §7.3: twice inside the window means recovery, not another retry.
      if (failures >= MAX_BOOT_FAILURES) {
        return {
          ...journal,
          status: 'crashed',
          failures,
          // Always name the version: a Recovery window that says "the workspace
          // could not be opened" without saying *which version* broke it is
          // useless to the person reading it.
          failureReason:
            event.reason ??
            `Version ${journal.to} could not open the workspace. You can go back to ${journal.from}.`,
        };
      }
      return { ...journal, failures };
    }

    case 'rolled-back':
      return { ...journal, status: 'rolled-back' };

    default:
      return journal;
  }
}

/**
 * Mark the update as confirmed once the app has run for the boot window.
 * Separate from the event reducer because it is driven by a timer.
 */
export function confirmBoot(journal: UpdateJournal, at: string): UpdateJournal {
  if (journal.status !== 'launched') return journal;
  return { ...journal, status: 'ok', confirmedAt: at };
}

/**
 * What the app should do on startup, given the journal it found and the version
 * that is actually running.
 */
export type BootDecision =
  | { action: 'none' }
  | { action: 'confirm-pending'; journal: UpdateJournal }
  | { action: 'recovery'; journal: UpdateJournal; reason: string };

export function decideBootAction(journal: UpdateJournal | null, runningVersion: string): BootDecision {
  if (!journal) return { action: 'none' };

  if (journal.status === 'crashed') {
    return {
      action: 'recovery',
      journal,
      reason:
        journal.failureReason ??
        `Version ${journal.to} did not open the workspace. You can go back to ${journal.from}.`,
    };
  }

  if (journal.status === 'installing') {
    // The installer ran but the new version never recorded a launch. Either the
    // user is still on the old version (cancelled update) or the new one died
    // before it could write anything.
    if (runningVersion === journal.to) {
      return { action: 'confirm-pending', journal };
    }
    // Back on the old version: the install did not happen. Nothing to do.
    return { action: 'none' };
  }

  if (journal.status === 'launched' && runningVersion === journal.to) {
    return { action: 'confirm-pending', journal };
  }

  return { action: 'none' };
}

/** §7.6: is this journal old enough to delete after a successful update? */
export function isJournalExpired(journal: UpdateJournal, now: number): boolean {
  if (journal.status !== 'ok') return false;
  const confirmed = journal.confirmedAt ? Date.parse(journal.confirmedAt) : Date.parse(journal.startedAt);
  if (Number.isNaN(confirmed)) return false;
  return now - confirmed > JOURNAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/** The folder name for a backup of this update: `backup-1.2.0-2026-11-07T10-00-00`. */
export function backupFolderName(fromVersion: string, startedAt: string): string {
  // Colons are illegal in Windows paths, so the ISO stamp is made path-safe.
  const safeStamp = startedAt.replace(/[:.]/g, '-');
  return `backup-${fromVersion}-${safeStamp}`;
}

/**
 * §7.1(c): the previous installer is cached so it can be run again. Returns the
 * path relative to the workspace's `Updates` folder.
 */
export function previousInstallerPath(fromVersion: string): string {
  return `previous/Setup-${fromVersion}.exe`;
}

/**
 * The text the Recovery window shows. Written as data so it can be asserted in a
 * test: a recovery screen that explains the wrong thing is worse than none.
 */
export interface RecoveryContext {
  fromVersion: string;
  toVersion: string;
  hasPreviousInstaller: boolean;
  hasBackups: boolean;
  /** Whether a schema migration ran during the failed update (§7.5). */
  migrationRan: boolean;
}

export function recoveryMessage(context: RecoveryContext): {
  headline: string;
  body: string[];
  canRestorePrevious: boolean;
} {
  const body: string[] = [
    `Version ${context.toVersion} could not open your workspace.`,
    'Your projects, media and exports have not been deleted.',
  ];

  if (context.migrationRan) {
    // §7.5: be explicit that restoring also restores pre-migration databases,
    // because a newer database cannot be opened by an older version.
    body.push(
      'The failed version upgraded your project databases. Restoring the previous version also restores the copies taken before that upgrade, so projects will open at the state they were in before the update.',
    );
  }

  if (!context.hasPreviousInstaller) {
    body.push(
      `The installer for ${context.fromVersion} was not kept, so it cannot be restored automatically. Download it from the releases page.`,
    );
  }

  if (context.hasBackups) {
    body.push('Small backups of your settings were taken before the update and can be restored.');
  }

  return {
    headline: 'Clipwright Studio had a problem starting',
    body,
    canRestorePrevious: context.hasPreviousInstaller,
  };
}
