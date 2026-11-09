/**
 * SPEC 09 §19 — Waveforms and thumbnails on the timeline.
 *
 * Fetches audio peak data and thumbnail images from the main process over
 * IPC, with a per-media cache so the same peaks are not re-read on every
 * render. The hook returns the raw peak arrays (min/max pairs per sample
 * window) and a base64 thumbnail data URL.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PeakData {
  min: number[];
  max: number[];
}

export interface PeaksResult {
  peaks256: PeakData;
  peaks4096: PeakData;
}

export interface ThumbnailResult {
  data: string;
  mime: string;
}

/** Minimal type for the clipwright bridge exposed by the preload script. */
interface ClipwrightBridge {
  getPeaks: (mediaId: string) => Promise<PeaksResult>;
  getThumbnail: (mediaId: string, timeUs: number) => Promise<ThumbnailResult | null>;
}

function getBridge(): ClipwrightBridge | undefined {
  return (window as unknown as { clipwright?: ClipwrightBridge }).clipwright;
}

/**
 * Loads and caches peaks for a given media ID. Re-fetches when the media ID
 * changes. Returns null while loading or when peaks are unavailable.
 */
export function useMediaPeaks(mediaId: string | undefined): PeaksResult | null {
  const [peaks, setPeaks] = useState<PeaksResult | null>(null);
  const cacheRef = useRef<Map<string, PeaksResult>>(new Map());

  const load = useCallback(async () => {
    if (!mediaId) {
      setPeaks(null);
      return;
    }
    const cached = cacheRef.current.get(mediaId);
    if (cached) {
      setPeaks(cached);
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    try {
      const result = await bridge.getPeaks(mediaId);
      cacheRef.current.set(mediaId, result);
      setPeaks(result);
    } catch {
      // Peaks unavailable (e.g. media has no audio) — leave as null.
    }
  }, [mediaId]);

  useEffect(() => {
    load();
  }, [load]);

  return peaks;
}

/**
 * Loads a single thumbnail for a media item at the given source time.
 * Returns a data URL suitable for use as an <img src>, or null while
 * loading or when the thumbnail is unavailable.
 */
export function useMediaThumbnail(
  mediaId: string | undefined,
  timeUs: number,
): string | null {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!mediaId) {
      setThumbUrl(null);
      return;
    }
    const cacheKey = `${mediaId}:${timeUs}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setThumbUrl(cached);
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge
      .getThumbnail(mediaId, timeUs)
      .then((result) => {
        if (cancelled || !result) return;
        const url = `data:${result.mime};base64,${result.data}`;
        cacheRef.current.set(cacheKey, url);
        setThumbUrl(url);
      })
      .catch(() => {
        // Thumbnail unavailable — leave as null.
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, timeUs]);

  return thumbUrl;
}

/**
 * Loads one frame per filmstrip tile (SPEC 09 §19), from the scrub cache.
 *
 * The strip used to tile a single poster, so every tile showed the same frame and the
 * strip could not tell a user where a cut lands — the one thing it is for. Each tile now
 * asks for the frame at its own centre time.
 *
 * Requests are made only for tiles that are actually drawn: a ten-minute clip at a
 * narrow zoom is thousands of tiles, and asking for all of them would be thousands of
 * extractions for frames off screen. Tiles already loaded are never re-requested, and a
 * failed one is left to be retried only if the strip is re-measured, because a retry loop
 * on a file that cannot produce frames would spin forever.
 */
export function useFilmstripFrames(
  mediaId: string | undefined,
  sourceInUs: number,
  sourceDurationUs: number,
  width: number,
  height: number,
  tileCount: number,
): (HTMLImageElement | null)[] {
  const cacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  /** Keys that returned nothing: not retried, or a broken file spins forever. */
  const failedRef = useRef<Set<string>>(new Set());
  /**
   * Keys with a request in flight.
   *
   * Separate from `failedRef` on purpose: marking a key failed before its request
   * returns would make a frame that is merely slow look permanently unavailable, and the
   * strip would keep that hole until the component remounted.
   */
  const inFlightRef = useRef<Set<string>>(new Set());
  const [, bump] = useState(0);

  useEffect(() => {
    if (!mediaId || tileCount <= 0 || width <= 0) return;
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;

    const tileWidth = height * (16 / 9);
    for (let tile = 0; tile < tileCount; tile += 1) {
      /*
        The tile's *centre* time, which is the time the frame represents: at the left edge
        the tile would show the frame before the cut and at the right the one after.
      */
      const centreFraction = Math.min(1, ((tile + 0.5) * tileWidth) / width);
      const timeUs = Math.round(sourceInUs + centreFraction * sourceDurationUs);
      const key = `${mediaId}:${timeUs}`;
      if (cacheRef.current.has(key) || failedRef.current.has(key) || inFlightRef.current.has(key)) {
        continue;
      }
      // Claimed before the await, so a re-render mid-flight does not request it twice.
      inFlightRef.current.add(key);
      bridge
        .getThumbnail(mediaId, timeUs)
        .then((result) => {
          if (cancelled) return;
          if (!result) {
            failedRef.current.add(key);
            return;
          }
          const img = new Image();
          img.onload = () => {
            inFlightRef.current.delete(key);
            if (cancelled) return;
            cacheRef.current.set(key, img);
            bump((value) => value + 1);
          };
          img.src = `data:${result.mime};base64,${result.data}`;
        })
        .catch(() => {
          failedRef.current.add(key);
        })
        .finally(() => {
          inFlightRef.current.delete(key);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [mediaId, sourceInUs, sourceDurationUs, width, height, tileCount]);

  const tileWidth = height * (16 / 9);
  const frames: (HTMLImageElement | null)[] = [];
  for (let tile = 0; tile < Math.max(0, tileCount); tile += 1) {
    const centreFraction = Math.min(1, ((tile + 0.5) * tileWidth) / Math.max(1, width));
    const timeUs = Math.round(sourceInUs + centreFraction * sourceDurationUs);
    frames.push(cacheRef.current.get(`${mediaId}:${timeUs}`) ?? null);
  }
  return frames;
}

/**
 * Draws waveform peaks onto a canvas context. The peaks are drawn as
 * vertical bars (min/max pairs) clipped to the canvas width. Uses the
 * 256-resolution peaks when zoomed out and 4096 when zoomed in.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  peaks: PeakData,
  width: number,
  height: number,
  color: string,
): void {
  if (peaks.min.length === 0) return;
  ctx.save();
  ctx.fillStyle = color;
  const midY = height / 2;
  const step = width / peaks.min.length;
  for (let i = 0; i < peaks.min.length; i++) {
    const x = i * step;
    const minVal = peaks.min[i] ?? 0;
    const maxVal = peaks.max[i] ?? 0;
    // Map [-1, 1] to [height, 0] (top = high value).
    const yMin = midY - (maxVal * midY);
    const yMax = midY - (minVal * midY);
    ctx.fillRect(x, yMin, Math.max(1, step), Math.max(1, yMax - yMin));
  }
  ctx.restore();
}

/**
 * Chooses which peak resolution to use based on pixels-per-second.
 * Below 50 px/s the 256-resolution peaks are sufficient; above that the
 * 4096-resolution peaks give a smoother waveform.
 */
export function selectPeakResolution(pxPerSecond: number): '256' | '4096' {
  return pxPerSecond < 50 ? '256' : '4096';
}

/**
 * Draws a thumbnail image onto a canvas context, tiled across the given
 * width. Each tile is drawn at the source time of the tile's centre.
 * The thumbnail data URL is repeated across the clip width as a
 * filmstrip; when per-time thumbnails are generated, the hook can be
 * extended to fetch them on demand.
 */
/** How many tiles a strip of this width holds at this height. */
export function filmstripTileCount(width: number, height: number): number {
  const tileWidth = height * (16 / 9);
  return Math.max(1, Math.ceil(width / tileWidth));
}

/**
 * Draws a filmstrip, one image per tile (SPEC 09 §19's "one per filmstrip tile, at the
 * source time of the tile's centre").
 *
 * `imageAt` is asked per tile rather than a single poster being repeated, because a strip
 * of the same frame tiled across a ten-second clip tells the user nothing about where a
 * cut lands — which is the only reason a filmstrip exists. Tiles whose image is missing
 * or not loaded are skipped, leaving the clip colour underneath: a strip that fills in
 * progressively is better than one that waits for its slowest frame.
 */
export function drawFilmstripTiles(
  ctx: CanvasRenderingContext2D,
  imageAt: (tile: number) => HTMLImageElement | null,
  width: number,
  height: number,
): void {
  const tileWidth = height * (16 / 9);
  let x = 0;
  let tile = 0;
  while (x < width) {
    const drawWidth = Math.min(tileWidth, width - x);
    const img = imageAt(tile);
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x, 0, drawWidth, height);
    }
    x += tileWidth;
    tile += 1;
  }
}
