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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDefaultTimeline, type TimelineState } from '@clipwright/timeline-engine';
import { PreviewPane, volumeKeyframesFor } from '../features/editor/PreviewPane.js';
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
  /** The stored transform, so a fixture can start from a scaled or turned clip. */
  transform?: Record<string, number | boolean>;
  crop?: Record<string, number>;
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
      transform: layer.transform ?? {},
      crop: layer.crop ?? {},
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

describe('PreviewPane effects', () => {
  it('applies a CSS filter for an effect CSS can reproduce', () => {
    const state = makeState([{ id: 'a' }]);
    (state.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'saturation', enabled: true, params: { amount: 0 } },
    ];
    render(<PreviewPane state={state} fps={30} />);
    const video = document.querySelector('[data-layer-id="a"] video') as HTMLElement;
    expect(video.style.filter).toContain('saturate(0');
  });

  it('leaves the filter unset for a clip with no effects', () => {
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} />);
    const video = document.querySelector('[data-layer-id="a"] video') as HTMLElement;
    expect(video.style.filter).toBe('');
  });

  it('skips a disabled effect', () => {
    const state = makeState([{ id: 'a' }]);
    (state.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'saturation', enabled: false, params: { amount: 0 } },
    ];
    render(<PreviewPane state={state} fps={30} />);
    const video = document.querySelector('[data-layer-id="a"] video') as HTMLElement;
    expect(video.style.filter).toBe('');
  });

  it('says so when an effect cannot be previewed', () => {
    // §10 §14 requires a visible banner rather than a silently wrong picture. A
    // vignette has no CSS filter equivalent.
    const state = makeState([{ id: 'a' }]);
    (state.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'vignette', enabled: true, params: { amount: 0.8 } },
    ];
    render(<PreviewPane state={state} fps={30} />);
    const banner = screen.getByTestId('preview-effect-banner');
    expect(banner.textContent).toContain('Vignette');
    expect(banner.textContent).toContain('export is unaffected');
  });

  it('shows no banner when every effect can be previewed', () => {
    const state = makeState([{ id: 'a' }]);
    (state.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'exposure', enabled: true, params: { stops: 1 } },
    ];
    render(<PreviewPane state={state} fps={30} />);
    expect(screen.queryByTestId('preview-effect-banner')).toBeNull();
  });

  it('ignores an unpaintable effect that is disabled', () => {
    // The banner is about the picture on screen; a disabled effect is not on it.
    const state = makeState([{ id: 'a' }]);
    (state.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'sharpen', enabled: false, params: { amount: 1 } },
    ];
    render(<PreviewPane state={state} fps={30} />);
    expect(screen.queryByTestId('preview-effect-banner')).toBeNull();
  });

  it('reports a temperature shift only when it is large enough to diverge', () => {
    // A small warm shift is close enough that sepia approximates it; a large one is
    // not, and saying so is better than pretending.
    const mild = makeState([{ id: 'a' }]);
    (mild.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'temperature', enabled: true, params: { amount: 20 } },
    ];
    render(<PreviewPane state={mild} fps={30} />);
    expect(screen.queryByTestId('preview-effect-banner')).toBeNull();

    cleanup();
    const strong = makeState([{ id: 'a' }]);
    (strong.items['a'] as { effects?: unknown[] }).effects = [
      { id: 'fx', effectId: 'temperature', enabled: true, params: { amount: 90 } },
    ];
    render(<PreviewPane state={strong} fps={30} />);
    expect(screen.getByTestId('preview-effect-banner').textContent).toContain('Temperature');
  });
});

describe('volume keyframes in the preview (SPEC 12 §6)', () => {
  it('shifts item-local keys into timeline time', () => {
    // The preview evaluates the envelope against timeline time, exactly as the
    // export does. A key at local 0 on a clip starting at 1.5 s therefore has to
    // become a key at 1.5 s, or the volume line plays early by the clip's position.
    const keys = volumeKeyframesFor({
      startUs: 1_500_000,
      keyframes: {
        volumeDb: [
          { timeUs: 0, value: -12, interpolation: 'linear' },
          { timeUs: 400_000, value: 0, interpolation: 'linear' },
        ],
      },
    });
    expect(keys?.map((key) => key.timeUs)).toEqual([1_500_000, 1_900_000]);
    expect(keys?.map((key) => key.valueDb)).toEqual([-12, 0]);
  });

  it('reports nothing for a clip without a volume line', () => {
    // `undefined` rather than an empty array: the envelope treats a present-but-empty
    // list as no keys too, but passing one around would allocate on every frame for
    // the overwhelmingly common case of a clip with no volume animation.
    expect(volumeKeyframesFor({ startUs: 0 })).toBeUndefined();
    expect(volumeKeyframesFor({ startUs: 0, keyframes: { volumeDb: [] } })).toBeUndefined();
  });

  it('drops a non-numeric value instead of passing NaN into the gain', () => {
    // A colour keyframe on `volumeDb` would become NaN, and NaN silences the clip
    // with nothing in the log to explain why.
    const keys = volumeKeyframesFor({
      startUs: 0,
      keyframes: {
        volumeDb: [
          { timeUs: 0, value: [1, 0, 0, 1], interpolation: 'linear' },
          { timeUs: 100_000, value: -3, interpolation: 'linear' },
        ],
      },
    });
    expect(keys).toHaveLength(1);
    expect(keys?.[0]!.valueDb).toBe(-3);
  });

  it('ignores a volume line on a clip whose animation belongs to another property', () => {
    // `opacity` keys must not be mistaken for the volume line; the properties are
    // separate and a clip can animate either without the other.
    expect(
      volumeKeyframesFor({ startUs: 0, keyframes: { opacity: [{ timeUs: 0, value: 0.5 }] } }),
    ).toBeUndefined();
  });
});

