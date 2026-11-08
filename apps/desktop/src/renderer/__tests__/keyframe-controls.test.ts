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
  keyframeAt,
  keyframeWriteRefusal,
  planPropertyEdit,
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
