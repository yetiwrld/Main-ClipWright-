# SPEC 08 — EDITOR LAYOUT, MEDIA LIBRARY, CLIP BIN AND INSPECTOR

**Binding.** Follows the structure of `specs/09`. Visual rules: `01`. Related: `02` (route, top bar), `03` (persistence), `04` (import pipeline), `09` (timeline), `10` (preview), `11` (captions/text/graphics), `12` (keyframes/effects/transitions/audio), `13` (AI tools), `14` (export).
Code: `/apps/desktop/src/renderer/features/editor` (+ sub-features `library`, `inspector`, `panels`). Editing logic stays in the engines (`09 §2`); this spec's UI only reads state and dispatches commands.

---

## 1. PURPOSE

A CapCut-style workspace that is dense and calm: everything the user needs within reach, nothing overlapping, every panel resizable and collapsible, and the same layout working for a 9:16 clip, a 16:9 video, and an editor session started from scratch with no AI step at all.

---

## 2. ARCHITECTURE (mandatory structure)

1. **One `EditorStore` (Zustand + Immer)** holding: the open `Composition` (from `timeline-engine`), `selection`, `ui` (panel sizes, active tabs, toggles), `editMode`. Timeline state is **never copied**; the store holds the engine's immutable state and swaps it on each committed transaction.
2. **Selectors are memoised and narrow.** A panel subscribes only to the slice it renders (e.g. the inspector subscribes to the selected items' ids and a derived `InspectorModel`).
3. **Panels are plugins:** each left-panel tab and each inspector section registers `{id, title, icon, order, isAvailable(selection), component}` in a registry. Adding a tab or section = registering one object.
4. **No panel mutates data directly.** Controls dispatch **commands** (`09 §2.3`). A slider drag = one transaction (live preview state during the drag, commit on release; Esc cancels).
5. The playhead is read from `playheadStore` (`09 §2.4`) only where needed (inspector keyframe readouts, transport).

---

## 3. WORKSPACE LAYOUT

### 3.1 Regions (standard tier, 1366–1919 px)
```
┌ Top bar (02 §2.2): ← Home · project name · stepper · tasks · save status · Export ┐
├──────────────┬───────────────────────────────┬──────────────────┤
│ LEFT PANEL   │ PREVIEW (10)                  │ INSPECTOR         │
│ tabs: Media  │  + transport + tools          │ (context-sensitive)│
│ Captions     │                               │                   │
│ Text Graphics│                               │                   │
│ Effects Trans│                               │                   │
│ Audio · AI   │                               │                   │
├──────────────┴───────────────────────────────┴──────────────────┤
│ TIMELINE (09)  — toolbar · ruler · tracks                         │
└──────────────────────────────────────────────────────────────────┘
```
- Panels are **rounded tiles** (`--radius-md`, 12 px) on `--surface-app` with **6 px gutters** (`01 §5`); **splitters** sit in the gutters.
- **Clip bin** (§6) is a horizontal strip **inside the left panel's Media tab** (top section, collapsible) and also reachable as a popover from the top-bar clip selector — it is **not** a fifth region.
- **Default sizes** (standard tier, 1366×768 reference): left 320 px, inspector 300 px, timeline height 38% of the content height, preview takes the remainder. Preview never smaller than 360×240.

### 3.2 Tiers (`01 §9`)
| Tier | Left panel | Inspector | Timeline |
|---|---|---|---|
| **Compact** (< 1366) | **Drawer** (slides over the preview from the left, `--dur-base`; collapsed by default when width < 1200; an icon rail of 48 px stays visible) | **Drawer** from the right, same rules | Gets priority height (min 40%); header column collapses to icons (`09 §5`) |
| **Standard** | docked, 320 px | docked, 300 px | 38% |
| **Large** (≥ 1920) | docked, 360 px | docked, 340 px | 34%; larger preview |
A drawer opens on demand (icon click, shortcut, or selecting a clip for the inspector when `Auto-open inspector` is on) and closes with Esc, a second click, or clicking the preview. Drawers never cover the transport controls or the timeline.

### 3.3 Resizing, collapsing, persistence
- **Splitters:** 6 px hit area in the gutter, drag to resize, **double-click resets** to default, arrow keys resize in 16 px steps when focused (`01` Splitter). Constraints: left 240–480 px, inspector 260–460 px, timeline 180 px–70% of height, preview min as above. A splitter drag that would break a minimum **collapses** the panel instead (snap-to-collapse at < 120 px) and shows a thin re-open handle.
- **Collapse/expand:** each panel header has a chevron; `Ctrl+B` toggles the left panel, `Ctrl+Shift+B` the inspector, `Ctrl+J` the timeline height between normal and maximised (timeline-focus mode hides the preview except a 16:9 mini-preview). Animate at `--dur-base` (transform/opacity only).
- **Persisted per user, per tier:** panel sizes, collapsed state, active left tab, inspector section open/closed states, timeline height, track header width. **Reset layout** in the editor ⋯ menu and Settings → General.
- **Workspace presets** (editor ⋯ → Layout): *Default*, *Captions focus* (left panel on Captions, larger inspector), *Timeline focus*, *Preview focus*. Selecting one sets the sizes; user adjustments are remembered as "Custom".

### 3.4 Editor top-bar additions
- **Clip selector** (a combobox next to the project name): lists all compositions of the project with thumbnails and durations, **+ New blank clip**, **Duplicate this clip**, rename inline. Changing the clip swaps the open composition (the previous one is checkpointed, `03 §5.2`); undo history is **per composition**.
- **Export** button (primary, pill) opens the Export panel/dialog (`14`); a badge shows the number of queued/running exports.

---

## 4. LEFT PANEL TABS

Icon + label tabs (labels hidden in drawer rail). A search field at the top of every tab filters that tab's content.

| Tab | Contents | Spec |
|---|---|---|
| **Media** | Clip bin (§6) · media library (§5) | this spec |
| **Captions** | Caption style gallery, caption list, auto-caption controls, import SRT/VTT | `11` |
| **Text** | Text presets (title, subtitle, heading, paragraph, lower third, callout), animation presets | `11` |
| **Graphics** | Shapes, lines, arrows, icons, stickers, user graphics | `11` |
| **Effects** | Video adjustments and effects with previews | `12` |
| **Transitions** | Transition presets with animated previews | `12` |
| **Audio** | Music/SFX library (user-added), voiceover recorder, audio tools | `12` |
| **AI tools** | Edit by transcript, silence removal, auto-reframe, auto emphasis, brand kit, more (tiers per `13`) | `13` |
Items in Effects/Transitions/Graphics/Text/Audio panels support **click to apply to selection** and **drag to the timeline or preview** (placement rules in `09 §15`).

---

## 5. MEDIA LIBRARY (Media tab)

### 5.1 Content and views
- Shows **all media of the project** (source videos, imported videos, images, audio, user graphics) plus a **Workspace** scope toggle (all media in the workspace, to reuse across projects).
- **Views:** grid (thumbnails 96 px, 3–4 per row) and list (name, kind icon, duration, resolution/format, size, usage count). Toggle in the panel header; remembered.
- **Filters** (segmented): All · Video · Audio · Image · Graphics. **Sort:** Name, Date added, Duration, Size, Kind (asc/desc). **Search** on name and metadata.
- Each item: thumbnail (poster frame for video, waveform strip for audio, image preview), duration badge, kind icon, a small status badge (*Processing…* with percent while derived files build, *Missing*, *Proxy ready*), and a **usage dot** when used on the timeline.
- Thumbnails/waveforms use skeletons while loading. List is **virtualised** (1,000+ items stays smooth).

### 5.2 Importing
- **Import button** (+ menu: *Files…*, *Folder…* (non-recursive by default with a checkbox), *From link…* (same probe/download flow as `04 §3`, as a background task)). **Drag from Explorer** onto the panel or **directly onto the timeline/preview** (`09 §15`). **Ctrl+I** opens the file dialog. Paste a copied file/URL (Ctrl+V while the panel has focus).
- Storage mode follows the project setting (copy default / reference) with a one-time per-import override in the dialog footer. Pipeline: `04 §7`. A per-file progress row appears at the top of the library while importing, with Cancel.
- Unsupported file → toast with the reason (`04 §2`); the rest of a batch continues.
- Duplicates (fingerprint match): offer *Use existing* (default) or *Import again*.

### 5.3 Item actions (right-click and ⋯)
**Add to timeline** (at the playhead on a suitable track, honouring the edit mode, `09 §13`) · **Preview** (opens a small preview popover with play/scrub, in/out marking, and "Add selection to timeline") · **Rename** (display name only) · **Replace media…** (swap the file behind all uses; keeps trims where the new duration allows, warns otherwise) · **Show in folder** · **Properties** (full `MediaInfo`, storage mode, path, SHA-256, derived files with sizes) · **Rebuild proxy/waveform** · **Relink…** (when missing) · **Remove from library** (§5.4).
- **Drag** an item onto the timeline (ghost clip with duration, drop indicators), onto the preview (creates an overlay item at the drop point), or onto another panel's drop target where relevant.
- **Multi-select** (Ctrl/Shift-click, drag-box) supports Add to timeline (in selection order, back-to-back), Remove, Rename pattern.
- **Audio items:** hover scrub with a small waveform; inline play button.

### 5.4 Removing media
If the media is in use anywhere in the project, show "Used N times in M clips" with the clip names; actions *Cancel* / *Remove anyway* (items become Missing-styled, nothing deleted, `03 §8`). Managed files are **not** deleted by removal; they are listed under unused media clean-up (`03 §8`).

### 5.5 Empty and loading states
Empty library: icon + "Import video, audio or images" + **Import** button + "or drag files here". A drag-over state highlights the panel with a dashed `--brand` outline (`--radius-md`).

---

## 6. CLIP BIN

A horizontal, scrollable strip at the top of the Media tab (collapsible; collapsed by default when the project has one clip):
- One **card per composition**: thumbnail (frame at 10% of its duration), name, duration, aspect-ratio badge, status chip (*Edited*, *New*, *Exported*), version badge when derived (v2).
- **Click** opens that clip in the editor; **double-click** renames; **Ctrl/Shift-click** multi-selects for **batch actions** (§9).
- ⋯ menu: Open, Rename, **Duplicate** (a new composition copy — "versions without destroying the original", master §8), **Create variant at another aspect ratio** (duplicates and re-fits, §8.3), **Insert into current clip** (adds the other clip's contents as a group at the playhead — "combining clips"), **Export…**, **Delete** (confirm; never deletes media).
- **Drag a clip card onto the timeline** → inserts it as a **nested group** of items placed per the edit mode (it is flattened into items, not a live reference, so later edits of the source clip do not silently change this one; state this in the tooltip).
- **+ New blank clip** card: choose aspect ratio, frame rate, name.

---

## 7. INSPECTOR

### 7.1 Principles
- **Context-sensitive:** shows sections for what is selected; nothing selected shows **Project/Canvas** settings. Section headers are collapsible (state persisted), sorted by relevance.
- **Dense:** 13 px text, 32 px controls, 4/8 px spacing (`01`). Labels left (96 px), controls right. Numeric fields support **drag-to-scrub on the label**, arrow-key nudge (Shift ×10, Alt ×0.1), unit suffixes, mouse-wheel adjustments only while focused, and `Enter`/`Esc` to commit/cancel. Multi-value state shows "Mixed" and editing sets all.
- **Every animatable property has a keyframe diamond** at the right end of its row (`12`): hollow = no keyframes, filled = keyframe at the playhead, half = animated but none here. Click toggles a keyframe at the playhead; a "◀ ▶" pair jumps between keyframes when the property is animated.
- **Reset** icon per property and per section (restores defaults, one undo step).

### 7.2 Sections per selection
| Selection | Sections (in order) |
|---|---|
| **Nothing / canvas** | **Canvas** (aspect ratio presets + custom, width×height, background colour or blur-fill of the video, frame rate 30/60 — changing the canvas offers *Fit existing clips* / *Keep positions* / *Cancel*), **Safe areas** (toggle platform overlays), **Project info** (name, duration, source media list) |
| **Video / image clip** | **Transform** (position X/Y, scale X/Y with link, rotation, anchor, flip H/V) · **Crop** (L/T/R/B, rounded corners, aspect lock, *Reframe…*) · **Opacity & blend** (opacity, blend mode) · **Speed** (0.1–8×, "preserve pitch", ripple toggle) · **Effects** (list, add, reorder, enable, params) · **Transitions** (in/out, type, duration, alignment) · **Audio** (volume, fade in/out, mute, detach audio) · **Basic info** (source, source in/out, timeline start/duration as TimecodeFields, label, **Replace media…**) |
| **Audio clip** | **Audio** (volume dB, gain, fade in/out with curve, pan/balance, mute, solo) · **Enhance** (normalise, noise reduction, ducking) · **Speed** · **Keyframes** · **Basic info** |
| **Caption(s)** | **Caption text** (text area, word list with per-word timing editor) · **Style** (preset, font, size, weight, colours, outline, shadow, background, spacing, alignment, position, animation, highlight mode) · **Timing** · **Apply style to** (selected / all captions / all in range) · **Transcript sync** badge/actions (`05 §11.3`) — details in `11` |
| **Text / shape / icon / sticker** | **Content** · **Transform** · **Style** (font, colour, stroke, shadow, background, spacing) · **Animation** (in / out / loop presets, durations, easing) · **Opacity & blend** · **Basic info** — details in `11` |
| **Adjustment / effect item** | **Effects**, **Opacity**, **Basic info** |
| **Multiple items (same type)** | The shared sections with "Mixed" values; relative operations (align, distribute, match size) shown as an **Align** section |
| **Multiple items (mixed types)** | **Align**, **Opacity**, **Timing offset**, **Group/Ungroup**, **Delete**, **Apply style…** if applicable |
| **Track** | Name, colour, height, mute/solo/lock/hide, **blend** (video tracks), **volume** (audio tracks) |
| **Marker** | Name, colour, time, note |
| **Transition** | Type, duration, alignment, direction/params, easing (`12`) |

### 7.3 Align / distribute
Buttons: align left/centre/right/top/middle/bottom to **canvas** or **selection**, **distribute** horizontally/vertically, **match width/height**, **centre on canvas**. One transaction per click.

### 7.4 Canvas (project) aspect-ratio change
Changing the aspect ratio inside the editor (`master §5.2`) uses the engine command `setCanvas`: the dialog offers **Re-fit video to fill** (default for the main video; reframing via the stored `initialFraming` and, if available, auto-reframe `13`), **Keep positions (letterbox)**, **Scale overlays proportionally**. Captions are **re-segmented** for the new aspect (`05 §11.2`) unless the user has manual caption edits, in which case the dialog lists the affected captions and asks (*Re-segment untouched* / *Keep all*).

---

## 8. BATCH AND MULTI-CLIP WORKFLOWS

### 8.1 Batch apply (from the clip bin multi-select or the ⋯ menu → "Apply to clips…")
Choose what to apply to the selected clips: *Caption style* · *Brand kit* (`13`) · *Text/logo overlay* (position and timing relative to start/end) · *Intro/outro clip* · *Audio normalisation* · *Canvas aspect ratio (creates variants)*. Shows a **preview of the affected clips** and a summary; runs as a transaction per clip with progress; **one undo per clip** and a "Revert batch" toast. Manually edited captions are skipped by default (checkbox to include) with the count shown.

### 8.2 Combining clips
- **Insert into current clip** (§6) and **Append clips**: select several clips in the bin → *Combine into new clip…* creates a new composition with them back-to-back (optional crossfade of N frames), leaving originals untouched.

### 8.3 Variants at another aspect ratio
*Create variant…* duplicates the composition, sets the new canvas, re-fits the main video using the stored framing (or auto-reframe if enabled), re-segments untouched captions, and names it "<name> (9:16)" etc.

---

## 9. COMMAND PALETTE AND SHORTCUTS
All editor commands are registered in a **command registry** `{id, title, icon, shortcut, when, run}` consumed by menus, the toolbar, tooltips, the palette (`Ctrl+K`, `02 §2.5`) and the shortcut editor (Settings → Keyboard shortcuts: view, search, rebind with conflict detection, reset; stored per user). Shortcuts for timeline/playhead are in `09 §22`; panel shortcuts here: `Ctrl+B`, `Ctrl+Shift+B`, `Ctrl+J`, `Ctrl+I`, `Ctrl+E` (Export), `Ctrl+S`, `F` (fit preview), `Ctrl+/` (cheat sheet), `Tab` cycles focus regions (left → preview → inspector → timeline) with a visible focus ring.

---

## 10. STATES, FEEDBACK AND ERRORS
- **Loading a composition:** skeleton panels; the timeline appears with the clips as soon as the engine state loads (thumbnails/waveforms stream in).
- **Missing media banner** (top of the preview): "N media files are missing — Relink" with a button (`04 §8`).
- **Background tasks** chip in the top bar covers proxy/waveform generation; the library items show their own *Processing…*.
- **Toasts** for add/remove/replace/undo-able actions; errors persist until dismissed (`01`).
- **Unsaved/save state** per `03 §5.2`. **Read-only** projects (newer schema, other instance, archived): a banner and all editing controls disabled with tooltip reasons.
- **Window close/leave** with exports running: confirm (exports can continue only while the app is open; resumable queue per `14`).

---

## 11. PERFORMANCE
Editor opens a 200-item composition in < 1.5 s (skeleton first); panel resize at 60 fps (CSS transforms/containment, no re-render of the timeline during splitter drags beyond its own size observer, debounced canvas redraws); library with 1,000 items scrolls at ≥ 55 fps; inspector updates within one frame of a selection change; inspector controls never re-render on playhead ticks except keyframe readouts.

---

## 12. EDGE CASES
Nothing open (project has no compositions) → empty state "Create a clip from a moment or add a blank clip" · opening a composition whose media is all missing · rapid clip switching (cancel in-flight loads) · window shrinks below min while a drawer is open (drawer closes) · localisation of long names (ellipsis + tooltip) · panels collapsed + window restored from minimised · very wide ultrawide (2560×1080): preview keeps aspect, side panels cap widths, extra width goes to the timeline · 200% scaling: controls keep 32 px logical size, text ≥ 12 px · keyboard-only use of every panel · screen reader labels on all icon buttons · duplicate clip names get numeric suffixes.

---

## 13. ACCEPTANCE CHECKS
1. All four regions render and resize correctly at 1100×680, 1280×720, 1920×1080, 2560×1080 and 200% scaling: no overlap, no clipped controls, drawers behave in compact tier, Play/Split/Undo/Export/Stepper always visible.
2. Splitters: drag, double-click reset, keyboard resize, snap-to-collapse; sizes persist across restart per tier; Reset layout works.
3. Import from the dialog, from Explorer drag onto library/timeline/preview, from a link, and a 50-file batch; per-file progress; unsupported file toast; duplicate prompt; all items appear with thumbnails/waveforms.
4. Library views/filters/sort/search; virtualised list with 1,000 items ≥ 55 fps; context-menu actions all work including Replace media (trims preserved where valid) and Remove-in-use warning.
5. Clip bin: open, rename, duplicate, variant at another aspect, insert into current clip, combine into new clip, delete (no media deleted); per-composition undo history.
6. Inspector shows the right sections per selection type (table 7.2), **Mixed** values and multi-edit work, numeric scrub/nudge/Esc-cancel work, keyframe diamonds reflect state, reset per property/section is one undo step.
7. Align/distribute buttons produce exact results (unit tests on the maths + one E2E).
8. Canvas change from 9:16 to 16:9 with each of the three options behaves as §7.4; captions re-segmented/asked correctly.
9. Batch apply (caption style, brand kit, overlay, normalise) to 5 clips with progress, skipped manual captions reported, per-clip undo, revert toast.
10. Command registry: every toolbar/menu action appears in the palette; rebinding a shortcut persists and conflicts are detected.
11. Missing-media banner and Relink flow work from the editor; read-only banners disable editing.
12. Keyboard-only walkthrough reaches every panel; focus rings visible; axe-style accessibility scan on the editor shows no critical violations.
13. Visual review against `01`: CapCut-density, flat tonal panels, no AI-look items, orange ≤ 5% of the screen.
