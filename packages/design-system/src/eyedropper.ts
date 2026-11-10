/**
 * The eyedropper (SPEC 01 §ColourPicker: "Swatches + hue/alpha + hex input + eyedropper **where
 * supported**; recent colours").
 *
 * "Where supported" is the whole design. `EyeDropper` is a Chromium API — present in the Electron
 * build this app ships and absent everywhere else — so a picker that assumed it would throw on
 * every other surface, and one that hid the control entirely would be a control the Electron user
 * never sees. The module therefore answers a single question — *can this environment pick a colour
 * off the screen?* — and the picker draws the button or does not.
 *
 * ## Why this is its own module
 *
 * The API is a constructor that must be called from a user gesture and returns a promise that
 * resolves to `{ sRGBHex }`, or rejects when the user presses Esc. That rejection is the case
 * worth pinning: it is **not an error**, it is a cancellation, and a picker that showed "Could
 * not pick a colour" on every Esc would train users to fear the button. jsdom has no `EyeDropper`,
 * so the whole path is exercised through an injected constructor rather than a browser.
 */

/** The shape `EyeDropper` resolves to. */
export interface EyeDropperResult {
  sRGBHex: string;
}

/** The constructor as this module uses it, narrowed to what it needs. */
export interface EyeDropperLike {
  open: () => Promise<EyeDropperResult>;
}

export interface EyeDropperConstructor {
  new (): EyeDropperLike;
}

/** What `pickColour` answers, in the three cases a caller must tell apart. */
export type PickResult =
  | { status: 'picked'; hex: string }
  | { status: 'cancelled' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string };

/**
 * The environment's eyedropper, or `undefined` when it has none.
 *
 * Read through `globalThis` rather than `window` so the module is usable — and testable — outside
 * a DOM. The cast is deliberate and narrow: TypeScript's DOM lib has no `EyeDropper`, because the
 * API is not a web standard, so there is nothing to import and nothing to widen.
 */
export function getEyeDropper(): EyeDropperConstructor | undefined {
  const candidate = (globalThis as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  return typeof candidate === 'function' ? candidate : undefined;
}

/** Whether the picker should draw its eyedropper button at all. */
export function canPickFromScreen(): boolean {
  return getEyeDropper() !== undefined;
}

/**
 * Normalise whatever the API returned to the `#RRGGBB` the rest of the app stores.
 *
 * The API is specified to return sRGB hex, but a picker that writes an unvalidated string into a
 * colour field is one bad value away from an invalid project — and the field accepts typed input
 * too, so the two paths must agree about what a colour looks like. Anything that is not six hex
 * digits after a `#` is refused rather than coerced: a guessed colour is worse than no colour.
 */
export function normalisePickedHex(hex: string): string | undefined {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1]!.toUpperCase()}` : undefined;
}

/**
 * Ask the user to pick a colour off the screen.
 *
 * Must be called from a user gesture — that is the API's rule, not this module's, and it is why
 * this is a function the button calls rather than something that runs on mount.
 *
 * `Constructor` is injected so the three non-picked outcomes can be tested without a browser:
 * the real one on a machine that has Chromium, a stub that rejects with `AbortError` for Esc, and
 * `undefined` for every other surface.
 */
export async function pickColour(
  Constructor: EyeDropperConstructor | undefined = getEyeDropper(),
): Promise<PickResult> {
  if (!Constructor) return { status: 'unsupported' };
  try {
    const result = await new Constructor().open();
    const hex = normalisePickedHex(result.sRGBHex);
    /*
      A result that is not a colour is a *failure*, not a cancellation: the user did pick
      something, and the app could not read it. Saying "cancelled" would leave them clicking the
      same spot again.
    */
    return hex ? { status: 'picked', hex } : { status: 'failed', message: 'That screen colour could not be read.' };
  } catch (error) {
    /*
      Esc rejects with `AbortError`, which is the user's decision and never an error. Chromium
      reports it through `name`, and some builds through the message, so both are checked — a
      cancellation that surfaced as a red message is exactly the sort of small betrayal that
      makes a feature feel unreliable.
    */
    if (isAbort(error)) return { status: 'cancelled' };
    const message = error instanceof Error ? error.message : '';
    return message
      ? { status: 'failed', message }
      : { status: 'failed', message: 'The screen colour picker is unavailable right now.' };
  }
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /abort|cancel/i.test(message);
}
