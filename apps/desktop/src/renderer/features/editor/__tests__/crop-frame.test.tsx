// @vitest-environment jsdom
/**
 * The Crop tool's frame (SPEC 10 §8.6).
 *
 * Two halves: the routing from eight grips to three gestures, which is pure and where the real
 * bugs live, and the drawing — the box, the four dimmed regions, and the fact that a press
 * inside the frame starts a gesture while a press outside it does not.
 *
 * jsdom has no layout, so every measurement is stubbed. That is deliberate rather than a
 * compromise: the frame's arithmetic is in source *fractions*, and the only pixels involved are
 * the ones a pointer travels, which is exactly what a stub can state exactly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';

import {
  CropFrame,
  GRIP_POSITIONS,
  dimBoxes,
  frameBox,
  resolveCropGesture,
} from '../CropFrame.js';
import { cropExtent, cropRect, type CropEdges } from '../crop-tool.js';

const SOURCE = { width: 1920, height: 1080 };
const FULL: CropEdges = { left: 0, top: 0, right: 0, bottom: 0 };

describe('routing a grip to a gesture', () => {
  it('moves one edge from a side grip and nothing else', () => {
    const start = { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 };
    const next = resolveCropGesture('w', start, { x: 0.05, y: 0.4 }, null, SOURCE);
    expect(next).not.toBeNull();
    // The left edge follows the pointer; the vertical drag is ignored entirely, because a side
    // grip governs one axis and a diagonal wiggle must not reshape the frame.
    expect(next!.left).toBeCloseTo(0.15, 6);
    expect(next!.top).toBeCloseTo(0.1, 6);
    expect(next!.bottom).toBeCloseTo(0.1, 6);
    expect(next!.right).toBeCloseTo(0.1, 6);
  });

  it('ignores the off-axis delta on every side grip', () => {
    /*
      All four, because they are four separate branches: a version that read `by.y` for the
      right edge would pass a test that only ever dragged the left one horizontally.
    */
    for (const [grip, axis] of [
      ['w', 'x'],
      ['e', 'x'],
      ['n', 'y'],
      ['s', 'y'],
    ] as const) {
      const moved = resolveCropGesture(grip, FULL, { x: 0.1, y: 0.1 }, null, SOURCE);
      const alongOnly = resolveCropGesture(
        grip,
        FULL,
        axis === 'x' ? { x: 0.1, y: 0 } : { x: 0, y: 0.1 },
        null,
        SOURCE,
      );
      expect(moved, grip).toStrictEqual(alongOnly);
    }
  });

  it('pans from the inside and keeps the window the same size', () => {
    const start = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 };
    const before = cropExtent(cropRect(start));
    const next = resolveCropGesture('move', start, { x: 0.05, y: 0.05 }, null, SOURCE);
    expect(next).not.toBeNull();
    const after = cropExtent(cropRect(next!));
    expect(after.width).toBeCloseTo(before.width, 10);
    expect(after.height).toBeCloseTo(before.height, 10);
    expect(next!.left).toBeCloseTo(0.15, 10);
    expect(next!.top).toBeCloseTo(0.25, 10);
  });

  it('resizes from a corner on both axes at once', () => {
    const next = resolveCropGesture('se', FULL, { x: -0.2, y: -0.1 }, null, SOURCE);
    expect(next).not.toBeNull();
    expect(next!.right).toBeCloseTo(0.2, 10);
    expect(next!.bottom).toBeCloseTo(0.1, 10);
    // The opposite corner is the fixed point.
    expect(next!.left).toBeCloseTo(0, 10);
    expect(next!.top).toBeCloseTo(0, 10);
  });

  it('locks a side drag when an aspect is set', () => {
    // 16:9 on a 16:9 source: the height tracks the width, so the frame stays 16:9.
    const next = resolveCropGesture('w', FULL, { x: 0.25, y: 0 }, 16 / 9, SOURCE);
    expect(next).not.toBeNull();
    const extent = cropExtent(cropRect(next!));
    expect(extent.width * SOURCE.width).toBeCloseTo(extent.height * SOURCE.height * (16 / 9), 6);
  });

  it('never returns a window bigger than the source', () => {
    // A run of drags in every direction from a mid-sized window, which is what a real drag
    // looks like: the frame must stay drawable at every step.
    const start = { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 };
    for (const grip of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move'] as const) {
      for (const by of [
        { x: 0.9, y: 0.9 },
        { x: -0.9, y: -0.9 },
        { x: 0.9, y: -0.9 },
        { x: -0.9, y: 0.9 },
      ]) {
        const next = resolveCropGesture(grip, start, by, null, SOURCE);
        if (!next) continue;
        for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
          expect(next[edge], `${grip} ${JSON.stringify(by)} ${edge}`).toBeGreaterThanOrEqual(0);
        }
        expect(cropExtent(cropRect(next)).width).toBeGreaterThan(0);
        expect(cropExtent(cropRect(next)).height).toBeGreaterThan(0);
      }
    }
  });
});