describe('on-canvas drag editing (SPEC 12 Phase 4)', () => {
  /** A timeline double with just the commands a drag calls. */
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  /**
   * jsdom gives every element a 0×0 box, and the drag measures the canvas to convert
   * pixels into fractions. Without a stubbed rectangle the conversion divides by zero
   * and the drag is correctly ignored — which would make these tests pass by doing
   * nothing. The size is set once and deliberately non-square (400×600) so a drag
   * measured against the wrong axis cannot pass.
   */
  function stubCanvasBox() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  it('does not make the picture draggable without a timeline', () => {
    // The preview is also rendered standalone; with no commands to call, the
    // outline must not appear and must not promise an edit that cannot happen.
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} />);
    expect(screen.queryByTestId('preview-selection')).toBeNull();
  });

  it('outlines the selected clip', () => {
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline()} />);
    expect(screen.getByTestId('preview-selection')).toBeTruthy();
  });

  it('does not outline a clip that is not selected', () => {
    render(
      <PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline(['other'])} />,
    );
    expect(screen.queryByTestId('preview-selection')).toBeNull();
  });

  it('moves the clip by the drag, in canvas fractions', () => {
    /*
      40 pixels across a 400-wide canvas is a tenth of the width; 60 down a 600-tall
      one is a tenth of the height. The two differ in pixels precisely so that a
      conversion measured against the wrong axis produces a different number.
    */
    stubCanvasBox();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 240, 360));
    fireEvent(layer, pointer('pointerup', 240, 360));

    expect(timeline.setItemProperties).toHaveBeenCalledWith(['a'], {
      transform: { x: 0.1, y: 0.1 },
    });
  });

  it('commits once on release, not on every pointer move', () => {
    /*
      A drag is one undo step. Writing on every move would put forty entries on the
      undo stack for one gesture, and "undo" would walk the clip back pixel by pixel.
    */
    stubCanvasBox();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 210, 300));
    fireEvent(layer, pointer('pointermove', 220, 300));
    fireEvent(layer, pointer('pointermove', 230, 300));
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    fireEvent(layer, pointer('pointerup', 230, 300));
    expect(timeline.setItemProperties).toHaveBeenCalledTimes(1);
  });

  it('does not commit a drag that ended where it started', () => {
    // A plain click on the picture would otherwise cost an empty undo step.
    stubCanvasBox();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointerup', 200, 300));
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('follows the pointer while the drag is in flight, before anything is written', () => {
    /*
      The picture has to move under the cursor; waiting for the commit would show
      nothing until release. The check is on the wrapper's own transform, which is
      what carries `transform.x/y`.
    */
    stubCanvasBox();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 280, 300));
    expect(layer.style.transform).toContain('translate(20%');
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });
});

