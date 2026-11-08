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
  croppedEdge,
  handleAt,
  movedOffset,
  pixelsToFraction,
  type CropEdge,
  type CropEdges,
} from './canvas-drag.js';

export interface CanvasDragTarget {
  itemId: string;
  /** Position and crop as they are stored, plus the size the layer is drawn at. */
  x: number;
  y: number;
  crop: CropEdges;
  /** The picture's drawn rectangle within the canvas, in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
}

interface Gesture {
  target: CanvasDragTarget;
  mode: 'move' | CropEdge;
  startX: number;
  startY: number;
  canvas: { width: number; height: number };
  from: { x: number; y: number; crop: CropEdges };
  to: { x: number; y: number; crop: CropEdges };
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
  /** Present for a move: both axes, because one drag moves the clip in two. */
  transform?: { x: number; y: number };
  /** Present for a crop: only the edge that was dragged. */
  crop?: { edge: CropEdge; value: number };
}

export interface CanvasDragApi {
  /** What the layer should draw with, which is the in-flight value during a drag. */
  preview: (itemId: string) => { x: number; y: number; crop: CropEdges } | null;
  /** Whether a gesture is in progress, so the outline can stay visible. */
  dragging: boolean;
  begin: (event: React.PointerEvent, target: CanvasDragTarget, canvas: HTMLDivElement | null) => void;
  move: (event: React.PointerEvent) => void;
  end: (event: React.PointerEvent) => void;
}

/**
 * @param commit Called once per completed drag with the final values.
 */
export function useCanvasDrag(commit: (change: CanvasDragCommit) => void): CanvasDragApi {
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewed, setPreviewed] = useState<{ itemId: string; x: number; y: number; crop: CropEdges } | null>(
    null,
  );

  const begin = useCallback(
    (event: React.PointerEvent, target: CanvasDragTarget, canvas: HTMLDivElement | null) => {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      // Which part of the picture the pointer went down on decides the gesture:
      // an edge crops, anywhere else moves.
      const handle = handleAt(
        { x: event.clientX - box.left, y: event.clientY - box.top },
        target.rect,
      );
      gesture.current = {
        target,
        mode: handle ?? 'move',
        startX: event.clientX,
        startY: event.clientY,
        canvas: { width: box.width, height: box.height },
        from: { x: target.x, y: target.y, crop: target.crop },
        to: { x: target.x, y: target.y, crop: target.crop },
      };
      setDragging(true);
      setPreviewed({ itemId: target.itemId, x: target.x, y: target.y, crop: target.crop });
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
    } else {
      // A crop edge moves along one axis only: the horizontal edges are measured
      // against the canvas width and the vertical ones against its height, matching
      // how the crop fractions are stored (both as fractions of the source, but the
      // *movement* the pointer makes is canvas-relative).
      const horizontal = current.mode === 'left' || current.mode === 'right';
      const delta = pixelsToFraction(
        horizontal ? dx : dy,
        horizontal ? current.canvas.width : current.canvas.height,
      );
      current.to = { ...current.to, crop: croppedEdge(current.from.crop, current.mode, delta) };
    }
    setPreviewed({ itemId: current.target.itemId, ...current.to });
  }, []);

  const end = useCallback(
    (event: React.PointerEvent) => {
      const current = gesture.current;
      gesture.current = null;
      setDragging(false);
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
      if (current.to.crop[current.mode] === current.from.crop[current.mode]) return;
      commit({
        itemId: current.target.itemId,
        crop: { edge: current.mode, value: current.to.crop[current.mode] },
      });
    },
    [commit],
  );

  const preview = useCallback(
    (itemId: string) => (previewed && previewed.itemId === itemId ? previewed : null),
    [previewed],
  );

  return { preview, dragging, begin, move, end };
}
