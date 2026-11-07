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
