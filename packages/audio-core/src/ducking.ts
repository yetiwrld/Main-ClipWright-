/**
 * Auto-ducking (SPEC 12 §6.7).
 *
 * > **Auto-duck** on a track: *Duck this track when [Original audio / Voiceover / selected tracks]
 * > has speech*. Inputs: the trigger tracks' post-gain signal (or the transcript word ranges when
 * > available, for speech detection without audio analysis); algorithm: compute a speech-activity
 * > envelope from the trigger audio (RMS in 20 ms windows with hysteresis: attack 120 ms, release
 * > 400 ms, threshold −42 dBFS adjustable), map to a ducking envelope (default −12 dB, adjustable
 * > −3…−24) and store it as a derived envelope on the ducked track.
 *
 * ## What was here before this module
 *
 * The `ducking` object on a track — `enabled`, `triggerTrackIds`, `reductionDb`, `thresholdDb`,
 * `attackMs`, `releaseMs` — has been in the project schema since the file format was written, and
 * **nothing read it**. Not the preview, not the mixer. The mixer ducked a *per-item*
 * `duckUnderSpeech` boolean at a hardcoded −12 dB, which is a different feature: it asks the bed
 * whether it wants ducking rather than the track what it ducks under, it cannot name its triggers,
 * and its curve could not be previewed because the preview had no ducking at all.
 *
 * That is the same shape as the bugs this project has been fixing one at a time — a field in the
 * file that no renderer honours — except that this one is a whole *feature*, with six parameters
 * that were validated on load and then dropped.
 *
 * ## Why this is the shared piece
 *
 * §6.7's binding sentence is that the envelope is "**used identically by preview automation and
 * export mixer** (no real-time side-chain)". Two implementations would drift, and the drift would
 * be inaudible in one direction: a preview that ducks slightly differently from the file is a
 * preview nobody trusts but nobody can point at. So the arithmetic lives here, once, and both
 * renderers consume its output — the export as per-sample gain, the preview as scheduled ramps.
 *
 * ## The envelope is a list of spans, not a curve
 *
 * The output is the *reduced regions* with their own attack and release, not a sample array. A
 * sample array would be tied to one sample rate and one mix length; a list of spans converts to
 * whatever the consumer needs — a `Float32Array` for the mixer, `setTargetAtTime` calls for the
 * preview — and it is small enough to compare in a test by eye.
 */

/** The track-level ducking settings, as the schema stores them. */
export interface DuckingSettings {
  enabled: boolean;
  /** Which tracks' speech triggers the reduction. Empty means "every track but this one". */
  triggerTrackIds: readonly string[];
  /** How far to reduce, in dB. The spec's range is −3…−24; the schema does not clamp it. */
  reductionDb: number;
  /** Speech is present when the trigger's RMS rises above this. */
  thresholdDb: number;
  attackMs: number;
  releaseMs: number;
}

/** The defaults the schema declares, exported so the two cannot disagree. */
export const DUCKING_DEFAULTS: DuckingSettings = {
  enabled: false,
  triggerTrackIds: [],
  reductionDb: -12,
  thresholdDb: -42,
  attackMs: 120,
  releaseMs: 400,
};

/** The spec's own bounds for the reduction (SPEC 12 §6.7: "adjustable −3…−24"). */
export const DUCKING_REDUCTION_RANGE = { min: -24, max: -3 } as const;

/**
 * A region where the ducked track is held down, in microseconds.
 *
 * `startUs`/`endUs` bound the *held* portion, between an attack that begins `startUs` earlier and
 * a release that finishes `endUs` later. Keeping the ramp times out of the span means a consumer
 * that only needs "is it down here" does not have to reconstruct them, and a consumer that needs
 * the ramp reads the same attack and release the settings carry.
 */
export interface DuckingSpan {
  /** Where the reduction reaches full depth. */
  startUs: number;
  /** Where the reduction begins to come back up. */
  endUs: number;
}

