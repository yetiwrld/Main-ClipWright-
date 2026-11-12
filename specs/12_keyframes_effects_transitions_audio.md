# SPEC 12 — KEYFRAMES, EFFECTS, TRANSITIONS AND AUDIO

**Binding.** Follows the structure of `specs/09`. Related: `01` (tokens, curve editor styling), `08` (inspector, panels), `09` (timeline, keyframes on the timeline §17, transitions §16, waveforms §19), `10` (preview, audio playback), `11` (text animation presets), `14` (export; shares all maths).
Code: `/packages/timeline-engine/keyframes` (model, interpolation, commands), `/packages/compositor/effects` and `/transitions` (GLSL), `/packages/audio-core` (envelopes, mix, analysis, DSP), UI in `/apps/desktop/src/renderer/features/{keyframes,effects,audio}`.

---

## 1. PURPOSE

One animation engine for every animatable property, a small, solid set of effects and transitions, and an audio system that sounds the same in preview and export. Everything is **deterministic**: the same project always renders the same frames and the same samples.

---

## 2. KEYFRAME ENGINE

### 2.1 Architecture (mandatory)
1. `evaluate(keyframes, localTimeUs, defaultValue): value` lives in `/packages/timeline-engine/keyframes` as a **pure function with no floating-point drift**: times are integers (µs); interpolation parameter `u = (t − t0) / (t1 − t0)` is computed in double precision from integers, and results are **not rounded** except where a property defines its own quantisation (e.g. opacity clamped 0–1). The compositor (preview and export) and the audio engine **call this same function**. No second implementation.
2. Keyframe data is stored on each item (`09 §4`): `keyframes: Record<PropertyPath, Keyframe[]>`, times **local to the item start**, sorted, unique per property, **frame-quantised** (`09 §3`).
3. Edits are engine commands: `addKeyframe`, `deleteKeyframes`, `moveKeyframes`, `duplicateKeyframes`, `pasteKeyframes`, `setKeyframeValue`, `setKeyframeEasing`, `setKeyframeInterpolation`, `setBezierHandles`, `shiftAnimation`, `scaleAnimationDuration`. Each is one undo step (`09 §24`).

### 2.2 Data model
```ts
type PropertyPath = 'transform.x'|'transform.y'|'transform.scaleX'|'transform.scaleY'|'transform.rotation'|'transform.anchorX'|'transform.anchorY'
  | 'opacity' | 'crop.left'|'crop.top'|'crop.right'|'crop.bottom'|'crop.radius'
  | 'audio.volume'|'audio.pan'
  | `effect.${EffectInstanceId}.${ParamId}`
  | `text.${...}` /* letterSpacing, colour channels, mask progress, perUnit offsets (11) */
  | `transition.${...}`;
interface Keyframe { timeUs: number /* local */; value: number | [number,number,number,number] /* colour RGBA 0–1 */;
  interpolation: 'linear'|'hold'|'bezier'|'preset';
  easing?: { preset: 'linear'|'easeIn'|'easeOut'|'easeInOut'|'easeInCubic'|'easeOutCubic'|'easeInOutCubic'|'easeInBack'|'easeOutBack'|'easeOutBounce'|'easeOutElastic' };
  bezier?: { outX: number; outY: number; inX: number; inY: number };   // control handles for the segment AFTER this key (cubic-bezier style, x in 0–1)
}
```
- The **interpolation/easing on a keyframe governs the segment from that key to the next.**
- Properties without keyframes use the static value on the item. **One keyframe** on a property means a constant value (it overrides the static value).
- **Colour** properties interpolate in **linear-light premultiplied RGBA** (documented, tested) to avoid muddy mid-tones; hex shown in UI.
- **Rotation** uses plain numeric interpolation (shortest-path wrapping is **not** applied, so 0→720° makes two turns, as users expect). Documented in the tooltip.
- `hold` = step function (value jumps at the next keyframe). `bezier` uses the handles; `preset` maps a named easing to fixed handles (table in code with unit tests; `easeOutBounce/Elastic/Back` evaluate with closed-form functions, still deterministic).
- Values **outside** the first/last keyframe hold the nearest value (no extrapolation).
- **Speed changes** (`09 §4`, `speed`) affect the **timeline duration** of an item but keyframe times are in **item-local timeline time**, so animation speed does not change when the clip speed changes; trimming/splitting uses the continuity rule below.

