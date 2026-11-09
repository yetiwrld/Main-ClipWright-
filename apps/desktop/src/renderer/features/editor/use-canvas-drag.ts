/**
 * The pointer side of on-canvas editing (SPEC 12 Phase 4).
 *
 * `canvas-drag.ts` holds the arithmetic; this holds the gesture. They are separate
 * because the arithmetic is worth testing without a DOM and the gesture is worth
 * testing without re-deriving the arithmetic.
 *
 * Two decisions shape the hook:
 *
 * - **The document is written once, on release.** A drag previews by holding its own
 *   values and re-rendering the layer; the timeline command runs when the pointer
 *   comes up. That gives the whole drag one undo step, which is what a user expects
 *   from "I moved the clip" — an undo that stepped back through forty pointer moves
 *   would be unusable.
 * - **The canvas is measured at pointer-down.** The preview is scaled to its panel,
 *   and the panel does not resize mid-drag; re-measuring on every move would only
 *   add a layout read per event and let a stray relayout change the scale under the
 *   user's hand.
 */
import { useCallback, useRef, useState } from 'react';
import {
  angleAbout,
  angleDelta,
  cornerAt,
  cornerScaleFactor,
  croppedEdge,
  edgeFixedPoint,
  edgeScale,
  freeScaleAboutCorner,
  lockedAxis,
  handleAt,
  movedOffset,
  pixelsToFraction,
  pointerToPictureFraction,
  signForOppositeEdge,
  rotatedBy,
  scaleAboutEdge,
  scaleAboutCorner,
  snapRotation,
  type Corner,
  type CropEdge,
  type CropEdges,
} from './canvas-drag.js';
import { clampCoverPosition, coverScaleFloor, type CoverExtent } from './cover-lock.js';
import {
  equalSpacingSnap,
  itemBounds,
  spacingMayApply,
  snapAxis,
  snapTargetsFor,
  snapThresholdPx,
  snapGuideFor,
  snappingApplies,
  type ItemBounds,
  type SnapGuide,
  type SnapTarget,
  type SpacingSpan,
} from './snapping.js';

export interface CanvasDragTarget {
  itemId: string;
  /** Position and crop as they are stored, plus the size the layer is drawn at. */
  x: number;
  y: number;
  rotation: number;
  /** The pivot, as a fraction of the picture — where the rotate handle turns about. */
  anchorX: number;
  anchorY: number;
  crop: CropEdges;
  /** The picture's drawn rectangle within the canvas, in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  /**
   * The picture's *untransformed* layout size, in CSS pixels.
   *
   * Needed to aim the anchor crosshair: `rect` is the transformed bounding box, and
   * inverting a rotation or scale needs the size the element has before either is
   * applied.
   */
  size: { width: number; height: number };
  /** The transform the picture is drawn with, so a pointer can be carried back. */
  scaleX: number;
  scaleY: number;
  /**
   * The picture's drawn size in canvas fractions, for snapping: half of each is the
   * distance from the item's centre to its edge, which is what `snapAxis` needs.
   */
  extent: { x: number; y: number };
  /**
   * Whether the fill lock is engaged for this gesture (SPEC 10 §8.5).
   *
   * Supplied by the caller rather than read from the document here, because whether the
   * lock applies depends on which item this is and what the user has switched on — the
   * panel already knows both, and a hook that read `state.toggles` would need the whole
   * document threaded through it.
   */
  coverLock?: boolean;
  /**
   * The picture's drawn size as a fraction of the canvas, which is what the lock's
   * clamp is expressed in: `extent.x` is a *fraction of the canvas width* but the
   * snapping code wants only the half-extent, while the cover rule needs the whole.
   *
   * Stored separately rather than re-derived, because `extent` is already scaled and
   * halved in the caller and re-deriving from it would silently drift if either changed.
   */
  cover?: CoverExtent;
  /**
   * Every *other* visible item's bounds, in canvas fractions from the canvas centre —
   * the lines this drag can snap to (SPEC 10 §8.8).
   */
  others: { x: readonly ItemBounds[]; y: readonly ItemBounds[] };
  /**
   * Extra lines from a *visible* overlay — safe-area edges, and later the grid
   * (SPEC 10 §8.8, §9).
   *
   * Supplied by the caller rather than derived here, because whether a line may be
   * snapped to depends on whether it is on screen: a snap to a guide the user cannot see
   * is the invisible-jump problem the guide lines exist to solve. The panel decides,
   * because the panel owns the overlay state.
   */
  overlayLines?: { x: readonly SnapTarget[]; y: readonly SnapTarget[] };
}

