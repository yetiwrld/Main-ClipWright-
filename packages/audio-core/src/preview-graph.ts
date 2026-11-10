/**
 * What the preview should *play*, as data (SPEC 12 §6.2, §6.3).
 *
 * The preview has always played one `<video>` element. That is why an audio item on its own track
 * — a music bed, a voiceover take, anything from *Extract audio* — was silent in the editor and
 * present in the export, and why pan was applied by the mixer and never heard.
 *
 * This module answers the question the graph needs, and only that: **which items are audible,
 * from which media, over which span, at what gain and pan?** It does no Web Audio and holds no
 * nodes, so the answer is testable without an `AudioContext` — and, more importantly, it is
 * written against the same `GainEnvelopeInput` the exporter's mixer uses, so the two cannot
 * disagree about what a volume keyframe or a fade means.
 *
 * ## Three decisions that are not obvious
 *
 * 1. **A muted item is not a silent item.** A muted item is *not requested at all*; a silent
 *    one (a fade down to −∞) is requested with a zero gain curve. The difference is audible:
 *    the file's decoder still has to start at the right instant, and a graph that skipped a
 *    muted item and later unmuted it would be a node that does not exist. Both are cheaper than
 *    they sound, and conflating them is how a preview ends up out of sync after an unmute.
 * 2. **Solo is resolved here, once.** An item is silenced if another track is soloed and it is
 *    not on it — the same rule the mixer applies — so the two never disagree about which track
 *    a user can hear. Track mute and item mute fold into the same predicate.
 * 3. **A crossfade is not previewed as a crossfade.** The export re-times an incoming clip
 *    earlier so its half of an equal-power window has material to reveal (SPEC 12 §4.2). The
 *    preview drives elements whose `currentTime` follows the playhead, and the gain curve it
 *    applies already describes the fade — so the request keeps the item where the user put it
 *    and the *envelope* does the shaping. A preview that moved clips earlier would show the
 *    picture and the sound in two different places, which is worse than an imperfect crossfade.
 */
import { gainAt, type FadeCurve, type GainEnvelopeInput } from './envelope.js';
import { duckingSpans, resolveDucking, type DuckingSpan } from './ducking.js';

/** One audible item, as the graph should build it. */
export interface PreviewAudioRequest {
  itemId: string;
  /**
   * The track the item is on.
   *
   * The graph needs it to give each track a summing node, which is what the headers' per-track
   * meters read (SPEC 12 §6.3). Carried out of the plan rather than looked up by the caller,
   * because the caller would have to map a track id back to a timeline the plan was derived
   * from — the exact coupling the pure module exists to avoid.
   */
  trackId: string;
  mediaId: string;
  /**
   * Where the item sits on the timeline, which is also where its element's `currentTime` runs
   * from — the preview seeks the element rather than decoding a range.
   */
  startUs: number;
  durationUs: number;
  /** The source in-point, so the element is positioned at the right frame of the media. */
  sourceInUs: number;
  /** Gain envelope, evaluated by the same function the exporter uses. */
  envelope: GainEnvelopeInput;
  /** Pan, −1 hard left … +1 hard right. The project stores −100…+100. */
  pan: number;
  /** Whether the item is silenced by another track's solo, which the graph dims rather than drops. */
  silencedBySolo: boolean;
  /**
   * Where this item's track is auto-ducked (SPEC 12 §6.7), in timeline microseconds.
   *
   * Empty for a track with no ducking, which is almost all of them. The graph schedules the same
   * attack/release ramps on the *track's* node that the mixer computes per sample — the same
   * `duckingSpans`, so §6.7's "used identically by preview automation and export mixer" is a
   * property of the code rather than of two people agreeing.
   */
  ducking: readonly DuckingSpan[];
  /**
   * The ramps the spans above are shaped by.
   *
   * Carried alongside rather than looked up by the consumer: the spans and the ramps come from one
   * set of settings, and a caller that resolved them separately could pair a track's spans with
   * another track's attack time — a mismatch that would sound almost right.
   */
  duckingRamps: { reductionDb: number; attackMs: number; releaseMs: number };
}

