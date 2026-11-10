/**
 * Making a kit *from the current clip* (SPEC 13 §8.2: "New kit (from scratch or *from the
 * current clip*: captures the used caption style, fonts, colours, logo/text items on selected
 * tracks)").
 *
 * This is the feature's other half. A user who has spent an afternoon getting one clip right —
 * a caption look, a title in the right corner, a logo on the top-left — should not have to
 * retype all of it into a form. The clip already *is* the kit; this module reads it back out.
 *
 * **What can be captured, and what cannot.** Two kinds of thing live in a project:
 *
 * - **Facts** — a caption's `captionStyleId`, a font family, a colour, an image item's media id.
 * - **Judgements** — which of six logo corners the top-left item "means", what percentage of
 *   the short side it occupies, whether it should show for the whole clip.
 *
 * Only the first kind can be read, and this module refuses to invent the second. It *measures*
 * geometry back into the kit's own units (`sizePct` and `margin` of the short side) so a kit
 * captured from a 16:9 clip lands correctly on 9:16 — a capture that stored pixels would be a
 * kit that only works on the clip it came from.
 *
 * Where a judgement would be invented, the module reports it instead: a clip with no caption
 * style gets a kit with no caption style and a sentence saying so, rather than a kit with five
 * plausible-looking colours that are nobody's brand.
 *
 * The module is pure and takes a narrow view of the timeline, so it needs no store, no DOM and
 * no media library. The one thing it cannot do alone is *resolve* a style id to a style — that
 * needs the style library, so the caller passes the style in.
 */
import type { BrandKit } from './schema.js';
import { CwbrandFormat, CwbrandFormatVersion, DEFAULT_KIT_COLOURS } from './schema.js';

/**
 * The little of a timeline item this module needs.
 *
 * Deliberately structural rather than importing `@clipwright/project-schema`: the package would
 * otherwise depend on the timeline's schema to read seven fields, and a shape this narrow is
 * what makes "captured from any item that has these" true rather than aspirational.
 */
export interface CapturableItem {
  id: string;
  type: string;
  trackId: string;
  startUs: number;
  durationUs: number;
  /** Present on captions and text items. */
  captionStyleId?: string;
  /** Present on image items: the media id the kit's logo will name. */
  mediaId?: string;
  /** Transform, as the timeline stores it — a fraction of the canvas centre plus a scale. */
  transform?: { x?: number; y?: number; scaleX?: number; scaleY?: number };
  opacity?: number;
}

/**
 * The parts of a resolved caption style this module reads.
 *
 * Structural for the same reason as `CapturableItem`: the caller may pass a
 * `@clipwright/caption-styles` value, and this package does not depend on that package to read
 * four colours and a font family.
 */
export interface CapturableStyle {
  font: { family: string; weight: number; italic: boolean; source: 'bundled' | 'user' | 'system' };
  fill: { color: string };
  outline: { color: string };
  highlight: { color: string };
  background: { color: string };
}

/** What a captured clip needs to know about itself. */
export interface CaptureSource {
  items: readonly CapturableItem[];
  /**
   * Which tracks to look at for graphics. Empty or absent means all of them — the spec's
   * "logo/text items on selected tracks", where selecting tracks narrows what a capture takes.
   */
  trackIds?: readonly string[];
  canvas: { widthPx: number; heightPx: number };
  /** The kit's id and name. The caller mints them; this module does not invent identities. */
  id: string;
  name: string;
  /**
   * The resolved caption style, if the caller could find one for the id the clip uses. Absent
   * means either there is no style or it is not installed — both reported, differently.
   */
  style?: CapturableStyle;
}

/** What could not be captured, so the editor can say so rather than showing an empty form. */
export interface CaptureReport {
  kit: BrandKit;
  /** Plain sentences about what the clip did not give up. */
  notes: string[];
}

