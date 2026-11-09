/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { handCursor, handlesVisible, isHandDrag, panBy } from '../view-tool.js';

describe('when a pointer press pans the view', () => {
  it('pans with the Pan tool, without any key held', () => {
    expect(isHandDrag({ tool: 'pan', spaceHeld: false, button: 0 })).toBe(true);
  });

  it('pans with Space held on the Select tool, which is the spec\'s Space+drag', () => {
    expect(isHandDrag({ tool: 'select', spaceHeld: true, button: 0 })).toBe(true);
  });

  it('does not pan on an ordinary press, so a clip can still be dragged', () => {
    /*
      The whole point of the pair above. If this were true, holding nothing and pressing on
      a clip would pan the view and the canvas would stop being editable — which is the
      failure a naive "pan whenever the view is zoomed" rule produces.
    */
    expect(isHandDrag({ tool: 'select', spaceHeld: false, button: 0 })).toBe(false);
  });

  it('ignores every button but the left one', () => {
    /*
      A middle- or right-drag is not this gesture. Claiming the right button would swallow
      the context menu's press, and inventing a middle-drag pan is a second undocumented
      way to do one thing.
    */
    for (const button of [1, 2, 3]) {
      expect(isHandDrag({ tool: 'pan', spaceHeld: false, button })).toBe(false);
      expect(isHandDrag({ tool: 'select', spaceHeld: true, button })).toBe(false);
    }
  });

  it('pans with either arming condition, not only both at once', () => {
    // Space *or* the tool. Requiring both would make each one alone useless.
    const toolOnly = isHandDrag({ tool: 'pan', spaceHeld: false, button: 0 });
    const spaceOnly = isHandDrag({ tool: 'select', spaceHeld: true, button: 0 });
    expect(toolOnly && spaceOnly).toBe(true);
  });
});

describe('the hand cursor', () => {
  it('shows grab when armed and grabbing while dragging', () => {
    expect(handCursor(true, false)).toBe('grab');
    expect(handCursor(true, true)).toBe('grabbing');
  });

  it('claims nothing when the hand is not armed', () => {
    // A cursor promising a pan that will not happen is worse than the default one: the
    // clip moves instead, on a press the user read as a pan.
    expect(handCursor(false, false)).toBe('default');
    expect(handCursor(false, true)).toBe('default');
  });
});

describe('whether the transform handles are drawn', () => {
  it('draws only with the toggle on and a clip selected', () => {
    expect(handlesVisible(true, true)).toBe(true);
  });

  it('hides when the toggle is off, even with a selection', () => {
    // Hiding the handles must not deselect — the inspector keeps working — so the only
    // thing the toggle may change is whether they are drawn.
    expect(handlesVisible(false, true)).toBe(false);
  });

  it('draws nothing without a selection, however the toggle is set', () => {
    expect(handlesVisible(true, false)).toBe(false);
    expect(handlesVisible(false, false)).toBe(false);
  });
});

describe('panning by a pointer delta', () => {
  it('adds the delta in screen pixels, undivided', () => {
    /*
      The transform is `translate(pan) scale(zoom)` with the translate outside the scale,
      so the pan is already in screen pixels. Dividing by the zoom here would make the
      frame lag the hand at 400% — it would move a quarter of the pointer's travel.
    */
    expect(panBy({ x: 10, y: -4 }, 5, 3)).toStrictEqual({ x: 15, y: -1 });
  });

  it('accumulates from where the drag started rather than from the last frame', () => {
    // Callers pass the pan captured at pointer-down; feeding the *current* pan back in would
    // compound the delta and send the frame flying.
    const start = { x: 0, y: 0 };
    expect(panBy(start, 5, 0)).toStrictEqual({ x: 5, y: 0 });
    expect(panBy(start, 5, 0)).toStrictEqual({ x: 5, y: 0 });
  });

  it('refuses a non-finite delta rather than producing NaN', () => {
    // NaN propagates into the transform and the frame disappears with no error anywhere.
    expect(panBy({ x: 1, y: 2 }, Number.NaN, 3)).toStrictEqual({ x: 1, y: 5 });
    expect(panBy({ x: 1, y: 2 }, 3, Number.POSITIVE_INFINITY)).toStrictEqual({ x: 4, y: 2 });
  });
});
