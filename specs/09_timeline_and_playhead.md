# SPEC 09 — TIMELINE AND PLAYHEAD

**Binding.** This is the model spec: every other spec follows this structure. Read all of it before writing code.
Related: `01` (visual tokens), `08` (editor layout, library, inspector), `10` (preview), `11` (captions), `12` (keyframes/transitions/audio), `14` (export), `03` (persistence).

Sections: 1 Purpose · 2 Architecture · 3 Time model · 4 Data model · 5 Layout · 6 Playhead · 7 Ruler and timecode · 8 Zoom, scroll, pan · 9 Tracks · 10 Clips (visual) · 11 Selection · 12 Editing operations · 13 Overlap and resize policy · 14 Snapping · 15 Drag and drop · 16 Transitions · 17 Keyframes on the timeline · 18 Markers and work area · 19 Waveforms and thumbnails · 20 Captions on the timeline · 21 Context menus · 22 Keyboard shortcuts · 23 Playback · 24 Undo/redo · 25 Persistence · 26 Links to other parts · 27 Performance · 28 Edge cases · 29 Invariants · 30 Acceptance checks.

---

## 1. PURPOSE

The timeline is where the user arranges and trims everything that ends up in the video: video, images, audio, captions, text, graphics and effects. It must feel as direct and predictable as CapCut or Premiere: every drag does what the user expects, nothing is destroyed by surprise, and the **playhead** is the single point of "now" that the whole app agrees on.

---

## 2. ARCHITECTURE (mandatory structure)

1. **`/packages/timeline-engine`** — pure TypeScript, **no React, no DOM, no Electron**. Contains the data model, **commands** (every edit is a pure function `(state, params) → newState | error`), selectors, snapping, ripple/overlap logic, time utilities. 100% unit-testable.
2. **`/apps/desktop/src/renderer/features/timeline`** — React UI. It only: draws state, translates pointer/keyboard input into engine commands, and shows previews of in-progress gestures. **No editing logic in UI components.**
3. **Command pattern.** Each user action = one **transaction** (e.g. an entire drag = one command applied on release, with a live *preview state* during the drag). Each transaction is pushed onto the undo stack (section 24).
4. **The playhead time is NOT React state.** It lives in a small subscribable store (`playheadStore`) read with `useSyncExternalStore`-style subscriptions and updated by a requestAnimationFrame loop. Only these subscribe to it: playhead element, timecode display, preview, caption/transcript highlight, inspector keyframe readouts, meters. **Clips, tracks and the ruler must not re-render on every playhead tick.**
5. Ruler, waveforms and thumbnail strips draw on `<canvas>`. Clips, track headers, handles and markers are absolutely-positioned DOM elements, **virtualised** (only items intersecting the viewport ±1 screen are mounted).

---

## 3. TIME MODEL

- All times are **integers in microseconds (µs)**. Never store or compute with floating-point seconds.
- **Project frame rate** (`project.fps`) is 30 or 60 (default 30). One frame = `1_000_000 / fps` µs (use rational maths: `frameToUs(f) = Math.round(f * 1_000_000 / fps)`; `usToFrame(us) = Math.round(us * fps / 1_000_000)`).
- **Quantisation:** every item start, duration, marker and the playhead is **quantised to the project frame grid** (always snaps to whole frames). Exceptions: source in-points of audio-only items may be sub-frame; keyframe times are frame-quantised.
- Minimum item duration = **1 frame**.
- Timeline start is `0`. No item may start before `0`.
- `projectDuration` = end time of the last item on any visible track (minimum 1 second). It is derived, never stored.
- Timecode format: `HH:MM:SS:FF` (frames, zero-padded; drop-frame not supported). Provide `formatTimecode(us)` and `parseTimecode(text)` in the engine with tests.

---

## 4. DATA MODEL (TypeScript, validated with zod in `project-schema`)

```ts
type Us = number; // integer microseconds

interface Project { id; name; fps: 30|60; canvas: {width; height; aspect: string};
  tracks: Track[]; items: Record<ItemId, Item>; markers: Marker[];
  workArea?: {inUs: Us; outUs: Us}; links: LinkGroup[]; groups: Group[]; }

interface Track {
  id; role: 'main'|'overlay'|'image'|'voiceover'|'music'|'sfx'|'captions'|'text'|'graphics'|'adjustment';
  kind: 'video'|'audio'|'caption'|'text'|'effect';   // what it can hold (see 9.2)
  name: string; order: number;      // visual tracks: higher order = in FRONT in the preview
  hidden: boolean; locked: boolean; muted: boolean; solo: boolean;
  heightPx: number; magnetic?: boolean;  // magnetic only meaningful on the main track
  auto: boolean;                    // auto-created by an overlap bump; removed when it becomes empty
  itemIds: ItemId[];                // sorted by startUs
}

interface ItemBase {
  id; trackId; type: 'video'|'image'|'audio'|'caption'|'text'|'shape'|'icon'|'sticker'|'adjustment';
  startUs: Us; durationUs: Us;      // on the timeline
  label: string; disabled: boolean;
  linkId?: LinkId; groupId?: GroupId;
  keyframes: Record<PropertyPath, Keyframe[]>;  // times are LOCAL (relative to item start)
  effects: EffectInstance[]; transitionIn?: Transition; // transition stored on the later clip of a junction (see 16)
}
interface MediaItem extends ItemBase { // video | image | audio
  mediaId; sourceInUs: Us; speed: number /* 0.1–8, default 1 */; volume: number; // etc.
}
// CaptionItem, TextItem, ShapeItem… defined in specs 11/12; they all extend ItemBase.
```
Timeline duration of a media item = `sourceDuration / speed`. Source range used = `[sourceInUs, sourceInUs + durationUs * speed]` and must lie inside the source media.

---

## 5. LAYOUT

The timeline is the bottom panel of the editor (`specs/08`). Top → bottom:

