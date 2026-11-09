import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Grid3x3,
  Lock,
  LockOpen,
  Minus,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { IconButton, Menu, type MenuItem } from '@clipwright/design-system';
import {
  formatTimecode,
  projectDurationUs,
  quantizeUs,
  clearGuides as clearGuidesCommand,
  removeGuide as removeGuideCommand,
  setGuides as setGuidesCommand,
  setGuidesLocked as setGuidesLockedCommand,
  type TimelineState,
} from '@clipwright/timeline-engine';
import type { CaptionStyle } from '@clipwright/caption-styles';
import { gainAt } from '@clipwright/audio-core';
import {
  activeAdjustmentLayers,
  activeEffects,
  effectsForLayer,
  itemGeometry,
  transitionAt,
  visibleLayers,
  type ActiveEffect,
  type ItemGeometry,
  type VisibleLayer,
  type WipeShape,
  type DissolveShape,
} from '@clipwright/compositor';
import { playheadStore, usePlayheadUs } from './playhead-store.js';
import { createSeekCoalescer, shouldSeek } from './seek-coalescer.js';
import { PreviewOverlays } from './PreviewOverlays.js';
import { SnapGuides } from './SnapGuides.js';
import { SpacingHints } from './SpacingHints.js';
import { UserGuides } from './UserGuides.js';
import { GridDialog } from './GridDialog.js';
import { addGuide, edgeAt, guideSnapTargets, guideToRemove, axisForEdge } from './user-guides.js';
import { GRID_THIRDS, effectiveGrid, gridLabel, gridLines, type GridChoice } from './grid.js';
import { itemBounds, targetsForLines, targetsForOverlayRect, type ItemBounds } from './snapping.js';
import {
  OVERLAYS_OFF,
  nextAreaOverlay,
  overlaysVisible,
  parseSafeAreas,
  platformKeyFor,
  safeAreaRect,
  type OverlayState,
} from './safe-areas.js';
import safeAreasData from '../../../../../../assets/safe-areas.json';
import { CaptionOverlay } from './CaptionOverlay.js';
import { HANDLE_SIZE, croppedEdge, handleAt, movedOffset, pixelsToFraction, type CropEdge } from './canvas-drag.js';
import type { TimelineApi } from './use-timeline.js';
import { useCanvasDrag } from './use-canvas-drag.js';
import { commitKeyed } from './keyframe-controls.js';

const MEDIA_ORIGIN = 'clipwright-media://media/';

/**
 * The guide geometry, parsed once at module load rather than per render.
 *
 * Parsing here also *validates*: the shipped file is checked every time this module
 * loads — in the app, in the tests and in `check-repo` — so a malformed value is a build
 * failure rather than an overlay drawn off-screen.
 */
const SAFE_AREAS = parseSafeAreas(safeAreasData);

/**
 * The timeline's blend mode name → the CSS keyword that means the same thing.
 *
 * Only `add` differs: the schema calls additive blending `add` (the name ffmpeg's
 * `addition` mode is reported under in our own export), while CSS calls it
 * `plus-lighter`. Passing `add` through unchanged is invalid CSS, so the browser
 * silently drops the declaration and the layer paints as if it were `normal` —
 * a bug that looks like blending being ignored. The rest happen to agree.
 */
/**
 * The effect chain as a CSS `filter` string, for the effects CSS can reproduce.
 *
 * CSS filters operate in sRGB on the *encoded* values, while the export linearises
 * first, so these are approximations rather than the same maths — the preview's job
 * is to show the shape of a grade while the export produces the real one. The
 * functions below were chosen so that the two agree closely for the usual settings:
 * `brightness()` and `saturate()` are close cousins of their linear counterparts,
 * whereas `contrast()` pivots on 0.5 rather than on 0.18 linear and is a visibly
 * different curve at large amounts.
 *
 * Five of the nine required effects have no CSS equivalent at all — blur, sharpen,
 * vignette and the two channel-mix ones need either a neighbourhood or per-channel
 * control that `filter` does not expose. Those are reported by
 * `unsupportedEffectNames` so the preview can say so instead of quietly showing an
 * ungraded picture.
 */
export function cssFiltersFor(effects: readonly ActiveEffect[]): string {
  const filters: string[] = [];
  for (const effect of effects) {
    const p = effect.params;
    switch (effect.effectId) {
      case 'brightness': {
        // CSS brightness() is a multiply, which is unlimited upward and zero at 0.
        // Mapping the −1…1 amount onto 0…2 keeps 0 as "unchanged" and makes the
        // direction right; the highlight roll-off the export uses is not expressible.
        const amount = p.amount ?? 0;
        filters.push(`brightness(${(1 + Math.max(-0.9, amount)).toFixed(4)})`);
        break;
      }
      case 'exposure': {
        filters.push(`brightness(${Math.pow(2, p.stops ?? 0).toFixed(4)})`);
        break;
      }
      case 'contrast': {
        filters.push(`contrast(${Math.pow(2, p.amount ?? 0).toFixed(4)})`);
        break;
      }
      case 'saturation': {
        filters.push(`saturate(${(p.amount ?? 1).toFixed(4)})`);
        break;
      }
      case 'temperature': {
        // Warm = more red, less blue. `sepia` is the only CSS function that shifts
        // the colour balance, and blending a little in is a fair stand-in for a
        // small shift; a large one diverges from the export, so the amount is
        // capped where the two still resemble each other.
        const shift = (p.amount ?? 0) / 100;
        if (shift > 0) filters.push(`sepia(${Math.min(0.35, shift * 0.35).toFixed(4)})`);
        else if (shift < 0) filters.push(`hue-rotate(${(Math.abs(shift) * 20).toFixed(2)}deg)`);
        break;
      }
      case 'blur': {
        // The export scales the radius by the frame's short side over 1080; the
        // preview draws at the canvas's own CSS size, and a 1:1 pixel radius is the
        // right unit there because the element is already sized in frame units.
        const radius = p.radius ?? 0;
        if (radius > 0) filters.push(`blur(${radius.toFixed(2)}px)`);
        break;
      }
      case 'tint':
      case 'sharpen':
      case 'vignette':
        // No CSS equivalent. Reported separately.
        break;
      default:
        break;
    }
  }
  return filters.join(' ');
}

/** Effects in a chain the preview cannot approximate, by their catalogue names. */
/**
 * The `clip-path` for a wipe, mirroring the export's per-pixel mask (SPEC 12 §4.2).
 *
 * The export computes an alpha per pixel from the projection of the pixel onto the
 * wipe's normal; CSS has no such primitive, so the four axis-aligned directions and
 * the diagonals are expressed as polygons. A soft edge needs a gradient mask rather
 * than a clip, so `softness` is deliberately ignored here and the preview shows a
 * hard edge — the same kind of approximation the effect filters already make, and
 * flagged in `docs/limitations.md` rather than silently wrong.
 *
 * `position` is how far the revealed region reaches, so the polygon keeps the
 * region *behind* the normal: for `left` (normal +x) that is the left-hand side.
 */
export function wipeClipPath(shape: WipeShape): string {
  const p = Math.min(1, Math.max(0, shape.position));
  // Percentage along each axis where the edge lies.
  const along = (axis: number) => (axis >= 0 ? p : 1 - p) * 100;
  if (shape.axisY === 0) {
    const edge = along(shape.axisX);
    return shape.axisX > 0
      ? `inset(0 ${100 - edge}% 0 0)`
      : `inset(0 0 0 ${edge}%)`;
  }
  if (shape.axisX === 0) {
    const edge = along(shape.axisY);
    return shape.axisY > 0
      ? `inset(0 0 ${100 - edge}% 0)`
      : `inset(${edge}% 0 0 0)`;
  }
  // Diagonal: reveal the triangular half the normal points away from.
  const x = shape.axisX > 0 ? 0 : 100;
  const y = shape.axisY > 0 ? 0 : 100;
  const fx = shape.axisX > 0 ? p * 100 : 100 - p * 100;
  const fy = shape.axisY > 0 ? p * 100 : 100 - p * 100;
  return `polygon(${x}% ${y}%, ${fx}% ${y}%, ${x}% ${fy}%)`;
}

/**
 * The CSS approximation of a dissolve on screen (SPEC 12 §4.2).
 *
 * The export thresholds a real value-noise field per pixel, which CSS cannot
 * express: `mask-image` can take a gradient or an image URL, not a procedural
 * field. What is achievable is a *pattern* mask at the dissolve's grain scale whose
 * coverage rises with progress, so the preview shows the incoming clip arriving in
 * patches rather than as an even fade. It is an approximation and is documented as
 * one — the file is authoritative.
 *
 * The two-stop gradient is what makes it a threshold rather than a blend: the hard
 * stop at `progress` puts each patch entirely on one side.
 */
