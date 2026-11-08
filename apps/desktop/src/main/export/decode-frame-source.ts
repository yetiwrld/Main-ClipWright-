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
  activeAdjustmentLayers,
  activeEffects,
  applyEffectsToFrame,
  compositeRgb,
  compositeRgbMasked,
  effectPassCount,
  effectsForLayer,
  evaluateProperty,
  transitionAt,
  wipeAlphaAt,
  joinYuv,
  rgbToYuv,
  splitYuv,
  yuvToRgb,
  type ActiveEffect,
  type BlendMode,
  type WipeShape,
  type ItemGeometryInput,
  type RgbFrame,
} from '@clipwright/compositor';
import type { Transition } from '@clipwright/project-schema/schemas';
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
  /** The last frame successfully read, kept so a transition can hold it. */
  lastFrame?: Buffer;
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
  /** Items already warned about for a heavy effect chain. */
  const seenHeavyEffects = new Set<string>();
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
  /**
   * How far an item's successor's transition reaches back before the cut.
   *
   * A `start`-aligned window lies entirely before it, a centred one reaches back by
   * half, an `end`-aligned one not at all. Used to keep the *outgoing* clip drawable
   * across the overlap — during a crossfade it has already ended.
   */
  const extensionFor = (item: PlannedItem): number => {
    const successor = videoItems
      .filter((other) => other.trackId === item.trackId && other.startUs > item.startUs)
      .sort((a, b) => a.startUs - b.startUs)[0];
    const transition = successor?.transitionIn;
    if (!transition || transition.durationUs <= 0) return 0;
    if (transition.alignment === 'start') return transition.durationUs;
    if (transition.alignment === 'center') return Math.round(transition.durationUs / 2);
    return 0;
  };

  /** Fade imposed by a transition on an item, given how far through it is. */
  const transitionFade = (item: PlannedItem | undefined, progress: number | null): number => {
    if (!item?.transitionIn || progress === null) return 1;
    const type = item.transitionIn.type;
    if (type === 'fade-black' || type === 'dip-color') {
      return progress < 0.5 ? 0 : (progress - 0.5) * 2;
    }
    return 1;
  };

  /** Opacity for one side of a transition at this instant. */
  const transitionOpacityFor = (
    item: PlannedItem,
    timeUs: number,
  ): { opacity: number; active: boolean; wipe?: WipeShape } => {
    if (item.transitionIn) {
      const at = transitionAt(item.startUs, asTransition(item.transitionIn), timeUs);
      if (at) {
        const fadedByLayers = transitionFade(item, at.progress) < 1;
        return {
          opacity: fadedByLayers ? 1 : at.state.toOpacity,
          active: true,
          // The incoming clip is the one the wipe reveals.
          wipe: at.state.wipe,
        };
      }
    }
    // Outgoing side: the next item on this track may be transitioning in.
    const successor = videoItems
      .filter((other) => other.trackId === item.trackId && other.startUs > item.startUs)
      .sort((a, b) => a.startUs - b.startUs)[0];
    if (successor?.transitionIn) {
      const at = transitionAt(successor.startUs, asTransition(successor.transitionIn), timeUs);
      // The outgoing side is not clipped: it stays whole underneath and the
      // incoming clip is masked over it. Clipping both would leave a gap.
      if (at) return { opacity: at.state.fromOpacity, active: true };
    }
    return { opacity: 1, active: false };
  };

  const visibleAt = (frameIndex: number): PlannedItem[] => {
    const timeUs = frameIndex * frameDurationUs;
    return videoItems
      .filter((item) => {
        const drawTo = item.startUs + item.durationUs + extensionFor(item);
        // The incoming side is widened by its own transition window.
        const incoming = item.transitionIn;
        const drawFrom = incoming
          ? Math.min(
              item.startUs,
              item.startUs -
                (incoming.alignment === 'start'
                  ? incoming.durationUs
                  : incoming.alignment === 'center'
                    ? Math.round(incoming.durationUs / 2)
                    : 0),
            )
          : item.startUs;
        return timeUs >= drawFrom && timeUs < drawTo;
      })
      .sort((a, b) => {
        const order = (a.trackOrder ?? 0) - (b.trackOrder ?? 0);
        if (order !== 0) return order;
        // Same track: the clip that starts later is on top, because that is the one
        // arriving. During a crossfade both are visible at once and ordering by id
        // would paint the outgoing clip over the incoming one for half the window.
        if (a.startUs !== b.startUs) return a.startUs - b.startUs;
        return a.itemId.localeCompare(b.itemId);
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
    // Decode the item's whole *drawable* span, not just its own duration: during a
    // transition it is still on screen after it has ended, and a decoder trimmed to
    // `durationUs` runs dry exactly at the cut — where the fade needs it most.
    // One extra frame of slack: `-t` is exclusive at its boundary, so a decoder
    // trimmed to exactly `durationUs` produces no frame for the instant the item
    // ends. That instant is the *cut* — precisely when a transition needs both
    // clips — so without the slack the outgoing side vanishes for one frame and
    // the crossfade flickers to the incoming clip alone.
    const decodeDurationUs = item.durationUs + extensionFor(item) + frameDurationUs;
    const segments = geometrySegments({
      durationUs: decodeDurationUs,
      keyframeTimes: animatedTimes(item),
      geometryAt,
    });

    let args: string[];
    if (segments.length > 1) {
      args = buildSegmentedDecodeArgs({
        sourcePath: mediaPath,
        inUs: sourceInUs,
        durationUs: decodeDurationUs,
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
        durationUs: decodeDurationUs,
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
      expectedFrames: Math.max(1, Math.round((decodeDurationUs / 1_000_000) * plan.fps)),
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
    // Copied, because `buffered` is a subarray of a buffer that is replaced on the
    // next read: holding a view of it would see the following frame's bytes.
    decoder.lastFrame = Buffer.from(frame);
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
        // The *drawable* end, not the item's own: during a transition the outgoing
        // clip is still on screen after it has ended, and killing its decoder here
        // would leave the crossfade painting a hole.
        const offScreen =
          index * frameDurationUs >= item.startUs + item.durationUs + extensionFor(item);
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
      const stack: Array<{
        frame: Buffer;
        opacity: number;
        blendMode: BlendMode;
        effects: ActiveEffect[];
        /** Stacking order of the layer's track; decides which adjustment layers grade it. */
        trackOrder: number;
        /** Set while a wipe is revealing this layer (SPEC 12 §4.2). */
        wipe?: WipeShape;
      }> = [];

      /*
        Adjustment layers at this frame (SPEC 12 §3.1). They are not layers
        themselves — they have no picture — so they never enter `stack`; they only
        contribute a chain to the layers below them. Resolved once per frame: every
        layer under one adjustment layer must see the same chain, and re-resolving it
        per layer would let them drift apart if the filter were order-dependent.
      */
      const adjustmentLayers = activeAdjustmentLayers(
        plan.items.map((item) => ({
          id: item.itemId,
          type: item.type,
          startUs: item.startUs,
          durationUs: item.durationUs,
          trackOrder: item.trackOrder ?? 0,
          effects: item.effects,
        })),
        index * frameDurationUs,
      );

      for (const item of visible) {
        const decoder = decoders.get(item.itemId);
        if (!decoder) continue;
        const frame = await readFrame(decoder);
        if (!frame) {
          /*
            The decoder ran out of material while the item is still supposed to be
            on screen. That happens at exactly one place in practice: a crossfade
            whose outgoing clip ends where its source ends, so there are no "handles"
            past the cut. Dropping the layer there makes the transition flicker to
            the incoming clip for a frame or two, which reads as a stutter.

            Holding the last decoded frame for the remainder of the drawable span is
            what an editor does with a still frame, and it is visibly better than a
            hole. The warning still names the item, so the shortfall is not silent.
          */
          warnings.push(`The source video for ${item.itemId} ended early.`);
          decoder.child.kill('SIGKILL');
          decoders.delete(item.itemId);
          if (decoder.lastFrame) {
            const transition = transitionOpacityFor(item, index * frameDurationUs);
            stack.push({
              frame: decoder.lastFrame,
              opacity: clampOpacity(item.opacity) * transition.opacity,
              blendMode: asBlendMode(item.blendMode),
              effects: activeEffects(item.effects),
              trackOrder: item.trackOrder ?? 0,
              wipe: transition.wipe,
            });
          }
          continue;
        }
        const transition = transitionOpacityFor(item, index * frameDurationUs);
          const effects = activeEffects(item.effects);
        // §3.2 wants a warning at six or more passes. Warned once per item rather
        // than once per frame, or a sixty-second export would emit eighteen hundred
        // copies of it.
        if (effectPassCount(effects) >= 6 && seenHeavyEffects.add(item.itemId)) {
          warnings.push(
            `${item.itemId} has ${effectPassCount(effects)} effect passes, which will slow this export.`,
          );
        }
        stack.push({
          frame,
          opacity: clampOpacity(item.opacity) * transition.opacity,
          blendMode: asBlendMode(item.blendMode),
          effects,
          trackOrder: item.trackOrder ?? 0,
          wipe: transition.wipe,
        });
      }

      if (stack.length === 0) return blankFrame(plan.width, plan.height);

      // The single opaque layer fast path: only valid when there is nothing behind
      // it to show through *and* nothing to do to it. An effect chain has to run
      // through RGB, so a graded clip cannot take this path even when it is the only
      // layer and fully opaque — the check that used to ignore that shipped effects
      // that were applied only when a second layer happened to exist.
      const simple =
        stack.length === 1 &&
        stack[0]!.opacity >= 1 &&
        stack[0]!.blendMode === 'normal' &&
        stack[0]!.effects.length === 0 &&
        // A live adjustment layer above this layer has to grade it, which needs RGB.
        adjustmentLayers.length === 0;
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
      /*
        An adjustment layer grades the *composite* of everything below it, not each
        layer separately. The difference is not academic: an adjustment layer over two
        half-opaque layers must grade their blend, and grading each at full strength
        first would double the correction and halve the blending's authority.

        So the layers are composited bottom-up into `base` as they always were, and
        the pending chains are flushed onto `base` at the moment the walk crosses the
        adjustment layer's track. `applyToBase` is that flush.
      */
      let pendingAdjustment = 0;
      const applyToBase = (upTo: number) => {
        while (
          pendingAdjustment < adjustmentLayers.length &&
          adjustmentLayers[pendingAdjustment]!.trackOrder < upTo
        ) {
          const chain = adjustmentLayers[pendingAdjustment]!.effects;
          applyEffectsToFrame(base.data, plan.width, plan.height, chain);
          pendingAdjustment += 1;
        }
      };
      for (const layer of stack) {
        // Anything below this layer has already been composited, so any adjustment
        // layer at or below it is due now. Doing this *before* the layer blends in
        // is what keeps an adjustment layer from grading a clip above it.
        applyToBase(layer.trackOrder);
        const rgb = yuvToRgb(splitYuv(layer.frame, plan.width, plan.height), scratch);
        // Effects run on the layer's own picture, before it is blended into the
        // frame below (SPEC 12 §3.1). Applying them after compositing would grade
        // whatever is underneath as well, which is a different — and much less
        // useful — operation.
        if (layer.effects.length > 0) {
          applyEffectsToFrame(rgb.data, plan.width, plan.height, layer.effects);
        }
        if (layer.wipe) {
          // A wipe is the one transition that is not an opacity: which pixels show
          // the incoming clip depends on where they are, so the layer is composited
          // through a per-pixel mask instead. Building the mask costs one pass over
          // the frame, and only while a wipe is actually running.
          compositeRgbMasked(
            base,
            rgb,
            layer.opacity,
            layer.blendMode,
            wipeMaskFor(layer.wipe, plan.width, plan.height),
          );
          continue;
        }
        compositeRgb(base, rgb, layer.opacity, layer.blendMode);
      }
      // Adjustment layers stacked above everything on the canvas still grade what
      // was painted; `Infinity` flushes whatever is left.
      applyToBase(Number.POSITIVE_INFINITY);
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
/**
 * The alpha mask for a wipe, one value per pixel (SPEC 12 §4.2).
 *
 * The shape's normal is normalised in the *frame's* space, so `t` runs 0 → 1 across
 * the projection of each pixel onto that normal. On a 16:9 frame a horizontal wipe
 * therefore sweeps the full width, and a diagonal one sweeps corner to corner at a
 * constant speed rather than arriving at one side first.
 */
function wipeMaskFor(shape: WipeShape, width: number, height: number): Float32Array {
  const mask = new Float32Array(width * height);
  // Projection bounds, so `t` is normalised to [0, 1] for any direction.
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => x! * shape.axisX + y! * shape.axisY);
  const min = Math.min(...corners);
  const span = Math.max(...corners) - min || 1;
  for (let y = 0; y < height; y += 1) {
    // Sample at pixel centres: sampling at the corner shifts a hard edge half a
    // pixel left of where it belongs, which is visible as a seam at p = 0.
    const ny = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width;
      const t = (nx * shape.axisX + ny * shape.axisY - min) / span;
      mask[y * width + x] = wipeAlphaAt(t, shape.position, shape.softness);
    }
  }
  return mask;
}

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

/**
 * A planned transition as the schema's shape.
 *
 * The plan carries it structurally rather than by importing the schema, so the
 * export package does not depend on the project schema. The cast is safe because
 * the planner copies the stored value; the enums are re-asserted here so a file
 * written by a newer build degrades to a sensible default instead of crashing.
 */
function asTransition(
  transition: PlannedItem['transitionIn'] | undefined,
): Transition | undefined {
  if (!transition) return undefined;
  const alignment =
    transition.alignment === 'start' || transition.alignment === 'end'
      ? transition.alignment
      : 'center';
  return {
    id: 'planned',
    type: transition.type as Transition['type'],
    durationUs: transition.durationUs,
    alignment,
    params: transition.params,
    easing: transition.easing as Transition['easing'],
    crossfadeAudio: true,
  };
}

/** A planned item's blend mode, falling back to `normal` for anything unknown. */
function asBlendMode(value: string | undefined): BlendMode {
  return BLEND_MODES.includes(value as BlendMode) ? (value as BlendMode) : 'normal';
}