/** The timeline facts this module needs. Structural, so no `TimelineState` import is required. */
export interface PreviewAudioTimeline {
  tracks: ReadonlyArray<{
    id: string;
    kind?: string;
    role?: string;
    hidden?: boolean;
    muted?: boolean;
    locked?: boolean;
    /**
     * Solo, as the *document* states it. Kept optional because a project written before the
     * field existed must read as "nothing soloed", not as "soloed".
     */
    solo?: boolean;
    volumeDb?: number;
    order?: number;
    /**
     * Auto-duck settings (SPEC 12 §6.7), as the schema stores them.
     *
     * Optional because a track written before the feature existed has none — and "none" has to
     * mean off, which is the spec's own default.
     */
    ducking?: {
      enabled?: boolean;
      triggerTrackIds?: readonly string[];
      reductionDb?: number;
      thresholdDb?: number;
      attackMs?: number;
      releaseMs?: number;
    };
  }>;
  items: Readonly<Record<string, {
    id: string;
    trackId: string;
    type: string;
    mediaId?: string;
    startUs: number;
    durationUs: number;
    sourceInUs?: number;
    sourceDurationUs?: number;
    volumeDb?: number;
    gainDb?: number;
    pan?: number;
    muted?: boolean;
    disabled?: boolean;
    fadeInUs?: number;
    fadeOutUs?: number;
    fadeCurve?: FadeCurve;
    /*
      `value` is `number | [number, number, number, number]` in the document schema, because the
      same keyframe tracks colour and vector properties. A volume track is numeric, but the type
      has to admit the tuple or the preview would have to cast a real project into shape — and a
      cast is exactly how a tuple reaches `gainFromDb` and produces NaN.
    */
    keyframes?: Readonly<Record<
      string,
      ReadonlyArray<{
        timeUs: number;
        value: number | readonly [number, number, number, number];
        interpolation?: string;
      }> | undefined
    >>;
  }>>;
}

/** Item types that carry their own audio. A caption or a shape has none. */
const AUDIBLE_TYPES = new Set(['video', 'audio']);

/**
 * The items the preview should play, in track order then start order.
 *
 * Order matters for the mixing graph's construction only in that a deterministic order makes a
 * test readable; the graph sums them, so any order is audible the same way.
 */
