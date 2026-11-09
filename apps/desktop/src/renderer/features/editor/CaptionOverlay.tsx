/**
 * SPEC 11 §3 — the caption layer over the preview.
 *
 * A canvas painted with the same `captionFrameAt` → `paintCaptionFrame` path the
 * export will use, so what the editor shows is what the export writes. The canvas
 * is sized in *project* pixels and scaled down by CSS, which means the text is laid
 * out at its real size and the preview never shows a different line break from the
 * finished file.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { resolveStyle, type CaptionStyle } from '@clipwright/caption-styles';
import { captionItemAt, captionFrameAt, type CaptionWordTiming } from '@clipwright/compositor';
import type { TimelineState } from '@clipwright/timeline-engine';
import { canvasMeasure, paintCaptionFrame } from './caption-painter.js';
import { textFrameAt, type GraphicItemLike } from './graphics.js';
import { usePlayheadUs } from './playhead-store.js';

/** The words of a caption that are actually visible, with their timings. */
interface VisibleCaption {
  text: string;
  wordIds: string[];
  wordTimings: CaptionWordTiming[];
  startUs: number;
  endUs: number;
}

/**
 * The caption on screen at a moment.
 *
 * The stored `text` and the `wordRefs` can disagree after a hand edit, so this
 * resolves the visible words first and passes them as a pair — the same rule
 * `visibleCaptionText` applies in the engine, which stops the preview from showing
 * words the export has already dropped.
 */
export function visibleCaptionAt(state: TimelineState, timeUs: number): VisibleCaption | null {
  const item = captionItemAt(Object.values(state.items), timeUs);
  if (!item) return null;
  const segment = (item as { captionSegment?: { wordRefs?: Array<{ wordId: string; startUs: number; endUs: number; textOverride?: string }>; text?: string; manualText?: boolean } }).captionSegment;
  if (!segment) return null;

  const refs = segment.wordRefs ?? [];
  const fallback = (segment.text ?? '').trim();

  // Word text lives on the transcript, and a ref only carries an override when the
  // user edited that word in place. Splitting `segment.text` is the same rule the
  // engine's `visibleCaptionText` applies, so the preview cannot show a word the
  // export has dropped.
  const words =
    refs.length > 0 && fallback.length > 0
      ? fallback.split(/\s+/u).slice(0, refs.length).map((text, index) => ({ ref: refs[index]!, text }))
      : [];

  if (words.length === 0) {
    if (fallback.length === 0) return null;
    // No per-word timing: the caption is a single string shown for its whole span.
    return {
      text: fallback,
      wordIds: [],
      wordTimings: [],
      startUs: item.startUs,
      endUs: item.startUs + item.durationUs,
    };
  }

  return {
    text: words.map((entry) => entry.text).join(' '),
    wordIds: words.map((entry) => entry.ref.wordId),
    wordTimings: words.map((entry) => ({ startUs: entry.ref.startUs, endUs: entry.ref.endUs })),
    startUs: item.startUs,
    endUs: item.startUs + item.durationUs,
  };
}

/**
 * The resolved style for an item.
 *
 * Resolution order is preset → project copy → item overrides (SPEC 11 §6). Project
 * copies are passed in rather than looked up here so this stays a pure function of
 * its arguments and can be tested without the bridge.
 */
export function captionStyleFor(
  itemStyleId: string | undefined,
  styleOverrides: Record<string, unknown> | undefined,
  projectCopies: Readonly<Record<string, CaptionStyle>> = {}
): CaptionStyle {
  return resolveStyle(itemStyleId, projectCopies, styleOverrides as Parameters<typeof resolveStyle>[2]);
}

/**
 * The text items live at `timeUs`, in item order (SPEC 11 §7).
 *
 * Exported and pure so this can be tested without a canvas: the interesting cases are
 * all about the span, and the half-open end is the one that is easy to get wrong — a
 * title whose end exactly meets the playhead is *off* screen, matching how the engine
 * and the export treat every other item's range. A closed interval would show it for
 * one extra frame, and the export would not, which is a one-frame difference nobody
 * would ever diagnose.
 */
