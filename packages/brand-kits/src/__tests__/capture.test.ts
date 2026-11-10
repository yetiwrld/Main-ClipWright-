import { describe, expect, it } from 'vitest';
import {
  captureKitFromClip,
  planKitApplication,
  resolvePlacement,
  tryParseBrandKit,
  exportBrandKit,
  type CapturableItem,
  type CapturableStyle,
} from '../index.js';

/**
 * Capturing a kit from the current clip (SPEC 13 §8.2).
 *
 * The claims worth testing are the ones that decide whether the captured kit is *useful*:
 * that it lands in the same relative place on a different canvas, that it does not treat the
 * picture in the middle of the frame as a logo, and that it says what it could not take
 * instead of inventing a look. Each fixture therefore uses distinguishing values — a logo at
 * 12% in the top-right, a caption style with four different colours — rather than defaults,
 * because a fixture sitting at a default cannot detect a missing field.
 */
const CANVAS = { widthPx: 1920, heightPx: 1080 };

const STYLE: CapturableStyle = {
  font: { family: 'Inter', weight: 800, italic: false, source: 'bundled' },
  fill: { color: '#FF2D55' },
  outline: { color: '#101010' },
  highlight: { color: '#22D3EE' },
  background: { color: '#0A0A0A' },
};

/**
 * An item at a fraction-of-the-frame centre, the way the timeline stores it.
 *
 * `x`/`y` are the offset from the canvas centre as a fraction, so `x: 0.44375` puts a box's
 * centre at 1920/2 + 0.44375*1920 = 1812 px — 4% of the short side in from the right edge, for
 * a box a tenth of the short side wide. A *negative* `y` is up, so `y: -0.4` is the top row:
 * the centre lands at 540 - 432 = 108 px, which is 4% in from the top.
 */
function item(overrides: Partial<CapturableItem> = {}): CapturableItem {
  return {
    id: 'itm-1',
    type: 'image',
    trackId: 'graphics',
    startUs: 0,
    durationUs: 10_000_000,
    transform: { x: 0.44375, y: -0.4, scaleX: 0.12, scaleY: 0.12 },
    opacity: 1,
    mediaId: 'logo-1',
    ...overrides,
  };
}

const source = (items: CapturableItem[], extra: Partial<Parameters<typeof captureKitFromClip>[0]> = {}) => ({
  items,
  canvas: CANVAS,
  id: 'kit-new',
  name: 'From clip',
  ...extra,
});