1. **Timeline toolbar** (36 px).
2. **Ruler row** (28 px): left cell is the header-column corner; right is the **ruler** with markers and the work-area bar.
3. **Track area**: left **header column**, right **canvas area**. Both scroll **vertically together**; the canvas area also scrolls horizontally. Header column and ruler are sticky.
4. **Horizontal scrollbar** and a **vertical scrollbar** (styled per `01`, 10 px wide, visible on hover/scroll, always draggable).

Header column width: 184 px default, resizable 140–280 px (splitter), collapsible to icons-only (48 px) in compact tier.

### 5.1 Toolbar contents (left → right)
Group A *Tools*: **Select** (V), **Razor/Split-at-click** (C), **Hand/pan** (H).
Group B *History*: **Undo** (Ctrl+Z), **Redo** (Ctrl+Shift+Z / Ctrl+Y).
Group C *Edit*: **Split at playhead** (S), **Delete** (Del), **Ripple delete** (Shift+Del), **Duplicate** (Ctrl+D), **Group/Ungroup** (Ctrl+G / Ctrl+Shift+G).
Group D *Modes (toggles)*: **Snapping** (N, on by default), **Magnetic main track** (on by default), **Ripple all tracks** (off), **Linked selection** (on), **Follow playhead** (on). Active toggle = `--brand-tint`.
Group E *Edit mode* segmented: **Normal / Insert / Overwrite** (default Normal; section 13).
Right side: **Add marker** (M), **Track height** (S/M/L menu), **Show waveforms**, **Show keyframes**, **Zoom out**, **zoom slider**, **Zoom in**, **Fit project**.
In compact tier, groups collapse into an overflow menu in the order set in `01 §9`. Play/transport controls live under the preview (`specs/10`), but Space always toggles playback when the timeline or preview has focus.

### 5.2 Default track layout for a new clip project (top → bottom)
`Captions` · `Text/Graphics` · `Overlay video` · **`MAIN VIDEO`** · `Original audio` · `Music` · `SFX`.
Empty tracks the user did not create show as thin drop-hint rows ("Drop here to add a track") so the editor never looks barren.

---

## 6. THE PLAYHEAD

### 6.1 Appearance
- A **2 px vertical line** in `--brand`, spanning the ruler and all tracks, drawn **above all clips**, below menus. Subtle glow `0 0 8px rgba(255,122,0,0.35)`.
- A **head handle** on the ruler: 14 px wide × 16 px tall, rounded-top pentagon pointing down, `--brand`, `--on-brand` tiny frame glyph not required. It is draggable.
- While dragging, a small **timecode bubble** (monospace, `--surface-card`) follows the head above the ruler.
- The line is positioned with `transform: translateX()` (no layout work). It is always sharp (never blurred by fractional pixels: round to the device pixel).

### 6.2 What the playhead is
`currentTimeUs` is the **single source of truth for "now"**. It is always on a frame boundary and always within `[0, projectDuration]` (typing a time beyond the end clamps to the end).
Everything below reads it and nothing else defines "now":
- **Preview** renders the composite at `currentTimeUs`.
- **Transcript panel and caption highlight** follow it.
- **Inspector** shows property values (including keyframe-interpolated values) at it.
- **Audio meters and audio scrubbing** use it.
- **Timecode display** shows it.
- **Edit actions** use it: Split, paste, insert, add marker, add keyframe, trim-to-playhead, "add at playhead" drops.

### 6.3 Moving the playhead (every way)
| Input | Result |
|---|---|
| **Mouse-down on the ruler** | Playhead jumps to that frame **immediately**, then follows the pointer while the button is held (scrub). Snaps (14) unless Alt held. |
| **Drag the head handle** | Same scrub behaviour. |
| **Click on empty track area** | **Deselects only.** Does not move the playhead. (User setting "Click empty timeline area moves playhead", default off.) |
| **Left / Right** | ∓1 frame (auto-repeat when held; hold ≥ 400 ms accelerates to 5 frames per repeat). |
| **Shift+Left / Right** | ∓1 second (rounded to frame). |
| **Up / Down** | Previous / next **edit point** (any item start or end on any unlocked, visible track). |
| **Ctrl+Left / Right** | Previous / next **marker**. |
| **Home / End** | Start of timeline / end of project. |
| **Click timecode, type, Enter** | Jump to typed time (see 7.2). |
| **Click a word in the transcript / a caption / a moment boundary link** | Jump to that time; the timeline scrolls so the playhead is visible. |
| **Mouse wheel on ruler with Ctrl** | Zoom (8.2), playhead unchanged. |
| **During playback** | Advances in real time (23). |

### 6.4 Scrubbing rules
- Preview updates to the frame at the pointer. Update at most once per animation frame; coalesce pointer events.
- **Never show a black or blank preview while scrubbing.** If the requested frame is not decoded yet, keep showing the last good frame (and, if proxies exist, decode from the proxy; fall back to nearest keyframe frame and refine).
- **Audio scrubbing** (toggle, default on): plays a short (~60 ms) snippet at the playhead while dragging. Muted tracks and hidden tracks are excluded.
- Scrubbing past the visible edge of the track area **auto-scrolls** horizontally (edge zone 48 px, speed ramps with distance from the edge, up to ~1200 px/s).
- Scrubbing pauses playback while the button is down; if playback was running, it resumes on release at the new position.

### 6.5 Playhead and zoom/scroll
- **Zooming never changes `currentTimeUs`.** After a zoom, the playhead must remain visible if it was visible before (zoom anchors per 8.2).
- **Follow playhead** (toolbar toggle, default on), during playback only:
  - *Page-flip mode (default):* when the playhead reaches 90% of the visible width, scroll so it sits at 10%. Smooth scroll over 150 ms is permitted (the one animation allowed in the timeline).
  - If the user **manually scrolls** during playback, follow pauses until playback is stopped and restarted or the user presses the Follow toggle.
- Window resize keeps the playhead's time visible.

