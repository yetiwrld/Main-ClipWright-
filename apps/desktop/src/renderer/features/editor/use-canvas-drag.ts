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
  freeScaleAboutCorner,
  lockedAxis,
  handleAt,
  movedOffset,
  pixelsToFraction,
  pointerToPictureFraction,
  rotatedBy,
  scaleAboutCorner,
  snapRotation,
  type Corner,
  type CropEdge,
  type CropEdges,
} from './canvas-drag.js';
import {
  itemBounds,
  snapAxis,
  snapTargetsFor,
  snapThresholdPx,
  snappingApplies,
  type ItemBounds,
  type SnapTarget,
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
   * Every *other* visible item's bounds, in canvas fractions from the canvas centre —
   * the lines this drag can snap to (SPEC 10 §8.8).
   */
  others: { x: readonly ItemBounds[]; y: readonly ItemBounds[] };
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
  snapped: { x: SnapTarget | null; y: SnapTarget | null };
  /** The canvas's top-left in client coordinates, so pointer positions can be
   * converted back into the picture's own space. */
  boxLeft: number;
  boxTop: number;
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
   * @param forcedMode Starts a specific gesture regardless of hit testing — how the
   * rotate handle and the anchor crosshair begin, since they are not edges of the
   * picture and the hit test would read them as a move.
   */
  begin: (
    event: React.PointerEvent,
    target: CanvasDragTarget,
    canvas: HTMLDivElement | null,
    forcedMode?: 'rotate' | 'anchor' | 'scale' | 'scale',
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

  const begin = useCallback(
    (
      event: React.PointerEvent,
      target: CanvasDragTarget,
      canvas: HTMLDivElement | null,
      forcedMode?: 'rotate' | 'anchor' | 'scale' | 'scale',
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
              snapTargetsFor('x', { others: current.target.others.x }),
              snapThresholdPx(current.canvas.width),
            ),
            y: snapAxis(
              moved.y,
              current.target.extent.y / 2,
              snapTargetsFor('y', { others: current.target.others.y }),
              snapThresholdPx(current.canvas.height),
            ),
          }
        : null;
      current.snapped = { x: snapped?.x.target ?? null, y: snapped?.y.target ?? null };
      current.to = { ...current.to, x: snapped?.x.position ?? moved.x, y: snapped?.y.position ?? moved.y };
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
      current.to = { ...current.to, scaleX: toScale.x, scaleY: toScale.y, ...position };
    } else {
      const edge = current.mode;
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
      const edge = current.mode;
      if (current.to.crop[edge] === current.from.crop[edge]) return;
      commit({
        itemId: current.target.itemId,
        crop: { edge, value: current.to.crop[edge] },
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
  }, []);

  const preview = useCallback(
    (itemId: string) => (previewed && previewed.itemId === itemId ? previewed : null),
    [previewed],
  );

  return { preview, dragging, mode, begin, move, end, cancel };
}