### 2.3 Keyframe rules on editing the timeline (all tested)
| Edit | Keyframe behaviour |
|---|---|
| **Move** item | Keyframes move with it (local times unchanged) |
| **Trim start** | Keyframe times shift by the trimmed amount; keys before 0 are **removed**, but the **value at the new start** is evaluated and a **boundary keyframe is inserted at 0** with that value and the incoming easing so the visuals are unchanged |
| **Trim end** | Keys beyond the end are removed; a boundary key at the new end is inserted with the evaluated value |
| **Split** | Each half gets the keys inside its range **plus boundary keys** with the evaluated value at the cut; the animation is visually continuous across the cut |
| **Duplicate / paste** | Keys copied as-is |
| **Speed change** | Keys unchanged in local timeline time; if the user checks "Scale animation with speed" they are scaled by the speed ratio |
| **Extend (reveal more source)** | Static end value continues; no keys are added |

### 2.4 Auto-keyframing and direct editing
- **Keyframe diamond** per property row in the inspector (`08 §7.1`): click = toggle a keyframe at the playhead with the **current evaluated value**; **◀ ▶** jump to the previous/next keyframe of that property; stopwatch behaviour is **not** used (explicit diamonds only).
- When a property **already has keyframes** and the user changes it (inspector, preview handles `10 §8.10`, curve editor), a keyframe is **written or updated at the playhead** (frame-quantised). If the playhead is outside the item, the edit is blocked with a tooltip.
- When a property has **no** keyframes, an edit changes the static value; there is no accidental animation.
- **Delete last keyframe** → the property reverts to its static value, set to that last key's value.
- Every keyframe creation records the evaluated value at that time, so adding a key never changes the picture.

### 2.5 Keyframes on the timeline (`09 §17`)
Show/hide per item with the toolbar toggle; each animated property gets a **sub-lane** with diamonds. Diamonds: click selects, **drag** moves (snapping to frames, playhead, other keys, item edges; Alt bypasses), **Shift-click** multi-selects, **box-select** in the lane, **Ctrl/Alt-drag** duplicates, **Delete** removes, **Ctrl+C/V** copies/pastes keys (paste at the playhead, same properties; if the property differs the paste is refused with the reason), **double-click** opens the value popover. Diamond style: 8 px rotated square, `--brand` fill when selected, `--text-secondary` otherwise, with a small easing glyph on the segment bar between keys (linear / ease / hold / bezier).

### 2.6 Value popover and the curve editor
- **Value popover:** value field (with units), interpolation select (*Linear, Hold, Ease in, Ease out, Ease in & out, Bezier…*), time field (TimecodeField).
- **Curve editor** (a bottom drawer of the timeline, or a floating panel; toggle `Ctrl+Shift+C`): graph of the selected properties — X time, Y value (auto-fit, **normalised view toggle** to compare different units), keyframes as points, **bezier handles** (draggable, `Shift` mirrors, `Alt` breaks tangents), segment easing preset dropdown, **zoom/pan** (wheel, middle-drag), **fit selection**, playhead cursor, snapping (frame grid, other keys), multi-property overlay with per-property colours (muted, never orange; selection is `--brand`), numeric **copy/paste/mirror/reverse/scale-time/scale-value** tools for selected keys. Edits are transactions on release; Esc cancels.
- Handle x values clamp to 0–1 (no time reversal); y may overshoot.

### 2.7 Animation presets
A **Presets** menu per property group (position/scale/opacity/rotation) and in the Effects panel: *Fade in/out, Slide in/out, Zoom in/out (Ken Burns), Pan, Shake, Pulse, Spin* — each writes real keyframes relative to the item's start/end with parameters (duration, distance/amount, easing, direction) and can be re-edited. **Punch-in presets** (zoom 100→115% over 0.4 s, hold, optional return) are first-class for the AI emphasis feature (`13`). Text presets come from `11 §11.1` and use the same writer.

### 2.8 Limits and performance
Max 2,000 keyframes per property, 20,000 per composition (clear error beyond). `evaluate` is O(log n) via binary search with a per-property cursor cache for sequential frames. Evaluating 500 animated properties per frame < 1 ms.