### 6.6 Playhead snapping and boundaries
- While scrubbing/dragging, snaps to snap targets (14) within 8 screen px. Holding **Alt** bypasses snapping.
- Hard clamp at `0`. Dragging past the project end is allowed up to `projectDuration` only.
- At the end of the project, playback stops with the playhead on the final frame (or loops if loop is on and a work area exists, see 18).

---

## 7. RULER AND TIMECODE

### 7.1 Ruler
- Draws time ticks and labels on canvas. **Readable at every zoom level.**
- Tick algorithm: candidate major intervals (seconds): `[1f, 2f, 5f, 10f]` (f = 1/fps) then `[0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]`. Choose the **smallest** interval whose on-screen width ≥ **80 px**. Minor ticks: subdivide the major into 5 (or 4 for 1/2/15/30/60-style intervals so ticks land on round values), drawn at ≥ 8 px apart (drop minors that would be closer).
- Label formats: below 1 s interval → `SS:FF`; below 1 min → `MM:SS`; otherwise `H:MM:SS`. Labels never overlap (skip when too tight).
- Colours: ticks `--line-default`, labels `--text-muted` `--fs-xs`.
- The ruler shows: markers (flags), the work-area bar (thin brand-tint band with draggable ends), and the playhead head.

### 7.2 Timecode display and entry
- A **timecode field** (monospace) appears left of the ruler corner and under the preview, both bound to `currentTimeUs`. Format `HH:MM:SS:FF`, plus total duration in muted text (`/ 00:01:12:10`).
- **Click** (or F2) → editable. Accepts: `HH:MM:SS:FF`; `MM:SS` (so `1:30` = 1 minute 30 seconds); a bare number of seconds such as `90`; digits-only entry without separators such as `130`, read with the usual editing-software rule (last two digits = frames, the two before = seconds, the two before that = minutes, so `130` = 1 second 30 frames); or `+30` / `-12` (relative frames). **Enter** commits, **Esc** cancels; invalid input shakes the field (opacity pulse, no motion) and keeps the old value. Clamp to `[0, projectDuration]`.

---

## 8. ZOOM, SCROLL, PAN

### 8.1 Zoom model
- Zoom is `pxPerSecond` (px per second). Range: min = whatever makes **3 hours** fit the viewport (floor 0.25 px/s); max = **one frame = 32 px** (e.g. 960 px/s at 30 fps).
- Zoom changes are exponential (multiply), so each step feels the same.

### 8.2 Inputs and anchors
| Input | Action | Anchor (point that stays still) |
|---|---|---|
| **Ctrl + mouse wheel** | zoom, ×1.1 per notch (continuous for smooth wheels) | **mouse position** |
| **Trackpad pinch** (wheel with ctrlKey) | zoom | pointer position |
| **Ctrl + `=` / Ctrl + `-`**, toolbar buttons, slider | zoom ×1.25 / ÷1.25 | **playhead if visible, otherwise viewport centre** |
| **Ctrl + 0** / toolbar *Fit project* | fit the whole project in the viewport with 24 px margin | — |
| **Ctrl + Shift + 0** | fit the **selection** (min zoom clamp applies) | — |
| **Alt + wheel** | vertical zoom = track height cycle (S/M/L) | — |

After any zoom the scroll offset is recalculated so the anchor stays under the same screen position. Zooming does not change selection or the playhead.

### 8.3 Scroll and pan
| Input | Action |
|---|---|
| Wheel | scroll tracks **vertically** |
| **Shift + wheel** | scroll **horizontally** |
| Trackpad two-finger | scrolls both axes natively |
| **Middle-mouse drag**, or **Hand tool (H)** drag | pan both axes |
| Scrollbars | drag, click-to-jump |
| `PageUp/PageDown` (timeline focused) | scroll horizontally by one viewport |
- Smooth: apply scroll in the same animation frame as input; no easing lag.
- Scroll is clamped: horizontal to `[0, projectDuration + 20% viewport]`, vertical to track content.
- Scroll and zoom are persisted per project (25).

---

## 9. TRACKS

### 9.1 Header controls (per track)
Left to right: **drag handle** (reorder), **role icon**, **name** (double-click or F2 to rename; truncates with tooltip), then icon buttons (visible on hover, always visible if toggled on): **Eye** (hide), **Speaker** (mute, audio-capable tracks), **Solo** (S-icon; audio), **Lock**.
- **Hidden:** items are not drawn in the preview and **not exported**; they remain on the timeline at 40% opacity.
- **Muted:** audio of that track is excluded from preview and export. Muting a video track mutes its embedded audio.
- **Solo:** while any track is soloed, only soloed audio tracks are heard (in preview and export).
- **Locked:** items cannot be selected, moved, trimmed or deleted, are drawn with a faint diagonal hatch, and are skipped by playhead-wide operations (split-all, ripple). Locked items still act as **snap targets**.
- Track height: drag the bottom border (min 28, max 160 px), or toolbar presets S 32 / M 48 / L 72. Defaults: main 64, others by role: audio 44, captions 32, text/graphics 32, overlay 48.
- Header **context menu:** Rename · Add track above/below (submenu by kind) · Move up/down · Duplicate track (with items) · Hide/Show · Mute · Lock · Delete track (confirm if it has items; undoable).

### 9.2 What each track kind holds
| Track kind | Accepts item types |
|---|---|
| `video` (roles main, overlay, image) | video, image |
| `audio` (voiceover, music, sfx, original audio) | audio |
| `caption` | caption |
| `text` (roles text, graphics) | text, shape, icon, sticker |
| `effect` (adjustment) | adjustment |
Dropping an incompatible item on a track is refused (cursor `not-allowed`, tooltip names the reason). Dropping on the **empty area below all tracks**, or on a "Drop here to add a track" row, creates a **new track of the right kind**.

### 9.3 Z-order
For visual tracks, **higher in the stack = in front** in the preview and export. Reordering tracks by drag changes z-order immediately in the preview. Audio track order has no effect on sound.

