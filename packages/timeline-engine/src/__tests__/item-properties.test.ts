/**
 * SPEC 09 §17, SPEC 12 §6.2 — editing the properties the inspector shows.
 *
 * Every one of these properties existed on the item and in the file format with no
 * command to change it, which made the inspector's disabled volume slider the honest
 * state of the app. The tests here are mostly about the *validation*: the schema
 * clamps on load, so a value that slips through is not a bad render — it is a
 * composition that refuses to open, and the user loses the whole project rather than
 * one gesture.
 */
import { describe, expect, it } from 'vitest';
import {
  createDefaultTimeline,
  createMediaItem,
  setItemProperties,
  type TimelineState,
} from '../index.js';
import { enablePatches } from 'immer';

enablePatches();

function makeState(): TimelineState {
  const base = createDefaultTimeline({ id: 'tl', name: 'Clip', fps: 30 });
  const track = base.tracks.find((candidate) => candidate.role === 'main')!;
  const item = createMediaItem({
    id: 'item-1',
    trackId: track.id,
    label: 'Opening',
    mediaId: 'media-1',
    type: 'video',
    startUs: 0,
    durationUs: 4_000_000,
    sourceDurationUs: 10_000_000,
  });
  return {
    ...base,
    tracks: base.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, itemIds: [item.id] } : candidate,
    ),
    items: { [item.id]: item },
  } as TimelineState;
}

const set = (state: TimelineState, patch: Parameters<typeof setItemProperties>[1]['patch']) =>
  setItemProperties(state, { itemIds: ['item-1'], patch, fps: 30 });

describe('setItemProperties', () => {
  it('sets opacity', () => {
    const result = set(makeState(), { opacity: 0.4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['item-1']!.opacity).toBe(0.4);
  });

  it('sets level, pan and speed', () => {
    const result = set(makeState(), { volumeDb: -12, gainDb: 3, pan: -40, speed: 1.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.state.items['item-1']!;
    expect(item.volumeDb).toBe(-12);
    expect(item.gainDb).toBe(3);
    expect(item.pan).toBe(-40);
    expect(item.speed).toBe(1.5);
  });

  it('sets fades and the fade curve', () => {
    const result = set(makeState(), { fadeInUs: 250_000, fadeOutUs: 250_000, fadeCurve: 'linear' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['item-1']!.fadeInUs).toBe(250_000);
    expect(result.state.items['item-1']!.fadeCurve).toBe('linear');
  });

  it('rounds a fade to a whole microsecond', () => {
    // Sub-microsecond values in the file would make two identical edits compare
    // unequal.
    const result = set(makeState(), { fadeInUs: 1000.7 });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.items['item-1']!.fadeInUs).toBe(1001);
  });

  it('merges a crop per edge, so editing one side keeps the others', () => {
    const first = set(makeState(), { crop: { left: 0.1 } });
    if (!first.ok) throw new Error(first.message);
    const second = setItemProperties(first.state, {
      itemIds: ['item-1'],
      patch: { crop: { right: 0.2 } },
      fps: 30,
    });
    if (!second.ok) throw new Error(second.message);
    const crop = second.state.items['item-1']!.crop;
    expect(crop.left).toBe(0.1);
    expect(crop.right).toBe(0.2);
    expect(crop.top).toBe(0);
  });

  it('merges a transform per field', () => {
    const first = set(makeState(), { transform: { x: 40 } });
    if (!first.ok) throw new Error(first.message);
    const second = setItemProperties(first.state, {
      itemIds: ['item-1'],
      patch: { transform: { rotation: 15 } },
      fps: 30,
    });
    if (!second.ok) throw new Error(second.message);
    const transform = second.state.items['item-1']!.transform;
    expect(transform.x).toBe(40);
    expect(transform.rotation).toBe(15);
    expect(transform.scaleX).toBe(1);
  });

  it('reports the bars as inverted patches, so undo restores the old value', () => {
    const state = makeState();
    const result = set(state, { opacity: 0.25 });
    if (!result.ok) throw new Error(result.message);
    expect(result.patches.length).toBeGreaterThan(0);
    expect(result.inverse.length).toBeGreaterThan(0);
  });
});

describe('setItemProperties validation', () => {
  const rejects = (patch: Parameters<typeof set>[1], text: string) => {
    const result = set(makeState(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(text);
  };

  it('refuses an opacity outside 0–1', () => {
    // The schema would reject this on the next load, and the user would lose the
    // composition rather than the gesture.
    rejects({ opacity: 1.5 }, 'Opacity');
    rejects({ opacity: -0.1 }, 'Opacity');
  });

  it('refuses a volume the slider cannot reach', () => {
    rejects({ volumeDb: 20 }, 'Volume');
    rejects({ volumeDb: -80 }, 'Volume');
  });

  it('refuses a gain beyond the clip-gain range', () => {
    rejects({ gainDb: 30 }, 'Gain');
  });

  it('refuses a pan beyond hard left or right', () => {
    rejects({ pan: -150 }, 'Pan');
  });

  it('refuses a speed outside 0.1×–8×', () => {
    rejects({ speed: 0 }, 'Speed');
    rejects({ speed: 12 }, 'Speed');
  });

  it('refuses fades longer than half the clip', () => {
    // Two fades each covering more than half overlap, and on a short clip the
    // overlap makes the fade fight itself.
    rejects({ fadeInUs: 3_000_000 }, 'half the clip');
  });

  it('allows fades that exactly fill half the clip', () => {
    const result = set(makeState(), { fadeInUs: 1_000_000, fadeOutUs: 1_000_000 });
    expect(result.ok).toBe(true);
  });

  it('refuses crop edges that leave no picture', () => {
    rejects({ crop: { left: 0.6, right: 0.5 } }, 'crop edges');
  });

  it('refuses a negative crop edge', () => {
    rejects({ crop: { left: -0.1 } }, 'negative');
  });

  it('says so when nothing is selected', () => {
    const result = setItemProperties(makeState(), { itemIds: [], patch: { opacity: 0.5 }, fps: 30 });
    expect(result.ok).toBe(false);
  });

  it('refuses to edit a clip on a locked track', () => {
    const state = makeState();
    const locked = {
      ...state,
      tracks: state.tracks.map((track) =>
        track.role === 'main' ? { ...track, locked: true } : track,
      ),
    } as TimelineState;
    const result = setItemProperties(locked, { itemIds: ['item-1'], patch: { opacity: 0.5 }, fps: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('locked');
  });
});

describe('setItemProperties across a selection', () => {
  it('applies to every selected clip', () => {
    const state = makeState();
    const track = state.tracks.find((candidate) => candidate.role === 'main')!;
    const second = createMediaItem({
      id: 'item-2',
      trackId: track.id,
      label: 'Second',
      mediaId: 'media-2',
      type: 'video',
      startUs: 4_000_000,
      durationUs: 2_000_000,
      sourceDurationUs: 10_000_000,
    });
    const withTwo = {
      ...state,
      items: { ...state.items, [second.id]: second },
    } as TimelineState;

    const result = setItemProperties(withTwo, {
      itemIds: ['item-1', 'item-2'],
      patch: { opacity: 0.5 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['item-1']!.opacity).toBe(0.5);
    expect(result.state.items['item-2']!.opacity).toBe(0.5);
    expect(result.affectedItemIds).toEqual(['item-1', 'item-2']);
  });

  it('skips an id that no longer exists rather than failing the whole edit', () => {
    const result = setItemProperties(makeState(), {
      itemIds: ['item-1', 'ghost'],
      patch: { opacity: 0.5 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.affectedItemIds).toEqual(['item-1']);
  });
});