---

## 3. EFFECTS

### 3.1 Architecture
- An **effect** is a registered module `{id, name, category, params: ParamSpec[], shader: GLSL, passes, requiresPrevFrame?: false}`; effect instances (`EffectInstance {id, effectId, enabled, params, keyframes}`) sit in an **ordered chain** on an item (`09 §4`); **adjustment-layer items** apply their chain to everything below them on the visible tracks within their time range.
- **Rendering:** each effect is one or more fragment-shader passes in `/packages/compositor/effects`, executed in a fixed colour pipeline: **sample → linearise (sRGB→linear) → effects chain → delinearise → transform/opacity** (so colour maths are consistent). The same GLSL runs in preview and export (export window, `14`).
- **ParamSpec:** `{id, label, type: 'float'|'int'|'bool'|'color'|'enum', min, max, default, step, unit, animatable}`. Effects UI is generated from ParamSpecs by a generic `ParamControl` (consistent with the inspector, `08 §7.1`).
- **Effect order** is user-controlled (drag to reorder; chain order matters and is documented); the panel's **Preview thumbnails** are rendered live on a sample frame (or the selected clip's frame at the playhead).
- Added from the **Effects panel** (click to add to selected item(s); drag onto a clip or onto the preview), or the inspector's *Add effect*. *Copy effects* / *Paste effects* between clips (`09 §12`).

### 3.2 Required effects and exact definitions
| Effect | Params (range, default) | Notes |
|---|---|---|
| **Brightness** | amount −1…1, 0 | Added in linear light × gain curve |
| **Exposure** | stops −3…3, 0 | Multiplies linear RGB by 2^stops |
| **Contrast** | −1…1, 0 | Around mid-grey pivot 0.18 linear (documented) |
| **Saturation** | 0…2, 1 | Luma-preserving (Rec.709 weights) |
| **Temperature** | −100…100, 0 | Warm/cool via blue–orange channel gains in linear space |
| **Tint** | −100…100, 0 | Green–magenta shift |
| **Sharpen** | amount 0…2, radius 0.5…3 px, 0.6 / 1 | Unsharp mask; radius scales with output resolution (relative to 1080 short side) so preview and 4K export match |
| **Blur (Gaussian)** | radius 0…100 px (relative to 1080 short side), 0 | Two-pass separable; clamped kernel for speed; **Directional/zoom blur** not in v1 |
| **Vignette** | amount 0…1, size 0.2…1.5, softness 0…1 | Radial darkening |
| **Crop** | `crop.*` (see `10 §8.6`) | Part of the item model, also exposed here |
| **Transform** | position, scale, rotation, anchor | Part of the item model |
| **Opacity** | 0…1, 1 | Part of the item model |
| **Speed** | 0.1…8× | Item property (`09`); optional *Ramp* via keyframes in v1 **not** supported (constant speed only; documented) |
| **Blend modes** | Normal, Multiply, Screen, Overlay, Add, Soft light | Item property |
| **Chroma key (optional, stretch)** | key colour, similarity, smoothness, spill | Not required for v1 acceptance; if built, must pass its own tests |
| **Colour LUT (.cube) (optional, stretch)** | strength | Stretch |
Each effect shows **Reset**, an **enabled** checkbox (eye), and **keyframe diamonds** on animatable params.
- Parameter ranges are validated; out-of-range loaded values are clamped with a log warning.
- **Colour space:** work in 8-bit sRGB with 16-bit float intermediate targets when available (`RGBA16F`), falling back to 8-bit; export uses `RGBA16F` where supported. A test checks no visible banding on a gradient fixture through a 3-effect chain.

### 3.3 Performance
Each additional full-frame effect pass costs ≲ 1.5 ms at 1080p on the reference machine; the UI warns ("This clip has many effects; preview may drop quality") beyond 6 passes on one item. Blur radius uses downsampling for large radii (documented, identical in export).

---

## 4. TRANSITIONS