### 9.4 The main track
- Exactly one track has role `main`. It cannot be deleted (it may be emptied) and always stays the **bottom-most visual track** unless the user explicitly reorders.
- **Magnetic main track** (toolbar toggle, default **on**): clips on the main track are always packed end to end with **no gaps**. Deleting, trimming shorter, or moving a main-track clip away closes the gap automatically; dropping a clip onto the main track inserts and ripples (see 13). With magnetic **off**, the main track behaves like any track.
- The first clip placed on an empty main track defines the project canvas suggestion only if the project has no canvas yet (normally the canvas is already set by the start page).

### 9.5 Auto tracks
When an operation would overlap items on a non-main track (13), the engine creates a new track of the same kind directly above (visual) or below (audio) with `auto: true` and moves the item there. An `auto` track that becomes empty is **removed automatically** (undoable). A user rename or any manual item drop onto it clears `auto`.

Soft limits: 64 tracks per project; show a clear message at the limit.

### 9.6 Linked audio
A video item with an audio stream keeps its audio **embedded** (waveform drawn inside the clip when "Show waveforms" is on). **Detach audio** (context menu) creates a linked audio item on an audio track at the same time range and mutes the video's embedded audio. Linked items share a `linkId`; with **Linked selection** on, moving, trimming, splitting, deleting and speed changes apply to both together. Hold **Ctrl+Alt** while clicking to select only one. **Unlink** removes the link.

---

## 10. CLIP APPEARANCE

- Rounded `--radius-clip` (5 px). Fill = track role colour at 85% (selected: 100% + 2 px `--brand` outline inset). Text label `--fs-xs` in white-ish, clipped with ellipsis, sticky to the visible left edge of the clip while scrolling.
- **Video/image:** thumbnail filmstrip (tile width = track height × 16/9; fewer tiles when zoomed out). **Audio** (and video with "Show waveforms"): waveform drawn in lighter tint along the clip bottom (video) or centred (audio). **Text/caption:** the text itself.
- Overlays (all small, within the clip): **speed badge** (`1.5×`) when speed ≠ 1; **fx badge** when effects exist; **mute/volume icon** when clip volume is 0; **keyframe diamonds** row (17); **disabled** = 40% opacity with strike pattern; **missing media** = red-tinted with warning icon and tooltip "Original file not found — Relink"; **proxy generating** = soft shimmer along the bottom edge; **locked** = diagonal hatch.
- Hover: lift fill to 100%, show **trim handles** (3 px light bars) at both edges. Handles hit zone = **min(8 px, 30% of clip width)** each side.
- Clips narrower than 4 px draw as a plain 4 px bar; narrower than 24 px hide labels and badges.
- Duration/time tooltip on hover (400 ms): name, duration, start–end.

---

## 11. SELECTION

| Input | Result |
|---|---|
| Click item | select only it (and its linked/grouped members) |
| **Ctrl+click** | toggle item in selection |
| **Shift+click** | range select on that track from the last selected item |
| **Drag on empty area** | **marquee** rectangle (selects items it touches, all unlocked tracks); hold Shift to add |
| **Ctrl+A** | select all unlocked items |
| **Esc** | clear selection (also cancels an in-progress drag, 15) |
| Click empty area | clear selection |
| **Alt+Up/Down** (timeline focused, nothing being dragged) | **move selected item(s) to the track above/below** |
| Tab / Shift+Tab | select next/previous item on the track (keyboard users) |
- Selected items: 2 px `--brand` outline, full-opacity fill. Group selection draws one dashed bounding box.
- **Sync:** selecting in the timeline selects in the preview (transform handles) and shows the inspector. Selecting in the preview selects in the timeline and **scrolls it into view without moving the playhead**.
- Selection survives zoom, scroll, and undo/redo of unrelated actions. After undo/redo, items affected by the action become selected.
- Locked or hidden-track items cannot be selected by marquee or Ctrl+A.

---

## 12. EDITING OPERATIONS

All operations: act on the selection; if the selection is empty and the operation says so, act on defaults; respect locked tracks (never edit them); update undo stack as **one** transaction; show a toast with **Undo** for destructive ones (delete, ripple delete, paste-overwrite).

