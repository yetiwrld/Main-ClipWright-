// @vitest-environment jsdom
/**
 * SPEC 15 §4.2, §6.4 — the update dialog.
 *
 * The behaviours that matter: the unsigned notice is never omitted, the buttons
 * match the state (no "Install" before a verified download), and progress shown
 * is the progress reported.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { UpdateDialog } from '../features/updates/UpdateDialog.js';
import type { UpdateStatePayload } from '../global.js';

afterEach(() => cleanup());

const baseRelease = {
  version: '1.3.0',
  summary: 'Exports are twice as fast.',
  full: '# What changed\n- Faster audio mix\n- Fixed a crash',
  releasedAt: '2026-11-01T10:00:00.000Z',
  prerelease: false,
  downloadBytes: 120_000_000,
  signed: false,
  htmlUrl: 'https://github.com/yetiwrld/Main-ClipWright-/releases/tag/v1.3.0',
};

function makeState(overrides: Partial<UpdateStatePayload> = {}): UpdateStatePayload {
  return {
    status: 'available',
    currentVersion: '1.2.0',
    channel: 'stable',
    lastCheckedAt: Date.now(),
    release: baseRelease,
    progress: null,
    error: null,
    skippedVersion: null,
    snoozedUntil: null,
    notice: null,
    ...overrides,
  };
}

function renderDialog(state: UpdateStatePayload | null, overrides: Partial<Parameters<typeof UpdateDialog>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onDownload: vi.fn(),
    onCancelDownload: vi.fn(),
    onInstall: vi.fn(),
    onSkip: vi.fn(),
    onRemindLater: vi.fn(),
    onViewOnGitHub: vi.fn(),
  };
  render(
    <UpdateDialog
      open
      state={state}
      progressLine={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('the available state', () => {
  it('shows both versions and the download size', () => {
    renderDialog(makeState());
    expect(screen.getByText('Version 1.3.0')).toBeTruthy();
    expect(screen.getByText('You have 1.2.0')).toBeTruthy();
    expect(screen.getByText('114 MB')).toBeTruthy();
  });

  it('always shows the unsigned notice when the installer is unsigned (§6.4)', () => {
    renderDialog(makeState());
    expect(screen.getByText('Unsigned installer.')).toBeTruthy();
    expect(screen.getByText(/SmartScreen/)).toBeTruthy();
  });

  it('omits the unsigned notice when the build is signed', () => {
    renderDialog(makeState({ release: { ...baseRelease, signed: true } }));
    expect(screen.queryByText('Unsigned installer.')).toBeNull();
  });

  it('warns about a pre-release', () => {
    renderDialog(makeState({ release: { ...baseRelease, prerelease: true } }));
    expect(screen.getByText('Pre-release')).toBeTruthy();
  });

  it('offers Download, Remind me later and Skip', () => {
    const handlers = renderDialog(makeState());
    // "Download" is also a metadata label, so match the button by role.
    const downloadButton = screen.getByRole('button', { name: 'Download' });

    fireEvent.click(downloadButton);
    expect(handlers.onDownload).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Skip this version'));
    expect(handlers.onSkip).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Remind me later'));
    expect(handlers.onRemindLater).toHaveBeenCalled();
  });

  it('never offers Install before the download is verified (§2.2)', () => {
    renderDialog(makeState());
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull();
  });

  it('shows the summary and can expand the full notes', () => {
    renderDialog(makeState());
    expect(screen.getByText('Exports are twice as fast.')).toBeTruthy();
    fireEvent.click(screen.getByText('Full release notes'));
    expect(screen.getByText('What changed')).toBeTruthy();
    expect(screen.getByText(/Faster audio mix/)).toBeTruthy();
  });

  it('opens the release page on request', () => {
    const handlers = renderDialog(makeState());
    fireEvent.click(screen.getByText('View on GitHub'));
    expect(handlers.onViewOnGitHub).toHaveBeenCalled();
  });
});

describe('the downloading state', () => {
  const downloading = makeState({
    status: 'downloading',
    progress: { percent: 42, transferredBytes: 42, totalBytes: 100, bytesPerSecond: 0, etaSec: null },
  });

  it('shows the reported percentage and offers Cancel', () => {
    const handlers = renderDialog(downloading, { progressLine: '42% · 5.0 MB/s' });
    // Both the progress bar and the detail line report the true percentage.
    expect(screen.getAllByText(/42%/).length).toBeGreaterThan(0);
    expect(screen.getByText('42% · 5.0 MB/s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onCancelDownload).toHaveBeenCalled();
  });

  it('does not offer Download or Install while downloading', () => {
    renderDialog(downloading);
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull();
  });
});

describe('the verifying state', () => {
  it('says what is happening and disables the action', () => {
    renderDialog(makeState({ status: 'verifying', progress: { percent: 100, transferredBytes: 100, totalBytes: 100, bytesPerSecond: 0, etaSec: null } }));
    expect(screen.getByText(/Checking the signature/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Verifying…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe('the ready state', () => {
  const ready = makeState({ status: 'ready' });

  it('offers Install and restart', () => {
    const handlers = renderDialog(ready);
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(handlers.onInstall).toHaveBeenCalled();
  });

  it('offers Later instead of Skip', () => {
    renderDialog(ready);
    expect(screen.getByText('Later')).toBeTruthy();
    expect(screen.queryByText('Skip this version')).toBeNull();
  });
});

describe('errors', () => {
  it('shows a plain message and a retry', () => {
    const handlers = renderDialog(
      makeState({
        status: 'error',
        error: {
          kind: 'offline',
          message: "Couldn't reach GitHub. Check your internet connection.",
          retryable: true,
        },
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Check your internet connection');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onDownload).toHaveBeenCalled();
  });

  it('does not offer a retry for a failure that will not improve', () => {
    renderDialog(
      makeState({
        status: 'error',
        error: { kind: 'unverified', message: "This update couldn't be verified.", retryable: false },
      }),
    );
    expect(screen.queryByText('You can try again.')).toBeNull();
  });
});

describe('nothing to show', () => {
  it('says so plainly instead of rendering an empty dialog', () => {
    renderDialog(null);
    expect(screen.getByText('There is no update to show right now.')).toBeTruthy();
  });
});
