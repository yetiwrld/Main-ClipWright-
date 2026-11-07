# SPEC 10 — PREVIEW MONITOR AND CANVAS CONTROLS

**Binding.** Follows the structure of `specs/09`. Related: `01` (tokens), `04` (proxies), `08` (layout), `09` (timeline/playhead), `11` (text/captions rendering), `12` (effects, keyframes, audio), `14` (export; shares the compositor).
Code: `/packages/compositor` (rendering, no React), `/apps/desktop/src/renderer/features/preview` (React shell, overlay handles, transport).

---

## 1. PURPOSE

Show the composition **exactly as it will be exported**, let the user manipulate anything **directly** (drag, scale, rotate, crop, edit text) without touching numeric fields, and keep video and audio in sync during playback. The preview is a *faithful* view of the same rendering code that export uses, not a different implementation.

---

## 2. ARCHITECTURE (mandatory structure)

1. **`renderFrame(composition, timeUs, ctx): Frame`** in `/packages/compositor` is the **single source of truth** for what a frame looks like. It is a pure function of `(composition state, time, decoded source frames, assets)`. Preview and export both call it (export in a hidden window, `14`). No visual logic exists outside it.
2. **Renderer:** WebGL2 via PixiJS inside one `<canvas>` sized to the **composition's canvas resolution scaled by preview quality** (§5). Layers are drawn back-to-front by track `order` then item order (`09 §4`). Text, captions, shapes and icons are rendered to textures by the **shared `TextRenderer`** (Chromium's 2D canvas text layout, the same in preview and export) and cached by content+style hash.
3. **Source frames** come from a **`FrameProvider`** abstraction with two implementations: `PreviewFrameProvider` (pooled `<video>` elements on proxies/originals + `requestVideoFrameCallback`) and `ExportFrameProvider` (ffmpeg raw frame decode, `14`). `renderFrame` only sees `FrameProvider.getFrame(itemId, sourceTimeUs)`.
4. **Overlay layer** (transform handles, guides, crop UI, safe areas, text-edit box) is **DOM/SVG above the canvas**, never rendered into the frame, so it can never leak into an export.
5. **Master clock = the audio clock** during playback (§7). The playhead store (`09 §2.4`) is updated from it. Video frames follow the clock; they never drive it.
6. All edits go through **engine commands** (`09 §2.3`); a drag = one transaction, with a **live preview state** applied during the gesture and committed on release (Esc cancels exactly).

---

## 3. LAYOUT OF THE PREVIEW PANEL

Top → bottom inside the preview tile (`08 §3.1`):
1. **Preview toolbar** (32 px): *View* controls (left) and *Canvas tools* (right) — §3.1.
2. **Viewport** (flex): the canvas centred on a `--surface-app` pasteboard, scaled to fit (§4).
3. **Transport bar** (40 px) — §3.2.
The viewport background around the frame is the pasteboard; the **frame** has a 1 px `--line-faint` hairline only when it is lighter than 8% luminance at its edge (so black video is still visibly bounded). No shadow on the frame.

### 3.1 Toolbar
Left: **Zoom** dropdown (*Fit* default, 25 / 50 / 100 / 200 / 400 %, *Fill*), **Preview quality** (*Auto*, *Full*, *Half*, *Quarter*; shows the effective one), **Safe areas** toggle (§9), **Guides/Grid** toggle (§8), **Handles** toggle (show/hide transform handles; `H`).
Right: **Tool** segmented: **Select/Transform** (V) · **Crop** (C) · **Text** (T; click to create text) · **Pan view** (hold Space or H-drag); **Fullscreen preview** (F11 while preview focused / `Ctrl+Shift+F`).
In compact tier, view options collapse into an overflow menu (`01 §9`).