### 4.1 Model (stored on the later clip of a junction, `09 §16`)
`Transition { id; type; durationUs; alignment: 'center'|'start'|'end'; params; easing }`, attached to the **incoming** item's `transitionIn` and, for fades to/from black at clip edges, `transitionOut`. A junction is two adjacent items on the same track (touching or overlapping by the transition).
- **Handles:** a transition needs source media beyond the cut. `durationUs ≤ min(outgoing available tail handle, incoming available head handle)` for `center` (each side contributes half), or the corresponding single-sided handle for `start`/`end`. The engine clamps and the UI shows the limit; with no handles only **fade/dip** types are offered (`09 §28.14`). Invariant 9 of `09`.
- Attach by dragging from the Transitions panel onto a junction (a `--brand` drop indicator), by selecting a junction and clicking a preset, or **Apply to all cuts** (bulk action with the selected preset and duration for the main track).
- Adjusting: drag the transition block's edges to change duration (symmetrical for `center`), drag the block to change alignment, or edit in the inspector (type, duration, alignment, direction, easing). A transition **survives** trim/move/split of its clips and is re-clamped (never silently deleted; if impossible it is flagged "Not enough footage" and renders as a cut + shown in red until fixed, with a toast).

### 4.2 Required types (all GLSL shaders mixing outgoing `A` and incoming `B` with progress `p = ease(u)`)
| Type | Definition | Params |
|---|---|---|
| **Crossfade** | `mix(A, B, p)` | — |
| **Dissolve** | noise-thresholded mix (deterministic noise texture, fixed seed) | grain size |
| **Fade to black / Fade from black** | `A→black` / `black→B` at the edges or as a dip pair | colour (black default, white option) |
| **Dip to colour** | A→colour→B | colour, hold % |
| **Wipe** | linear reveal along a direction with soft edge | direction (L/R/U/D/diagonals), softness |
| **Slide** | B pushes A (or B slides over A) | direction, mode (push / cover / reveal) |
| **Zoom** | A zooms in/out while crossfading into B | direction (in/out), amount |
| **Spin/Blur-zoom (stretch)** | optional | — |
Easing options use the keyframe easing presets (`§2.2`). A transition between a clip and **empty space** acts as a fade of that clip to/from transparent.
- **Audio during a video transition:** linked audio gets an **equal-power crossfade** over the same range by default (toggle "Crossfade audio" on the transition; off = cut). Standalone audio items get their own fades (`§6.3`).
- Transitions between **overlay items** and on **text/caption items** are not transitions: those use item in/out animations (`11`, `12 §2.7`).

---

## 5. SPEED AND TIME REMAPPING
- Constant speed 0.1×–8× per video/audio item (`09 §12`). Video at slow speed duplicates frames (nearest-frame sampling by default; **frame blending** option `Smooth slow-motion: Off / Blend`) and audio is time-stretched (`atempo` chain for export; `10 §7.4` for preview).
- **Freeze frame** (`Ctrl+Shift+F`): splits at the playhead and inserts a still image item of the current frame (rendered from the same frame pipeline) of a chosen duration (default 2 s), ripple per edit mode.
- **Reverse** is out of scope for v1 (listed in `docs/limitations.md`).

---

## 6. AUDIO SYSTEM

### 6.1 Architecture
1. **`/packages/audio-core`** is pure TypeScript (+ a small WASM/Node DSP where needed): **envelope evaluation** (volume/pan keyframes + fades + ducking → per-sample gain curve), **mixing**, **loudness analysis** (EBU R128 integrated/short-term/true-peak using a tested implementation, or ffmpeg `ebur128` in a worker), **peak/RMS metering**, **ducking analysis**. Used by export (`14`) and by the preview worker; the preview's Web Audio automation is generated **from the same envelope function** (`10 §7.1`).
2. **Audio is rendered for export by our mixer, not by ffmpeg filter-graph guesses:** for each audio-bearing item, decode the needed source range with ffmpeg to **float32 PCM, 48 kHz, stereo** (applying speed via `atempo` chain and trimming), apply the item's gain envelope per sample, pan, fades, track volume/mute/solo, ducking envelope, then sum into the master with a final **safety limiter** (default on: look-ahead true-peak limiter at −1 dBTP; toggle off in export settings) and stream the result to the encoder (`14`). Tested against a reference mix for gain accuracy (§9).
3. **Linked audio** (`09 §4` link groups) is edited with its video: move/trim/split together; unlinked by *Ctrl+Alt* selection or the context menu (*Unlink*), **detach audio** (*Extract audio to a track*) creates a separate audio item and mutes the video's embedded audio (undoable).

