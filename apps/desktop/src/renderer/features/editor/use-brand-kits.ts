/**
 * SPEC 13 §8.2 — the project's brand kits.
 *
 * The kits a project has live in the project record's `settings`, under one key, in the same
 * place the caption-style copies live and for the same reason: a kit is the user's, it travels
 * with the project it was made for, and a separate database table would have to be migrated,
 * backed up and reconciled for data that is a handful of small objects.
 *
 * `settings` is `passthrough` in the schema, so nothing in the project format had to change —
 * which is the whole benefit of the caption-style precedent and the reason this file mirrors
 * `use-caption-styles.ts` instead of inventing a store.
 *
 * Invalid entries are dropped rather than thrown. A kit written by a newer build, or one a bad
 * merge mangled, must not stop the editor from opening: the user loses that kit, not the
 * project.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tryParseBrandKit, type BrandKit } from '@clipwright/brand-kits';
import { api, isDesktop } from '../../api.js';

/** Where in the project record the kits live. */
export const BRAND_KITS_SETTING = 'brandKits';

/** The kits in a project's settings, keyed by id. Exported so a test can check the parse. */
export function projectKitsFromSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, BrandKit> {
  const raw = settings?.[BRAND_KITS_SETTING];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const kits: Record<string, BrandKit> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = tryParseBrandKit(value);
    if (!parsed.ok) continue;
    /*
      The key is the identity, not the object's `id`: the two can disagree after a hand-edited
      file, and the one the map is keyed by is the one every caller looks a kit up with.
    */
    kits[id] = { ...parsed.kit, id };
  }
  return kits;
}

export interface BrandKitsApi {
  /** Every kit in this project, in insertion order. */
  kits: BrandKit[];
  get: (kitId: string) => BrandKit | undefined;
  /** Create or replace a kit. Resolves false when the project could not be written. */
  save: (kit: BrandKit) => Promise<boolean>;
  /** Delete a kit. Applied items are untouched — they are ordinary items. */
  remove: (kitId: string) => Promise<boolean>;
  loading: boolean;
  error: string;
}

export function useBrandKits(projectId: string): BrandKitsApi {
  const [kits, setKits] = useState<Record<string, BrandKit>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /*
    The whole settings object is kept and written back: `updateProject` replaces the field
    rather than merging into it, so sending only `brandKits` would drop the caption styles, the
    aspect and everything else.
  */
  const settingsRef = useRef<Record<string, unknown>>({});
  const kitsRef = useRef<Record<string, BrandKit>>({});

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
        const loaded = projectKitsFromSettings(settings);
        kitsRef.current = loaded;
        setKits(loaded);
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
    async (next: Record<string, BrandKit>) => {
      if (!isDesktop()) return false;
      const settings = { ...settingsRef.current, [BRAND_KITS_SETTING]: next };
      try {
        await api.updateProject(projectId, { settings });
        /*
          Only after the write lands: showing a kit as saved when the disk said no is how a
          user finds out at export time instead of here.
        */
        settingsRef.current = settings;
        kitsRef.current = next;
        setKits(next);
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
    (kit: BrandKit) => write({ ...kitsRef.current, [kit.id]: kit }),
    [write],
  );

  const remove = useCallback(
    (kitId: string) => {
      const { [kitId]: _removed, ...rest } = kitsRef.current;
      return write(rest);
    },
    [write],
  );

  const get = useCallback((kitId: string) => kitsRef.current[kitId], []);

  return useMemo(
    () => ({ kits: Object.values(kits), get, save, remove, loading, error }),
    [kits, get, save, remove, loading, error],
  );
}
