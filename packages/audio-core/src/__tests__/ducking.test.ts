/**
 * Auto-ducking (SPEC 12 §6.7).
 *
 * The feature was a schema-only object for the life of the project: six settings, validated on
 * load, read by nothing. So the tests here are about two things — that the envelope means what the
 * spec says, and that the preview and the export compute *the same* envelope, which is §6.7's
 * binding sentence ("used identically by preview automation and export mixer").
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKING_DEFAULTS,
  DUCKING_REDUCTION_RANGE,
  duckingGainAt,
  duckingSpans,
  resolveDucking,
  speechFromWords,
  type DuckingSettings,
} from '../ducking.js';

const settings = (overrides: Partial<DuckingSettings> = {}): DuckingSettings => ({
  ...DUCKING_DEFAULTS,
  enabled: true,
  ...overrides,
});

const SPEECH = [{ startUs: 1_000_000, endUs: 2_000_000, trackId: 'trk-voice' }];

describe('when a track ducks at all', () => {
  it('does nothing when the feature is off', () => {
    /*
      §6.7: "It is **off by default** and never applied silently." A field that defaults to on is
      a project where every music track dips under dialogue the user never asked it to.
    */
    const spans = duckingSpans({ settings: settings({ enabled: false }), items: [], speech: SPEECH });
    expect(spans).toEqual([]);
    expect(DUCKING_DEFAULTS.enabled).toBe(false);
  });

  it('ducks under every track when no trigger is named', () => {
    /* The spec's default reading: "Duck this track when [...] has speech" with nothing chosen. */
    const spans = duckingSpans({ settings: settings(), items: [], speech: SPEECH });
    expect(spans).toEqual([{ startUs: 1_000_000, endUs: 2_000_000 }]);
  });

  it('only ducks for speech on the tracks it names', () => {
    const spans = duckingSpans({
      settings: settings({ triggerTrackIds: ['trk-voice'] }),
      items: [],
      speech: [
        { startUs: 0, endUs: 500_000, trackId: 'trk-other' },
        { startUs: 1_000_000, endUs: 2_000_000, trackId: 'trk-voice' },
      ],
    });
    expect(spans).toEqual([{ startUs: 1_000_000, endUs: 2_000_000 }]);
  });

  it('ignores speech it cannot attribute when triggers are named', () => {
    /*
      A region with no `trackId` cannot be shown to come from a chosen trigger, so it is not one.
      The alternative — treating unknown as a match — means a bed ducks under a track the user
      explicitly excluded.
    */
    const spans = duckingSpans({
      settings: settings({ triggerTrackIds: ['trk-voice'] }),
      items: [],
      speech: [{ startUs: 0, endUs: 1_000_000 }],
    });
    expect(spans).toEqual([]);
  });

  it('does not duck when there is no speech', () => {
    expect(duckingSpans({ settings: settings(), items: [], speech: [] })).toEqual([]);
  });

  it('refuses a reduction of zero or a positive gain', () => {
    /*
      A "reduction" of 0 dB produces a span that multiplies by 1 — which every log, meter and
      assertion reads as ducking applied, while nothing is quieter. Refusing is honest.
    */
    expect(duckingSpans({ settings: settings({ reductionDb: 0 }), items: [], speech: SPEECH })).toEqual([]);
    expect(duckingSpans({ settings: settings({ reductionDb: 6 }), items: [], speech: SPEECH })).toEqual([]);
  });

  it('clamps a reduction outside the spec’s range', () => {
    /*
      −3…−24 is the spec's range. A hand-edited project carrying −40 would silence the track
      rather than duck it, and the control would still read as "a lot of ducking".
    */
    expect(DUCKING_REDUCTION_RANGE).toEqual({ min: -24, max: -3 });
    const deep = settings({ reductionDb: -40 });
    /*
      Asserted through `duckingGainAt`, which clamps independently — so this passes even if
      `duckingSpans` does not, which is exactly what a mutation showed. The gain at the instant is
      the one place both agree, and it is what the renderers read.
    */
    const deepSpans = duckingSpans({ settings: deep, items: [], speech: SPEECH });
    expect(duckingGainAt(deepSpans, 1_500_000, deep)).toBeCloseTo(Math.pow(10, -24 / 20), 6);
    /* A reduction inside the range is used as stored, at full depth. */
    const inside = settings({ reductionDb: -6 });
    expect(
      duckingGainAt(duckingSpans({ settings: inside, items: [], speech: SPEECH }), 1_500_000, inside),
    ).toBeCloseTo(Math.pow(10, -6 / 20), 6);
  });
});

