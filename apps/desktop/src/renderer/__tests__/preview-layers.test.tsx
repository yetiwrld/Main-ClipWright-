// @vitest-environment jsdom
/**
 * SPEC 10 §2/§6 — the preview composites layers, not just the last clip to start.
 *
 * The preview used to draw exactly one item: whichever visible clip began most
 * recently. An overlay clip therefore hid the clip under it completely and a
 * track sitting above the main track changed nothing about the picture. These
 * tests pin the layer stack, opacity and blend mode the inspector writes.
 *
 * jsdom does no painting, so the assertions are about the DOM that decides the
 * composite — the order of `[data-layer-id]` nodes, their `opacity` and
 * `mix-blend-mode`. Whether the browser then blends them correctly is not
 * something a unit test can prove; it is exercised by hand in the app.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import { PreviewPane } from '../features/editor/PreviewPane.js';
import { playheadStore } from '../features/editor/playhead-store.js';

interface Overrides {
  id?: string;
  mediaId?: string;
  startUs?: number;
  durationUs?: number;
  opacity?: number;
  blendMode?: string;
  keyframes?: Record<string, unknown>;
  trackRole?: 'main' | 'overlay';
}

/**
 * A timeline with a main video plus an optional overlay clip on the overlay
 * track, which `createDefaultTimeline` puts above the main track.
 */
function makeState(layers: Overrides[] = [{}]): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const mainTrack = base.tracks.find((track) => track.role === 'main')!;
  const overlayTrack = base.tracks.find((track) => track.role === 'overlay')!;
  const items: Record<string, unknown> = {};
  const tracks = base.tracks.map((track) => ({ ...track, itemIds: [] as string[] }));

  layers.forEach((layer, index) => {
    const track = layer.trackRole === 'overlay' ? overlayTrack : mainTrack;
    const item = {
      id: layer.id ?? `item-${index}`,
      trackId: track.id,
      type: 'video' as const,
      mediaId: layer.mediaId ?? `media-${index}`,
      startUs: layer.startUs ?? 0,
      durationUs: layer.durationUs ?? 5_000_000,
      sourceInUs: 0,
      transform: {},
      crop: {},
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      keyframes: layer.keyframes,
    };
    items[item.id] = item;
    const entry = tracks.find((candidate) => candidate.id === track.id)!;
    entry.itemIds.push(item.id);
  });

  return { ...base, tracks, items } as unknown as TimelineState;
}

const layerNodes = () =>
  Array.from(document.querySelectorAll('[data-layer-id]')) as HTMLElement[];

beforeEach(() => playheadStore.set(0));
afterEach(() => {
  cleanup();
  playheadStore.set(0);
});

describe('PreviewPane layers', () => {
  it('draws a single item when only one is visible', () => {
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} />);
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['a']);
  });

  it('keeps an overlay clip instead of dropping it', () => {
    // Before layering, the overlay won outright and `a` was never drawn.
    render(
      <PreviewPane
        state={makeState([
          { id: 'a' },
          { id: 'b', trackRole: 'overlay', startUs: 1_000_000, durationUs: 2_000_000 },
        ])}
        fps={30}
      />,
    );
    // At t=0 only `a` is on screen; at t=1.5s both are.
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['a']);
    act(() => playheadStore.set(1_500_000));
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['a', 'b']);
  });

  it('stacks the overlay above the main track', () => {
    render(
      <PreviewPane
        state={makeState([
          { id: 'a' },
          { id: 'b', trackRole: 'overlay', startUs: 0, durationUs: 5_000_000 },
        ])}
        fps={30}
      />,
    );
    // DOM order is paint order: the last node is the top layer.
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['a', 'b']);
  });

  it('applies the item opacity to its layer', () => {
    render(<PreviewPane state={makeState([{ id: 'a', opacity: 0.4 }])} fps={30} />);
    expect(layerNodes()[0]!.style.opacity).toBe('0.4');
  });

  it('defaults to fully opaque when the item has no opacity', () => {
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} />);
    expect(layerNodes()[0]!.style.opacity).toBe('1');
  });

  it('applies the blend mode to its layer', () => {
    render(<PreviewPane state={makeState([{ id: 'a', blendMode: 'screen' }])} fps={30} />);
    expect(layerNodes()[0]!.style.mixBlendMode).toBe('screen');
  });

  it('maps the stored `add` mode to the CSS keyword that exists', () => {
    // The schema spells additive blending `add`; CSS calls it `plus-lighter`.
    // Passing the stored name straight through would silently do nothing.
    render(<PreviewPane state={makeState([{ id: 'a', blendMode: 'add' }])} fps={30} />);
    expect(layerNodes()[0]!.style.mixBlendMode).toBe('plus-lighter');
  });

  it('hides a layer whose opacity is zero rather than painting it', () => {
    render(<PreviewPane state={makeState([{ id: 'a', opacity: 0 }])} fps={30} />);
    expect(layerNodes()).toHaveLength(0);
  });

  it('respects keyframed opacity at the playhead', () => {
    render(
      <PreviewPane
        state={
          makeState([
            {
              id: 'a',
              opacity: 1,
              // `keyframes` is a record keyed by property, not a flat list.
              keyframes: {
                opacity: [
                  { timeUs: 0, value: 0, easing: 'linear' },
                  { timeUs: 1_000_000, value: 1, easing: 'linear' },
                ],
              },
            },
          ])
        }
        fps={30}
      />,
    );
    act(() => playheadStore.set(500_000));
    expect(Number(layerNodes()[0]!.style.opacity)).toBeCloseTo(0.5, 2);
  });
});