export function dissolveMaskStyle(shape: DissolveShape): React.CSSProperties {
  // `Math.min`/`Math.max` pass NaN straight through, and a NaN in a mask stop makes
  // the browser drop the whole mask — which shows the incoming clip in full from the
  // first frame. Check for it rather than trusting the clamp.
  const raw = Number.isFinite(shape.progress) ? shape.progress : 0;
  const p = Math.min(1, Math.max(0, raw));
  const grain = Number.isFinite(shape.grain) ? shape.grain : 0.1;
  // Grain is a fraction of the frame; sizing the repeating cell in the same units
  // keeps the patches looking alike at any window size.
  const cellPct = Math.max(0.5, grain * 100);
  return {
    // A mask only reads alpha, so the colour is irrelevant — but it still has to
    // be a token rather than a literal (`01` §12.2), and `currentColor` is the one
    // that expresses "any opaque colour" without inventing a palette entry.
    WebkitMaskImage: `repeating-conic-gradient(from 45deg, currentColor ${p * 100}%, transparent 0)`,
    maskImage: `repeating-conic-gradient(from 45deg, currentColor ${p * 100}%, transparent 0)`,
    // Size the repeating cell so the patches read at the dissolve's grain.
    WebkitMaskSize: `${cellPct}% ${cellPct}%`,
    maskSize: `${cellPct}% ${cellPct}%`,
  };
}

export function unsupportedEffectNames(effects: readonly ActiveEffect[]): string[] {
  const names: string[] = [];
  for (const effect of effects) {
    // `tint` needs per-channel gains CSS does not expose; `sharpen` needs a
    // high-pass; `vignette` needs a radial mask, which is a `radial-gradient`
    // overlay rather than a filter and is not attempted here.
    if (effect.effectId === 'tint') names.push('Tint');
    if (effect.effectId === 'sharpen') names.push('Sharpen');
    if (effect.effectId === 'vignette') names.push('Vignette');
    if (effect.effectId === 'temperature' && Math.abs(effect.params.amount ?? 0) > 35) {
      names.push('Temperature (only approximated)');
    }
  }
  return names;
}

const CSS_BLEND_MODE: Record<string, React.CSSProperties['mixBlendMode']> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  add: 'plus-lighter',
  'soft-light': 'soft-light',
};

/**
 * Preview canvas (SPEC 10 first slice): shows the frame under the playhead from
 * the main-track item, scaled into the project canvas. Playback advances the
 * playhead from a real clock and lets the video element follow it.
 */
