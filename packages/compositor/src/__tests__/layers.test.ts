/**
 * SPEC 10 §2/§6 — layering items into one frame.
 *
 * Two things are being pinned here. First, which layers contribute at an instant:
 * an overlay clip over a main clip is the normal case the export got wrong by
 * writing only the topmost *decoded* item, independent of track order. Second, the
 * ffmpeg argument each layer turns into — and the shape of that argument was
 * discovered by measurement, not by reading the docs:
 *
 * - `all_expr` silently overrides `all_mode` (a multiply graph and a normal graph
 *   produced byte-identical output when both carried an expression);
 * - there are no `multiply()`/`addition()` functions in the expression language;
 *
 * so mode and opacity have to be two separate `blend` stages.
 */
import { describe, expect, it } from 'vitest';
import {
  ffmpegBlendMode,
  layerBlendFilter,
  needsCompositing,
  visibleLayers,
  type LayerItem,
} from '../layers.js';

const item = (overrides: Partial<LayerItem> = {}): LayerItem => ({
  id: 'item-1',
  startUs: 0,
  durationUs: 1_000_000,
  trackOrder: 0,
  ...overrides,
});

const keys = (pairs: Array<[number, number]>) =>
  pairs.map(([timeUs, value]) => ({ timeUs, value, interpolation: 'linear' as const }));

describe('visibleLayers', () => {
  it('includes an item that covers the instant', () => {
    expect(visibleLayers([item()], 500_000).map((layer) => layer.id)).toEqual(['item-1']);
  });

  it('excludes an item that has not started or has ended', () => {
    const layer = item({ startUs: 1_000_000, durationUs: 1_000_000 });
    expect(visibleLayers([layer], 999_999)).toEqual([]);
    expect(visibleLayers([layer], 1_000_000)).toHaveLength(1);
    // Half-open range: the end instant belongs to whatever comes next, so two
    // abutting clips do not both draw on the frame where they meet.
    expect(visibleLayers([layer], 2_000_000)).toEqual([]);
  });

  it('draws the higher track on top', () => {
    const layers = visibleLayers(
      [item({ id: 'overlay', trackOrder: 10 }), item({ id: 'main', trackOrder: 0 })],
      500_000,
    );
    expect(layers.map((layer) => layer.id)).toEqual(['main', 'overlay']);
  });

  it('drops a disabled item and one on a hidden track', () => {
    // A hidden track is not the same as a muted one: hidden means "not in the
    // picture", which is exactly what an export must honour.
    expect(visibleLayers([item({ disabled: true })], 0)).toEqual([]);
    expect(visibleLayers([item({ hiddenTrack: true })], 0)).toEqual([]);
  });

  it('drops a fully transparent layer', () => {
    // Dropping rather than drawing at alpha 0 matters for a multiply layer: drawn,
    // it would darken the frame it is supposed to be invisible over.
    expect(visibleLayers([item({ opacity: 0 })], 0)).toEqual([]);
  });

  it('keeps a layer with a small non-zero opacity', () => {
    expect(visibleLayers([item({ opacity: 0.01 })], 0)).toHaveLength(1);
  });

  it('clamps an out-of-range opacity instead of hiding the clip', () => {
    expect(visibleLayers([item({ opacity: 1.4 })], 0)[0]!.opacity).toBe(1);
    expect(visibleLayers([item({ opacity: -0.5 })], 0)).toEqual([]);
  });

  it('defaults to normal blend at full opacity', () => {
    const [layer] = visibleLayers([item()], 0);
    expect(layer).toMatchObject({ opacity: 1, blendMode: 'normal' });
  });

  it('evaluates a keyframed opacity', () => {
    const withKeys = item({ keyframes: { opacity: keys([[0, 1], [1_000_000, 0]]) } });
    expect(visibleLayers([withKeys], 0)[0]!.opacity).toBe(1);
    expect(visibleLayers([withKeys], 500_000)[0]!.opacity).toBe(0.5);
    expect(visibleLayers([withKeys], 300_000)[0]!.opacity).toBeCloseTo(0.7, 6);
  });

  it('drops a layer whose keyframed opacity reaches zero', () => {
    // An item that fades out and stays out must stop costing a decoder and must not
    // keep blending.
    const withKeys = item({ keyframes: { opacity: keys([[0, 1], [1_000_000, 0]]) } });
    expect(visibleLayers([withKeys], 1_000_000)).toEqual([]);
  });

  it('sorts by id within a track so two decoders cannot swap places', () => {
    // Two overlapping items on one track is what a bad split leaves behind; an
    // unstable order makes the frame flicker between them.
    const first = visibleLayers(
      [item({ id: 'b', trackOrder: 0 }), item({ id: 'a', trackOrder: 0 })],
      0,
    );
    const second = visibleLayers(
      [item({ id: 'a', trackOrder: 0 }), item({ id: 'b', trackOrder: 0 })],
      0,
    );
    expect(first.map((layer) => layer.id)).toEqual(second.map((layer) => layer.id));
  });
});