### 6.2 Audio properties and controls (inspector Audio section; `08 §7.2`)
- **Volume** in **dB** (−60…+12, 0 default) with a fader; "mute". Internally linear gain = 10^(dB/20); −∞ at −60 (clamped to silence).
- **Gain** (clip gain, −24…+24 dB) vs **Volume** (post-fade level): *Gain* is applied before fades and is intended for static level matching; *Volume* is keyframeable. (Both shown; tooltip explains.)
- **Pan / Balance** (−100…100) for stereo; mono sources are placed with constant-power pan.
- **Mono/Stereo handling:** a mono item is duplicated to both channels; multi-channel (5.1) sources are down-mixed with the standard ITU coefficients on decode; documented.
- **Fade in / Fade out:** durations (frame-quantised) with a curve (**Linear, Equal-power (default), Exponential**); drag the **fade handles** at the top corners of the audio clip on the timeline (`09 §10`), shown as a drawn curve over the waveform.
- **Audio keyframes** for volume and pan (`§2`), drawn as a **volume line** across the clip on the timeline (drag the line to move keys; Alt-click on the line adds a key) with snapping; the line shows 0 dB reference.
- **Mute/Solo/Lock/Hide per track and per clip** (`09 §9`); solo overrides mute on others during preview **and export** only if "Include solo state in export" is on (default off → export ignores solo, honours mute; stated in the dialog).

### 6.3 Waveforms and meters
- **Waveform display** on audio clips and video clips with audio (`09 §19`): peaks from `peaks.bin` (`04 §6.4`), drawn with the clip's current gain/volume curve (the waveform reflects the envelope) in a muted track colour; toggle in the timeline toolbar.
- **Meters:** master **stereo peak meter** in the transport bar (`10 §3.2`) with −60…0 dB scale, peak hold (1.5 s), clip indicator that latches until clicked; **per-track meters** in the track headers when headers are wide enough. Meters update at 30 Hz from an `AnalyserNode` in preview. **Loudness readout** (momentary LUFS) shown in an *Audio meters* popover; integrated LUFS is reported after normalisation analysis and in export validation (`14 §7`).

### 6.4 Trimming, splitting, synchronisation
- Trimming/splitting audio uses the same rules as video (`09 §12`, sub-frame source in-points allowed for audio-only items). Splitting a clip with fades puts a fade-out/in of **2 frames** at the cut by default to avoid clicks (setting "Click-free edits", default on); fades the user set on the original outer edges are preserved.
- **Sync tools:** *Nudge audio ±1 frame / ±1 ms* (hold Alt for ms) for per-item **sync offset** (item property `audioOffsetUs`, can be negative, applied without moving the video), and **Sync to clap/peak (stretch)**: optional automatic alignment of two clips by cross-correlation of their audio (e.g. external recorder to camera audio), `Edit → Sync audio` — marked **stretch**; if built, it must be tested with fixtures offset by a known amount (±1 frame accuracy).
- The relationship between audio and its video is preserved when clips are moved, trimmed or split (linked selection, `09`).

### 6.5 Multiple tracks, voiceover, music, SFX
- Default audio tracks (`09 §5.2`): *Original audio*, *Music*, *SFX*; users can add unlimited audio tracks (to the track limit). Track **roles** (`voiceover`, `music`, `sfx`) set colour (`01 §3.6`) and the default ducking roles (§6.7).
- **Audio library** (Audio panel): user-added audio (imported through `04 §7`), organised in the project/workspace *Music* and *Sound effects* collections with search, tags, duration, hover audition (play button + scrub), **Add at playhead / drag to timeline**. **No bundled copyrighted music.** A small set of **self-made, licence-clean SFX** (clicks, whooshes, pops, risers generated synthetically by the team with documented provenance in `docs/licences.md`) may ship; if the team cannot guarantee licence cleanliness, ship none and state "Import your own sound effects" in the empty state.
- **Voiceover recorder:** *Record* button in the Audio panel (and a mic icon on audio track headers) using `getUserMedia` after the **explicit Windows/Chromium mic permission**; device selector, input level meter, **3-2-1 count-in** (optional), record **at the playhead onto the armed track** (arm = track header toggle), **monitoring** with headphones warning, **punch-in** (re-record a selected range), takes saved as **48 kHz WAV** in `Media/` (managed, `04 §7`) and placed as audio items; Esc discards, Space stops. Recording never starts without an explicit click; the permission/denied state is explained plainly; no recording indicator is hidden. Video playback during recording is muted unless "Play project audio while recording" is on (default on with headphones warning).

