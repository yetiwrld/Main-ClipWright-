// @vitest-environment jsdom
/**
 * SPEC 15 §7.3–§7.5 — the Recovery window.
 *
 * The scenarios worth testing are the ones where the wrong words or a missing
 * button leave someone stuck: no previous installer kept, a migration that
 * invalidated the old databases, and the installer failing to start.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryDialog } from '../features/updates/RecoveryDialog.js';
import type { RecoveryStatePayload } from '../global.js';

// Without this, each render stacks on the previous one and every query finds
// duplicate elements.
afterEach(cleanup);

const state: RecoveryStatePayload = {
  headline: 'Clipwright Studio had a problem starting',
  body: [
    'Version 1.3.0 could not open your workspace.',
    'Your projects, media and exports have not been deleted.',
  ],
  canRestorePrevious: true,
  fromVersion: '1.2.0',
  toVersion: '1.3.0',
};

function setup(overrides: Partial<RecoveryStatePayload> = {}, onRestorePrevious = vi.fn(async () => ({ ok: true }))) {
  const onDismiss = vi.fn();
  const onOpenReleasesPage = vi.fn();
  render(
    <RecoveryDialog
      open
      state={{ ...state, ...overrides }}
      onRestorePrevious={onRestorePrevious}
      onDismiss={onDismiss}
      onOpenReleasesPage={onOpenReleasesPage}
    />,
  );
  return { onRestorePrevious, onDismiss, onOpenReleasesPage };
}

describe('RecoveryDialog', () => {
  it('says the work is safe', () => {
    setup();
    expect(screen.getByText(/have not been deleted/)).toBeTruthy();
  });

  it('shows every sentence it was given, in order', () => {
    setup();
    const body = screen.getByTestId('recovery-body');
    const paragraphs = Array.from(body.querySelectorAll('p')).map((node) => node.textContent);
    expect(paragraphs).toEqual(state.body);
  });

  it('names both versions', () => {
    setup();
    expect(screen.getByText('1.2.0 → 1.3.0')).toBeTruthy();
  });

  it('offers going back when the previous installer was kept', () => {
    setup();
    expect(screen.getByTestId('restore-previous').textContent).toContain('Go back to 1.2.0');
  });

  it('offers a download instead when it was not kept, and says why', () => {
    // §7.1(c) allows the installer to be missing; the window must not pretend
    // a restore is possible.
    const { onOpenReleasesPage } = setup({
      canRestorePrevious: false,
      body: [...state.body, 'The installer for 1.2.0 was not kept, so it cannot be restored automatically.'],
    });

    expect(screen.queryByTestId('restore-previous')).toBeNull();
    expect(screen.getByText(/was not kept/)).toBeTruthy();
    screen.getByRole('button', { name: 'Download 1.2.0' }).click();
    expect(onOpenReleasesPage).toHaveBeenCalled();
  });

  it('calls through when the user chooses to go back', async () => {
    const { onRestorePrevious } = setup();
    fireEvent.click(screen.getByTestId('restore-previous'));
    expect(onRestorePrevious).toHaveBeenCalledTimes(1);
  });

  it('shows the installer failure instead of a silent no-op', async () => {
    const failing = vi.fn(async () => ({ ok: false, error: 'The installer is missing.' }));
    setup({}, failing);

    fireEvent.click(screen.getByTestId('restore-previous'));

    expect(await screen.findByTestId('recovery-error')).toBeTruthy();
    expect(screen.getByTestId('recovery-error').textContent).toContain('The installer is missing.');
  });

  it('reports a thrown error too', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('EACCES');
    });
    setup({}, throwing as never);
    fireEvent.click(screen.getByTestId('restore-previous'));
    await waitFor(() => expect(screen.getByTestId('recovery-error').textContent).toContain('EACCES'));
  });

  it('lets the user continue anyway, without hiding the risk', () => {
    const { onDismiss } = setup();
    screen.getByRole('button', { name: 'Continue anyway' }).click();
    expect(onDismiss).toHaveBeenCalled();
    // Honest about what continuing means.
    expect(screen.getByText(/Continuing keeps version 1.3.0/)).toBeTruthy();
  });

  it('renders nothing when there is no recovery state', () => {
    const { container } = render(
      <RecoveryDialog open state={null} onRestorePrevious={vi.fn()} onDismiss={vi.fn()} onOpenReleasesPage={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });
});
