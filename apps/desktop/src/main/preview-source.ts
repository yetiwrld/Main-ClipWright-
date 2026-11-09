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

/**
 * The scrub-frame URL a preview overlay should show, or `null` when no frame can serve it.
 *
 * The preview has three ways to show a frame under the playhead, and they are not equally
 * good:
 *
 *   1. **A cached scrub frame** — a file read and an `<img>` swap. This is what the cache
 *      was built for and what the preview has never used.
 *   2. **A `<video>` seek** — bounded by how fast the element can flush its decoder and
 *      reach a keyframe, which is the whole problem the cache exists to solve.
 *   3. **Nothing** — what happens today while a seek is in flight.
 *
 * `timeUs` is a *source* time (see `scrubTimeFor`), not a timeline one. The URL carries the
 * media id and the raw microsecond value; the protocol handler derives the file itself, so
 * the renderer never needs to know where the derived directory is — the same property that
 * keeps `clipwright-media://` a registry rather than a path.
 *
 * Quantising to the grid here rather than at the handler is deliberate: the renderer asks
 * for the same instant repeatedly as a pointer moves, and a URL that changes per microsecond
 * would miss the HTTP cache as well as the frame cache.
 */
export function scrubFrameUrl(
  mediaId: string | undefined,
  timeUs: number,
  gridUs: number,
): string | null {
  if (!mediaId) return null;
  if (!Number.isFinite(timeUs) || timeUs < 0) return null;
  const grid = Number.isFinite(gridUs) && gridUs > 0 ? gridUs : 1;
  const index = Math.floor(timeUs / grid);
  /*
    The first path segment of this scheme lands in the URL's *host*, not its path —
    `new URL('clipwright-media://scrub/m/0')` gives `host: 'scrub'` — which is why the
    existing media URLs read `://media/<id>` and why this one reads the same way. The parser
    below normalises across the two spellings rather than assuming either.
  */
  return `clipwright-media://scrub/${encodeURIComponent(mediaId)}/${index * grid}`;
}

/**
 * The media id and source time in a scrub URL, or `null` when it is not one.
 *
 * Parsed in main rather than trusted from the renderer, because the protocol handler turns
 * the answer into a filesystem path: a URL that could name an arbitrary path would let a
 * compromised renderer read the disk through its own media scheme. Only the `<id>/<timeUs>`
 * shape is accepted, and the id is still resolved through the media registry afterwards.
 */
export function parseScrubFrameUrl(url: string): { mediaId: string; timeUs: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'clipwright-media:') return null;
  /*
    Normalised across the two spellings of this scheme, because `new URL` puts the first
    path segment of a non-special scheme in the **host**: `clipwright-media://scrub/m/0`
    gives `host: 'scrub'` and `pathname: '/m/0'`, which is also why the existing media URLs
    read `://media/<id>`. A hand-written or re-serialised URL can put the same segment in
    the path instead, so both are flattened into one list of segments and the shape is
    checked once rather than twice.
  */
  const segments = [
    ...(parsed.host ? [parsed.host] : []),
    ...parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean),
  ];
  if (segments[0] !== 'scrub' || segments.length !== 3) return null;
  let mediaId: string;
  try {
    mediaId = decodeURIComponent(segments[1]!);
  } catch {
    // A malformed escape sequence throws, and a throw inside a protocol handler is a crashed
    // request rather than a 404.
    return null;
  }
  if (!mediaId) return null;
  const timeUs = Number(segments[2]);
  if (!Number.isFinite(timeUs) || timeUs < 0) return null;
  return { mediaId, timeUs };
}