describe('crop-edge drags on the canvas (SPEC 12 Phase 4)', () => {
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  /**
   * The canvas is 400×600 and the layer fills it, so its drawn rectangle is the whole
   * canvas — which puts the left edge at x=0. A pointer 2 px inside that edge is
   * within the handle band; one at the centre is the move grip.
   */
  function stubBoxes() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  it('crops from the frame and writes nothing until Enter', () => {
    /*
      The whole §8.6 contract in one gesture.

      A drag on the left edge of the *frame* moves the crop's left inset, and it stays a draft:
      the document is untouched until `Enter`, so `Esc` can throw the session away. Before the
      frame existed this surface cropped per drag and wrote on pointer-up, which made the two
      undo entries a single drag produced impossible to explain to a user who had pressed `Esc`.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Crop tool' }));
    const frame = screen.getByTestId('preview-crop-rect');

    // The frame fills the 400×600 box, so 40 px of travel is a tenth of its width.
    fireEvent(frame, pointer('pointerdown', 2, 300));
    fireEvent(frame, pointer('pointermove', 42, 300));
    fireEvent(frame, pointer('pointerup', 42, 300));

    // Nothing written yet: a session in flight is a draft.
    expect(timeline.setItemProperties).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['a'], {
      crop: { left: 0.1 },
    });
    // The position must be untouched: one gesture, one property.
    const calls = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.every((call) => !('transform' in (call[1] as object)))).toBe(true);
  });

  it('applies nothing when Enter follows a session that changed nothing', () => {
    /*
      `Enter` on an untouched frame is a way to leave the tool, not an edit. Without the guard
      it pushes an undo step that changes nothing, so the next `Ctrl+Z` appears to do nothing at
      all — a dead undo is worse than a missing one, because it teaches the user not to trust it.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Crop tool' }));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
    expect(timeline.updateKeyframe).not.toHaveBeenCalled();
  });

  it('throws the session away on Esc, writing nothing', () => {
    /*
      The half of §8.6 that a per-gesture write would make impossible: a drag that was visible
      on screen and then discarded. Nothing reaches the document at any point, so `Esc` needs no
      undo of its own — and crucially leaves the clip's *stored* crop in place.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Crop tool' }));
    const frame = screen.getByTestId('preview-crop-rect');

    fireEvent(frame, pointer('pointerdown', 2, 300));
    fireEvent(frame, pointer('pointermove', 42, 300));
    fireEvent(frame, pointer('pointerup', 42, 300));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    // And the tool is back to Select, so the frame is gone.
    expect(screen.queryByTestId('preview-crop-rect')).toBeNull();
  });

  it('draws the frame over the uncropped source, not over the crop', () => {
    /*
      §8.6 says the rectangle goes over the **uncropped** source, and this is why: with the
      stored crop applied, the picture outside the window is invisible, so a user could never
      widen a crop back out — the grips would sit on the edge of a picture already cut away.

      The clip below is cropped to its left quarter, so the two geometries differ by a lot. The
      crop is *stored*, so this is exercised without any session drag.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    const state = makeState([{ id: 'a' }]);
    state.items.a = { ...state.items.a!, crop: { left: 0, top: 0, right: 0.75, bottom: 0, radius: 0 } };
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Crop tool' }));

    const fit = document.querySelector('[data-testid="preview-item-fit"]') as HTMLElement;
    /*
      The fit box's `aspectRatio` is `${source.width * sourceAspect} / ${source.height}`, and
      `source` is the *cropped* rectangle. Stored, the 0.75 crop makes it 0.25 of the source
      wide; dropped, it is the whole source. Asserting the exact string rather than "not one
      value" is what makes this catch the bug: the crop has to be *gone*, not merely different.
    */
    // The canvas is 9:16 and no frame has loaded, so the source's stand-in ratio is 0.5625 —
    // and 0.5625 / 1 is the *uncropped* box. With the crop applied it would be 0.140625 / 1.
    expect(fit.style.aspectRatio).toBe('0.5625 / 1');
  });

  it('does not crop when the drag began in the middle of the picture', () => {
    // The mirror case: a centre drag must not crop. Without this, a handle-zone that
    // was too generous would silently crop every time someone repositioned a clip.
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 240, 300));
    fireEvent(layer, pointer('pointerup', 240, 300));

    const calls = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.every((call) => !('crop' in (call[1] as object)))).toBe(true);
  });
});

