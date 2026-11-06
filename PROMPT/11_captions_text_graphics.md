# SPEC 11 — CAPTIONS, TEXT, GRAPHICS, ICONS AND FONTS

**Binding.** Follows the structure of `specs/09`. Caption **data** and segmentation: `05 §11` (this spec does not redefine them). Related: `01` (tokens), `08` (panels, inspector), `09 §20` (captions on the timeline), `10` (rendering, direct editing), `12` (keyframes/animation engine), `13` (auto emphasis, brand kits), `14` (burned-in vs sidecar).
Code: `/packages/compositor/text` (TextRenderer, layout), `/packages/timeline-engine/captions` (commands), `/packages/caption-styles` (schema, presets, import/export), UI in `/apps/desktop/src/renderer/features/captions` and `…/graphics`.

---

## 1. PURPOSE

Captions are the product's signature. They must look professionally designed, update live as the user edits, stay linked to the transcript without being destroyed by it, and render **identically** in the preview and the export. Text, shapes, icons and stickers use the same style and animation machinery, so there is one system, not three.

---

## 2. ARCHITECTURE (mandatory structure)

1. **One `TextRenderer`** (in `/packages/compositor`) lays out and draws all text-like content (captions, titles, lower thirds, callouts). It uses Chromium's canvas 2D text APIs (`measureText`, `fillText`, `strokeText`) on an `OffscreenCanvas`, so the **preview and the export (same Chromium) produce the same pixels**. It exposes `layout(textModel, style, boxWidth): LayoutResult` (lines, per-glyph/word rectangles) — a **pure function** unit-tested for wrapping, alignment and word rectangles — and `draw(layoutResult, time): Texture`.
2. **Caption item = text item + word timing + a style reference.** A caption is an `ItemBase` of `type:'caption'` (`09 §4`) with payload `{segment: CaptionSegment (05 §11.1), styleId?, styleOverrides?, animation?}`. Style is **resolved** as `preset (by id) → project-local copy → item overrides`. If the preset is later changed or removed, the project's local copy (stored in `caption_styles_used`, `03 §4`) keeps captions rendering identically.
3. **Styles are data** (`.cwstyle` JSON, §6), validated with zod, versioned, importable/exportable. Built-in presets are the same files shipped in `/assets/caption-presets/`; no preset-specific code.
4. **Animation is keyframe-based** (`12`): every caption/text animation preset is a **generator of keyframes and per-word timing curves**, not a bespoke renderer. Text can be re-edited after an animation is applied.
5. **All edits are engine commands** (`09 §2.3`) in `/packages/timeline-engine/captions`: `editCaptionText`, `retimeCaption`, `splitCaption`, `mergeCaptions`, `moveCaptions`, `resizeCaption`, `applyCaptionStyle`, `setWordHighlight`, `regenerateCaptions`, `syncCaptionsWithTranscript`. UI components contain no caption logic.

---

## 3. CAPTIONS ON THE TIMELINE

(Visual rules in `09 §20`; summary of behaviour required here.)
- Captions live on **caption tracks** (`role:'captions'`, `kind:'caption'`). They are **separate editable items**; **never burned into source media**.
- A clip project gets one caption track by default; the user can add more (e.g. a translation track, `13` later).
- Caption items never overlap on the same track (`09` invariant 1). Overlapping captions across different tracks are allowed and render by track order.
- Each caption item shows its text; at sufficient zoom, word ticks are shown; the selected caption shows draggable edges.
- **Trimming** a caption's edge never changes word text; words outside the new range are **kept in the model but hidden** (so extending restores them) until the user explicitly applies *Trim words to range* (an inspector button). The visible text always equals the words whose midpoint lies inside the caption range.
- **Splitting** at the playhead splits at the nearest word boundary (never inside a word; if the playhead is inside a word it goes to the closer boundary); the two parts keep word timings and styles (`09 §12`).
- **Merging** (select 2+ adjacent): concatenates words, re-lines per the style's line rules; refused if non-adjacent unless "Merge across gap" is confirmed (fills the gap).

---

## 4. THE CAPTIONS PANEL (left tab, `08 §4`)

