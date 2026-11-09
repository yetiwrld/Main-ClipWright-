// @vitest-environment jsdom
/**
 * The pixel grid's drawing (SPEC 10 §9).
 *
 * jsdom implements no 2D canvas, so this file installs a recording stub for `getContext` and
 * asserts on the *calls* — which is the right level anyway: the question "did it draw a line
 * every 8 pixels across 400 pixels" is answerable from the fill rectangles without
 * rasterising anything, and rasterising in a test would be a picture nobody looks at.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PixelGrid } from '../features/editor/PixelGrid.js';

interface Recorded {
  fills: Array<{ x: number; y: number; w: number; h: number }>;
}

/** A 2D context that records `fillRect` and swallows everything else. */
function stubCanvas(recorded: Recorded) {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      recorded.fills.push({ x, y, w, h });
    }),
    set fillStyle(_value: string) {
      /* recorded nowhere: the colour is not the claim */
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  return ctx;
}

beforeEach(() => {
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderGrid = (props: Partial<React.ComponentProps<typeof PixelGrid>> = {}) =>
  render(
    <PixelGrid
      spacing={8}
      width={400}
      height={320}
      canvas={{ width: 50, height: 40 }}
      {...props}
    />,
  );

describe('the pixel grid', () => {
  it('draws one line per spacing across the frame', () => {
    /*
      400 px at 8 px spacing is 50 boundaries including the first at 0, so 51 verticals and
      41 horizontals. Derived rather than counted off a run: `floor(400/8) + 1`.
    */
    const recorded: Recorded = { fills: [] };
    stubCanvas(recorded);
    renderGrid();
    const verticals = recorded.fills.filter((fill) => fill.h === 320);
    const horizontals = recorded.fills.filter((fill) => fill.w === 400);
    expect(verticals).toHaveLength(Math.floor(400 / 8) + 1);
    expect(horizontals).toHaveLength(Math.floor(320 / 8) + 1);
  });

  it('draws the lines one screen pixel wide, whatever the zoom', () => {
    /*
      The whole reason the grid is drawn outside the scaled canvas. A line that inherited the
      zoom would be 8 px wide at 800%, which is a bar chart rather than a grid.
    */
    const recorded: Recorded = { fills: [] };
    stubCanvas(recorded);
    renderGrid({ spacing: 16 });
    expect(recorded.fills.every((fill) => fill.w === 1 || fill.h === 1)).toBe(true);
  });

  it('starts at the composition\'s own pixel 0', () => {
    /*
      This canvas is positioned over the frame, so `x = 0` here *is* the composition's column
      0 and the boundaries are simply multiples of the spacing. The frame's offset within the
      viewport must not enter into it — an earlier version folded that offset into a modulo,
      which put every line a few pixels off the composition's own pixel edges. The frame is
      centred by the panel on a fractional offset, so there was no alignment to gain and a
      great deal to lose.
    */
    const recorded: Recorded = { fills: [] };
    stubCanvas(recorded);
    renderGrid({ spacing: 8 });
    const verticals = recorded.fills.filter((fill) => fill.h === 320).map((fill) => fill.x);
    expect(verticals.slice(0, 3)).toEqual([0, 8, 16]);
  });

  it('rounds every line to a whole pixel', () => {
    // A line at 3.4 px is drawn as two half-lit columns and reads as a smudge. A fractional
    // spacing is what produces that, so the case is built with one.
    const recorded: Recorded = { fills: [] };
    stubCanvas(recorded);
    renderGrid({ spacing: 7.3 });
    for (const fill of recorded.fills) {
      expect(Number.isInteger(fill.x)).toBe(true);
      expect(Number.isInteger(fill.y)).toBe(true);
    }
  });

  it('sizes its backing store for the device ratio', () => {
    /*
      A canvas is drawn at its backing-store resolution and then scaled by CSS, so on a 2×
      display the backing store has to be twice the CSS size or every line is a half-pixel
      blur.
    */
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    stubCanvas({ fills: [] });
    renderGrid();
    const canvas = screen.getByTestId('pixel-grid') as HTMLCanvasElement;
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(640);
  });

  it('draws nothing for a spacing it cannot use', () => {
    /*
      The guard inside the component as well as the one in `pixelGridSpacing`: this component
      is given a number and must not draw at `NaN` or a negative, whatever its caller did.
    */
    for (const bad of [Number.NaN, 0, -8]) {
      const recorded: Recorded = { fills: [] };
      stubCanvas(recorded);
      const { unmount } = renderGrid({ spacing: bad });
      expect(recorded.fills).toHaveLength(0);
      unmount();
    }
  });

  it('takes no pointer events', () => {
    // It sits over the frame; a layer that swallowed a pointer would make the picture
    // undraggable at 800% — exactly when someone is trying to nudge a pixel.
    stubCanvas({ fills: [] });
    renderGrid();
    const canvas = screen.getByTestId('pixel-grid') as HTMLCanvasElement;
    expect(canvas.style.pointerEvents).toBe('none');
  });

  it('reports its spacing, so the drawing can be inspected', () => {
    stubCanvas({ fills: [] });
    renderGrid({ spacing: 12 });
    expect(screen.getByTestId('pixel-grid').getAttribute('data-spacing')).toBe('12');
  });
});