describe('the reframe gesture (SPEC 10 §8.6 "Set framing…")', () => {
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
      setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  function stubBoxes() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  it('opens a fixed window and writes nothing until Enter', () => {
    /*
      The gesture §8.6 describes, end to end: a window that does not move, a picture dragged
      under it, and nothing written until the user commits. The draft is the point — `Esc` has to
      be able to discard a framing that was already visible on screen.

      The clip starts at **scale 2**, and that is not a convenience. A picture that exactly fills
      the window has no overhang, so its centre may not move at all without exposing canvas — the
      clamp holds it still, correctly. jsdom never loads a video, so `sourceAspect` falls back to
      the canvas's and a scale-1 clip covers exactly; only a zoomed clip has room to pan.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'a', transform: { scaleX: 2, scaleY: 2 } }])}
        fps={30}
        timeline={timeline}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set framing' }));

    expect(screen.getByTestId('preview-reframe')).toBeTruthy();
    const window_ = screen.getByTestId('preview-reframe');
    fireEvent(window_, pointer('pointerdown', 200, 300));
    fireEvent(window_, pointer('pointermove', 240, 300));
    fireEvent(window_, pointer('pointerup', 240, 300));

    // A tenth of the canvas to the right, and still nothing in the document.
    expect(timeline.setKeyframesAt).not.toHaveBeenCalled();
    expect(timeline.setItemProperties).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(timeline.setKeyframesAt).toHaveBeenCalledTimes(1);
    const [itemId, , values] = (timeline.setKeyframesAt as unknown as { mock: { calls: [string, number, Record<string, number>][] } }).mock.calls[0]!;
    expect(itemId).toBe('a');
    // All four paths in one call, which is what makes it one undo step.
    expect(Object.keys(values).sort()).toStrictEqual([
      'transform.scaleX',
      'transform.scaleY',
      'transform.x',
      'transform.y',
    ]);
    expect(values['transform.x']).toBeCloseTo(0.1, 6);
    expect(values['transform.y']).toBeCloseTo(0, 6);
  });

  it('discards the framing on Esc, writing nothing', () => {
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set framing' }));
    const window_ = screen.getByTestId('preview-reframe');
    fireEvent(window_, pointer('pointerdown', 200, 300));
    fireEvent(window_, pointer('pointermove', 300, 380));
    fireEvent(window_, pointer('pointerup', 300, 380));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(timeline.setKeyframesAt).not.toHaveBeenCalled();
    expect(screen.queryByTestId('preview-reframe')).toBeNull();
  });

  it('draws the picture from the draft, so it follows the pointer', () => {
    /*
      The half of the gesture that is not about the document at all: the *picture* has to move
      while nothing is written. A draft that the overlay tracked but the layer ignored would
      leave the outline sliding over a stationary shot — the gesture would look implemented and
      feel broken.

      Asserted on the real element, by the transform the layer computes from `itemGeometry`. The
      draft's `x` shows up as a translate fraction, and the draft's scale multiplies the picture.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'a', transform: { scaleX: 2, scaleY: 2 } }])}
        fps={30}
        timeline={timeline}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set framing' }));
    const layer_ = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    const before = layer_.style.transform;
    const window_ = screen.getByTestId('preview-reframe');
    fireEvent(window_, new MouseEvent('pointerdown', { clientX: 200, clientY: 300, bubbles: true }));
    fireEvent(window_, new MouseEvent('pointermove', { clientX: 260, clientY: 300, bubbles: true }));
    fireEvent(window_, new MouseEvent('pointerup', { clientX: 260, clientY: 300, bubbles: true }));

    const after = layer_.style.transform;
    expect(after).not.toBe(before);
    // A tenth of a step at 0.15 of the width: the translate is in percent of the canvas.
    expect(after).toContain('translate(15%');
  });

  it('writes nothing for a gesture that ended where it started', () => {
    // `Enter` on an untouched window is a way to leave the mode, not an edit.
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set framing' }));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(timeline.setKeyframesAt).not.toHaveBeenCalled();
    expect(screen.queryByTestId('preview-reframe')).toBeNull();
  });

  it('keeps the picture inside the canvas, so no empty canvas is exposed', () => {
    /*
      SPEC 13's acceptance criteria say "no empty canvas exposed", and the clamp is where that is
      enforced. A drag of nine canvas-widths must stop at the picture's own edge rather than
      sliding the shot out of the window.

      At scale 2 the picture covers 2× the canvas, so its centre may travel 0.5 before an edge
      comes inside. The 4,000-px drag below is ten canvas widths and must land exactly on 0.5.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'a', transform: { scaleX: 2, scaleY: 2 } }])}
        fps={30}
        timeline={timeline}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set framing' }));
    const window_ = screen.getByTestId('preview-reframe');
    fireEvent(window_, pointer('pointerdown', 200, 300));
    fireEvent(window_, pointer('pointermove', 4200, 300));
    fireEvent(window_, pointer('pointerup', 4200, 300));
    fireEvent.keyDown(document, { key: 'Enter' });

    const [, , values] = (timeline.setKeyframesAt as unknown as { mock: { calls: [string, number, Record<string, number>][] } }).mock.calls[0]!;
    // Half the overhang of a 2× picture, and not a pixel further.
    expect(values['transform.x']).toBeCloseTo(0.5, 6);
  });
});

describe('canvas drags follow the same auto-keyframing rule as the sidebar (SPEC 12 §2.4)', () => {
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  function stubBox() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  const dragCentre = (layer: HTMLElement) => {
    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 240, 360));
    fireEvent(layer, pointer('pointerup', 240, 360));
  };

  it('keys both position axes when the clip is already position-animated', () => {
    /*
      The rule is the same one the sliders follow: editing an animated property writes
      a key at the playhead, because the evaluator reads the keys and ignores the
      static value — so a static write here would be invisible. Both axes are keyed
      because one drag moves the clip in two: keying x and statically setting y would
      make the horizontal half animate and the vertical half snap, a diagonal path the
      user never drew.
    */
    stubBox();
    const timeline = fakeTimeline();
    const state = makeState([{ id: 'a', keyframes: { 'transform.x': [{ timeUs: 0, value: 0, interpolation: 'linear' }] } }]);
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    dragCentre(document.querySelector('[data-layer-id="a"]') as HTMLElement);

    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    /*
      The fixture's one key sits at time 0 and so does the playhead, so the writing
      branch is *update*, not insert — a duplicate key at the same time would break
      the model's "unique per property" rule. Both axes are updated even though only
      x had a key: half a gesture is not an edit.
    */
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('a', 'transform.x', 0, { value: 0.1 });
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('a', 'transform.y', 0, { value: 0.1 });
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
  });

  it('inserts keys at the playhead when it sits between existing ones', () => {
    // The insert branch: animated, but nothing keyed on this exact frame. The local
    // time is the playhead minus the clip's start, since key times are item-local.
    stubBox();
    const timeline = fakeTimeline();
    const state = makeState([
      {
        id: 'a',
        startUs: 1_000_000,
        keyframes: { 'transform.x': [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
      },
    ]);
    act(() => playheadStore.set(1_500_000));
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    dragCentre(document.querySelector('[data-layer-id="a"]') as HTMLElement);

    expect(timeline.addKeyframe).toHaveBeenCalledWith('a', 'transform.x', 500_000, 0.1);
    expect(timeline.addKeyframe).toHaveBeenCalledWith('a', 'transform.y', 500_000, 0.1);
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
    act(() => playheadStore.set(0));
  });

  it('moves the clip statically when it has no position keys', () => {
    // The other half of the rule: a drag on a never-animated clip must move it, not
    // silently start an animation.
    stubBox();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    dragCentre(document.querySelector('[data-layer-id="a"]') as HTMLElement);

    expect(timeline.setItemProperties).toHaveBeenCalledWith(['a'], { transform: { x: 0.1, y: 0.1 } });
    expect(timeline.addKeyframe).not.toHaveBeenCalled();
  });

  it('keys a crop edge that is already animated', () => {
    stubBox();
    const timeline = fakeTimeline();
    const state = makeState([
      { id: 'a', keyframes: { 'crop.left': [{ timeUs: 0, value: 0, interpolation: 'linear' }] } },
    ]);
    render(<PreviewPane state={state} fps={30} timeline={timeline} />);
    /*
      Cropping is the Crop tool's gesture now (SPEC 10 §8.6), and it goes through the frame.
      An edge on the clip itself scales one axis (§8.2) whatever the tool, so the animation rule
      is exercised on the frame's own drag.
    */
    fireEvent.click(screen.getByRole('button', { name: 'Crop tool' }));
    const frame = screen.getByTestId('preview-crop-rect');

    fireEvent(frame, pointer('pointerdown', 2, 300));
    fireEvent(frame, pointer('pointermove', 42, 300));
    fireEvent(frame, pointer('pointerup', 42, 300));
    fireEvent.keyDown(document, { key: 'Enter' });

    // A key already sits at the playhead, so this updates rather than inserting.
    expect(timeline.updateKeyframe).toHaveBeenCalledWith('a', 'crop.left', 0, { value: 0.1 });
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });
});

describe('the rotate handle and Esc (SPEC 10 §8.2, §8.3)', () => {
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  /** A 400×600 canvas with the picture filling it. */
  function stubBoxes() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      // The fit element is the picture; everything else is the canvas.
      const isFit = this.getAttribute('data-testid') === 'preview-item-fit';
      return {
        x: 0, y: 0, left: 0, top: 0,
        width: 400, height: 600, right: 400, bottom: 600,
        ...(isFit ? {} : {}),
        toJSON: () => ({}),
      } as DOMRect;
    });
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  it('shows a rotate handle only on the selected clip', () => {
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline()} />);
    expect(screen.getByTestId('preview-rotate-handle')).toBeTruthy();
    cleanup();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline(['x'])} />);
    expect(screen.queryByTestId('preview-rotate-handle')).toBeNull();
  });

  it('turns the clip as the pointer circles the pivot', () => {
    /*
      The pivot with a centred anchor is the picture's middle, (200, 300). Starting
      the drag directly above it — (200, 100) — and moving to its right — (400, 300)
      — is a quarter turn clockwise, which is what the model stores.

      A handle that measured displacement instead of angle would write something
      unrelated; one that flipped the sign would turn the picture anticlockwise while
      the pointer went clockwise, which is the most confusing failure a rotate handle
      has.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const handle = screen.getByTestId('preview-rotate-handle');

    fireEvent(handle, pointer('pointerdown', 200, 100));
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointermove', 400, 300));
    fireEvent(layer, pointer('pointerup', 400, 300));

    expect(timeline.setItemProperties).toHaveBeenCalledWith(['a'], {
      transform: { rotation: expect.closeTo(90, 4) },
    });
  });

  it('starts a rotate rather than a move, so the clip does not also translate', () => {
    // Pointer-down on the handle bubbles through the layer, which would begin a move
    // as well; the handle stops propagation so one gesture edits one property.
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const handle = screen.getByTestId('preview-rotate-handle');
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(handle, pointer('pointerdown', 200, 100));
    fireEvent(layer, pointer('pointermove', 400, 300));
    fireEvent(layer, pointer('pointerup', 400, 300));

    for (const call of (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls) {
      const patch = call[1] as { transform?: Record<string, unknown> };
      expect(patch.transform && 'x' in patch.transform, 'a rotate must not write a position').toBe(false);
    }
  });

  it('abandons the drag when Esc is pressed', () => {
    /*
      SPEC 10 §8.3: `Esc` cancels "exactly" — the picture goes back and nothing is
      written. An undo would be the wrong affordance: it would also consume a stack
      entry for an edit that never happened.
    */
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 280, 300));
    fireEvent(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The pointer comes up after the cancel; nothing may be committed.
    fireEvent(layer, pointer('pointerup', 280, 300));

    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('puts the picture back when Esc is pressed mid-drag', () => {
    // Cancelling has to drop the in-flight preview as well as skip the commit, or the
    // clip stays where the pointer left it until something else re-renders.
    stubBoxes();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 280, 300));
    expect(layer.style.transform).toContain('translate(20%');
    fireEvent(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(layer.style.transform).not.toContain('translate(20%');
    fireEvent(layer, pointer('pointerup', 280, 300));
  });
});