describe('captureKitFromClip', () => {
  it('takes the caption style from the clip’s captions', () => {
    const { kit } = captureKitFromClip(
      source(
        [
          item({ id: 'c1', type: 'caption', trackId: 'captions', captionStyleId: 'bold-creator', mediaId: undefined, transform: undefined }),
        ],
        { style: STYLE },
      ),
    );
    expect(kit.captionStyleId).toBe('bold-creator');
  });

  it('maps the style’s colours onto the kit’s slots', () => {
    /*
      Every slot is a different colour here, so a mapping that crossed two of them fails:
      the text comes from the fill, the accent from the highlight, and the background from the
      background. A fixture with one colour everywhere could not tell them apart.
    */
    const { kit } = captureKitFromClip(
      source(
        [item({ id: 'c1', type: 'caption', trackId: 'captions', captionStyleId: 'bold-creator', mediaId: undefined, transform: undefined })],
        { style: STYLE },
      ),
    );
    expect(kit.colors.text).toBe('#FF2D55');
    expect(kit.colors.accent).toBe('#22D3EE');
    expect(kit.colors.background).toBe('#0A0A0A');
    // `primary` mirrors the text rather than taking the outline: a kit's primary is a brand
    // colour the style does not have, and the outline is not one either.
    expect(kit.colors.primary).toBe('#FF2D55');
  });

  it('takes the caption font, and no size for it', () => {
    // A kit's FontRef has no size: size belongs to the caption style, and a captured size
    // would fight the style the kit is applied with.
    const { kit } = captureKitFromClip(
      source(
        [item({ id: 'c1', type: 'caption', trackId: 'captions', captionStyleId: 'bold-creator', mediaId: undefined, transform: undefined })],
        { style: STYLE },
      ),
    );
    expect(kit.fonts.caption).toEqual({ family: 'Inter', weight: 800, italic: false, source: 'bundled' });
    expect(kit.fonts.caption).not.toHaveProperty('sizePctOfShortSide');
  });

  it('captures a corner image as the logo, with that corner', () => {
    const { kit } = captureKitFromClip(source([item()]));
    expect(kit.logo?.assetId).toBe('logo-1');
    expect(kit.logo?.position).toBe('tr');
  });

  it('measures the logo back into percentages, so it lands the same on another canvas', () => {
    /*
      The whole point of capturing percentages rather than pixels. The item was placed in the
      top-right at 12% scale; the captured kit re-placed on a *vertical* canvas must put its
      box the same fraction of the short side in, or the capture is worthless off the clip it
      came from.
    */
    const { kit } = captureKitFromClip(source([item()]));
    expect(kit.logo?.sizePct).toBeCloseTo(12, 5);
    // 4% of the short side in from the right, which is what the fixture's centre implies.
    expect(kit.logo?.margin).toBeCloseTo(4, 4);

    const portrait = { widthPx: 1080, heightPx: 1920 };
    const box = resolvePlacement(kit.logo!, portrait);
    expect(box.width).toBeCloseTo((12 / 100) * 1080, 5);
    const rightGap = portrait.widthPx - (box.x + box.width);
    expect(rightGap).toBeCloseTo((4 / 100) * 1080, 5);
  });

  it('measures the margin on the right axis, in a corner where they differ', () => {
    /*
      The top-right box is 12% of the short side (129.6 px) in from the right and 4% (43.2 px)
      down from the top. A margin recovered from the *y* centre would be 43.2 + 7.2 = 50.4 px
      instead of 108 + 7.2 = 115.2, and only a fixture whose two distances differ can see it —
      which the default one, 4% in both axes, cannot.
    */
    const { kit } = captureKitFromClip(
      source([item({ transform: { x: 0.44375, y: -0.39, scaleX: 0.12, scaleY: 0.12 } })]),
    );
    // centre x = 1812 px, size 129.6 → box left edge 1747.2, gap to 1920 = 172.8 px = 16%.
    expect(kit.logo?.position).toBe('tr');
    expect(kit.logo?.margin).toBeCloseTo(((1920 - (1812 + 129.6 / 2)) / 1080) * 100, 4);
    // And the y distance says 14.4 px — a different number, which is the point.
    expect(kit.logo?.margin).toBeLessThan(20);
  });

  it('measures a left-hand corner from the left edge', () => {
    /*
      Left and right corners are two separate branches, and only the right-hand one had a test:
      a mutation that measured the left margin from the *y* centre passed everything else in
      this file. The fixture is a top-left box 4% in from the left, whose y distance (54 px)
      differs from its x distance (43.2 px) — so the two formulas cannot agree by accident.
    */
    const { kit } = captureKitFromClip(
      source([item({ transform: { x: -0.44375, y: -0.39, scaleX: 0.12, scaleY: 0.12 } })]),
    );
    expect(kit.logo?.position).toBe('tl');
    // centre x = 108 px, size 129.6 → box left edge 43.2 px = 4% of the short side.
    expect(kit.logo?.margin).toBeCloseTo(4, 4);
  });

  it('does not treat an image in the middle of the frame as a logo', () => {
    // A portrait in the centre is the user's content. Capturing it would put their face in a
    // corner on every clip the kit was applied to.
    const { kit, notes } = captureKitFromClip(
      source([item({ transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 } })]),
    );
    expect(kit.logo).toBeUndefined();
    expect(notes.join(' ')).toContain('no logo');
  });

  it('picks the image nearest a corner when two are near', () => {
    const { kit } = captureKitFromClip(
      source([
        item({ id: 'a', mediaId: 'far', transform: { x: -0.2, y: -0.2, scaleX: 0.1, scaleY: 0.1 } }),
        item({ id: 'b', mediaId: 'near', transform: { x: 0.44375, y: -0.4, scaleX: 0.1, scaleY: 0.1 } }),
      ]),
    );
    expect(kit.logo?.assetId).toBe('near');
  });

  it('honours the selected tracks', () => {
    // "logo/text items on selected tracks": a track the user did not select contributes
    // nothing, even when it holds the only corner image.
    const { kit } = captureKitFromClip(
      source([item({ trackId: 'other' })], { trackIds: ['graphics'] }),
    );
    expect(kit.logo).toBeUndefined();
  });

  it('produces a kit that validates and round-trips', () => {
    /*
      The capture's output goes straight into the editor and then into a `.cwbrand` file, so a
      kit that fails `tryParseBrandKit` or loses fields on export would be a capture feature
      that produces unusable kits.
    */
    const { kit } = captureKitFromClip(
      source(
        [item({ id: 'c1', type: 'caption', trackId: 'captions', captionStyleId: 'bold-creator' }), item()],
        { style: STYLE },
      ),
    );
    const parsed = tryParseBrandKit(kit);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(exportBrandKit(parsed.kit)).toEqual(exportBrandKit(kit));
  });

  it('says so when the clip has no captions, and takes no colours anyway', () => {
    /*
      With a style supplied but no caption to bind it to, the kit must take nothing from it: a
      capture that used a style the clip does not have would colour the kit from the wrong
      look, and there is no id to write into `captionStyleId` either.
    */
    const { kit, notes } = captureKitFromClip(source([item()], { style: STYLE }));
    expect(kit.captionStyleId).toBeUndefined();
    expect(kit.colors.text).toBe('#FFFFFF');
    expect(kit.fonts.caption).toBeUndefined();
    expect(notes.join(' ')).toContain('no captions');
  });

  it('says so when the captions’ style could not be resolved', () => {
    // The style id is still captured — applying the kit elsewhere reports the same missing
    // style again — but the kit takes no colours from a style it never saw.
    const { kit, notes } = captureKitFromClip(
      source([item({ id: 'c1', type: 'caption', trackId: 'captions', captionStyleId: 'missing-style', mediaId: undefined, transform: undefined })]),
    );
    expect(kit.captionStyleId).toBe('missing-style');
    expect(kit.colors.text).toBe('#FFFFFF');
    expect(notes.join(' ')).toContain('missing-style');
  });

  it('uses neutral colours when there is no style, rather than inventing a palette', () => {
    // A kit with invented colours looks finished and is not. Black and white is a kit the
    // user knows they have to edit.
    const { kit } = captureKitFromClip(source([item()]));
    expect(kit.colors).toMatchObject({ text: '#FFFFFF', background: '#000000', accent: '#FFFFFF' });
    expect(kit.colors.custom).toEqual([]);
  });

  it('reports text items it cannot capture yet', () => {
    const { notes } = captureKitFromClip(
      source([item({ id: 't1', type: 'text', mediaId: undefined })]),
    );
    expect(notes.join(' ')).toContain('Text and shape items are not captured');
  });

  it('reports a logo that started part-way through the clip', () => {
    // A kit has no field for "appear at 4s"; saying so is better than a kit that silently
    // makes a reveal permanent.
    const { notes } = captureKitFromClip(source([item({ startUs: 4_000_000 })]));
    expect(notes.join(' ')).toContain('part-way through');
  });

  it('skips an image with no media, even when it is the nearest to a corner', () => {
    /*
      The schema requires an `assetId` on a logo, so capturing a media-less image would produce
      a kit that fails to validate. The media-less item here is *nearer* the corner than the
      real logo, so a capture that merely skipped it at the end would still pick it and return
      a kit with no asset — the assertion is on which item won, not on whether one did.
    */
    const { kit } = captureKitFromClip(
      source([
        item({ id: 'ghost', mediaId: undefined, transform: { x: 0.48, y: -0.48, scaleX: 0.1, scaleY: 0.1 } }),
        item({ id: 'real', mediaId: 'logo-1', transform: { x: 0.3, y: -0.3, scaleX: 0.1, scaleY: 0.1 } }),
      ]),
    );
    expect(kit.logo?.assetId).toBe('logo-1');
    expect(kit.logo?.position).toBe('tr');
  });
});
