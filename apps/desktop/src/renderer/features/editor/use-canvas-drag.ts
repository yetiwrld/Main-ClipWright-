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
  croppedEdge,
  handleAt,
  movedOffset,
  pixelsToFraction,
  rotatedBy,
  type CropEdge,
  type CropEdges,
} from './canvas-drag.js';

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
}

/** The values a gesture can change, as they stand at any moment during it. */
interface State {
  x: number;
  y: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
  crop: CropEdges;
}

interface Gesture {
  target: CanvasDragTarget;
  mode: 'move' | 'rotate' | 'anchor' | CropEdge;
  startX: number;
  startY: number;
  canvas: { width: number; height: number };
  from: State;
  to: State;
  /** For a rotate, the pointer's angle about the pivot when the drag began. */
  startAngle: number;
  /** For a rotate, the pivot in client coordinates. */
  pivot: { x: number; y: number };
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
  mode: 'move' | 'rotate' | 'anchor' | CropEdge | null;
  /**
   * @param forcedMode Starts a specific gesture regardless of hit testing — how the
   * rotate handle and the anchor crosshair begin, since they are not edges of the
   * picture and the hit test would read them as a move.
   */
  begin: (
    event: React.PointerEvent,
    target: CanvasDragTarget,
    canvas: HTMLDivElement | null,
    forcedMode?: 'rotate' | 'anchor',
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
      forcedMode?: 'rotate' | 'anchor',
    ) => {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      // Which part of the picture the pointer went down on decides the gesture:
      // an edge crops, anywhere else moves.
      const handle = forcedMode
        ? null
        : handleAt({ x: event.clientX - box.left, y: event.clientY - box.top }, target.rect);
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
      gesture.current = {
        target,
        mode: forcedMode ?? handle ?? 'move',
        startX: event.clientX,
        startY: event.clientY,
        canvas: { width: box.width, height: box.height },
        from: {
          x: target.x,
          y: target.y,
          rotation: target.rotation,
          anchorX: target.anchorX,
          anchorY: target.anchorY,
          crop: target.crop,
        },
        to: {
          x: target.x,
          y: target.y,
          rotation: target.rotation,
          anchorX: target.anchorX,
          anchorY: target.anchorY,
          crop: target.crop,
        },
        startAngle: angleAbout(pivot, { x: event.clientX, y: event.clientY }),
        pivot,
        boxLeft: box.left,
        boxTop: box.top,
      };
      setDragging(true);
      setMode(forcedMode ?? handle ?? 'move');
      setPreviewed({
        itemId: target.itemId,
        x: target.x,
        y: target.y,
        rotation: target.rotation,
        anchorX: target.anchorX,
        anchorY: target.anchorY,
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
      const moved = movedOffset(current.from, { xPixels: dx, yPixels: dy }, current.canvas);
      current.to = { ...current.to, ...moved };
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
      const rect = current.target.rect;
      const fractionX = (event.clientX - current.boxLeft - rect.x) / (rect.width || 1);
      const fractionY = (event.clientY - current.boxTop - rect.y) / (rect.height || 1);
      current.to = {
        ...current.to,
        anchorX: Math.min(1, Math.max(0, fractionX)),
        anchorY: Math.min(1, Math.max(0, fractionY)),
      };
    } else if (current.mode === 'rotate') {
      // The gesture is the *change* in the pointer's angle about the pivot, so a drag
      // that circles the handle round the clip produces a continuous rotation.
      const now = angleAbout(current.pivot, { x: event.clientX, y: event.clientY });
      current.to = {
        ...current.to,
        rotation: rotatedBy(current.from.rotation, angleDelta(current.startAngle, now)),
      };
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
