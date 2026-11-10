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
  addShapeItem,
  createDefaultTimeline,
  createMediaItem,
  setItemProperties,
  type TimelineState,
} from '../index.js';
import { applyPatches, enablePatches } from 'immer';

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

  /*
    Shapes and icons (SPEC 11 §12). Both were settable only at creation: a user who wanted
    a star instead of a rectangle, or a heavier outline than the picker's default, had to
    delete the item and add it again. The fields were in the schema, drawn by both
    renderers and exported; the command simply had no way to write them.
  */
  it('changes a shape\'s kind', () => {
    const state = makeState();
    const added = addShapeItem(state, { id: 'shape-1', shapeKind: 'rect', startUs: 0, fps: 30 });
    if (!added.ok) throw new Error(added.message);
    const result = setItemProperties(added.state, {
      itemIds: ['shape-1'],
      patch: { shapeKind: 'star' },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['shape-1']!.shapeKind).toBe('star');
  });

  it('changes an icon\'s stroke width', () => {
    const state = makeState();
    const added = addShapeItem(state, { id: 'ico-1', iconName: 'star', startUs: 0, fps: 30 });
    if (!added.ok) throw new Error(added.message);
    const result = setItemProperties(added.state, {
      itemIds: ['ico-1'],
      patch: { iconStrokeWidth: 3.5 },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['ico-1']!.iconStrokeWidth).toBe(3.5);
  });

  it('refuses a stroke width the picker could not produce', () => {
    /*
      The schema's own range, enforced with a message rather than by letting the patch
      throw inside `produceWithPatches`. A slider cannot leave 0.5–4; a corrupted project
      or a future caller can, and the difference between the two failures is whether the
      user is told why nothing happened.
    */
    const state = makeState();
    const added = addShapeItem(state, { id: 'ico-2', iconName: 'star', startUs: 0, fps: 30 });
    if (!added.ok) throw new Error(added.message);
    for (const width of [0.4, 4.5, Number.NaN]) {
      const result = setItemProperties(added.state, {
        itemIds: ['ico-2'],
        patch: { iconStrokeWidth: width },
        fps: 30,
      });
      expect(result.ok, `width ${width}`).toBe(false);
    }
  });

  it('refuses to give an icon a shape kind as well', () => {
    /*
      An item with both would leave two renderers free to disagree about which geometry
      wins — the same reason `addShapeItem` refuses an icon with a kind. Refused rather
      than resolved by precedence, because whichever precedence is chosen, the file
      describes something the UI cannot have made.
    */
    const state = makeState();
    const added = addShapeItem(state, { id: 'ico-3', iconName: 'star', startUs: 0, fps: 30 });
    if (!added.ok) throw new Error(added.message);
    const result = setItemProperties(added.state, {
      itemIds: ['ico-3'],
      patch: { shapeKind: 'rect' },
      fps: 30,
    });
    expect(result.ok).toBe(false);
  });

  it('changes which icon an item draws, and drops the old stored geometry', () => {
    /*
      The last piece of the same gap: the picker was an "add" flow, so turning a star into a
      heart meant deleting the item and losing its timing.
    */
    const state = makeState();
    const added = addShapeItem(state, {
      id: 'ico-4',
      iconName: 'star',
      iconShapes: [{ t: 'path', d: 'M0 0 L10 10' }],
      startUs: 0,
      fps: 30,
    });
    if (!added.ok) throw new Error(added.message);

    const result = setItemProperties(added.state, {
      itemIds: ['ico-4'],
      patch: { iconName: 'heart' },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.state.items['ico-4']!;
    expect(item.iconName).toBe('heart');
    /*
      `iconShapes` is cleared, and this is the assertion that matters. Stored geometry is
      the escape hatch for a file opened by a build with a different Lucide set; keeping a
      star's paths on an item now named `heart` would draw the star while the picker showed
      the heart selected — the same "the control and the picture disagree" failure this
      feature keeps producing.
    */
    expect(item.iconShapes).toBeUndefined();
  });

  it('refuses an icon name on a shape or on a clip with no geometry', () => {
    // The other direction of the exclusivity rule: an item must not acquire two sources
    // of geometry, and a video must not gain an icon it has nowhere to draw.
    const state = makeState();
    const shape = addShapeItem(state, { id: 'shape-2', shapeKind: 'rect', startUs: 0, fps: 30 });
    if (!shape.ok) throw new Error(shape.message);
    expect(
      setItemProperties(shape.state, {
        itemIds: ['shape-2'],
        patch: { iconName: 'star' },
        fps: 30,
      }).ok,
    ).toBe(false);

    // `item-1` is the fixture's video clip: no `iconName`, no `shapeKind`.
    expect(
      setItemProperties(makeState(), {
        itemIds: ['item-1'],
        patch: { iconName: 'star' },
        fps: 30,
      }).ok,
    ).toBe(false);
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

describe('noise reduction on an item (SPEC 12 §6.8)', () => {
  /*
    The field is what makes the cleaned copy reachable: the preview and the export both read the
    item, so a job whose result lived only in the inspector would produce a preview that sounded
    cleaned and a file that did not. These tests are about the two transitions that matter — apply,
    and revert — and about revert being a real command rather than a mutation of a hidden copy.
  */

  it('applies a cleaned copy to the item that asked for it', () => {
    const state = makeState();
    const result = setItemProperties(state, {
      itemIds: ['item-1'],
      patch: {
        noiseReduction: {
          strength: 'high',
          path: '/project/derived/enhanced/abc.wav',
          method: 'afftdn',
        },
      },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['item-1']!.noiseReduction).toEqual({
      strength: 'high',
      path: '/project/derived/enhanced/abc.wav',
      method: 'afftdn',
    });
  });

  it('reverts by clearing the field, and leaves no null behind', () => {
    /*
      `undefined`, not `null`. The schema distinguishes absent from null, and a project carrying
      `noiseReduction: null` would read as "has this field" to every `!== undefined` check
      downstream — which is the sort of difference that only shows up in a saved file.
    */
    const withCopy = setItemProperties(makeState(), {
      itemIds: ['item-1'],
      patch: { noiseReduction: { strength: 'low', path: '/x.wav' } },
      fps: 30,
    });
    expect(withCopy.ok).toBe(true);
    if (!withCopy.ok) return;

    const reverted = setItemProperties(withCopy.state, {
      itemIds: ['item-1'],
      patch: { noiseReduction: null },
      fps: 30,
    });
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    /*
      `toBeUndefined` alone would pass on a null too, and `'noiseReduction' in item` passes for an
      assigned `undefined` — both were checked and neither distinguishes the two states. What
      distinguishes them is the *value*: a revert that wrote `null` would survive `toBeUndefined`'s
      sibling (`toBeNull`) and neither of these, so this asserts the value is exactly `undefined`
      and says why, rather than asserting a property that is true either way.
    */
    expect(reverted.state.items['item-1']!.noiseReduction).toBeUndefined();
    /*
      And the round trip that would catch a `null`: the schema's own parse. A project with
      `noiseReduction: null` fails `.optional()`'s object shape at the type level and would be
      preserved as null by `.passthrough()` — so the check that matters is what a save writes.
    */
    const serialised = JSON.stringify(reverted.state.items['item-1']);
    expect(serialised).not.toContain('noiseReduction":null');
  });

  it('is undoable, because a revert the user cannot take back is a trap', () => {
    /*
      Revert is safe on disk — the original was never written to — but it is still an edit to the
      project: the item goes back to playing different audio. Undo is what makes that a decision
      the user can change their mind about rather than a one-way door.
    */
    const applied = setItemProperties(makeState(), {
      itemIds: ['item-1'],
      patch: { noiseReduction: { strength: 'medium', path: '/y.wav' } },
      fps: 30,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const reverted = setItemProperties(applied.state, {
      itemIds: ['item-1'],
      patch: { noiseReduction: null },
      fps: 30,
    });
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    /* The inverse patches, replayed, put the copy back. */
    const restored = applyPatches(reverted.state, reverted.inverse);
    expect(restored.items['item-1']!.noiseReduction?.path).toBe('/y.wav');
  });

  it('leaves other items alone when one is cleaned', () => {
    const state = makeState();
    const second = createMediaItem({
      id: 'item-2',
      trackId: state.items['item-1']!.trackId,
      label: 'Second',
      mediaId: 'media-2',
      startUs: state.items['item-1']!.startUs + state.items['item-1']!.durationUs,
      durationUs: 1_000_000,
      sourceDurationUs: 1_000_000,
    });
    const twoItems: TimelineState = { ...state, items: { ...state.items, 'item-2': second } };
    const result = setItemProperties(twoItems, {
      itemIds: ['item-1'],
      patch: { noiseReduction: { strength: 'low', path: '/z.wav' } },
      fps: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items['item-2']!.noiseReduction).toBeUndefined();
  });
});
