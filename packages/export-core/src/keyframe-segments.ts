/**
 * SPEC 12 §2.2 / 14 §4.2 — keyframed properties in a decode that has no notion of
 * time.
 *
 * The bundled ffmpeg 4.1 evaluates `scale`/`crop` expressions **once**, at
 * configuration time; there is no `t` and no per-frame re-evaluation (measured:
 * `scale=w='iw*(1+t)'` fails with "Undefined constant"). So a keyframed move
 * cannot be written as one expression.
 *
 * It can be written as several: split the item's range at each keyframe time,
 * bake the value that is valid inside each segment, and concatenate. A move from
 * scale 1 to scale 1.3 over one second becomes two decodes — 1.0, then 1.3 — which
 * is a step rather than a ramp. That is visibly coarser than the preview, and it
 * is why this module returns the segment count: the caller reports how many
 * segments a clip was rendered in, so "this export stepped" is a fact in the log
 * rather than something the user has to notice.
 *
 * Why not interpolate at a fixed frame interval instead? Because each segment is a
 * separate `trim` + decode over the whole source; N segments cost roughly N passes
 * over the source. Baking per *keyframe* keeps the cost proportional to the work
 * the user actually asked for, and the segments can be merged when the values are
 * equal (see `mergeEqualSegments`), so a keyframe pair that happens to hold still
 * costs nothing extra.
 */

/**
 * A property value baked for one contiguous time range.
 *
 * Deliberately generic: the caller supplies whatever its filter chain understands.
 * `@clipwright/compositor`'s `ItemGeometry` is what the export passes, but keeping
 * the type open means this module does not need a dependency on the compositor just
 * to describe a rectangle.
 */
export interface GeometrySegment<T> {
  /** Start of the segment, in microseconds from the item's own start. */
  startUs: number;
  /** End of the segment, exclusive. */
  endUs: number;
  /** The geometry to bake for the whole segment. */
  geometry: T;
}

/** Anything that can produce the geometry at a given instant. */
export type GeometryAt<T> = (timeUs: number) => T;

/**
 * The distinct times a property changes value within `[0, durationUs)`.
 *
 * Keyframe times are clipped to the item's range: a key outside the item is not a
 * place the item's picture changes, and including it would emit an empty segment.
 */
