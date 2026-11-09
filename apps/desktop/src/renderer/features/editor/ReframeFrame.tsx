/**
 * The reframe gesture's fixed window (SPEC 10 §8.6).
 *
 * §8.6's **"Set framing…"** button "lets the user drag the video under a fixed canvas rectangle
 * to set the framing keyframe for this moment". This component is that rectangle, and its whole
 * job is the opposite of `CropFrame`'s: the window does not move, so every drag moves the
 * *picture* instead.
 *
 * Two consequences shape the code below.
 *
 * The first is that there are no handles. A crop has eight grips because its rectangle has eight
 * movable parts; this rectangle is the canvas, which is fixed by definition, so the only gesture
 * is a pan — plus a wheel or pinch to zoom, because a 16:9 shot in a 9:16 canvas cannot fill it
 * at a scale of 1 no matter where it is dragged.
 *
 * The second is that the dimming is *inverted* from the crop frame's. There, the picture is
 * whole and the region outside the crop is dimmed to show what is being thrown away. Here the
 * window is the canvas, so everything outside it is simply not the video — the useful signal is
 * the opposite: showing where the picture's own edges are, so a user can tell how much of the
 * shot they are cutting off. That is what the picture's outline is for.
 */

import { useRef } from 'react';

import { reframeCoverage, reframedOffset, reframedScale, roundFraming } from './reframe.js';

export interface ReframeFrameProps {
  /** The framing as it currently stands, in canvas fractions. */
  framing: { x: number; y: number; scale: number };
  /** The canvas's aspect, so the rectangle is drawn the shape the video will be. */
  canvasAspect: number;
  /** The picture's own aspect, which decides how much of the canvas it covers. */
  sourceAspect: number;
  /** The new framing, while a gesture is in flight. */
  onPreview: (framing: { x: number; y: number; scale: number }) => void;
  /** The framing when the gesture ends — one commit per gesture. */
  onCommit: (framing: { x: number; y: number; scale: number }) => void;
  /** Told when a gesture begins, so the parent can stop other drags claiming the pointer. */
  onDragStart?: () => void;
}

/** How much a wheel notch scales by. Chosen so a trackpad pinch reads as a continuous zoom. */
export const REFRAME_ZOOM_STEP = 1.002;

/**
 * The picture's own outline, as a percentage box inside the window.
 *
 * This is what tells the user how much of the shot survives: at scale 1 a 16:9 picture in a 9:16
 * canvas is a band, and seeing that band move is the whole feedback the gesture has. Rounded to
 * a thousandth of a percent, which is under a pixel at any window size and keeps the DOM
 * readable.
 */
export function pictureBox(
  framing: { x: number; y: number; scale: number },
  sourceAspect: number,
  canvasAspect: number,
): { left: string; top: string; width: string; height: string } {
  const coverage = reframeCoverage(framing.scale, sourceAspect, canvasAspect);
  /*
    Takes a *fraction* of the window and returns a CSS percentage — the ×100 is the whole point,
    and leaving it out made every box a hundred times too small. Rounded to a thousandth of a
    percent, which is under a pixel at any window size, and clamped so a picture dragged far
    outside produces a box the browser can still lay out.
  */
  const pct = (fraction: number) => {
    const value = Math.min(1000, Math.max(-1000, fraction * 100));
    return `${Math.round(value * 1000) / 1000}%`;
  };
  const centred = (offset: number, size: number) => offset - size / 2 + 0.5;
  return {
    left: pct(centred(framing.x, coverage.width)),
    top: pct(centred(framing.y, coverage.height)),
    width: pct(coverage.width),
    height: pct(coverage.height),
  };
}

export function ReframeFrame({
  framing,
  canvasAspect,
  sourceAspect,
  onPreview,
  onCommit,
  onDragStart,
}: ReframeFrameProps) {
  const gesture = useRef<{
    startX: number;
    startY: number;
    from: { x: number; y: number; scale: number };
    size: { width: number; height: number };
  } | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const box = windowRef.current?.getBoundingClientRect();
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      from: { ...framing },
      size: { width: box?.width ?? 0, height: box?.height ?? 0 },
    };
    onDragStart?.();
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (current.size.width <= 0 || current.size.height <= 0) return;
    // A drag is in *canvas* fractions, which is the space the framing is stored in.
    const by = {
      x: (event.clientX - current.startX) / current.size.width,
      y: (event.clientY - current.startY) / current.size.height,
    };
    const coverage = reframeCoverage(current.from.scale, sourceAspect, canvasAspect);
    onPreview({ ...reframedOffset(current.from, by, coverage), scale: current.from.scale });
  };

  const end = () => {
    if (!gesture.current) return;
    gesture.current = null;
    onCommit(framing);
  };

  /**
   * The wheel's zoom, centred on the canvas.
   *
   * A fixed window has only one pivot, so there is no "zoom about the cursor" question here —
   * which is a relief, because the equivalent in the preview proper took a whole function.
   */
  const wheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const factor = Math.pow(REFRAME_ZOOM_STEP, -event.deltaY);
    onPreview(roundFraming(reframedScale(framing, factor, sourceAspect, canvasAspect)));
  };

  return (
    <div
      data-testid="preview-reframe"
      ref={windowRef}
      aria-label="Reframe window"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onWheel={wheel}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'auto',
        cursor: 'move',
        touchAction: 'none',
        // A dashed border reads as "this is a mode, not an object": the window cannot be
        // moved or resized, so it must not look like the crop frame's solid, grabbable one.
        outline: '1px dashed var(--brand)',
        outlineOffset: -1,
        overflow: 'hidden',
      }}
    >
      {/*
        The picture's outline. It is the only thing that moves, so it carries the whole message:
        where the shot sits inside the finished video, and how much of it the window cuts off.
      */}
      <div
        data-testid="preview-reframe-picture"
        style={{
          position: 'absolute',
          ...pictureBox(framing, sourceAspect, canvasAspect),
          pointerEvents: 'none',
          border: '1px solid var(--text-secondary)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
        }}
      />
    </div>
  );
}
