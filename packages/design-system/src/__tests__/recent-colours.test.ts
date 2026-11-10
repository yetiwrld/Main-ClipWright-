/**
 * Recent colours (SPEC 01 §ColourPicker).
 *
 * The value of the strip is entirely in its ordering, so these are ordering tests: newest first,
 * a re-pick moves rather than duplicates, and a half-typed hex never gets in. Each of those is a
 * way the strip stops being useful — a list with duplicates is shorter than its own limit for no
 * visible reason, and one full of `#F`, `#FF`, `#FF7` is unusable at the moment it is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  RECENT_LIMIT,
  addRecentColour,
  mergeRecentColours,
  normaliseHex,
} from '../recent-colours.js';

describe('normalising a colour', () => {
  it('uppercases six-digit hex, with or without the hash', () => {
    // The colour input returns `#ff7a00`, the hex field uppercases as it commits, and a paste may
    // have no hash. All three are the same colour and must not become three entries.
    expect(normaliseHex('#ff7a00')).toBe('#FF7A00');
    expect(normaliseHex('ff7a00')).toBe('#FF7A00');
    expect(normaliseHex('  #FF7A00 ')).toBe('#FF7A00');
  });

  it('expands three-digit shorthand', () => {
    // `#f80` is a colour a user can type. Refusing it would make the field silently drop a valid
    // entry, which reads as the field being broken.
    expect(normaliseHex('#f80')).toBe('#FF8800');
    expect(normaliseHex('f80')).toBe('#FF8800');
  });

  it('refuses anything that is not a colour', () => {
    // Partial input is the ordinary case: the field commits on every keystroke.
    expect(normaliseHex('#F')).toBeUndefined();
    expect(normaliseHex('#FF')).toBeUndefined();
    expect(normaliseHex('#FF7A0')).toBeUndefined();
    expect(normaliseHex('#FF7A00FF')).toBeUndefined();
    expect(normaliseHex('')).toBeUndefined();
    expect(normaliseHex('rgb(255,122,0)')).toBeUndefined();
  });
});

describe('the recents list', () => {
  it('adds the newest colour at the front', () => {
    expect(addRecentColour(['#111111'], '#222222')).toEqual(['#222222', '#111111']);
  });

  it('moves a colour that is already there instead of duplicating it', () => {
    /*
      A colour someone returns to is the *most* recent by definition. Duplicating it would also
      push the genuinely older colours out first, so the list would end up shorter than its own
      limit with nothing to show for it.
    */
    const result = addRecentColour(['#111111', '#222222', '#333333'], '#333333');
    expect(result).toEqual(['#333333', '#111111', '#222222']);
  });

  it('returns the same array when the colour is already newest', () => {
    /*
      Equality, not just equal contents: the store is driven by a `setState` whose return value is
      the update, and the hex field commits on **every keystroke**. A new array each time would
      re-render the dialog once per character typed.
    */
    const recents = ['#FF7A00', '#111111'];
    expect(addRecentColour(recents, '#ff7a00')).toBe(recents);
    expect(addRecentColour(recents, '#FF7A00')).toBe(recents);
  });

  it('ignores a colour that is still being typed', () => {
    // The field sends `#F`, `#FF`, `#FF7`… on the way to `#FF7A00`, and the strip is short enough
    // that the prefixes would be most of it.
    expect(addRecentColour(['#111111'], '#FF')).toEqual(['#111111']);
    expect(addRecentColour(['#111111'], '#111111')).toEqual(['#111111']);
  });

  it('drops the oldest when the list is full', () => {
    // The limit is the whole design: a strip that scrolled would be a palette, and there is
    // already a colour input for that.
    let recents: readonly string[] = [];
    for (let index = 0; index < RECENT_LIMIT + 2; index += 1) {
      recents = addRecentColour(recents, `#00000${index}`);
    }
    expect(recents).toHaveLength(RECENT_LIMIT);
    expect(recents[0]).toBe('#000007');
    expect(recents).not.toContain('#000000');
  });
});

describe('merging two lists', () => {
  it('keeps the first list ahead of the second', () => {
    // The first is the current session's; anything from before should come after it.
    expect(mergeRecentColours(['#111111'], ['#222222'])).toEqual(['#111111', '#222222']);
  });

  it('deduplicates across spellings', () => {
    // A saved list from a previous version may hold `#ff7a00` while today's writes `#FF7A00`.
    expect(mergeRecentColours(['#FF7A00'], ['#ff7a00', '#222222'])).toEqual(['#FF7A00', '#222222']);
  });

  it('re-caps a saved list that is longer than today’s limit', () => {
    // Stored recents outlive the constant that produced them.
    const long = Array.from({ length: 12 }, (_, index) => `#00000${index}`);
    expect(mergeRecentColours(long, [])).toHaveLength(RECENT_LIMIT);
  });
});