export function PreviewPane({
  state,
  fps,
  captionStyles = {},
  timeline,
}: {
  state: TimelineState;
  fps: 30 | 60;
  /** Project-local caption styles, so the preview shows what the export will. */
  captionStyles?: Readonly<Record<string, CaptionStyle>>;
  /**
   * Enables on-canvas editing (SPEC 12 Phase 4). Optional because the preview is
   * also rendered without an editor around it, and a picture with no commands to
   * call is still a valid preview — the handles simply do not appear.
   */
  timeline?: TimelineApi;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * The canvas rectangle, measured on drag start rather than tracked continuously.
   *
   * Measuring per frame would mean a `getBoundingClientRect` on every pointer move,
   * and more importantly the canvas does not resize *during* a drag: capturing it
   * once is both cheaper and steadier, since a mid-drag layout shift would otherwise
   * change the pixels-to-fraction ratio under the user's hand.
   */
  const canvasRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  /**
   * The Guides menu's anchor, in viewport coordinates, or `null` while closed.
   *
   * `Menu` is fixed-positioned when given `x`/`y`, so anchoring it to the button's own
   * rectangle is what makes it open *under* the button at whatever width the strip is.
   */
  const [guideMenuAt, setGuideMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const durationUs = projectDurationUs(state);

  const canvas = state.canvas ?? { width: 1080, height: 1920, aspect: '9:16' };

  /*
    Overlays are view state, not document state (SPEC 10 §9): they are never written to
    the project, never keyframeable, and never part of an export. Holding them in a
    `useState` here rather than in the timeline is the whole of that guarantee at this
    layer — nothing below the preview can see them.
  */
  /*
    §8.2's *Show anchor*, `A` — on by default.

    The spec says the crosshair appears "only with Show anchor", which reads as off until
    asked for; it is on instead because the pivot is the answer to "why did it move like
    that", and a user who never learns the key never sees it. The toggle exists so it can
    be put away, which is what the spec's word "only" is really protecting: a crosshair
    on screen when the user wants none. Like the overlays this is view state, not
    document state.

    Deliberately *not* part of `OverlayState`: that object is the compliance overlay set
    with one cycling key, and folding a boolean into it would put a transform handle in
    the same bucket as a safe-area guide. It is also not the same as §8's `H` *Handles*
    toggle — hiding the handles leaves the pivot visible, because the crosshair is a
    readout as much as a grip.
  */
  /*
    A `Ctrl`-drag from the viewport edge creates a user guide (SPEC 10 §8.8).

    Held as a ref rather than state: this is a gesture in progress, and re-rendering on
    every pointer move to update a value nothing draws yet would be re-rendering the whole
    preview sixty times a second for a line that appears on release.

    The guide is created on *release*, not on pointer-down, because a drag that never went
    anywhere is a mis-click and should not leave a line behind — the same rule a
    click-not-a-drag follows everywhere else in this preview.
  */
  const guideDrag = useRef<{ axis: 'x' | 'y'; at: number; removing: boolean } | null>(null);
  const [showAnchor, setShowAnchor] = useState(true);
  const [overlays, setOverlays] = useState<OverlayState>(OVERLAYS_OFF);
  /**
   * The grid the user has chosen — the thirds until they say otherwise.
   *
   * Separate from `overlays` because it is a *setting*, not a visibility: `Ctrl+'` turns
   * the grid off and on again, and the choice has to survive that, or setting 5×4 and
   * toggling twice would silently put the thirds back. It is view state and is not saved
   * with the project, like every other overlay.
   */
  const [grid, setGrid] = useState<GridChoice>(GRID_THIRDS);
  const [gridDialogOpen, setGridDialogOpen] = useState(false);
  const platformKey = platformKeyFor(canvas.aspect ?? '');
  const platformZone = platformKey ? (SAFE_AREAS.platforms[platformKey] ?? null) : null;

  /*
    `Ctrl+;` cycles the area overlay and `Ctrl+'` toggles the thirds, per SPEC 10 §9's
    single binding for the set. Bound at the document while the preview is mounted: the
    preview is the only place an overlay means anything, so it does not need a global
    command, and a dialog that wants `Ctrl+;` gets it.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key !== ';' && event.key !== "'") return;
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke from a text field — `;` is an ordinary character there.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      event.preventDefault();
      setOverlays((current) =>
        event.key === ';'
          ? { ...current, areas: nextAreaOverlay(current.areas, platformZone !== null) }
          : /*
              A toggle that *remembers*: turning the grid off sets it to `null`, turning it
              back on restores `grid` — so a user who set 5×4 and pressed `Ctrl+'` twice
              gets their 5×4 back rather than being quietly reset to the thirds.
            */
            { ...current, thirds: current.thirds ? null : grid },
      );
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [platformZone, grid]);
  /*
    `A` toggles the crosshair (SPEC 10 §8.2). Bare, not `Ctrl`-modified, so it needs its
    own listener — the effect above returns early on anything without a modifier.

    Guarded against text fields for the same reason: `a` is a letter before it is a
    command, and guarding on the *modifier* alone would not catch this one.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'a' || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      event.preventDefault();
      setShowAnchor((value) => !value);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Subscribing to the playhead is what makes a keyframed property redraw as time
  // moves; reading `playheadStore.get()` without subscribing would animate only
  // when something else happened to re-render.
  const playheadUs = usePlayheadUs();

  /*
    On-canvas editing (SPEC 12 Phase 4): the selected clip gets an outline and can be
    dragged to move it, or dragged by an edge to crop it. The commit runs once, on
    release, so the whole gesture is one undo step.
  */
  const drag = useCanvasDrag(
    useCallback(
      (change) => {
        if (!timeline) return;
        const item = state.items[change.itemId];
        if (!item) return;
        /*
          A finished drag follows the *same* §2.4 rule as the sidebar, through the same
          function: moving a clip whose position is already animated writes a key at the
          playhead instead of editing the static value. Routing both surfaces through
          `commitKeyed` is what keeps a frame made by dragging identical to one made by
          typing, and it is why this callback passes a list — a move touches two axes.
        */
        const writer = {
          playheadUs: quantizeUs(playheadStore.get(), fps),
          addKeyframe: (id: string, path: string, at: number, value: number) =>
            timeline.addKeyframe(id, path, at, value),
          updateKeyframe: (id: string, path: string, at: number, patch: { value: number }) =>
            timeline.updateKeyframe(id, path, at, patch),
        };
        if (change.crop) {
          const path = `crop.${change.crop.edge}`;
          commitKeyed(
            writer,
            item,
            [{ path, value: change.crop.value }],
            () => timeline.setItemProperties([change.itemId], { crop: { [change.crop!.edge]: change.crop!.value } }),
          );
          return;
        }
        if (!change.transform) return;
        const edit = change.transform;
        if (edit.rotation !== undefined) {
          commitKeyed(writer, item, [{ path: 'transform.rotation', value: edit.rotation }], () =>
            timeline.setItemProperties([change.itemId], { transform: { rotation: edit.rotation } }),
          );
          return;
        }
        if (edit.anchorX !== undefined || edit.anchorY !== undefined) {
          /*
            Both anchor axes are written together, for the same reason the uniform
            scale field writes both: they are one point, and a half-written pivot is a
            pivot the user never placed.
          */
          const anchorX = edit.anchorX ?? item.transform.anchorX;
          const anchorY = edit.anchorY ?? item.transform.anchorY;
          commitKeyed(
            writer,
            item,
            [
              { path: 'transform.anchorX', value: anchorX },
              { path: 'transform.anchorY', value: anchorY },
            ],
            () => timeline.setItemProperties([change.itemId], { transform: { anchorX, anchorY } }),
          );
          return;
        }
        if (edit.scaleX !== undefined && edit.scaleY !== undefined) {
          /*
            A corner drag writes the scale *and* the compensating position as one edit.
            The position cannot be dropped: scaling happens about the anchor, so without
            the move the corner the user held still would slide out from under the
            pointer. And the axes are always equal, because this is a uniform handle —
            the inspector's per-axis fields are how a non-uniform clip is made.
          */
          const x = edit.x ?? item.transform.x ?? 0;
          const y = edit.y ?? item.transform.y ?? 0;
          commitKeyed(
            writer,
            item,
            [
              { path: 'transform.scaleX', value: edit.scaleX },
              { path: 'transform.scaleY', value: edit.scaleY },
              { path: 'transform.x', value: x },
              { path: 'transform.y', value: y },
            ],
            () =>
              timeline.setItemProperties([change.itemId], {
                transform: { scaleX: edit.scaleX, scaleY: edit.scaleY, x, y, scale: 1 },
              }),
          );
          return;
        }
        if (edit.x === undefined || edit.y === undefined) return;
        commitKeyed(
          writer,
          item,
          [
            { path: 'transform.x', value: edit.x },
            { path: 'transform.y', value: edit.y },
          ],
          () => timeline.setItemProperties([change.itemId], { transform: { x: edit.x, y: edit.y } }),
        );
      },
      // `state` is read for the item's stored values; changing it re-creates the
      // callback, which is what makes the next gesture see the latest document.
      [timeline, state, fps],
    ),
  );
  const selectedId = timeline?.selection.length === 1 ? timeline.selection[0] : undefined;

  /*
    `Esc` abandons an in-flight drag (SPEC 10 §8.3). Bound at the document rather than
    the canvas because the pointer may have been captured by the layer and focus can be
    anywhere; the handler is only active while a gesture is running, so it does not
    swallow `Esc` from dialogs or the command palette.
  */
  useEffect(() => {
    if (!drag.dragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      drag.cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drag.dragging, drag.cancel]);



  // Playback clock (SPEC 09 §23): advance on animation frames, stop at the end.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const deltaUs = (now - last) * 1000;
      last = now;
      const next = playheadStore.get() + deltaUs;
      if (next >= durationUs) {
        playheadStore.set(durationUs);
        setPlaying(false);
        return;
      }
      playheadStore.set(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationUs, playing]);

  useEffect(() => {
    const toggle = () => setPlaying((value) => !value);
    window.addEventListener('clipwright:toggle-play', toggle);
    return () => window.removeEventListener('clipwright:toggle-play', toggle);
  }, []);



  /**
   * Every picture layer at the playhead, bottom first (SPEC 10 §2/§6) including
   * the two sides of a running transition (SPEC 12 §4).
   *
   * The preview used to draw exactly one item — the one that started last — so an
   * overlay clip was invisible and the main video showed through it. Layering is
   * resolved by the same `visibleLayers` the export uses, which is what stops the
   * two from disagreeing about which clip is on top.
   *
   * A transition is the one case where an item is drawn outside its own time range:
   * during a centred crossfade the *outgoing* clip has already ended and the
   * *incoming* one has not started, yet both are on screen. `visibleLayers` already
   * widens the incoming side; the outgoing side is widened here by looking forward
   * for the next item on the same track.
   */
  const layers = useMemo(() => {
    const pictures = Object.values(state.items).filter(
      (entry) => (entry.type === 'video' || entry.type === 'image') && entry.mediaId,
    );
    const orderOf = (trackId: string) =>
      state.tracks.find((track) => track.id === trackId)?.order ?? 0;

    return visibleLayers(
      pictures.map((entry) => {
        // An item whose successor starts inside a transition window stays drawable
        // across that window: it is the outgoing half of the transition.
        const successor = pictures
          .filter((other) => other.trackId === entry.trackId && other.startUs > entry.startUs)
          .sort((a, b) => a.startUs - b.startUs)[0];
        // How far the successor's transition reaches back before its own start:
        // the whole duration for a `start`-aligned window, half of it for a centred
        // one, and not at all for an `end`-aligned one.
        const transitionIn = successor?.transitionIn;
        const extensionUs = !transitionIn
          ? 0
          : transitionIn.alignment === 'start'
            ? transitionIn.durationUs
            : transitionIn.alignment === 'center'
              ? Math.round(transitionIn.durationUs / 2)
              : 0;
        return {
          id: entry.id,
          startUs: entry.startUs,
          durationUs: entry.durationUs + extensionUs,
          trackOrder: orderOf(entry.trackId),
          opacity: entry.opacity,
          blendMode: entry.blendMode,
          keyframes: entry.keyframes,
          disabled: entry.disabled,
          hiddenTrack: Boolean(state.tracks.find((track) => track.id === entry.trackId)?.hidden),
          transitionIn: entry.transitionIn,
        };
      }),
      playheadUs,
    );
  }, [state, playheadUs]);

  /**
   * Adjustment layers live at the playhead (SPEC 12 §3.1).
   *
   * They have no picture of their own, so they are not layers — they are chains that
   * grade the layers underneath. Resolved once here rather than per layer so that
   * every layer below a given adjustment layer sees exactly the same chain.
   */
  const adjustmentLayers = useMemo(
    () =>
      activeAdjustmentLayers(
        Object.values(state.items).map((entry) => ({
          id: entry.id,
          type: entry.type,
          startUs: entry.startUs,
          durationUs: entry.durationUs,
          trackOrder: state.tracks.find((track) => track.id === entry.trackId)?.order ?? 0,
          disabled: entry.disabled,
          hiddenTrack: state.tracks.find((track) => track.id === entry.trackId)?.hidden,
          effects: entry.effects,
        })),
        playheadUs,
      ),
    [state, playheadUs],
  );

  /**
   * Effects that are active under the playhead but that the preview cannot draw.
   *
   * Collected from every visible layer rather than only the selected one, because
   * the banner is about the picture on screen — an unpaintable effect on an overlay
   * clip is just as missing as one on the main track.
   */
  const unpreviewable = useMemo(() => {
    const names = new Set<string>();
    for (const layer of layers) {
      const chain = [
        ...activeEffects(state.items[layer.id]?.effects),
        ...effectsForLayer(adjustmentLayers, layer.trackOrder),
      ];
      for (const name of unsupportedEffectNames(chain)) {
        names.add(name);
      }
    }
    return [...names];
  }, [layers, state, adjustmentLayers]);

  // Sound comes from the bottom picture layer only — the one `videoRef` points at.
  // Each layer seeks itself; this function must not seek or the two would fight
  // over the same element.
  const syncVideo = useCallback(() => {
    const video = videoRef.current;
    const us = playheadStore.get();
    const bottom = layers[0] ? state.items[layers[0].id] : undefined;
    if (!video || !bottom) {
      setMissing(true);
      video?.pause();
      return;
    }
    setMissing(false);

    // The preview's level comes from the same envelope the export mixes with
    // (SPEC 12 §6.1). Reading the item's own volume is not enough: a fade or a
    // keyframed volume lives in the envelope, and a preview that ignores it sounds
    // different from the file — which is the one thing a preview must not do.
    //
    // The track's mute/solo state is folded in here too, because the video element
    // has no notion of tracks.
    const track = state.tracks.find((candidate) => candidate.id === bottom.trackId);
    const anySolo = state.tracks.some((candidate) => candidate.solo);
    video.volume = gainAt(
      {
        startUs: bottom.startUs,
        durationUs: bottom.durationUs,
        gainDb: bottom.gainDb ?? 0,
        volumeDb: bottom.volumeDb ?? 0,
        fadeInUs: bottom.fadeInUs,
        fadeOutUs: bottom.fadeOutUs,
        fadeCurve: bottom.fadeCurve,
        muted: Boolean(bottom.muted),
        trackMuted: Boolean(track?.muted),
        silencedBySolo: anySolo && !track?.solo,
        /*
          Volume keyframes (SPEC 12 §6), which the preview was ignoring while the
          export honoured them. Stored local to the item and evaluated against
          timeline time, so they are shifted by the item's own start — the same shift
          `planAudioItems` performs for the export, because a preview that disagreed
          with the file would be worse than one that ignored the feature outright.
        */
        keyframes: volumeKeyframesFor(bottom),
      },
      us,
    );
  }, [layers, state]);

  // Follow the playhead while it moves (scrubbing and playback alike).
  useEffect(() => {
    const unsubscribe = playheadStore.subscribe(syncVideo);
    syncVideo();
    return unsubscribe;
  }, [syncVideo]);



  /*
    Every layer's geometry at the current instant, keyed by id, plus the drawn bounds
    snapping measures against.

    Computed here rather than inside the render loop because a drag needs its
    *neighbours'* bounds, and no item can know those while the others are still being
    drawn. One pass, then a lookup per layer.
  */
  const layerGeometry = useMemo(() => {
    const byId: Record<string, ReturnType<typeof itemGeometry>> = {};
    for (const layer of layers) {
      const item = state.items[layer.id];
      if (!item) continue;
      byId[layer.id] = itemGeometry({
        ...item,
        timeUs: playheadUs,
        canvas: { width: canvas.width, height: canvas.height },
      });
    }
    return byId;
  }, [layers, state.items, playheadUs, canvas.width, canvas.height]);

  /*
    The lines a *visible* overlay contributes to snapping (SPEC 10 §8.8, §9).

    Gated on the overlay being on screen. Snapping to a line the user cannot see is the
    invisible-jump problem the guide lines exist to solve, reintroduced through the back
    door: a clip would stick to something with nothing to explain it.

    The rectangles come from the same `safeAreaRect` the overlay itself draws from, so a
    retuned `assets/safe-areas.json` moves the line and the snap together and the two
    cannot drift apart.
  */
  const userGuides = useMemo(() => state.guides ?? [], [state.guides]);
  const overlayLines = useMemo(() => {
    const safeFraction =
      overlays.areas === 'title-safe'
        ? SAFE_AREAS.titleSafe
        : overlays.areas === 'action-safe'
          ? SAFE_AREAS.actionSafe
          : null;
    const rects = safeFraction !== null ? [safeAreaRect(safeFraction)] : [];
    /*
      The grid, when it is showing. Same gate and same reason: `Ctrl+'` draws it, and a
      clip must not stick to a composition line the user has not asked to see. The columns
      govern vertical lines, so they are `x` targets; the rows are `y`.
    */
    const grid = overlays.thirds ? effectiveGrid(overlays.thirds) : null;
    const gridX = grid ? targetsForLines(gridLines(grid.columns), 'grid-line') : [];
    const gridY = grid ? targetsForLines(gridLines(grid.rows), 'grid-line') : [];
    /*
      The user's guides are always snap targets, unlike the compliance overlays: they are
      on screen whenever the project is open, because the user put them there, so there is
      nothing invisible about snapping to one.
    */
    return {
      x: [
        ...rects.flatMap((rect) => targetsForOverlayRect(rect, 'x')),
        ...guideSnapTargets(userGuides, 'x'),
        ...gridX,
      ],
      y: [
        ...rects.flatMap((rect) => targetsForOverlayRect(rect, 'y')),
        ...guideSnapTargets(userGuides, 'y'),
        ...gridY,
      ],
    };
  }, [overlays.areas, overlays.thirds, userGuides]);

  /*
    The Guides menu (SPEC 10 §8.8): *Add horizontal*, *Add vertical*, *Lock*, *Clear*.

    Every item is a command, so every item is undoable — Ctrl+Z puts back a guide that
    *Clear* removed, which is the difference between a menu that is a shortcut for the
    gestures and a menu that quietly bypasses the undo stack. *Add* drops the guide in the
    middle of the composition and leaves the user to drag it; there is no other sensible
    default position, and picking an edge would put it under the edge handle.
  */
  const guideMenuItems = useMemo((): MenuItem[] => {
    const count = userGuides.length;
    const allLocked = count > 0 && userGuides.every((guide) => guide.locked);
    const anyLocked = userGuides.some((guide) => guide.locked);
    /*
      Built inside the command, from the state the command is handed, rather than here from
      the list the menu was rendered with. `setGuides` replaces the whole array, so a list
      captured when the menu opened would drop any guide placed while it was open — the
      gesture and the menu look independent, and the menu would quietly undo the gesture.
    */
    const add = (axis: 'x' | 'y') => (stateNow: TimelineState) => {
      const id = `guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // The pure filter, so a guide already sitting at the middle is replaced rather than
      // doubled — the same near-duplicate rule the drag gesture obeys.
      const next = addGuide(stateNow.guides ?? [], { id, axis, at: 0.5, locked: false });
      return setGuidesCommand(stateNow, { guides: next });
    };
    return [
      {
        id: 'guide-add-horizontal',
        label: 'Add horizontal guide',
        icon: <Minus size={13} />,
        onSelect: () => {
          timeline?.run('Add guide', add('y'));
        },
      },
      {
        id: 'guide-add-vertical',
        label: 'Add vertical guide',
        icon: <Grid3x3 size={13} />,
        onSelect: () => {
          timeline?.run('Add guide', add('x'));
        },
      },
      {
        id: 'guide-lock',
        label: allLocked ? 'Unlock guides' : 'Lock guides',
        icon: allLocked ? <LockOpen size={13} /> : <Lock size={13} />,
        // No shortcut shown: Lock has no key of its own, and the one gesture it is next to
        // (`Shift`+`Ctrl`-drag) is the one it *blocks* — advertising it here would read as
        // the way to lock rather than the way to remove.
        separatorBefore: true,
        disabled: count === 0,
        disabledReason: 'There are no guides yet.',
        onSelect: () => {
          timeline?.run(allLocked ? 'Unlock guides' : 'Lock guides', (stateNow) =>
            setGuidesLockedCommand(stateNow, { locked: !allLocked }),
          );
        },
      },
      {
        id: 'guide-clear',
        label: anyLocked ? 'Clear unlocked guides' : 'Clear guides',
        icon: <X size={13} />,
        danger: true,
        disabled: count === 0,
        disabledReason: 'There are no guides yet.',
        onSelect: () => {
          timeline?.run('Clear guides', (stateNow) => clearGuidesCommand(stateNow));
        },
      },
      {
        id: 'grid-settings',
        label: overlays.thirds ? `Composition grid (${gridLabel(overlays.thirds)})` : 'Composition grid',
        icon: <Grid3x3 size={13} />,
        separatorBefore: true,
        /*
          The grid lives here because this button already *is* the overlay control in the
          transport strip, and a second button next to it for one overlay would be the
          beginning of a toolbar row. It is also where a user who has just pressed `Ctrl+'`
          will look to change what they see.
        */
        shortcut: "Ctrl+'",
        onSelect: () => setGridDialogOpen(true),
      },
    ];
  }, [userGuides, timeline, overlays.thirds]);

  /*
    The snap targets, as bounds on each axis. A drag excludes its own item — snapping a
    clip to where it already is would pin it in place — so the map is of *every* item and
    the drag filters; doing it the other way round would need one map per dragged item.
  */
  const snapBounds = useMemo(() => {
    const canvasAspect =
      canvas.height > 0 && Number.isFinite(canvas.width / canvas.height)
        ? canvas.width / canvas.height
        : 1;
    const bounds: Record<string, { x: ItemBounds; y: ItemBounds }> = {};
    for (const [id, geometry] of Object.entries(layerGeometry)) {
      /*
        The drawn size in canvas fractions: `source.width` is already a fraction of the
        canvas width, and the scale multiplies it. Crop is already folded into
        `source.width`, so a cropped clip snaps to the edges of what is actually visible.
      */
      const width = geometry.source.width * geometry.scaleX;
      const height = geometry.source.height * geometry.scaleY;
      bounds[id] = {
        x: itemBounds(geometry.offsetX, width, geometry.rotation, height, canvasAspect),
        y: itemBounds(
          geometry.offsetY,
          height,
          geometry.rotation,
          width,
          Number.isFinite(canvasAspect) && canvasAspect > 0 ? 1 / canvasAspect : 1,
        ),
      };
    }
    return bounds;
  }, [layerGeometry, canvas.width, canvas.height]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface-app)',
          padding: 'var(--space-3)',
        }}
      >
        <div
          ref={canvasRef}
          data-testid="preview-canvas"
          /*
            `Ctrl` + drag from an edge (SPEC 10 §8.8). Bound on the canvas rather than the
            window so a drag that leaves the preview stops meaning anything, and guarded
            to the edges so an ordinary `Ctrl`-drag over the picture — which is not a
            gesture this surface otherwise gives a meaning — is ignored rather than
            silently making guides.
          */
          onPointerDown={(event) => {
            if (!(event.ctrlKey || event.metaKey) || !timeline) return;
            /*
              A `Ctrl`-drag that began **on a clip** is that clip's drag, not a guide. The
              layer sits inside this element, so its pointer-down bubbles here — without
              this check one gesture both moved the picture and left a line behind, which
              is precisely the "two things at once" the rotate handle has to stop
              propagation to avoid. Checking the target rather than stopping propagation in
              the layer keeps the layer's own handler unaware of guides entirely.
            */
            const origin = event.target as HTMLElement | null;
            if (origin?.closest('[data-layer-id]')) return;
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) return;
            const fractionX = (event.clientX - box.left) / box.width;
            const fractionY = (event.clientY - box.top) / box.height;
            const edge = edgeAt(fractionX, fractionY);
            if (!edge) return;
            event.preventDefault();
            const axis = axisForEdge(edge);
            /*
              `Shift` is read here rather than at release, because a `pointerup` carries
              no modifier state — reading `event.shiftKey` there would always be false and
              the removal gesture would silently never fire.
            */
            guideDrag.current = {
              axis,
              at: axis === 'x' ? fractionX : fractionY,
              removing: event.shiftKey,
            };
          }}
          onPointerMove={(event) => {
            const active = guideDrag.current;
            if (!active) return;
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) return;
            // Follows the pointer: the guide is placed where it is released, so the user
            // can pull it in from the edge and let go where the subject actually is.
            guideDrag.current = {
              ...active,
              at: active.axis === 'x'
                ? (event.clientX - box.left) / box.width
                : (event.clientY - box.top) / box.height,
            };
          }}
          onPointerUp={() => {
            const active = guideDrag.current;
            guideDrag.current = null;
            if (!active || !timeline) return;
            if (active.removing) {
              /*
                `Shift`+`Ctrl`-drag takes a guide away. Without it the only way to remove
                one is undo, which also throws away every edit since it was placed — too
                blunt for a mark the user made and changed their mind about.
              */
              /*
                Resolved against the state the command is handed, like the *Add* path and
                for the same reason: this render's list could predate a guide being placed,
                moved or locked, and here a stale read would remove something the user had
                already protected.
              */
              timeline.run('Remove guide', (stateNow) => {
                const doomed = guideToRemove(stateNow.guides ?? [], active.axis, active.at);
                // Nothing in reach is not an error worth an undo step — the gesture was a
                // no-op, and a failure would light up the status bar for it.
                return doomed ? removeGuideCommand(stateNow, { id: doomed.id }) : null;
              });
              return;
            }
            const id = `guide~${Date.now().toString(36)}~${Math.round(active.at * 1e6)}`;
            /*
              `run` with the engine command, so the guide is one undo step and lands in the
              project file. The list is built from the state the command is *handed*, not
              from this render's: `setGuides` replaces the whole array, so a snapshot taken a
              frame earlier would drop a guide placed in between — the same trap the menu's
              *Add* had, and the reason both build their list in here.
            */
            timeline.run('Add guide', (stateNow) =>
              setGuidesCommand(stateNow, {
                guides: addGuide(stateNow.guides ?? [], {
                  id,
                  axis: active.axis,
                  at: active.at,
                  // A guide the user just dragged in is never born locked.
                  locked: false,
                }),
              }),
            );
          }}
          style={{
            position: 'relative',
            aspectRatio: state.canvas?.aspect ?? '9:16',
            maxHeight: '100%',
            maxWidth: '100%',
            height: '100%',
            background: canvas.backgroundColor ?? 'var(--surface-card)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            border: '1px solid var(--line-subtle)',
          }}
        >
          {/*
            Guides sit above the picture and below the selection handles: above,
            because a safe area you cannot see over is useless; below, because a guide
            must never take a pointer away from a clip being dragged.
          */}
          {overlaysVisible(overlays) ? (
            <PreviewOverlays state={overlays} data={SAFE_AREAS} zone={platformZone} />
          ) : null}
          {/*
            Above the guides and below the handles: a snap line is about the gesture in
            progress, so it sits with the selection rather than with the compliance
            overlays the user switched on deliberately.
          */}
          {/*
            The user's own guides draw first, below the gesture overlays: they are
            permanent marks on this project, not feedback about the drag in progress, so
            a snap line belongs on top of them.
          */}
          <UserGuides guides={state.guides ?? []} />
          <SnapGuides guides={drag.guides} />
          {/*
            The equal-spacing hint sits with the guides rather than below them: both
            explain the same gesture, and a hint on its own is the only thing on screen
            when a clip is being spaced rather than aligned.
          */}
          <SpacingHints spans={drag.spacing} />
          {/*
            Every layer's geometry, computed before the render loop rather than inside
            it, because snapping needs the *other* items' bounds — and an item cannot
            know its neighbours while its neighbours are still being drawn. One pass
            here, one lookup below.
          */}
          {layers.length > 0 ? (
            layers.map((layer: VisibleLayer, index: number) => {
              const transition = transitionFor(layer, state, playheadUs);
              // The item's own chain, then everything grading it from above: the
              // preview must show an adjustment layer's effect just as the export
              // renders it, or the two disagree about the picture.
              const effects = [
                ...activeEffects(state.items[layer.id]?.effects),
                ...effectsForLayer(adjustmentLayers, layer.trackOrder),
              ];
              const item = state.items[layer.id]!;
              const live = drag.preview(layer.id);
              /*
                The in-flight drag overrides the stored values, so the picture follows
                the pointer without the document changing under the user's hand. Both
                the *geometry* and the *element* have to read the live value: updating
                only one would draw the picture in one place while its outline sat in
                another.
              */
              /*
                The canvas size goes in so the anchor's arm is rotated in one unit: the
                two arms are fractions of different sides, and a non-square canvas made
                them disagree by the aspect ratio.
              */
              const geometry = itemGeometry({
                ...item,
                ...(live ? { transform: { ...item.transform, x: live.x, y: live.y } } : {}),
                ...(live ? { crop: live.crop } : {}),
                timeUs: playheadUs,
                canvas: { width: canvas.width, height: canvas.height },
              });
              /*
                What this drag can snap to, and where its own edges are.

                `others` excludes this item: snapping a clip to a line it already sits on
                would pin it in place for the whole gesture. The extents are the drawn
                size in canvas fractions, which is what `snapAxis` measures half of.
              */
              const snapExtent = {
                x: geometry.source.width * geometry.scaleX,
                y: geometry.source.height * geometry.scaleY,
              };
              const snapOthers = {
                x: Object.entries(snapBounds)
                  .filter(([id]) => id !== layer.id)
                  .map(([, bounds]) => bounds.x),
                y: Object.entries(snapBounds)
                  .filter(([id]) => id !== layer.id)
                  .map(([, bounds]) => bounds.y),
              };
              const editable = Boolean(timeline) && selectedId === layer.id;
              return (
              <PreviewLayer
                key={layer.id}
                item={item}
                geometry={geometry}
                editable={editable}
                dragging={drag.dragging}
                fps={fps}
                onPointerDown={(event) => {
                  if (!editable) return;
                  // The drag surface is the layer's own wrapper: the clamp inside
                  // `handleAt` measures against the drawn rectangle, so the edges
                  // land where the picture's edges are.
                  const box = event.currentTarget.getBoundingClientRect();
                  drag.begin(
                    event,
                    {
                      itemId: layer.id,
                      x: live?.x ?? item.transform.x ?? 0,
                      y: live?.y ?? item.transform.y ?? 0,
                      rotation: live?.rotation ?? item.transform.rotation ?? 0,
                      anchorX: live?.anchorX ?? item.transform.anchorX ?? 0.5,
                      anchorY: live?.anchorY ?? item.transform.anchorY ?? 0.5,
                      crop: live?.crop ?? item.crop,
                      // Move and crop measure against the drawn box, so the layer's own
                      // size is what they want; the untransformed size is only used to
                      // aim the anchor crosshair.
                      size: { width: box.width, height: box.height },
                      scaleX: geometry.scaleX,
                      scaleY: geometry.scaleY,
                      extent: snapExtent,
                      others: snapOthers,
                      /*
                        Only the move gesture gets these: a scale or a rotate has its own
                        arithmetic that a snap would fight, and `snapped` is computed for
                        a move alone.
                      */
                      overlayLines,
                      rect: { x: 0, y: 0, width: box.width, height: box.height },
                    },
                    canvasRef.current,
                  );
                }}
                onRotateStart={(event) => {
                  if (!editable) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  const fit = document.querySelector<HTMLElement>(
                    `[data-layer-id="${layer.id}"] [data-testid="preview-item-fit"]`,
                  );
                  const fitBox = fit?.getBoundingClientRect();
                  drag.begin(
                    event,
                    {
                      itemId: layer.id,
                      x: live?.x ?? item.transform.x ?? 0,
                      y: live?.y ?? item.transform.y ?? 0,
                      rotation: live?.rotation ?? item.transform.rotation,
                      anchorX: live?.anchorX ?? item.transform.anchorX,
                      anchorY: live?.anchorY ?? item.transform.anchorY,
                      crop: live?.crop ?? item.crop,
                      // A rotate needs the pivot, not the pointer, so the size fields
                      // are unused here; the layer's own box fills them and the gesture
                      // only reads `rect`.
                      size: { width: box.width, height: box.height },
                      scaleX: geometry.scaleX,
                      scaleY: geometry.scaleY,
                      extent: snapExtent,
                      others: snapOthers,
                      // The pivot has to be measured against the *picture's* box, so
                      // the handle turns about the crosshair rather than the frame.
                      rect: fitBox
                        ? { x: fitBox.left - box.left, y: fitBox.top - box.top, width: fitBox.width, height: fitBox.height }
                        : { x: 0, y: 0, width: box.width, height: box.height },
                    },
                    canvasRef.current,
                    'rotate',
                  );
                }}
                onAnchorStart={(event) => {
                  if (!editable) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  const fit = document.querySelector<HTMLElement>(
                    `[data-layer-id="${layer.id}"] [data-testid="preview-item-fit"]`,
                  );
                  const fitBox = fit?.getBoundingClientRect();
                  drag.begin(
                    event,
                    {
                      itemId: layer.id,
                      x: live?.x ?? item.transform.x ?? 0,
                      y: live?.y ?? item.transform.y ?? 0,
                      rotation: live?.rotation ?? item.transform.rotation ?? 0,
                      anchorX: live?.anchorX ?? item.transform.anchorX ?? 0.5,
                      anchorY: live?.anchorY ?? item.transform.anchorY ?? 0.5,
                      crop: live?.crop ?? item.crop,
                      // The element's *layout* size, which is what a transform is applied to; the
                      // bounding box would already include the rotation and scale.
                      size: fit ? { width: fit.offsetWidth, height: fit.offsetHeight } : { width: box.width, height: box.height },
                      scaleX: geometry.scaleX,
                      scaleY: geometry.scaleY,
                      extent: snapExtent,
                      others: snapOthers,
                      rect: fitBox
                        ? {
                            x: fitBox.left - box.left,
                            y: fitBox.top - box.top,
                            width: fitBox.width,
                            height: fitBox.height,
                          }
                        : { x: 0, y: 0, width: box.width, height: box.height },
                    },
                    canvasRef.current,
                    'anchor',
                  );
                }}
                onPointerMove={(event) => {
                  if (!editable) return;
                  drag.move(event);
                }}
                onPointerUp={(event) => {
                  if (!editable) return;
                  drag.end(event);
                }}
                showAnchor={showAnchor}
                opacity={layer.opacity * (transition?.fromOpacity ?? 1)}
                blendMode={layer.blendMode}
                transitionOffsetX={transition?.offsetX ?? 0}
                transitionOffsetY={transition?.offsetY ?? 0}
                transitionScale={transition?.scale ?? 1}
                transitionWipe={transition?.wipe}
                transitionDissolve={transition?.dissolve}
                effectFilter={cssFiltersFor(effects)}
                initialAspect={canvas.width / canvas.height}
                muted={muted}
                playing={playing}
                onPlayRejected={() => setPlaying(false)}
                // Only the bottom layer carries sound: two <video> elements both
                // playing the same source double the volume and echo by a frame.
                audio={index === 0}
                reffed={index === 0 ? videoRef : undefined}
              />
              );
            })
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                padding: 'var(--space-3)',
                fontSize: 'var(--fs-sm)',
                color: 'var(--text-muted)',
              }}
            >
              {missing ? 'Nothing under the playhead' : 'Add a clip to preview'}
            </div>
          )}

          {/*
            Captions are painted over the video, always — including over the
            "nothing under the playhead" message, because a caption track can be
            the only track with content in a range.
          */}
          <CaptionOverlay
            state={state}
            width={canvas.width}
            height={canvas.height}
            projectCopies={captionStyles}
          />

          {/*
            SPEC 10 §14 — the preview must admit what it cannot show. This build
            has no WebGL2 renderer, so effects are drawn with CSS filters where CSS
            has an equivalent and not at all where it does not. Saying so is the
            difference between a preview that is approximate and a preview that
            lies; the export applies the full chain either way.
          */}
          {unpreviewable.length > 0 && (
            <div
              data-testid="preview-effect-banner"
              style={{
                position: 'absolute',
                left: 'var(--space-2)',
                right: 'var(--space-2)',
                bottom: 'var(--space-2)',
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: 'color-mix(in srgb, var(--surface-app) 85%, transparent)',
                color: 'var(--text-secondary)',
                fontSize: 'var(--fs-xs)',
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              Some effects can’t be previewed on this computer ({unpreviewable.join(', ')});
              export is unaffected.
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderTop: '1px solid var(--line-subtle)',
        }}
      >
        <IconButton
          label="Back to start"
          size={28}
          icon={<SkipBack size={14} />}
          onClick={() => playheadStore.set(0)}
        />
        <IconButton
          label={playing ? 'Pause' : 'Play'}
          shortcut="Space"
          size={32}
          active={playing}
          icon={playing ? <Pause size={14} /> : <Play size={14} />}
          onClick={() => setPlaying((value) => !value)}
        />
        <IconButton
          label="Jump to end"
          size={28}
          icon={<SkipForward size={14} />}
          onClick={() => playheadStore.set(durationUs)}
        />
        <TransportTimecode fps={fps} durationUs={durationUs} />
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            // Anchors the Guides menu's absolute fallback; `Menu` is fixed-positioned
            // when it has coordinates, so this only matters if that ever changes.
            position: 'relative',
          }}
        >
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton
              /*
                The label carries the grid, because the grid is a setting with no other
                visible home: `Ctrl+'` turns it on and off and the lines themselves say
                nothing about whether they are 3×3 or 5×4.
              */
              label={`Guides and grid (${gridLabel(overlays.thirds ?? grid)})`}
              shortcut="Ctrl+drag from an edge"
              size={28}
              active={guideMenuAt !== null}
              icon={
                userGuides.some((guide) => guide.locked) ? (
                  <Lock size={14} />
                ) : (
                  <Grid3x3 size={14} />
                )
              }
              /*
                A plain toggle, with the button's own press kept away from `Menu`.

                `Menu` closes itself on any `mousedown` outside itself, and this button is
                outside it — so without the `onMouseDown` guard, pressing the button while
                the menu is open ran that listener *first*, the click then toggled an
                already-closed menu back open, and the button could never close what it
                opened. Stopping the press from reaching the window listener leaves the
                toggle to the click, which is also what keeps keyboard activation (Enter
                and Space fire a click and no `mousedown`) working.
              */
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setGuideMenuAt((open) =>
                  open ? null : { x: rect.left, y: rect.bottom + 4 },
                );
              }}
            />
          </span>
          {guideMenuAt && (
            <Menu
              items={guideMenuItems}
              x={guideMenuAt.x}
              y={guideMenuAt.y}
              onClose={() => setGuideMenuAt(null)}
            />
          )}
          <GridDialog
            open={gridDialogOpen}
            value={grid}
            onClose={() => setGridDialogOpen(false)}
            onApply={(next) => {
              setGrid(next);
              /*
                Applying turns the grid *on*. Someone who opens this dialog has asked to see
                a grid, and making them press `Ctrl+'` afterwards to find out whether the
                numbers were what they wanted would be a second step for no reason.
              */
              setOverlays((current) => ({ ...current, thirds: next }));
              setGridDialogOpen(false);
            }}
          />
          <IconButton
            label={muted ? 'Unmute preview' : 'Mute preview'}
            size={28}
            active={muted}
            icon={muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            onClick={() => setMuted((value) => !value)}
          />
        </div>
      </div>
    </div>
  );
}