/** The colours a kit needs, given a style — or the neutral set when there is none. */
function coloursFrom(style: CapturableStyle | undefined): BrandKit['colors'] {
  /*
    Mapping, not invention: a caption style has four colours that mean four things, and a kit
    has five slots. The fill is the text colour and the kit's `text` (it is what the words are
    painted in); the highlight is the `accent` (it is what the style makes words stand out
    with); the background is `background`. `primary` and `secondary` have no counterpart in a
    caption style at all, so they take the text and background colours — the two the style does
    commit to — rather than a brand colour guessed from an outline.

    With no style there is nothing to map, and the kit gets black and white. A kit with the
    schema's required fields filled with neutral defaults is one the user edits knowingly; one
    with invented colours looks finished and is not.
  */
  if (!style) {
    return { ...DEFAULT_KIT_COLOURS, custom: [] };
  }
  return {
    primary: style.fill.color,
    secondary: style.background.color,
    accent: style.highlight.color,
    background: style.background.color,
    text: style.fill.color,
    custom: [],
  };
}

/**
 * Read a clip back into a kit.
 *
 * The rules, in the order they matter:
 *
 * 1. **The caption style comes from the captions.** The first caption with a style wins. A clip
 *    usually has one style; when it has two, the kit takes the first and says nothing — the user
 *    can change it in the form, and a warning about a choice the kit cannot make is noise.
 * 2. **The logo is the image item nearest a corner**, if any. Its corner, size and margin are
 *    measured back into the kit's units. An image in the middle of the frame is content, not
 *    branding.
 * 3. **Colours and the caption font come from the resolved style**, which is why they are real
 *    values rather than defaults when the caller has the style in hand.
 * 4. Everything else is reported rather than guessed.
 */
export function captureKitFromClip(source: CaptureSource): CaptureReport {
  const notes: string[] = [];
  const wanted = source.trackIds && source.trackIds.length > 0 ? new Set(source.trackIds) : null;
  const scope = wanted ? source.items.filter((item) => wanted.has(item.trackId)) : [...source.items];

  /* ---- Captions: the style id, and nothing invented around it. ---- */
  const captions = scope.filter((item) => item.type === 'caption');
  const captionStyleId = captions.find((item) => item.captionStyleId !== undefined)?.captionStyleId;

  if (captions.length === 0) {
    notes.push('This clip has no captions, so the kit has no caption look.');
  } else if (captionStyleId === undefined) {
    notes.push('The captions on this clip use no style, so the kit has none to take from them.');
  } else if (source.style === undefined) {
    /*
      The captions name a style but the caller could not resolve it — most often because it came
      from a project whose style is not installed here. This is SPEC 13 §8.3's missing-font case
      one step earlier, and it is worth a sentence: the kit will carry the id and no colours,
      and applying it elsewhere will report the same problem again.
    */
    notes.push(
      `The captions use the style “${captionStyleId}”, which could not be found, so the kit took no colours or fonts from it.`,
    );
  }

  /* ---- Graphics: measured back into the kit's own units. ---- */
  const graphics = scope.filter((item) => item.type === 'image' || item.type === 'video');
  const logoPlacement = captureLogo(graphics, source.canvas, notes);

  const textItems = scope.filter((item) => item.type === 'text' || item.type === 'shape');
  if (textItems.length > 0) {
    notes.push(
      'Text and shape items are not captured yet: only the kit’s logo and caption style can be read back from a clip, so a lower third has to be added by hand.',
    );
  }

  if (logoPlacement === undefined && graphics.length > 0) {
    notes.push(
      'No image sat near a corner, so this clip gave the kit no logo. A picture in the middle of the frame is treated as content, not branding.',
    );
  }

  const style = captionStyleId !== undefined ? source.style : undefined;

  const kit: BrandKit = {
    format: CwbrandFormat,
    formatVersion: CwbrandFormatVersion,
    id: source.id,
    name: source.name,
    colors: coloursFrom(style),
    /*
      The caption font, mapped across: a kit's `FontRef` has no size, because size belongs to
      the style that is applied — a kit that shipped a size would fight the style's own.
    */
    fonts: style
      ? {
          heading: { ...style.font },
          body: { ...style.font },
          caption: { ...style.font },
        }
      : {},
    safeAreaPreset: 'none',
    ...(captionStyleId !== undefined ? { captionStyleId } : {}),
    ...(logoPlacement !== undefined ? { logo: logoPlacement } : {}),
  };

  return { kit, notes };
}

/**
 * An image item as a kit logo, or `undefined` when it is not one.
 *
 * A corner is decided by which third of the frame the item's centre lands in: the outer third
 * of *both* axes, which is the only definition under which the middle of the frame is not a
 * corner. When two corners both qualify the nearer one wins, and an outer corner beats an
 * inner one because it is further away.
 */