| Operation | Shortcut | Behaviour |
|---|---|---|
| **Split** | **S** (also Ctrl+B) | Splits selected items at the playhead. If **nothing is selected**, splits **every unlocked, visible item** under the playhead. Items where the playhead is within 1 frame of an edge are skipped. Both halves keep all properties; the right half gets a new id. **Keyframes** are split with interpolated boundary keyframes inserted on both sides so animation is continuous. A transition on the cut stays attached to the correct neighbour. Linked partners split together. **Caption** items split at the **nearest word boundary** to the playhead. |
| **Razor tool** | C (then click) | Clicking a clip splits it at the clicked time (snapped to frames; snapping on). Tool remains active until V is pressed. |
| **Delete** | Del / Backspace | Removes selected items, leaving a gap. On the main track with Magnetic on, the gap closes (main-track items after it shift left). |
| **Ripple delete** | Shift+Del | Removes selected items and shifts later items on the **same track(s) (and linked partners)** left by the removed duration. With **Ripple all tracks** on, shifts every unlocked track. |
| **Cut / Copy / Paste** | Ctrl+X / C / V | Copy stores items with relative offsets, relative track offsets and keyframes (in a clipboard that also survives between projects in the same session). Paste puts the **earliest item at the playhead**, on the same track as the original if still valid, otherwise the first compatible track; relative layout is preserved. If the destination overlaps existing items, the Overlap policy (13) applies. Cut = copy + delete. |
| **Paste attributes** | Ctrl+Shift+V | Applies copied effects/transform/caption style/keyframes to the selected items. |
| **Duplicate** | Ctrl+D | Places a copy immediately after the original on the same track (or, if blocked, per Overlap policy). Selection moves to the copy. |
| **Trim** | drag edge | Changes the item's start (left edge) or end (right edge). **Cannot extend past the source media** for video/audio; image, text, caption (within word bounds), shape, icon, sticker, adjustment can extend freely. Live tooltip shows delta and new duration. During the drag, the **preview shows the frame at the dragged edge**. |
| **Trim start/end to playhead** | **Q** / **W** | Trims the selected item's start/end to the playhead (no gap closing). **Shift+Q / Shift+W**: ripple version (closes the gap). |
| **Ripple trim** | Shift+drag edge | Trim and shift later items on that track by the same amount. |
| **Rolling edit** | Ctrl+drag at a junction between two adjacent clips | Moves the cut point; the left clip's end and right clip's start change by the same amount; total span unchanged; limited by available source on both sides. |
| **Move** | drag body | See 15. Arrow nudge: **Alt+Left/Right** ±1 frame, **Alt+Shift+Left/Right** ±10 frames. |
| **Extend / shorten** | trim, speed, inspector duration | Governed by the Resize policy (13). |
| **Replace** | context menu *Replace clip…* | Swaps the source media, keeps position, duration (clamped to the new source) and effects. A library asset's context menu also offers *Replace selected clip*. |
| **Group / Ungroup** | Ctrl+G / Ctrl+Shift+G | Group = move/trim/split/delete together; may span tracks; selecting any member selects the group; double-click to select inside. A group cannot move if any member sits on a locked track. |
| **Freeze frame, Reverse** | context menu | v1 stretch (see `13`); not required in Phase 4. |
| **Speed** | context menu / inspector | Changes `speed` (0.1–8×). Duration changes by Resize policy. Audio pitch preserved up to 2× (stretch), beyond that allowed with pitch artefacts and a warning. |
| **Enable/Disable clip** | context menu | `disabled` items are skipped in preview and export. |
| **Split to detach audio** | context menu | See 9.6. |

---

## 13. OVERLAP AND RESIZE POLICY (this is what "never destroy anything by surprise" means)

### 13.1 Invariant
**Items on the same track never overlap.** The engine rejects any state where they do.

### 13.2 Edit modes (toolbar segmented control, applies to drops, pastes and moves)
| Mode | When the target span is occupied |
|---|---|
| **Normal** (default) | **Bump:** on non-main tracks, create/choose the nearest auto track (9.5) and put the item there. On the **main track**: if Magnetic is on, behaves as **Insert**; if off, the item is **clamped** to the nearest free gap or bumped to an overlay track if no gap is large enough (with a toast saying so). |
| **Insert** | Items at/after the insert point on that track (and linked partners) shift right by the item's duration. If the drop lands **inside** a clip, that clip is split at the drop point first. |
| **Overwrite** | The occupied span is replaced: items fully covered are removed, partially covered items are **trimmed** (never lost beyond the covered span). A toast with **Undo** appears. Preview shows the doomed span tinted `--error-tint`. |
Temporary overrides **while dragging**: hold **Ctrl** = Insert, hold **Shift** = Overwrite. Release before drop to cancel the override.

### 13.3 Resize policy (trim extend, speed slow-down, duration field)
- **Shortening** never affects neighbours (a gap appears; on a magnetic main track it closes).
- **Extending** is **clamped at the next item** on the same track and shows a "Blocked by next clip" tooltip. It never overwrites and never silently pushes others.
- With **Ripple** (Shift-drag, ripple trim, or Ripple all tracks) extending pushes later items right. Locked tracks never move: if a ripple would push an item on a locked track, the ripple is refused with a message.
- **Clamps:** minimum 1 frame; start ≥ 0; video/audio end ≤ source end.

### 13.4 Ripple rules
Ripple operations shift later items on the **affected tracks**: the track(s) of the edited item(s), plus the tracks of their linked partners. **Ripple all tracks** (off by default) adds every unlocked track. Locked tracks never shift. Shifts preserve relative spacing. A ripple that would move something below 0 is clamped.

---

## 14. SNAPPING

- Toggle **N**; default on. Hold **Alt** to bypass while dragging.
- **Snap targets:** playhead; start and end of every item on every track (including locked and hidden); markers; work-area in/out; timeline start (0); project end; caption word boundaries (only when 1 frame ≥ 8 px).
- **Threshold:** **8 screen px** regardless of zoom. Nearest target wins.
- **Source edges when moving:** the moved selection's **leading and trailing edges** (for multi-selection, the group's extreme edges and every item's edges) are all candidates.
- **Feedback:** a 1 px `--brand` vertical guide line spanning the whole track area at the snapped time, plus a small label with the timecode near the ruler. The snap is **hard** (no easing).
- Snapping applies to: playhead scrub, clip move, trim, marker drag, keyframe diamond drag, razor tool, transition edges, work-area ends.

---

## 15. DRAG AND DROP

