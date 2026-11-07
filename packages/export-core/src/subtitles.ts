/**
 * SPEC 14 §4.4 / §7 check 18 — Subtitle sidecar file generation.
 *
 * Generates SRT and WebVTT files from caption items on the timeline.
 * Caption items have segments with word-level timing.
 */

/** A caption segment with timing. */
export interface CaptionCue {
  /** Start time in microseconds. */
  startUs: number;
  /** End time in microseconds. */
  endUs: number;
  /** Text content. */
  text: string;
}

/** Format microseconds as SRT timestamp: HH:MM:SS,mmm */
export function formatSrtTimestamp(us: number): string {
  const totalMs = Math.floor(us / 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/** Format microseconds as WebVTT timestamp: HH:MM:SS.mmm */
export function formatVttTimestamp(us: number): string {
  return formatSrtTimestamp(us).replace(',', '.');
}

/** Generate an SRT file from caption cues. */
export function generateSrt(cues: CaptionCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startUs - b.startUs);
  return sorted
    .map((cue, index) => {
      return `${index + 1}\n${formatSrtTimestamp(cue.startUs)} --> ${formatSrtTimestamp(cue.endUs)}\n${cue.text}\n`;
    })
    .join('\n');
}

/** Generate a WebVTT file from caption cues. */
export function generateVtt(cues: CaptionCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startUs - b.startUs);
  const body = sorted
    .map((cue) => {
      return `${formatVttTimestamp(cue.startUs)} --> ${formatVttTimestamp(cue.endUs)}\n${cue.text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** Generate subtitle content in the requested format. */
export function generateSubtitles(
  cues: CaptionCue[],
  format: 'srt' | 'vtt',
): string {
  return format === 'srt' ? generateSrt(cues) : generateVtt(cues);
}

/** Extract caption cues from timeline items. */
export function extractCuesFromItems(
  items: Array<{
    id: string;
    type: string;
    startUs: number;
    durationUs: number;
    captionSegment?: { text: string };
  }>,
): CaptionCue[] {
  return items
    .filter((item) => item.type === 'caption' && item.captionSegment)
    .map((item) => ({
      startUs: item.startUs,
      endUs: item.startUs + item.durationUs,
      text: item.captionSegment!.text,
    }));
}
