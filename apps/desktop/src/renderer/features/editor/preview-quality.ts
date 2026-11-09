/**
 * What the preview is actually playing, and what it owes the user for it (SPEC 10 §5.1).
 *
 * §5.1 asks for three things: an **Auto** render scale, a paused frame that always redraws at
 * Full, and a visible account of whether the preview is running on a proxy. The first two need a
 * render loop with a scale to change — this build draws DOM layers at each element's own
 * resolution, so there is no internal render scale to step down and a "Preview ½" chip would be
 * a control that does nothing. What *is* real is the third, and it is the one the spec is most
 * insistent about: *"a small chip … appears in the toolbar (never silent)"*, and the original
 * fallback gets *"the 'Preparing smoother preview…' chip"*.
 *
 * This module is the policy half of that: given a clip's media record and the user's setting,
 * which of the two files is being played, and what should be said about it. The drawing lives in
 * `PreviewPane`; keeping the decision here means the interesting cases — a proxy that was
 * planned but has not landed yet, a proxy that is gone from disk, a codec that will never get
 * one — can be tested without a DOM or a filesystem.
 */

/** The fields of a media record this policy reads (SPEC 04 §6.3, §7). */
export interface PreviewMediaLike {
  id?: string;
  kind?: 'video' | 'audio' | 'image' | string;
  /**
   * The preview proxy, when one exists.
   *
   * `undefined` and `null` are different answers in this codebase's records — absent means the
   * media predates proxies, `null` means `needsProxy` declined — and both mean "no proxy to
   * play" here, so the policy collapses them. The distinction is kept in the record because the
   * media pipeline cares about it; the preview does not.
   */
  proxyPath?: string | null;
  /** Whether the pipeline intends to make a proxy for this file (SPEC 04 §6.2). */
  needsProxy?: boolean;
  info?: {
    // Unused by the policy itself, but carried so a caller can pass a whole record.
    durationUs?: number;
  } | null;
}

/**
 * A background job, as far as this policy cares (SPEC 04 §6.2).
 *
 * Only the *proxy* job is interesting, and only while it is live: `media-pipeline` reports
 * "Preparing preview" at 86% of the import, and the record gains a `proxyPath` when it finishes.
 * Anything else — a probe, an export, a proxy job that already finished — says nothing about
 * whether the preview is playing a proxy right now.
 */
export interface PreviewJobLike {
  type?: string;
  mediaId?: string;
  status?: 'queued' | 'running' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'done' | string;
}

export interface PreviewQualityOptions {
  /** The user's `useProxyPreview` setting. Off means the original, always. */
  useProxies: boolean;
  /**
   * The project's background jobs, so "a proxy is being made" is a fact rather than a guess.
   *
   * Optional because the preview is also rendered without a job list, and the chip degrades to
   * silence rather than to an invented answer.
   */
  jobs?: readonly PreviewJobLike[];
}

/**
 * Whether a live proxy job is working on this media.
 *
 * `cancelled` and `failed` are *not* live: a proxy job that failed leaves `proxyPath` null
 * forever, and reporting "preparing" for it would promise a file that is never coming. That is
 * the one case where the honest answer is the same as "needs no proxy" — silence.
 */
function proxyInFlight(mediaId: string | undefined, jobs: readonly PreviewJobLike[] | undefined): boolean {
  if (!mediaId || !jobs) return false;
  return jobs.some(
    (job) =>
      job.type === 'proxy' &&
      job.mediaId === mediaId &&
      (job.status === 'queued' || job.status === 'running' || job.status === 'paused'),
  );
}

/**
 * Whether anything is still waiting on a proxy, and therefore whether the job list is worth
 * watching.
 *
 * This is the *poll* predicate, not the chip's: a job list only matters while a transcode is
 * outstanding, and an editor that polled for the life of the session would be a timer answering a
 * question nobody asked. It returns false as soon as every proxy exists — the moment the poll can
 * stop for good. `needsProxy` is what main already records; `proxyPath` is what eventually arrives.
 */
