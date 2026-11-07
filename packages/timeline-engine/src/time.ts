// Time utilities for the timeline (SPEC 09 §3, §7.2).
//
// Every time value in the timeline is an integer number of microseconds. Seconds
// never appear as floats: the only place a frame rate is divided out is here, and
// the result is rounded back onto the frame grid.

export type Fps = 30 | 60;

export const US_PER_SECOND = 1_000_000;

/** Microseconds in one frame at `fps` (rounded, as SPEC 09 §3 requires). */
export function frameToUs(frame: number, fps: Fps): number {
  return Math.round((frame * US_PER_SECOND) / fps);
}

/** Nearest frame index for a time. */
export function usToFrame(us: number, fps: Fps): number {
  return Math.round((us * fps) / US_PER_SECOND);
}

/** One frame in µs — the minimum item duration and the quantisation grid. */
export function frameDurationUs(fps: Fps): number {
  return frameToUs(1, fps);
}

/** Snap any time onto the project frame grid, never below zero. */
export function quantizeUs(us: number, fps: Fps): number {
  if (!Number.isFinite(us)) return 0;
  return Math.max(0, frameToUs(usToFrame(us, fps), fps));
}

/** Round a duration up to a whole number of frames, at least one frame. */
export function quantizeDurationUs(us: number, fps: Fps): number {
  const frames = Math.max(1, Math.ceil((us * fps) / US_PER_SECOND));
  return frameToUs(frames, fps);
}

export function clampUs(us: number, minUs: number, maxUs: number): number {
  return Math.min(Math.max(us, minUs), maxUs);
}

function pad(value: number, width = 2): string {
  return String(Math.max(0, Math.trunc(value))).padStart(width, '0');
}

/** `HH:MM:SS:FF` — frames, zero padded, no drop-frame (SPEC 09 §3). */
export function formatTimecode(us: number, fps: Fps): string {
  const totalFrames = Math.max(0, usToFrame(us, fps));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * Parse the entry formats listed in SPEC 09 §7.2:
 * `HH:MM:SS:FF`, `MM:SS`, bare seconds (`90`), digits-only (`130` = 1 s 30 f)
 * and relative frames (`+30` / `-12`, returned as a delta).
 */
export function parseTimecode(
  text: string,
  fps: Fps,
  currentUs = 0,
): { us: number; relative: boolean } | null {
  const raw = text.trim();
  if (!raw) return null;

  const relative = raw.startsWith('+') || raw.startsWith('-');
  if (relative) {
    const frames = Number(raw.slice(1));
    if (!Number.isFinite(frames) || frames < 0) return null;
    const sign = raw.startsWith('-') ? -1 : 1;
    return { us: Math.max(0, currentUs + sign * frameToUs(Math.round(frames), fps)), relative: true };
  }

  const parts = raw.split(':');
  if (parts.length > 4) return null;
  if (!parts.every((part) => part === '' || /^\d+(\.\d+)?$/.test(part))) return null;

  const nums = parts.map((part) => (part === '' ? 0 : Number(part)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (parts.length === 1) {
    const value = nums[0] as number;
    // No separators: `130` means 1 s 30 f in the usual editing convention.
    if (Number.isInteger(value) && value >= 100 && !raw.includes('.')) {
      const digits = raw;
      const frames = Number(digits.slice(-2));
      const seconds = Number(digits.slice(-4, -2) || 0);
      const minutes = Number(digits.slice(0, -4) || 0);
      // Frame counts at or past the rate roll into seconds, like every NLE.
      return {
        us: frameToUs(minutes * 60 * fps + seconds * fps + frames, fps),
        relative: false,
      };
    }
    return { us: frameToUs(Math.round(value * fps), fps), relative: false };
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let frames = 0;
  if (parts.length === 4) {
    [hours, minutes, seconds, frames] = nums as [number, number, number, number];
  } else if (parts.length === 3) {
    [minutes, seconds, frames] = nums as [number, number, number];
  } else {
    [minutes, seconds] = nums as [number, number];
  }

  if (frames >= fps || seconds >= 60 || minutes >= 60) return null;
  const totalFrames = Math.round((hours * 3600 + minutes * 60 + seconds) * fps) + Math.round(frames);
  return { us: frameToUs(totalFrames, fps), relative: false };
}
