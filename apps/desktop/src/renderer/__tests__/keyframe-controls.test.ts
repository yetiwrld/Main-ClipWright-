/**
 * SPEC 12 §2.4 — inspector keyframe controls and auto-keyframing.
 *
 * The two behaviours interact, so the tests are organised around the decision
 * boundary: an edit is a keyframe only when the property is *already* animated,
 * and even then only when the playhead is inside the clip.
 */
import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@clipwright/project-schema/schemas';
import {
  ANIMATABLE_PROPERTIES,
  adjacentKeyTime,
  displayedScale,
  isUniformScale,
  keyframeAt,
  keyframeWriteRefusal,
  commitKeyed,
  planPairedEdit,
  planPropertyEdit,
  type KeyframeCommitWriter,
} from '../features/editor/keyframe-controls.js';

const key = (timeUs: number, value: number): Keyframe =>
  ({ timeUs, value, interpolation: 'linear' }) as Keyframe;

const clip = { startUs: 1_000_000, durationUs: 2_000_000 };
// Inside: [1.0 s, 3.0 s). The playhead in most tests sits 0.5 s into the clip.
const inside = 1_500_000;

describe('keyframe write refusal (SPEC 12 §2.4)', () => {
  it('allows a key inside the clip', () => {
    expect(keyframeWriteRefusal(clip, inside)).toBeNull();
  });

  it('allows a key exactly on the clip start', () => {
    // The first frame is part of the clip, so a key there is visible.
    expect(keyframeWriteRefusal(clip, clip.startUs)).toBeNull();
  });

  it('refuses a key exactly on the clip end', () => {
    /*
      Half-open, like every other span in this codebase: the item is not drawn on
      `start + duration`, so a key there would exist in the file and never be seen.
    */
    expect(keyframeWriteRefusal(clip, clip.startUs + clip.durationUs)).not.toBeNull();
  });

  it('explains which side of the clip the playhead is on', () => {
    // The tooltip is the whole user-facing part of the refusal, so it has to say
    // something actionable rather than "invalid".
    expect(keyframeWriteRefusal(clip, 0)).toMatch(/before/);
    expect(keyframeWriteRefusal(clip, 9_000_000)).toMatch(/past the end/);
    expect(keyframeWriteRefusal(undefined, inside)).toMatch(/No clip/);
  });
});

describe('toggling a keyframe at the playhead', () => {
  it('finds a key stored at the exact time', () => {
    expect(keyframeAt([key(0, 0), key(500_000, 1)], 500_000)?.value).toBe(1);
    expect(keyframeAt([key(0, 0)], 500_000)).toBeUndefined();
    expect(keyframeAt(undefined, 0)).toBeUndefined();
  });
});

describe('jumping between keys (SPEC 12 §2.4 ◀ ▶)', () => {
  const keys = [key(0, 0), key(1_000_000, 1), key(3_000_000, 0)];

  it('finds the previous key', () => {
    expect(adjacentKeyTime(keys, 2_000_000, 'previous')).toBe(1_000_000);
  });

  it('finds the next key', () => {
    expect(adjacentKeyTime(keys, 2_000_000, 'next')).toBe(3_000_000);
  });

  it('returns null at the ends rather than wrapping', () => {
    // Wrapping would move the playhead backwards while the user asks to go forward,
    // which reads as a bug. §2.4 does not ask for a wrap.
    expect(adjacentKeyTime(keys, 0, 'previous')).toBeNull();
    expect(adjacentKeyTime(keys, 3_000_000, 'next')).toBeNull();
  });

  it('skips over a key exactly at the playhead', () => {
    // On a key, "previous" must mean the one before it — not the key underfoot,
    // which would make the button appear dead.
    expect(adjacentKeyTime(keys, 1_000_000, 'previous')).toBe(0);
    expect(adjacentKeyTime(keys, 1_000_000, 'next')).toBe(3_000_000);
  });

  it('orders keys by time however they were stored', () => {
    const shuffled = [key(3_000_000, 0), key(0, 0), key(1_000_000, 1)];
    expect(adjacentKeyTime(shuffled, 500_000, 'next')).toBe(1_000_000);
    expect(adjacentKeyTime(shuffled, 2_000_000, 'previous')).toBe(1_000_000);
  });

  it('reports nothing for a property with no keys', () => {
    expect(adjacentKeyTime([], 0, 'next')).toBeNull();
    expect(adjacentKeyTime(undefined, 0, 'previous')).toBeNull();
  });
});

