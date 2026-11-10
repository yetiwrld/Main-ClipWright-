/**
 * The preview's audio plan (SPEC 12 §6.2).
 *
 * Every case here is a way the preview could disagree with the export about what the user hears.
 * That is the failure mode this module exists to prevent — the project spent several slices with
 * a preview that played one element and a mixer that honoured gain, pan and fades, so the two
 * described different mixes and only one of them was in the file.
 *
 * The decisions worth reading twice:
 *
 * - **A muted item is not requested; a silent one is.** Muted means "do not play", so there is
 *   nothing for a graph to do. Conflating the two produces a node that does not exist when the
 *   user unmutes.
 * - **Solo is resolved once, across the document.** The rule is the mixer's: any track soloed
 *   means every other track is silent.
 * - **A keyframe is not shifted.** The mixer shifts keyframe times into mix time because it
 *   decodes a range; the preview drives elements at their own positions, so local is correct
 *   here. Getting this backwards would move every volume line by the clip's start.
 */
import { describe, expect, it } from 'vitest';
import {
  gainAtInstant,
  gainCurveFor,
  hasAudioAt,
  previewAudioRequests,
  type PreviewAudioTimeline,
} from '../preview-graph.js';

const track = (id: string, overrides: Partial<PreviewAudioTimeline['tracks'][number]> = {}) => ({
  id,
  kind: 'audio',
  order: 0,
  ...overrides,
});

const item = (
  id: string,
  overrides: Partial<PreviewAudioTimeline['items'][string]> = {},
): PreviewAudioTimeline['items'][string] => ({
  id,
  trackId: 'audio-1',
  type: 'audio',
  mediaId: `media-${id}`,
  startUs: 0,
  durationUs: 4_000_000,
  ...overrides,
});

const timeline = (
  items: PreviewAudioTimeline['items'],
  tracks: PreviewAudioTimeline['tracks'] = [track('audio-1')],
): PreviewAudioTimeline => ({ tracks, items });

describe('which items the preview plays', () => {
  it('plays an audio item on its own track', () => {
    /*
      The headline fix. Before this, sound came only from the one `<video>` element the preview
      drove, so a music bed was silent in the editor and present in the export — a difference
      the user discovers by exporting.
    */
    const requests = previewAudioRequests(timeline({ a: item('a') }));
    expect(requests.map((request) => request.mediaId)).toEqual(['media-a']);
  });

  it('plays a video item’s own audio', () => {
    // A video with sound is the ordinary case, and it must not be lost when the graph takes over
    // from the single `<video>` element.
    const requests = previewAudioRequests(
      timeline({ v: item('v', { type: 'video' }) }, [track('audio-1', { kind: 'video' })]),
    );
    expect(requests).toHaveLength(1);
  });

  it('ignores items with no audio of their own', () => {
    /*
      A caption, a shape, a title. These usually carry no `mediaId` either, but the type check is
      the one that matters: a caption that somehow named a media id still has no audio to play,
      and a test fixture without one would pass against a type check that did not exist.
    */
    const requests = previewAudioRequests(
      timeline({
        c: item('c', { type: 'caption' }),
        t: item('t', { type: 'text' }),
        s: item('s', { type: 'shape' }),
      }),
    );
    expect(requests).toEqual([]);
  });

  it('ignores an item with no media', () => {
    // A colour intro is a `video` item with no source; it is the canvas, not a file.
    expect(previewAudioRequests(timeline({ a: item('a', { mediaId: undefined }) }))).toEqual([]);
  });

  it('ignores a disabled item, as the exporter does', () => {
    // Disabling is how a user switches a clip off without deleting it (SPEC 09 §9). A preview
    // that kept playing it would contradict the timeline's own eye-off chip.
    expect(previewAudioRequests(timeline({ a: item('a', { disabled: true }) }))).toEqual([]);
  });

  it('does not play across a hidden track', () => {
    /*
      Hiding is a *view* concern and the export ignores it (SPEC 12 §6.2 — the export honours
      mute). So a hidden track still plays, and this test exists to pin the surprising answer
      rather than the intuitive one.
    */
    const requests = previewAudioRequests(
      timeline({ a: item('a') }, [track('audio-1', { hidden: true })]),
    );
    expect(requests).toHaveLength(1);
  });
});

