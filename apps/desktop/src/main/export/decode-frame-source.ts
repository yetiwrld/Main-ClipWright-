/**
 * SPEC 14 §4.2 — a `FrameSource` backed by real ffmpeg decoders.
 *
 * This replaces the solid-colour fallback for compositions that have video: each
 * planned video item gets a decoder process that emits `yuv420p` frames at the
 * export resolution and rate, and the source composes them onto the output
 * frame as the timeline plays.
 *
 * Each decoder's filter chain applies the item's own static geometry — crop,
 * scale, rotation, flip and offset — so a clip framed in the editor exports with
 * that framing (`@clipwright/export-core`'s `sourceFilterChain`).
 *
 * What it does **not** do yet: run the real compositor (text, effects,
 * transitions, blend modes, keyframes). Items are composited by "topmost visible
 * wins", with lower layers showing through where the top item has no frame. That
 * is honest — the file contains the composition's actual footage — but it is not
 * the full `renderFrame` path, and `docs/export.md` says so.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import {
  buildDecodeArgs,
  buildSegmentedDecodeArgs,
  geometrySegments,
  segmentedDecodeChain,
  sourceFilterChain,
  type ExportPlan,
  type PlannedItem,
} from '@clipwright/export-core';
import {
  compositeRgb,
  evaluateProperty,
  joinYuv,
  rgbToYuv,
  splitYuv,
  yuvToRgb,
  type BlendMode,
  type ItemGeometryInput,
  type RgbFrame,
} from '@clipwright/compositor';
import { ffmpegPath, CancelledError } from './ffmpeg-runner.js';
import { expectedFrameBytes, type FrameSource } from './export-runner.js';

/** A decoder process plus the bookkeeping needed to pace it. */
interface ItemDecoder {
  item: PlannedItem;
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** Raw bytes waiting in the read buffer. */
  buffered: Buffer;
  /** Frames actually produced so far (for shortfall detection). */
  framesProduced: number;
  /** Frames the item should contribute across the export. */
  expectedFrames: number;
  /** `true` once the process exited or a read error occurred. */
  done: boolean;
  stderr: string;
}

/** Media lookup the source needs: item's mediaId → absolute file path. */
export type MediaPathResolver = (mediaId: string) => string | undefined;

export interface DecodeFrameSourceOptions {
  plan: ExportPlan;
  resolveMediaPath: MediaPathResolver;
  /** Called with readable progress text when an item's decode fails. */
  onWarning?: (message: string) => void;
  /** Concurrent decoder cap; §4.2 says min(6, cores). */
  maxDecoders?: number;
}

/**
 * Compose frames from real decoders.
 *
 * Frames are requested strictly in order, so a single decoder can be advanced
 * lazily: `readFrame` pulls exactly one frame from the pipe each time, which is
 * the back-pressure the spec asks for without a separate queue implementation.
 */
