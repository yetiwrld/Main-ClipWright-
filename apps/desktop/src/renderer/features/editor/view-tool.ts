/**
 * The preview's view gestures: the hand tool, and whether the transform handles are shown
 * (SPEC 10 §3.1, §4, §8.2).
 *
 * These are view state, not document state: none of it reaches a project file, an undo
 * stack or an export. That is the same guarantee the overlays have, and it is why the
 * decisions live in a pure module that the pane can call rather than inside its handlers.
 *
 * ## The Space problem
 *
 * SPEC 10 §3.2 gives **Space** to Play/Pause and §4 gives **Space+drag** to panning the
 * view. Both are in the spec, on the same key, and a naive implementation of the second
 * breaks the first: a pan handler that claims Space on keydown stops the transport, and one
 * that claims the pointer drag unconditionally pans when the user meant to move a clip.
 *
 * The resolution used here is the one that keeps both promises, and it is a *deferred*
 * decision rather than an arbitration:
 *
 *   - Space **down** still toggles playback, exactly as it always has. Nothing about
 *     holding the key suppresses that.
 *   - If the pointer then goes down **while Space is held**, that drag pans the view and
 *     does not touch the clip under it. This is what makes Space+drag reachable at all: the
 *     user is holding a key, and a pointer press is unambiguous evidence of which gesture
 *     they meant.
 *   - Releasing Space does not re-toggle playback. Toggling on key-up would double-fire
 *     every ordinary press (once down, once up), which is the classic way this pair of
 *     bindings produces a play/pause flicker.
 *
 * So the key is never ambiguous per-event: playback is a keydown, panning is a pointer-down
 * that happens to occur while the key is held. The cost is that starting a Space+drag also
 * toggles playback once — which is honest and visible, and is what the spec's own pairing
 * implies. A user who wants a pure pan uses the Hand tool in the toolbar, where no key is
 * involved at all.
 */

/**
 * The preview's active tool (SPEC 10 §3.1's right-hand segmented control).
 *
 * `crop` matters beyond the cursor: it is what gives the four edge handles a *crop*
 * meaning. Under `select` those edges scale one axis each, as §8.2 requires, and cropping
 * moves to the Crop tool (§8.6) rather than competing for the same gesture.
 */
export type PreviewTool = 'select' | 'pan' | 'crop';

export interface HandDragInput {
  /** Whether the toolbar's Pan tool is active. */
  tool: PreviewTool;
  /** Whether the space bar is currently held down. */
  spaceHeld: boolean;
  /** Which pointer button started the gesture (`event.button`). */
  button: number;
}

/**
 * Whether a pointer press on the picture pans the view instead of editing the clip under it.
 *
 * A left press is required: a middle- or right-drag is not this gesture, and treating one as
 * a pan would swallow the context menu's press. A middle-drag is a common pan convention in
 * other editors, but it is not in this spec and inventing it would be a second undocumented
 * way to do the same thing.
 */
export function isHandDrag(input: HandDragInput): boolean {
  if (input.button !== 0) return false;
  return input.tool === 'pan' || input.spaceHeld;
}

/**
 * The cursor a view gesture earns.
 *
 * `grab` while the hand is armed and `grabbing` while a pan is in flight, which is the one
 * piece of feedback that tells a user *before* they press that a drag will move the view
 * rather than the clip — the alternative is a clip that jumps on a press the user thought
 * was a pan. `default` otherwise, so the pane never claims a cursor it will not honour.
 */
export function handCursor(armed: boolean, dragging: boolean): 'grab' | 'grabbing' | 'default' {
  if (!armed) return 'default';
  return dragging ? 'grabbing' : 'grab';
}

/**
 * Whether the transform handles are drawn (SPEC 10 §3.1's **Handles** toggle, `H`).
 *
 * Separate from "is something selected" on purpose, and both must be true. Hiding the
 * handles must not deselect the clip — the inspector and the layer stack still work, and a
 * user who hides the handles to judge a picture is still editing that picture — so this
 * answers only the *drawing* question and never touches the selection.
 *
 * The `H` key is not the same as §8.2's **Show anchor** (`A`): hiding the handles leaves the
 * pivot crosshair visible, because the crosshair is a readout as much as a grip.
 */
export function handlesVisible(handlesOn: boolean, hasSelection: boolean): boolean {
  return handlesOn && hasSelection;
}

/**
 * The pan a drag of the given screen-pixel delta produces.
 *
 * Screen pixels, not canvas pixels: the pan is applied *outside* the frame's scale, in the
 * same `translate(...) scale(...)` transform whose translate is in screen pixels, so the
 * frame follows the pointer exactly at any zoom. Dividing by the scale here would make the
 * view lag the hand at 400% — the classic "the thing slides slower than my finger".
 *
 * The result is *not* clamped here. `clampPan` needs the frame's scaled size, which this
 * module does not know, and clamping is the caller's job where that size is available.
 */
export function panBy(start: { x: number; y: number }, dx: number, dy: number) {
  const move = (value: number) => (Number.isFinite(value) ? value : 0);
  return { x: move(start.x + move(dx)), y: move(start.y + move(dy)) };
}
