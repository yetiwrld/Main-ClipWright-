// @vitest-environment jsdom
/**
 * SPEC 11 §6 — project-local caption styles.
 *
 * The hook exists because a style has to be stored somewhere the preview *and* the
 * export can both read. The tests below are mostly about the two ways that goes
 * wrong: writing only the style map back over the project's other settings, and
 * reporting a save as successful when the write failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor, act } from '@testing-library/react';
import { BUILT_IN_STYLES, builtInStyle, exportStyle, type CaptionStyle } from '@clipwright/caption-styles';

const getProject = vi.fn();
const updateProject = vi.fn();

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    getProject: (...args: unknown[]) => getProject(...args),
    updateProject: (...args: unknown[]) => updateProject(...args),
  },
}));

const { useCaptionStyles, projectStylesFromSettings, CAPTION_STYLES_SETTING } = await import(
  '../features/editor/use-caption-styles.js'
);

const bold = builtInStyle('bold-creator')!;
const house: CaptionStyle = { ...bold, id: 'house', name: 'House style' };

/** A stored copy, in the shape a `.cwstyle` file would have. */
const stored = (style: CaptionStyle) => exportStyle(style);

beforeEach(() => {
  getProject.mockReset();
  updateProject.mockReset();
  getProject.mockResolvedValue({ id: 'p1', settings: { aspect: '9:16' } });
  updateProject.mockImplementation(async (_id: string, patch: { settings?: Record<string, unknown> }) => ({
    id: 'p1',
    settings: patch.settings ?? {},
  }));
});

afterEach(() => cleanup());

describe('projectStylesFromSettings', () => {
  it('returns nothing when the project has no copies', () => {
    expect(projectStylesFromSettings({ aspect: '9:16' })).toEqual({});
    expect(projectStylesFromSettings(undefined)).toEqual({});
  });

  it('reads copies back as styles', () => {
    const styles = projectStylesFromSettings({ [CAPTION_STYLES_SETTING]: { house: stored(house) } });
    expect(Object.keys(styles)).toEqual(['house']);
    expect(styles.house!.name).toBe('House style');
  });

  it('drops an entry it cannot parse instead of failing the whole project', () => {
    // A style written by a newer build must cost the user that one style, not the
    // editor: an open that throws is an open that never happens.
    const styles = projectStylesFromSettings({
      [CAPTION_STYLES_SETTING]: {
        house: stored(house),
        broken: { format: 'nope' },
        alsoBroken: 42,
        notAnObject: null,
      },
    });
    expect(Object.keys(styles)).toEqual(['house']);
  });

  it('ignores a settings value that is not a map', () => {
    expect(projectStylesFromSettings({ [CAPTION_STYLES_SETTING]: 'oops' })).toEqual({});
    expect(projectStylesFromSettings({ [CAPTION_STYLES_SETTING]: ['a'] })).toEqual({});
  });
});

describe('useCaptionStyles', () => {
  it('loads the project copies on open', async () => {
    getProject.mockResolvedValue({ id: 'p1', settings: { [CAPTION_STYLES_SETTING]: { house: stored(house) } } });
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(Object.keys(result.current.styles)).toEqual(['house']);
    expect(result.current.error).toBe('');
  });

  it('keeps every other setting when saving a style', async () => {
    // `updateProject` replaces `settings` wholesale. Sending only the style map
    // would reset the project's aspect, language and framing on every save — a
    // data loss that shows up as "my aspect ratio keeps changing".
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.save(house)).toBe(true);
    });
    const patch = updateProject.mock.calls[0]![1] as { settings: Record<string, unknown> };
    expect(patch.settings.aspect).toBe('9:16');
    expect((patch.settings[CAPTION_STYLES_SETTING] as Record<string, CaptionStyle>).house!.name).toBe(
      'House style',
    );
  });

  it('exposes the saved style immediately', async () => {
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save(house);
    });
    expect(result.current.styles.house?.name).toBe('House style');
  });

  it('reports a failed write instead of pretending it saved', async () => {
    updateProject.mockRejectedValue(new Error('disk is full'));
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let ok = true;
    await act(async () => {
      ok = await result.current.save(house);
    });
    expect(ok).toBe(false);
    // The style is not in the map, so the UI cannot show a save that did not happen.
    expect(result.current.styles.house).toBeUndefined();
    expect(result.current.error).toContain('disk is full');
  });

  it('keeps the previous write when a later one fails', async () => {
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save(house);
    });
    updateProject.mockRejectedValueOnce(new Error('nope'));
    const other: CaptionStyle = { ...bold, id: 'other', name: 'Other' };
    await act(async () => {
      expect(await result.current.save(other)).toBe(false);
    });
    expect(Object.keys(result.current.styles)).toEqual(['house']);
  });

  it('removes a project copy', async () => {
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save(house);
    });
    await act(async () => {
      expect(await result.current.remove('house')).toBe(true);
    });
    expect(result.current.styles.house).toBeUndefined();
  });

  it('never lets a save shadow a preset id in the list', async () => {
    // A copy that reused `bold-creator` as its id would replace the preset for the
    // whole project, which is the one thing SPEC 11 §6 forbids.
    const { result } = renderHook(() => useCaptionStyles('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const ids = new Set(BUILT_IN_STYLES.map((style) => style.id));
    await act(async () => {
      await result.current.save(house);
    });
    expect(ids.has('house')).toBe(false);
  });
});
