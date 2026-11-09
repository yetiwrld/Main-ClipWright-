/**
 * The Crop tool's frame over the **uncropped** source (SPEC 10 §8.6).
 *
 * A component of its own rather than another branch inside `PreviewPane`, because the frame
 * needs to sit at a different depth in the tree than the clip's own handles: it is drawn over
 * the *whole* source, which is larger than the cropped window the selection outline marks out,
 * and it must not move when the clip's picture moves.
 *
 * The arithmetic lives in `crop-tool.ts`. What is here is the drawing and the pointer routing:
 * eight grips, a dimmed region outside them, and a pan when the pointer is inside. Everything
 * about *what a drag means* is a pure function so the rules can be tested without a DOM.
 */

import { useRef } from 'react';

import {
  cropExtent,
  cropGripAt,
  cropRect,
  cornerCrop,
  gripCursor,
  isResizeGrip,
  lockedCrop,
  pannedCrop,
  type CropEdge,
  type CropEdges,
  type CropGrip,
  type CropRect,
} from './crop-tool.js';

/** How close, in CSS pixels, a pointer has to be to a grip before it takes the drag. */
export const GRIP_REACH = 10;

/** The grips, in the order they are drawn, so a test can assert the whole set. */
export const GRIP_POSITIONS: readonly { grip: CropGrip; left: string; top: string }[] = [
  { grip: 'nw', left: '0%', top: '0%' },
  { grip: 'n', left: '50%', top: '0%' },
  { grip: 'ne', left: '100%', top: '0%' },
  { grip: 'e', left: '100%', top: '50%' },
  { grip: 'se', left: '100%', top: '100%' },
  { grip: 's', left: '50%', top: '100%' },
  { grip: 'sw', left: '0%', top: '100%' },
  { grip: 'w', left: '0%', top: '50%' },
];

/** The rectangle the frame is drawn in, as percentages of the uncropped source. */
export function frameBox(rect: CropRect): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const width = cropExtent(rect).width;
  const height = cropExtent(rect).height;
  /*
    Rounded, because these go into CSS as strings: `1 − 0.1 − 0.3` is 0.6000000000000001 in
    binary, and `"60.00000000000001%"` is both ugly in the DOM and impossible to assert on.
    A hundredth of a percent is far below a pixel at any real window size.
  */
  const pct = (value: number) => `${Math.round(Math.max(0, value) * 100 * 1000) / 1000}%`;
  return {
    left: pct(rect.left),
    top: pct(rect.top),
    width: pct(width),
    height: pct(height),
  };
}

/**
 * The four dimmed regions outside the frame.
 *
 * Four rectangles rather than one box-shadow or a `clip-path`, because the dimming has to let
 * pointer events through to the canvas *behind* it while still being visible over the picture:
 * a single element covering the source would swallow the pointer-down that begins a new
 * selection. Each region is a plain block with `pointerEvents: none`, so the geometry stays
 * obvious and the hit testing stays with the frame itself.
 */
export function dimBoxes(rect: CropRect): { key: string; style: React.CSSProperties }[] {
  const width = Math.max(0, cropExtent(rect).width);
  const height = Math.max(0, cropExtent(rect).height);
  const right = 1 - rect.left - width;
  const bottom = 1 - rect.top - height;
  return [
    // Above the frame: the full width, ending where the frame starts.
    { key: 'north', style: { left: 0, top: 0, width: '100%', height: `${rect.top * 100}%` } },
    // Below it.
    { key: 'south', style: { left: 0, bottom: 0, width: '100%', height: `${bottom * 100}%` } },
    // The two side strips, between the two horizontals — otherwise they would overlap them and
    // a semi-transparent dim would be twice as dark where it happens to stack.
    {
      key: 'west',
      style: { left: 0, top: `${rect.top * 100}%`, width: `${rect.left * 100}%`, height: `${height * 100}%` },
    },
    {
      key: 'east',
      style: {
        right: 0,
        top: `${rect.top * 100}%`,
        width: `${right * 100}%`,
        height: `${height * 100}%`,
      },
    },
  ];
}

/** How a gesture in progress began, so the moves know what to recompute. */
interface Gesture {
  grip: CropGrip;
  startX: number;
  startY: number;
  from: CropEdges;
  /** The frame's size in CSS pixels at pointer-down, which is what a delta divides by. */
  size: { width: number; height: number };
}

