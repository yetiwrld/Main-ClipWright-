/**
 * The eyedropper (SPEC 01 §ColourPicker, "where supported").
 *
 * The API is Chromium-only, so every branch here is exercised through an injected constructor:
 * jsdom has no `EyeDropper` at all, and a test that needed a real browser could not run in CI at
 * all. The cases that matter are the *negative* ones, because they are what a naive
 * implementation gets wrong:
 *
 * - **Esc is a cancellation, not an error.** It rejects with `AbortError`, and showing "could not
 *   pick a colour" on every Esc teaches users the button is unreliable.
 * - **No API means no button.** A disabled control is a promise the feature works somewhere; on a
 *   surface without the API it never will.
 * - **A non-colour result is a failure, not a cancellation.** The user did pick something.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  canPickFromScreen,
  getEyeDropper,
  normalisePickedHex,
  pickColour,
  type EyeDropperConstructor,
} from '../eyedropper.js';

/** A constructor whose `open()` settles however the test says. */
function stub(open: () => Promise<{ sRGBHex: string }>): EyeDropperConstructor {
  return class {
    open = open;
  } as unknown as EyeDropperConstructor;
}

describe('the eyedropper', () => {
  it('returns the picked colour, normalised', async () => {
    // The API is specified to return sRGB hex, and the app stores uppercase `#RRGGBB`. A picked
    // colour and a typed one therefore look the same in the project file.
    const result = await pickColour(stub(async () => ({ sRGBHex: '#ff7a00' })));
    expect(result).toEqual({ status: 'picked', hex: '#FF7A00' });
  });

  it('treats Esc as a cancellation and says nothing', async () => {
    /*
      This is the case that decides whether the feature feels solid. Cancelling is what the user
      asked for; a red message on every Esc trains them to distrust the button.
    */
    const abort = Object.assign(new Error('The user canceled the selection.'), { name: 'AbortError' });
    const result = await pickColour(
      stub(async () => {
        throw abort;
      }),
    );
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('recognises a cancellation from its name alone', async () => {
    /*
      Chromium's usual shape: an `AbortError` whose message says nothing about cancelling. The
      first version of this fixture also had "canceled" in the message, so it passed with the
      name check deleted — the two paths were not tested separately, and only one of them was
      actually load-bearing.
    */
    const abort = Object.assign(new Error('User pressed Escape.'), { name: 'AbortError' });
    const result = await pickColour(
      stub(async () => {
        throw abort;
      }),
    );
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('recognises a cancellation reported only through the message', async () => {
    // Chromium has reported the abort both ways across versions, and a cancellation that came out
    // as a failure would be a bug nobody could reproduce on demand.
    const result = await pickColour(
      stub(async () => {
        throw new Error('Selection cancelled');
      }),
    );
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('reports a genuine failure with its message', async () => {
    // A screen-capture permission refusal is not a cancellation and the user needs to read why.
    const result = await pickColour(
      stub(async () => {
        throw new Error('Screen capture is blocked.');
      }),
    );
    expect(result).toEqual({ status: 'failed', message: 'Screen capture is blocked.' });
  });

  it('reports a result that is not a colour as a failure, not a cancellation', async () => {
    /*
      Distinguishing these matters: "cancelled" tells the user nothing happened and they will try
      again in the same place; "that colour could not be read" tells them the app is at fault.
    */
    const result = await pickColour(stub(async () => ({ sRGBHex: 'not-a-colour' })));
    expect(result.status).toBe('failed');
  });

  it('answers “unsupported” rather than throwing where the API does not exist', async () => {
    // The renderer also runs in a plain browser during UI work, and in CI.
    expect(await pickColour(undefined)).toEqual({ status: 'unsupported' });
  });

  it('reports support from the environment, not from a build flag', () => {
    /*
      Read at call time so a test — or a future Electron upgrade — changes the answer without a
      rebuild. `getEyeDropper` is the single place that knows the global's name.
    */
    expect(canPickFromScreen()).toBe(false);
    expect(getEyeDropper()).toBeUndefined();
    const global = globalThis as { EyeDropper?: unknown };
    const original = global.EyeDropper;
    global.EyeDropper = stub(async () => ({ sRGBHex: '#000000' }));
    try {
      expect(canPickFromScreen()).toBe(true);
    } finally {
      global.EyeDropper = original;
    }
  });

  it('accepts a colour with or without its hash, and refuses anything else', () => {
    /*
      The picked value and the typed value go through the same check, so a picker that wrote an
      unvalidated string could put a bad colour into a project — and the schema would then refuse
      the whole style, which looks like the picker being broken.
    */
    expect(normalisePickedHex('#4DA3FF')).toBe('#4DA3FF');
    expect(normalisePickedHex('4da3ff')).toBe('#4DA3FF');
    expect(normalisePickedHex('  #4DA3FF  ')).toBe('#4DA3FF');
    expect(normalisePickedHex('#FFF')).toBeUndefined();
    expect(normalisePickedHex('rgb(1,2,3)')).toBeUndefined();
  });
});
