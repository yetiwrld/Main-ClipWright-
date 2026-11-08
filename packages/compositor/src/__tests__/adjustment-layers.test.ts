/**
 * SPEC 12 §3.1 — adjustment layers grade what is below them.
 *
 * The spec's acceptance list (item 5) asks that "adjustment layers affect only the
 * tracks below within their time range". Both halves of that sentence are easy to get
 * wrong in opposite directions: grading everything makes an adjustment layer behave
 * like a global filter, and grading nothing makes it inert. These tests pin each
 * boundary — above, below, same track, before, after.
 */
import { describe, expect, it } from 'vitest';
import {
  activeAdjustmentLayers,
  effectsForLayer,
  isAdjustmentItem,
  type AdjustmentItem,
} from '../adjustment-layers.js';

const adjustment = (overrides: Partial<AdjustmentItem> = {}): AdjustmentItem => ({
  id: 'adj-1',
  type: 'adjustment',
  startUs: 0,
  durationUs: 5_000_000,
  trackOrder: 10,
  effects: [{ effectId: 'exposure', params: { stops: 1 } }],
  ...overrides,
});

const layer = (overrides: Partial<AdjustmentItem> = {}): AdjustmentItem => ({
  id: 'clip-1',
  type: 'video',
  startUs: 0,
  durationUs: 5_000_000,
  trackOrder: 0,
  ...overrides,
});

describe('activeAdjustmentLayers', () => {
  it('finds an adjustment layer covering the instant', () => {
    expect(activeAdjustmentLayers([adjustment()], 1_000_000).map((l) => l.id)).toEqual(['adj-1']);
  });

  it('ignores one that has not started or has ended', () => {
    // The window is half-open, like every other time range in the timeline.
    const item = adjustment({ startUs: 2_000_000, durationUs: 1_000_000 });
    expect(activeAdjustmentLayers([item], 1_999_999)).toHaveLength(0);
    expect(activeAdjustmentLayers([item], 2_500_000)).toHaveLength(1);
    expect(activeAdjustmentLayers([item], 3_000_000)).toHaveLength(0);
  });

  it('ignores a disabled adjustment layer', () => {
    expect(activeAdjustmentLayers([adjustment({ disabled: true })], 0)).toHaveLength(0);
  });

  it('ignores one whose track is hidden', () => {
    expect(activeAdjustmentLayers([adjustment({ hiddenTrack: true })], 0)).toHaveLength(0);
  });

  it('ignores one with no enabled effects', () => {
    // Nothing to do; keeping it would make every "is there work" check say yes.
    expect(activeAdjustmentLayers([adjustment({ effects: [] })], 0)).toHaveLength(0);
    expect(
      activeAdjustmentLayers(
        [adjustment({ effects: [{ effectId: 'exposure', enabled: false }] })],
        0,
      ),
    ).toHaveLength(0);
  });

  it('ignores an ordinary clip even if it carries effects', () => {
    // A graded clip is not an adjustment layer; its chain applies to itself.
    const graded = layer({ effects: [{ effectId: 'exposure' }] });
    expect(activeAdjustmentLayers([graded], 0)).toHaveLength(0);
  });

  it('returns them bottom-most first', () => {
    // Two stacked exposure layers must compose in timeline order, or a +1 and a −1
    // would not cancel.
    const low = adjustment({ id: 'low', trackOrder: 5 });
    const high = adjustment({ id: 'high', trackOrder: 20 });
    expect(activeAdjustmentLayers([high, low], 0).map((l) => l.id)).toEqual(['low', 'high']);
  });

  it('filters the chain through the effect catalogue', () => {
    // An unknown effect in a project file must not reach the renderer.
    const item = adjustment({
      effects: [
        { effectId: 'exposure', params: { stops: 99 } },
        { effectId: 'chroma-key' },
      ],
    });
    const [resolved] = activeAdjustmentLayers([item], 0);
    expect(resolved!.effects).toHaveLength(1);
    expect(resolved!.effects[0]!.params.stops).toBe(3); // clamped to the spec's range
  });
});

describe('effectsForLayer', () => {
  const layers = activeAdjustmentLayers(
    [adjustment({ id: 'adj', trackOrder: 10 })],
    0,
  );

  it('applies to a layer below it', () => {
    expect(effectsForLayer(layers, 0)).toHaveLength(1);
  });

  it('does not apply to a layer above it', () => {
    // The whole point of "below": an adjustment layer must not grade an overlay
    // sitting on a higher track.
    expect(effectsForLayer(layers, 20)).toHaveLength(0);
  });

  it('does not apply to its own track', () => {
    // Ambiguous by construction — a track holds one kind of content — so rather
    // than guess, it does not apply.
    expect(effectsForLayer(layers, 10)).toHaveLength(0);
  });

  it('returns nothing when there are no adjustment layers', () => {
    expect(effectsForLayer([], 0)).toHaveLength(0);
  });

  it('concatenates several layers in order', () => {
    const stacked = activeAdjustmentLayers(
      [
        adjustment({ id: 'a', trackOrder: 5, effects: [{ effectId: 'exposure' }] }),
        adjustment({ id: 'b', trackOrder: 8, effects: [{ effectId: 'contrast' }] }),
      ],
      0,
    );
    expect(effectsForLayer(stacked, 0).map((effect) => effect.effectId)).toEqual([
      'exposure',
      'contrast',
    ]);
  });

  it('skips a layer that is below the clip it would grade', () => {
    const mixed = activeAdjustmentLayers(
      [
        adjustment({ id: 'low', trackOrder: 1 }),
        adjustment({ id: 'high', trackOrder: 30 }),
      ],
      0,
    );
    // A clip on track 5 is graded by the layer at 30 only.
    expect(effectsForLayer(mixed, 5)).toHaveLength(1);
  });
});

describe('isAdjustmentItem', () => {
  it('identifies the adjustment type and nothing else', () => {
    expect(isAdjustmentItem({ type: 'adjustment' })).toBe(true);
    for (const type of ['video', 'image', 'audio', 'caption', 'text', 'shape']) {
      expect(isAdjustmentItem({ type })).toBe(false);
    }
  });
});