### 15.1 Sources
Media library assets (video, image, audio, text assets, graphics, icons, stickers) · effects/transitions/caption-style/animation presets from their panels · files dragged from Windows Explorer onto the timeline (imports per the user's copy/reference setting, then places) · items already on the timeline.

### 15.2 Gesture rules (prevent accidental edits)
- **Drag threshold: 4 px** of movement before any drag begins. A click never moves anything.
- Pointer-down zones on a clip: **edge zones** (10.2) = trim; **body** = move; **ruler/empty** = see 6 and 11. Use **pointer capture** so drags continue outside the window.
- **Esc** during a drag cancels it and restores the original state.
- Dragging **continues** during playback (playhead keeps running).
- Auto-scroll: when the pointer is within 48 px of a track-area edge during a drag, scroll that direction (speed ramps up to ~1200 px/s horizontally, ~600 px/s vertically).

### 15.3 Feedback
- A **ghost** at the real size and position of the dragged item(s), semi-transparent.
- A **drop indicator**: the resulting span outlined on the target track (valid = `--brand`, invalid = `--error`), plus the snap guide (14). In Insert mode, a vertical insertion line with shifted items previewed. In Overwrite mode, covered span tinted.
- Invalid target: cursor `not-allowed` and a tooltip with the reason ("Audio can't go on a video track").
- Live readout near the pointer: new start time and track name.

### 15.4 Multi-item and cross-track moves
All selected items move together preserving **relative time offsets and relative track offsets**. If any item has no compatible track at the target offset, the vertical move clamps to the nearest valid offset for the whole selection. A selection that includes locked-track items cannot be moved (the locked items are excluded from the selection at gesture start, with a toast).

### 15.5 Dropping new items
- Dropping on a track: start = drop time (snapped), per edit mode (13.2).
- Dropping **on a clip's junction** with a transition preset: attaches the transition (16).
- Dropping a transition, effect, animation or caption style **onto an item** applies it to that item.
- Dropping on the empty area below tracks: creates a new compatible track.
- Dropping a video onto the **main track** when empty: sets the first clip; if the aspect ratio differs from the canvas, uses "fit to canvas" (user can change in the inspector).

---

## 16. TRANSITIONS

- A transition lives **at a junction** between two adjacent items on the same `video`-kind track. It is stored on the **later** item as `transitionIn {type, durationUs, alignment}`.
- Appearance: a small rounded handle (20×20 px minimum, `--surface-card` with icon) centred on the junction; selecting it shows its extent as a translucent band over both clips.
- Valid junctions highlight while a transition is being dragged from the effects panel.
- **Duration:** default 0.5 s (15 frames at 30 fps), minimum 2 frames, maximum = `min(available source "handle" after left clip's end, handle before right clip's start)`. If no handles exist (the clips use the full source), only the *Fade to/from black* and *Dip* types are offered, as they need no extra media.
- **Alignment:** *Centred on cut* (default), *Starts at cut*, *Ends at cut*; changeable in the inspector or by dragging the band edges.
- Drag the band's left/right edge to change duration; drag the junction handle to change alignment; **snaps** per 14.
- Moving, trimming, or deleting a clip keeps or removes its transitions logically: deleting a clip removes transitions at its junctions; trimming a clip clamps its transition to the new handles.
- Transitions never change the total timeline length: they overlap the two clips' visible regions using source handles, not by shifting clips.

---

## 17. KEYFRAMES ON THE TIMELINE

(Interpolation maths and property list: `specs/12`.)
- A clip with keyframes shows **diamond markers** in a thin lane at its bottom when it is selected or "Show keyframes" is on. Expanding the **track header chevron** reveals **per-property sub-lanes** (Position, Scale, Rotation, Opacity, Volume, Crop, …) with their own diamonds.
- Keyframe times are stored **local to the item**. Moving an item moves its keyframes with it. Trimming the item's start shifts local times by the trim amount; keyframes pushed outside the item range are **kept but inactive** (the value at the clip boundary is computed from the interpolation as if they existed).
- **Diamond interactions:** click selects; drag moves horizontally (frame-quantised, snapped to playhead/other keyframes); **Delete** removes; **double-click** opens the easing popover (Linear, Ease in, Ease out, Ease in-out, custom curve in `12`); **Ctrl+C/V** copies/pastes selected keyframes at the playhead; **right-click** menu: Delete, Duplicate, Easing…, Copy.
- **Add keyframe at playhead:** inspector stopwatch/diamond button, or **K** with a property focused. Value edits on a keyframed property at a time without a keyframe **auto-create** a keyframe if *Auto-keyframe* is on (default on once a property has ≥ 1 keyframe).

---

## 18. MARKERS AND WORK AREA

- **M** adds a marker at the playhead (default colour `--brand-amber`; palette of 6). A marker has an optional name and note. Draw: small flag on the ruler plus a faint (1 px, 20% opacity) vertical line through the tracks when "Show markers" is on.
- Double-click a marker to edit name/note/colour. Drag to move (snaps). **Delete** removes the selected marker. Markers are snap targets and **Ctrl+Left/Right** jumps between them.
- **Work area:** **I** sets the in point and **O** the out point at the playhead (also draggable on the ruler); **Alt+X** clears them. Used for: **loop playback** (when the Loop toggle in the transport is on) and **export range** ("Export work area only", `specs/14`). A thin brand-tint band on the ruler shows the range.
- Clips created from moments get automatic markers at the **original moment start and end** (named "Moment start/end").

---

## 19. WAVEFORMS AND THUMBNAILS

- Generated **asynchronously** in a background worker from the **proxy** (or source if no proxy). Cached on disk in the project cache and reused across sessions.
- **Waveform peaks:** store two resolutions (e.g. 256 and 4096 samples per peak window); choose by zoom. Draw min/max pairs on canvas. While not ready, show a skeleton shimmer, never an empty clip.
- **Thumbnails:** one per filmstrip tile, at the source time of the tile's centre; cache key `(mediaId, sourceTimeMs, tileHeight)`; LRU memory cap 200 MB; draw placeholder (clip colour) until ready; request visible tiles first.
- Generation never blocks the UI. Cancelled when the item leaves the viewport and was not started.

---

## 20. CAPTIONS ON THE TIMELINE

(Content and styling: `specs/11`.)
- Caption items live on `caption` tracks and are **segments** (a few words or a sentence, with per-word timing inside).
- They obey selection, trim, split, move and snapping like other items, plus:
  - **Move:** the segment moves and **all its word times move with it**.
  - **Trim:** changes the segment's start/end but **snaps to word boundaries** (never cuts inside a word); words outside the new range are removed from this segment only (undoable) — never silently deleted without the toast-with-Undo.
  - **Split** at the nearest word boundary (12). **Merge** (context menu / Ctrl+J on two adjacent selected segments) joins them.
  - Word boundaries show as thin ticks inside the segment when 1 frame ≥ 8 px.
- Captions on one track never overlap (13).
- When the underlying clip is trimmed/split/moved, linked captions follow if "Captions follow clip" is on (default on): they share the clip's `linkId`.

---

## 21. CONTEXT MENUS (all via the shared ContextMenu component)

**On a clip:** Cut · Copy · Paste · Paste attributes · Duplicate · Delete · Ripple delete · Split at playhead · Detach audio · Unlink · Group/Ungroup · Speed… · Enable/Disable · Replace clip… · Reveal in media library · Properties (focuses the inspector). Disabled items remain visible with a tooltip explaining why.
**On a track header:** see 9.1.
**On empty track area:** Paste · Add marker here · Add track.
**On the ruler:** Add marker · Set work-area in/out · Clear work area · Fit project.
**On a transition handle:** Duration… · Alignment · Replace transition · Delete.
**On a marker / keyframe:** see 17, 18.

---

## 22. KEYBOARD SHORTCUTS (defaults; all remappable in Settings)

| Key | Action | Key | Action |
|---|---|---|---|
| Space | Play/Pause | S | Split |
| J / K / L | Slow down / Pause / Faster (1×, 2×, 4× forward only) | Q / W | Trim start / end to playhead |
| ← / → | ∓1 frame | Shift+Q / Shift+W | Ripple trim to playhead |
| Shift+← / → | ∓1 second | Del | Delete |
| ↑ / ↓ | Prev / next edit point | Shift+Del | Ripple delete |
| Ctrl+← / → | Prev / next marker | Ctrl+C / X / V | Copy / Cut / Paste |
| Home / End | Start / end | Ctrl+Shift+V | Paste attributes |
| M | Add marker | Ctrl+D | Duplicate |
| I / O | In / Out | Ctrl+G / Ctrl+Shift+G | Group / Ungroup |
| Alt+X | Clear in/out | Ctrl+J | Merge captions |
| V / C / H | Select / Razor / Hand | N | Toggle snapping |
| Ctrl+= / Ctrl+- | Zoom in / out | Ctrl+0 / Ctrl+Shift+0 | Fit project / selection |
| Ctrl+A | Select all | Esc | Deselect / cancel drag |
| Alt+← / → | Nudge ±1 frame | Alt+Shift+← / → | Nudge ±10 frames |
| Alt+↑ / ↓ | Move to track above/below | Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) | Undo / Redo |
| K (with property focused) | Add keyframe | F2 | Rename |
Shortcuts only fire when no text field is focused. A shortcuts cheat sheet (Ctrl+/) lists them. Conflicts are detected in Settings.