describe('merging speech into holds', () => {
  it('merges regions a release apart, so the bed does not wobble between sentences', () => {
    /*
      Two sentences with a 100 ms pause: releasing and re-attacking inside 400 ms is audible as a
      pulse. The merge threshold is the release time for exactly this reason.
    */
    const spans = duckingSpans({
      settings: settings({ releaseMs: 400 }),
      items: [],
      speech: [
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 1_100_000, endUs: 2_000_000 },
      ],
    });
    expect(spans).toEqual([{ startUs: 0, endUs: 2_000_000 }]);
  });

  it('keeps regions apart when the pause is longer than the release', () => {
    const spans = duckingSpans({
      settings: settings({ releaseMs: 100 }),
      items: [],
      speech: [
        { startUs: 0, endUs: 1_000_000 },
        { startUs: 2_000_000, endUs: 3_000_000 },
      ],
    });
    expect(spans).toHaveLength(2);
  });

  it('accepts regions in any order and normalises an inverted one', () => {
    /* Speech detection has no reason to be sorted, and a region with end < start is a bug upstream
       that should not become a negative-length hold here. */
    const spans = duckingSpans({
      settings: settings({ releaseMs: 0 }),
      items: [],
      speech: [
        { startUs: 3_000_000, endUs: 4_000_000 },
        { startUs: 2_000_000, endUs: 1_000_000 },
      ],
    });
    expect(spans).toEqual([
      { startUs: 1_000_000, endUs: 2_000_000 },
      { startUs: 3_000_000, endUs: 4_000_000 },
    ]);
  });
});

describe('the gain at an instant', () => {
  const config = settings({ reductionDb: -12, attackMs: 120, releaseMs: 400 });
  const spans = [{ startUs: 1_000_000, endUs: 2_000_000 }];

  it('is unity well before the speech', () => {
    expect(duckingGainAt(spans, 0, config)).toBe(1);
  });

  it('reaches full depth for the whole held portion', () => {
    const floor = Math.pow(10, -12 / 20);
    expect(duckingGainAt(spans, 1_000_000, config)).toBeCloseTo(floor, 6);
    expect(duckingGainAt(spans, 1_500_000, config)).toBeCloseTo(floor, 6);
    expect(duckingGainAt(spans, 2_000_000, config)).toBeCloseTo(floor, 6);
  });

  it('ramps in across the attack and out across the release', () => {
    const floor = Math.pow(10, -12 / 20);
    /*
      Halfway through a 120 ms attack the gain is halfway from unity down to the floor — and the
      *direction* is the part worth pinning. A first version of this test only asserted "between
      the floor and one", which is true of a ramp that runs the wrong way and therefore of a duck
      that starts loud-quiet-loud instead of quietening. The closed form is given in full so the
      slope is fixed, not merely bounded.
    */
    const attacking = duckingGainAt(spans, 1_000_000 - 60_000, config);
    expect(attacking).toBeCloseTo(1 + (floor - 1) * 0.5, 6);
    /* Two instants, ordered: the attack gets deeper as it approaches the speech. */
    const early = duckingGainAt(spans, 1_000_000 - 100_000, config);
    const late = duckingGainAt(spans, 1_000_000 - 20_000, config);
    expect(late).toBeLessThan(early);
    expect(early).toBeLessThan(1);
    expect(late).toBeGreaterThan(floor);
    /* Halfway through the release it is halfway back. */
    expect(duckingGainAt(spans, 2_000_000 + 200_000, config)).toBeCloseTo(
      floor + (1 - floor) * 0.5,
      6,
    );
  });

  it('is unity once the release has finished', () => {
    expect(duckingGainAt(spans, 2_000_000 + 400_000 + 1, config)).toBe(1);
  });

  it('returns unity for no spans, so a caller needs no `enabled` check', () => {
    expect(duckingGainAt([], 1_500_000, config)).toBe(1);
  });
});

describe('speech from a transcript', () => {
  it('joins words into sentences, so the duck does not pulse between them', () => {
    /*
      The spec offers the transcript as an alternative to audio analysis. Words in a sentence are
      separated by tens of milliseconds; treating each gap as a release makes the music pulse.
    */
    const regions = speechFromWords([
      { startUs: 0, endUs: 200_000 },
      { startUs: 250_000, endUs: 500_000 },
      { startUs: 540_000, endUs: 800_000 },
      /* A real pause. */
      { startUs: 3_000_000, endUs: 3_300_000 },
    ]);
    expect(regions).toEqual([
      { startUs: 0, endUs: 800_000 },
      { startUs: 3_000_000, endUs: 3_300_000 },
    ]);
  });

  it('returns nothing for no words', () => {
    expect(speechFromWords([])).toEqual([]);
  });

  it('takes the gap as an option, because a slow speaker needs a longer one', () => {
    const words = [
      { startUs: 0, endUs: 100_000 },
      { startUs: 400_000, endUs: 500_000 },
    ];
    expect(speechFromWords(words, { gapMs: 100 })).toHaveLength(2);
    expect(speechFromWords(words, { gapMs: 500 })).toHaveLength(1);
  });
});

describe('resolving stored settings', () => {
  it('fills in every default for a track with none', () => {
    expect(resolveDucking(undefined)).toEqual(DUCKING_DEFAULTS);
  });

  it('fills only the missing fields', () => {
    const resolved = resolveDucking({ enabled: true, reductionDb: -18 });
    expect(resolved.enabled).toBe(true);
    expect(resolved.reductionDb).toBe(-18);
    expect(resolved.attackMs).toBe(DUCKING_DEFAULTS.attackMs);
  });

  it('treats a partial as complete, which is what a draft needs', () => {
    /* A track from an unsaved draft has not been through the parser, so its fields are partial. */
    expect(resolveDucking({}).enabled).toBe(false);
  });
});
