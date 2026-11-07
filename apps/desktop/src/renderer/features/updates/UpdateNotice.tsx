/**
 * SPEC 15 §4.2 — the update notice, mounted once in the app shell.
 *
 * Owns the dialog and the top-bar chip so both read the same state from one
 * `useUpdates()` instance. Rendering them separately would mean two copies of
 * the state machine in the renderer, which is exactly the kind of drift the
 * "main process owns the state" rule exists to prevent.
 *
 * The dialog opens by itself only when `shouldPrompt` says so (§4.2: once per
 * version, never during a download the user started). After that the chip is the
 * only way in, so a user who dismissed it is not asked again.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useUpdates } from './use-updates.js';
import { UpdateDialog } from './UpdateDialog.js';
import { UpdateChip } from './UpdateChip.js';

export interface UpdateNoticeProps {
  /** Set false in tests and on the start page, where the chip would be noise. */
  showChip?: boolean;
  /** Called when the user asks to see the update's release page. */
  onOpenReleasePage?: (url: string) => void;
  /**
   * A counter the shell increments to ask for the dialog — used by the Settings
   * "Check now" row, which lives in a different subtree. A counter rather than a
   * boolean so repeated presses keep working after the dialog is closed.
   */
  openRequest?: number;
}

export function UpdateNotice({ showChip = true, onOpenReleasePage, openRequest = 0 }: UpdateNoticeProps) {
  const updates = useUpdates();
  const [open, setOpen] = useState(false);
  // Once the user closes the dialog, do not re-open it on the next prompt.
  const [dismissedThisRun, setDismissedThisRun] = useState(false);

  // §4.2: prompt at most once per version, and never while installing.
  useEffect(() => {
    if (!dismissedThisRun && updates.shouldPromptDialog) setOpen(true);
  }, [dismissedThisRun, updates.shouldPromptDialog]);

  // An explicit request from Settings overrides the "already dismissed" rule:
  // the user is asking to see it now.
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  const close = useCallback(() => {
    setOpen(false);
    setDismissedThisRun(true);
  }, []);

  // The hook already validates the scheme and routes through the main process;
  // duplicating the URL logic here would mean two places to get it wrong.
  const { openReleasePage: openFromHook } = updates;
  const openReleasePage = useCallback(() => {
    if (onOpenReleasePage) {
      const url = updates.state?.release?.htmlUrl;
      if (url) onOpenReleasePage(url);
      return;
    }
    openFromHook();
  }, [onOpenReleasePage, openFromHook, updates.state?.release?.htmlUrl]);

  const chipVisible = showChip && updates.showChip && !open;

  return (
    <>
      {chipVisible && (
        <UpdateChip
          label={updates.state?.release ? `Update ${updates.state.release.version}` : 'Update available'}
          onSelect={() => setOpen(true)}
        />
      )}

      <UpdateDialog
        open={open}
        state={updates.state}
        progressLine={updates.progressLine}
        onClose={close}
        onDownload={() => void updates.download()}
        onCancelDownload={() => void updates.cancelDownload()}
        onInstall={() => void updates.install()}
        onSkip={() => void updates.skip()}
        onRemindLater={() => {
          void updates.remindLater();
          close();
        }}
        onViewOnGitHub={openReleasePage}
      />
    </>
  );
}