function TransportTimecode({ fps, durationUs }: { fps: 30 | 60; durationUs: number }) {
  const us = usePlayheadUs();
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        color: 'var(--text-secondary)',
      }}
    >
      {formatTimecode(us, fps)} <span style={{ color: 'var(--text-muted)' }}>/ {formatTimecode(durationUs, fps)}</span>
    </span>
  );
}


/**
 * What a running transition asks of one layer (SPEC 12 §4).
 *
 * A layer can be on either side of the cut, and the two sides want opposite halves
 * of the same `TransitionState` — so this picks the half. The incoming item is the
 * one that carries `transitionIn`; the outgoing one is whichever layer's successor
 * does. Offsets are returned in frame widths, the unit the transform uses.
 */
function transitionFor(
  layer: VisibleLayer,
  state: TimelineState,
  timeUs: number,
): {
  fromOpacity: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  /** Set on the incoming side of a running wipe (SPEC 12 §4.2). */
  wipe?: WipeShape;
  /** Set on the incoming side of a running dissolve (SPEC 12 §4.2). */
  dissolve?: DissolveShape;
} | null {
  const item = state.items[layer.id];
  if (!item) return null;

  if (item.transitionIn) {
    const at = transitionAt(item.startUs, item.transitionIn, timeUs);
    if (!at) return null;
    // `visibleLayers` already multiplies in the two fade shapes' contribution
    // (`fade-black`, `dip-color`), because those are the only ones where the
    // incoming item is *absent* rather than transparent. Applying `toOpacity` again
    // here would square the fade — a 0.5 became 0.25.
    const fadedByLayers =
      item.transitionIn.type === 'fade-black' || item.transitionIn.type === 'dip-color';
    return {
      fromOpacity: fadedByLayers ? 1 : at.state.toOpacity,
      offsetX: at.state.toOffsetX,
      offsetY: at.state.toOffsetY,
      scale: at.state.toScale,
      wipe: at.state.wipe,
      dissolve: at.state.dissolve,
    };
  }

  // Outgoing side: find the next item on this track and ask its transition.
  const pictures = Object.values(state.items).filter(
    (entry) => entry.trackId === item.trackId && entry.startUs > item.startUs,
  );
  const successor = pictures.sort((a, b) => a.startUs - b.startUs)[0];
  if (!successor?.transitionIn) return null;
  const at = transitionAt(successor.startUs, successor.transitionIn, timeUs);
  if (!at) return null;
  return {
    fromOpacity: at.state.fromOpacity,
    offsetX: at.state.fromOffsetX,
    offsetY: at.state.fromOffsetY,
    scale: at.state.fromScale,
  };
}