Sections, top→bottom:
1. **Auto-captions** card: *Generate from transcript* (uses the project transcript and the **current style**, `05 §11.2` with the canvas aspect) · *Regenerate* (only untouched captions, §9) · *Import SRT/VTT…* (parsed into caption segments; word times estimated proportionally to character count and flagged `approximate`) · *Hide filler words* toggle (`05 §10`) · status line ("143 captions · 12 edited by you").
2. **Style gallery:** a 2-column grid of **live preview tiles** (each renders the style on a sample phrase with the project's canvas aspect, using the real `TextRenderer`; animation plays on hover only). Tile states: default, hover, selected (`--brand-tint` + 1 px `--brand` outline), *Modified* dot when the project copy differs from the preset. Header: **All · Mine · Favourites** segmented; search; **Import style…**, **New style from selection**.
3. **Caption list:** virtualised list of all captions: time, text (editable inline: double-click), word-count, flags (*Edited*, *Transcript changed*, *Low confidence*, *Overlap warning* if > max chars/lines), checkbox multi-select. Click = seek and select on the timeline. Keyboard: ↑/↓, Enter edit, Ctrl+Enter split at the caret, Ctrl+Backspace merge with previous.
4. **Bulk actions bar** (when ≥ 1 selected): *Apply style to selected*, *Apply to all*, *Apply to range (work area)*, *Delete*, *Shift timing ±*, *Re-segment…* (opens the segmentation parameters dialog: max chars/line, max lines, max duration; deterministic `buildCaptions`).
5. **Find & replace** in captions (case option) with count and preview; replacement records `manualText: true` only on changed captions.

---

## 5. BUILT-IN CAPTION STYLE PRESETS (all ten required, all editable)

Each preset ships as a `.cwstyle` file with the parameters in §6. Names are final; looks are specified so a careful developer can build them without guessing. Fonts are from the **bundled OFL set** (§10). Colours listed are defaults the user can change; every preset must be **legible on both bright and dark video** (verified by the contrast test in §14 — outline/shadow/background guarantee ≥ 3:1 against both a white and a black test frame).

| # | Preset | Look and behaviour |
|---|---|---|
| 1 | **Clean Minimal** | Manrope 600, white, 0.5 px soft shadow, no outline, lower-third area (y 78%), sentence-case, 2 lines max, **fade** in/out 120 ms, no word highlight |
| 2 | **Bold Creator** | Montserrat 800, **uppercase**, white fill, 6 px black outline (rounded joins), hard drop shadow (0, 6 px, 0), centred (y 62%), 1–2 lines, **pop** in (scale 0.85→1.05→1, 140 ms) per caption |
| 3 | **Highlighted Keywords** | Poppins 700, white; **keywords** (from auto-emphasis, `13`, or user-marked) rendered in `--brand-amber`-like highlight colour `#FFD400` with a 130% scale pop; other words white; black outline 4 px |
| 4 | **Karaoke** | Poppins 700, base text white at 60% opacity; the **currently spoken word** fills to `#FFD400` (left-to-right fill over the word's duration) and stays lit; 2 lines, y 70%; soft shadow |
| 5 | **Word by Word** | Anton 400 (condensed), **uppercase**, **one word at a time** centred (y 55%), white with 5 px black outline, each word **pops** (scale 0.8→1) and the previous disappears instantly; target words = 1 |
| 6 | **Multi-line Subtitle** | Inter 500, white on a **rounded semi-opaque dark box** (rgba(0,0,0,0.62), radius 10 px, padding 12×6), max 2 lines, left-aligned inside a centred block, y 86%, fade 100 ms |
| 7 | **Animated Slide** | Poppins 700, white with `#FF7A00`-free accent colours chosen from the brand kit (default `#4DA3FF` highlight); lines **slide up** and fade in 160 ms, words highlight in sequence with a colour change; y 66% |
| 8 | **Editorial** | Playfair Display 600 (serif), sentence-case, off-white `#F5F0E6`, thin 1 px black outline, **letter-spacing +1%**, centred, y 80%, **no animation** except 150 ms fade; italic emphasis on keywords |
| 9 | **Podcast** | Inter 700, white text on a **solid brand-neutral chip** per line (rgba(20,20,22,0.9), radius 8 px), speaker label (small, muted) above when `speaker` is known, y 74%, 2 lines, fade 100 ms |
| 10 | **Social Pop** | Bangers 400 (or Archivo Black), uppercase, alternating word colours (white / `#FFD400` / `#3DD68C`) per word index, 5 px outline, rotation jitter of ±2° per caption (deterministic seed), **bounce** in (overshoot 1.12) , y 60% |
Defaults chosen for the **start page card 2** (`02 §4.4`): *Bold Creator* is the default selected preset. Every preset must work at 9:16, 1:1, 4:5, 16:9 (positions given as percentages of the canvas; font size as % of the canvas **short side**, §6, so presets scale across aspect ratios and resolutions identically in preview and export).

---

## 6. CAPTION STYLE FORMAT (`.cwstyle`, documented in `docs/formats.md` and validated by zod)

```jsonc
{
  "format": "cwstyle", "formatVersion": 1,
  "id": "uuid", "name": "Bold Creator", "author": "…", "license": "…",   // license field is free text shown on import
  "createdAt": "…",
  "font": { "family": "Montserrat", "weight": 800, "italic": false,
            "source": "bundled" | "user" | "system",    // how to find it (§10)
            "sizePctOfShortSide": 7.2 },                  // font size relative to the canvas short side
  "text": { "case": "none"|"upper"|"lower"|"title", "align": "left"|"center"|"right",
            "letterSpacingEm": 0, "wordSpacingEm": 0, "lineHeight": 1.15,
            "maxLinesHint": 2, "maxCharsPerLineHint": 20 },    // hints for buildCaptions; user can override per project
  "fill": { "color": "#FFFFFF", "opacity": 1 },
  "outline": { "enabled": true, "color": "#000000", "widthPctOfFont": 9, "join": "round" },
  "shadow": { "enabled": true, "color": "#000000", "opacity": 0.6, "dx": 0, "dyPctOfFont": 8, "blurPctOfFont": 0 },
  "background": { "enabled": false, "color": "#000000", "opacity": 0.6, "radiusPx": 10, "paddingX": 12, "paddingY": 6, "perLine": true },
  "position": { "anchor": "bottom-center", "xPct": 50, "yPct": 62, "maxWidthPct": 86 },
  "highlight": { "mode": "none"|"current-word"|"keywords"|"karaoke-fill"|"word-by-word"|"sequence",
                 "color": "#FFD400", "scale": 1.0, "background": null, "keepLit": true },
  "wordColors": ["#FFFFFF", "#FFD400"],          // optional cycling colours
  "animation": { "in": {"preset":"pop","durationMs":140,"easing":"easeOut", "params": {}},
                 "out": {"preset":"fade","durationMs":100,"easing":"linear"},
                 "perWord": {"preset":"pop","durationMs":120,"staggerMs":0} },
  "timing": { "leadMs": 0, "lagMs": 0, "minDisplayMs": 600, "holdAfterLastWordMs": 150 },
  "rotationJitterDeg": 0, "seed": 1
}
```
Rules:
- **Units are relative** (percent of canvas short side / of font size) so a style looks the same at any resolution. Absolute px appear only for the background radius/padding, which are scaled by `canvasShort / 1080`.
- **Unknown fields are preserved** on import/export; `formatVersion` migrations are unit-tested.
- **Import:** drag a `.cwstyle` file onto the Captions panel or *Import style…*; validate with zod, show a preview tile and the `license` text, handle fonts (§10: if the font isn't available, offer *Use a similar bundled font* or *Import the font file…*), confirm. Imports go to the **Mine** collection (`CaptionStyles/` folder, `03 §3`) and stay available in **future projects**.
- **Export:** *Export style…* writes a `.cwstyle` (font **not** embedded; the font family and source type are recorded).
- **Edit a preset:** editing in the inspector creates a **project-local copy** (the preset file is untouched). **Save as my style…** writes it to **Mine**; **Update preset** is available only for the user's own styles; built-ins can be *reset* but never overwritten.
- Style JSON schema is published in `docs/formats.md` with two worked examples.

---

## 7. CAPTION STYLE EDITOR (inspector section for captions, and a *Style editor* dialog for presets)

Controls, grouped: **Font** (family combobox with live preview rows, weight, italic, size slider in % of short side with a numeric field showing the px equivalent) · **Text** (case, alignment, letter/word/line spacing) · **Fill & Highlight** (colour picker with recent colours and eyedropper; highlight mode segmented; highlight colour; keyword scale) · **Outline** · **Shadow** · **Background** (colour, opacity, radius, padding, per-line vs block) · **Position** (anchor grid, X/Y %, max width %, *Drag on canvas* toggle; safe-area snap `10 §9`) · **Animation** (in/out/per-word preset, duration, stagger, easing curve — presets from `12 §3`) · **Timing** (lead/lag, min display, hold) · **Apply to** (*This caption*, *Selected*, *All*, *All in range*).
Changes apply **live** to the selected captions (preview within one frame); a slider drag = one transaction; **Reset** per group.
**Per-word highlight editing:** in the caption list's word view or by double-clicking a caption in the preview, individual words can be toggled **Emphasis** (uses the style's highlight look) with a click (or `Ctrl+B`) and recoloured; stored as `wordOverrides: {wordId → {emphasis?: boolean, color?: string, scale?: number}}` so styles can be swapped without losing which words the user emphasised.

---

## 8. CAPTION EDITING OPERATIONS (all undoable; all with live preview)

| Operation | Behaviour |
|---|---|
| Edit words | Inline edit in the list, in the preview (double-click) or the inspector word list. Replace keeps timing; insert/delete/merge/split word semantics as `05 §9.3`. Sets `manualText: true`. |
| Change timing | Drag the caption's edges or move it on the timeline (`09`); or edit start/end in the inspector; word timings can be **re-spaced** (*Distribute words evenly*) or **nudged per word** in a mini word-timeline (drag word boundaries with snap to frame; sets `manualTiming: true`). |
| Split / Merge | §3. |
| Move | Drag on the timeline; moving a caption never changes its words; multi-select moves together; overlap with another caption on the same track is resolved by `09 §13` (bump to auto track/ insert/overwrite per mode). |
| Resize duration | Edge drag; words are re-timed **proportionally** (default) or kept (Alt = keep word times and just change the display window, hiding words outside). |
| Position | Drag in the preview (`10 §8.2`) or X/Y in the inspector; per-caption offset overrides the style position (`styleOverrides.position`), with *Reset to style position*. |
| Apply animations | Per caption or style-wide (§7). |
| Multi-select style apply | §4.4. |
| Delete | Removes the caption item only (transcript untouched). |

---

## 9. SYNC WITH THE TRANSCRIPT (rules in `05 §11.3`; UI here)
- A caption with `manualTiming`/`manualText` shows a **"Transcript changed"** badge when its source words have changed since it was created; the inspector shows **Sync…** with *Update text only* · *Update text and timing* · *Keep mine* (never auto-overwrites).
- Untouched captions regenerate automatically for the affected range **only while the project's caption track is in "Linked to transcript" mode** (toggle in the Captions panel, default on). Turning it off freezes captions from the transcript entirely (they become fully independent).
- **Send corrections back to transcript** (text only) is a bulk action on selected captions (confirm, undoable; it bumps `transcript.version` and triggers `07` stale-moment flags).
- Re-segmenting (aspect-ratio change, or *Re-segment…*) preserves captions with manual flags unless the user chooses otherwise (`08 §7.4`).

---

## 10. FONTS

### 10.1 Bundled set (OFL, in `/assets/fonts`, woff2 + the original licence files; listed in `docs/licences.md` and About → Third-party notices)
**UI:** Manrope. **Caption/text set** (each with the weights actually shipped recorded in a manifest): Inter, Montserrat, Poppins, Anton, Bebas Neue, Oswald, Archivo Black, Bangers, Playfair Display, Lora, Roboto, Roboto Condensed, Source Sans 3, Nunito, Lexend, DM Sans, Space Grotesk, JetBrains Mono (for code-style captions), Caveat (handwriting), Permanent Marker. If a font's licence turns out not to permit bundling (verify each against its upstream licence file during Phase 1), remove it and record that in `docs/decisions.md`.
- Variable fonts are used where available; if a requested weight isn't present the nearest is used and the UI shows only the weights that exist.
- **Emoji and symbols in captions:** render with the system emoji font (Segoe UI Emoji); documented as "system font, may look different on another computer".
- **Non-Latin scripts:** Noto Sans variants for Arabic, Devanagari, CJK, etc. are **downloadable language packs** (OFL, hash-verified, in `Fonts/`) offered when a transcript's language needs them; until then the system font fallback is used with a notice. RTL text uses the browser's bidi layout; the `TextRenderer` must lay out RTL and mixed-direction lines correctly (test with Arabic/Hebrew fixtures).

### 10.2 User fonts
- *Import font…* accepts `.ttf`, `.otf`, `.woff2`; validated (parsed with a font parser; reject corrupt files), copied to `Fonts/` (managed) and registered with `FontFace`. The dialog states: "Make sure you have the right to use this font. Clipwright doesn't check licences." Font family names are shown with a small *Imported* tag.
- **System fonts** can be used (queried through Chromium's `queryLocalFonts` where available, otherwise a font list from the main process); they are labelled *System* and warned about when exporting a package (`03 §10.5`).
- **Missing font handling:** when a project uses a font not present (e.g. opened on another computer), captions/text render with a **similar fallback** and show a **"Font missing: <name>"** warning in the inspector and a banner with *Choose replacement* (replaces everywhere, undoable) and *Import font…*.
- Fonts are loaded **before** the first frame is rendered (`document.fonts.load`) in both preview and export; export waits for fonts and fails clearly if one cannot load.

---

## 11. TEXT ITEMS (titles, subtitles, headings, paragraphs, lower thirds, callouts)

- **Presets** in the Text panel: *Title*, *Subtitle*, *Heading*, *Paragraph*, *Lower third (name + role)*, *Callout (with arrow/shape)*, *Quote*, *Counter/Stat*, *Bullet list*. Each is a **template** that creates one or several linked items (e.g. lower third = shape + two text items grouped). Templates are `.cwtemplate` JSON files (same schema family) and user-extensible ("Save selection as template").
- **Properties** (all in the inspector; `08 §7.2`): text content (multi-line, rich per-range bold/italic/colour only for **paragraph** types in v1: bold, italic, colour, underline), font family/size/weight, alignment (L/C/R/justify), colour (solid; **gradient fill is out of scope in v1**, documented), background (colour, opacity, radius, padding), stroke, shadow, line spacing, letter spacing, box dimensions (**auto-size** vs **fixed box**, with *shrink to fit* option), position, rotation, opacity, blend mode, anchor.
- **Text on a path / 3D / warp** are out of scope for v1 (listed in `docs/limitations.md`).
- **Creation:** click a preset (adds at the playhead on a text track, 3 s default, centred), drag it onto the preview (placed at the drop point) or the timeline, or use the Text tool (`10 §8.7`).

### 11.1 Text animations (editable presets, built on keyframes, `12`)
Categories: **In**, **Out**, **Loop**, and **Per-unit** (per word / per letter / per line). Presets (all required):
| Preset | Behaviour (defaults) | Parameters |
|---|---|---|
| **Fade** | opacity 0→1 | duration, easing |
| **Slide** | from offset + fade | direction (L/R/T/B), distance %, duration, easing |
| **Pop** | scale 0.8→1.08→1 + fade | overshoot, duration |
| **Bounce** | drop with elastic settle | height, bounces (1–3), duration |
| **Typewriter** | characters appear sequentially | speed (chars/s), cursor on/off, sound off |
| **Scale** | scale 0→1 or 1→0 | pivot (centre/baseline/left), duration, easing |
| **Wipe** | mask reveal | direction, softness, duration |
| **Reveal** | lines/words rise from a clipping mask | direction, stagger, duration |
| **Word-by-word** | words appear in sequence | stagger ms, effect (fade/pop/slide) |
| **Letter-by-letter** | letters appear in sequence | stagger ms, effect |
| **Pulse** (loop) | gentle scale 1→1.04→1 | period, amount |
| **Shake** (loop, optional) | small deterministic jitter (seeded) | amount, period |
User controls: **duration, direction, easing, delay, stagger, and the in/out/loop assignment**. The result is written as **real keyframes** (position/scale/opacity/mask progress and per-unit offsets) so the user can **open the keyframe editor and tweak them** (`12`) and they are **deterministic in export** (seeded randomness only; no `Math.random`). A *Reset animation* button reverts to the preset's generated keyframes. Animations are visible on the timeline as in/out handles on the item (`09 §17`).

---

## 12. SHAPES, LINES, ARROWS, ICONS, STICKERS AND CUSTOM GRAPHICS

- **Shapes:** rectangle (corner radius), rounded rectangle, ellipse, triangle, polygon (3–12 sides), star (points, inner ratio), **line**, **arrow** (head style/size), **speech bubble**. Properties: fill (solid/none), stroke (colour, width, dash, caps), corner radius, size, position, rotation, opacity, shadow, blend. Implemented as SVG paths rasterised by the `TextRenderer`'s sibling `VectorRenderer` at the target resolution (crisp at any scale; never raster-stretched).
- **Icon library (offline):** the **full Lucide set** (ISC licence) bundled as an SVG sprite, searchable by name and tags with category chips, plus a second bundled open set if licences allow (e.g. Tabler Icons, MIT; verify and record). **No network calls.** Icons are tintable (single colour or `currentColor`), stroke width adjustable (0.5–4), size, rotation, flip.
- **Stickers:** a small bundled set of **self-made, licence-clean vector stickers** (generated by the team; no third-party artwork, no copyrighted characters) such as arrows, underline swooshes, circles/highlight scribbles, check/cross marks, "NEW / LIVE / SALE" badges (text-free versions plus editable-text versions), emoji-free decorative frames. Do not ship any sticker whose licence is unclear.
- **Custom graphics:** import **SVG** (sanitised: strip `<script>`, event handlers, external references, `foreignObject`; limit size 5 MB), **PNG/JPG/WebP** (alpha preserved), **GIF** (first frame static in v1). Imported SVG gets *Recolour* (replace fills/strokes by palette mapping when the SVG uses simple colours; otherwise whole-graphic tint) and remains vector at export. User graphics are stored in the project media library (`04 §7`) and in the workspace *Graphics* collection for reuse.
- **Logos / watermarks:** *Add logo* (from library or brand kit, `13`) with position presets (corners, with margins 4%), size %, opacity, *Show for whole clip* toggle; adds an image item with locked aspect.
- All graphics are items on **graphics/text tracks** with the full transform, keyframe, animation, opacity and blend support; they can be placed from the panel by click (playhead), drag to timeline, or drag to preview.

---

## 13. SUBTITLE EXPORT AND BURNED-IN CAPTIONS (hand-off to `14`)
- Caption items can be exported as **SRT** and **WebVTT** (one file per caption track, UTF-8; line-wrapped by the item's `lines`; **WebVTT** with optional style cues only if the style is simple; SRT never carries styling) — named `<name>.<lang>.<ext>`; times derive from the **caption item's timeline position** (after trims, ripples and speed changes) not the transcript's original times; hidden words excluded.
- In the export dialog: **Burn captions into video** (default on), **Also export subtitle file(s)**, or **Subtitle file only**. A track can be excluded from burn-in (e.g. a translation track kept as sidecar only). Burn-in uses the same `TextRenderer` (`14 §4`).
- **Imports:** SRT/VTT/`.ass` (basic text and timing only; styling ignored with a notice).

---

## 14. TESTING AND ACCEPTANCE

**Fixtures:** the English 2-minute clip with reference word timings (`05 §14`), an RTL (Arabic/Hebrew) sample, a CJK sample, a clip with two speakers, a bright-white and a black background test video.

1. `TextRenderer.layout` unit tests: wrapping per max width, alignment, line balance, outline/shadow bounds, letter/word spacing, RTL and mixed-direction, emoji fallback, font-missing fallback (golden JSON of word rectangles).
2. Each of the **10 presets** renders on the fixtures at 9:16, 1:1, 4:5 and 16:9; legibility test: text contrast ≥ 3:1 against the white and the black frames (automated pixel sampling of the glyph area vs background); golden images stored per preset; **preview vs export SSIM ≥ 0.995** (`10 §15` check 10).
3. Style editor: every control changes the preview within one frame; slider drags are single undo steps; per-word emphasis survives switching presets; project-local copy keeps looking identical after the preset is edited or deleted.
4. `.cwstyle` export → import round trip is lossless (unknown fields preserved); invalid files rejected with a plain message; a style referencing a missing font offers replacement/import.
5. Caption operations: edit text/timing, split, merge, move, resize (proportional vs Alt-keep), reposition, multi-select apply, find & replace — each undoable; invariants hold (no overlaps on a track, frame-aligned times, words never outside the caption window except hidden ones).
6. Transcript sync: edit a word in the transcript → untouched captions regenerate; manually edited captions show the badge; *Keep mine* leaves them intact; *Update text only/Update text and timing* behave exactly; turning off *Linked to transcript* freezes them.
7. Text animation presets: all 12 produce deterministic keyframes; editing keyframes afterwards works; two exports of the same project are **bit-identical in frame content** (hash of decoded frames); a frame-counter test shows the animation timing is correct at 30 and 60 fps.
8. Fonts: all bundled fonts load offline (network disabled); import of `.ttf/.otf/.woff2`; corrupt font rejected; missing-font flow works after opening a package on a machine without the font; fonts are awaited before the first rendered frame (no flash of fallback in export).
9. Graphics: shapes, lines, arrows; Lucide icons searchable offline; SVG sanitisation test with a malicious SVG (script, external image, `onload`) → neutralised; recolour; vector stays crisp at 4K export (edge sharpness test).
10. SRT/VTT export parses back with a standard parser, times match the timeline after a ripple edit and a speed change; burned-in vs sidecar options work as selected.
11. Visual review against `01`: panel UI uses tokens/components; preset tiles are not AI-look (no gradients/glass in the tiles chrome); readable at 1280×720 and 200% scaling.