### 6.6 Loudness normalisation
- **Normalise clip** (inspector → Enhance): analyses integrated loudness of the item (ebur128 on the decoded range, progress + cancel, cached by `(mediaId, range, speed)`) and sets the **gain** to reach a target (**−16 LUFS** default for speech-led short-form; presets −14 / −16 / −23 with explanations, user-editable); never exceeds a true-peak ceiling of −1 dBTP (reduces gain if needed and says so).
- **Normalise project** (Export dialog option, `14 §3`): measures the **mixed** result and applies one master gain to reach the target; shows measured before/after. Does not alter any item.
- All normalisation writes **visible gain values** the user can undo/edit (never a hidden processing step).

### 6.7 Ducking (music under speech)
- **Auto-duck** on a track (track header menu or Audio panel): *Duck this track when [Original audio / Voiceover / selected tracks] has speech*. Inputs: the **trigger tracks' post-gain signal** (or the transcript word ranges when available, for speech detection without audio analysis); algorithm: compute a **speech-activity envelope** from the trigger audio (RMS in 20 ms windows with hysteresis: attack 120 ms, release 400 ms, threshold −42 dBFS adjustable), map to a **ducking envelope** (default −12 dB, adjustable −3…−24; smoothing identical for all uses) and **store it as a derived envelope** on the ducked track (visible as a faint overlay and editable by the user as a keyframe line once *Bake to keyframes* is clicked). The ducking envelope is **recomputed (debounced 500 ms) when items move**, deterministically, and **used identically by preview automation and export mixer** (no real-time side-chain). It is **off by default** and never applied silently.
- Off per item/track; *Bake to keyframes* converts it into editable volume keyframes (undoable).

### 6.8 Noise reduction and enhancement (offline, non-real-time)
- **Reduce noise** (Enhance section) runs as a **background job** (`04 §9`, type `audio_enhance`) that renders a **derived, denoised copy** of the item's source range (`Media/<id>/enhanced/<hash>.wav`) using the best available bundled method: **RNNoise via ffmpeg `arnndn`** (with a licence-checked bundled model) when available, otherwise ffmpeg `afftdn` with a conservative profile; strength Low/Medium/High; A/B toggle (original vs enhanced) in the inspector; **never destructive** (the item points to the derived file; *Revert* restores the original). Progress, cancel, caching, and a plain warning "Noise reduction can affect voice quality; compare before using".
- Optional stretch (not required): **De-ess**, **Voice isolation**. Do not claim studio-quality results.
- **Click-free** and **DC-offset** cleanup are always applied silently at decode (document).

### 6.9 Audio-only and image-only items
- Audio-only items have no preview image: the timeline clip shows the waveform; the preview shows nothing for them. A project with **only audio** is allowed (canvas background shown; export audio-only as `.m4a`/`.mp3`? Not required: v1 exports video only — an audio-only composition exports as a video with the canvas colour, stated in `docs/limitations.md`).

---

## 7. LINKS
Keyframes ↔ `08` inspector diamonds, `09 §17`, `10 §8.10`, `11 §11.1`; effects/transitions ↔ compositor (`10`), export (`14`); audio ↔ timeline waveform (`09 §19`), preview audio (`10 §7`), export mixer (`14 §5`), recording → `04 §7`; ducking/normalisation → `13` (one-click "Enhance audio"); decode/peaks → `04 §6`.

---

