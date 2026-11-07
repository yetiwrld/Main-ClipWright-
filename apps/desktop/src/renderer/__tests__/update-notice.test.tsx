// @vitest-environment jsdom
/**
 * SPEC 15 §3, §4.1, §4.2 — the mounted update UI.
 *
 * The behaviour under test is really a set of rules about when *not* to
 * interrupt: no dialog when nothing has been found, no re-prompt after the user
 * closed it, no chip while the dialog is open. Getting those wrong is how update
 * prompts earn their reputation.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_DRAG_REGION } from '../components/TopBar.js';

const mockState: { value: unknown } = { value: null };

vi.mock('../features/updates/use-updates.js', () => ({
  useUpdates: () => mockState.value,
}));

const { UpdateNotice } = await import('../features/updates/UpdateNotice.js');
const { UpdateChip } = await import('../features/updates/UpdateChip.js');

function hookResult(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      status: 'available',
      currentVersion: '1.2.0',
      channel: 'stable',
      lastCheckedAt: null,
      release: {
        version: '1.3.0',
        summary: 'Faster exports.',
        full: 'Faster exports.',
        releasedAt: '2026-11-01T00:00:00Z',
        prerelease: false,
        downloadBytes: 120_000_000,
        signed: false,
        htmlUrl: 'https://github.com/yetiwrld/Main-ClipWright-/releases/tag/v1.3.0',
      },
      progress: null,
      error: null,
      skippedVersion: null,
      snoozedUntil: null,
      notice: null,
    },
    statusLine: 'Version 1.3.0 is available.',
    progressLine: null,
    shouldPromptDialog: false,
    showChip: true,
    checking: false,
    lastCheckedLabel: 'Today',
    check: vi.fn(),
    download: vi.fn(),
    cancelDownload: vi.fn(),
    install: vi.fn(),
    skip: vi.fn(),
    remindLater: vi.fn(),
    dismiss: vi.fn(),
    openReleasePage: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  mockState.value = hookResult();
});

describe('UpdateNotice', () => {
  it('shows the chip with the version when an update is available', () => {
    render(<UpdateNotice />);
    expect(screen.getByTestId('update-chip').textContent).toContain('Update 1.3.0');
  });

  it('hides the chip when the hook says it does not belong', () => {
    mockState.value = hookResult({ showChip: false });
    render(<UpdateNotice />);
    expect(screen.queryByTestId('update-chip')).toBeNull();
  });

  it('hides the chip when showChip is false, even if the update exists', () => {
    render(<UpdateNotice showChip={false} />);
    expect(screen.queryByTestId('update-chip')).toBeNull();
  });

  it('does not open the dialog on its own when no update was found', () => {
    mockState.value = hookResult({ shouldPromptDialog: false });
    render(<UpdateNotice />);
    expect(screen.queryByText('Update available')).toBeNull();
  });

  it('opens by itself when the hook says to prompt (§4.2)', () => {
    mockState.value = hookResult({ shouldPromptDialog: true });
    render(<UpdateNotice />);
    expect(screen.getByText('Update available')).toBeTruthy();
  });

  it('opens when the user clicks the chip', () => {
    render(<UpdateNotice />);
    fireEvent.click(screen.getByTestId('update-chip'));
    expect(screen.getByText('Update available')).toBeTruthy();
    // The chip steps aside while the dialog is up.
    expect(screen.queryByTestId('update-chip')).toBeNull();
  });

  it('opens when the shell asks, e.g. from Settings (§3)', () => {
    const { rerender } = render(<UpdateNotice openRequest={0} />);
    expect(screen.queryByText('Update available')).toBeNull();

    rerender(<UpdateNotice openRequest={1} />);
    expect(screen.getByText('Update available')).toBeTruthy();
  });

  it('does not re-prompt after the user closes the dialog', () => {
    mockState.value = hookResult({ shouldPromptDialog: true });
    const { rerender } = render(<UpdateNotice />);
    expect(screen.getByText('Update available')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByText('Update available')).toBeNull();

    // A new state arrives that still says "prompt me".
    mockState.value = hookResult({ shouldPromptDialog: true });
    rerender(<UpdateNotice />);
    expect(screen.queryByText('Update available')).toBeNull();
  });

  it('passes user actions through to the hook', () => {
    const download = vi.fn();
    mockState.value = hookResult({
      download,
      state: { ...hookResult().state as object, status: 'available' },
    });
    render(<UpdateNotice openRequest={1} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateChip', () => {
  it('is a button, so it is reachable by keyboard', () => {
    const onSelect = vi.fn();
    render(<UpdateChip label="Update 1.3.0" onSelect={onSelect} />);
    const chip = screen.getByRole('button', { name: /Update 1.3.0/ });
    expect(chip.tagName).toBe('BUTTON');
    fireEvent.click(chip);
    expect(onSelect).toHaveBeenCalled();
  });

  it('opts out of the window drag region, so clicks reach the chip', () => {
    // The top bar is a drag region; Electron swallows clicks on draggable
    // elements, so a clickable chip must declare no-drag. jsdom drops the
    // WebkitAppRegion key from inline styles, so the constant is asserted
    // directly — it is the value the component spreads.
    expect(NO_DRAG_REGION).toEqual({ WebkitAppRegion: 'no-drag' });
    const onSelect = vi.fn();
    render(<UpdateChip label="Update 1.3.0" onSelect={onSelect} />);
    expect(screen.getByTestId('update-chip')).toBeTruthy();
  });
});