### 3.2 Transport bar
Left→right: **Timecode** (current `HH:MM:SS:FF`, click to edit, `09 §7`), **Go to start** (Home), **Previous frame** (←), **Play/Pause** (Space; 36 px brand-tinted round button), **Next frame** (→), **Go to end** (End), **Loop** toggle (loops the work area or the whole clip), **Playback rate** (0.25×, 0.5×, 1×, 1.5×, 2×; audio muted or pitch-preserved per §7.4), **Volume** (master preview volume; does not affect export) with mute, **Duration** readout. Right: **Level meter** (stereo peak, `12`) and **Fullscreen**. All controls have tooltips with shortcuts; the transport never wraps or overlaps at the minimum preview width (collapses loop/rate into a ⋯ menu below 520 px).

---

## 4. VIEWPORT, SCALING AND COORDINATES

- **Canvas resolution** = composition canvas (e.g. 1080×1920). **Preview scale** = fit factor × zoom. The exported output is determined by the **export settings and canvas**, never by the preview scale or window size (`14`): resizing the window must not change anything but the on-screen scale. A test proves a frame rendered at preview scale 0.25 and at 1.0 differ only by resampling.
- **Coordinate spaces** (document in code comments): *Canvas space* (px, origin top-left, +y down, canvas size), *Item space* (item's local, origin at anchor), *Screen space* (DOM px). All conversions go through one `ViewTransform` with unit tests. Positions stored in items are in **canvas pixels relative to canvas centre** (`x=0,y=0` = centred), scale as multipliers (1 = 100%), rotation in degrees clockwise, anchor in item-relative 0–1.
- **Transform order** (the same matrix order in preview and export): `translate(position) · rotate · scale · translate(−anchor)`, then crop applies **in item space before** transform. Mirror (flip) is a negative scale on the item.
- **Zoom/pan of the view:** mouse wheel with **Ctrl** zooms about the cursor; **Space+drag** or the Hand tool pans; **Fit** (`F`) resets; view zoom/pan is **not saved in the composition** (it is UI state, persisted per project only as a convenience).
- **Pixel-exactness:** when zoom is 100% the canvas is drawn 1:1 with device pixels (`devicePixelRatio` respected); overlays are SVG so they remain crisp at 200% Windows scaling.

---

## 5. PLAYBACK QUALITY AND PERFORMANCE

### 5.1 Preview quality
- **Auto** chooses the internal render scale (1, 0.5, 0.25 of canvas resolution, long side capped at 1920) from the *measured* frame time: if the 30-frame average render+upload exceeds **80% of the frame budget**, step down one level; if under 40% for 3 s, step up. The change takes effect at the next frame; a small chip "Preview ½" appears in the toolbar (never silent).
- The **paused** frame always re-renders at **Full** (or the highest the GPU texture limit allows) after 150 ms of stillness so the user judges the real image.
- Preview uses **proxies** where they exist (`04 §6.3`); originals otherwise with the "Preparing smoother preview…" chip. Switching to the proxy happens at the next seek/play, never mid-frame.

### 5.2 Frame budget and caching
- Target: **30 fps playback at 1080p with 3 video layers + captions** on the reference machine (`00 §3`); 60 fps projects play at best-effort with dropped preview frames (never dropped audio) and a "Preview dropping frames" chip; **export is never affected**.
- **Texture cache** (LRU, GPU memory cap 512 MB or 25% of reported limits): text/caption/shape/icon textures, effect intermediate targets. **Frame provider cache:** ~1 s of decoded frames ahead of the playhead per active video item (`createImageBitmap` from `<video>` frames where possible) with a hard memory cap of 400 MB.
- **Active-set culling:** only items intersecting `[t − 200 ms, t + 1 s]` have decoders/textures; the others are released. A video item that starts in the future is pre-seeked 500 ms before its start.
- Rendering runs on `requestAnimationFrame`; heavy work (waveform, thumbnail) never shares that frame.

### 5.3 Frame accuracy
- Frames for a video item at timeline time `t` come from source time `sourceInUs + (t − startUs)·speed`.
- **Playing:** use `requestVideoFrameCallback` metadata (`mediaTime`) to select the correct frame; do not use `currentTime` polling.
- **Paused/seeking:** seek the `<video>` to the target, wait for `seeked` + `requestVideoFrameCallback`, then verify `|mediaTime − target| ≤ ½ frame` on the proxy (CFR, GOP 15 makes this reliable). If it is off, retry once; if still off, **fall back to a precise ffmpeg still** (`-ss` accurate decode of that frame, cached) and show it (scrub shows the nearest frame immediately, then settles within **150 ms**). The user must never see a black/blank frame while scrubbing (`09` check 3): keep the **last good frame** on screen until the new one is ready.
- Frame stepping (←/→) is exact: always the frame at `playhead ± 1 frame` via the same path.

---

## 6. WHAT THE PREVIEW DRAWS (fidelity contract)

In order, per frame: canvas background (solid colour or blurred/fit-filled main video, `08 §7.2`) → tracks bottom→top → per item: source frame → crop → effects chain (`12`) → transform → opacity/blend → transitions (outgoing/incoming mix, `12`) → keyframed property values at `t`.
Included: all video/image/text/caption/shape/icon items, adjustment layers, transitions, speed changes, opacity, blend modes. **Not** drawn in the frame: handles, guides, safe areas, selection outlines, missing-media badge (a missing item renders as a dark "Media offline" slate with the name in the **preview only**; export refuses, `04 §8`).
**Differences between preview and export are limited to resampling quality and the decoder** (proxy vs original). A **golden-frame test** (§15) renders the same fixture frames in the preview pipeline (hidden window at full quality, original frames) and the export pipeline and requires **SSIM ≥ 0.995** per frame on text/caption/transition/keyframe fixtures.

---

## 7. AUDIO PLAYBACK AND SYNC

1. **Web Audio graph** in the renderer: each audio-bearing item (video with audio, audio items) → decoded **from a derived preview audio file** (`Media/<id>/audio48k_preview.m4a` or the proxy's audio, generated with the proxy) into `AudioBuffer`s chunked by 30 s windows (never the whole file) → `GainNode` (volume/fades/keyframes as scheduled automation: `setValueCurveAtTime` from the **same envelope function** as export, `12 §10`) → pan → track bus → master. Muted/solo/hidden track rules from `09 §9` apply.
2. **Master clock:** `audioContext.currentTime` mapped to timeline time; the playhead store is updated from it each rAF. Video frame selection uses this time. On drift between the video element and the clock > 1.5 frames, **video re-seeks** (never the audio).
3. **Latency compensation:** subtract `outputLatency`/`baseLatency` when available so the visible frame matches what is heard.
4. **Playback rate ≠ 1:** audio is time-stretched (pitch-preserved with a granular/WSOLA stretch, implemented in the preview audio worker; or muted at extreme rates < 0.5× or > 2×, with a tooltip) — documented as preview-only; export uses the exact `atempo` chain.
5. **Scrubbing audio:** short grains (~60 ms) play while dragging the playhead if *Audio scrubbing* is on (default on, Settings → General); off while Ctrl is held.
6. **Sync target:** < 1 frame drift over 5 minutes of playback, measured (§15).

---

## 8. DIRECT MANIPULATION (Select/Transform tool)

### 8.1 Selection in the preview
- **Click** selects the topmost **visible item with non-transparent pixels** under the cursor (alpha hit-test against the item's rendered bounds, with a 4 px tolerance for thin shapes/text); **click again** (or **Alt+click**) cycles through items stacked under the cursor; **click empty** deselects (the main video counts as an item: to select it, click on it; if it fills the canvas use **Alt+click** to reach items beneath overlays, or select from the timeline).
- **Shift/Ctrl+click** adds/removes; **drag a rubber-band** from empty pasteboard or empty canvas space selects every item **fully inside** the box (Alt: any intersecting). Selection is shared with the timeline and inspector (`08`); selecting in one place selects in all, and the timeline scrolls the clip into view when it is off-screen (only if Follow is on).
- Locked-track and hidden-track items cannot be selected in the preview (tooltip on hover explains).

### 8.2 Handles and gestures
Selected item(s) show an **oriented bounding box** (rotated with the item; multi-selection shows an axis-aligned box of the union) with:
| Control | Look | Gesture | Modifiers |
|---|---|---|---|
| **Body** | the box interior | **Drag to move** (X and Y) | **Shift** locks to the dominant axis; **Alt** disables snapping; **arrow keys** nudge 1 canvas px (Shift 10 px) |
| **Corner handles** (4) | 10 px squares, 1 px `--brand` stroke, `--surface-card` fill, hit area 20 px | Scale **uniformly** about the **opposite corner** | **Alt** scales about the **centre**; **Shift** toggles to free (non-uniform) scale |
| **Edge handles** (4) | 10×6 px pills | Scale along one axis (non-uniform); for *text boxes* resize the box width/height (text re-wraps, font size unchanged) | **Alt** about centre; **Shift** uniform |
| **Rotation handle** | 14 px circle 24 px above the top edge | **Rotate through 360°** about the anchor; shows a live angle readout | **Shift** snaps to 15° steps; snapping also at 0/90/180/270 |
| **Anchor point** | small crosshair (only with *Show anchor*, `A`) | Drag to move the anchor without moving the item visually (the engine compensates position) | — |
Cursor icons change per handle (move, nwse-resize rotated to the item angle, rotate). Handle sizes stay constant in screen pixels regardless of preview zoom. Hovering the body shows a 1 px `--brand` hover outline.

### 8.3 Scale by wheel / pinch
**Ctrl+wheel** always zooms the **view** (§4), never the item. Scaling the selected item by wheel is `Alt+wheel` while the pointer is over it (±2% per notch, about the item's centre). Trackpad pinch over the viewport zooms the view; pinch with the item selected and **Alt** held scales the item.

### 8.4 Zoom into the video ("punch-in")
A dedicated **Zoom** slider-and-keyframe affordance lives in the inspector (`08 §7.2`) and as a small floating **Zoom ±** pair next to the selected main video; it scales the item about the **canvas centre** (or the framing focus point). Combined with keyframes (`12`) it creates punch-ins.

### 8.5 Moving a video inside the frame (reframing)
Dragging the **main video** moves it freely, but when the video fully covers the canvas (the common "fill" case) a **cover-lock** option (default **on**, toggle `Ctrl+L`, shown as a lock chip in the toolbar) **prevents the drag from exposing empty canvas**: position is clamped so the video still covers the frame; the status chip says "Fill lock on". Scale below cover is blocked while on. Turning it off allows free placement (letterbox/overlay layouts).

### 8.6 Crop tool (C)
- Entering crop for the selected item shows a **crop rectangle** with 8 handles over the **uncropped** source (dimmed outside), plus an **aspect lock** select (Free, Original, 1:1, 9:16, 16:9, 4:5, Canvas) and **Rounded corners** radius slider in the toolbar. Dragging inside the rectangle **pans the crop**; handles resize it; **Enter** applies, **Esc** cancels.
- Crop values are stored in source-relative fractions (`cropL/T/R/B` 0–1) and are **keyframeable** (`12`). A crop never changes the item's timeline duration.
- **Reframe** (focus point) for videos: in the Crop tool a **"Set framing…"** button lets the user drag the video under a fixed canvas rectangle to set the framing keyframe for this moment (the manual precursor of auto-reframe, `13`).

### 8.7 Direct text editing
- **Double-click** a text item (or press **Enter** with it selected) enters an **in-place editor** (a positioned `contenteditable` with the exact font, size, spacing and wrap of the item, scaled by the view). Esc/click-away commits as **one** transaction; **Ctrl+Z** inside undoes typing steps until commit (editor-local), then the transaction is a single undo entry.
- With the **Text tool (T)**, a click creates a text item at the click with default style; a drag creates a fixed-width text box.
- **Captions** are edited the same way (double-click a caption shows its words); word-level timing is edited in the caption panel/timeline (`11`).

### 8.8 Align and snap in the preview
- **Snap targets** (8 screen px, `Alt` bypasses): canvas centre lines, canvas edges, **safe-area edges**, other items' edges and centres, **equal-spacing** hints (distance guides between three items), rotation at 0/90/180/270, and the **grid** when shown.
- **Guides:** thin `--brand` lines (1 px, sharp) with a small distance label; only while dragging; max 4 lines at once.
- **User guides:** drag from the toolbar's *Guides* menu or `Ctrl`+drag from the viewport edge creates guides (saved with the project, `03`); `Guides` menu: *Add horizontal/vertical*, *Clear*, *Lock*.
- **Grid** overlay: 3×3 thirds (default) or custom N×M; toggle `Ctrl+'`.

### 8.9 Multi-selection
Group box move/scale/rotate scales items about the group's pivot; per-item rotation preserved; **flip**; non-uniform group scale is applied by changing each item's position and scale (skew is never introduced; if an item is rotated and the group scale is non-uniform the gesture is constrained to uniform and the status chip says so).

### 8.10 Transactions and feedback
- During a gesture, the engine applies a **preview patch** each pointer move (rAF-throttled); on **pointerup** the final values are committed as **one command** (`transformItems`), pushed to the undo stack (`09 §24`). **Esc** restores exactly the pre-gesture state. A pointer **down+up without moving** (< 3 px) is a click, never an edit.
- A small **HUD** near the handle shows live values (X, Y, W×H or scale %, angle) in the monospace face.
- With keyframing active (the property has keyframes) a transform edit **writes a keyframe at the playhead** (or updates the existing one), per `12 §2.3`; the HUD shows a diamond. If the property is animated but "Auto-keyframe" is off (default **on** for animated properties), the edit is applied as an **offset to the whole curve** after a one-time confirm.

---

## 9. SAFE AREAS AND OVERLAYS
- **Safe-area overlays** (toggle, `Ctrl+;`): *Title safe* (90%), *Action safe* (93%), and **vertical-platform UI zones** for 9:16/4:5 (top ~14%, bottom ~25%, right ~12% by default as translucent no-go bands) defined in `/assets/safe-areas.json` (data, not code, so values can be tuned; labelled "Approximate — platforms change their UI"). Never drawn into exports.
- **Rule-of-thirds** and **centre cross** options. **Pixel grid** at ≥ 800% zoom.
- Overlays use `--brand` at ≤ 40% opacity lines and dim bands at 12% black. At most one overlay set shows by default (safe areas off by default).

---

## 10. PLAYBACK CONTROL BEHAVIOUR
- **Space** toggles play from anywhere in the editor (when not typing); **J/K/L** shuttle (reverse not required: **J** plays backwards in the preview only at 1× by stepping frames when the source is intra-friendly (proxy); if reverse is unavailable, J steps back 1 s repeatedly and the tooltip says so — document in `docs/limitations.md`).
- **Loop:** loops the work area (`09 §18`), else the whole composition.
- **Play from selection:** `Shift+Space` plays the selected item's range once.
- Reaching the end stops at the last frame (or loops); pressing Play at the end restarts from 0.
- Seeking while playing keeps playing (`09 §28.11`).
- **Fullscreen preview:** shows only the frame and a fading transport; Esc exits.
- Preview audio meter and mute are preview-only.

---

## 11. LINKS
Playhead (`09 §6`), selection (`09 §11`, `08`), inspector values (`08 §7`), keyframes/effects/transitions (`12`), captions/text (`11`), proxies and frame accuracy (`04`), export parity (`14`).

---

## 12. PERFORMANCE TARGETS (reference machine)
- Pointer-to-pixel latency for handle drags ≤ 1 frame (≤ 16 ms) at 1080p with 10 items.
- Seek-to-visible-frame ≤ 100 ms on proxies (`09` check 1); settle to full quality ≤ 150 ms after stopping.
- 30 fps playback sustained for 5 minutes with 3 video layers + captions; no memory growth > 5% over that run (leak test).
- Zero React re-renders of preview panel chrome per playhead tick (only the canvas and timecode update).
- GPU memory stays under the cap; text textures reused (cache hit ratio > 95% during playback of static text).

---

## 13. EDGE CASES
Item fully off-canvas (selectable via timeline; the HUD shows an arrow to bring into view; "Centre on canvas" in the inspector) · scale of 0 (clamped to min 1% / handle hit-areas stay usable for tiny items via a minimum 12 px box) · very large images (downscaled textures, original used at export) · rotated + cropped items (handles follow the cropped, rotated box) · text with missing font (substitute + badge, `11`) · animated GIF import (first frame static in v1, noted) · item with alpha PNG hit-testing · 4K source on a machine with GPU texture limit 4096 (tile or downscale in preview only) · WebGL context lost (auto-recreate textures, resume, toast "Preview was reset") · extremely long captions (truncate preview lines never; wrap per style) · high-DPI monitor mix (moving the window between 100% and 200% monitors re-scales without blur) · two items with identical bounds (cycling click) · aspect ratio change while dragging (cancel the gesture) · preview opened with no media (shows empty canvas with the canvas colour and a hint).

---

## 14. HARDWARE AND FALLBACKS
- **GPU requirement:** WebGL2. If unavailable or blocklisted, fall back to **Canvas2D rendering with reduced effects** (blur/sharpen/blend modes approximated or disabled with a visible banner "Some effects can't be previewed on this computer; export is unaffected"). Export always uses its own hidden window with software GL (SwiftShader/ANGLE) as a last resort (`14`), so output is correct either way.
- Detect and log GPU info; Settings → Performance shows renderer, texture limits and a **Test preview** button.

---

## 15. ACCEPTANCE CHECKS
1. Drag move, corner uniform scale, edge non-uniform scale, rotate 360° (incl. Shift 15° snaps), anchor move, flip, nudge, and Alt-from-centre all behave per §8.2 and are each **one undo step**; Esc cancels exactly; click never edits.
2. Selection: topmost pick with alpha hit-testing, Alt-cycle, rubber-band, multi-select, locked/hidden items not selectable; selection syncs with timeline and inspector.
3. Cover-lock prevents empty canvas on the main video; turning it off allows free placement; chip shows state.
4. Crop tool: handles, pan, aspect lock, rounded corners, apply/cancel; crop values keyframeable; duration unchanged; exported frame matches.
5. Direct text editing: double-click, create with T, in-place typing matches final render; captions editable in place.
6. Snapping/guides/grid/safe areas: 8 px snaps with guides, Alt bypass, user guides persist, overlays never appear in an export (frame diff test).
7. Resize window / change zoom / change quality / change Windows scale: exported dimensions and aspect ratio unaffected (automated, `14`); frame at preview scale 0.25 vs 1.0 differ only by resampling.
8. Frame accuracy: stepping ← → shows exactly the expected frames (burned-in frame-counter fixture); scrubbing never shows black; settle ≤ 150 ms.
9. Playback: 5-minute run keeps A/V drift < 1 frame (measured with a clapper/frame-counter + tone fixture); 30 fps maintained on the reference fixture; auto quality steps down/up with a visible chip.
10. **Golden-frame parity:** preview-pipeline vs export-pipeline frames match **SSIM ≥ 0.995** on fixtures covering text, captions (all 10 presets), shapes, icons, transitions, keyframes, effects, crop, blend modes.
11. Transport: all buttons, timecode entry, loop, rates, volume/mute, meter; Shift+Space plays selection; J/K/L behaviour as §10 (documented limitation recorded).
12. WebGL fallback banner appears when WebGL2 is disabled (forced by a flag) and export still produces correct output.
13. Visual review against `01`: handles, HUD, guides use tokens; no AI-look items; readable at 1280×720 and 200% scaling.