export function segmentBoundaries(
  keyframeTimes: ReadonlyArray<ReadonlyArray<number>>,
  durationUs: number,
): number[] {
  const times = new Set<number>([0]);
  for (const list of keyframeTimes) {
    for (const time of list) {
      // `time` is in item-local microseconds; a key at exactly `durationUs` closes
      // the range rather than opening a zero-length segment after it.
      if (time > 0 && time < durationUs) times.add(Math.round(time));
    }
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Two geometries are the same segment if every baked number matches.
 *
 * Compared to six decimals rather than exactly: the values come out of `evaluate`,
 * which does floating-point interpolation, and two segments that differ in the
 * last bit should not cost a second decode.
 */
/** The fields a baked geometry has to agree on to share one decode. */
interface ComparableGeometry {
  crop?: { left?: number; top?: number; right?: number; bottom?: number };
  transform?: {
    x?: number;
    y?: number;
    scaleX?: number;
    scaleY?: number;
    rotation?: number;
    flipH?: boolean;
    flipV?: boolean;
  };
}

export function sameGeometry(a: ComparableGeometry, b: ComparableGeometry): boolean {
  const close = (x: number | undefined, y: number | undefined) =>
    Math.abs((x ?? 0) - (y ?? 0)) < 1e-6;
  const edges: Array<'left' | 'top' | 'right' | 'bottom'> = ['left', 'top', 'right', 'bottom'];
  for (const edge of edges) {
    if (!close(a.crop?.[edge], b.crop?.[edge])) return false;
  }
  if (!close(a.transform?.x, b.transform?.x)) return false;
  if (!close(a.transform?.y, b.transform?.y)) return false;
  if (!close(a.transform?.scaleX, b.transform?.scaleX)) return false;
  if (!close(a.transform?.scaleY, b.transform?.scaleY)) return false;
  if (!close(a.transform?.rotation, b.transform?.rotation)) return false;
  if ((a.transform?.flipH ?? false) !== (b.transform?.flipH ?? false)) return false;
  if ((a.transform?.flipV ?? false) !== (b.transform?.flipV ?? false)) return false;
  return true;
}

/**
 * Split `[0, durationUs)` at the keyframe times and bake each segment.
 *
 * Returns a single segment when nothing animates, which is the common case: the
 * caller then issues exactly the decode it issued before keyframes existed.
 */
export function geometrySegments<T extends ComparableGeometry>(options: {
  durationUs: number;
  keyframeTimes?: ReadonlyArray<ReadonlyArray<number>>;
  geometryAt: GeometryAt<T>;
  /** Floor so a pathological file cannot spawn hundreds of decodes. */
  maxSegments?: number;
}): Array<GeometrySegment<T>> {
  const durationUs = Math.max(1, Math.round(options.durationUs));
  const boundaries = segmentBoundaries(options.keyframeTimes ?? [], durationUs);
  const limit = Math.max(1, options.maxSegments ?? 32);
  if (boundaries.length > limit) {
    // Drop the least significant boundaries rather than refuse the export: an
    // approximation the log admits to beats a render that never starts.
    const stride = boundaries.length / limit;
    const kept = new Set<number>([0]);
    for (let index = 0; index < limit; index += 1) kept.add(boundaries[Math.floor(index * stride)]!);
    boundaries.length = 0;
    boundaries.push(...[...kept].sort((a, b) => a - b));
  }

  const segments: Array<GeometrySegment<T>> = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const startUs = boundaries[index]!;
    const endUs = index + 1 < boundaries.length ? boundaries[index + 1]! : durationUs;
    if (endUs <= startUs) continue;
    const geometry = options.geometryAt(startUs);
    const previous = segments[segments.length - 1];
    if (previous && sameGeometry(previous.geometry, geometry)) {
      // Hold the first segment open instead of emitting a duplicate decode.
      previous.endUs = endUs;
      continue;
    }
    segments.push({ startUs, endUs, geometry });
  }
  return segments;
}

/**
 * The `filter_complex` for a segmented decode (SPEC 14 §4.2).
 *
 * `split` first, then one `trim` per segment: filtering the same input twice
 * without `split` gives the second branch an already-consumed stream and it
 * silently produces nothing (measured: a two-segment chain emitted 30 of its 60
 * frames). `setsar=1` at the end of every branch is the other requirement —
 * `concat` refuses branches whose sample aspect ratios differ, and a scaled branch
 * picks up a different SAR from an unscaled one.
 *
 * Each branch must already be `yuv420p`: `concat` will not convert, and the
 * encoder's input is the same format.
 */
export function segmentedDecodeChain<T extends { startUs: number; endUs: number }>(options: {
  segments: ReadonlyArray<T>;
  /** The per-segment chain, from `sourceFilterChain`. */
  chainFor: (segment: T, index: number) => string;
  targetFps: number;
  /** The item's own start offset in the source, in microseconds. */
  sourceInUs: number;
}): string {
  const segments = options.segments;
  if (segments.length === 0) throw new Error('A segmented decode needs at least one segment.');

  const branches: string[] = [];
  const labels: string[] = [];
  if (segments.length > 1) {
    branches.push(`[0:v]split=${segments.length}${segments.map((_, index) => `[s${index}]`).join('')}`);
  }
  for (const [index, segment] of segments.entries()) {
    const input = segments.length > 1 ? `[s${index}]` : '[0:v]';
    const from = (options.sourceInUs + segment.startUs) / 1_000_000;
    const to = (options.sourceInUs + segment.endUs) / 1_000_000;
    // `fps` before `trim`: trimming raw timestamps on a variable-frame-rate source
    // lands the cut between two frames and the segment count comes out short.
    // `sourceFilterChain` opens with the same filter, so the two `fps` stages in a
    // row are harmless — but the per-segment chain is built for a standalone
    // decode, and passing a second fps flag through the options would only make the
    // two callers disagree about the grid.
    branches.push(
      `${input}fps=${options.targetFps}:round=near,trim=${from.toFixed(6)}:${to.toFixed(6)},setpts=PTS-STARTPTS,${options.chainFor(segment, index)}[v${index}]`,
    );
    labels.push(`[v${index}]`);
  }

  if (segments.length > 1) {
    branches.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0[out]`);
  }
  return branches.join(';');
}