export function mediaAwaitingProxy(media: readonly PreviewMediaLike[] | undefined): boolean {
  if (!media) return false;
  return media.some((item) => item.needsProxy === true && !item.proxyPath);
}

/** Which file the preview plays, and why. */
export type PreviewSourceChoice =
  | { kind: 'proxy'; reason: 'proxy' }
  /**
   * The original, because the proxy has not been made yet — the case that earns the
   * "Preparing smoother preview…" chip. `pending` is false when no proxy is even planned
   * (an ordinary 1080p H.264 source, which `needsProxy` correctly declines), and true when one
   * is expected shortly.
   */
  | { kind: 'original'; reason: 'no-proxy' | 'proxy-pending' | 'proxies-off' | 'not-a-video' };

/**
 * Which file the preview should play for this clip.
 *
 * Deliberately does **not** check that the proxy exists on disk: main's protocol handler owns
 * that (it is the only side that can `stat`), and duplicating the check here would give two
 * answers to one question. What this decides is the *policy* — proxies off, not a video, proxy
 * planned but not ready — so the chip can say the right thing.
 */
export function previewSourceChoice(
  media: PreviewMediaLike | undefined,
  options: PreviewQualityOptions,
): PreviewSourceChoice {
  if (!media) return { kind: 'original', reason: 'not-a-video' };
  if (media.kind !== undefined && media.kind !== 'video') {
    /*
      Only video gets a proxy. An image has nothing to transcode, and an audio clip drawn in the
      preview is a waveform rather than a frame — saying "Preparing smoother preview…" over
      either would be a promise about a file that is never coming.
    */
    return { kind: 'original', reason: 'not-a-video' };
  }
  if (!options.useProxies) return { kind: 'original', reason: 'proxies-off' };
  if (media.proxyPath) return { kind: 'proxy', reason: 'proxy' };
  if (proxyInFlight(media.id, options.jobs)) return { kind: 'original', reason: 'proxy-pending' };
  return { kind: 'original', reason: 'no-proxy' };
}

/** A chip to show over the preview, or `null` for "say nothing". */
export interface PreviewQualityChip {
  /** What the chip says, in SPEC 10 §5.1's own words. */
  label: string;
  /**
   * Which of the two the chip is. `quality` is the "playing at less than full" notice; `info` is
   * the "something is still being prepared" notice. Separate because they read differently: one
   * is a statement about now, the other a promise about shortly.
   */
  tone: 'info' | 'quality';
  /** A longer explanation, for the chip's `title`. */
  detail: string;
}

/**
 * The chip §5.1 requires, or `null` when there is nothing to say.
 *
 * The rule the spec sets is **"never silent"**: a preview that is not showing the real image has
 * to say so. So every non-proxy answer gets a chip *except* the two where the original *is* the
 * right file — a clip that needs no proxy, and a still image — where a notice would be noise
 * about a non-event.
 */
export function previewQualityChip(
  media: PreviewMediaLike | undefined,
  options: PreviewQualityOptions,
): PreviewQualityChip | null {
  const choice = previewSourceChoice(media, options);
  switch (choice.reason) {
    case 'proxy':
      return null;
    case 'proxy-pending':
      return {
        label: 'Preparing smoother preview…',
        tone: 'info',
        detail: 'Editing from the original until the proxy is ready. It switches at the next play or seek.',
      };
    case 'proxies-off':
      return {
        label: 'Preview: original',
        tone: 'quality',
        detail: 'Proxy preview is switched off, so full-resolution files are played as they are.',
      };
    case 'no-proxy':
      /*
        A source that needs no proxy is not worth a notice — that is the common case and the
        chip would be permanent. It is worth one when the material is *heavy* and no proxy is
        planned, because that combination means the user is about to have a slow session and
        nothing is being done about it.

        Heaviness is not readable from the record here (no codec, no resolution), so the honest
        rule is the inverse of the one above: say nothing unless the caller has told us the media
        is still expecting a proxy. That is `proxy-pending`, handled above.
      */
      return null;
    case 'not-a-video':
    default:
      return null;
  }
}