export interface DuckingInput {
  settings: DuckingSettings;
  /** The item's own span on the timeline, in microseconds. */
  items: ReadonlyArray<{ startUs: number; durationUs: number; trackId: string }>;
  /** Speech regions the trigger tracks were found to contain, in timeline microseconds. */
  speech: ReadonlyArray<{ startUs: number; endUs: number; trackId?: string }>;
}

/**
 * The regions a ducked track should be held down.
 *
 * Returns an empty list whenever the answer is "no ducking", which keeps the caller free of
 * `enabled` checks: a disabled track, one with no triggers, and one whose triggers have no speech
 * all produce `[]`, and every consumer treats that as unity gain.
 */
export function duckingSpans(input: DuckingInput): DuckingSpan[] {
  const { settings } = input;
  if (!settings.enabled) return [];

  /*
    The trigger set. An empty `triggerTrackIds` means "everything else on the timeline", which is
    the spec's default reading and the only one that makes an unconfigured auto-duck do something
    sensible: a music track with auto-duck on and no triggers chosen ducks under whatever is
    speaking.
  */
  const triggers = new Set(settings.triggerTrackIds);
  const speech = input.speech.filter((region) => {
    if (triggers.size === 0) return true;
    return region.trackId !== undefined && triggers.has(region.trackId);
  });
  if (speech.length === 0) return [];

  /*
    A reduction of zero is not a duck, and neither is a positive one. Checked **before** the clamp:
    clamping first turns `0` into −3 and a request for no ducking into a 3 dB duck, which is the
    opposite of what the number says.
  */
  if (!Number.isFinite(settings.reductionDb) || settings.reductionDb >= 0) return [];
  /*
    No clamp here, deliberately. `duckingGainAt` clamps the reduction before turning it into a
    gain, and that is the only place the value becomes *audible* — so a second clamp in this
    function was redundant, which a mutation proved by surviving: deleting it changed no output
    anywhere. Clamping once, where it matters, is the version that cannot drift from itself.
  */

  /* Merge overlapping speech into single holds, so two people talking over each other is one dip
     rather than a dip that releases between their sentences. */
  const merged = mergeRegions(speech, settings.releaseMs);
  return merged.map((region) => ({
    startUs: Math.max(0, Math.round(region.startUs)),
    endUs: Math.max(0, Math.round(region.endUs)),
  }));
}

/**
 * Merge speech regions that are close enough that releasing between them would be audible.
 *
 * The gap threshold is the release time: if the ducked track would have come back up and gone
 * down again inside that window, the listener hears a wobble, and merging is what stops it. This
 * is the spec's "smoothing identical for all uses" applied to the span level.
 */