describe('mute and solo, resolved the way the mixer resolves them', () => {
  it('does not request a muted item at all', () => {
    /*
      Muted is "do not play", not "play at zero". A zero-gain node still needs a decoder and a
      buffer position, and a graph that built it would be paying for silence — but the real
      reason is that "not requested" is a different fact from "requested but silent", and the
      two get conflated at exactly the moment someone unmutes mid-playback.
    */
    expect(previewAudioRequests(timeline({ a: item('a', { muted: true }) }))).toEqual([]);
  });

  it('does not request anything on a muted track', () => {
    expect(
      previewAudioRequests(timeline({ a: item('a') }, [track('audio-1', { muted: true })])),
    ).toEqual([]);
  });

  it('silences every other track when one is soloed', () => {
    // The mixer's rule, and the one a user expects: solo means *only* this. Two audio tracks here,
    // one soloed, so exactly one request survives.
    const requests = previewAudioRequests(
      timeline(
        { a: item('a'), b: item('b', { trackId: 'audio-2' }) },
        [track('audio-1', { solo: true }), track('audio-2', { order: 1 })],
      ),
    );
    expect(requests.map((request) => request.itemId)).toEqual(['a']);
  });

  it('plays everything when nothing is soloed', () => {
    // `solo: false` on every track is the ordinary state, and it must not be read as "soloed".
    const requests = previewAudioRequests(
      timeline(
        { a: item('a'), b: item('b', { trackId: 'audio-2' }) },
        [track('audio-1', { solo: false }), track('audio-2', { solo: false, order: 1 })],
      ),
    );
    expect(requests).toHaveLength(2);
  });

  it('treats a project with no solo field as nothing soloed', () => {
    /*
      A project written before solo existed has no `solo` key at all. Reading `undefined` as
      truthy would silence the entire project the first time it was opened in this build.
    */
    const requests = previewAudioRequests(
      timeline(
        { a: item('a'), b: item('b', { trackId: 'audio-2' }) },
        [track('audio-1'), track('audio-2', { order: 1 })],
      ),
    );
    expect(requests).toHaveLength(2);
  });
});

describe('the gain envelope', () => {
  it('carries gain, volume and track volume', () => {
    // Three multipliers that the mixer applies and the preview must too: clip gain (static level
    // matching), volume (keyframeable) and the track's own fader.
    const requests = previewAudioRequests(
      timeline({ a: item('a', { gainDb: -3, volumeDb: -6 }) }, [track('audio-1', { volumeDb: -2 })]),
    );
    expect(requests[0]!.envelope.gainDb).toBe(-3);
    expect(requests[0]!.envelope.volumeDb).toBe(-6);
    expect(requests[0]!.envelope.trackVolumeDb).toBe(-2);
  });

  it('leaves an absent control absent, so the schema default applies', () => {
    /*
      `undefined` and `0` mean the same thing here (unity gain), but they are not the same *fact*:
      an item written before gain existed has no value at all, and inventing one would stop a
      later schema default from ever reaching it.
    */
    const envelope = previewAudioRequests(timeline({ a: item('a') }))[0]!.envelope;
    expect(envelope.gainDb).toBeUndefined();
    expect(envelope.volumeDb).toBeUndefined();
  });

  it('evaluates a fade to silence at the clip’s edges and to unity inside', () => {
    /*
      The curve is what the graph applies to an `AudioParam`, so its *shape* is the audible
      result. A fade is 0 at the very start, 1 after the fade-in has elapsed, and 0 again at the
      very end — the same `gainAt` the mixer evaluates per sample.
    */
    const request = previewAudioRequests(
      timeline({ a: item('a', { fadeInUs: 1_000_000, fadeOutUs: 1_000_000 }) }),
    )[0]!;
    const curve = gainCurveFor(request, 400);
    /*
      The first *sample* is a quarter of a millisecond into a one-second fade, so it is near zero
      rather than exactly zero — the curve samples inside the span, never on its boundary.
    */
    expect(curve[0]!).toBeLessThan(0.02);
    expect(Math.max(...curve)).toBeCloseTo(1, 2);
    expect(curve[curve.length - 1]!).toBeLessThan(0.02);
  });

  it('never asks for the end boundary, where the envelope is zero', () => {
    /*
      `gainAt` returns 0 at `start + duration` — the item is over. Sampling *inside* the span is
      what avoids ending every clip with a one-sample click into silence, so the last point of the
      curve must still be a real level.
    */
    const request = previewAudioRequests(timeline({ a: item('a') }))[0]!;
    const curve = gainCurveFor(request, 64);
    expect(curve[curve.length - 1]!).toBeGreaterThan(0.9);
  });

  it('keeps volume keyframes in the item’s own time', () => {
    /*
      The mixer shifts keyframe times into mix time because it decodes a range that starts at the
      export's in-point. The preview drives each element at its own position, so a keyframe at
      1 s is at 1 s — and shifting it here would move every volume line by the clip's start.
    */
    const request = previewAudioRequests(
      timeline({
        a: item('a', {
          startUs: 2_000_000,
          keyframes: { volumeDb: [{ timeUs: 1_000_000, value: -40 }] },
        }),
      }),
    )[0]!;
    expect(request.envelope.keyframes).toEqual([
      { timeUs: 1_000_000, valueDb: -40 },
    ]);
  });

  it('drops a keyframe whose value is not a number', () => {
    // A malformed project. Refusing the whole request over one bad key would silence a clip the
    // user can otherwise hear; the envelope simply ignores the point.
    const request = previewAudioRequests(
      timeline({
        a: item('a', {
          keyframes: {
            volumeDb: [
              { timeUs: 0, value: Number.NaN },
              { timeUs: 1_000_000, value: -6 },
            ],
          },
        }),
      }),
    )[0]!;
    expect(request.envelope.keyframes).toHaveLength(1);
  });
});