---

## 23. PLAYBACK

- **Space** toggles. Playback starts at `currentTimeUs`. At the end (or work-area out when Loop is on) it stops (or loops).
- **Master clock:** when any audio plays, the **audio output position is the clock**; the playhead derives from it so video never drifts from audio. With no audio, use a monotonic high-resolution timer. The preview renders the frame for the clock time; if frames can't keep up it **drops frames, never slows audio**.
- **Playback rate** (preview-only, set in the transport under the preview): 0.5×, 1×, 1.5×, 2×. Audio is time-stretched to preserve pitch up to 2×. Rates do not change the project.
- The playhead UI updates once per animation frame; the engine state is not touched.
- **Editing during playback is allowed**: operations use the playhead's current frame at the moment of the command. Starting a drag does not pause playback.
- Preview uses proxies by default; "Use original media in preview" toggle in Performance settings.

---

## 24. UNDO / REDO

- Every transaction is one undo step (a drag = one step; a paste = one step; split-all = one step; an auto-track removal is part of the step that caused it).
- Stack depth ≥ 200 steps per project session. Playhead, zoom, scroll and panel layout are **not** undoable.
- Undo/redo are available while playing and during idle. They are blocked only while a drag is in progress.
- Commands are pure; undo uses inverse patches (store immer patches) so memory stays small.
- After undo/redo, affected items are selected and scrolled into view if off-screen.

---

## 25. PERSISTENCE

Saved in the project (`specs/03`): tracks (including heights, lock/hide/mute/solo, `auto`), items with all properties and keyframes, markers, work area, groups and links, edit-mode and toggles (snapping, magnetic, ripple-all, linked selection, follow, edit mode), view state (zoom, scroll position, header width, track heights), and the **playhead time**. Reopening restores everything exactly.
- Autosave is **debounced 2 s after the last command**, runs off the UI thread in a single database transaction, and **never blocks interaction**. A "Saved" / "Saving…" indicator shows state.
- A crash must lose at most the last 2 seconds of edits (recovery checkpoints in `specs/03`).

---

## 26. LINKS TO OTHER PARTS

| Part | Reads from timeline | Writes to timeline |
|---|---|---|
| Preview (`10`) | playhead, items, transforms | selection, transform edits (via commands) |
| Inspector (`08`) | selection, playhead | property edits, keyframes (via commands) |
| Media library (`08`) | drop targets | usage counts; "in use" warning before removing media |
| Captions (`11`) | caption items, playhead | caption edits (via commands) |
| Transcript panel (`05`) | playhead | seek requests |
| Export (`14`) | visible items, mutes, work area | none |
| Moments (`07`) | — | initial clip layout, moment markers |
| Persistence (`03`) | everything | restore |
All writes go through **engine commands**; no module mutates timeline state directly.

---

## 27. PERFORMANCE TARGETS (reference machine, `00` §3)

- Scrubbing and zoom/scroll interaction: **≥ 55 fps** with 500 visible items and 10 tracks.
- Project with **2,000 items**: opens in under 2 s and stays interactive.
- Any command on ≤ 100 items completes in **< 50 ms**; undo/redo < 50 ms.
- Playhead movement during playback causes **zero React re-renders** of clips, tracks and ruler.
- Memory: thumbnail LRU 200 MB cap; waveform peaks held per visible media only.
- Hit-testing and snapping use a **sorted index / interval structure** (not linear scans) once items > 200.

---

## 28. EDGE CASES (each must have defined, tested behaviour)