export function previewAudioRequests(timeline: PreviewAudioTimeline): PreviewAudioRequest[] {
  const tracks = new Map(timeline.tracks.map((track) => [track.id, track]));

  /*
    Speech regions for auto-ducking (SPEC 12 §6.7), derived from the *other* audible items on the
    timeline rather than from decoded audio.

    The spec offers two inputs: "the trigger tracks' post-gain signal ... or the transcript word
    ranges when available, for speech detection without audio analysis". The preview has neither a
    decode nor, usually, a transcript — but it does know where every other item sits, and an item
    on an audio-bearing track that is playing is exactly what the mixer treats as a cue. Using the
    same source means the preview's ducking and the file's ducking cover the same instants, which
    is the property that matters; an analysis-based version would be more accurate about *speech*
    and would disagree with the export, which is worse.
  */
  const audibleItems = Object.values(timeline.items).filter(
    (item) =>
      !item.muted &&
      !item.disabled &&
      (item.type === 'audio' || item.type === 'video') &&
      !(tracks.get(item.trackId)?.muted ?? false) &&
      !(tracks.get(item.trackId)?.hidden ?? false),
  );
  const duckingFor = (trackId: string): readonly DuckingSpan[] => {
    const track = tracks.get(trackId);
    if (!track?.ducking) return [];
    /*
      No `enabled` check here: `duckingSpans` returns nothing for a disabled track, and a second
      guard was redundant — a mutation deleting it changed no output. One check, in the module that
      owns the decision.
    */
    const settings = resolveDucking(track.ducking);
    const speech = audibleItems
      .filter((other) => other.trackId !== trackId)
      .map((other) => ({ startUs: other.startUs, endUs: other.startUs + other.durationUs, trackId: other.trackId }));
    return duckingSpans({ settings, items: [], speech });
  };
  /*
    One computation per track, not per item: a track with twelve items would otherwise walk the
    whole timeline twelve times to compute the same spans.
  */
  const duckingRampsFor = (trackId: string) => {
    const settings = resolveDucking(tracks.get(trackId)?.ducking);
    return {
      reductionDb: settings.reductionDb,
      attackMs: settings.attackMs,
      releaseMs: settings.releaseMs,
    };
  };
  const duckingByTrack = new Map<string, readonly DuckingSpan[]>();
  const duckingForTrack = (trackId: string): readonly DuckingSpan[] => {
    if (!duckingByTrack.has(trackId)) duckingByTrack.set(trackId, duckingFor(trackId));
    return duckingByTrack.get(trackId)!;
  };
  /*
    Solo is a document-wide question, so it is answered once. A hidden track is *not* soloed out
    of existence: hiding is a view concern, and the export honours mute while ignoring hide
    (SPEC 12 §6.2). Treating hide as silence here would make the preview disagree with the file
    in the direction a user is least likely to check.
  */
  const anySolo = timeline.tracks.some((track) => track.solo === true);

  const requests: PreviewAudioRequest[] = [];
  for (const item of Object.values(timeline.items)) {
    if (!AUDIBLE_TYPES.has(item.type)) continue;
    if (!item.mediaId) continue;
    /* A disabled item is one the user switched off, and the exporter drops it too. */
    if (item.disabled === true) continue;
    const track = tracks.get(item.trackId);
    if (!track) continue;

    const silencedBySolo = anySolo && track.solo !== true;
    /*
      A muted item or track is *not requested*. Its silence is not a curve to evaluate: there is
      nothing to play, and giving the graph a node that produces zero for the whole range would
      cost a decoder per muted clip for no audible difference.
    */
    if (item.muted === true || track.muted === true || silencedBySolo) continue;

    const envelope: GainEnvelopeInput = {
      startUs: item.startUs,
      durationUs: item.durationUs,
      /*
        Volume keyframes are stored local to the item, and `gainAt` evaluates against the same
        local times — unlike the mixer, which shifts them into mix time because it decodes a
        range. Nothing is shifted here, and that asymmetry is deliberate: it is the difference
        between "where the clip is in the file" and "where it is in the project".
      */
      ...(item.keyframes?.['volumeDb']
        ? {
            keyframes: item.keyframes['volumeDb']
              /*
                `Number.isFinite`, not `typeof === 'number'`. `typeof NaN` is `'number'`, so a
                NaN keyframe passes the loose check and then poisons the whole curve: every
                sample after it evaluates to NaN, and an `AudioParam` fed NaN goes silent for the
                rest of the clip with nothing in the console to explain it.
              */
              .filter(
                (
                  key,
                ): key is {
                  timeUs: number;
                  value: number;
                  interpolation?: string;
                } => typeof key.value === 'number' && Number.isFinite(key.value),
              )
              .map((key) => ({
                timeUs: key.timeUs,
                valueDb: key.value,
                ...(key.interpolation === 'hold' ||
                key.interpolation === 'linear' ||
                key.interpolation === 'bezier' ||
                key.interpolation === 'preset'
                  ? { interpolation: key.interpolation }
                  : {}),
              })),
          }
        : {}),
      ...(item.volumeDb === undefined ? {} : { volumeDb: item.volumeDb }),
      ...(item.gainDb === undefined ? {} : { gainDb: item.gainDb }),
      ...(track.volumeDb === undefined ? {} : { trackVolumeDb: track.volumeDb }),
      ...(item.fadeInUs === undefined ? {} : { fadeInUs: item.fadeInUs }),
      ...(item.fadeOutUs === undefined ? {} : { fadeOutUs: item.fadeOutUs }),
      ...(item.fadeCurve === undefined ? {} : { fadeCurve: item.fadeCurve }),
    };

    requests.push({
      itemId: item.id,
      trackId: item.trackId,
      mediaId: item.mediaId,
      startUs: item.startUs,
      durationUs: item.durationUs,
      sourceInUs: item.sourceInUs ?? 0,
      envelope,
      /*
        Pan is stored as a percentage and the graph wants −1…+1, divided once here — the same
        conversion `planAudioItems` performs for the mixer, so a value can never be read in two
        units by two modules.
      */
      pan: item.pan === undefined ? 0 : Math.max(-1, Math.min(1, item.pan / 100)),
      silencedBySolo: false,
      /*
        Computed from the *other* items, so an item on a ducked track never triggers its own
        reduction — which would be a track ducking under itself.
      */
      ducking: duckingForTrack(item.trackId),
      duckingRamps: duckingRampsFor(item.trackId),
    });
  }

  requests.sort((a, b) => {
    const orderOf = (trackId: string) => tracks.get(trackId)?.order ?? 0;
    const byTrack =
      orderOf(timeline.items[a.itemId]?.trackId ?? '') - orderOf(timeline.items[b.itemId]?.trackId ?? '');
    return byTrack !== 0 ? byTrack : a.startUs - b.startUs;
  });
  return requests;
}