describe('PreviewPane transitions', () => {
  /** Two clips back to back on the main track, the second crossfading in. */
  function twoClips(transition: Record<string, unknown>) {
    const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
    const track = base.tracks.find((entry) => entry.role === 'main')!;
    const items = {
      a: {
        id: 'a', trackId: track.id, type: 'video' as const, mediaId: 'm-a',
        startUs: 0, durationUs: 1_000_000, sourceInUs: 0, transform: {}, crop: {},
      },
      b: {
        id: 'b', trackId: track.id, type: 'video' as const, mediaId: 'm-b',
        startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, transform: {}, crop: {},
        transitionIn: {
          id: 'tr', type: 'crossfade', durationUs: 400_000, alignment: 'center',
          params: {}, easing: 'linear', crossfadeAudio: true, ...transition,
        },
      },
    };
    return {
      ...base,
      tracks: base.tracks.map((entry) =>
        entry.id === track.id ? { ...entry, itemIds: ['a', 'b'] } : entry,
      ),
      items,
    } as unknown as TimelineState;
  }

  it('draws both clips during a crossfade', () => {
    // The bug this pins: before transitions were evaluated, clip `a` ended at 1s
    // and clip `b` started at 1s, so at 1s exactly one of them existed and the cut
    // was hard no matter what the project file said.
    render(<PreviewPane state={twoClips({})} fps={30} />);
    act(() => playheadStore.set(1_000_000));
    expect(layerNodes().map((node) => node.dataset.layerId).sort()).toEqual(['a', 'b']);
  });

  it('keeps the outgoing clip out before the transition window opens', () => {
    render(<PreviewPane state={twoClips({})} fps={30} />);
    act(() => playheadStore.set(600_000));
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['a']);
  });

  it('fades the outgoing clip out and the incoming clip in', () => {
    render(<PreviewPane state={twoClips({})} fps={30} />);
    act(() => playheadStore.set(850_000));
    const byId = new Map(layerNodes().map((node) => [node.dataset.layerId, node]));
    // 850ms is 1/8 of the way into [800ms, 1200ms).
    expect(Number(byId.get('a')!.style.opacity)).toBeCloseTo(0.875, 2);
    expect(Number(byId.get('b')!.style.opacity)).toBeCloseTo(0.125, 2);
  });

  it('leaves only the incoming clip after the window closes', () => {
    render(<PreviewPane state={twoClips({})} fps={30} />);
    act(() => playheadStore.set(1_400_000));
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['b']);
  });

  it('slides both clips during a slide transition', () => {
    render(<PreviewPane state={twoClips({ type: 'slide', params: { direction: 'left' } })} fps={30} />);
    act(() => playheadStore.set(1_000_000));
    const byId = new Map(layerNodes().map((node) => [node.dataset.layerId, node]));
    // Halfway: the outgoing clip has moved half a frame left, the incoming one is
    // half a frame right of centre.
    expect(byId.get('a')!.style.transform).toContain('-50%');
    expect(byId.get('b')!.style.transform).toContain('50%');
  });

  it('does not draw the incoming clip in the first half of a fade-to-black', () => {
    render(<PreviewPane state={twoClips({ type: 'fade-black' })} fps={30} />);
    act(() => playheadStore.set(900_000));
    expect(layerNodes().map((node) => node.dataset.layerId)).toEqual(['a']);
  });

  it('fades the incoming clip in over the second half of a fade-to-black', () => {
    render(<PreviewPane state={twoClips({ type: 'fade-black' })} fps={30} />);
    act(() => playheadStore.set(1_100_000));
    const byId = new Map(layerNodes().map((node) => [node.dataset.layerId, node]));
    expect(Number(byId.get('b')!.style.opacity)).toBeCloseTo(0.5, 2);
  });
});