/**
 * An item's `volumeDb` keyframes, shifted from item-local into timeline time.
 *
 * Only numeric values are kept: the schema lets a keyframe hold an RGBA tuple, and a
 * tuple reaching the dB envelope would become `NaN`, which multiplies through the
 * gain and silences the whole clip with no error to explain it.
 */
export function volumeKeyframesFor(
  item: { startUs: number; keyframes?: Record<string, readonly { timeUs: number; value: unknown; interpolation?: string }[]> },
): ReadonlyArray<{ timeUs: number; valueDb: number; interpolation?: 'linear' | 'hold' | 'bezier' | 'preset' }> | undefined {
  const keys = item.keyframes?.['volumeDb'];
  if (!keys || keys.length === 0) return undefined;
  const shifted = keys
    .filter((key) => typeof key.value === 'number')
    .map((key) => ({
      timeUs: key.timeUs + item.startUs,
      valueDb: key.value as number,
      ...(key.interpolation
        ? { interpolation: key.interpolation as 'linear' | 'hold' | 'bezier' | 'preset' }
        : {}),
    }));
  return shifted.length > 0 ? shifted : undefined;
}

/**
 * One picture layer of the preview (SPEC 10 §2/§6).
 *
 * Extracted from the canvas so the frame can hold more than one. The crop,
 * transform and flip work exactly as they did when there was a single item; what
 * is new is that each layer carries its own opacity and blend mode, applied with
 * CSS because the browser already composites this way and re-implementing the
 * blend maths in JavaScript would be slower *and* a second definition of what a
 * `multiply` is.
 *
 * `mix-blend-mode` blends against everything painted below it inside the same
 * stacking context, which is the canvas — so a `screen` overlay picks up the main
 * video, not the app chrome behind it.
 */