/** The values a gesture can change, as they stand at any moment during it. */
interface State {
  x: number;
  y: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
  /** Per-axis scale. A corner drag moves both, evenly. */
  scaleX: number;
  scaleY: number;
  crop: CropEdges;
}

/** The gestures that are not one of the picture's eight edges. */
export type GestureMode = 'move' | 'rotate' | 'anchor' | 'scale';

interface Gesture {
  target: CanvasDragTarget;
  /**
   * Whether an edge drag crops or scales.
   *
   * SPEC 10 §8.2 gives the edges "scale along one axis" and §8.6 puts cropping behind the
   * **Crop** tool (`C`). Before this, the edges cropped because that was the only gesture
   * the surface had, so per-axis scale had no pointer affordance at all. The tool now
   * decides which meaning an edge has, rather than the same drag doing both.
   */
  edgeMode: 'crop' | 'scale';
  mode: GestureMode | CropEdge;
  startX: number;
  startY: number;
  canvas: { width: number; height: number };
  from: State;
  to: State;
  /** For a rotate, the pointer's angle about the pivot when the drag began. */
  startAngle: number;
  /** For a rotate, the pivot in client coordinates. */
  pivot: { x: number; y: number };
  /**
   * For a scale: which corner was grabbed, the corner that stays put (in client
   * coordinates), and how far apart they were when the drag began — the ratio of the
   * current distance to that one is the scale factor.
   */
  corner: Corner | null;
  fixedCorner: { x: number; y: number } | null;
  startDistance: number;
  /**
   * The picture's centre in client coordinates, and how far the pointer started from
   * it — what `Alt` measures against instead of the opposite corner.
   */
  centre: { x: number; y: number };
  startCentreDistance: number;
  /** The guide lines this drag is currently snapped to, for drawing them. */
  snapped: { x: SnapGuide | null; y: SnapGuide | null };
  /** The canvas's top-left in client coordinates, so pointer positions can be
   * converted back into the picture's own space. */
  boxLeft: number;
  boxTop: number;
  /**
   * Whether the fill lock stopped this gesture at its last pointer move.
   *
   * Kept on the gesture rather than in state: it is read once, on release, to put the
   * "Fill lock on" chip up. Setting state from a 60 Hz move handler for a boolean that
   * changes twice a drag would repaint the canvas for nothing.
   */
  coverBlocked: boolean;
}

/**
 * What a finished drag asks the editor to do.
 *
 * A canvas drag follows the same §2.4 rule as the sidebar (SPEC 12 §2.4): moving a
 * clip whose position is already animated writes a key at the playhead rather than
 * editing the static value. The gesture does not decide that itself — it hands the
 * final values to the caller, which routes them through the shared rule so the two
 * surfaces cannot disagree.
 */
export interface CanvasDragCommit {
  itemId: string;
  /**
   * Present for a move, a rotate or an anchor drag — whichever of the three ran.
   * A move carries both axes because one drag moves the clip in two; a rotate carries
   * only `rotation`; an anchor drag carries only the pivot.
   */
  transform?: {
    x?: number;
    y?: number;
    rotation?: number;
    anchorX?: number;
    anchorY?: number;
    scaleX?: number;
    scaleY?: number;
  };
  /** Present for a crop: only the edge that was dragged. */
  crop?: { edge: CropEdge; value: number };
}

