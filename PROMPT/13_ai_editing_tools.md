# SPEC 13 — AI EDITING TOOLS (WITH TIERS) AND BRAND KITS

**Binding.** Follows the structure of `specs/09`. Related: `05` (transcript, fillers), `06` (providers, ONNX models, consent), `07` (moments), `08` (AI tools tab), `09` (commands), `10` (framing), `11` (captions, emphasis), `12` (keyframes, audio), `04 §9` (jobs).
Code: `/packages/ai-core/editing` (tools), `/packages/ai-core/vision` (detection/tracking), `/packages/timeline-engine` (the **commands** the tools issue), UI in `/apps/desktop/src/renderer/features/ai-tools`.

---

## 1. PURPOSE

Speed up the boring parts of editing with tools that are **useful, honest and fully reversible**. Every tool is a **proposal** the user can preview, adjust, apply as ordinary editing commands (one undo step per applied tool), and fully modify afterwards. No tool locks the user into an AI decision (master §8).

---

## 2. TIERS (binding order of work)

| Tier | Meaning | Tools |
|---|---|---|
| **CORE** (required for v1 acceptance, built in Phase 5) | Must work, be tested and documented | 1 **Edit by transcript** (includes one-click filler-word removal) · 2 **Silence removal** · 3 **Auto-reframe** · 4 **Auto emphasis** (keywords + punch-ins) · 5 **Brand kits** |
| **STRETCH** (build only after all CORE tools and Phase 6 checks pass; each must pass its own checks or be removed from the UI) | Nice to have | 6 **Enhance audio** (one-click normalise + noise reduction + optional ducking, composed from `12`) · 7 **Title, hook, description and hashtag suggestions** (LLM) · 8 **Auto zoom (punch-ins) without captions** · 9 **Chapters/progress-bar overlay** · 10 **Auto-sync external audio** (`12 §6.4`) |
| **LATER** (not in v1; **no UI, no mention in the app**; listed in `docs/limitations.md` roadmap) | Needs new infrastructure | Offline **speaker diarization** and speaker-aware layouts · **Caption translation** and multi-language tracks · **AI voice / dubbing** · **Background removal / chroma without a key** · **B-roll suggestion** · **Multi-speaker split-screen auto layout** |
Rule: a LATER or unfinished STRETCH tool is **never shown** in the UI as a disabled "coming soon" teaser. Marking an incomplete feature as complete is forbidden (`00 §2.1`).

---

## 3. COMMON ARCHITECTURE FOR EVERY TOOL (mandatory)

1. **Tool interface**
```ts
interface AiEditTool<P, R> {
  id: string; title: string; requires: Requirement[];     // 'transcript' | 'llm' | 'onnx:<model>' | 'audio' | 'video'
  analyse(input: ToolInput, params: P, signal, onProgress): Promise<R>;     // pure analysis → a PROPOSAL (data), no timeline change
  toCommands(proposal: R, composition: Composition, options): Command[];     // proposal → engine commands (09 §2.3)
  describe(proposal: R): string[];                                           // human summary lines
}
```
2. **Two-step flow in the UI** (the same for all tools): **Analyse** (job with progress/cancel, `04 §9`) → **Review panel** (a list/preview of what will change, each proposed change with a **checkbox**, a **preview** button, and tool parameters adjustable with **instant re-evaluation** where cheap) → **Apply** (executes `toCommands` as **one transaction**, one undo step, toast "Applied — Undo") . **Nothing changes the timeline during Analyse.**
3. **Scope selector** on every tool: *Selected clip(s)* (default if selection exists) · *This clip (whole composition)* · *Selected range (work area)*.
4. **Requirements and honesty:** `requires` is checked by `resolveProvider`/model checks (`06`); a tool whose requirement is missing is shown **enabled but explains**: "Needs a language model: install one (offline) or add a provider (online)" with the fix buttons; never a fake result. Offline vs online label on every tool (`06 §4.4`). **Online use sends only transcript text/numbers**, with the consent dialog (`06 §8`).
5. **No hidden state:** tool results are stored in the composition only as the ordinary items/keyframes/markers they create (plus a small `aiProvenance` note on created items `{tool, version, appliedAt}` shown in the inspector as "Created by <tool>"). Re-running a tool on already-processed material first offers *Replace previous result* (revert and redo) or *Run again on top*.
6. **Determinism:** non-LLM tools are deterministic for the same input and parameters (unit-tested). LLM tools use fixed temperature/seed where supported and always have a heuristic fallback (`07 §4.4`) or a clear failure state.
7. **Performance:** every analysis runs in a worker/utility process with cancel; UI never blocks (`00 §7`).