export function createDecodeFrameSource(options: DecodeFrameSourceOptions): FrameSource {
  const { plan, resolveMediaPath } = options;
  const frameBytes = expectedFrameBytes(plan.width, plan.height);
  const decoders = new Map<string, ItemDecoder>();
  const warnings: string[] = [];
  const frameDurationUs = 1_000_000 / plan.fps;

  const videoItems = plan.items
    .filter((item) => (item.type === 'video' || item.type === 'image') && item.mediaId)
    .sort((a, b) => a.startUs - b.startUs);

  /**
   * Items visible at a given output frame, **bottom layer first**.
   *
   * Painting order is the track's `order` (larger is nearer the viewer), and two
   * items on the same track are ordered by id so a decoder restart cannot swap
   * them between frames. Without this sort the composite would depend on the order
   * the plan happened to list items in, which is a bug that shows up once every few
   * exports.
   */
  const visibleAt = (frameIndex: number): PlannedItem[] => {
    const timeUs = frameIndex * frameDurationUs;
    return videoItems
      .filter((item) => timeUs >= item.startUs && timeUs < item.startUs + item.durationUs)
      .sort((a, b) => {
        const order = (a.trackOrder ?? 0) - (b.trackOrder ?? 0);
        return order !== 0 ? order : a.itemId.localeCompare(b.itemId);
      });
  };

  const startDecoder = (item: PlannedItem): ItemDecoder | null => {
    const mediaPath = item.mediaId ? resolveMediaPath(item.mediaId) : undefined;
    if (!mediaPath || !existsSync(mediaPath)) {
      warnings.push(`Media for ${item.itemId} is missing.`);
      return null;
    }
    const sourceInUs = Math.max(0, item.sourceInUs);

    const chainFor = (geometry: ItemGeometryInput) =>
      sourceFilterChain({
        targetFps: plan.fps,
        outputWidth: plan.width,
        outputHeight: plan.height,
        fit: 'fit',
        // The item's own crop/scale/rotation, so the decoded frame is the picture
        // the editor showed rather than the whole source (SPEC 10 §8.4–8.6).
        geometry,
      });

    /**
     * The geometry the filter chain takes is the *stored* shape (crop edges and
     * transform fields), not `itemGeometry`'s resolved form — the chain does its own
     * fitting and needs the fractions. So the animation is sampled through
     * `evaluateProperty` rather than through `itemGeometry`.
     */
    const geometryAt = (timeUs: number): ItemGeometryInput => {
      const staticGeometry = (item.geometry ?? {}) as ItemGeometryInput;
      const keys = item.keyframes as
        | Record<string, Array<{ timeUs: number; value: unknown }>>
        | undefined;
      const read = (path: Parameters<typeof evaluateProperty>[1], fallback: number) =>
        evaluateProperty(keys as Parameters<typeof evaluateProperty>[0], path, timeUs, fallback);
      return {
        crop: {
          left: read('crop.left', staticGeometry.crop?.left ?? 0),
          top: read('crop.top', staticGeometry.crop?.top ?? 0),
          right: read('crop.right', staticGeometry.crop?.right ?? 0),
          bottom: read('crop.bottom', staticGeometry.crop?.bottom ?? 0),
        },
        transform: {
          x: read('transform.x', staticGeometry.transform?.x ?? 0),
          y: read('transform.y', staticGeometry.transform?.y ?? 0),
          scaleX: read('transform.scaleX', staticGeometry.transform?.scaleX ?? 1),
          scaleY: read('transform.scaleY', staticGeometry.transform?.scaleY ?? 1),
          rotation: read('transform.rotation', staticGeometry.transform?.rotation ?? 0),
          flipH: staticGeometry.transform?.flipH ?? false,
          flipV: staticGeometry.transform?.flipV ?? false,
          // The legacy framing field only applies when the axes are untouched; that
          // rule lives in `effectiveScale`, and passing it through keeps one
          // definition of what "scale" means.
          scale: staticGeometry.transform?.scale,
        },
      };
    };

    // Time-varying geometry cannot be one expression: ffmpeg 4.1 evaluates
    // `scale`/`crop` once, so an animated item is decoded as several segments with
    // a constant value each (SPEC 12 §2.2). An item with no keys — the common case
    // — takes the single-decode path exactly as before.
    const segments = geometrySegments({
      durationUs: item.durationUs,
      keyframeTimes: animatedTimes(item),
      geometryAt,
    });

    let args: string[];
    if (segments.length > 1) {
      args = buildSegmentedDecodeArgs({
        sourcePath: mediaPath,
        inUs: sourceInUs,
        durationUs: item.durationUs,
        filterComplex: segmentedDecodeChain({
          segments,
          targetFps: plan.fps,
          sourceInUs: 0,
          chainFor: (segment) => chainFor(segment.geometry),
        }),
      });
      warnings.push(
        `${item.itemId} animates: rendered in ${segments.length} segments, so its movement steps rather than ramps.`,
      );
    } else {
      args = buildDecodeArgs({
        sourcePath: mediaPath,
        inUs: sourceInUs,
        durationUs: item.durationUs,
        filterChain: chainFor(segments[0]?.geometry ?? geometryAt(0)),
      });
    }
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pause();
    const decoder: ItemDecoder = {
      item,
      child,
      buffered: Buffer.alloc(0),
      framesProduced: 0,
      expectedFrames: Math.max(1, Math.round((item.durationUs / 1_000_000) * plan.fps)),
      done: false,
      stderr: '',
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      decoder.stderr += chunk;
      if (decoder.stderr.length > 4096) decoder.stderr = decoder.stderr.slice(-2048);
    });
    child.on('close', () => {
      decoder.done = true;
    });
    child.on('error', (err) => {
      decoder.done = true;
      warnings.push(`A source video could not be read: ${err.message}`);
    });
    // If the process dies mid-frame the read below rejects; make sure that
    // rejection is handled rather than becoming an unhandled error.
    child.stdout.on('error', () => {
      decoder.done = true;
    });
    return decoder;
  };

  const readFrame = async (decoder: ItemDecoder): Promise<Buffer | null> => {
    while (decoder.buffered.length < frameBytes) {
      if (decoder.done) {
        // Shortfall: repeat the last good frame for up to 2 frames, else fail.
        return null;
      }
      const chunk = await readSome(decoder.child.stdout);
      if (chunk === null) {
        decoder.done = true;
        return null;
      }
      decoder.buffered = Buffer.concat([decoder.buffered, chunk]);
    }
    const frame = decoder.buffered.subarray(0, frameBytes);
    decoder.buffered = decoder.buffered.subarray(frameBytes);
    decoder.framesProduced += 1;
    return frame;
  };

  return {
    label: 'decoded source',
    async open() {
      if (videoItems.length === 0) return;
      const missing = videoItems
        .map((item) => (item.mediaId ? resolveMediaPath(item.mediaId) : undefined))
        .filter((path) => !path || !existsSync(path));
      if (missing.length > 0) {
        throw new Error(
          missing.length === 1
            ? "A file used in this clip can't be found."
            : `${missing.length} files used in this clip can't be found.`,
        );
      }
    },
    async next(index) {
      const visible = visibleAt(index);
      if (visible.length === 0) {
        // Nothing on the timeline here: the canvas colour (§4.1 background).
        return blankFrame(plan.width, plan.height);
      }

      // Lazily start decoders for items that just became visible and stop the
      // ones that have scrolled past, so at most a handful run at once.
      const cap = Math.max(1, Math.min(options.maxDecoders ?? 4, 6));
      for (const item of visible) {
        if (!decoders.has(item.itemId) && decoders.size < cap) {
          const decoder = startDecoder(item);
          if (decoder) decoders.set(item.itemId, decoder);
        }
      }
      for (const [itemId, decoder] of decoders) {
        const item = decoder.item;
        const offScreen = index * frameDurationUs >= item.startUs + item.durationUs;
        if (offScreen) {
          decoder.child.kill('SIGKILL');
          decoders.delete(itemId);
        }
      }

      /*
        Composite every visible layer, bottom first (SPEC 10 §2/§6).

        This used to keep the topmost item that still had a frame and discard the
        rest, which meant an overlay clip replaced the video underneath it and a
        faded or multiplied layer arrived in the file as an opaque, normal
        rectangle. Each layer is now decoded, converted to RGB, and blended onto the
        frame below with its own opacity and mode — the same operation the preview
        performs with CSS.

        When only one layer is visible and it is fully opaque and `normal`, the
        decoded bytes are returned untouched: that is the overwhelmingly common
        case (one clip on the main track) and it keeps the old, cheap path exactly
        as it was rather than round-tripping every frame through RGB for nothing.
      */
      const stack: Array<{ frame: Buffer; opacity: number; blendMode: BlendMode }> = [];
      for (const item of visible) {
        const decoder = decoders.get(item.itemId);
        if (!decoder) continue;
        const frame = await readFrame(decoder);
        if (!frame) {
          // Shortfall on this layer: drop it and let the ones below show through,
          // rather than failing the whole export over one bad clip.
          warnings.push(`The source video for ${item.itemId} ended early.`);
          decoder.child.kill('SIGKILL');
          decoders.delete(item.itemId);
          continue;
        }
        stack.push({
          frame,
          opacity: clampOpacity(item.opacity),
          blendMode: asBlendMode(item.blendMode),
        });
      }

      if (stack.length === 0) return blankFrame(plan.width, plan.height);

      // The single opaque layer fast path: only valid when there is nothing behind
      // it to show through. On a black canvas an opaque `normal` layer covers the
      // backdrop completely, so the decoded bytes are the frame and the RGB
      // round-trip would only cost time. On any other canvas the layer still covers
      // it, so the test is opacity and mode, not the colour.
      const simple =
        stack.length === 1 && stack[0]!.opacity >= 1 && stack[0]!.blendMode === 'normal';
      if (simple) return Buffer.from(stack[0]!.frame);

      /*
        Paint every layer onto a canvas-coloured backdrop, bottom first.

        The backdrop matters. Blending a 50 % bottom layer *toward black* is only
        right when the canvas happens to be black — on a white canvas the export
        would produce a grey frame where the preview shows a pale one. Compositing
        onto the real canvas colour makes the bottom layer an ordinary layer rather
        than a special case, and it makes the bottom layer's blend mode behave like
        every other layer's instead of being silently ignored.

        Buffers are allocated once per call, not per layer: a 1080p RGB frame is
        6 MB and an export runs thousands of them.
      */
      const base: RgbFrame = {
        width: plan.width,
        height: plan.height,
        data: new Uint8ClampedArray(plan.width * plan.height * 3),
      };
      fillCanvas(base, plan.backgroundColor);
      const scratch: RgbFrame = {
        width: plan.width,
        height: plan.height,
        data: new Uint8ClampedArray(base.data.length),
      };
      for (const layer of stack) {
        const rgb = yuvToRgb(splitYuv(layer.frame, plan.width, plan.height), scratch);
        compositeRgb(base, rgb, layer.opacity, layer.blendMode);
      }
      return joinYuv(rgbToYuv(base));
    },
    async close() {
      for (const decoder of decoders.values()) {
        decoder.child.stdout.removeAllListeners();
        decoder.child.kill('SIGKILL');
      }
      decoders.clear();
    },
    /** Exposed for the job log; not part of the FrameSource contract. */
    get warnings() {
      return warnings;
    },
  } as FrameSource & { warnings: string[] };
}

