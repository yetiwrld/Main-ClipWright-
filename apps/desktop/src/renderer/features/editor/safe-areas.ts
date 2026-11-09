/**
 * Safe areas, platform UI zones and the composition guides (SPEC 10 §9).
 *
 * Two things are kept apart here, deliberately:
 *
 * - **The geometry**, which is arithmetic on fractions of the canvas and is worth
 *   testing without a DOM.
 * - **The numbers themselves**, which live in `assets/safe-areas.json` because SPEC 10
 *   §9 asks for data rather than code. Platforms move their chrome around; a value
 *   baked into a `.ts` file is a rebuild, and one baked into a validator is a release.
 *
 * Everything produced here is an overlay. Nothing in this module is ever consulted by
 * the exporter, and the rectangles it returns are in *canvas fractions*, so they cannot
 * be mistaken for pixels or handed to a renderer that draws to a frame.
 */

import type { GridChoice } from './grid.js';

export interface PlatformZone {
  label: string;
  /** Fraction of the canvas height covered by platform chrome at the top. */
  top: number;
  /** Fraction covered at the bottom — the largest, because of scrub bars and CTAs. */
  bottom: number;
  /** Fraction covered at the right — action buttons. */
  right: number;
}

export interface SafeAreaData {
  titleSafe: number;
  actionSafe: number;
  platforms: Record<string, PlatformZone>;
}

/** A rectangle in canvas fractions, origin top-left. */
export interface GuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which overlay is showing. At most one set at a time (SPEC 10 §9). */
export type OverlayKind = 'none' | 'title-safe' | 'action-safe' | 'platform-zones';

/** The overlays that are not a set of rectangles: lines across the frame. */
export type LineOverlayKind = 'thirds' | 'centre-cross';

const isFraction = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Validate the shipped data at module load.
 *
 * Runs in the app, in the tests and in `check-repo`, so a malformed file is a build
 * failure rather than an overlay that silently draws off-screen. The same reasoning as
 * the caption presets: a data file nobody validates is a data file that rots.
 */
export function parseSafeAreas(raw: unknown): SafeAreaData {
  if (typeof raw !== 'object' || raw === null) throw new Error('safe-areas.json: not an object');
  const record = raw as Record<string, unknown>;
  if (!isFraction(record.titleSafe)) throw new Error('safe-areas.json: titleSafe is not a fraction');
  if (!isFraction(record.actionSafe)) throw new Error('safe-areas.json: actionSafe is not a fraction');
  /*
    Title safe is the *smaller* rectangle — 90% inside 93% — so a file with them the
    wrong way round would draw the looser guide inside the tighter one and read as a
    bug in the drawing rather than in the data.
  */
  if ((record.titleSafe as number) > (record.actionSafe as number)) {
    throw new Error('safe-areas.json: titleSafe must be inside actionSafe');
  }
  const platforms = record.platforms;
  if (typeof platforms !== 'object' || platforms === null) {
    throw new Error('safe-areas.json: platforms is not an object');
  }
  const parsedPlatforms: Record<string, PlatformZone> = {};
  for (const [aspect, value] of Object.entries(platforms as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`safe-areas.json: platform ${aspect} is not an object`);
    }
    const zone = value as Record<string, unknown>;
    for (const side of ['top', 'bottom', 'right'] as const) {
      if (!isFraction(zone[side])) {
        throw new Error(`safe-areas.json: ${aspect}.${side} is not a fraction`);
      }
    }
    /*
      The two vertical bands must not meet or overlap: a file where they sum past 1
      describes a screen with no safe area at all, which is never what a platform means
      and would make the overlay draw inverted.
    */
    if ((zone.top as number) + (zone.bottom as number) >= 1) {
      throw new Error(`safe-areas.json: ${aspect} top and bottom bands overlap`);
    }
    parsedPlatforms[aspect] = {
      label: typeof zone.label === 'string' ? zone.label : aspect,
      top: zone.top as number,
      bottom: zone.bottom as number,
      right: zone.right as number,
    };
  }
  if (Object.keys(parsedPlatforms).length === 0) {
    throw new Error('safe-areas.json: no platforms');
  }
  return {
    titleSafe: record.titleSafe,
    actionSafe: record.actionSafe,
    platforms: parsedPlatforms,
  };
}

/** A centred rectangle covering `fraction` of each side of the canvas. */
export function safeAreaRect(fraction: number): GuideRect {
  /*
    Clamped rather than trusted: a caller passing 1.5 would draw outside the canvas and
    a negative one would draw inverted, and neither is a thing a guide should be able
    to do however the value arrived.
  */
  const size = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const inset = (1 - size) / 2;
  return { x: inset, y: inset, width: size, height: size };
}

/**
 * The platform's chrome, as the bands it actually covers.
 *
 * Returned as separate bands rather than one rectangle because that is what a platform
 * does: it covers three edges and leaves the middle alone. Drawing one rectangle would
 * dim the safe area instead of the unsafe one.
 */
export function platformBands(zone: PlatformZone): {
  top: GuideRect;
  bottom: GuideRect;
  right: GuideRect;
} {
  return {
    top: { x: 0, y: 0, width: 1, height: zone.top },
    bottom: { x: 0, y: 1 - zone.bottom, width: 1, height: zone.bottom },
    right: { x: 1 - zone.right, y: 0, width: zone.right, height: 1 },
  };
}

/**
 * The aspect key a platform zone should be looked up by, or `null`.
 *
 * Platform chrome only exists for vertical and portrait frames; a 16:9 landscape
 * composition has no top band and no right column of buttons, so showing them would be
 * a guide to nothing.
 */
export function platformKeyFor(aspect: string): string | null {
  return aspect === '9:16' || aspect === '4:5' ? aspect : null;
}

/**
 * The overlay state the preview holds, and the one place the "at most one set" rule
 * lives (SPEC 10 §9).
 *
 * The spec's phrasing — "at most one overlay set shows by default" — is a rule about
 * which combinations are allowed, so it is modelled as a selection rather than as four
 * independent booleans that a caller could turn all of on.
 */
export interface OverlayState {
  /** Safe areas and platform zones: mutually exclusive. */
  areas: OverlayKind;
  /**
   * The composition grid — the thirds by default, or whatever N×M the user chose.
   *
   * Named `thirds` because that is what it was and what it still is unless asked
   * otherwise: the spec describes one overlay with two settings, so widening this from a
   * boolean to a `GridChoice` adds the custom case without a second toggle or a second
   * keybinding. `null` is off.
   */
  thirds: GridChoice | null;
  centreCross: boolean;
}

export const OVERLAYS_OFF: OverlayState = { areas: 'none', thirds: null, centreCross: false };

/**
 * Cycle to the next area overlay.
 *
 * Safe areas are off by default and the cycle turns them on, so one keypress walks
 * `none → title → action → platform → none`. Cycling rather than four toggle keys
 * because the spec's `Ctrl+;` is a single binding for the whole set.
 */
export function nextAreaOverlay(kind: OverlayKind, hasPlatform: boolean): OverlayKind {
  switch (kind) {
    case 'none':
      return 'title-safe';
    case 'title-safe':
      return 'action-safe';
    case 'action-safe':
      // A landscape canvas has no platform chrome, so the cycle skips that stop rather
      // than offering a guide that would draw nothing.
      return hasPlatform ? 'platform-zones' : 'none';
    case 'platform-zones':
    default:
      return 'none';
  }
}

/** Whether anything at all is being drawn — the panel skips the whole overlay tree. */
export function overlaysVisible(state: OverlayState): boolean {
  return state.areas !== 'none' || state.thirds !== null || state.centreCross;
}
