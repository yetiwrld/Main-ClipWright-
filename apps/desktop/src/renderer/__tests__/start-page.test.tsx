// @vitest-environment jsdom
/**
 * The start screen — the one screen that had no test, and the one that was broken.
 *
 * Pressing "Find clips" could not create a project: the page sent `storageMode: 'copy'`, which is
 * not in the schema's enum, so `ProjectRecordSchema.parse` threw in main and the create failed.
 * Three more keys (`aspectRatio`, `captionStyle`, `clipLength`) were unknown and therefore ignored,
 * so a user choosing 4:3, Karaoke and Short silently got 9:16, Bold creator and 30–60 s.
 *
 * These tests assert the payload the page hands the bridge, and validate it against the real
 * schema — which is the check that was missing. Validating here rather than only in main means the
 * failure names the page.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectRecordSchema } from '@clipwright/project-schema/schemas';
import { StartPage } from '../pages/StartPage.js';

const created: Array<{ name: string; settings: Record<string, unknown> }> = [];

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    listProjects: vi.fn(async () => []),
    createProject: vi.fn(async (payload: { name: string; settings: Record<string, unknown> }) => {
      created.push(payload);
      return { id: 'prj_new', name: payload.name, stage: 'import' };
    }),
  },
  describeError: (err: unknown) => String(err),
}));

afterEach(() => {
  cleanup();
  created.length = 0;
});

/** A project as the store would build it from what the page sent. */
function storedSettings() {
  return ProjectRecordSchema.parse({
    id: 'prj_new',
    name: 'Untitled project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: created[0]!.settings,
  }).settings;
}

/**
 * Puts a source on the page, since the button is disabled until there is one.
 *
 * The page reads the dropped file's fields directly, so a minimal `File`-shaped object is enough
 * and avoids a real DataTransfer, which jsdom does not implement.
 */
function attachSource() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (input) {
    const file = new File(['x'], 'interview.mp4', { type: 'video/mp4' }) as File & { path?: string };
    Object.defineProperty(file, 'path', { value: '/videos/interview.mp4' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
  }
}

async function pressFindClips() {
  const button = await screen.findByRole('button', { name: /find clips/i });
  fireEvent.click(button);
  await waitFor(() => expect(created).toHaveLength(1));
}

describe('the start screen sends settings the schema accepts', () => {
  it('creates a project from the defaults', async () => {
    render(<StartPage onNavigate={() => undefined} />);
    attachSource();
    await pressFindClips();

    /* Parsing here is the assertion: before the fix this threw `invalid_enum_value` on `copy`. */
    const settings = storedSettings();
    expect(settings.storageMode).toBe('managed');
    expect(settings.aspect).toBe('9:16');
    expect(settings.sourcePath).toBe('/videos/interview.mp4');
  });

  it('sends the aspect tile the user picked, by its schema name', async () => {
    render(<StartPage onNavigate={() => undefined} />);
    attachSource();
    fireEvent.click(screen.getByRole('button', { name: '4:3' }));
    await pressFindClips();
    expect(storedSettings().aspect).toBe('4:3');
  });

  it('sends the caption style the user picked', async () => {
    /*
      The silent half of the bug: `captionStyle` was an unknown key the schema passed through and
      nothing read, so the project was created with the schema's default and no error was shown.

      One change per test, deliberately. The first version of this test picked Karaoke *and* Short,
      so removing `captionStyle` from the create callback's dependencies still passed — the clip
      length dep rebuilt the callback and carried the new caption style with it. A test that makes
      two changes cannot tell which one made the other work.
    */
    render(<StartPage onNavigate={() => undefined} />);
    attachSource();
    fireEvent.click(screen.getByRole('button', { name: 'Karaoke' }));
    await pressFindClips();
    expect(storedSettings().captionStyleId).toBe('karaoke');
  });

  it('sends the clip length the user picked, as the range the analysis reads', async () => {
    render(<StartPage onNavigate={() => undefined} />);
    attachSource();
    fireEvent.click(screen.getByRole('button', { name: /^Short 15/ }));
    await pressFindClips();

    const settings = storedSettings();
    expect(settings.clipLengthPreset).toBe('short');
    /* The range is what `moments-service` reads; the preset name alone would be decorative. */
    expect(settings.clipLengthRangeSec).toEqual([15, 30]);
  });

  it('sends the storage choice, which the schema names differently', async () => {
    /*
      The value that broke the page. "Copy into the project" is `managed` in the schema, and it is
      chosen from a control inside the Advanced panel — so this test opens the panel first.
    */
    render(<StartPage onNavigate={() => undefined} />);
    attachSource();
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reference original' }));
    await pressFindClips();
    expect(storedSettings().storageMode).toBe('reference');
  });

  it('does not send a clip count the schema would refuse', async () => {
    /*
      `Number('custom')` is NaN, and the schema refuses a non-integer count — the same shape of
      failure as `copy`. The Custom tile has to resolve to a number before it is sent.
    */
    render(<StartPage onNavigate={() => undefined} />);
    attachSource();
    /* Two Custom tiles exist — aspect and clip count — so both are taken, which is also the case
       that would break: a NaN from either one refuses the whole project. */
    const customTiles = screen.getAllByRole('button', { name: 'Custom' });
    for (const tile of customTiles) fireEvent.click(tile);
    await pressFindClips();
    const settings = storedSettings();
    expect(Number.isInteger(settings.clipCount)).toBe(true);
    expect(settings.customAspect).toEqual({ width: 4, height: 5 });
  });
});