export interface CanvasDragApi {
  /** What the layer should draw with, which is the in-flight value during a drag. */
  preview: (itemId: string) => State | null;
  /** Whether a gesture is in progress, so the outline can stay visible. */
  dragging: boolean;
  /** Which gesture is running, for the cursor and the outline. */
  mode: GestureMode | CropEdge | null;
  /**
   * The guide lines the drag is currently snapped to, or `null` per axis.
   *
   * Exposed so the preview can draw them: a snap that moves the picture without showing
   * *why* is indistinguishable from the clip jumping, and that is the one thing a guide
   * exists to prevent (SPEC 10 §8.8).
   */
  guides: { x: SnapGuide | null; y: SnapGuide | null };
  /**
   * The two equal gaps to draw, when this drag is equalising a spacing
   * (SPEC 10 §8.8's "distance guides between three items").
   *
   * Empty in every other case. Separate from `guides` because a spacing hint is not a
   * line on a target — it is two spans between three items, and drawing it as a line
   * would say the wrong thing.
   */
  /**
   * The two equal gaps to draw, when this drag is equalising a horizontal spacing
   * (SPEC 10 §8.8's "distance guides between three items"), or empty.
   *
   * Horizontal only. Vertical spacing is the same maths, but nothing has been built to
   * confirm it reads well stacked — and a hint that draws on an axis the user is not
   * dragging along is worse than none.
   */
  spacing: readonly SpacingSpan[];
  /**
   * @param forcedMode Starts a specific gesture regardless of hit testing — how the
   * rotate handle and the anchor crosshair begin, since they are not edges of the
   * picture and the hit test would read them as a move.
   */
  begin: (
    event: React.PointerEvent,
    target: CanvasDragTarget,
    canvas: HTMLDivElement | null,
    forcedMode?: 'rotate' | 'anchor' | 'scale' | 'scale',
    /**
     * What an **edge** drag means under the active tool: `crop` while the Crop tool is on,
     * `scale` otherwise (SPEC 10 §8.2 against §8.6). Corners and the body are unaffected.
     */
    edgeMode?: 'crop' | 'scale',
  ) => void;
  move: (event: React.PointerEvent) => void;
  end: (event: React.PointerEvent) => void;
  /**
   * Abandon the gesture without writing anything (SPEC 10 §8.3's `Esc`).
   *
   * Distinct from `end`: `end` commits what the drag reached, `cancel` throws it away
   * and puts the picture back where it started. Without it a drag that the user
   * regrets can only be fixed by a second drag or an undo — and an undo would also
   * throw away whatever the drag in progress has not yet committed, which is nothing,
   * so `Esc` is strictly the better affordance.
   */
  cancel: () => void;
  /**
   * Whether the fill lock stopped the gesture at its last move (SPEC 10 §8.5).
   *
   * Exposed so the preview can say "Fill lock on" while the picture refuses to move:
   * the spec asks for a status chip, and a clamp with no explanation is the drag feeling
   * broken. False for every gesture when the lock is off.
   */
  coverBlocked: boolean;
}

/**
 * @param commit Called once per completed drag with the final values.
 */