describe('auto-keyframing (SPEC 12 §2.4)', () => {
  it('edits the static value when the property has no keys', () => {
    // The important half of the rule: a user dragging a slider on a clip that has
    // never been animated must not accidentally create animation.
    expect(planPropertyEdit(undefined, clip, inside, 0.5)).toEqual({ kind: 'static' });
    expect(planPropertyEdit([], clip, inside, 0.5)).toEqual({ kind: 'static' });
  });

  it('writes a key at the playhead when the property is already animated', () => {
    const keys = [key(0, 0), key(2_000_000, 1)];
    // The playhead is 0.5 s into a clip starting at 1.0 s, so the *local* time is
    // 0.5 s — keyframe times are item-local, and writing the absolute time here
    // would put the key in the wrong place on every clip that does not start at 0.
    expect(planPropertyEdit(keys, clip, inside, 0.25)).toEqual({
      kind: 'insert-key',
      timeUs: 500_000,
      value: 0.25,
    });
  });

  it('updates the existing key rather than inserting a duplicate', () => {
    // Inserting a second key at the same time would violate the model's
    // "unique per property" rule and make evaluation pick one arbitrarily.
    const keys = [key(0, 0), key(500_000, 1)];
    expect(planPropertyEdit(keys, clip, inside, 0.75)).toEqual({
      kind: 'update-key',
      timeUs: 500_000,
      value: 0.75,
    });
  });

  it('falls back to the static value when the playhead is outside the clip', () => {
    /*
      Auto-keyframing cannot clamp the key into the clip: that would write a key at a
      time the user did not choose and silently reshape the animation. §2.4 blocks
      the edit; with no keyframe to write, the static value is what remains.
    */
    const keys = [key(0, 0), key(2_000_000, 1)];
    expect(planPropertyEdit(keys, clip, 0, 0.5)).toEqual({ kind: 'static' });
    expect(planPropertyEdit(keys, clip, 9_000_000, 0.5)).toEqual({ kind: 'static' });
  });
});

