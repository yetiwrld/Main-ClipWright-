/**
 * SPEC 10 §8.5 — the fill lock: a video that covers the canvas keeps covering it.
 *
 * Dragging the main video is how a user reframes a shot, and when that video already
 * fills the frame (the common case) a drag towards the middle is the one gesture with
 * no visible effect: the picture moves, and the frame it exposes at the trailing edge is
 * empty canvas. The spec's answer is a lock, default on, that clamps the drag so the
 * video still covers, and refuses a scale that would drop it below cover.
 *
 * Coordinates here are the ones the document stores, not screen pixels: `offsetX/Y` are
 * fractions of the canvas side and `scale` multiplies the layer, which is laid out to
 * span the frame. That is what makes the clamp expressible at all — a rule written in
 * pixels would mean the same gesture behaved differently at preview zoom, and the export
 * (which has no screen) could not apply it.
 *
 * The arithmetic is deliberately small and closed-form. Slop of half a canvas either way
 * is *visible* canvas, so there is no tolerance to tune and nothing to iterate.
 */

/**
 * The picture's drawn size as fractions of the canvas, which is what the cover rule needs.
 *
 * Not `source × scale`. The preview lays the picture out as a box spanning the **whole
 * canvas width**, with the cropped region magnified to fill it — that is what makes a crop
 * a punch-in rather than a smaller picture — and the box's height then follows the
 * *source's* aspect against the canvas's. So:
 *
 * - width is `scaleX` alone; a narrower crop is compensated by the inner video, and
 *   `source.width` must not be multiplied in or a cropped clip would look like it stopped
 *   covering when it in fact got bigger;
 * - height is `scaleY · canvasAspect / sourceAspect`, which is 1 for a source matching the
 *   canvas and far below it for a 16:9 clip in a 9:16 project.
 *
 * That last case is the one worth stating plainly: a letterboxed video *cannot* cover, at
 * any scale, so the lock must leave it alone — §8.5's own sentence about allowing
 * "letterbox/overlay layouts" only makes sense if the lock is about the case that does
 * fill. Measuring the canvas width alone would have clamped exactly the clips the setting
 * is not for.
 */
export function drawnExtent(input: {
  /** The cropped fraction of the source, as `geometry.source` reports it. */
  source: { width: number; height: number };
  scaleX: number;
  scaleY: number;
  /** The source's own width/height, from the loaded frame. */
  sourceAspect: number;
  /** The canvas's width/height. */
  canvasAspect: number;
}): { width: number; height: number } {
  const { source, scaleX, scaleY, sourceAspect, canvasAspect } = input;
  const usable =
    Number.isFinite(sourceAspect) &&
    Number.isFinite(canvasAspect) &&
    sourceAspect > 0 &&
    canvasAspect > 0 &&
    source.width > 0;
  /*
    A missing aspect means the frame has not loaded yet. Falling back to "matches the
    canvas" is the guess the preview itself makes before the first frame, so the lock
    behaves the same way at that moment as it will a moment later — rather than reading a
    NaN and either locking everything or nothing.
  */
  const height = usable
    ? (source.height * scaleY * canvasAspect) / (source.width * sourceAspect)
    : scaleY;
  return { width: Number.isFinite(scaleX) ? scaleX : 1, height };
}

/**
 * Whether the fill lock governs this item (SPEC 10 §8.5).
 *
 * "The **main video**" is a specific thing, not any clip that happens to fill the frame:
 * a full-frame title or a colour layer is a deliberate overlay, and clamping one to the
 * canvas edges would make it impossible to place a caption that runs off the edge. The
 * lock is about the footage the shots are cut from.
 *
 * Two conditions, both needed:
 * - the clip is a **video** with no parent — a clip loaded from footage, rather than a
 *   generated layer, an image or a shape;
 * - it sits on the track with `role: 'main'`, which is the document's own statement of
 *   which track is the main video rather than a guess from its name or position.
 *
 * Returns false for a state with no tracks or no main track rather than throwing: a
 * project mid-migration is not an error worth losing a drag over, and the lock is a
 * convenience whose absence is the old behaviour.
 */
export function isMainVideo(
  item: { type?: string; trackId?: string },
  state: { tracks?: readonly { id: string; role?: string }[] },
): boolean {
  if (item.type !== 'video') return false;
  const track = state.tracks?.find((candidate) => candidate.id === item.trackId);
  return track?.role === 'main';
}

/** The picture's drawn size and centre, as fractions of the canvas. */
export interface CoverExtent {
  /** Drawn width as a fraction of the canvas width. */
  width: number;
  /** Drawn height as a fraction of the canvas height. */
  height: number;
  /** Centre offset from the canvas centre, as fractions of each canvas side. */
  offsetX: number;
  offsetY: number;
}

/**
 * How far the picture may be dragged on one axis before it stops covering.
 *
 * A picture `width` wide, centred at `offsetX`, spans `offsetX ± width/2` in canvas
 * fractions where the canvas itself spans `±0.5`. It still covers while
 * `offsetX - width/2 <= -0.5` and `offsetX + width/2 >= 0.5` — that is, while
 * `|offsetX| <= (width - 1) / 2`.
 *
 * When the limit is negative the picture is *narrower* than the canvas and cannot cover
 * at any position. Returning the limit anyway would mean clamping to a range that does
 * not exist (a lower bound above the upper one), so the caller is told instead, and the
 * drag is left alone: the lock has nothing to protect, and freezing a clip in place
 * would be a lock on the wrong thing.
 */
