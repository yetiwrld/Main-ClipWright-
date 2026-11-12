/**
 * Time base: every duration and timestamp in Clipwright Studio is an integer
 * number of MICROSECONDS. Frames are derived from fps, never stored as the
 * primary unit.
 */
export type Microseconds = number;

export const US_PER_SECOND = 1_000_000;
export const US_PER_MS = 1_000;

export const usFromSeconds = (s: number): Microseconds => Math.round(s * US_PER_SECOND);
export const usFromMs = (ms: number): Microseconds => Math.round(ms * US_PER_MS);
export const secondsFromUs = (us: Microseconds): number => us / US_PER_SECOND;
export const msFromUs = (us: Microseconds): number => us / US_PER_MS;

/** Clamp an integer µs value into [min, max]. */
export const clampUs = (us: Microseconds, min: Microseconds, max: Microseconds): Microseconds =>
  Math.min(max, Math.max(min, Math.round(us)));

/** Convert µs to a frame index for a given fps (rounded to nearest frame). */
export const frameFromUs = (us: Microseconds, fps: number): number =>
  Math.round((us / US_PER_SECOND) * fps);

/** Convert a frame index to µs for a given fps. */
export const usFromFrame = (frame: number, fps: number): Microseconds =>
  Math.round((frame * US_PER_SECOND) / fps);

/** Format µs as HH:MM:SS:FF for a given fps (monospace, never for storage). */
export const formatTimecode = (us: Microseconds, fps: number): string => {
  const totalFrames = frameFromUs(Math.max(0, us), fps);
  const fr = totalFrames % Math.round(fps);
  const totalSeconds = Math.floor(totalFrames / Math.round(fps));
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(fr)}`;
};

/** Format µs as a short human duration, e.g. "1:23" or "1:02:03". */
export const formatDurationShort = (us: Microseconds): string => {
  const totalSeconds = Math.floor(Math.max(0, us) / US_PER_SECOND);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
};