---

## 4. TOOL 1 — EDIT BY TRANSCRIPT (CORE)

### 4.1 What it is
A panel that shows the composition's transcript text (words from the clip's range, with the clip's **speed/trim** applied) where **deleting words deletes the corresponding video and audio** and closes the gap — "edit video by editing text".

### 4.2 UI (AI tools tab → *Edit by transcript*, also a docked mode of the transcript panel)
- Word-level text view of the current composition's **main video** range: current word highlighted during playback; click a word = seek; **drag/Shift-click** selects a range; deleted words shown **struck-through and dimmed** (still listed; click *Restore* to bring back); **filler words** underlined faintly; **pauses ≥ 0.4 s** shown as small `·` chips (clickable to delete the pause).
- **Selection toolbar:** *Delete* (Del/Backspace), *Restore*, *Keep only selection* (deletes everything else), *Delete all filler words* (uses the `filler` flag, `05 §10`; shows a count and a **preview list** of fillers with checkboxes first), *Delete pauses longer than [0.5 s ▾]* (scans pauses and shows the count).
- **Live preview:** deletions are shown as **pending edits** (a lightweight overlay model); playing the preview **skips deleted ranges seamlessly** (the preview applies the cut list virtually). **Apply cuts** commits them to the timeline; until then nothing is changed in the composition. Auto-apply setting: *Apply immediately* (each delete commits at once as its own undo step; default **off**).
- Cut quality settings: **Padding** around each cut (default 40 ms of kept audio before/after word boundaries to avoid clipped consonants), **Audio crossfade** at joins (default 2 frames equal-power), **Snap cuts to the nearest frame**.

