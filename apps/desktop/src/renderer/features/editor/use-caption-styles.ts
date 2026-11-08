/**
 * SPEC 11 §6, §7 — project-local caption styles.
 *
 * A style editor has to put its result *somewhere*. The presets are immutable, so
 * every edit becomes a copy that belongs to this project and to nothing else. The
 * copies live in the project record's settings (which are `passthrough`), keyed by
 * id, and every consumer — the caption overlay, the caption panel, and the burn-in
 * — reads them through this one hook so a saved style cannot be visible in the
 * preview and missing from the export.
 *
 * Invalid entries are dropped rather than thrown: a style saved by a newer build,
 * or one a bad merge mangled, must not stop the editor from opening. The user loses
 * that style, not the project.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tryParseStyle, type CaptionStyle } from '@clipwright/caption-styles';
import { api, isDesktop } from '../../api.js';

/** Where in the project record the copies live. */
export const CAPTION_STYLES_SETTING = 'captionStyles';

export function projectStylesFromSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, CaptionStyle> {
  const raw = settings?.[CAPTION_STYLES_SETTING];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const styles: Record<string, CaptionStyle> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = tryParseStyle(value);
    if (!parsed.ok) continue;
    // The key is the identity: two entries claiming one id would make which one
    // wins depend on the order of an object, which is not a decision anyone made.
    styles[id] = parsed.style;
  }
  return styles;
}

export interface CaptionStylesApi {
  styles: Readonly<Record<string, CaptionStyle>>;
  /** Persist one style. Resolves false when the project could not be written. */
  save: (style: CaptionStyle) => Promise<boolean>;
  /** Delete a project copy. Built-ins are not in here, so they cannot be. */
  remove: (styleId: string) => Promise<boolean>;
  loading: boolean;
  error: string;
}

export function useCaptionStyles(projectId: string): CaptionStylesApi {
  const [styles, setStyles] = useState<Record<string, CaptionStyle>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // The whole settings object has to be written back: `updateProject` replaces the
  // field rather than merging into it, so sending only `captionStyles` would drop
  // the aspect, the language, everything.
  const settingsRef = useRef<Record<string, unknown>>({});
  const stylesRef = useRef<Record<string, CaptionStyle>>({});

  useEffect(() => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void api
      .getProject(projectId)
      .then((project) => {
        if (cancelled) return;
        const settings = (project?.settings ?? {}) as Record<string, unknown>;
        settingsRef.current = settings;
        const loaded = projectStylesFromSettings(settings);
        stylesRef.current = loaded;
        setStyles(loaded);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const write = useCallback(
    async (next: Record<string, CaptionStyle>) => {
      if (!isDesktop()) return false;
      const settings = {
        ...settingsRef.current,
        [CAPTION_STYLES_SETTING]: next,
      };
      try {
        await api.updateProject(projectId, { settings });
        // Only after the write lands: showing a style as saved when the disk said
        // no is how a user discovers the loss at export time instead of here.
        settingsRef.current = settings;
        stylesRef.current = next;
        setStyles(next);
        setError('');
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [projectId],
  );

  const save = useCallback(
    (style: CaptionStyle) => write({ ...stylesRef.current, [style.id]: style }),
    [write],
  );

  const remove = useCallback(
    (styleId: string) => {
      const { [styleId]: _removed, ...rest } = stylesRef.current;
      return write(rest);
    },
    [write],
  );

  return useMemo(() => ({ styles, save, remove, loading, error }), [styles, save, remove, loading, error]);
}
