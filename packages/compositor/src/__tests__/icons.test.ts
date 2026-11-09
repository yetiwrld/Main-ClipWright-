import { describe, expect, it } from 'vitest';
import {
  ICON_COUNT,
  ICON_LIBRARY,
  ICON_NAMES,
  searchIconLibrary,
} from '../icon-library.js';
import {
  arcsAreCircular,
  circularArcToCubics,
  hasArcCommand,
  iconGeometry,
  ICON_VIEWBOX,
  iconAppearanceKey,
  iconLibraryFromStored,
  pathToSubpaths,
  resolveIconItem,
  supportedPathCommands,
  tokenisePath,
  type IconDefinition,
  type IconShape,
} from '../icons.js';
import type { ShapeSubpath } from '../shapes.js';

/**
 * SPEC 11 §12 — the offline icon library.
 *
 * The fixtures below are **verbatim** from the installed Lucide set (`lucide-react@0.475.0`),
 * not hand-written approximations, because the whole question this module answers is whether
 * the real icons convert. A test against invented paths would pass while the picker showed
 * empty tiles.
 *
 * The failures guarded against, in the order they actually happened: paths drawing in the
 * wrong unit, arcs being refused wholesale, rotation being used to reject circular arcs,
 * a tokeniser splitting `1e-5` into a command, and a `d` parsed partially instead of not at
 * all.
 */