### 4.3 Algorithm
1. Map each deleted word range to **source time** → merge adjacent/overlapping deleted ranges, extend by padding (never into a kept word's body: clamp to the midpoint of the gap between a deleted and a kept word).
2. Convert to **timeline ranges** (through speed/trim). Quantise to frames: start rounds **down**, end rounds **up** to avoid clipping words (cuts are expanded by at most 1 frame each side).
3. Emit commands (all in one transaction): for the video item **and its linked audio** (and any items in the scope that are *not* locked): `splitAt(range.start)`, `splitAt(range.end)`, `rippleDelete(rangeItems)` honouring **ripple-all-tracks** per the user's toggle (default for this tool: **ripple all unlocked tracks** so overlays, music and captions keep their relation; shown in the review panel so the user can change it). Captions are regenerated for kept words (`05 §11`), preserving manually edited captions per `11 §9` (badge, not overwritten).
4. At each join, apply the configured **audio crossfade** and optional **video micro-cut smoothing** (a 2-frame crossfade; off by default, since hard cuts are normal for talking-head shorts).
5. Add **timeline markers** "Cut" at each join (so the user can find and tweak them; togglable).
6. Keyframes: items split/trimmed per `12 §2.3` (continuity preserved).

### 4.4 Rules and edge cases
- Deleting a **partial word** is not possible (words are atomic); to split a word use the transcript editor (`05 §9.3`) first.
- **Approximate-timing words** (`approximate: true`) show a warning chip "timing approximate — cuts may clip speech"; padding for these is doubled.
- Deleting words that span a **hidden/locked** item's range: locked items are untouched (reported); in *ripple all* mode a locked track in range **blocks** the apply with a message (`09 §28.10`).
- A transcript with **edits** is respected (edited words keep the original timing).
- **Undo** restores everything (the transcript's deleted-state is part of the composition's edit-by-transcript state so undo/redo and the panel stay in sync).
- Filler detection languages: those with `/assets/fillers/<lang>.json`; other languages show "Filler list not available for <language>" and hide the button.

### 4.5 Acceptance (see §10)
Cuts never clip speech (measured on a fixture: boundary speech energy preserved), A/V sync after cuts < 1 frame, one undo step, ripple behaviour correct on all tracks.

---

## 5. TOOL 2 — SILENCE REMOVAL (CORE)

### 5.1 Behaviour
Finds silent or dead-air sections and removes or shortens them, with a visual review.

### 5.2 Detection
- Input: the composition's main audio (post-gain, pre-music) decoded from the **source range** at 16 kHz mono (reuse `audio16k.wav` when the item is the unmodified source, else decode the range).
- **Voice-activity based, not just level-based:** compute RMS in 10 ms frames; a frame is *silent* if below the **threshold** (default **−38 dBFS**, adjustable −60…−20 with a **live waveform overlay** showing detected silences in a muted colour on the timeline) **and** (when a transcript exists) contains **no word** (words override level: speech with low level is never cut). A silent region must last **≥ minimum duration** (default **0.5 s**, 0.2–3 s) to count.
- **Padding:** keep **120 ms** (0–500 ms) of silence on each side so cuts sound natural.
- Modes: **Remove silences** (ripple delete) · **Shorten to N s** (keep at most N seconds of each silence, default 0.25 s) · **Speed up silences** (stretch only; **not in v1**).
- A **minimum-keep rule**: never produce a kept segment shorter than **3 frames** (merge instead).

### 5.3 UI
Sliders (threshold, minimum duration, padding) with **live count + total time saved** ("12 silences, −8.4 s"); a list of detected silences (time, length, checkbox, *Play around*); *Preview* skips them virtually (as §4.2); *Apply* issues the same cut machinery as Tool 1 (shared `applyCutList`, including ripple/links/captions/markers).
- Works on **music-only/no-speech** sources by level only, with a notice.
- Background noise floor estimation: **Auto threshold** button measures the noise floor (the 10th percentile of frame RMS) + 6 dB.

### 5.4 Edge cases
Breaths between words (padding keeps them) · very noisy audio (Auto threshold; warn if SNR is low) · music bed under silence (analysis uses the **speech track only**: the user can choose the analysed track) · multiple audio streams (uses the project's chosen stream, `04 §5`) · zero silences found → "No silences longer than 0.5 s were found" with the sliders still adjustable.

---

## 6. TOOL 3 — AUTO-REFRAME (CORE)

### 6.1 Goal
Convert a landscape (or any) source into the chosen canvas (typically 9:16) by **keeping the subject in frame** with smooth virtual camera movement, implemented as ordinary **crop/position/scale keyframes** on the video item (so the user can adjust everything).

### 6.2 Detection (offline, bundled)
- **ONNX Runtime** (Node, `onnxruntime-node`) with a bundled, permissively licensed **face detector** (e.g. YuNet or BlazeFace-class; licence verified and recorded in `docs/licences.md`) and a bundled **lightweight saliency/person fallback** if licensing allows; models live in `Models/onnx/` or the installer (`06 §7.4`). **No cloud calls.** If no model can be shipped for licensing reasons, fall back to §6.4 and state it.
- Sampling: analyse frames from the **proxy** at **5 fps** (10 fps for fast content, option), batch inference; run per **shot** (scene cuts from `07 §4.3` or a fresh `select='gt(scene,0.3)'` pass) so the virtual camera **resets at cuts**.
- Per sampled frame: face boxes (+ landmarks if available); confidence threshold 0.5. **Subject selection** within a shot: the **largest/most persistent face**; when several faces exist, prefer the face that is **speaking** (if transcript speaker/lip-activity heuristics are available; v1: the face with the highest **mouth-region motion** between frames when available, else the largest) with a **UI to choose the subject** (click a face in a thumbnail strip per shot).

### 6.3 Camera path
1. Convert subject centre per sample to a **target crop centre** (rule of thirds optional: eyes at ~38% from the top for portrait crops).
2. **Smooth** with a critically damped spring / One-Euro filter (parameters: *Smoothness* slider Low/Medium/High, default Medium) with a **dead-zone** (the camera doesn't move while the subject stays within the central 20% of the crop) to avoid jitter; limit pan speed (max 25% of crop width per second) and acceleration; cuts reset instantly.
3. **Crop size:** the **minimum scale that fills the canvas** (cover) with optional extra *Headroom/Zoom* (100–130%). The crop never exposes empty canvas (clamped at the source edges).
4. Reduce keyframes: simplify the path with Ramer-Douglas-Peucker (tolerance 1.5 px at the canvas scale) so the result has a **manageable number of keyframes** (cap 8 per second, merged to ≤ 400 per clip) written to `transform.x/y` (and `scale` where zoomed), with `easeInOut` segments — **editable keyframes**, not a baked video.
- **Run time budget:** ≤ 0.5× real-time on the reference machine for 1080p (i.e. a 10-minute source analyses in ≤ 5 min), progress and cancel.

### 6.4 Fallbacks
- No face found in a shot → **saliency** (if model) else **static centre** with the user's `initialFraming` (`02 §4.3`); the review panel marks such shots "No subject found — using manual framing" and lets the user drag-set the framing for that shot (`10 §8.6`).
- Screen recordings / slides: detect as low-motion non-face content → keep centre/initial framing (option *Content type: Screen/slides* disables face tracking).
- Source already matching the canvas ratio → tool explains "Nothing to reframe" (offers a zoom-only mode).

### 6.5 UI
Review panel shows a **filmstrip per shot** with the detected subject box and the resulting crop rectangle, **Subject** picker, **Smoothness**, **Headroom**, **Mode: Follow face / Follow saliency / Fixed**, and a **Preview** that plays with the path applied virtually. **Apply** writes the keyframes onto the main video item (and linked ones) as one transaction; *Remove auto-reframe* reverts to the item's static framing.
- Also runs automatically after clip creation when the start-page / project setting "Auto-reframe" is on (`07 §10.2`) as a **background job**; the clip is usable immediately and the keyframes are applied when ready as **one undo step** with a toast (never while the user is mid-gesture: queued until idle).

---

## 7. TOOL 4 — AUTO EMPHASIS (CORE)

### 7.1 What it does
Marks **keywords** in captions (for highlight styles, `11 §5` #3/#7) and optionally creates **punch-in zooms** on emphasised moments.

### 7.2 Keyword selection
- **With an LLM** (`06`): send caption text (per chunk of ~40 captions) with a strict JSON schema (`{captionId, wordIndices[]}`) asking for the **1–2 most important words per caption** (numbers, names, strong verbs/nouns, contrast words), max 25% of words per clip; zod validation, repair/retry and heuristic fallback as in `07 §4.4`.
- **Heuristic (always available, offline):** score words by: numbers/currency/percent, capitalised mid-sentence words (names), words with high IDF relative to the transcript (rare words), emphasis from loudness peaks on the word's span (from the audio features in `07 §4.2`), negations/intensifiers ("never", "always", "free", "secret"); exclude stopwords (language list in `/assets/stopwords/<lang>.json`); keep 1–2 per caption with a minimum spacing of 2 words. Results are deterministic.
- The result is stored as **`wordOverrides.emphasis`** on caption words (`11 §7`) so the user can toggle individual words afterwards and switching caption styles keeps emphasis.

### 7.3 Punch-ins (optional checkbox)
For selected emphasised words (top ~1 per 6 s, spacing ≥ 4 s, only on the main video, never across cuts), write **scale keyframes** (100% → 110–118% over 0.25 s, hold the word duration, ease back over 0.25 s; *Zoom intensity* slider; centre = subject framing/canvas centre) using the preset from `12 §2.7`. Preview lists each punch-in with a checkbox. Never applied to clips with auto-reframe moving fast (the review warns about stacking scale keyframes and offers to combine as relative scale).

### 7.4 UI
Review list of captions with the proposed keyword words highlighted (click a word to toggle), counts, *Re-run with LLM / heuristic*, *Select emphasis colour* (default from the caption style), *Apply*. Reversible: *Clear emphasis*.

---

## 8. TOOL 5 — BRAND KITS (CORE)

### 8.1 What a kit is
A reusable bundle applied to one clip or many (batch, `08 §8.1`). Stored in `<workspace>/BrandKits/<kitId>/kit.json` + assets; managed in **AI tools → Brand kit** and Settings → Brand kits.
```ts
interface BrandKit { format:'cwbrand'; formatVersion:1; id; name;
  colors: { primary; secondary; accent; background; text; /* + up to 8 custom */ };
  fonts: { heading: FontRef; body: FontRef; caption: FontRef };           // FontRef as in 11 §10
  captionStyleId?: string; captionOverrides?: StyleOverrides;             // default caption look
  logo?: { assetId; position: 'tl'|'tr'|'bl'|'br'|'custom'; xPct; yPct; sizePct; opacity; margin; showFrom: 'start'|'always'|{atSec}; showFor?: seconds|'whole' };
  watermark?: { /* same shape, usually semi-transparent */ };
  intro?: { assetId|compositionTemplateId; durationSec };  outro?: { … };
  lowerThird?: { templateId; fields: {name?; role?}; showAtSec; forSec };
  textDefaults?: { titleStyle; subtitleStyle };
  audio?: { musicAssetId?; musicVolumeDb; duckUnderSpeech: boolean; normaliseTargetLufs? };
  safeAreaPreset?: 'tiktok'|'reels'|'shorts'|'none';
}
```
### 8.2 UI
- **Kit list** (cards with colour swatches, logo, caption look), **New kit** (from scratch or *from the current clip*: captures the used caption style, fonts, colours, logo/text items on selected tracks), **Edit** (form with the fields above; logo/intro/outro pickers use the media library; colour picker with recent colours and *Pick from logo* — samples dominant colours via k-means on the logo image), **Duplicate**, **Export/Import** (`.cwbrand` zip with assets; licence/font warnings as in `03 §10.5`), **Delete** (confirm).
- **Apply kit** to: *This clip* · *Selected clips* · *All clips* (batch with progress, `08 §8.1`) with checkboxes for **what to apply** (Captions style, Logo/watermark, Intro/outro, Lower third, Music + ducking, Fonts/colours for text items) and a before/after preview. Applied as **ordinary items/styles** (logo = image item on a graphics track, with a locked-aspect transform; intro/outro = clips inserted at start/end per the edit mode; captions = style assigned, manual caption overrides skipped unless ticked). Items created get `aiProvenance: {tool:'brand-kit', kitId}` to enable **Reapply** (remove previously kit-created items and apply the new version) and **Detach from kit**.
- **Default kit:** a kit can be set as default; the start page's caption style card shows it and new clips use it automatically (`02 §4.4`, `07 §10`).
- **Safe-area aware:** logo positions respect the selected safe-area preset (`10 §9`).

### 8.3 Rules and edge cases
Kit with a missing font → substitute and flag (`11 §10.2`) · logo with transparency · intro longer than the clip (allowed) · applying a kit to a clip with a different aspect → positions are percentages, so adapt; **intro/outro assets in the wrong aspect** → fit with the canvas fill option and a warning · a kit applied twice (Reapply replaces) · deleting a kit leaves applied items untouched (they are ordinary items; the provenance link becomes "kit removed") · the kit's music asset missing → skipped with a report.

---

## 9. STRETCH TOOLS (specification stubs; build only after CORE + Phase 6)

6. **Enhance audio:** one panel button composing `12 §6.6–6.8`: *Normalise + Reduce noise (Medium) + (optional) Auto-duck music*, with an A/B toggle and a summary "Loudness −21.4 → −16.0 LUFS; noise −9 dB". Acceptance: each constituent passes its `12` checks; the combined action is one undo step per item.
7. **Title/hook/description/hashtag suggestions (LLM):** from the clip's transcript produce 5 title options, 3 hook lines (first sentences; can create a **hook text overlay** for the first 3 s on request), a short description, and hashtags. Requires an LLM (`06`), shows the provider/locality, copyable results, no auto-posting. Hashtags are suggestions only. Never claims reach/virality.
8. **Auto zoom without captions:** punch-ins from audio emphasis peaks only.
9. **Chapters / progress bar:** transcript topic segmentation (LLM or heuristic) → markers and optional on-screen progress bar overlay.
10. **Auto-sync external audio:** `12 §6.4`.
Each STRETCH tool, if built, must follow §3 and have acceptance checks recorded in `docs/verification.md`; otherwise it is **absent from the UI**.

---

## 10. UI: THE "AI TOOLS" TAB (`08 §4`)
- A list of **tool cards** (icon, name, one-line description, status chips: *Offline* / *Needs model* / *Online*, last-run note). Clicking opens the tool's **review panel** in place (back arrow returns to the list).
- A top strip shows **"AI mode: Offline | Online | Automatic"** with the provider/model that tools will use (`06 §4.4`).
- A **Running jobs** line shows analysis progress with Cancel.
- Consistent empty/failed states: plain messages with fix buttons (install Ollama, add provider, download the face model), never a spinner that never ends.

---

## 11. EDGE CASES (all tools)
Composition with no transcript (Edit-by-transcript and Auto emphasis disabled with a "Transcribe first" button that runs the pipeline for this clip's source range) · transcript stale after edits (warn; offer re-sync) · clip with multiple main-video items · locked tracks/hidden tracks · source media missing · very long compositions (analysis chunked, UI virtualised) · app closed mid-analysis (job resumes or restarts; nothing partially applied) · user edits the timeline while a tool's review panel is open (the proposal is revalidated; if affected, it shows "The clip changed — re-analyse" and disables Apply) · applying on a composition in read-only mode (disabled with reason) · two tools applied in sequence (e.g. silence removal after edit-by-transcript — works because all tools use ordinary commands) · tools used on a **clip created from a moment with pre/post-roll** (`07 §10`: respects the original boundary markers) · GPU/CPU limits (ONNX on CPU only, documented speeds).

---

## 12. TESTING AND ACCEPTANCE

**Fixtures:** 2-minute talking-head 16:9 clip with ground-truth subject boxes (hand-labelled at 1 fps) and word timings; a clip with fillers ("um", "uh") and long pauses; a two-person clip; a screen-recording clip; a noisy-room clip; 1080p vertical already-9:16 clip.

1. **Common:** every tool follows Analyse → Review → Apply; nothing changes during Analyse (state hash equal); Apply is **one undo step**; cancel works; missing requirements show plain fixes; offline/online labels correct; consent dialog before any online call; `aiProvenance` set.
2. **Edit by transcript:** deleting word ranges removes the matching video/audio; **no speech clipped** (boundary energy test); A/V sync intact (< 1 frame); filler removal on the filler fixture removes ≥ 95% of labelled fillers and < 1% of non-fillers; pause deletion works; padding/crossfade settings change the result as specified; ripple-all vs single-track; locked-track block message; captions regenerate for kept words and manual captions keep their badge; Restore/undo works; virtual preview skips the same ranges as the applied result (frame/audio comparison).
3. **Silence removal:** on the pauses fixture, ≥ 95% of ground-truth silences ≥ 0.5 s are detected and **no speech is removed** (0 words cut); threshold/min/padding sliders update counts live; Auto threshold works; Shorten mode leaves N s; deterministic results across two runs.
4. **Auto-reframe:** on the labelled fixture the crop contains the subject's face box in **≥ 95% of sampled frames**, the face centre stays within the central 60% of the crop in ≥ 90% of frames; no empty canvas exposed; path jerk below a threshold (measured: max pan speed ≤ 25% crop width/s); shot cuts reset the camera; keyframe count within caps; fallback paths (no face, screen recording) behave as §6.4; subject picker changes the result; runs ≤ 0.5× real-time on the reference machine (record the number); result editable in the preview/inspector.
5. **Auto emphasis:** LLM path (mock + one real model, recorded) and heuristic path both produce valid `wordOverrides`; ≤ 25% of words; deterministic heuristic; punch-ins spaced ≥ 4 s, written as editable keyframes; toggling a word works; switching caption styles keeps emphasis.
6. **Brand kits:** create from scratch and from a clip; apply to one and to 5 clips with progress; logo placed per percentages across 9:16/1:1/16:9; intro/outro inserted; caption style applied while manual captions skipped; Reapply/Detach/Delete semantics; `.cwbrand` export → import round trip on a clean workspace; missing font/asset handling.
7. **Stretch tools** (if shipped): their own checks recorded; otherwise confirmed **absent** from the UI by an automated UI test.
8. **LATER tools:** an automated string/UI scan confirms none are mentioned or shown.
9. Honesty scan: no UI string claims "perfect", "guaranteed", "viral" or "studio quality"; accuracy numbers shown anywhere come from our recorded benchmarks (`docs/verification.md`).
10. Visual review against `01`: review panels use design-system components, dense editor style, no AI-look items (no sparkle icons/gradients/glow).