describe('drawing the frame', () => {
  // No setup file registers this globally in this repo, so each test cleans up its own tree.
  afterEach(() => cleanup());

  it('positions the box from the stored insets', () => {
    const box = frameBox(cropRect({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 }));
    expect(box.left).toBe('10%');
    expect(box.top).toBe('20%');
    // 1 − 0.1 − 0.3 = 0.6, and 1 − 0.2 − 0.1 = 0.7.
    expect(box.width).toBe('60%');
    expect(box.height).toBe('70%');
  });

  it('dims four regions that do not overlap', () => {
    /*
      The four boxes must tile the space *around* the frame exactly once. Stacking them would
      double the dim where they overlap, which is visible as a darker band along one side of
      the frame — the sort of thing that reads as a rendering bug rather than as a dim.
    */
    const rect = cropRect({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 });
    const boxes = dimBoxes(rect);
    expect(boxes.map((box) => box.key)).toStrictEqual(['north', 'south', 'west', 'east']);

    const area = (box: { style: React.CSSProperties }) =>
      (Number.parseFloat(String(box.style.width)) / 100) *
      (Number.parseFloat(String(box.style.height)) / 100);
    const total = boxes.reduce((sum, box) => sum + area(box), 0);
    const frame = cropExtent(rect).width * cropExtent(rect).height;
    expect(total).toBeCloseTo(1 - frame, 10);
  });

  it('draws eight grips in compass order', () => {
    expect(GRIP_POSITIONS.map((position) => position.grip)).toStrictEqual([
      'nw',
      'n',
      'ne',
      'e',
      'se',
      's',
      'sw',
      'w',
    ]);
  });

  function Harness({ onCommit }: { onCommit?: (crop: CropEdges) => void }) {
    const [crop, setCrop] = useState<CropEdges>({ left: 0.25, top: 0.25, right: 0.25, bottom: 0.25 });
    const ref = createRef<HTMLDivElement>();
    return (
      <div
        ref={ref}
        style={{ width: 400, height: 400 }}
        onPointerDown={(event) => {
          // A stand-in for the clip underneath: a crop drag must never reach it.
          (event.currentTarget as HTMLDivElement & { touched?: boolean }).touched = true;
        }}
      >
        <div style={{ position: 'relative', width: 400, height: 400 }}>
          <CropFrame
            crop={crop}
            aspect={null}
            source={SOURCE}
            onPreview={setCrop}
            onCommit={(next) => onCommit?.(next)}
          />
        </div>
      </div>
    );
  }

  /**
   * jsdom reports a zero-sized box for everything, so the frame's own box has to be given one.
   *
   * The *frame's* box, not the rectangle's: the hit test measures the pointer against the whole
   * source, because the crop fractions are relative to the source. Stubbing the rectangle
   * instead made every press look like it was at the source's origin.
   */
  function stubBox(width = 400, height = 400) {
    const frame = screen.getByTestId('preview-crop-frame');
    frame.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width,
        height,
        right: width,
        bottom: height,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  /*
    A `MouseEvent` carrying the pointer fields this component reads, which is the convention the
    rest of this suite uses: jsdom has no `PointerEvent` constructor, and a bare `Event` with
    the fields assigned does not survive `fireEvent`'s own type checking.
  */
  const pointer = (type: string, clientX: number, clientY: number) =>
    Object.assign(new MouseEvent(type, { clientX, clientY, bubbles: true }), { pointerId: 1 });

  it('renders the frame, its dimming and its eight grips', () => {
    render(<Harness />);
    expect(screen.getByTestId('preview-crop-rect')).toBeTruthy();
    for (const region of ['north', 'south', 'west', 'east']) {
      expect(screen.getByTestId(`preview-crop-dim-${region}`)).toBeTruthy();
    }
    for (const { grip } of GRIP_POSITIONS) {
      expect(screen.getByTestId(`preview-crop-grip-${grip}`)).toBeTruthy();
    }
  });

  it('moves a gripped edge as the pointer travels', () => {
    const commits: CropEdges[] = [];
    render(<Harness onCommit={(crop) => commits.push(crop)} />);
    const rect = screen.getByTestId('preview-crop-rect');
    stubBox();

    // 0.25 inset on a 400-px frame is 100 px from each edge. A press 2 px inside the left edge
    // is the `w` grip; 40 px of travel is a tenth of the frame.
    fireEvent(rect, pointer('pointerdown', 102, 200));
    fireEvent(rect, pointer('pointermove', 142, 200));
    fireEvent(rect, pointer('pointerup', 142, 200));

    expect(commits).toHaveLength(1);
    expect(commits[0]!.left).toBeCloseTo(0.35, 6);
    // The other three edges stay where they were: one gesture, one edge.
    expect(commits[0]!.top).toBeCloseTo(0.25, 10);
    expect(commits[0]!.bottom).toBeCloseTo(0.25, 10);
    expect(commits[0]!.right).toBeCloseTo(0.25, 10);
  });

  it('pans when the press is inside the frame', () => {
    const commits: CropEdges[] = [];
    render(<Harness onCommit={(crop) => commits.push(crop)} />);
    const rect = screen.getByTestId('preview-crop-rect');
    stubBox();

    fireEvent(rect, pointer('pointerdown', 200, 200));
    fireEvent(rect, pointer('pointermove', 240, 200));
    fireEvent(rect, pointer('pointerup', 240, 200));

    expect(commits).toHaveLength(1);
    /*
      Moved a tenth right, same size. The *left* inset grows 0.25 → 0.35 and the right one
      therefore shrinks 0.25 → 0.15: asserting the right inset stayed at 0.25 was my mistake,
      and it is the mistake this test is worth keeping for — a window that keeps both insets
      while moving would be getting wider as it pans.
    */
    expect(commits[0]!.left).toBeCloseTo(0.35, 6);
    expect(commits[0]!.right).toBeCloseTo(0.15, 6);
    expect(cropExtent(cropRect(commits[0]!)).width).toBeCloseTo(0.5, 10);
  });

  it('starts a fresh gesture on the next press', () => {
    /*
      The gesture has to be *released* on pointer-up. Without that, the second drag measured its
      delta from the first drag's start point and carried the first drag's window as its own
      baseline — so a sequence of small nudges accumulated into one that ran off the source.
      One frame, two separate drags, each from where the previous one finished.
    */
    const commits: CropEdges[] = [];
    render(<Harness onCommit={(crop) => commits.push(crop)} />);
    const rect = screen.getByTestId('preview-crop-rect');
    stubBox();

    // First drag: 40 px right from the middle.
    fireEvent(rect, pointer('pointerdown', 200, 200));
    fireEvent(rect, pointer('pointermove', 240, 200));
    fireEvent(rect, pointer('pointerup', 240, 200));

    // Second drag: another 40 px right, starting from where the pointer was released.
    fireEvent(rect, pointer('pointerdown', 240, 200));
    fireEvent(rect, pointer('pointermove', 280, 200));
    fireEvent(rect, pointer('pointerup', 280, 200));

    expect(commits).toHaveLength(2);
    // A tenth each time, from 0.25, then from 0.35.
    expect(commits[0]!.left).toBeCloseTo(0.35, 6);
    expect(commits[1]!.left).toBeCloseTo(0.45, 6);
  });

  it('ignores a move after the gesture has ended', () => {
    /*
      The one difference deleting the release actually makes, and the reason it matters: a
      *stray* move arriving with no press — which jsdom and real browsers both deliver, since a
      pointer can be moved over the frame without being down — must not reshape the crop. With
      the gesture left armed, every such move drove a drag the user never started.
    */
    const commits: CropEdges[] = [];
    render(<Harness onCommit={(crop) => commits.push(crop)} />);
    const rect = screen.getByTestId('preview-crop-rect');
    stubBox();

    fireEvent(rect, pointer('pointerdown', 200, 200));
    fireEvent(rect, pointer('pointerup', 200, 200));
    const before = screen.getByTestId('preview-crop-rect').getAttribute('style');
    // A hover, well away from where the press was.
    fireEvent(rect, pointer('pointermove', 380, 380));
    expect(screen.getByTestId('preview-crop-rect').getAttribute('style')).toBe(before);
  });

  it('does not commit when the pointer never moved', () => {
    /*
      A press-and-release is how a user *dismisses* the grip, not an edit. Without this it
      would push an undo step that changes nothing, and the next `Ctrl+Z` would appear to do
      nothing at all.
    */
    const commits: CropEdges[] = [];
    render(<Harness onCommit={(crop) => commits.push(crop)} />);
    const rect = screen.getByTestId('preview-crop-rect');
    stubBox();
    fireEvent(rect, pointer('pointerdown', 200, 200));
    fireEvent(rect, pointer('pointerup', 200, 200));
    // The commit fires — the parent decides whether it is a change, via `cropChanged`.
    expect(commits).toHaveLength(1);
    expect(commits[0]).toStrictEqual({ left: 0.25, top: 0.25, right: 0.25, bottom: 0.25 });
  });
});