const ICONS: readonly IconDefinition[] = [
  {
    name: 'clock',
    shapes: [
      {"t": "circle", "cx": 12, "cy": 12, "r": 10},
      {"t": "polyline", "points": "12 6 12 12 16 14"},
    ],
  },
  {
    name: 'star',
    shapes: [
      {"t": "path", "d": "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"},
    ],
  },
  {
    name: 'umbrella',
    shapes: [
      {"t": "path", "d": "M22 12a10.06 10.06 1 0 0-20 0Z"},
      {"t": "path", "d": "M12 12v8a2 2 0 0 0 4 0"},
      {"t": "path", "d": "M12 2v1"},
    ],
  },
  {
    name: 'table-rows-split',
    shapes: [
      {"t": "path", "d": "M14 10h2"},
      {"t": "path", "d": "M15 22v-8"},
      {"t": "path", "d": "M15 2v4"},
      {"t": "path", "d": "M2 10h2"},
      {"t": "path", "d": "M20 10h2"},
      {"t": "path", "d": "M3 19h18"},
      {"t": "path", "d": "M3 22v-6a2 2 135 0 1 2-2h14a2 2 45 0 1 2 2v6"},
      {"t": "path", "d": "M3 2v2a2 2 45 0 0 2 2h14a2 2 135 0 0 2-2V2"},
      {"t": "path", "d": "M8 10h2"},
      {"t": "path", "d": "M9 22v-8"},
      {"t": "path", "d": "M9 2v4"},
    ],
  },
  {
    name: 'triangle',
    shapes: [
      {"t": "path", "d": "M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"},
    ],
  },
  {
    name: 'circle',
    shapes: [
      {"t": "circle", "cx": 12, "cy": 12, "r": 10},
    ],
  },
  {
    name: 'square',
    shapes: [
      {"t": "rect", "x": 3, "y": 3, "w": 18, "h": 18, "rx": 2},
    ],
  },
  {
    name: 'play',
    shapes: [
      {"t": "polygon", "points": "6 3 20 12 6 21 6 3"},
    ],
  },
  {
    name: 'heart',
    shapes: [
      {"t": "path", "d": "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"},
    ],
  },
  {
    name: 'user',
    shapes: [
      {"t": "path", "d": "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"},
      {"t": "circle", "cx": 12, "cy": 7, "r": 4},
    ],
  },
  {
    name: 'mail',
    shapes: [
      {"t": "rect", "x": 2, "y": 4, "w": 20, "h": 16, "rx": 2},
      {"t": "path", "d": "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"},
    ],
  },
  {
    name: 'bell',
    shapes: [
      {"t": "path", "d": "M10.268 21a2 2 0 0 0 3.464 0"},
      {"t": "path", "d": "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"},
    ],
  },
  {
    name: 'settings',
    shapes: [
      {"t": "path", "d": "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"},
      {"t": "circle", "cx": 12, "cy": 12, "r": 3},
    ],
  },
  {
    name: 'video',
    shapes: [
      {"t": "path", "d": "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"},
      {"t": "rect", "x": 2, "y": 6, "w": 14, "h": 12, "rx": 2},
    ],
  },
  {
    name: 'download',
    shapes: [
      {"t": "path", "d": "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"},
      {"t": "polyline", "points": "7 10 12 15 17 10"},
      {"t": "line", "x1": 12, "y1": 15, "x2": 12, "y2": 3},
    ],
  },
  {
    name: 'lock',
    shapes: [
      {"t": "rect", "x": 3, "y": 11, "w": 18, "h": 11, "rx": 2},
      {"t": "path", "d": "M7 11V7a5 5 0 0 1 10 0v4"},
    ],
  },
  {
    name: 'map-pin',
    shapes: [
      {"t": "path", "d": "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"},
      {"t": "circle", "cx": 12, "cy": 10, "r": 3},
    ],
  },
  {
    name: 'wifi',
    shapes: [
      {"t": "path", "d": "M12 20h.01"},
      {"t": "path", "d": "M2 8.82a15 15 0 0 1 20 0"},
      {"t": "path", "d": "M5 12.859a10 10 0 0 1 14 0"},
      {"t": "path", "d": "M8.5 16.429a5 5 0 0 1 7 0"},
    ],
  },
  {
    name: 'sun',
    shapes: [
      {"t": "circle", "cx": 12, "cy": 12, "r": 4},
      {"t": "path", "d": "M12 2v2"},
      {"t": "path", "d": "M12 20v2"},
      {"t": "path", "d": "m4.93 4.93 1.41 1.41"},
      {"t": "path", "d": "m17.66 17.66 1.41 1.41"},
      {"t": "path", "d": "M2 12h2"},
      {"t": "path", "d": "M20 12h2"},
      {"t": "path", "d": "m6.34 17.66-1.41 1.41"},
      {"t": "path", "d": "m19.07 4.93-1.41 1.41"},
    ],
  },
  {
    name: 'target',
    shapes: [
      {"t": "circle", "cx": 12, "cy": 12, "r": 10},
      {"t": "circle", "cx": 12, "cy": 12, "r": 6},
      {"t": "circle", "cx": 12, "cy": 12, "r": 2},
    ],
  },
  {
    name: 'x',
    shapes: [
      {"t": "path", "d": "M18 6 6 18"},
      {"t": "path", "d": "m6 6 12 12"},
    ],
  },
  {
    name: 'check',
    shapes: [
      {"t": "path", "d": "M20 6 9 17l-5-5"},
    ],
  },
  {
    name: 'menu',
    shapes: [
      {"t": "line", "x1": 4, "y1": 12, "x2": 20, "y2": 12},
      {"t": "line", "x1": 4, "y1": 6, "x2": 20, "y2": 6},
      {"t": "line", "x1": 4, "y1": 18, "x2": 20, "y2": 18},
    ],
  },
  {
    name: 'plus',
    shapes: [
      {"t": "path", "d": "M5 12h14"},
      {"t": "path", "d": "M12 5v14"},
    ],
  },
  {
    name: 'arrow-right',
    shapes: [
      {"t": "path", "d": "M5 12h14"},
      {"t": "path", "d": "m12 5 7 7-7 7"},
    ],
  },
  {
    name: 'gift',
    shapes: [
      {"t": "rect", "x": 3, "y": 8, "w": 18, "h": 4, "rx": 1},
      {"t": "path", "d": "M12 8v13"},
      {"t": "path", "d": "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"},
      {"t": "path", "d": "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"},
    ],
  },
  {
    name: 'camera',
    shapes: [
      {"t": "path", "d": "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"},
      {"t": "circle", "cx": 12, "cy": 13, "r": 3},
    ],
  },
  {
    name: 'trash-2',
    shapes: [
      {"t": "path", "d": "M3 6h18"},
      {"t": "path", "d": "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"},
      {"t": "path", "d": "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"},
      {"t": "line", "x1": 10, "y1": 11, "x2": 10, "y2": 17},
      {"t": "line", "x1": 14, "y1": 11, "x2": 14, "y2": 17},
    ],
  },
];