function captureLogo(
  items: readonly CapturableItem[],
  canvas: { widthPx: number; heightPx: number },
  notes: string[],
): BrandKit['logo'] | undefined {
  const shortSide = Math.min(canvas.widthPx, canvas.heightPx);
  let best:
    | { item: CapturableItem; position: 'tl' | 'tr' | 'bl' | 'br'; distance: number }
    | undefined;

  for (const item of items) {
    /* An item with no transform sits at the centre with scale 1 — not a logo. */
    if (!item.transform) continue;
    /*
      And an item with no media cannot name an asset, which the kit's logo requires: capturing
      it would produce a kit that fails to validate, so it is not a logo it can take.
    */
    const mediaId = item.mediaId;
    if (mediaId === undefined) continue;
    const centreX = ((item.transform.x ?? 0) + 0.5) * canvas.widthPx;
    const centreY = ((item.transform.y ?? 0) + 0.5) * canvas.heightPx;
    const fractionX = centreX / canvas.widthPx;
    const fractionY = centreY / canvas.heightPx;

    const corners = [
      { position: 'tl' as const, x: 0, y: 0 },
      { position: 'tr' as const, x: canvas.widthPx, y: 0 },
      { position: 'bl' as const, x: 0, y: canvas.heightPx },
      { position: 'br' as const, x: canvas.widthPx, y: canvas.heightPx },
    ];
    for (const corner of corners) {
      const inBand =
        (corner.x === 0 ? fractionX <= 1 / 3 : fractionX >= 2 / 3) &&
        (corner.y === 0 ? fractionY <= 1 / 3 : fractionY >= 2 / 3);
      if (!inBand) continue;
      const distance = Math.hypot(centreX - corner.x, centreY - corner.y);
      if (!best || distance < best.distance) {
        best = { item, position: corner.position, distance };
      }
    }
  }

  if (!best) return undefined;

  const { item, position } = best;
  // Narrowed once, here: every item that reached `best` has a media id (see the loop above).
  const assetId = item.mediaId;
  if (assetId === undefined) return undefined;
  /*
    `sizePct` and `margin` are percentages of the short side, so both are measured against it.
    The item's drawn size is its natural size times its scale, and the natural size is not in
    this shape — so the scale is the substitute for a real box, and it is what the kit needs:
    "this was drawn at 12% of its natural size", which re-applies to the same relative size.
  */
  const scale = Math.min(item.transform?.scaleX ?? 1, item.transform?.scaleY ?? 1);
  const sizePct = Math.max(1, Math.min(100, scale * 100));
  const sizePx = (sizePct / 100) * shortSide;
  const centreX = ((item.transform?.x ?? 0) + 0.5) * canvas.widthPx;
  const centreY = ((item.transform?.y ?? 0) + 0.5) * canvas.heightPx;

  /*
    The margin is the gap between the frame's edge and the box's edge, recovered from the
    centre: the centre is half a box in from the box's own edge, so the gap is that much less
    than the centre-to-edge distance. Vertical corners measure against the *height* for `y` and
    the width for `x`, because the box is square here (`resolvePlacement` returns a square) and
    `margin` applies to both edges.
  */
  const marginPx =
    position === 'tl' || position === 'bl'
      ? centreX - sizePx / 2
      : canvas.widthPx - (centreX + sizePx / 2);
  const marginPct = Math.max(0, Math.min(50, (marginPx / shortSide) * 100));

  if (item.startUs > 0) {
    /*
      A kit's logo has `showFrom` but the schema's values describe a *window* — and a clip's
      item that starts mid-way is a deliberate reveal. A kit has no field for "appear at 4s",
      so this says what it did rather than silently changing the behaviour.
    */
    notes.push(
      'The logo on this clip starts part-way through, and a kit has no field for a delayed logo, so the kit shows it from the start.',
    );
  }

  return {
    assetId,
    position,
    xPct: 0,
    yPct: 0,
    sizePct,
    opacity: item.opacity ?? 1,
    margin: Number.isFinite(marginPct) ? marginPct : 0,
    showFrom: 'always',
    showFor: 'whole',
  };
}