describe('needsCompositing', () => {
  it('is false for nothing', () => {
    expect(needsCompositing([])).toBe(false);
  });

  it('is false for one opaque normal layer', () => {
    // The common case: one video on the main track. It must keep the cheap path it
    // had before layering existed.
    expect(needsCompositing(visibleLayers([item()], 0))).toBe(false);
  });

  it('is true as soon as a layer is see-through or blended', () => {
    expect(needsCompositing(visibleLayers([item({ opacity: 0.5 })], 0))).toBe(true);
    expect(needsCompositing(visibleLayers([item({ blendMode: 'screen' })], 0))).toBe(true);
    expect(
      needsCompositing(visibleLayers([item(), item({ id: 'two', trackOrder: 1 })], 0)),
    ).toBe(true);
  });
});

describe('ffmpegBlendMode', () => {
  it('uses the name ffmpeg 4.1 accepts for every mode', () => {
    // A wrong name is not a warning: ffmpeg rejects the whole graph and the export
    // fails with a message about a filter.
    expect(ffmpegBlendMode('add')).toBe('addition');
    expect(ffmpegBlendMode('soft-light')).toBe('softlight');
    expect(ffmpegBlendMode('normal')).toBe('normal');
    expect(ffmpegBlendMode('multiply')).toBe('multiply');
    expect(ffmpegBlendMode('screen')).toBe('screen');
    expect(ffmpegBlendMode('overlay')).toBe('overlay');
  });
});

describe('layerBlendFilter', () => {
  it('emits nothing for an opaque normal layer', () => {
    // It *is* the frame; a blend stage would be a no-op filter on the hot path.
    expect(layerBlendFilter('normal', 1)).toBeNull();
  });

  it('emits nothing for a transparent layer', () => {
    expect(layerBlendFilter('normal', 0)).toBeNull();
    expect(layerBlendFilter('multiply', 0)).toBeNull();
  });

  it('emits only the mode at full opacity', () => {
    expect(layerBlendFilter('multiply', 1)).toBe('blend=all_mode=multiply');
    expect(layerBlendFilter('add', 1)).toBe('blend=all_mode=addition');
  });

  it('emits mode then opacity mix, in that order', () => {
    // Order is load-bearing: `all_expr` overrides `all_mode`, so the mode has to be
    // applied by a stage that has no expression of its own.
    expect(layerBlendFilter('multiply', 0.5)).toBe(
      "blend=all_mode=multiply,blend=all_expr='A*0.5+B*0.5'",
    );
    expect(layerBlendFilter('soft-light', 0.6)).toBe(
      "blend=all_mode=softlight,blend=all_expr='A*0.4+B*0.6'",
    );
  });

  it('emits only the opacity mix for a normal layer below full opacity', () => {
    expect(layerBlendFilter('normal', 0.25)).toBe("blend=all_expr='A*0.75+B*0.25'");
  });

  it('never mixes toward B*alpha, which would fade the layer to black', () => {
    // The expression has to keep the layer's share of the *blend*, not of black:
    // `A*(1-a) + B*a` where B is already the blended picture.
    const filter = layerBlendFilter('screen', 0.5)!;
    expect(filter).toContain('A*0.5+B*0.5');
    expect(filter).not.toContain('B*0.5+');
  });

  it('clamps an out-of-range opacity', () => {
    expect(layerBlendFilter('multiply', 2)).toBe('blend=all_mode=multiply');
    expect(layerBlendFilter('multiply', -1)).toBeNull();
  });

  it('is deterministic for the same inputs', () => {
    expect(layerBlendFilter('overlay', 0.333333)).toBe(layerBlendFilter('overlay', 0.333333));
  });
});