export function textItemsAt(state: TimelineState, timeUs: number): GraphicItemLike[] {
  return Object.values(state.items).filter(
    (entry) =>
      entry.type === 'text' &&
      !entry.disabled &&
      timeUs >= entry.startUs &&
      timeUs < entry.startUs + entry.durationUs
  ) as unknown as GraphicItemLike[];
}

export function CaptionOverlay({
  state,
  width,
  height,
  projectCopies,
}: {
  state: TimelineState;
  width: number;
  height: number;
  /** Project-local style copies, keyed by id (SPEC 11 §6). */
  projectCopies?: Readonly<Record<string, CaptionStyle>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const measureRef = useRef<{ key: string; measure: ReturnType<typeof canvasMeasure> } | null>(null);
  const playheadUs = usePlayheadUs();

  const caption = useMemo(() => visibleCaptionAt(state, playheadUs), [state, playheadUs]);

  // The item under the playhead, for its id and its style choice.
  const item = useMemo(
    () => captionItemAt(Object.values(state.items), playheadUs),
    [state, playheadUs]
  );

  /*
    Text items live at this instant (SPEC 11 §7), drawn on the same canvas.

    Same canvas rather than a second overlay element because both are `layoutText` →
    `paintCaptionFrame`, and a second canvas would be a second z-index to keep in step
    with the first. Text draws *before* captions: a caption is the thing the viewer is
    reading, and a title that covered one would be the wrong layering.
  */
  const graphicItems = useMemo(
    () => textItemsAt(state, playheadUs),
    [state, playheadUs]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /*
      Text items first, each measuring with the style it actually draws with. The
      measure cache is keyed by font, so a title in a different family than the caption
      below it must not reuse the caption's metrics — that would wrap the title at the
      wrong widths, which is invisible in a test and obvious on screen.
    */
    for (const graphic of graphicItems) {
      const style = captionStyleFor(
        (graphic as { captionStyleId?: string }).captionStyleId,
        (graphic as { styleOverrides?: Record<string, unknown> }).styleOverrides,
        projectCopies
      );
      const cacheKey = JSON.stringify(style.font);
      if (measureRef.current?.key !== cacheKey) {
        measureRef.current = { key: cacheKey, measure: canvasMeasure(ctx, style) };
      }
      const frame = textFrameAt({
        item: graphic,
        style,
        timeUs: playheadUs,
        canvasWidth: width,
        canvasHeight: height,
        measure: measureRef.current.measure,
      });
      if (frame) paintCaptionFrame(ctx, frame, style, { canvasShortSide: Math.min(width, height) });
    }

    if (!caption || !item) return;

    const style = captionStyleFor(
      (item as { captionStyleId?: string }).captionStyleId,
      (item as { styleOverrides?: Record<string, unknown> }).styleOverrides,
      projectCopies
    );

    // Measurements are cached per style, because a caption can change style while
    // the playhead moves and a stale cache would wrap the new style's text at the
    // old style's widths.
    const cacheKey = JSON.stringify(style.font);
    if (measureRef.current?.key !== cacheKey) {
      measureRef.current = { key: cacheKey, measure: canvasMeasure(ctx, style) };
    }
    const measure = measureRef.current.measure;

    const segment = (item as { captionSegment?: { wordOverrides?: Record<string, { emphasis?: boolean; color?: string; scale?: number }> } }).captionSegment;
    const frame = captionFrameAt({
      text: caption.text,
      style,
      wordTimings: caption.wordTimings,
      wordIds: caption.wordIds,
      overrides: segment?.wordOverrides,
      segment: { startUs: caption.startUs, endUs: caption.endUs },
      timeUs: playheadUs,
      canvasWidth: width,
      canvasHeight: height,
      measure,
    });

    paintCaptionFrame(ctx, frame, style, { canvasShortSide: Math.min(width, height) });
  }, [caption, item, graphicItems, playheadUs, width, height, projectCopies]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}