export function coverLimit(size: number): number | null {
  if (!Number.isFinite(size) || size < 1) return null;
  return (size - 1) / 2;
}

/**
 * The position to draw instead of the one the pointer asked for, with each axis
 * clamped independently.
 *
 * Both axes, not just the one being dragged: a picture that was already off-centre
 * vertically — placed that way with the lock off, or by an older project — must not be
 * free to slide further out on the axis the user is not touching, and a drag that
 * arrives at a locked position from an unlocked start should land *inside* the limit.
 */
export function clampCoverPosition(
  position: { x: number; y: number },
  extent: CoverExtent,
): { x: number; y: number; clampedX: boolean; clampedY: boolean } {
  const clamp = (value: number, size: number) => {
    const limit = coverLimit(size);
    if (limit === null) return value;
    return Math.min(limit, Math.max(-limit, value));
  };
  const x = clamp(position.x, extent.width);
  const y = clamp(position.y, extent.height);
  return { x, y, clampedX: x !== position.x, clampedY: y !== position.y };
}

/**
 * Whether this scale would take a covering picture below cover.
 *
 * §8.5: "Scale below cover is blocked while on." Blocked means the *scale* is refused
 * rather than the drag being clamped to some position, because a smaller picture cannot
 * be moved into covering the frame — there is no answer to give.
 *
 * The input is the *drawn* extent, so a 16:9 source on a 9:16 canvas arrives already
 * smaller than 1 vertically and the rule stays quiet about it — which is right: that clip
 * letterboxes at any sane scale, and the lock is about the fill case. The answer follows
 * from the geometry rather than from a constant that would have to be right for every
 * aspect ratio at once, and no caller has to know the source's aspect to apply it.
 */
export function blocksCoverScale(extent: CoverExtent, next: { width: number; height: number }): boolean {
  return (
    (extent.width >= 1 && next.width < 1) ||
    (extent.height >= 1 && next.height < 1)
  );
}

/**
 * Whether the picture currently covers the canvas on both axes.
 *
 * The toolbar chip says "Fill lock on" when it is on; it says nothing about whether the
 * *clip* is filling, and a lock engaged on a letterboxed overlay would be a promise about
 * something the user is not doing. The panel uses this to show the state only when it
 * means something, and to explain a drag that stopped moving.
 */
export function coversCanvas(extent: CoverExtent, tolerance = 1e-6): boolean {
  const limit = (size: number) => (size - 1) / 2 + tolerance;
  const horizontal = Math.abs(extent.offsetX) <= limit(extent.width);
  const vertical = Math.abs(extent.offsetY) <= limit(extent.height);
  return extent.width >= 1 - tolerance && extent.height >= 1 - tolerance && horizontal && vertical;
}

/**
 * The smallest uniform factor a covering picture may be scaled by (SPEC 10 §8.5).
 *
 * `0` means "no floor": nothing about this picture is covering, so the lock has no
 * opinion and the caller should leave the scale alone.
 *
 * A *factor* rather than a target scale because the gesture is radial and uniform: both
 * axes move together. Shrinking by `f` takes the drawn extent to `width·f`, so an axis
 * that covers needs `f >= 1/width` — and the axis needing the *most* magnification
 * decides, which is the maximum. Taking the minimum instead would let the height fall
 * out of cover while the width was still fine: a gap along the axis nobody was watching.
 *
 * Clamping the factor rather than refusing the gesture is deliberate. A handle that stops
 * dead at the limit reads as a broken handle; one that keeps tracking the pointer while
 * the picture stops shrinking reads as a wall, which is what the setting is.
 */
export function minCoverFactor(extent: CoverExtent): number {
  let factor = 0;
  if (Number.isFinite(extent.width) && extent.width >= 1) {
    factor = Math.max(factor, 1 / extent.width);
  }
  if (Number.isFinite(extent.height) && extent.height >= 1) {
    factor = Math.max(factor, 1 / extent.height);
  }
  return factor;
}

/**
 * The scale to draw during a gesture: the one the pointer asks for, floored so a
 * covering picture does not shrink out of cover.
 *
 * Applied to the *result* of the gesture rather than to its input, because the pointer
 * may wander far past the limit and come back — a floor on the input would let the
 * picture creep back a frame at a time as the pointer returned.
 */
export function coverScaleFloor<T extends { x: number; y: number }>(
  fromScale: { x: number; y: number },
  nextScale: T,
  extent: CoverExtent,
): { x: number; y: number } {
  const factor = minCoverFactor(extent);
  if (factor <= 0) return nextScale;
  /*
    The floor is expressed against the *stored* scale, and `extent` is the extent at that
    stored scale. Falling below `from · factor` is the only way the picture can stop
    covering, so that product is the wall.
  */
  const floorX = fromScale.x * factor;
  const floorY = fromScale.y * factor;
  if (nextScale.x >= floorX && nextScale.y >= floorY) return nextScale;
  return { x: Math.max(nextScale.x, floorX), y: Math.max(nextScale.y, floorY) };
}