## 8. EDGE CASES
Keyframes on a property of a deleted effect (removed with it) · effect param removed in a newer version (ignored, preserved in payload) · keyframe at exact item end (allowed, last frame) · two items' transitions overlapping the same clip (blocked: one transition per edge) · transition on the first/last clip of the main track (fade from/to black only) · crossfade where handles differ on each side (clamp to the smaller; alignment `start`/`end` offered) · speed change after a transition (re-clamped) · audio with no samples at the start (silence padded) · very quiet source normalisation (gain capped at +24 dB with a warning) · clipping already present in the source (reported in meters, never "fixed" silently) · mono vs stereo mixed on one track · 1000+ volume keyframes (decimation display only; evaluation exact) · recording device removed mid-take (stop, keep what was recorded, toast) · sample-rate mismatch (all converted to 48 kHz at decode) · muted track with ducking sources (ducking uses the pre-mute signal only if "Use muted track as trigger" is on; default off) · exporting while a noise-reduction job runs (waits or uses the original, asked) · preview audio buffer underrun (brief silence + a log entry, never a crash).

---

## 9. TESTING AND ACCEPTANCE

**Unit/property tests:** `evaluate` for every interpolation/easing (golden values at 21 sample points each), hold/bezier/preset segments, colour interpolation in linear light, boundary-key insertion on trim/split (visual continuity: value before and after the cut equal within 1e-9), keyframe moves/duplicates/paste, limits, envelope generation (volume + fades + pan + ducking), equal-power fade identity (`a² + b² = 1`), mixer gain accuracy, limiter ceiling, normalisation target, speed `atempo` chain factors, transition clamping and handle maths, round-trip inverse for every keyframe command.

1. Every property in §2.2 can be keyframed from the inspector, the preview handles and the timeline lane; adding a key never changes the picture; deleting the last key restores a static value.
2. Keyframe editing on the timeline: select, box-select, drag with snapping, duplicate, copy/paste, delete, easing glyphs; trimming/splitting/moving/speed-changing clips keeps animation correct (automated checks on `§2.3`, plus a visual frame comparison before/after a split).
3. Curve editor: bezier handles, presets, mirror/break, fit, multi-property overlay; edits are single transactions; Esc cancels.
4. Animation presets (*Fade, Slide, Zoom/Ken Burns, Pan, Shake, Pulse, Spin, Punch-in*) write editable keyframes; two exports of the same project have identical frame hashes (determinism).
5. All required effects (§3.2) behave per definition (numeric tests on test charts: e.g. exposure +1 stop doubles linear values; saturation 0 = Rec.709 luma); chain order matters and is reorderable; adjustment layers affect only the tracks below within their time range; copy/paste effects works; 6+ passes show the warning.
6. Effects are **resolution-independent**: a blur radius and sharpen radius at 4K export match the 1080p preview scaled (SSIM ≥ 0.99 after rescale).
7. Transitions: all required types attach at junctions, resize/re-align, clamp to handles, survive trim/move/split, show "Not enough footage" when impossible, apply-to-all-cuts, audio equal-power crossfade on/off.
8. Audio: volume/gain in dB, pan, fades (3 curves) with drag handles, volume line keyframes, waveform reflects envelope, meters (peak hold, clip latch), mute/solo (export honours mute; solo per setting), split/trim/link behaviours, click-free edits.
9. **Preview vs export audio parity:** the preview's rendered output (captured via an offline audio context run of the same graph) and the export mix match within **0.5 dB RMS** per 100 ms window on a 3-track fixture with fades, pan, keyframes and ducking.
10. Normalisation: clip and project targets hit −16 LUFS ±0.5 LU (verified by an independent ffmpeg `ebur128` pass); true-peak ceiling respected; written as visible, undoable gain.
11. Ducking: music drops by the configured amount within the attack time under speech and recovers within the release time (measured on a synthetic fixture); recomputes after moving clips; *Bake to keyframes* yields identical audio.
12. Voiceover: permission flow, device select, count-in, record, punch-in, take saved as 48 kHz WAV and placed on the armed track; denied permission and removed-device cases handled with plain messages.
13. Noise reduction: runs as a background job with progress/cancel, A/B toggle, revert; measurable noise-floor reduction on a noisy fixture (≥ 6 dB lower in silent segments) without clipping.
14. Everything above survives **save → close → reopen** and `.cwpack` round trips identically (`03` check 8).
15. Visual review against `01`: curve editor, fades, volume line, meters use tokens; track colours distinct from `--brand`; no AI-look items.