/**
 * A request's gain curve for a span, as an array of 0…1 multipliers.
 *
 * Produced by the same `gainAt` the mixer evaluates per sample, so a fade curve and a volume
 * keyframe mean exactly the same thing in the preview as in the file. `points` is the number of
 * `AudioParam` samples; Web Audio interpolates linearly between them, which is why a beam of
 * points across a long clip is not the same as a step.
 */
export function gainCurveFor(request: PreviewAudioRequest, points: number): Float32Array {
  const count = Math.max(2, Math.floor(points));
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    /* Half-open: the last point sits just inside the item's end, never on it, because `gainAt`
       returns 0 at the end boundary and the final sample would snap to silence. */
    const timeUs = request.startUs + (request.durationUs * (index + 0.5)) / count;
    curve[index] = gainAt(request.envelope, Math.min(timeUs, request.startUs + request.durationUs - 1));
  }
  return curve;
}

/**
 * The envelope's value at one instant.
 *
 * This — not a curve — is what a running preview needs each frame: the gain is a function of
 * time, and a volume keyframe or a fade changes *within* a clip. The first version of the graph
 * asked `gainCurveFor(request, 1)` for this, which returns a one-point curve whose only entry is
 * evaluated at the clip's start: a constant. Fades and keyframed volume were therefore applied to
 * the first frame of each clip and never updated, which would have looked exactly like the
 * feature not working.
 *
 * Time is clamped into the item's own span, so a caller one microsecond past the end gets the
 * last audible value rather than the envelope's hard zero at the boundary.
 */
export function gainAtInstant(request: PreviewAudioRequest, timeUs: number): number {
  /*
    Only the **end** is clamped. Clamping the start too — pinning anything earlier to `startUs` —
    turned "this item has not begun yet" into "this item is playing at the clip's opening gain",
    which is a bed leaking into the seconds before it starts. `gainAt` already answers 0 outside
    the span; the clamp exists for the end boundary alone.
  */
  const clamped = Math.min(timeUs, request.startUs + request.durationUs - 1);
  return gainAt(request.envelope, clamped);
}

/** Whether any request overlaps an instant, for deciding whether the graph is worth running. */
export function hasAudioAt(requests: readonly PreviewAudioRequest[], timeUs: number): boolean {
  return requests.some(
    (request) => timeUs >= request.startUs && timeUs < request.startUs + request.durationUs,
  );
}
