/**
 * Recent colours (SPEC 01 §ColourPicker: "recent colours").
 *
 * A colour field is used in a burst -- a user picks a background, then an outline a shade darker,
 * then the original again -- and a recent-colours strip exists so that second visit does not mean
 * retyping a hex. The whole value is therefore in **recency**, not in uniqueness, which is what
 * makes the list's ordering the interesting part:
 *
 * - Picking a colour already in the list **moves it to the front** rather than adding a second
 *   copy. A list that accumulated duplicates would push the genuinely-older colours out first and
 *   end up shorter than its own limit for no reason.
 * - The comparison is case-insensitive and normalises to `#RRGGBB`, because the same colour arrives
 *   spelled three ways: `#ff7a00` from the colour input, `#FF7A00` from the hex field (which
 *   uppercases), and `ff7a00` from a paste. Three entries for one colour is the failure this
 *   prevents.
 * - Nothing is added until the value is a *complete* colour. A hex field commits on every
 *   keystroke, so recording as the user types would fill the strip with `#F`, `#FF`, `#FF7` — and
 *   the strip is short enough that half-typed prefixes would be most of it.
 */

/** How many recent colours a picker keeps. Six fits beside the preset swatches without wrapping. */
export const RECENT_LIMIT = 6;

/**
 * Normalise a colour to `#RRGGBB`, or `undefined` when it is not one.
 *
 * Three-digit shorthand is expanded because `#f80` is a colour a user can type and `#FF8800` is
 * what it means — refusing it would make the field silently drop a valid entry.
 */
export function normaliseHex(input: string): string | undefined {
  const trimmed = input.trim();
  const long = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (long) return `#${long[1]!.toUpperCase()}`;
  const short = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1]!.split('');
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return undefined;
}

/**
 * Add a colour to the recents, newest first.
 *
 * Returns the **same array** when the colour is already at the front, so a component can use the
 * return value as a change signal without re-rendering on every keystroke of an unchanged colour.
 * That matters here because the field commits per keystroke: `#FF7A00` typed past its own value
 * would otherwise produce six renders and six identical lists.
 */
export function addRecentColour(recents: readonly string[], input: string): readonly string[] {
  const hex = normaliseHex(input);
  if (!hex) return recents;
  if (recents[0] === hex) return recents;
  return [hex, ...recents.filter((entry) => entry !== hex)].slice(0, RECENT_LIMIT);
}

/**
 * Merge two lists, newest first, for a picker that starts from saved recents.
 *
 * Deduplicated and re-capped, because the saved list came from a previous session and may be
 * longer than today's limit or contain the same colour spelled two ways.
 */
export function mergeRecentColours(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  for (const candidate of [...first, ...second]) {
    const hex = normaliseHex(candidate);
    if (hex && !merged.includes(hex)) merged.push(hex);
  }
  return merged.slice(0, RECENT_LIMIT);
}