const PreviewLayer = memo(function PreviewLayer({
  item,
  geometry,
  opacity,
  blendMode,
  initialAspect,
  transitionOffsetX,
  transitionOffsetY,
  transitionScale,
  transitionWipe,
  transitionDissolve,
  effectFilter,
  muted,
  playing,
  onPlayRejected,
  audio,
  reffed,
  editable = false,
  dragging = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRotateStart,
  fps,
  onAnchorStart,
  showAnchor = true,
}: {
  item: TimelineState['items'][string];
  geometry: ItemGeometry;
  /** Whether this layer is the selected clip and the preview can edit it. */
  editable?: boolean;
  /** Whether a drag is in flight, which keeps the outline solid. */
  dragging?: boolean;
  onPointerDown?: (event: React.PointerEvent) => void;
  /** Starts a rotate gesture from the handle above the picture. */
  onRotateStart?: (event: React.PointerEvent) => void;
  /** Starts an anchor drag from the crosshair. */
  onAnchorStart?: (event: React.PointerEvent) => void;
  /**
   * Whether the pivot crosshair is drawn at all (§8.2's *Show anchor*, `A`).
   *
   * Separate from `editable` on purpose: `editable` means "this clip is the selection and
   * a gesture here would edit it", while this means "the user wants to see the pivot".
   * Hiding the crosshair must not stop the clip being dragged, and a read-only preview
   * must not resurrect it.
   */
  showAnchor?: boolean;
  /**
   * The project's frame rate, for the seek threshold: "close enough" is measured in
   * frames, so half a frame at 60 fps is half the time it is at 30.
   */
  fps: number;
  onPointerMove?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  opacity: number;
  blendMode: string;
  /** Canvas aspect, used until the source reports its own. */
  initialAspect: number;
  /** Horizontal slide from a running transition, in frame widths. */
  transitionOffsetX: number;
  /** Vertical slide from a running transition, in frame heights. */
  transitionOffsetY: number;
  /** CSS `filter` string approximating the item's effect chain. */
  effectFilter: string;
  /** Scale from a running `zoom` transition. */
  transitionScale: number;
  /** The sweeping edge of a running `wipe` (SPEC 12 §4.2). */
  transitionWipe?: WipeShape;
  /** The noise field of a running `dissolve` (SPEC 12 §4.2). */
  transitionDissolve?: DissolveShape;
  muted: boolean;
  playing: boolean;
  onPlayRejected: () => void;
  /** Whether this layer supplies sound. Only the bottom layer does. */
  audio: boolean;
  reffed?: React.MutableRefObject<HTMLVideoElement | null>;
}) {
  // The source's own aspect ratio, known only after the first frame's metadata.
  // Until then the canvas ratio is the best guess, which is also what the element
  // was doing before crop existed.
  const [sourceAspect, setSourceAspect] = useState(initialAspect);
  const src = item.mediaId ? `${MEDIA_ORIGIN}${encodeURIComponent(item.mediaId)}` : undefined;
  const fitRef = useRef<HTMLDivElement>(null);

  // Each layer's <video> has to follow the playhead on its own: they carry
  // different source in-points, so one shared `currentTime` would put every layer
  // at the same frame of the same file.
  useEffect(() => {
    const video = fitRef.current?.querySelector('video');
    if (!video) return;
    /*
      Seeks are coalesced rather than issued per event. Assigning `currentTime` starts a
      seek and assigning it again *aborts* that seek, so a scrub that assigned for every
      pointer move spent the whole drag abandoning decodes and showing none of them.

      The coalescer keeps one seek in flight and holds only the newest target, so the
      picture lands where the pointer is with at most one seek of lag, however fast the
      drag.
    */
    const coalescer = createSeekCoalescer({
      seek: (seconds) => {
        video.currentTime = seconds;
      },
    });
    // The element's own answer that a seek is over. Without this the coalescer would
    // believe a seek was forever in flight and never issue another.
    const onSeeked = () => coalescer.settled();
    video.addEventListener('seeked', onSeeked);

    const sync = () => {
      const us = playheadStore.get();
      const sourceUs = item.sourceInUs + (us - item.startUs) * (item.speed ?? 1);
      const target = sourceUs / 1_000_000;
      /*
        The threshold depends on whether the element is running: while playing, the
        element closes drift on its own and a correction is a visible hitch, so only a
        real drift is worth one. Paused or scrubbing, the element is the only thing that
        can show the frame under the playhead, so half a frame already matters.
      */
      if (shouldSeek(video.currentTime, target, { playing: !video.paused, fps })) {
        coalescer.request(target);
      }
    };
    const unsubscribe = playheadStore.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      video.removeEventListener('seeked', onSeeked);
    };
  }, [item.sourceInUs, item.startUs, item.speed, fps]);

  // Every layer plays its own element: the parent used to call `play()` on the
  // single <video>, and with a stack the overlays would sit frozen on their first
  // frame while the layer beneath them ran.
  useEffect(() => {
    const video = fitRef.current?.querySelector('video');
    if (!video) return;
    if (playing) void video.play().catch(onPlayRejected);
    else video.pause();
  }, [playing, onPlayRejected]);

  /*
    The crosshair's position as a fraction of the *drawn* picture.

    `geometry.anchorX/Y` are item-relative 0–1 — the same space the crosshair is laid
    out in — so no conversion is needed here beyond noting that the picture is what
    they are relative to. Kept in one object so the JSX below reads as one position
    rather than two lookups that could drift apart.
  */
  const anchorFraction = {
    x: geometry.anchorX ?? 0.5,
    y: geometry.anchorY ?? 0.5,
  };

  if (!src) return null;

  return (
    <div
      data-testid="preview-item"
      data-layer-id={item.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        mixBlendMode: CSS_BLEND_MODE[blendMode] ?? 'normal',
        // The edit surface must receive the pointer even at full transparency, or a
        // clip faded to zero becomes impossible to select or drag — the one moment a
        // user most wants to grab it.
        ...(editable ? { cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' } : {}),
        // The transition's slide adds to the item's own offset: both are frame
        // fractions, so they compose without conversion.
        transform: `translate(${(geometry.offsetX + transitionOffsetX) * 100}%, ${
          (geometry.offsetY + transitionOffsetY) * 100
        }%)`,
        // A wipe clips the layer rather than fading it, so it is a `clip-path` on
        // the outermost element: clipping an inner one would be undone by the
        // wrapper's own transform and would clip the wrong edge on a slid layer.
        // A soft edge is a two-stop gradient mask instead of a hard inset.
        ...(transitionWipe ? { clipPath: wipeClipPath(transitionWipe) } : {}),
        ...(transitionDissolve ? dissolveMaskStyle(transitionDissolve) : {}),
      }}
    >
      <div
        ref={fitRef}
        data-testid="preview-item-fit"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          /*
            Order matters, and the CSS reads right-to-left: this says *rotate, then
            scale*, so the scale multiplies the picture's own axes. Writing
            `scale(...) rotate(...)` instead scales along the SCREEN axes, which is a
            different picture whenever both are non-zero and the scale is non-uniform.

            SPEC 10 §4 defines the matrix as `translate · rotate · scale`,
            rightmost-applied-first, so the point is scaled in the picture's frame and
            then rotated — and that is what the exporter does too, because ffmpeg
            applies `scale` and only then `rotate`. Uniform scale commutes with
            rotation, so the two orders only diverged once the inspector started
            offering Scale X and Scale Y separately; from then on a rotated clip with
            unlike axes previewed as the exported picture's opposite aspect.
          */
          transform: `translate(-50%, -50%) rotate(${
            geometry.rotation
          }deg) scale(${
            geometry.scaleX * (geometry.flipH ? -1 : 1) * transitionScale
          }, ${geometry.scaleY * (geometry.flipV ? -1 : 1) * transitionScale})`,
          maxWidth: '100%',
          maxHeight: '100%',
          aspectRatio: `${geometry.source.width * sourceAspect} / ${geometry.source.height}`,
          width: '100%',
          overflow: 'hidden',
        }}
      >
        {/*
          The selection outline sits on the *fit* element, not the layer wrapper: this
          is the rectangle the crop actually carves out, so the handles land where the
          visible edges are. Putting it on the wrapper would outline the whole canvas
          and the edge drags would be measured against the wrong rectangle.
        */}
        {editable ? (
          /*
            The rotate handle sits *above* the picture, outside the fit element's
            overflow, so it is drawn as a sibling positioned from the top edge rather
            than as a child of the clipped box. It is a translate handle: pointer-down
            anywhere on it starts a rotate about the anchor.
          */
          <div
            data-testid="preview-rotate-handle"
            aria-label="Rotate the clip"
            onPointerDown={(event) => {
              // Without this the pointer-down would bubble to the layer and start a
              // move as well, so the clip would translate and rotate at once.
              event.stopPropagation();
              event.preventDefault();
              onRotateStart?.(event);
            }}
            style={{
              position: 'absolute',
              left: '50%',
              // 24 px above the top edge, per SPEC 10 §8.2's control table.
              top: -24,
              width: 14,
              height: 14,
              marginLeft: -7,
              borderRadius: '50%',
              background: 'var(--surface-card)',
              border: '1px solid var(--brand)',
              cursor: 'grab',
              // Above the video, which is absolutely positioned over this element.
              zIndex: 2,
            }}
          />
        ) : null}
        {editable ? (
          <div
            data-testid="preview-selection"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              outline: `1px solid ${dragging ? 'var(--brand)' : 'var(--text-secondary)'}`,
              outlineOffset: 0,
              // A second, dashed ring inside keeps the edge visible over both bright
              // and dark footage; one colour alone disappears against one or the other.
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.45)',
            }}
          >
            {/*
              Corner grips, drawn only as a cue — the hit test is along the whole edge
              (`handleAt`), so a user who grabs slightly off a corner still crops.
            */}
            {/*
              The anchor crosshair (SPEC 10 §8.2's *Show anchor*, `A`). It sits at the
              pivot as a fraction of the picture, and dragging it moves the pivot
              *without moving the picture* — the engine compensates, which `itemGeometry`
              already does by folding the anchor into the offset.

              Unlike the edge grips it must receive the pointer, so it is the one child
              of this overlay that is not `pointerEvents: none`.
            */}
            {showAnchor ? (
            <div
              data-testid="preview-anchor"
              aria-label="Drag the anchor point"
              onPointerDown={(event) => {
                // Same reason as the rotate handle: without stopping here the layer
                // beneath would start a move and the picture would slide while the
                // crosshair was being placed.
                event.stopPropagation();
                event.preventDefault();
                onAnchorStart?.(event);
              }}
              style={{
                position: 'absolute',
                left: `${(anchorFraction.x ?? 0.5) * 100}%`,
                top: `${(anchorFraction.y ?? 0.5) * 100}%`,
                width: 16,
                height: 16,
                transform: 'translate(-50%, -50%)',
                cursor: 'move',
                pointerEvents: 'auto',
                zIndex: 3,
              }}
            >
              {/* A crosshair drawn as two bars, so it reads as a pivot rather than as
                  another round handle. */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: '50%',
                  height: 1,
                  marginTop: -0.5,
                  background: 'var(--brand-amber)',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: '50%',
                  width: 1,
                  marginLeft: -0.5,
                  background: 'var(--brand-amber)',
                }}
              />
            </div>
            ) : null}
            {/*
              Corner grips (SPEC 10 §8.2). These *scale* uniformly about the opposite
              corner; the edge grips below still crop. The two gestures share the
              picture's edges, so a corner is drawn larger than an edge grip and takes
              the hit test first — grabbing a corner must scale, and a user who meant to
              crop can drag a little further along the edge.

              Positioned inside the picture's own box, which is already rotated, so the
              grips sit on the corners of the *oriented* bounding box the spec asks for
              without any trigonometry here.
            */}
            {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
              <div
                key={corner}
                data-testid={`preview-corner-${corner}`}
                style={{
                  position: 'absolute',
                  ...(corner === 'nw' ? { left: 0, top: 0 } : {}),
                  ...(corner === 'ne' ? { right: 0, top: 0 } : {}),
                  ...(corner === 'se' ? { right: 0, bottom: 0 } : {}),
                  ...(corner === 'sw' ? { left: 0, bottom: 0 } : {}),
                  width: HANDLE_SIZE,
                  height: HANDLE_SIZE,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: 1,
                  background: 'var(--surface-card)',
                  border: '1px solid var(--brand)',
                }}
              />
            ))}
            {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
              <div
                key={edge}
                data-testid={`preview-handle-${edge}`}
                style={{
                  position: 'absolute',
                  ...(edge === 'left' ? { left: 0, top: '50%' } : {}),
                  ...(edge === 'right' ? { right: 0, top: '50%' } : {}),
                  ...(edge === 'top' ? { top: 0, left: '50%' } : {}),
                  ...(edge === 'bottom' ? { bottom: 0, left: '50%' } : {}),
                  width: HANDLE_SIZE / 2,
                  height: HANDLE_SIZE / 2,
                  transform: 'translate(-50%, -50%)',
                  background: 'var(--brand)',
                  border: '1px solid var(--surface-app)',
                }}
              />
            ))}
          </div>
        ) : null}
        <video
          ref={reffed}
          src={src}
          muted={muted || !audio}
          playsInline
          crossOrigin="anonymous"
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) setSourceAspect(videoWidth / videoHeight);
          }}
          style={{
            position: 'absolute',
            // The filter goes on the <video> rather than the layer wrapper so it
            // applies to the picture only: a blur on the wrapper would feather the
            // crop's hard edge, which is not what the export does.
            filter: effectFilter || undefined,
            left: `${-(geometry.source.x / geometry.source.width) * 100}%`,
            top: `${-(geometry.source.y / geometry.source.height) * 100}%`,
            width: `${100 / geometry.source.width}%`,
            height: `${100 / geometry.source.height}%`,
            objectFit: 'fill',
          }}
        />
      </div>
    </div>
  );
});