export function useCanvasDrag(commit: (change: CanvasDragCommit) => void): CanvasDragApi {
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<CanvasDragApi['mode']>(null);
  const [previewed, setPreviewed] = useState<
    (State & { itemId: string }) | null
  >(null);
  /*
    Held in state rather than read off the gesture ref, because the ref does not cause a
    render — the guide would only appear on whichever pointer move happened to coincide
    with some other re-render, which is not an affordance but a flicker.
  */
  const [spacing, setSpacing] = useState<readonly SpacingSpan[]>([]);
  const [guides, setGuides] = useState<{ x: SnapGuide | null; y: SnapGuide | null }>({
    x: null,
    y: null,
  });
  /*
    Held in state, unlike the gesture's own flag, because the chip has to appear while
    the drag is still happening. It changes at most twice a gesture — when the picture
    reaches the wall and when it comes off it — so the guard below keeps the 60 Hz move
    handler from repainting for a boolean that did not change.
  */
  const [coverBlocked, setCoverBlocked] = useState(false);

  const begin = useCallback(
    (
      event: React.PointerEvent,
      target: CanvasDragTarget,
      canvas: HTMLDivElement | null,
      forcedMode?: 'rotate' | 'anchor' | 'scale' | 'scale',
      edgeMode: 'crop' | 'scale' = 'scale',
    ) => {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      // Which part of the picture the pointer went down on decides the gesture:
      // an edge crops, anywhere else moves.
      /*
        Corners are tested before edges, because a corner sits at the end of two edges
        and scaling is the more specific gesture. Within `reach` of a corner the drag
        scales; along the rest of an edge it crops, which is what this surface already
        did and keeps every crop reachable by dragging a little past the corner.
      */
      const localPoint = { x: event.clientX - box.left, y: event.clientY - box.top };
      const corner = cornerAt(localPoint, target.rect, target.rotation);
      const handle = forcedMode
        ? null
        : corner
          ? null
          : handleAt(localPoint, target.rect);
      /*
        The pivot in client coordinates. `rect` is the picture's drawn box in canvas
        space and the anchor is a fraction of the picture, so the pivot is inside that
        box — the same rectangle the crop handles are tested against, which is what
        makes the rotate handle turn about the crosshair the user set rather than
        about the element's middle.
      */
      /*
        `?? 0.5` for the same reason `movedOffset` guards its own inputs: the schema
        defaults the anchor, but a project that predates it — or a fixture written by
        hand — may not carry one, and `undefined` here makes the pivot `NaN`. A `NaN`
        pivot does not throw: every angle sampled about it is `NaN`, the rotation
        delta is `NaN`, and the handle simply does nothing while the pointer moves.
        The default is the picture's centre, which is what the model means by an
        absent anchor.
      */
      const anchorX = target.anchorX ?? 0.5;
      const anchorY = target.anchorY ?? 0.5;
      const pivot = {
        x: box.left + target.rect.x + anchorX * target.rect.width,
        y: box.top + target.rect.y + anchorY * target.rect.height,
      };
      /*
        Where the fixed corner sits, in client coordinates. Derived from the same drawn
        rectangle the hit test used, so the corner the user sees is the corner the
        maths holds still.
      */
      const fixedSign = corner
        ? { x: corner === 'nw' || corner === 'sw' ? 1 : -1, y: corner === 'nw' || corner === 'ne' ? 1 : -1 }
        : { x: 0, y: 0 };
      const fixedCorner = corner
        ? (() => {
            const centreX = box.left + target.rect.x + target.rect.width / 2;
            const centreY = box.top + target.rect.y + target.rect.height / 2;
            const radians = (target.rotation * Math.PI) / 180;
            const cos = Math.cos(radians);
            const sin = Math.sin(radians);
            const localX = (fixedSign.x * target.rect.width) / 2;
            const localY = (fixedSign.y * target.rect.height) / 2;
            return {
              x: centreX + cos * localX - sin * localY,
              y: centreY + sin * localX + cos * localY,
            };
          })()
        : null;
      gesture.current = {
        target,
        edgeMode,
        mode: forcedMode ?? (corner ? 'scale' : handle) ?? 'move',
        startX: event.clientX,
        startY: event.clientY,
        canvas: { width: box.width, height: box.height },
        from: {
          x: target.x,
          y: target.y,
          rotation: target.rotation,
          anchorX: target.anchorX,
          anchorY: target.anchorY,
          scaleX: target.scaleX,
          scaleY: target.scaleY,
          crop: target.crop,
        },
        to: {
          x: target.x,
          y: target.y,
          rotation: target.rotation,
          anchorX: target.anchorX,
          anchorY: target.anchorY,
          scaleX: target.scaleX,
          scaleY: target.scaleY,
          crop: target.crop,
        },
        startAngle: angleAbout(pivot, { x: event.clientX, y: event.clientY }),
        pivot,
        corner,
        fixedCorner,
        startDistance: fixedCorner
          ? Math.hypot(event.clientX - fixedCorner.x, event.clientY - fixedCorner.y)
          : 0,
        centre: {
          x: box.left + target.rect.x + target.rect.width / 2,
          y: box.top + target.rect.y + target.rect.height / 2,
        },
        snapped: { x: null, y: null },
        startCentreDistance: Math.hypot(
          event.clientX - (box.left + target.rect.x + target.rect.width / 2),
          event.clientY - (box.top + target.rect.y + target.rect.height / 2),
        ),
        boxLeft: box.left,
        boxTop: box.top,
        coverBlocked: false,
      };
      setDragging(true);
      setMode(forcedMode ?? (corner ? 'scale' : handle) ?? 'move');
      setPreviewed({
        itemId: target.itemId,
        x: target.x,
        y: target.y,
        rotation: target.rotation,
        anchorX: target.anchorX,
        anchorY: target.anchorY,
        scaleX: target.scaleX,
        scaleY: target.scaleY,
        crop: target.crop,
      });
      // Capture so a fast drag that leaves the element still tracks; without it the
      // gesture dies the moment the pointer crosses the preview's edge.
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    },
    [],
  );

  const move = useCallback((event: React.PointerEvent) => {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;

    if (current.mode === 'move') {
      /*
        `Shift` locks the move to the dominant axis (SPEC 10 §8.2). Which axis is
        "dominant" is decided from the pointer's total travel, not per-event, so the
        lock does not flicker between the two while the pointer wanders near the
        diagonal — the drag commits to the direction the user is clearly going.
      */
      const locked = event.shiftKey ? lockedAxis({ xPixels: dx, yPixels: dy }) : null;
      const moved = movedOffset(
        current.from,
        { xPixels: locked === 'y' ? 0 : dx, yPixels: locked === 'x' ? 0 : dy },
        current.canvas,
      );
      /*
        Snapping applies to a move only. Scaling and rotating have their own arithmetic
        that a snap would fight — a scale is measured from a corner the user is holding,
        and nudging it onto a guide would move the picture out from under the pointer.
        SPEC 10 §8.8 lists canvas edges, item edges and centres as the move targets, and
        `Alt` bypasses the lot.
      */
      const snapped = snappingApplies(event)
        ? {
            x: snapAxis(
              moved.x,
              current.target.extent.x / 2,
              snapTargetsFor('x', {
                others: current.target.others.x,
                overlay: current.target.overlayLines?.x ?? [],
              }),
              snapThresholdPx(current.canvas.width),
            ),
            y: snapAxis(
              moved.y,
              current.target.extent.y / 2,
              snapTargetsFor('y', {
                others: current.target.others.y,
                overlay: current.target.overlayLines?.y ?? [],
              }),
              snapThresholdPx(current.canvas.height),
            ),
          }
        : null;
      /*
        The guide carries how far the item moved, not just where it landed: a line with no
        number says *something* lined up, which is most of the reassurance but not the
        answer to "how much did it just jump?". Measured against the canvas size on each
        axis separately, because eight pixels is eight pixels on a wide canvas and a tall
        one alike.
      */
      const guide = {
        x: snapped ? snapGuideFor(snapped.x, current.canvas.width) : null,
        y: snapped ? snapGuideFor(snapped.y, current.canvas.height) : null,
      };
      current.snapped = guide;
      /*
        Only set when it changed. A pointer move emits sixty of these a second and every
        one would otherwise re-render the preview, which the performance targets in
        SPEC 10 §12 explicitly rule out.

        The comparison includes the delta and not just the position. A drag can hold one
        line while sliding along it — the x guide stays on the canvas centre while the
        item moves vertically — and comparing position alone would freeze the distance
        label at whatever it read at that instant.
      */
      setGuides((previous) =>
        previous.x?.target.at === guide.x?.target.at &&
        previous.y?.target.at === guide.y?.target.at &&
        previous.x?.deltaPx === guide.x?.deltaPx &&
        previous.y?.deltaPx === guide.y?.deltaPx
          ? previous
          : guide,
      );
      /*
        Equal-spacing hints (SPEC 10 §8.8).

        Only considered on an axis where no line caught. A flush edge is the stronger,
        more visible intent — and it is what this app already did before spacing existed,
        so letting a spacing hint outbid a line would silently take away an alignment
        users have. `Alt` bypasses the lot, because a user who has asked to place the
        clip exactly should not be nudged by either rule.
      */
      let spacedX: number | null = null;
      let spacingSpans: readonly SpacingSpan[] = [];
      if (spacingMayApply(snapped?.x ?? null)) {
        const half = current.target.extent.x / 2;
        const spacingSnap = equalSpacingSnap(
          { left: moved.x - half, centre: moved.x, right: moved.x + half },
          current.target.others.x,
          snapThresholdPx(current.canvas.width),
        );
        if (spacingSnap) {
          spacedX = moved.x + spacingSnap.delta;
          spacingSpans = spacingSnap.spans;
        }
      }
      /*
        Only replaced when the spans actually change, for the same reason the guides are:
        sixty pointer moves a second must not repaint the canvas for two bars that have
        not moved.
      */
      setSpacing((previous) =>
        previous.length === spacingSpans.length &&
        previous.every(
          (span, index) =>
            span.from === spacingSpans[index]!.from && span.to === spacingSpans[index]!.to,
        )
          ? previous
          : spacingSpans,
      );
      /*
        Keyed on whether a *target* was hit, not on whether a position came back.
        `snapAxis` returns the unchanged position when nothing is near enough, so
        `snapped.x.position` is never null and `?? spacedX` would have silently discarded
        every spacing correction — the hint would draw and the commit would ignore it.
        That is exactly what the discriminating test caught.
      */
      const landed = {
        x: snapped?.x.target ? snapped.x.position : (spacedX ?? moved.x),
        y: snapped?.y.target ? snapped.y.position : moved.y,
      };
      /*
        The fill lock (SPEC 10 §8.5), last, so it has the final say. Snapping and spacing
        both move the picture towards where the user asked; the lock is the one rule that
        can *override* them, because a snap to a guide that exposes canvas is a snap the
        setting exists to refuse.

        Clamped per axis and reporting which, rather than silently adjusting: the caller
        draws a "Fill" chip from that, and a drag that stops at an invisible wall with no
        explanation is the failure mode this feedback is for.
      */
      const clamped =
        current.target.coverLock && current.target.cover
          ? clampCoverPosition(landed, current.target.cover)
          : null;
      current.coverBlocked = clamped ? clamped.clampedX || clamped.clampedY : false;
      setCoverBlocked(current.coverBlocked);
      current.to = {
        ...current.to,
        x: clamped ? clamped.x : landed.x,
        y: clamped ? clamped.y : landed.y,
      };
    } else if (current.mode === 'anchor') {
      /*
        Dragging the crosshair moves the pivot *without moving the picture* — the
        engine compensates, which is what `itemGeometry` already does by folding the
        anchor into the offset. So this gesture writes only the two anchor fractions:
        the picture appears to stay put while the point it will turn about slides
        across it, and that is the property the spec asks for.

        The fraction is the pointer's position measured inside the *picture's* drawn
        rectangle, which is the space the model stores the anchor in.
      */
      /*
        Carried back through the picture's own transform, not measured off its bounding
        box: a 90° turn swaps the box's axes and a scale compresses every fraction
        toward the centre, so box arithmetic puts the crosshair where the user did not
        point — and does so silently, since the drag still "works".
      */
      const target = current.target;
      const fraction = pointerToPictureFraction(
        { x: event.clientX, y: event.clientY },
        {
          box: {
            left: current.boxLeft + target.rect.x,
            top: current.boxTop + target.rect.y,
            width: target.rect.width,
            height: target.rect.height,
          },
          size: target.size,
          rotation: current.from.rotation,
          // The gesture's own previewed scale, so a clip scaled mid-animation aims
          // with the scale it is drawn at rather than the stored one.
          scaleX: target.scaleX,
          scaleY: target.scaleY,
        },
      );
      current.to = { ...current.to, anchorX: fraction.x, anchorY: fraction.y };
    } else if (current.mode === 'rotate') {
      // The gesture is the *change* in the pointer's angle about the pivot, so a drag
      // that circles the handle round the clip produces a continuous rotation.
      const now = angleAbout(current.pivot, { x: event.clientX, y: event.clientY });
      const turned = rotatedBy(current.from.rotation, angleDelta(current.startAngle, now));
      /*
        `Shift` snaps to 15° steps. The cardinals are multiples of 15, so they come free
        rather than needing a separate rule that could disagree with this one near a
        tie. Applied to the *result* so the readout the user sees is the snapped value.
      */
      current.to = { ...current.to, rotation: event.shiftKey ? snapRotation(turned) : turned };
    } else if (current.mode === 'scale') {
      /*
        Uniform scale, measured as the ratio of the pointer's distance from the fixed
        corner to what that distance was at pointer-down. Radial rather than per-axis,
        so the gesture feels the same however the picture is rotated — the user is
        pulling one corner away from the one that stays put.

        The position compensation is not optional. Scaling happens about the anchor
        (SPEC 10 §4), so the arm from the anchor to the content grows with the scale;
        without the compensating move the picture would expand away from its own centre
        and the corner the user is *not* holding would slide, which is the single thing
        a corner handle promises it will not do.
      */
      /*
        `Alt` holds the picture's centre still instead of the opposite corner, which is
        the same radial gesture with the fixed point moved: the factor is measured from
        the centre and the corner offset in the compensation goes to zero.

        `Shift` toggles uniform into free scale, so the two axes are solved separately
        by carrying the pointer back into the picture's own frame. Doing that with the
        *screen* axes instead would make a clip turned 90° widen when the pointer was
        pulled down.
      */
      const aboutCentre = event.altKey;
      const fixedPoint = aboutCentre
        ? current.centre ?? { x: current.startX, y: current.startY }
        : current.fixedCorner ?? { x: current.startX, y: current.startY };
      const startDistance = aboutCentre ? current.startCentreDistance : current.startDistance;
      const factor = cornerScaleFactor(
        { x: event.clientX, y: event.clientY },
        fixedPoint,
        startDistance,
      );
      const toScale = event.shiftKey
        ? freeScaleAboutCorner(
            { x: event.clientX, y: event.clientY },
            {
              fixed: fixedPoint,
              start: { x: current.startX, y: current.startY },
              startScale: { x: current.from.scaleX, y: current.from.scaleY },
              rotation: current.from.rotation,
            },
          )
        : { x: current.from.scaleX * factor, y: current.from.scaleY * factor };
      const position = scaleAboutCorner(
        {
          corner: current.corner ?? 'se',
          fromScale: { x: current.from.scaleX, y: current.from.scaleY },
          toScale,
          anchorX: current.from.anchorX,
          anchorY: current.from.anchorY,
          width: current.target.size.width,
          height: current.target.size.height,
          rotation: current.from.rotation,
          aboutCentre,
        },
        { x: current.from.x, y: current.from.y },
        current.canvas,
      );
      /*
        The floor under the scale (SPEC 10 §8.5): a picture that covers must not shrink
        out of cover, so the gesture's result is raised to the smallest factor that still
        fills. Both the scale and its compensating position come from the floored value —
        keeping the position the unfloored scale needed would slide the fixed corner, the
        one thing a corner handle promises not to do.
      */
      const floored =
        current.target.coverLock && current.target.cover && !event.shiftKey
          ? coverScaleFloor({ x: current.from.scaleX, y: current.from.scaleY }, toScale, current.target.cover)
          : toScale;
      const flooredPosition =
        floored === toScale
          ? position
          : scaleAboutCorner(
              {
                corner: current.corner ?? 'se',
                fromScale: { x: current.from.scaleX, y: current.from.scaleY },
                toScale: floored,
                anchorX: current.from.anchorX,
                anchorY: current.from.anchorY,
                width: current.target.size.width,
                height: current.target.size.height,
                rotation: current.from.rotation,
                aboutCentre,
              },
              { x: current.from.x, y: current.from.y },
              current.canvas,
            );
      current.coverBlocked = floored !== toScale;
      setCoverBlocked(current.coverBlocked);
      current.to = { ...current.to, scaleX: floored.x, scaleY: floored.y, ...flooredPosition };
    } else if (current.edgeMode === 'crop') {
      const edge = current.mode as CropEdge;
      // A crop edge moves along one axis only: the horizontal edges are measured
      // against the canvas width and the vertical ones against its height, matching
      // how the crop fractions are stored (both as fractions of the source, but the
      // *movement* the pointer makes is canvas-relative).
      const horizontal = edge === 'left' || edge === 'right';
      const delta = pixelsToFraction(
        horizontal ? dx : dy,
        horizontal ? current.canvas.width : current.canvas.height,
      );
      current.to = { ...current.to, crop: croppedEdge(current.from.crop, edge, delta) };
    } else {
      /*
        An edge with the Crop tool off: scale the one axis that edge governs (SPEC 10
        §8.2). The fixed point is the *opposite* edge, which is what makes the picture
        grow away from the side the user is not touching — the same promise a corner
        makes, for one axis instead of two.

        `Shift` asks for the corner behaviour instead: both axes by the edge's factor.
      */
      const edge = current.mode as CropEdge;
      const fixed = edgeFixedPoint({
        edge,
        /*
          The drawn box in client coordinates. `boxLeft`/`boxTop` are captured at
          pointer-down for the same reason the corner path captures them: re-measuring
          mid-drag would let a layout shift move the "fixed" side under the user's hand.
        */
        rect: {
          x: current.boxLeft + current.target.rect.x,
          y: current.boxTop + current.target.rect.y,
          width: current.target.rect.width,
          height: current.target.rect.height,
        },
        rotation: current.from.rotation,
      });
      const toScale = edgeScale(
        { x: event.clientX, y: event.clientY },
        {
          edge,
          fixed,
          start: { x: current.startX, y: current.startY },
          startScale: { x: current.from.scaleX, y: current.from.scaleY },
          rotation: current.from.rotation,
          uniform: event.shiftKey,
        },
      );
      const position = scaleAboutEdge(
        {
          sign: signForOppositeEdge(edge),
          fromScale: { x: current.from.scaleX, y: current.from.scaleY },
          toScale,
          anchorX: current.from.anchorX,
          anchorY: current.from.anchorY,
          width: current.target.size.width,
          height: current.target.size.height,
          rotation: current.from.rotation,
        },
        { x: current.from.x, y: current.from.y },
        current.canvas,
      );
      current.to = { ...current.to, scaleX: toScale.x, scaleY: toScale.y, ...position };
    }
    setPreviewed({ itemId: current.target.itemId, ...current.to });
  }, []);

  const end = useCallback(
    (event: React.PointerEvent) => {
      const current = gesture.current;
      gesture.current = null;
      setDragging(false);
      setMode(null);
      setPreviewed(null);
      /*
        The guide goes with the gesture. A line left behind after the pointer is released
        would claim the clip is still aligned to something when it is simply where it
        ended up.
      */
      setGuides({ x: null, y: null });
      setSpacing([]);
      setCoverBlocked(false);
      (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
      if (!current) return;

      if (current.mode === 'move') {
        // Nothing moved is not an edit: committing it would push an empty undo step
        // onto the stack, and a click on the canvas would cost an undo.
        if (current.to.x === current.from.x && current.to.y === current.from.y) return;
        commit({
          itemId: current.target.itemId,
          transform: { x: current.to.x, y: current.to.y },
        });
        return;
      }
      if (current.mode === 'rotate') {
        if (current.to.rotation === current.from.rotation) return;
        commit({
          itemId: current.target.itemId,
          transform: { rotation: current.to.rotation },
        });
        return;
      }
      if (current.mode === 'anchor') {
        if (
          current.to.anchorX === current.from.anchorX &&
          current.to.anchorY === current.from.anchorY
        ) {
          return;
        }
        commit({
          itemId: current.target.itemId,
          transform: { anchorX: current.to.anchorX, anchorY: current.to.anchorY },
        });
        return;
      }
      if (current.mode === 'scale') {
        if (
          current.to.scaleX === current.from.scaleX &&
          current.to.scaleY === current.from.scaleY
        ) {
          return;
        }
        /*
          Both axes and the position go in one commit. A scale that wrote the axes but
          not the compensation would move the picture's centre, and a half-written pair
          would leave the corner the user was holding drifting from under the pointer.
        */
        commit({
          itemId: current.target.itemId,
          transform: {
            scaleX: current.to.scaleX,
            scaleY: current.to.scaleY,
            x: current.to.x,
            y: current.to.y,
          },
        });
        return;
      }
      const edge = current.mode as CropEdge;
      if (current.edgeMode === 'crop') {
        if (current.to.crop[edge] === current.from.crop[edge]) return;
        commit({
          itemId: current.target.itemId,
          crop: { edge, value: current.to.crop[edge] },
        });
        return;
      }
      /*
        An edge scale writes both axes and the compensating move, like a corner does. The
        untouched axis is carried through `to` unchanged, so an edge drag cannot silently
        reset a free scale the user had already set on the other one.
      */
      if (
        current.to.scaleX === current.from.scaleX &&
        current.to.scaleY === current.from.scaleY
      ) {
        return;
      }
      commit({
        itemId: current.target.itemId,
        transform: {
          scaleX: current.to.scaleX,
          scaleY: current.to.scaleY,
          x: current.to.x,
          y: current.to.y,
        },
      });
    },
    [commit],
  );

  const cancel = useCallback(() => {
    /*
      No commit and no write: the preview is dropped, which puts the picture back to
      the values it is actually stored with. Nothing has touched the document during
      the drag, so there is nothing to undo — `Esc` is cheaper than an undo and does
      not disturb the undo stack.
    */
    gesture.current = null;
    setDragging(false);
    setMode(null);
    setPreviewed(null);
    setCoverBlocked(false);
    /*
      Both overlays go with the gesture, for the same reason the preview does: a guide or
      a spacing left behind would describe a drag that is no longer happening. The spacing
      was missed here when it was added to `end()` and not to `cancel()`, and a test that
      released the pointer found it while `Esc` did not.
    */
    setGuides({ x: null, y: null });
    setSpacing([]);
  }, []);

  const preview = useCallback(
    (itemId: string) => (previewed && previewed.itemId === itemId ? previewed : null),
    [previewed],
  );

  return {
    preview,
    dragging,
    mode,
    guides,
    spacing,
    coverBlocked,
    begin,
    move,
    end,
    cancel,
  };
}