describe('pan', () => {
  it('divides the project’s percentage once', () => {
    /*
      The project stores −100…+100 and Web Audio wants −1…+1. Dividing in two places is how the
      export and the preview drift apart, so the conversion lives here and nowhere else in the
      preview — the same rule `planAudioItems` follows for the mixer.
    */
    expect(previewAudioRequests(timeline({ a: item('a', { pan: -100 }) }))[0]!.pan).toBe(-1);
    expect(previewAudioRequests(timeline({ a: item('a', { pan: 50 }) }))[0]!.pan).toBe(0.5);
    expect(previewAudioRequests(timeline({ a: item('a') }))[0]!.pan).toBe(0);
  });

  it('clamps a value outside the stored range', () => {
    // A project can be edited by hand, and a pan of 500 would put the sound somewhere a stereo
    // field does not have. Clamping here keeps the graph's contract intact.
    expect(previewAudioRequests(timeline({ a: item('a', { pan: 500 }) }))[0]!.pan).toBe(1);
  });
});

describe('ordering and overlap', () => {
  it('orders by track, then by start', () => {
    // Deterministic order makes a failing graph test readable, and the graph sums, so nothing
    // else depends on it.
    const requests = previewAudioRequests(
      timeline(
        {
          late: item('late', { trackId: 'audio-1', startUs: 5_000_000 }),
          early: item('early', { trackId: 'audio-1', startUs: 1_000_000 }),
          above: item('above', { trackId: 'audio-2', startUs: 0 }),
        },
        [track('audio-1', { order: 1 }), track('audio-2', { order: 0 })],
      ),
    );
    expect(requests.map((request) => request.itemId)).toEqual(['above', 'early', 'late']);
  });

  it('knows whether anything is playing at an instant', () => {
    // Used to decide whether the graph is worth running at all: a project with no audio at the
    // playhead should not spin up an `AudioContext`.
    const requests = previewAudioRequests(
      timeline({ a: item('a', { startUs: 1_000_000, durationUs: 2_000_000 }) }),
    );
    expect(hasAudioAt(requests, 1_500_000)).toBe(true);
    expect(hasAudioAt(requests, 500_000)).toBe(false);
    /* Half-open, like every other range in this project: the end instant is already past. */
    expect(hasAudioAt(requests, 3_000_000)).toBe(false);
  });
});

describe('keyframes that belong to other tracks', () => {
  /*
    The document lets a keyframe hold a vector, because the same mechanism drives colour and
    position. A `volumeDb` track is numeric — but "the field is called volumeDb" is not a type,
    and a project with one vector keyframe on that track used to be a compile error here or, worse,
    a NaN in the graph if it were cast past. It is skipped instead.
  */
  it('skips a vector keyframe on a volume track rather than reading it as a gain', () => {
    const request = previewAudioRequests(
      timeline({
        a: item('a', {
          keyframes: {
            /*
              Cast because the fixture helper types a keyframe's value as a number, and that is the
              point of the case: a real document type is wider than the fixture's.
            */
            volumeDb: [
              { timeUs: 0, value: [1, 2, 3, 4] },
              { timeUs: 500_000, value: -6 },
            ] as unknown as { timeUs: number; value: number }[],
          },
        }),
      }),
    )[0]!;
    expect(request.envelope.keyframes).toEqual([
      /* No `interpolation` on the source key, so none is invented here. */
      { timeUs: 500_000, valueDb: -6 },
    ]);
  });
});