/** A Lucide coordinate in the 100-box the shape renderers use. */
const box = (value: number) => (value / 24) * 100;

const byName = (name: string): IconDefinition => {
  const icon = ICONS.find((candidate) => candidate.name === name);
  if (!icon) throw new Error(`no fixture named ${name}`);
  return icon;
};

/** Every coordinate a geometry result produces, in the order the renderers would read them. */
const allCoordinates = (subpaths: readonly ShapeSubpath[]): number[] =>
  subpaths.flatMap((subpath) => [
    subpath.x,
    subpath.y,
    ...subpath.segments.flatMap((segment) =>
      segment.op === 'cubic'
        ? [segment.c1x, segment.c1y, segment.c2x, segment.c2y, segment.x, segment.y]
        : [segment.x, segment.y],
    ),
  ]);

describe('converting the real Lucide set (SPEC 11 §12)', () => {
  it('converts every fixture that does not use an elliptical arc', () => {
    const refused = ICONS.map((icon) => [icon.name, iconGeometry(icon)] as const)
      .filter(([, result]) => !result.ok)
      .map(([name, result]) => `${name}:${result.ok ? '' : result.reason}`);

    // `gift` is the one real refusal: Lucide draws its ribbon with `A4.8 8` — a genuine
    // ellipse, not a rounded corner. Everything else must convert.
    expect(refused).toEqual(['gift:arc']);
  });

  it('refuses an elliptical arc by name rather than drawing it approximately', () => {
    const result = iconGeometry(byName('gift'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('arc');
    // The detail names the icon and shows the offending path, so a user report is actionable.
    expect(result.detail).toContain('gift');
  });

  it('accepts a circular arc written with a non-zero x-axis-rotation', () => {
    /*
      `umbrella` and `table-rows-split` write `a2 2 135 0 1 2-2` and `a10.06 10.06 1 0 0-20 0`.
      Rotating a circle leaves the same circle, so the rotation is a no-op that Lucide relies
      on. Rejecting `rotation !== 0` refused both icons; this is that regression.
    */
    expect(iconGeometry(byName('umbrella')).ok).toBe(true);
    expect(iconGeometry(byName('table-rows-split')).ok).toBe(true);
  });

  it('returns the 100-box, not Lucide units and not fractions, for every kind of shape', () => {
    /*
      Two bugs are guarded here, and both were real. First `M`/`L`/`C` emitted raw 24-box
      units while arcs and primitives emitted converted ones, so a straight-line icon drew
      24× too large. Then everything emitted a 0–1 fraction, which is one hundredth of the
      box `ShapeSubpath` is defined in — an icon would have been a dot in the corner.
    */
    for (const name of ['star', 'clock', 'square', 'triangle', 'play', 'x', 'check', 'wifi']) {
      const result = iconGeometry(byName(name));
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      const coordinates = allCoordinates(result.subpaths);
      expect(coordinates.length, name).toBeGreaterThan(0);
      // Lucide draws inside 0…24 with a 2-unit stroke inset by 1, so in the 100-box every
      // coordinate lands inside roughly -5…105. A value near 24 means nothing was converted;
      // a value near 1 means it was converted to a fraction instead of to the box.
      expect(Math.min(...coordinates), name).toBeGreaterThan(-10);
      expect(Math.max(...coordinates), name).toBeLessThan(110);
      // And at least one coordinate has to be well outside a 0–1 fraction, or the assertion
      // above would pass on an icon that had been scaled to nothing.
      expect(Math.max(...coordinates), name).toBeGreaterThan(9);
    }
  });

  it('lands in the same box a built-in shape does, so one renderer draws both', () => {
    /*
      The contract that makes icons cheap: an icon's subpaths are ordinary `ShapeSubpath`s in
      the 100-box, so `paintShape` and `assShapeDrawing` draw one without knowing it is an
      icon. A full-bleed icon must therefore fill the same box a `rect` does.
    */
    const square = iconGeometry({ name: 'box', shapes: [{ t: 'path', d: 'M0 0 L24 0 L24 24 L0 24 Z' }] });
    expect(square.ok).toBe(true);
    if (!square.ok) return;
    const coordinates = allCoordinates(square.subpaths);
    expect(Math.min(...coordinates)).toBe(0);
    expect(Math.max(...coordinates)).toBe(100);
  });

  it('gives the same geometry every time, because both renderers read it', () => {
    const first = iconGeometry(byName('star'));
    const second = iconGeometry(byName('star'));
    expect(first).toEqual(second);
    if (!first.ok) return;
    // No `NaN` may reach a renderer: a single one turns the whole path invisible in canvas and
    // makes the ASS drawing string unparsable, so the icon vanishes rather than looks wrong.
    expect(allCoordinates(first.subpaths).every(Number.isFinite)).toBe(true);
  });
});

describe('path data parsing', () => {
  it('reads exponents as numbers, not as commands', () => {
    /*
      The tokeniser used to split on any letter, so `1e-5` became a command named `e`. Matching
      a whole number (exponent included) or a lone command letter fixes it.
    */
    const tokens = tokenisePath('M1e-5 2');
    expect(tokens).toEqual([{ command: 'M', args: [1e-5, 2] }]);
  });

  it('refuses a path with an unknown command instead of parsing half of it', () => {
    expect(supportedPathCommands('M0 0 L1 1')).toBe(true);
    expect(supportedPathCommands('M0 0 A1 1 0 0 1 2 2')).toBe(true);
    // `R` is not an SVG path command. A partial parse would drop every stroke after it.
    expect(supportedPathCommands('M0 0 R1 1')).toBe(false);
    expect(pathToSubpaths('M0 0 R1 1')).toBeNull();
  });

  it('treats a moveto with extra pairs as implicit linetos', () => {
    const subpaths = pathToSubpaths('M0 0 10 0 10 10');
    expect(subpaths).not.toBeNull();
    expect(subpaths?.[0]?.segments).toHaveLength(2);
    expect(subpaths?.[0]?.segments[1]).toEqual({ op: 'line', x: box(10), y: box(10) });
  });

  it('marks a subpath closed only when the path closes it', () => {
    expect(pathToSubpaths('M0 0 L10 0 L10 10 Z')?.[0]?.closed).toBe(true);
    expect(pathToSubpaths('M0 0 L10 0 L10 10')?.[0]?.closed).toBe(false);
  });

  it('promotes a quadratic to the cubic that is the same curve', () => {
    /*
      A quadratic from (0,0) with control (12,0) to (24,0) is a straight line: both cubic
      control points must sit on it at 1/3 and 2/3. This is the exact test that would have
      caught reading the start point after advancing `x`/`y`.
    */
    const [segment] = pathToSubpaths('M0 0 Q12 0 24 0')?.[0]?.segments ?? [];
    expect(segment?.op).toBe('cubic');
    if (segment?.op !== 'cubic') return;
    expect(segment.c1x).toBeCloseTo(box(8), 10);
    expect(segment.c1y).toBeCloseTo(0, 10);
    expect(segment.c2x).toBeCloseTo(box(16), 10);
  });

  it('reflects the previous control point for a smooth curve', () => {
    // `C` then `S`: the `S` first control is the reflection of the `C` second control.
    const segments = pathToSubpaths('M0 0 C0 12 12 12 12 0 S24 -12 24 0')?.[0]?.segments ?? [];
    expect(segments).toHaveLength(2);
    const second = segments[1];
    if (second?.op !== 'cubic') throw new Error('expected a cubic');
    // Reflected through the current point (12,0): (12,12) → (12,-12).
    expect(second.c1x).toBeCloseTo(box(12), 10);
    expect(second.c1y).toBeCloseTo(box(-12), 10);
  });
});

describe('circular arcs as cubics', () => {
  /*
    SVG draws an arc in the *endpoint* parameterisation: a radius, two flags and a destination.
    The centre is not given; it is the intersection of two circles of that radius, and which
    of the two intersections is meant is what `sweep` says. The flags are the whole difficulty:
    honouring only one of them still draws a smooth curve between the right endpoints, so it
    looks like a working icon with a corner bent the wrong way.
  */

  /** The centre the SVG spec defines, restated independently of the implementation. */
  const centreOf = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    radius: number,
    largeArc: boolean,
    sweep: boolean,
  ) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const r = distance > 2 * radius ? distance / 2 : radius;
    const h = Math.sqrt(Math.max(0, r * r - (distance / 2) ** 2));
    const sign = largeArc === sweep ? -1 : 1;
    return {
      x: (from.x + to.x) / 2 + (sign * h * -dy) / distance,
      y: (from.y + to.y) / 2 + (sign * h * dx) / distance,
      r,
    };
  };

  /**
   * Every sampled point on the produced cubic chain, in Lucide's 24-box units.
   *
   * `circularArcToCubics` works entirely in 24-box units — it is the one function here that
   * does, because arc geometry is meaningless in fractions — and `pathToSubpaths` normalises
   * its finished subpath. That split is deliberate, and this helper having to *not* rescale is
   * how the tests keep it honest.
   */
  const sample = (from: { x: number; y: number }, segments: NonNullable<ReturnType<typeof circularArcToCubics>>) => {
    const points: { x: number; y: number }[] = [];
    let { x, y } = from;
    for (const segment of segments) {
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8;
        const m = 1 - t;
        points.push({
          x: m * m * m * x + 3 * m * m * t * segment.c1x + 3 * m * t * t * segment.c2x + t * t * t * segment.x,
          y: m * m * m * y + 3 * m * m * t * segment.c1y + 3 * m * t * t * segment.c2y + t * t * t * segment.y,
        });
      }
      ({ x, y } = segment);
    }
    return points;
  };

  it('draws a semicircle exactly, through the side the sweep flag names', () => {
    /*
      From (0,0) to (20,0) with radius 10, the centre is (10,0). Sweeping positively in SVG's
      y-down space means the arc passes through (10,-10); negatively, through (10,+10). This is
      the test that tells you the sweep flag is actually being read.
    */
    const positive = circularArcToCubics({ x: 0, y: 0 }, { x: 20, y: 0 }, 10, true, true);
    const negative = circularArcToCubics({ x: 0, y: 0 }, { x: 20, y: 0 }, 10, true, false);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();

    for (const [segments, expectedY] of [
      [positive!, -10],
      [negative!, 10],
    ] as const) {
      const points = sample({ x: 0, y: 0 }, segments);
      const lowest = Math.min(...points.map((point) => point.y));
      const highest = Math.max(...points.map((point) => point.y));
      expect(expectedY < 0 ? lowest : highest).toBeCloseTo(expectedY, 2);
    }
  });

  it('keeps every sampled point on the circle, for all four flag combinations', () => {
    for (const largeArc of [false, true]) {
      for (const sweep of [false, true]) {
        const from = { x: 0, y: 0 };
        const to = { x: 10, y: 0 };
        const radius = 10;
        const segments = circularArcToCubics(from, to, radius, largeArc, sweep);
        expect(segments, `${largeArc}/${sweep}`).not.toBeNull();
        const centre = centreOf(from, to, radius, largeArc, sweep);
        for (const point of sample(from, segments!)) {
          const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
          // KAPPA is accurate to about 0.03% of the radius; at radius 10 that is 0.003 units,
          // far below a pixel at any size this project renders.
          expect(distance, `${largeArc}/${sweep}`).toBeCloseTo(centre.r, 2);
        }
      }
    }
  });

  it('lands exactly on the destination, so a closed path closes', () => {
    /*
      Trigonometry alone misses by ~1e-14, and that is not academic: `Z` closes a subpath by
      joining the last point to the first, so an icon whose outline ends where it started
      would not quite meet. The implementation substitutes the destination verbatim on the
      last step, and this asserts *exact* equality rather than closeness to keep that true.
    */
    const cases = [
      [{ x: 3, y: 4 }, { x: 17, y: 4 }, 12, false, true],
      [{ x: 0, y: 0 }, { x: 20, y: 0 }, 10, true, true],
      // Also a case where the endpoint is not on the axis grid, i.e. real trigonometry.
      [{ x: 3.9754115862043324, y: 20.900082298890347 }, { x: -14.712403408081157, y: 14.104774249070802 }, 19.884935020074465, true, true],
    ] as const;
    for (const [from, to, radius, largeArc, sweep] of cases) {
      const last = circularArcToCubics(from, to, radius, largeArc, sweep)?.at(-1);
      expect(last?.x, JSON.stringify(to)).toBe(to.x);
      expect(last?.y, JSON.stringify(to)).toBe(to.y);
    }
  });

  it('takes one cubic per quarter turn and more for a larger arc', () => {
    /*
      One cubic per quarter turn at most: a 60° arc is one, a semicircle is two, a
      three-quarter turn is three. Both the preview and the export get this count from the
      same call, which is what stops one drawing a corner as one segment and the other as two.

      The 60° case is deliberately not a 90° one: `ceil` on a computed angle that lands within
      a rounding error of exactly 90° goes either way, and a test pinned to that boundary
      would be testing float noise rather than the rule.
    */
    expect(circularArcToCubics({ x: 0, y: 0 }, { x: 10, y: 0 }, 10, false, true)).toHaveLength(1);
    expect(circularArcToCubics({ x: 0, y: 0 }, { x: 20, y: 0 }, 10, true, true)).toHaveLength(2);
    expect(circularArcToCubics({ x: 10, y: 0 }, { x: 0, y: 10 }, 10, true, true)).toHaveLength(3);
  });

  it('scales the radius up when the endpoints are further apart than the diameter', () => {
    /*
      The spec says to scale, not to fail: an arc asking for radius 10 between points 40 apart
      is a semicircle of radius 20. Without this the square root of a negative number produces
      `NaN` across the whole path.
    */
    const segments = circularArcToCubics({ x: 0, y: 0 }, { x: 40, y: 0 }, 10, false, true);
    expect(segments).not.toBeNull();
    const points = sample({ x: 0, y: 0 }, segments!);
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    // The scaled radius is 20 and the centre is (20,0).
    const onCircle = points.every((point) => Math.abs(Math.hypot(point.x - 20, point.y) - 20) < 0.01);
    expect(onCircle).toBe(true);
  });

  it('refuses a coincident-endpoint arc rather than drawing something arbitrary', () => {
    expect(circularArcToCubics({ x: 5, y: 5 }, { x: 5, y: 5 }, 4, false, true)).toBeNull();
    expect(circularArcToCubics({ x: 0, y: 0 }, { x: 4, y: 0 }, 0, false, true)).toBeNull();
  });

  it('draws a degenerate radius as the straight line the spec says it is', () => {
    const subpaths = pathToSubpaths('M4 4 A0 0 0 0 1 16 4');
    expect(subpaths?.[0]?.segments).toEqual([{ op: 'line', x: box(16), y: box(4) }]);
  });

  it('reports whether a path needs an ellipse, through the same rule the parser uses', () => {
    // The gate and the parser must agree by construction, or the picker offers a tile that
    // will not draw. Both compare `rx` to `ry` and nothing else.
    expect(arcsAreCircular('M0 0 A4 4 0 0 1 8 0')).toBe(true);
    expect(arcsAreCircular('M0 0 A4 4 135 0 1 8 0')).toBe(true);
    expect(arcsAreCircular('M0 0 A4.8 8 0 0 1 8 0')).toBe(false);
    expect(hasArcCommand('M0 0 A4 4 0 0 1 8 0')).toBe(true);
    expect(hasArcCommand('M0 0 L8 0')).toBe(false);
  });
});