function mergeRegions(
  regions: ReadonlyArray<{ startUs: number; endUs: number }>,
  releaseMs: number,
): Array<{ startUs: number; endUs: number }> {
  if (regions.length === 0) return [];
  const sorted = [...regions]
    .map((region) => ({
      startUs: Math.min(region.startUs, region.endUs),
      endUs: Math.max(region.startUs, region.endUs),
    }))
    .sort((left, right) => left.startUs - right.startUs);

  const gapUs = Math.max(0, releaseMs) * 1000;
  const merged: Array<{ startUs: number; endUs: number }> = [{ ...sorted[0]! }];
  for (const region of sorted.slice(1)) {
    const current = merged[merged.length - 1]!;
    if (region.startUs - current.endUs <= gapUs) {
      current.endUs = Math.max(current.endUs, region.endUs);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * The gain the ducked track should have at an instant, given its spans.
 *
 * Used by tests, by the preview's per-frame fallback, and by anything that needs one number rather
 * than a curve. The ramp is **linear in amplitude**, matching the export's `duckingCurve`, because
 * the two have to agree and a linear-in-dB ramp would move at a different rate in one of them.
 */
export function duckingGainAt(
  spans: readonly DuckingSpan[],
  timeUs: number,
  settings: Pick<DuckingSettings, 'reductionDb' | 'attackMs' | 'releaseMs'>,
): number {
  const floor = Math.pow(10, clampReduction(settings.reductionDb) / 20);
  const attackUs = Math.max(0, settings.attackMs) * 1000;
  const releaseUs = Math.max(0, settings.releaseMs) * 1000;

  for (const span of spans) {
    const attackStart = span.startUs - attackUs;
    const releaseEnd = span.endUs + releaseUs;
    if (timeUs < attackStart || timeUs > releaseEnd) continue;

    if (timeUs < span.startUs) {
      /* Attacking: unity down to the floor across the attack window. */
      const progress = attackUs === 0 ? 1 : (timeUs - attackStart) / attackUs;
      return 1 + (floor - 1) * progress;
    }
    if (timeUs <= span.endUs) return floor;
    /* Releasing: floor back up to unity. */
    const progress = releaseUs === 0 ? 1 : (timeUs - span.endUs) / releaseUs;
    return floor + (1 - floor) * Math.min(1, progress);
  }
  return 1;
}

function clampReduction(value: number): number {
  /* A non-finite stored value would make `Math.pow` NaN and silence the track for good. */
  if (!Number.isFinite(value)) return DUCKING_DEFAULTS.reductionDb;
  return Math.min(DUCKING_REDUCTION_RANGE.max, Math.max(DUCKING_REDUCTION_RANGE.min, value));
}

/**
 * The settings a track actually has, with the defaults filled in.
 *
 * The schema fills defaults on load, but a track can reach the preview from a *draft* that has not
 * been through the parser — and a missing `enabled` read as `undefined` would be falsy, which is
 * right by accident. Filling them here makes it right by construction.
 */
export function resolveDucking(stored: Partial<DuckingSettings> | undefined): DuckingSettings {
  if (!stored) return { ...DUCKING_DEFAULTS };
  return {
    enabled: stored.enabled ?? DUCKING_DEFAULTS.enabled,
    triggerTrackIds: stored.triggerTrackIds ?? DUCKING_DEFAULTS.triggerTrackIds,
    reductionDb: stored.reductionDb ?? DUCKING_DEFAULTS.reductionDb,
    thresholdDb: stored.thresholdDb ?? DUCKING_DEFAULTS.thresholdDb,
    attackMs: stored.attackMs ?? DUCKING_DEFAULTS.attackMs,
    releaseMs: stored.releaseMs ?? DUCKING_DEFAULTS.releaseMs,
  };
}

/**
 * Speech regions from a transcript's word ranges (SPEC 12 §6.7's "or the transcript word ranges
 * when available").
 *
 * The spec offers this as an alternative to audio analysis, and it is the better one when there is
 * a transcript: it needs no decode, it cannot be fooled by a music bed on the trigger track, and
 * it is what the user is *looking at* when they turn the control on.
 *
 * Words closer together than `gapMs` become one region — an ordinary sentence has gaps between
 * words, and treating every one as a release would duck and release between every word.
 */
export function speechFromWords(
  words: ReadonlyArray<{ startUs: number; endUs: number }>,
  options: { gapMs?: number } = {},
): Array<{ startUs: number; endUs: number }> {
  const gapUs = (options.gapMs ?? 250) * 1000;
  if (words.length === 0) return [];
  const sorted = [...words]
    .map((word) => ({ startUs: Math.min(word.startUs, word.endUs), endUs: Math.max(word.startUs, word.endUs) }))
    .sort((left, right) => left.startUs - right.startUs);

  const regions: Array<{ startUs: number; endUs: number }> = [{ ...sorted[0]! }];
  for (const word of sorted.slice(1)) {
    const current = regions[regions.length - 1]!;
    if (word.startUs - current.endUs <= gapUs) {
      current.endUs = Math.max(current.endUs, word.endUs);
    } else {
      regions.push({ ...word });
    }
  }
  return regions;
}