/** Read whatever is available (at least one byte) or `null` at end of stream. */
function readSome(stream: NodeJS.ReadableStream): Promise<Buffer | null> {
  return new Promise((resolveRead, rejectRead) => {
    const onReadable = () => {
      cleanup();
      const chunk = stream.read();
      resolveRead(Buffer.isBuffer(chunk) ? chunk : null);
    };
    const onEnd = () => {
      cleanup();
      resolveRead(null);
    };
    const onError = (err: Error) => {
      cleanup();
      rejectRead(err instanceof CancelledError ? err : new Error(err.message));
    };
    const cleanup = () => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** A black yuv420p frame at the plan's resolution. */
export /** The item's keyframe times per animated property, for the segment boundaries. */
function animatedTimes(item: PlannedItem): number[][] {
  if (!item.keyframes) return [];
  return Object.values(item.keyframes).map((keys) => keys.map((key) => key.timeUs));
}

export function blankFrame(width: number, height: number): Buffer {
  const ySize = width * height;
  const chroma = Math.ceil(width / 2) * Math.ceil(height / 2);
  const frame = Buffer.alloc(ySize + chroma * 2, 128);
  frame.fill(16, 0, ySize);
  return frame;
}

/**
 * Fill an RGB frame with the canvas colour.
 *
 * `#rrggbb` in, and anything unparseable becomes black — which is what the canvas
 * default was before the colour was configurable, so a bad value degrades to the
 * old behaviour instead of failing the export.
 */
function fillCanvas(frame: RgbFrame, color: string | undefined): void {
  const match = /^#?([0-9a-f]{6})$/i.exec(color ?? '');
  const value = match ? parseInt(match[1]!, 16) : 0;
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  for (let index = 0; index < frame.data.length; index += 3) {
    frame.data[index] = red;
    frame.data[index + 1] = green;
    frame.data[index + 2] = blue;
  }
}

/** Opacity of a planned item, clamped to the range the schema stores. */
function clampOpacity(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'add',
  'soft-light',
];

/** A planned item's blend mode, falling back to `normal` for anything unknown. */
function asBlendMode(value: string | undefined): BlendMode {
  return BLEND_MODES.includes(value as BlendMode) ? (value as BlendMode) : 'normal';
}
