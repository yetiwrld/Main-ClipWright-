/**
 * SPEC 15 §3, §4 — the renderer's view of the updater.
 *
 * The main process owns the state machine; this hook mirrors it and exposes the
 * user actions. It never invents a status of its own, so what the user sees is
 * always what the updater actually did.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SNOOZE_MS,
  describeUpdateStatus,
  formatDownloadProgress,
  shouldPrompt,
  shouldShowChip,
} from '@clipwright/update-core/browser';
import type { UpdateState } from '@clipwright/update-core/browser';
import type { UpdateStatePayload } from '../../global.js';
import { getBridge, isDesktop } from '../../api.js';

export interface UseUpdatesResult {
  /** `null` until the first state arrives from main. */
  state: UpdateStatePayload | null;
  /** One sentence for the Settings row (§3). */
  statusLine: string;
  /** `42% · 5.0 MB/s · 30s left`, or null when not downloading. */
  progressLine: string | null;
  /** Whether the dialog should be shown without the user asking (§4.2). */
  shouldPromptDialog: boolean;
  /** Whether the top-bar "Update available" chip belongs on screen. */
  showChip: boolean;
  /** True while a check is in flight, for the button spinner. */
  checking: boolean;
  /** Human "Last checked" text from the main process, or a plain fallback. */
  lastCheckedLabel: string;
  check: (options?: { manual?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  remindLater: () => Promise<void>;
  dismiss: () => Promise<void>;
  openReleasePage: () => void;
}

const UNSUPPORTED: UpdateStatePayload = {
  status: 'idle',
  currentVersion: '—',
  channel: 'stable',
  lastCheckedAt: null,
  release: null,
  progress: null,
  error: null,
  skippedVersion: null,
  snoozedUntil: null,
  notice: null,
};

export function useUpdates(): UseUpdatesResult {
  const bridge = getBridge();
  const desktop = isDesktop();
  const [state, setState] = useState<UpdateStatePayload | null>(null);
  // Recomputed on a slow tick so "remind me later" expires without a reload.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!desktop || !bridge) return;
    let cancelled = false;

    void bridge.getUpdateState().then((initial) => {
      if (!cancelled) setState(initial);
    }).catch(() => {
      // A failing getter must not break Settings; the panel shows "Not checked yet".
    });

    const unsubscribe = bridge.onUpdateState((next) => {
      if (!cancelled) setState(next);
    });

    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [bridge, desktop]);

  const check = useCallback(async (options?: { manual?: boolean }) => {
    if (!bridge) return;
    // The result arrives over `update:state`; nothing to do with the return value
    // except let a thrown IPC failure surface in the console rather than vanish.
    await bridge.checkForUpdates(options);
  }, [bridge]);

  const download = useCallback(async () => {
    await bridge?.downloadUpdate();
  }, [bridge]);

  const cancelDownload = useCallback(async () => {
    const next = await bridge?.cancelUpdateDownload();
    if (next) setState(next);
  }, [bridge]);

  const install = useCallback(async () => {
    await bridge?.installUpdate();
  }, [bridge]);

  const skip = useCallback(async () => {
    const next = await bridge?.skipUpdateVersion();
    if (next) setState(next);
  }, [bridge]);

  const remindLater = useCallback(async () => {
    const next = await bridge?.remindUpdateLater();
    if (next) setState(next);
  }, [bridge]);

  const dismiss = useCallback(async () => {
    const next = await bridge?.dismissUpdate();
    if (next) setState(next);
  }, [bridge]);

  const openReleasePage = useCallback(() => {
    const url = state?.release?.htmlUrl;
    if (!url) return;
    // The main process validates the scheme before opening anything externally.
    void bridge?.openPath(url);
  }, [bridge, state]);

  // Safe without a cast: `global.d.ts` asserts UpdateStatePayload is identical to
  // update-core's UpdateState, so this assignment is checked at compile time.
  const effective: UpdateState = state ?? UNSUPPORTED;

  return useMemo<UseUpdatesResult>(() => {
    const statusLine = desktop
      ? describeUpdateStatus(effective, now)
      : 'Updates are available in the desktop app.';

    return {
      state,
      statusLine,
      progressLine: formatDownloadProgress(effective.progress),
      shouldPromptDialog: desktop && state !== null && shouldPrompt(effective, now),
      showChip: desktop && state !== null && shouldShowChip(effective),
      checking: effective.status === 'checking',
      lastCheckedLabel:
        effective.lastCheckedAt === null
          ? 'Never checked'
          : new Date(effective.lastCheckedAt).toLocaleString(),
      check,
      download,
      cancelDownload,
      install,
      skip,
      remindLater,
      dismiss,
      openReleasePage,
    };
  }, [
    state,
    desktop,
    effective,
    now,
    check,
    download,
    cancelDownload,
    install,
    skip,
    remindLater,
    dismiss,
    openReleasePage,
  ]);
}

/** Re-export so a component can render the snooze window without importing core. */
export { SNOOZE_MS };
