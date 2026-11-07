// @vitest-environment node
/**
 * SPEC 15 §7 — update journal, boot marking and recovery.
 *
 * These rules decide whether a user whose app stopped starting gets a way back.
 * The cases worth care: a cancelled install must not trigger recovery, a single
 * workspace failure must not either (it may be a fluke), and the second one must.
 */
import { describe, expect, it } from 'vitest';
import {
  BOOT_CONFIRM_MS,
  JOURNAL_RETENTION_DAYS,
  MAX_BOOT_FAILURES,
  advanceJournal,
  backupFolderName,
  confirmBoot,
  createJournal,
  decideBootAction,
  isJournalExpired,
  previousInstallerPath,
  recoveryMessage,
  type UpdateJournal,
} from '../journal.js';

const T0 = '2026-11-07T10:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

const installing = () => createJournal('1.2.0', '1.3.0', T0);
const launched = () => advanceJournal(installing(), { type: 'launched', at: T0 });

describe('createJournal', () => {
  it('starts in the installing state', () => {
    expect(installing()).toMatchObject({ from: '1.2.0', to: '1.3.0', status: 'installing', startedAt: T0 });
  });
});

describe('advanceJournal', () => {
  it('records the first launch', () => {
    const journal = launched();
    expect(journal.status).toBe('launched');
    expect(journal.launchedAt).toBe(T0);
  });

  it('does not overwrite the first launch time on a second launch', () => {
    const journal = advanceJournal(launched(), { type: 'launched', at: at(5000) });
    expect(journal.launchedAt).toBe(T0);
  });

  it('counts one workspace failure without entering recovery', () => {
    const journal = advanceJournal(launched(), { type: 'workspace-failed', at: at(1000) });
    expect(journal.status).toBe('launched');
    expect(journal.failures).toBe(1);
  });

  it('enters the crashed state on the second failure (§7.3)', () => {
    let journal = launched();
    journal = advanceJournal(journal, { type: 'workspace-failed', at: at(1000) });
    journal = advanceJournal(journal, { type: 'workspace-failed', at: at(2000), reason: 'db locked' });

    expect(journal.status).toBe('crashed');
    expect(journal.failures).toBe(MAX_BOOT_FAILURES);
    expect(journal.failureReason).toBe('db locked');
  });

  it('ignores a failure before the new version has launched', () => {
    // The old version failing is not this update's problem.
    const journal = advanceJournal(installing(), { type: 'workspace-failed', at: T0 });
    expect(journal.status).toBe('installing');
    expect(journal.failures).toBeUndefined();
  });

  it('records a rollback', () => {
    expect(advanceJournal(launched(), { type: 'rolled-back', at: at(9000) }).status).toBe('rolled-back');
  });

  it('does not advance a confirmed journal', () => {
    const confirmed = confirmBoot(launched(), at(BOOT_CONFIRM_MS));
    const after = advanceJournal(confirmed, { type: 'workspace-failed', at: at(BOOT_CONFIRM_MS + 1000) });
    expect(after.status).toBe('ok');
  });
});

describe('confirmBoot', () => {
  it('confirms a launched update after the window', () => {
    const journal = confirmBoot(launched(), at(BOOT_CONFIRM_MS));
    expect(journal.status).toBe('ok');
    expect(journal.confirmedAt).toBe(at(BOOT_CONFIRM_MS));
  });

  it('will not confirm something that never launched', () => {
    expect(confirmBoot(installing(), at(BOOT_CONFIRM_MS)).status).toBe('installing');
  });

  it('uses a 60-second window (§7.3)', () => {
    expect(BOOT_CONFIRM_MS).toBe(60_000);
  });
});