export interface CropFrameProps {
  /** The crop as it stands, draft or stored. */
  crop: CropEdges;
  /** The locked ratio as a width/height number, or `null` for Free. */
  aspect: number | null;
  /** The source's pixel size, which the ratio needs in order to mean anything. */
  source: { width: number; height: number };
  /** The frame's new crop, while a drag is in flight. */
  onPreview: (crop: CropEdges) => void;
  /** The frame's crop when the pointer is released — one commit per gesture. */
  onCommit: (crop: CropEdges) => void;
  /** Called when a drag begins, so the parent can stop other gestures claiming the pointer. */
  onDragStart?: () => void;
}

/**
 * The frame's own pointer handling.
 *
 * A pointer *capture* at pointer-down is what makes a drag continue when the pointer leaves
 * the frame — which it does immediately when the user drags a grip inward, since the grip is
 * on the frame's edge. Without it the first move that crossed the boundary delivered its
 * events to whatever was underneath, and the crop stopped following the pointer at exactly the
 * moment it started mattering.
 */
export function CropFrame({
  crop,
  aspect,
  source,
  onPreview,
  onCommit,
  onDragStart,
}: CropFrameProps) {
  const gesture = useRef<Gesture | null>(null);
  /** The frame's own element — the whole source, which the fractions are relative to. */
  const frameRef = useRef<HTMLDivElement>(null);
  const rect = cropRect(crop);


  /**
   * A pointer position as fractions of the **whole source**, which is the space the crop
   * rectangle is expressed in.
   *
   * Measured against the frame's own box, not the rectangle's: measuring against the rectangle
   * would make every point inside it land in `0..1` of the *window*, so the hit test would
   * think the pointer was always at the frame's edge and the grip it picked would depend on the
   * crop's size rather than on where the user pressed.
   */
  const localPoint = (event: React.PointerEvent) => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    };
  };

  const begin = (event: React.PointerEvent<HTMLDivElement>, grip: CropGrip) => {
    // The picture's own pointer-down would otherwise start a move, and a crop drag would
    // translate the clip at the same time.
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    /*
      The frame's own box, measured once at pointer-down. Re-measuring per move would let a
      layout change — a zoom, a panel resize, the picture settling into place — move the
      denominator under the user's hand mid-drag, which reads as the crop accelerating.
    */
    const box = frameRef.current?.getBoundingClientRect();
    gesture.current = {
      grip,
      startX: event.clientX,
      startY: event.clientY,
      from: { ...rect },
      size: { width: box?.width ?? 0, height: box?.height ?? 0 },
    };
    onDragStart?.();
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (current.size.width <= 0 || current.size.height <= 0) return;
    // Fractions of the *source*, which is the box the rect is expressed in.
    const by = {
      x: (event.clientX - current.startX) / current.size.width,
      y: (event.clientY - current.startY) / current.size.height,
    };
    const next = resolveCropGesture(current.grip, current.from, by, aspect, source);
    if (next) onPreview(next);
  };

  const end = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    // The commit carries whatever the preview last reached, which the parent has already put
    // in its draft — so this is the one write for the whole gesture.
    onCommit(crop);
  };

  return (
    <div
      data-testid="preview-crop-frame"
      /*
        The frame's own box is the whole source, so the fractions map straight onto it. It is
        `pointerEvents: none` and only the frame inside takes the pointer: a press in the dimmed
        region must reach the canvas behind, or the user could not start a new selection while
        the Crop tool is open.
      */
      ref={frameRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {dimBoxes(rect).map(({ key, style }) => (
        <div
          key={key}
          data-testid={`preview-crop-dim-${key}`}
          style={{
            position: 'absolute',
            background: 'rgba(0, 0, 0, 0.55)',
            pointerEvents: 'none',
            ...style,
          }}
        />
      ))}
      <div
        data-testid="preview-crop-rect"
        aria-label="Crop rectangle"
        style={{
          position: 'absolute',
          ...frameBox(rect),
          pointerEvents: 'auto',
          cursor: gripCursor('move'),
          outline: '1px solid var(--brand)',
          // A second ring in the opposite tone, for the same reason the selection outline has
          // one: a single colour disappears against footage of its own brightness.
          boxShadow: '0 0 0 1px rgba(255,255,255,0.65)',
          touchAction: 'none',
        }}
        onPointerDown={(event) => {
          /*
            Which grip this press is on is decided from the *point*, not from which child was
            hit: the grips are 10-px blocks, but the edges themselves take a drag too — a user
            who aims two pixels inside the top edge means the top edge. That also makes the
            hit test independent of whether a grip's little block happens to be under the
            pointer, which a diagonal drag would break.
          */
          /*
            The tolerance is measured against the frame's own box, per axis: a 10-px grip is a
            different fraction of a wide frame than of a tall one, and a single number would
            make the vertical grips harder to hit than the horizontal ones.
          */
          const box = frameRef.current?.getBoundingClientRect();
          const tolerance = {
            x: box && box.width > 0 ? GRIP_REACH / box.width : 0,
            y: box && box.height > 0 ? GRIP_REACH / box.height : 0,
          };
          const grip = cropGripAt(localPoint(event), rect, tolerance) ?? 'move';
          begin(event, grip);
        }}
      >
        {GRIP_POSITIONS.map(({ grip, left, top }) => (
          <div
            key={grip}
            data-testid={`preview-crop-grip-${grip}`}
            aria-label={`Crop handle ${grip}`}
            style={{
              position: 'absolute',
              left,
              top,
              width: GRIP_REACH,
              height: GRIP_REACH,
              marginLeft: -GRIP_REACH / 2,
              marginTop: -GRIP_REACH / 2,
              cursor: gripCursor(grip),
              borderRadius: 2,
              background: 'var(--surface-card)',
              border: '1px solid var(--brand)',
              // They are hits on the frame itself, which already owns the pointer routing.
              pointerEvents: 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** A side grip's edge name, in the document's vocabulary. */
const EDGE_FOR_GRIP: Record<'n' | 'e' | 's' | 'w', CropEdge> = {
  n: 'top',
  e: 'right',
  s: 'bottom',
  w: 'left',
};

/**
 * The crop a grip drag produces, or `null` when it cannot be built.
 *
 * Separate from the component so the mapping from eight grips to the three pure gestures is
 * testable on its own: a corner is `cornerCrop`, a side is `lockedCrop` (which handles both the
 * locked and the free case), and the inside is `pannedCrop`. Getting this routing wrong is the
 * kind of bug that only shows up as "one of the eight handles does something odd".
 */
export function resolveCropGesture(
  grip: CropGrip,
  from: CropEdges,
  by: { x: number; y: number },
  aspect: number | null,
  source: { width: number; height: number },
): CropEdges | null {
  if (grip === 'move') {
    /*
      A pan is caught by rounding each axis of the window in the same way, which is what
      `pannedCrop` does; it is never refused, because a pan that hits the source's edge simply
      stops — the window's *size* is unchanged, so there is nothing to degenerate.
    */
    return pannedCrop(from, by);
  }
  if (!isResizeGrip(grip)) return null;
  if (grip === 'nw' || grip === 'ne' || grip === 'se' || grip === 'sw') {
    return cornerCrop(from, grip, by, aspect, source);
  }
  /*
    A side grip moves one edge. `lockedCrop` already does exactly that when the ratio is
    locked, and degenerates to the plain edge move when it is not — so the free case goes
    through it too rather than through a second implementation of the same arithmetic.
  */
  /*
    The grips are named by compass point and the stored edges by side, so this is a real
    mapping rather than a cast: `n` and `top` are the same edge, but naming them the same
    thing in both places would force the hit test's vocabulary onto the document's.
  */
  const edge: CropEdge = EDGE_FOR_GRIP[grip];
  // `lockedCrop` wants the *lead* axis' delta, in the sign its edges are stored with: `left`
  // and `top` grow inward from a positive drag, so a rightward move on the left grip is a
  // positive delta.
  const delta = edge === 'left' || edge === 'right' ? by.x : by.y;
  if (aspect === null) {
    // Free: one edge moves, no ratio to satisfy, no reason to refuse.
    return edgeOnly(from, edge, delta);
  }
  return lockedCrop(from, edge, delta, aspect, source);
}

/**
 * One edge moved, with the window kept drawable — the free-aspect side drag.
 *
 * Clamped rather than refused, unlike the locked case: with no ratio to satisfy there is
 * nothing a clamp can contradict, and a side drag that runs into the source's edge should stop
 * there rather than stop responding.
 */
function edgeOnly(from: CropEdges, edge: CropEdge, delta: number): CropEdges {
  const rect = cropRect(from);
  const MIN = 0.02;
  const next: CropEdges = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  switch (edge) {
    case 'left':
      next.left = Math.min(Math.max(0, rect.left + delta), 1 - rect.right - MIN);
      break;
    case 'right':
      next.right = Math.min(Math.max(0, rect.right - delta), 1 - rect.left - MIN);
      break;
    case 'top':
      next.top = Math.min(Math.max(0, rect.top + delta), 1 - rect.bottom - MIN);
      break;
    default:
      next.bottom = Math.min(Math.max(0, rect.bottom - delta), 1 - rect.top - MIN);
      break;
  }
  return next;
}
