/**
 * Which file the *preview* should play for a media item (SPEC 04 §7).
 *
 * Proxies exist so scrubbing 4K is not a slideshow, and the decision of whether one is
 * needed already lives in `needsProxy`. This module answers the separate question the
 * app was never asking: given a media record, which of its files should a `<video>`
 * element be pointed at?
 *
 * Kept apart from the Electron protocol handler so the policy can be tested directly —
 * "fell back to the original because the proxy was deleted" is not a thing worth
 * standing up a browser to check.
 */

/** The fields of a media record this decision reads. */
export interface PreviewSourceRecord {
  /** The original file. Always the answer when no proxy is usable. */
  path: string;
  /** The proxy, when one was generated. */
  proxyPath?: string | null | undefined;
}

export interface PreviewSourceOptions {
  /** Whether the user wants proxies used at all. */
  useProxies: boolean;
  /**
   * Whether a path exists on disk, injectable so the decision can be tested without
   * touching a filesystem. Defaults to "trust the record".
   */
  exists?: (path: string) => boolean;
}

/**
 * The path the preview should play, and why.
 *
 * The `reason` is returned rather than logged because the two interesting answers —
 * "there is no proxy" and "there is one but it is gone" — look identical from the
 * outside and mean very different things when a user reports that editing is still
 * slow.
 *
 * Falling back is the default in every uncertain case. A proxy that cannot be read
 * must never make a clip unplayable: the original is always correct, only slower.
 */
export function previewSourceFor(
  record: PreviewSourceRecord,
  options: PreviewSourceOptions,
): { path: string; reason: 'original' | 'proxy' | 'proxy-missing' | 'proxies-off' } {
  const proxy = record.proxyPath;
  if (!proxy) return { path: record.path, reason: 'original' };
  if (!options.useProxies) return { path: record.path, reason: 'proxies-off' };
  /*
    Checked rather than trusted. A proxy lives in the derived directory, which the user
    can clear at any time — and a `404` from the protocol handler would leave the clip
    blank, which reads as "this file is broken" rather than "the proxy is gone".
  */
  const exists = options.exists ?? (() => true);
  if (!exists(proxy)) return { path: record.path, reason: 'proxy-missing' };
  return { path: proxy, reason: 'proxy' };
}