describe('decideBootAction', () => {
  it('does nothing without a journal', () => {
    expect(decideBootAction(null, '1.3.0')).toEqual({ action: 'none' });
  });

  it('asks for confirmation when the new version is running', () => {
    const decision = decideBootAction(launched(), '1.3.0');
    expect(decision.action).toBe('confirm-pending');
  });

  it('does nothing when the user cancelled the install and is still on the old version', () => {
    // §11: "installer launched but user cancels UAC — app remains running, state
    // resets". This must not send them to a Recovery window.
    expect(decideBootAction(installing(), '1.2.0')).toEqual({ action: 'none' });
  });

  it('confirms when the new version started without writing a launch marker', () => {
    // The process may have died between the installer and the journal write.
    const decision = decideBootAction(installing(), '1.3.0');
    expect(decision.action).toBe('confirm-pending');
  });

  it('opens recovery after a crash, naming both versions', () => {
    let journal = launched();
    journal = advanceJournal(journal, { type: 'workspace-failed', at: at(1000) });
    journal = advanceJournal(journal, { type: 'workspace-failed', at: at(2000) });

    const decision = decideBootAction(journal, '1.3.0');
    expect(decision.action).toBe('recovery');
    if (decision.action === 'recovery') {
      expect(decision.reason).toContain('1.3.0');
    }
  });

  it('does nothing once confirmed', () => {
    const confirmed = confirmBoot(launched(), at(BOOT_CONFIRM_MS));
    expect(decideBootAction(confirmed, '1.3.0')).toEqual({ action: 'none' });
  });
});

describe('isJournalExpired', () => {
  it('keeps an unconfirmed journal regardless of age', () => {
    const old = launched();
    expect(isJournalExpired(old, Date.parse(T0) + 365 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('expires a confirmed journal after the retention window', () => {
    const confirmed = confirmBoot(launched(), T0);
    const day = 24 * 60 * 60 * 1000;
    expect(isJournalExpired(confirmed, Date.parse(T0) + (JOURNAL_RETENTION_DAYS - 1) * day)).toBe(false);
    expect(isJournalExpired(confirmed, Date.parse(T0) + (JOURNAL_RETENTION_DAYS + 1) * day)).toBe(true);
  });

  it('keeps a crashed journal so the recovery path stays available', () => {
    let journal: UpdateJournal = launched();
    journal = advanceJournal(journal, { type: 'workspace-failed', at: at(1) });
    journal = advanceJournal(journal, { type: 'workspace-failed', at: at(2) });
    expect(isJournalExpired(journal, Date.parse(T0) + 365 * 24 * 60 * 60 * 1000)).toBe(false);
  });
});

describe('paths', () => {
  it('makes a path-safe backup folder name', () => {
    // Colons are illegal in Windows paths; a raw ISO stamp would fail to create.
    const name = backupFolderName('1.2.0', T0);
    expect(name).not.toContain(':');
    expect(name).toBe('backup-1.2.0-2026-11-07T10-00-00-000Z');
  });

  it('names the cached previous installer', () => {
    expect(previousInstallerPath('1.2.0')).toBe('previous/Setup-1.2.0.exe');
  });
});

describe('recoveryMessage', () => {
  const base = { fromVersion: '1.2.0', toVersion: '1.3.0', hasPreviousInstaller: true, hasBackups: true, migrationRan: false };

  it('says the data is safe, first', () => {
    const { body } = recoveryMessage(base);
    expect(body[1]).toContain('have not been deleted');
  });

  it('offers restore when the previous installer was kept', () => {
    expect(recoveryMessage(base).canRestorePrevious).toBe(true);
  });

  it('explains when it cannot restore', () => {
    const result = recoveryMessage({ ...base, hasPreviousInstaller: false });
    expect(result.canRestorePrevious).toBe(false);
    expect(result.body.join(' ')).toContain('releases page');
  });

  it('warns that a migration means restoring older databases too (§7.5)', () => {
    const { body } = recoveryMessage({ ...base, migrationRan: true });
    expect(body.join(' ')).toContain('upgraded your project databases');
    expect(body.join(' ')).toContain('restores the copies taken before that upgrade');
  });

  it('does not mention backups it does not have', () => {
    const { body } = recoveryMessage({ ...base, hasBackups: false });
    expect(body.join(' ')).not.toContain('Small backups');
  });
});