describe('the anchor crosshair (SPEC 10 §8.2)', () => {
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  /**
   * The canvas and the picture both measure 400×600 at the origin.
   *
   * The crosshair is aimed in reverse through the picture's transform, so the test
   * needs a real layout size (`offsetWidth`/`offsetHeight`) as well as the bounding
   * box — jsdom reports 0 for both unless they are stubbed.
   */
  function stubLayout() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
    for (const [prop, value] of [['offsetWidth', 400], ['offsetHeight', 600]] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => value,
      });
    }
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  it('sits at the picture’s centre by default', () => {
    // The default anchor is 0.5,0.5, so the crosshair starts in the middle. A missing
    // anchor must read as the centre rather than as the corner, which is what an
    // omitted field would give if the default were not applied.
    stubLayout();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline()} />);
    const crosshair = screen.getByTestId('preview-anchor');
    expect(crosshair.style.left).toBe('50%');
    expect(crosshair.style.top).toBe('50%');
  });

  it('appears only on the selected clip', () => {
    stubLayout();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline(['x'])} />);
    expect(screen.queryByTestId('preview-anchor')).toBeNull();
  });

  it('moves the pivot to where the pointer is, and nothing else', () => {
    /*
      SPEC 10 §8.2: "Drag to move the anchor without moving the item visually (the
      engine compensates position)". So the gesture writes only the two anchor
      fractions — a position write would slide the clip, which is the one thing the
      interaction promises not to do.

      Aimed a quarter of the way across and a quarter down: 100,150 of a 400×600
      picture is 0.25,0.25.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const crosshair = screen.getByTestId('preview-anchor');
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(crosshair, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 100, 150));
    fireEvent(layer, pointer('pointerup', 100, 150));

    expect(timeline.setItemProperties).toHaveBeenCalledWith(['a'], {
      transform: { anchorX: expect.closeTo(0.25, 4), anchorY: expect.closeTo(0.25, 4) },
    });
    for (const call of (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls) {
      const patch = call[1] as { transform?: Record<string, unknown> };
      expect(patch.transform && 'x' in patch.transform, 'the anchor drag must not move the clip').toBe(
        false,
      );
    }
  });

  it('writes both anchor axes together', () => {
    // The pivot is one point: a half-written pair is a pivot the user never placed,
    // and the two axes have no meaning independently.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const crosshair = screen.getByTestId('preview-anchor');
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(crosshair, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 100, 150));
    fireEvent(layer, pointer('pointerup', 100, 150));

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, unknown> };
    expect(Object.keys(patch.transform).sort()).toEqual(['anchorX', 'anchorY']);
  });

  it('commits only the anchor, never a position, when the drag ends', () => {
    /*
      The claim that matters is about the *commit*, not the in-flight state: the end
      handler is what decides whether a gesture edits one property or two. An earlier
      version of this test asserted the negative on the preview state instead, and a
      mutant that also wrote the position into the gesture's preview survived it —
      because the anchor branch never reads that field. Checking the payload that
      actually reaches the document is the only version that bites.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const crosshair = screen.getByTestId('preview-anchor');
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(crosshair, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 100, 150));
    fireEvent(layer, pointer('pointerup', 100, 150));

    expect(timeline.setItemProperties).toHaveBeenCalledTimes(1);
    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, unknown> };
    expect(Object.keys(patch.transform).sort(), 'one gesture, one property pair').toEqual([
      'anchorX',
      'anchorY',
    ]);
  });

  it('does not move the picture while the crosshair is being placed', () => {
    /*
      SPEC 10 §8.2 promises the item does not move visually. The preview state is what
      the picture is drawn from, so if the gesture wrote a position into it the clip
      would slide under the pointer while the user was aiming — the picture would
      visibly jump away from the crosshair they were dragging.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const crosshair = screen.getByTestId('preview-anchor');
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(crosshair, pointer('pointerdown', 200, 300));
    fireEvent(layer, pointer('pointermove', 100, 150));
    expect(layer.style.transform).not.toMatch(/translate\((?!0%, 0%)/);
  });
});

describe('the corner grips (SPEC 10 §8.2)', () => {
  function fakeTimeline(selection: string[] = ['a']) {
    return {
      fps: 30,
      selection,
      setItemProperties: vi.fn(() => true),
      addKeyframe: vi.fn(() => true),
    setKeyframesAt: vi.fn(() => true),
      updateKeyframe: vi.fn(() => true),
    } as unknown as import('../features/editor/use-timeline.js').TimelineApi;
  }

  function stubLayout() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400,
      toJSON: () => ({}),
    } as DOMRect);
    for (const [prop, value] of [['offsetWidth', 400], ['offsetHeight', 400]] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    }
  }

  const pointer = (type: string, clientX: number, clientY: number) =>
    new MouseEvent(type, { clientX, clientY, bubbles: true });

  it('compensates from the clip’s anchor, so a corner drag pivots where the user set', () => {
    /*
      Scaling happens about the anchor, so the compensating move has to be measured
      from it too. A centre-only shortcut is invisible with the default anchor — every
      other test here uses one — and drifts the picture on every scale once the anchor
      is off-centre.

      Same gesture as the centred case above; the committed position must differ.
    */
    const dragAt = (transform: Record<string, number>) => {
      stubLayout();
      const timeline = fakeTimeline();
      render(
        <PreviewPane
          state={makeState([{ id: 'a', transform }])}
          fps={30}
          timeline={timeline}
        />,
      );
      const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
      fireEvent(layer, pointer('pointerdown', 400, 400));
      fireEvent(layer, pointer('pointermove', 600, 600));
      fireEvent(layer, pointer('pointerup', 600, 600));
      const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![1] as { transform: Record<string, number> };
      return patch.transform;
    };

    const centred = dragAt({});
    cleanup();
    const offCentre = dragAt({ anchorX: 0.25, anchorY: 0.25 });

    expect(offCentre.scaleX).toBeCloseTo(centred.scaleX!, 6);
    expect(offCentre.x).not.toBeCloseTo(centred.x!, 4);
  });

  it('turns the compensation by the clip’s angle', () => {
    /*
      The compensating move is the anchor-to-content arm *rotated into screen axes*, so
      a turned clip has to move along a different diagonal than an upright one. Passing
      the rotation through as zero is invisible while the clip is upright — which is
      every other test here.
    */
    const dragAt = (transform: Record<string, number>) => {
      stubLayout();
      const timeline = fakeTimeline();
      render(
        <PreviewPane
          state={makeState([{ id: 'a', transform }])}
          fps={30}
          timeline={timeline}
        />,
      );
      const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
      fireEvent(layer, pointer('pointerdown', 400, 400));
      fireEvent(layer, pointer('pointermove', 600, 600));
      fireEvent(layer, pointer('pointerup', 600, 600));
      const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![1] as { transform: Record<string, number> };
      return patch.transform;
    };

    const upright = dragAt({});
    cleanup();
    const turned = dragAt({ rotation: 90 });

    // Same scale either way — the factor is a distance and angles do not change it.
    expect(turned.scaleX).toBeCloseTo(upright.scaleX!, 6);
    // But the shift is along a different diagonal: a quarter turn swaps its components.
    expect(turned.x!).toBeCloseTo(upright.y!, 4);
    expect(turned.y!).toBeCloseTo(upright.x!, 4);
  });

  it('locks a Shift move to one axis', () => {
    /*
      SPEC 10 §8.2: `Shift` locks the body drag to the dominant axis. Without it a
      horizontal drag that wobbles a few pixels vertically nudges the clip off its
      line, which is the whole reason the modifier exists.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    const down = new MouseEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true });
    fireEvent(layer, down);
    // A long horizontal pull with a small vertical drift, Shift held throughout.
    fireEvent(
      layer,
      new MouseEvent('pointermove', { clientX: 300, clientY: 210, shiftKey: true, bubbles: true }),
    );
    fireEvent(
      layer,
      new MouseEvent('pointerup', { clientX: 300, clientY: 210, shiftKey: true, bubbles: true }),
    );

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.x).toBeGreaterThan(0);
    // The vertical drift is discarded entirely, not merely reduced.
    expect(patch.transform.y).toBe(0);
  });

  it('does not lock an unmodified move', () => {
    // The lock is the modifier's job, so the same drag without Shift keeps both axes.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, new MouseEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true }));
    fireEvent(layer, new MouseEvent('pointermove', { clientX: 300, clientY: 210, bubbles: true }));
    fireEvent(layer, new MouseEvent('pointerup', { clientX: 300, clientY: 210, bubbles: true }));

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.y).not.toBe(0);
  });

  it('snaps a Shift rotation to a 15° step', () => {
    /*
      Dragging the handle off the top of the clip by a few degrees with `Shift` held
      must land on a step, not on the raw angle the pointer happened to be at.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const handle = screen.getByTestId('preview-rotate-handle');
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    // Pivot is the picture's centre (200,200). Straight up is 0°; a pointer 20° off it
    // is a small drag that must land on a multiple of 15.
    fireEvent(handle, new MouseEvent('pointerdown', { clientX: 200, clientY: 50, bubbles: true }));
    fireEvent(
      layer,
      new MouseEvent('pointermove', { clientX: 250, clientY: 60, shiftKey: true, bubbles: true }),
    );
    fireEvent(
      layer,
      new MouseEvent('pointerup', { clientX: 250, clientY: 60, shiftKey: true, bubbles: true }),
    );

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    const rotation = patch.transform.rotation!;
    expect(rotation % 15).toBe(0);
    expect(rotation).not.toBe(0);
  });

  it('toggles a Shift corner drag to free scale', () => {
    /*
      SPEC 10 §8.2: `Shift` toggles the corner handle from uniform to free scale. A
      vertical-only pull is the clearest probe — uniform scaling would change both
      axes equally, free scaling changes only the one pulled.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, new MouseEvent('pointerdown', { clientX: 400, clientY: 400, bubbles: true }));
    fireEvent(
      layer,
      new MouseEvent('pointermove', { clientX: 400, clientY: 600, shiftKey: true, bubbles: true }),
    );
    fireEvent(
      layer,
      new MouseEvent('pointerup', { clientX: 400, clientY: 600, shiftKey: true, bubbles: true }),
    );

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    // The vertical pull stretches height and leaves width at its start value.
    expect(patch.transform.scaleY!).toBeGreaterThan(1.2);
    expect(patch.transform.scaleX!).toBeCloseTo(1, 2);
  });

  it('scales about the centre when Alt is held', () => {
    /*
      `Alt` holds the picture's centre still instead of the opposite corner, so with a
      centred anchor the position must not move at all — where the same drag without
      Alt shifts it by a quarter canvas.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, new MouseEvent('pointerdown', { clientX: 400, clientY: 400, bubbles: true }));
    fireEvent(
      layer,
      new MouseEvent('pointermove', { clientX: 600, clientY: 600, altKey: true, bubbles: true }),
    );
    fireEvent(
      layer,
      new MouseEvent('pointerup', { clientX: 600, clientY: 600, altKey: true, bubbles: true }),
    );

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.scaleX!).toBeGreaterThan(1);
    expect(patch.transform.x!).toBeCloseTo(0, 6);
    expect(patch.transform.y!).toBeCloseTo(0, 6);
  });

  it('draws four grips, one per corner', () => {
    stubLayout();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline()} />);
    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      expect(screen.getByTestId(`preview-corner-${corner}`)).toBeTruthy();
    }
  });

  it('draws them only on the selected clip', () => {
    stubLayout();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={fakeTimeline(['x'])} />);
    expect(screen.queryByTestId('preview-corner-nw')).toBeNull();
  });

  it('scales both axes and the position in one commit', () => {
    /*
      A corner drag is one gesture over three fields. Writing the scale without the
      compensating position would slide the corner the user is holding still; writing
      only one axis would shear the picture, which a uniform handle must never do.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    // Grab the south-east corner at (400,400) and pull it to (600,600): the distance
    // from the fixed north-west corner goes 566 → 849, a factor of 1.5.
    fireEvent(layer, pointer('pointerdown', 400, 400));
    fireEvent(layer, pointer('pointermove', 600, 600));
    fireEvent(layer, pointer('pointerup', 600, 600));

    expect(timeline.setItemProperties).toHaveBeenCalledTimes(1);
    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(Object.keys(patch.transform).sort()).toEqual(['scale', 'scaleX', 'scaleY', 'x', 'y']);
    expect(patch.transform.scaleX).toBeCloseTo(1.5, 2);
    expect(patch.transform.scaleY).toBeCloseTo(1.5, 2);
    /*
      And the position must actually have been compensated, not merely included. A
      mutant that dropped the compensation still committed the same two keys, so
      asserting the key list alone let it through.

      Here the dragged corner is south-east, so the corner that stays put is
      north-west, and growing about it pushes the centre TOWARD the dragged corner:
      down and right, positive. A 400x400 picture at 1.5 is 600 across, so the centre
      travels half its own width from the fixed corner, 100 px - 0.25 of the 400 px
      canvas.
    */
    expect(Number.isFinite(patch.transform.x!)).toBe(true);
    expect(patch.transform.x!).toBeCloseTo(0.25, 3);
    expect(patch.transform.y!).toBeCloseTo(0.25, 3);
  });

  it('scales evenly even when the clip started non-uniform', () => {
    /*
      A corner handle is a *uniform* scale, so a clip at 2×1 becomes 3×1.5 rather than
      snapping to square. Multiplying the existing axes is the only reading that does
      not silently discard the shape the user set in the inspector.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(
      <PreviewPane
        state={makeState([{ id: 'a', transform: { scaleX: 2, scaleY: 1 } }])}
        fps={30}
        timeline={timeline}
      />,
    );
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    fireEvent(layer, pointer('pointerdown', 400, 400));
    fireEvent(layer, pointer('pointermove', 600, 600));
    fireEvent(layer, pointer('pointerup', 600, 600));

    const patch = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { transform: Record<string, number> };
    expect(patch.transform.scaleX! / patch.transform.scaleY!).toBeCloseTo(2, 4);
  });

  it('writes nothing when the corner is grabbed and released in place', () => {
    // A click on a corner is not an edit; committing it would cost an undo step.
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 400, 400));
    fireEvent(layer, pointer('pointerup', 400, 400));
    expect(timeline.setItemProperties).not.toHaveBeenCalled();
  });

  it('keeps the edge gesture on the clip once cropping has a frame of its own', () => {
    /*
      Under the Crop tool the clip's own edge is *no longer* a crop gesture (SPEC 10 §8.6):
      cropping moved to the frame, so a press on the clip's edge has to fall through to the
      per-axis scale of §8.2.

      That leaves exactly one crop path rather than two overlapping hit tests, which matters
      because they disagree: the old one wrote on pointer-up, while the frame drafts until
      `Enter`. Both being live meant a drag near the edge could be committed by one and then
      reverted by the other's `Esc`.
    */
    stubLayout();
    const timeline = fakeTimeline();
    render(<PreviewPane state={makeState([{ id: 'a' }])} fps={30} timeline={timeline} />);
    fireEvent.click(screen.getByRole('button', { name: 'Crop tool' }));
    const layer = document.querySelector('[data-layer-id="a"]') as HTMLElement;

    fireEvent(layer, pointer('pointerdown', 400, 200));
    fireEvent(layer, pointer('pointermove', 300, 200));
    fireEvent(layer, pointer('pointerup', 300, 200));

    // A scale writes the transform, never a crop.
    const calls = (timeline.setItemProperties as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.every((call) => !('crop' in (call[1] as object)))).toBe(true);
    expect(timeline.setItemProperties).toHaveBeenCalledWith(['a'], {
      transform: expect.objectContaining({ scaleX: expect.any(Number) }),
    });
  });
});