describe('the envelope at one instant', () => {
  it('follows a fade as time passes, rather than holding its first value', () => {
    /*
      The bug this exists to prevent: the running graph first asked for a one-point curve, whose
      only entry is evaluated at the clip's start — a constant. Fades and keyframed volume were
      applied to the first frame of each clip and never updated, which looks exactly like the
      feature not working at all.
    */
    const request = previewAudioRequests(
      timeline({ a: item('a', { durationUs: 2_000_000, fadeInUs: 2_000_000 }) }),
    )[0]!;
    const quarter = gainAtInstant(request, 500_000);
    const threeQuarters = gainAtInstant(request, 1_500_000);
    expect(threeQuarters).toBeGreaterThan(quarter);
    expect(quarter).toBeLessThan(1);
  });

  it('follows a volume keyframe within the clip', () => {
    // The same property for the keyframed path: a line drawn in the inspector is a function of
    // time, and the graph has to read it at the playhead rather than at the clip's start.
    const request = previewAudioRequests(
      timeline({
        a: item('a', {
          durationUs: 4_000_000,
          keyframes: {
            volumeDb: [
              { timeUs: 0, value: 0 },
              { timeUs: 4_000_000, value: -30 },
            ],
          },
        }),
      }),
    )[0]!;
    expect(gainAtInstant(request, 1_000_000)).toBeGreaterThan(gainAtInstant(request, 3_000_000));
  });

  it('reads exactly the end instant as the last audible value, not as silence', () => {
    /*
      `gainAt` returns 0 exactly at `start + duration` — the item is over. A caller one microsecond
      past the end should get the last audible value, not a silent snap; that snap is what a
      one-sample click at every clip's tail sounds like.
    */
    /*
      A *faded* item is the fixture that can tell the two implementations apart: with a fade the
      value at the boundary and the value one microsecond inside it differ, so "clamped" and
      "unclamped" give different answers. A plain item reads unity either way, and a first version
      of this test used one — it passed against the bug.
    */
    const request = previewAudioRequests(
      timeline({ a: item('a', { durationUs: 2_000_000, fadeOutUs: 2_000_000 }) }),
    )[0]!;
    const atEnd = gainAtInstant(request, request.startUs + request.durationUs);
    expect(atEnd).toBeGreaterThan(0);
    expect(atEnd).toBeLessThan(0.01);
  });

  it('is zero before the clip starts', () => {
    // The other half of the clamp: silence before the item, because it has not begun.
    const request = previewAudioRequests(timeline({ a: item('a', { startUs: 2_000_000 }) }))[0]!;
    expect(gainAtInstant(request, 0)).toBe(0);
  });
});