1. **Empty timeline:** shows the default track layout and a friendly empty state ("Drag media here or use the Media panel"); Play does nothing; Fit project does nothing.
2. **Very long media (3 h):** zoom range still works; thumbnails/waveforms generate lazily; no UI stall.
3. **Zero-length results:** any operation producing an item < 1 frame is refused (trim) or removes it with Undo toast (overwrite trim).
4. **Negative start:** movement clamps to 0 (on a magnetic main track, ripples).
5. **Missing source media:** clip stays, drawn as missing; playback shows a "media offline" frame; export refuses with a clear message listing the missing items; Relink flow from the clip menu.
6. **Variable-frame-rate sources:** placed at nearest frame; the inspector shows a VFR note; proxies are made constant-frame-rate.
7. **No audio stream:** no waveform; mute controls disabled for that clip with tooltip.
8. **Window resized:** layout tier changes keep playhead visible and selection intact; toolbar groups collapse per `01`.
9. **Track count at limit (64):** message, no crash.
10. **Locked track in a ripple or group move:** refused with message; nothing moves.
11. **Drag while playing:** allowed; preview keeps playing.
12. **Dropping a file that fails to import:** non-blocking toast with reason; timeline unchanged.
13. **Speed change that would overlap next clip:** clamped per 13.3 with tooltip.
14. **Transition with no handles:** only fade/dip types offered (16).
15. **Undo after autosave / after app minimise:** works; undo history persists for the session.
16. **Deleting a track with linked items:** link partners on other tracks are unlinked, not deleted.
17. **Pasting across projects:** items referencing media not in the destination project are imported/linked per the copy/reference setting, or the paste is refused with a message.
18. **Time entry beyond end:** clamp to end.

---

## 29. INVARIANTS (assert in engine; unit-test with property-based tests)

1. Items on a track never overlap.
2. All `startUs`/`durationUs` are integers aligned to the frame grid (audio source offsets excepted).
3. `durationUs ≥ 1 frame`; `startUs ≥ 0`.
4. For media items, `[sourceInUs, sourceInUs + durationUs·speed] ⊆ [0, sourceDurationUs]`.
5. `track.itemIds` is sorted by `startUs` and matches each item's `trackId`.
6. Exactly one `main` track exists.
7. Every `linkId`/`groupId` references ≥ 2 members (otherwise the id is cleared).
8. Visual track `order` values are unique; locked tracks' items are byte-identical before/after any operation that must not touch them.
9. `transitionIn.durationUs` ≤ available handles on both sides.
10. Applying a command then its inverse yields the original state (round-trip test for every command).

---

## 30. ACCEPTANCE CHECKS (record each result in `docs/verification.md`)

**Playhead**
1. Clicking the ruler at any zoom places the playhead on the nearest frame and the preview shows that frame within 100 ms.
2. Dragging the head scrubs smoothly; releasing leaves it on a frame boundary; Alt disables snapping.
3. Scrubbing never shows a black/blank preview frame.
4. Left/Right move exactly 1 frame; Shift+Left/Right 1 second; Up/Down jump between edit points; Ctrl+Left/Right between markers; Home/End work.
5. Timecode entry accepts all documented formats and clamps correctly.
6. During playback, audio and video stay in sync (< 1 frame drift over 5 minutes, measured), and the playhead causes no clip re-renders (React profiler assertion).
7. Follow-playhead page-flips at 90%; manual scroll pauses following.
8. Zooming (wheel, keys, buttons, slider, fit) never changes the playhead time and keeps the anchor point still.

**Tracks and clips**
9. Create, rename, reorder, hide, lock, mute, solo and delete tracks; reordering changes z-order in the preview; hidden/muted tracks are absent from export.
10. Magnetic main track closes gaps on delete/trim/move-out; inserting between clips ripples.
11. Incompatible drops are refused with a reason; dropping below tracks creates a new correct track.

**Editing**
12. Split with selection and without selection (split-all) is correct, including keyframe continuity and caption word boundaries.
13. Trim cannot exceed source media; edge hit zones work on narrow clips; preview shows the edge frame during trim.
14. Ripple delete, ripple trim, rolling edit, Q/W trims behave as specified; locked tracks never move.
15. Copy/cut/paste, paste attributes and duplicate preserve relative layout and keyframes.
16. Overlap policy: Normal bumps to an auto track; Insert ripples; Overwrite trims covered items and shows Undo; Ctrl/Shift temporary modes work.
17. Extending a clip is clamped at the next clip; nothing is ever overwritten by a trim.
18. Group/ungroup and linked audio/video move, trim and split together; Ctrl+Alt+click selects one.

**Interaction quality**
19. A click never moves a clip (4 px threshold); Esc cancels any drag exactly.
20. Snapping (8 px) works for playhead, edges, markers, work area, keyframes, transitions; guides appear; Alt bypasses.
21. Multi-clip drag preserves relative offsets and tracks; edge auto-scroll works in both axes.
22. Drag from the media library, from Explorer, and from effect/transition panels all place items correctly.
23. Transitions attach at junctions, resize, re-align, clamp to handles, and survive trimming/moving.
24. Keyframe diamonds drag, copy, delete and show per-property sub-lanes; moving/trimming/splitting clips keeps animation correct.

**Persistence and performance**
25. Save → close → reopen restores tracks, items, keyframes, markers, zoom, scroll, toggles and playhead exactly.
26. A hard kill of the app during editing loses ≤ 2 s of work after relaunch recovery.
27. 2,000-item project meets section 27 targets on the reference machine.
28. Undo/redo round-trips every command (automated), with correct selection afterwards.

**Quality bar**
29. All unit tests (engine commands, snapping, ripple, overlap, ruler ticks, time conversion, invariants) pass; Playwright tests cover checks 1–5, 10, 12, 16, 19, 25.
30. Visual review against `specs/01`: no AI-look items, correct tokens, readable at 1280×720 and at 200% Windows scaling.