describe('the animatable property list', () => {
  it('offers only paths the renderer or the audio envelope reads', () => {
    /*
      A diamond on a path nothing evaluates lets a user animate a property and see
      nothing change — the exact failure this audit has been chasing. The paths here
      are the ones `itemGeometry`, the layer resolver and the gain envelope read.
    */
    const evaluated = new Set([
      'opacity',
      'volumeDb',
      'transform.scaleX',
      'transform.scaleY',
      'transform.x',
      'transform.y',
      'transform.rotation',
      'crop.left',
      'crop.right',
      'crop.top',
      'crop.bottom',
    ]);
    for (const property of ANIMATABLE_PROPERTIES) {
      expect(evaluated.has(property.path), `${property.path} is not read by any consumer`).toBe(true);
    }
  });

  it('has no duplicate paths', () => {
    const paths = ANIMATABLE_PROPERTIES.map((property) => property.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('the scale the inspector shows (legacy `transform.scale`)', () => {
  it('reports the legacy scale while both axes are untouched', () => {
    /*
      The compositor honours `transform.scale` while `scaleX`/`scaleY` are both still
      at their default of 1. Reading `scaleX` alone therefore shows 100% for a clip
      that renders at 150% — and a §2.4 diamond on that row would record 1 and resize
      the clip the moment it was clicked.
    */
    expect(displayedScale({ scale: 1.5, scaleX: 1, scaleY: 1 })).toBeCloseTo(1.5, 6);
    expect(isUniformScale({ scale: 1.5, scaleX: 1, scaleY: 1 })).toBe(true);
  });

  it('reports the per-axis scale once an axis has been set', () => {
    // Touching an axis retires the legacy field, exactly as the compositor does.
    expect(displayedScale({ scale: 1.5, scaleX: 2, scaleY: 2 })).toBe(2);
  });

  it('agrees with a plain untransformed clip', () => {
    expect(displayedScale({})).toBe(1);
    expect(isUniformScale({})).toBe(true);
  });

  it('reports a non-uniform scale as non-uniform rather than picking an axis', () => {
    // A single field cannot show 120% wide by 80% tall; the inspector has to show
    // both axes instead of silently displaying one of them.
    expect(isUniformScale({ scaleX: 1.2, scaleY: 0.8 })).toBe(false);
  });
});

describe('keying an edit that moves two axes at once', () => {
  it('stays static when neither axis is animated', () => {
    expect(planPairedEdit([undefined, []], clip, inside, 1.5)).toEqual({ kind: 'static' });
  });

  it('keys both axes when either one is already animated', () => {
    /*
      The single Scale field writes `scaleX` and `scaleY` together. Keying only one
      would pin the other, so the picture would stretch — the exact failure the shared
      field exists to prevent.
    */
    const keys = [key(0, 1), key(2_000_000, 2)];
    expect(planPairedEdit([keys, undefined], clip, inside, 1.5)).toEqual({
      kind: 'insert-key',
      timeUs: 500_000,
      value: 1.5,
    });
  });

  it('updates when a key already sits on the playhead on either axis', () => {
    // A key on only one of the two axes still means "this frame is keyed"; inserting
    // a second key on that axis would collide.
    const keyed = [key(0, 1), key(500_000, 2)];
    expect(planPairedEdit([undefined, keyed], clip, inside, 1.5)).toEqual({
      kind: 'update-key',
      timeUs: 500_000,
      value: 1.5,
    });
  });

  it('respects the clip boundary like a single-property edit', () => {
    const keys = [key(0, 1)];
    expect(planPairedEdit([keys, keys], clip, 0, 1.5)).toEqual({ kind: 'static' });
  });
});

describe('committing an edit, from the sidebar or the canvas', () => {
  function writer(playheadUs: number) {
    const added: Array<[string, string, number, number]> = [];
    const updated: Array<[string, string, number, number]> = [];
    const api: KeyframeCommitWriter = {
      playheadUs,
      addKeyframe: (itemId, path, timeUs, value) => (added.push([itemId, path, timeUs, value]), true),
      updateKeyframe: (itemId, path, timeUs, patch) =>
        (updated.push([itemId, path, timeUs, patch.value]), true),
    };
    return { api, added, updated };
  }

  const animated = { ...clip, id: 'item-1', keyframes: { opacity: [key(0, 0), key(2_000_000, 1)] } };

  it('agrees with planPropertyEdit for a single property', () => {
    /*
      The sidebar's own path and this one must not drift: one of them drives every
      slider and the other drives every canvas drag, and a disagreement would mean a
      keyframe written by dragging but not by typing — the kind of inconsistency that
      looks like a rendering bug rather than an editing one.
    */
    for (const playheadUs of [1_500_000, 1_000_000, 3_500_000]) {
      const plan = planPropertyEdit(animated.keyframes!['opacity'], animated, playheadUs, 0.5);
      const { api, added, updated } = writer(playheadUs);
      const staticEdits: string[] = [];
      const outcome = commitKeyed(api, animated, [{ path: 'opacity', value: 0.5 }], () =>
        staticEdits.push('static'),
      );
      expect(outcome).toBe(plan.kind === 'static' ? 'static' : 'keyed');
      if (plan.kind === 'static') {
        expect(staticEdits).toHaveLength(1);
        expect(added).toHaveLength(0);
      } else if (plan.kind === 'insert-key') {
        expect(added).toEqual([['item-1', 'opacity', plan.timeUs, 0.5]]);
      } else {
        expect(updated).toEqual([['item-1', 'opacity', plan.timeUs, 0.5]]);
      }
    }
  });

  it('keys every property of a multi-property gesture, with each one\'s own value', () => {
    /*
      Dragging a clip changes x and y at once. Both must be keyed: keying x and
      statically setting y would make the horizontal half animate and the vertical
      half snap, producing a diagonal path the user never drew.
    */
    const state = {
      ...clip,
      id: 'item-1',
      keyframes: { 'transform.x': [key(0, 0)], 'transform.y': [key(0, 0)] },
    };
    const { api, added } = writer(inside);
    commitKeyed(api, state, [{ path: 'transform.x', value: 0.3 }, { path: 'transform.y', value: -0.2 }], () => {
      throw new Error('should have keyed');
    });
    expect(added).toEqual([
      ['item-1', 'transform.x', 500_000, 0.3],
      ['item-1', 'transform.y', 500_000, -0.2],
    ]);
  });

  it('stays static when none of the gesture\'s properties is animated', () => {
    // Dragging an un-animated clip must move it, not start an animation — the same
    // rule the sliders follow.
    const { api, added } = writer(inside);
    const staticEdits: string[] = [];
    const outcome = commitKeyed(api, { ...clip, id: 'item-1' }, [{ path: 'transform.x', value: 0.3 }], () =>
      staticEdits.push('static'),
    );
    expect(outcome).toBe('static');
    expect(staticEdits).toHaveLength(1);
    expect(added).toHaveLength(0);
  });

  it('keys both properties when only one of the gesture\'s pair is animated', () => {
    // The same paired rule as the uniform Scale field: half a gesture is not an edit.
    const state = { ...clip, id: 'item-1', keyframes: { 'transform.x': [key(0, 0)] } };
    const { api, added } = writer(inside);
    commitKeyed(api, state, [{ path: 'transform.x', value: 0.3 }, { path: 'transform.y', value: -0.2 }], () => {
      throw new Error('should have keyed');
    });
    expect(added.map((call) => call[1])).toEqual(['transform.x', 'transform.y']);
  });
});