describe('auto-ducking in the preview (SPEC 12 §6.7)', () => {
  /*
    §6.7's binding sentence is that the ducking envelope is "used identically by preview automation
    and export mixer". Until this slice the preview had *no* ducking at all — the graph was built
    from `previewAudioRequests`, which did not carry it, and the track-level settings the schema
    declares were read by nothing anywhere.

    These tests are about the plan, not the Web Audio: the hook multiplies `duckingGainAt` into the
    item's gain node per frame, and the arithmetic it calls is the one tested in `ducking.test.ts`.
    What is asserted here is that the plan carries the right spans for the right track.
  */
  const timeline = (options: {
    ducking?: Record<string, unknown>;
    items?: Array<{ id: string; trackId: string; startUs: number; durationUs: number; type?: string }>;
  }): PreviewAudioTimeline => ({
    tracks: [
      { id: 'trk-music', kind: 'audio', role: 'music', order: 0, ...(options.ducking ? { ducking: options.ducking } : {}) },
      { id: 'trk-voice', kind: 'audio', role: 'voiceover', order: 1 },
    ],
    items: Object.fromEntries(
      (options.items ?? [
        { id: 'bed', trackId: 'trk-music', startUs: 0, durationUs: 10_000_000 },
        { id: 'voice', trackId: 'trk-voice', startUs: 2_000_000, durationUs: 1_000_000 },
      ]).map((item) => [
        item.id,
        {
          id: item.id,
          trackId: item.trackId,
          type: item.type ?? 'audio',
          mediaId: `media-${item.id}`,
          startUs: item.startUs,
          durationUs: item.durationUs,
        },
      ]),
    ),
  } as unknown as PreviewAudioTimeline);

  it('carries no ducking for a track that has none', () => {
    const requests = previewAudioRequests(timeline({}));
    expect(requests.every((request) => request.ducking.length === 0)).toBe(true);
  });

  it('ducks a track under the other tracks’ items', () => {
    const requests = previewAudioRequests(
      timeline({ ducking: { enabled: true, triggerTrackIds: [] } }),
    );
    const bed = requests.find((request) => request.itemId === 'bed')!;
    expect(bed.ducking).toEqual([{ startUs: 2_000_000, endUs: 3_000_000 }]);
  });

  it('never lets an item duck under itself', () => {
    /*
      The failure that makes the whole feature useless: a music track whose own items count as
      speech would duck continuously, and the sound would be quiet everywhere with no visible cause.
    */
    const requests = previewAudioRequests(
      timeline({ ducking: { enabled: true, triggerTrackIds: [] } }),
    );
    const bed = requests.find((request) => request.itemId === 'bed')!;
    /* Only the voice's span, not the bed's own ten seconds. */
    expect(bed.ducking).toHaveLength(1);
    expect(bed.ducking[0]!.startUs).toBe(2_000_000);
  });

  it('honours the tracks it names', () => {
    const requests = previewAudioRequests(
      timeline({ ducking: { enabled: true, triggerTrackIds: ['trk-other'] } }),
    );
    const bed = requests.find((request) => request.itemId === 'bed')!;
    expect(bed.ducking).toEqual([]);
  });

  it('does nothing when the track is not enabled', () => {
    const requests = previewAudioRequests(
      timeline({ ducking: { enabled: false, triggerTrackIds: [] } }),
    );
    expect(requests.find((request) => request.itemId === 'bed')!.ducking).toEqual([]);
  });

  it('does not count a muted item as speech', () => {
    /*
      A muted voice is not audible, so it must not duck the music. The previous version of this
      test removed the voice from the timeline altogether, which asserts that an absent item is not
      a trigger — true, and not the question. A mutation deleting the mute filter survived it.
    */
    const base = timeline({ ducking: { enabled: true, triggerTrackIds: [] } });
    const muted = {
      ...base,
      items: {
        ...base.items,
        voice: { ...base.items['voice']!, muted: true },
      },
    } as unknown as PreviewAudioTimeline;
    expect(previewAudioRequests(muted).find((request) => request.itemId === 'bed')!.ducking).toEqual([]);
  });

  it('does not count a hidden track’s item as speech', () => {
    const base = timeline({ ducking: { enabled: true, triggerTrackIds: [] } });
    const hidden = {
      ...base,
      tracks: base.tracks.map((track) =>
        track.id === 'trk-voice' ? { ...track, hidden: true } : track,
      ),
    } as unknown as PreviewAudioTimeline;
    expect(previewAudioRequests(hidden).find((request) => request.itemId === 'bed')!.ducking).toEqual([]);
  });

  it('carries the ramps that shaped the spans', () => {
    const requests = previewAudioRequests(
      timeline({ ducking: { enabled: true, triggerTrackIds: [], reductionDb: -18, attackMs: 50, releaseMs: 200 } }),
    );
    const bed = requests.find((request) => request.itemId === 'bed')!;
    expect(bed.duckingRamps).toEqual({ reductionDb: -18, attackMs: 50, releaseMs: 200 });
  });

  it('computes one set of spans per track, shared by its items', () => {
    /*
      Not a micro-optimisation: a track with several items would otherwise walk the whole timeline
      once per item, and a project with fifty music cues would do that fifty times per render.
    */
    const requests = previewAudioRequests(
      timeline({
        ducking: { enabled: true, triggerTrackIds: [] },
        items: [
          { id: 'bed-a', trackId: 'trk-music', startUs: 0, durationUs: 4_000_000 },
          { id: 'bed-b', trackId: 'trk-music', startUs: 5_000_000, durationUs: 4_000_000 },
          { id: 'voice', trackId: 'trk-voice', startUs: 2_000_000, durationUs: 1_000_000 },
        ],
      }),
    );
    const a = requests.find((request) => request.itemId === 'bed-a')!;
    const b = requests.find((request) => request.itemId === 'bed-b')!;
    /* The same array instance: computed once and handed to both. */
    expect(a.ducking).toBe(b.ducking);
  });
});