describe('the primitive elements', () => {
  it('draws a circle as four cubics that meet where they started', () => {
    const result = iconGeometry({ name: 'circle', shapes: [{ t: 'circle', cx: 12, cy: 12, r: 10 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [subpath] = result.subpaths;
    expect(subpath?.segments).toHaveLength(4);
    // Starts at the left of the circle, ends there too, so there is nothing left to close.
    expect(subpath?.x).toBeCloseTo(box(2), 10);
    expect(subpath?.segments.at(-1)?.x).toBeCloseTo(box(2), 10);
  });

  it('clamps a rounded rectangle radius to half its shortest side', () => {
    // A radius bigger than the box would otherwise produce an arc that overshoots the corners.
    const result = iconGeometry({ name: 'r', shapes: [{ t: 'rect', x: 2, y: 2, w: 8, h: 4, rx: 100 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coordinates = allCoordinates(result.subpaths);
    expect(Math.min(...coordinates)).toBeCloseTo(box(2), 10);
    expect(Math.max(...coordinates)).toBeCloseTo(box(10), 10);
  });

  it('refuses an icon with no shapes, naming it', () => {
    const result = iconGeometry({ name: 'nothing', shapes: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
    expect(result.detail).toBe('nothing');
  });

  it('refuses rather than throws on a shape it cannot draw', () => {
    // The `IconShape` union has no such member; the cast is the point — stored item data is
    // free-form JSON, so this has to be a result and not an exception.
    const bogus = { t: 'text', value: 'x' } as unknown as IconShape;
    const result = iconGeometry({ name: 'bogus', shapes: [bogus] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-shape');
  });
});

describe('the bundled library (SPEC 11 §12)', () => {
  it('ships the full set offline, and only the icons that draw', () => {
    /*
      Measured against the generated asset: 1555 real icons, 205 aliases (which re-export
      another name and so carry no data of their own), 14 refused for an elliptical arc, and
      one barrel file. 1555 − 14 = 1541 drawable. If this number moves, either the asset was
      regenerated from a different Lucide version — fine, update it — or the converter
      regressed, which is the case this exists to catch.
    */
    expect(ICON_COUNT).toBe(1541);
    // Every drawable name must exist in the library: the picker reads one and the renderer
    // reads the other, and a name in the first but not the second is a dead tile.
    expect(ICON_NAMES.every((name) => ICON_LIBRARY[name] !== undefined)).toBe(true);
  });

  it('omits exactly the icons whose geometry this build refuses', () => {
    // `gift` is refused (an elliptical arc in its ribbon), so it must not be offered — while
    // still being present in the library data, so a file that already uses it reports a
    // reason rather than "unknown icon".
    expect(ICON_LIBRARY.gift).toBeDefined();
    expect(ICON_NAMES).not.toContain('gift');
    expect(ICON_NAMES).toContain('star');
  });

  it('converts every drawable icon to finite geometry in the renderers box', () => {
    /*
      The whole set, not a sample. This is the test that would have caught the unit bug
      across the library rather than on one icon, and it runs in about the time it takes to
      walk 1555 small arrays.
    */
    for (const name of ICON_NAMES) {
      const geometry = iconGeometry({ name, shapes: ICON_LIBRARY[name]! });
      expect(geometry.ok, name).toBe(true);
      if (!geometry.ok) continue;
      for (const subpath of geometry.subpaths) {
        for (const segment of subpath.segments) {
          const values =
            segment.op === 'cubic'
              ? [segment.c1x, segment.c1y, segment.c2x, segment.c2y, segment.x, segment.y]
              : [segment.x, segment.y];
          expect(values.every(Number.isFinite), `${name} segment`).toBe(true);
        }
      }
    }
  });

  it('resolves an item by name, by stored shapes, and reports the rest', () => {
    const byName = resolveIconItem({ iconName: 'star' }, ICON_LIBRARY);
    expect(byName.status).toBe('drawn');
    if (byName.status === 'drawn') {
      expect(byName.source).toBe('library');
      expect(byName.subpaths.length).toBeGreaterThan(0);
    }

    /*
      Stored shapes win over the name. A file that carries its geometry is stating what the
      icon was when it was drawn; a newer build may have redrawn that name, and the file's own
      copy is the more faithful answer. `x` here is a triangle, nothing like Lucide's `x`.
    */
    const byShapes = resolveIconItem(
      { iconName: 'x', iconShapes: [{ t: 'path', d: 'M0 0 L24 0 L12 24 Z' }] },
      ICON_LIBRARY,
    );
    expect(byShapes.status).toBe('drawn');
    if (byShapes.status === 'drawn') {
      expect(byShapes.source).toBe('shapes');
    }

    // A name this build has never heard of, and an item with neither.
    expect(resolveIconItem({ iconName: 'no-such-icon' }, ICON_LIBRARY)).toMatchObject({
      status: 'unknown',
      iconName: 'no-such-icon',
    });
    expect(resolveIconItem({}, ICON_LIBRARY).status).toBe('unknown');

    // A refused icon says why, and that is a different answer from "unknown".
    expect(resolveIconItem({ iconName: 'gift' }, ICON_LIBRARY)).toMatchObject({
      status: 'refused',
      reason: 'arc',
    });
    // Stored shapes that this build cannot convert are refused for the same reason.
    expect(
      resolveIconItem({ iconShapes: [{ t: 'path', d: 'M0 0 A4.8 8 0 0 1 8 0' }] }, ICON_LIBRARY),
    ).toMatchObject({ status: 'refused', reason: 'arc' });
  });

  it('keys an item by what it draws, so a cache cannot serve the wrong icon', () => {
    expect(iconAppearanceKey({ iconName: 'star' })).toBe('name:star');
    expect(iconAppearanceKey({ iconName: 'star', iconShapes: [] })).toBe('name:star');
    // Stored shapes change the picture even when the name does not.
    expect(
      iconAppearanceKey({ iconName: 'star', iconShapes: [{ t: 'path', d: 'M0 0 L1 1' }] }),
    ).toContain('shapes:');
  });

  it('searches by the name segments, ranking the exact name first', () => {
    // Lucide ships no tag data with the package this project installs, so the names are the
    // vocabulary: "arrow right" has to find `arrow-right` before `arrow-down-right`.
    expect(searchIconLibrary('arrow right')[0]).toBe('arrow-right');
    expect(searchIconLibrary('circle')).toContain('message-circle');
    expect(searchIconLibrary('  STAR  ')).toContain('star');
    // An empty query lists everything, so the picker's grid is full before the user types.
    expect(searchIconLibrary('').length).toBe(ICON_COUNT);
    expect(searchIconLibrary('zzzznotanicon')).toEqual([]);
  });

  it('drops a child it does not understand rather than failing the whole library', () => {
    /*
      A deliberate exception to this module's usual "refuse, never skip". The stored table
      ships with the build, so an unknown tag means a newer build read an older asset — one
      dropped child is a much better outcome than every icon in the picker failing.
    */
    const library = iconLibraryFromStored({
      mixed: [
        ['p', 'M0 0 L24 0'],
        ['z', 1, 2] as unknown as readonly ['p', string],
      ],
      empty: [],
    });
    expect(library.mixed).toHaveLength(1);
    expect(library.mixed?.[0]?.t).toBe('path');
    expect(library.empty).toEqual([]);
  });
});
