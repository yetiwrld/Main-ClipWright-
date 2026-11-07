# SPEC 07 — MOMENT DETECTION, SCORING AND THE MOMENTS SCREEN

**Binding.** Follows the structure of `specs/09`. Inputs: `05` (transcript), `04` (media info, proxies). Providers/models: `06`. Clip creation lands in `08`/`09`/`11`.
Code: `/packages/ai-core/moments`.

---

## 1. PURPOSE

Find the parts of a long video that work as **standalone short videos**, rate them transparently, show why, let the user preview and adjust them, and turn the chosen ones into editable clips. This is the product's core feature: it must never be random cutting, and it must never pretend its scores are a guarantee of virality.

---

## 2. INPUTS
- Transcript words, sentences, paragraphs (`05 §10`).
- User settings snapshot: target clip length range, number of clips, clip focus text, content type, language, processing mode (`02 §4`).
- Audio features computed locally (§4.2) and scene cuts (§4.3).
- Optional: an LLM from `06` (Ollama or an online provider).

---

## 3. MODES (always labelled in the UI)
| Mode | When | Label on results |
|---|---|---|
| **AI scoring** | An LLM is available per processing mode | "Scored by <model> (local|online)" |
| **Basic scoring** | No LLM available (offline without Ollama, no provider) | "Basic scoring — no AI model. Install a local model or add a provider for better results." |
The mode is stored on each moment (`basis: 'llm'|'heuristic'`). Never present heuristic scores as AI scores. Online use follows the consent rules in `00 §2.3` and `05 §5`: **only transcript text and numeric features are sent, never audio or video**, and the dialog says so.

---

## 4. PIPELINE (six stages; each reports progress)

### 4.1 Stage 1 — Prepare candidates ("thought units")
1. Use `sentences` as atoms. A **candidate** is a contiguous run of sentences `[i..j]`.
2. **Length bounds:** `min = targetMin × 0.8`, `max = targetMax × 1.2` (the 20% flex from `02 §4.5`).
3. Generate candidates by sliding `i` over every sentence that is a **valid start** and extending `j` until `max`, keeping those ≥ `min` that end on a **valid end**:
   - Valid start: the sentence begins the transcript, a paragraph, or follows a pause ≥ 0.5 s; not starting with a dangling connector ("and", "but", "so", "because", "which") unless the previous sentence is also included.
   - Valid end: ends with terminal punctuation; not followed within 0.3 s by a continuing clause; not ending on a filler.
4. If the total number of candidates exceeds **N = clamp(5 × requestedCount, 30, 120)** (for Auto, N = 60), prune with the cheap heuristic score (4.2) keeping the top N after **non-maximum suppression** (drop candidates overlapping an already kept, higher-scored one by > 50% of the shorter's duration).

### 4.2 Stage 2 — Audio and text features (local, fast)
Computed per candidate; all normalised to 0–1 against the whole video's distribution:
| Feature | How |
|---|---|
| Energy / emphasis | RMS loudness variance and peak count from `audio16k.wav` (ffmpeg `astats`/`ebur128` windows of 250 ms) |
| Speech rate | words ÷ speaking time; both very slow and very fast are penalised, mid-high rewarded |
| Pause density | share of time in pauses ≥ 0.4 s |
| Hook (first sentence) | question; number/statistic; strong claim words; second-person address; contrast ("but", "never", "nobody"); curiosity gap phrases; negation; length ≤ 18 words |
| Emotion intensity | lexicon-based sentiment magnitude for the language where a lexicon exists; exclamation density; laughter/applause markers in text; loudness spikes |
| Completeness | starts at a valid start, ends at a valid end, contains a resolution marker ("so", "that's why", "the point is") near the end |
| Standalone risk | opening pronouns/deictics ("this", "that", "he", "they") with no antecedent in the first sentence; references like "as I said earlier" |
| Redundancy | similarity to already kept candidates (below) |
**Heuristic score** = weighted sum with the weights in §6 using only available features (this is also the entire score in Basic mode).

### 4.3 Scene cuts (optional, cheap)
ffmpeg `select='gt(scene,0.3)'` on the proxy produces cut times. Used only to **avoid ending a clip mid-shot-change** (prefer an end within 0.5 s of a cut or at a sentence end) and to expose "visual change count" as a minor pacing signal. Skipped for audio-only or if it would exceed 20% of the transcription time on this machine.

### 4.4 Stage 3 — LLM evaluation (AI scoring mode only)
- Candidates are sent in **batches** sized to the model's context (`num_ctx` for Ollama, default 8192 → batch ≈ 6–10 candidates; computed from token estimates, leaving 30% headroom for the answer).
- Each candidate is rendered as: `id`, `start`, `end`, `duration`, **the transcript text with sentence indices**, and a few numeric hints (speech rate, energy rank). Include 1 sentence of preceding context and 1 following (marked as context only) so the model can judge standalone-ness.
- The model must reply with **only JSON** matching the schema (§4.4.2). Validate with zod. On invalid JSON: **repair attempt** (strip code fences, trailing commas), then **retry once** at temperature 0.1 with a stricter reminder; if still invalid, those candidates **fall back to heuristic scores** and carry `basis: 'heuristic'` (and a per-moment note). Never crash the stage.
- Temperature 0.2. Seeds fixed where supported for repeatability. Timeout per batch 120 s (local) / 60 s (online), retry 2×.
- **Clip focus text** is injected into the prompt ("The user is especially interested in: …") and also boosts the *Audience interest* weight by +5 points (taken evenly from the others).

#### 4.4.1 System prompt template (use verbatim, fill the placeholders)
```
You are an expert short-form video editor who finds the best standalone clips in long videos.
You will receive candidate clips taken from a transcript. For EACH candidate, judge how well it
would work as a standalone short video for social media (TikTok, Reels, YouTube Shorts).

Content type: {contentType}. Language: {language}. {focusLine}

Score each dimension as an integer from 0 to 100 using these anchors:
  0-30 = weak, 31-55 = average, 56-75 = good, 76-90 = very good, 91-100 = exceptional (rare).
Dimensions:
  hook: does the first 3 seconds grab attention?
  standalone: can a new viewer understand it with no other context?
  emotion: does it create laughter, surprise, anger, inspiration or curiosity?
  interest: is the topic/insight novel, useful, or discussion-provoking for a general audience?
  story: does it have a clear beginning, development and ending?
  value: does it teach something or entertain in a satisfying way?
  pacing: is it tight, without long rambling or dead air?
  social: is it suitable and engaging as a short social video?

Also return:
  title: a clear, specific title of at most 8 words (no clickbait, no quotes, no emoji).
  reason: ONE sentence (max 25 words) explaining the main reason it works or does not.
  needsContext: true if a viewer would be confused without earlier material.
  trimStartSentence / trimEndSentence: the sentence indices (from the candidate) where the clip
    should best begin and end; they must stay inside the candidate.
  flags: array of any of ["rambling","weak_ending","profanity","sensitive_topic","off_topic","needs_context"].

Be strict and honest: most candidates are average. Do not give all candidates high scores.
Respond with ONLY valid JSON, no markdown, matching exactly:
{"results":[{"id":string,"scores":{"hook":int,"standalone":int,"emotion":int,"interest":int,"story":int,"value":int,"pacing":int,"social":int},"title":string,"reason":string,"needsContext":boolean,"trimStartSentence":int,"trimEndSentence":int,"flags":[string]}]}
```
The schema is also enforced by zod; extra fields are dropped; missing candidates are scored heuristically.

### 4.5 Stage 4 — Boundary refinement
For each candidate (after any `trimStart/EndSentence` from the LLM, clamped inside the candidate):
1. Snap start to the **first word's start** and end to the **last word's end**. Never cut mid-word.
2. Add **breathing room**: pre-roll `min(0.25 s, gap to previous word)` and post-roll `min(0.4 s, gap to next word)`; never include any part of another speaker's words or of a different sentence's first word.
3. Prefer the end to land on a pause ≥ 0.3 s if one exists within the last 1.5 s.
4. **Standalone repair:** if `needsContext` or the standalone-risk feature is high and there is room under `max`, try extending the start back by 1–2 sentences (whole sentences only) and re-score `standalone` heuristically; keep the extension only if it improves standalone-ness and total duration ≤ `max`.
5. Enforce length: if the result is shorter than `min × 0.8` or longer than `max × 1.1` after refinement, discard it (log why).

### 4.6 Stage 5 — De-duplication and diversity
- **Time overlap:** if two moments overlap by > 50% of the shorter's duration, keep the higher-scored (the other is dropped, not hidden).
- **Text similarity:** shingle (5-word) Jaccard > 0.6 or embedding cosine > 0.88 (if a local embedding model is available) → treat as duplicates; keep the higher score.
- **Alternates:** when two overlapping moments both score within 5 points and differ in length by > 30%, keep both as **alternate versions** in one group (shown stacked: "Short version / Long version"). Never more than 2 alternates per group.
- **Diversity:** after sorting, apply a **soft penalty** (−3 points) to a moment within 20 s of a higher-ranked one, so the list isn't dominated by one stretch.

### 4.7 Stage 6 — Rank and select
- Final score = weighted sum (§6), rounded to an integer 0–100.
- Selected set = top **K** by score where K = requested number; for **Auto**: all with score ≥ 65, max 20, min 3 (if fewer than 3 reach 65, take the top 3 and say so).
- The list also contains up to **2× K** further candidates under a "More moments" expander (ranked), so the user can choose others. Moments scoring < 40 are hidden unless the user lowers the score filter.

---

## 5. TARGET LENGTH BEHAVIOUR
- Clips inside `[targetMin, targetMax]` get no penalty. Between `min` (×0.8) and `targetMin`, or between `targetMax` and `max` (×1.2), apply a **−1 point per 1% outside** penalty to the pacing/social dimensions. Beyond those bounds candidates are not generated.
- The user can still trim any clip freely on the Moments screen and in the editor.

---

## 6. SCORING MODEL (transparent)

### 6.1 Dimensions and default weights (sum = 100)
| Dimension | Weight |
|---|---|
| Hook strength | 20 |
| Standalone context | 20 |
| Emotional impact | 15 |
| Audience interest | 15 |
| Storytelling | 10 |
| Educational/entertainment value | 10 |
| Pacing | 5 |
| Social suitability | 5 |

### 6.2 Content-type adjustments (points moved, still sum 100)
| Type | Adjustment |
|---|---|
| Podcast/interview | Hook +5, Standalone +5; Pacing −5, Social −5 |
| Talking head/vlog | Hook +5, Emotion +5; Story −5, Value −5 |
| Tutorial/educational | Value +10, Story +5; Emotion −10, Social −5 |
| Gaming/stream | Emotion +10, Pacing +5; Standalone −10, Value −5 |
| Lecture/talk | Value +5, Story +5; Hook −5, Emotion −5 |
| Auto/Other | none |
**Auto-detect content type** (when "Auto"): from the transcript and audio features (speaker count if known, question/answer pattern, instruction verbs, exclamation and loudness variance) with the LLM when available; record the guess and show it as a chip the user can change (changing it re-ranks instantly without re-running the model: only weights change).

### 6.3 Heuristic ↔ LLM blending
In AI mode: `dimensionScore = 0.8 × llmScore + 0.2 × heuristicScore` for dimensions that have a heuristic counterpart (hook, standalone, emotion, pacing, story); others use the LLM score alone. This damps LLM noise and local-model quirks.

### 6.4 Confidence (High / Medium / Low)
Start at High; lower one level for each: LLM–heuristic disagreement on overall > 20 points; LLM JSON needed repair/retry; average word confidence < 0.6 or any `approximate` words in the range; flags include `rambling` or `needs_context`. Low-confidence moments show a muted ring and the label "Low confidence".

### 6.5 Honesty requirements
- A permanent caption on the screen: **"Scores are AI estimates of how well a moment works as a standalone clip, not a prediction of views."**
- Never display words like "viral", "guaranteed", "will perform".
- Every moment shows its **score breakdown** (eight bars) and the one-sentence reason.

---

## 7. DATA MODEL
```ts
interface Moment { id; projectId; transcriptVersion: number; startUs; endUs; durationUs;
  title; reason; score: number; scores: Record<Dim, number>; weightsUsed: Record<Dim, number>;
  confidence: 'high'|'medium'|'low'; basis: 'llm'|'heuristic'; model?: string; provider?: string;
  flags: string[]; needsContext: boolean; transcriptPreview: string; hookSentence: string;
  groupId?: string /*alternates*/; status: 'candidate'|'favourite'|'rejected'|'clipped';
  userEdited: boolean; manual: boolean; createdAt; clips: CompositionId[]; }
```
`transcriptVersion` marks staleness: if the transcript changes inside a moment's range, the moment shows "Transcript edited" and offers re-score.

---

## 8. THE ANALYSIS PROGRESS SCREEN
Uses `StageProgressScreen` (`02 §6`). Sub-steps with the reason lines from `02 §6.3`: *Preparing candidates → Analysing audio → Scoring (n of m batches, model name chip) → Removing duplicates → Ranking*. Hero percentage = weighted stage progress (preparing 10%, audio 15%, scoring 60% in AI mode (or 0% and audio 70% in Basic mode), dedupe 5%, ranking 10%). Cancel keeps computed features and candidates cached so re-running is fast. A result **never appears half-ranked**: the list shows once, at the end.

---

## 9. THE MOMENTS SCREEN (`/project/:id/moments`)

### 9.1 Layout
- **Two panes** (tier ratios in `01 §9`): **left** moment list, **right** preview panel. Bottom **action bar**.
- **Top toolbar of the left pane:** search (transcript text and titles), **Sort** (Score ↓ default, Time in video, Duration), **Filters** popover (min score slider 0–100, duration range, favourites only, status, confidence), a **content-type chip** (editable, instant re-rank), and a **"Find more"** button (§9.5).
- Mode label ("Scored by …" / "Basic scoring"), the honesty caption (6.5), and the stale-settings banner when applicable.

### 9.2 Moment card (`--radius-lg`, 16 px padding)
Left: **ScoreRing** (`01`) with number. Middle: **title** (600), one-line **reason**, meta row (`0:42–1:18 · 36 s`, chips: *Favourite*, *Needs context*, *Low confidence*, *Alternate*, *Transcript edited*), and the **hook sentence** (first words highlighted lightly). Right: icon buttons **Favourite** (star), **Reject** (✕, undo toast), **⋯** (Regenerate, Create manual variant, Show in transcript). A **checkbox** at the top-left selects for batch actions. Clicking the card selects it and loads the preview. Expanding "Why this score" reveals the **eight-bar breakdown** with values and the weights used, plus the flags.
- Alternates appear as a stacked pair inside one card with a segmented toggle (*Short | Long*).
- Cards stagger in once (`01 §8`). Skeleton cards while loading.

### 9.3 Preview panel
- **Player** (proxy or original) in the **chosen aspect ratio** with the **crop framing** applied and the chosen **caption style rendered live** over it (so what they see is what the clip will start as). Controls: play/pause (Space), loop (default on for the moment range), mute, playback rate, current time and duration.
- It plays **exactly the moment range** with the post-roll; the playhead is confined to the range unless the user scrubs outside using the handles' extension.
- **Mini timeline** beneath: waveform of the range plus ±15 s of context (dimmed), **word ticks** when zoomed, two **draggable handles** (start/end) in `--brand`. Handles **snap to word boundaries** by default; hold **Alt** for frame-level, **Shift+Arrow** nudges ±1 word, **Alt+Arrow** ±1 frame. Live readout of new start/end/duration; clamped to ≥ 3 s and ≤ 10 min; a warning chip if outside the target range ("Longer than your target").
- A **transcript strip** below shows the text in the range with the current word highlighted, and sentence boundaries marked; clicking a word seeks; dragging a handle past a sentence boundary updates the text live.
- Edited boundaries set `userEdited: true`; **Reset** restores the AI boundaries. Scores for edited moments are shown as "Edited — score may differ" (and a **Re-score** button re-evaluates only that moment).

### 9.4 Selecting and creating
- **Select** with checkboxes, **Ctrl+A** (all visible), Shift-click range. Action bar shows "**3 selected**" and **Create clips** (primary, creates all selected), **Create & open** on a single moment, and **Reject selected**.
- **Create manual moment:** (a) from the transcript editor selection (`05 §9.2`), (b) the **"+ Add range"** button: set start/end by dragging on a full-video waveform strip. Manual moments have `manual: true`, can be scored on request (**Score this**) and otherwise show "Manual — not scored".
- Rejected moments are hidden (filter "Show rejected" restores). Reject is undoable for the session.

### 9.5 Regenerate and find more
- **Regenerate (⋯):** re-run scoring/titles for that moment (optionally with a different provider/model chosen in a small popover).
- **Find more:** opens a popover with the **focus text** field and content type; re-runs Stages 1–7 **excluding time ranges already used by existing moments**, appending new moments without disturbing the user's favourites/rejections/edits.
- Both show a lightweight progress state in the card/toolbar (not a full-screen takeover).

### 9.6 Keyboard
↑/↓ move selection · Space play/pause · Enter create clip for the focused moment · F favourite · X reject · Ctrl+A select all · Esc clears selection · `[`/`]` nudge start/end by one word.

---

## 10. CLIP CREATION (what "Create clip" does)
For each selected moment, in order, with a progress toast ("Creating 3 clips…"):
1. Create a **Composition** (a clip) inside the project: canvas from the project's aspect ratio (resolution presets in `14`; default shortest side 1080 → 1080×1920 for 9:16), `fps` = 30 (or 60 if the source is ≥ 50 fps and the user's export default is 60).
2. **Main video track:** one video item referencing the source over `[startUs, endUs]` (sourceIn = startUs), placed at timeline 0, with the project's `initialFraming` applied (scale to fill the canvas, then offset by framing); if "Auto-reframe" is on and available (`13`), apply it after creation as a background job.
3. **Audio:** original audio kept (embedded).
4. **Captions:** build with `buildCaptions` (`05 §11`) from the words in range (times shifted by `−startUs`) in the **chosen caption style** on a Captions track.
5. **Markers:** "Moment start" and "Moment end" at the **original** boundaries when the clip was extended with pre/post-roll (`09 §18`).
6. Name = moment title (deduplicated "Title (2)").
7. Mark the moment `clipped` and link `clips[]`. **Creating again** from the same moment produces a **new version** (e.g. "Title v2") — originals are never overwritten.
8. Open the editor on the **first created clip** (`/editor/:compId`); all created clips appear in the **clip bin** (`08`).
Everything created is fully editable. Failures for one clip do not stop the others; a summary lists errors.

---

## 11. PERSISTENCE AND LINKS
Moments, scores, weights, flags and statuses persist per project and survive restarts. Feature caches (audio features, candidate lists) are stored in `Cache/` keyed by `(mediaId, transcriptVersion, settingsHash)`. Links: transcript (`05`), providers/model manager (`06`), caption presets (`11`), editor/compositions (`08`/`09`), job queue (`04 §9`).

---

## 12. EDGE CASES
Very short video (< target min) → one candidate = whole video with a note · video with no speech → Moments screen explains and offers manual ranges · transcript has `approximate` words → confidence lowered · LLM returns identical scores for everything → detect (std dev < 3) and re-run once with stricter prompt, else blend more heuristic (0.5/0.5) and show a note · model too small / returns nonsense → fallback to heuristics with explanation and "Try another model" · provider offline mid-run → pause, offer Switch to local or Basic scoring · user edits transcript after moments exist → affected moments flagged stale · requesting 50 clips from a 5-minute video → capped by available distinct candidates with a message · Auto count with few good moments → min 3 rule · moments crossing a long silence → boundary rules prevent dead air · a moment range includes video-only section with no speech → allowed only if user-created.

---

## 13. TESTING AND ACCEPTANCE
**Fixtures:** three transcripts (podcast 60 min, tutorial 20 min, vlog 10 min) with **human-labelled "good moments"** (5–8 each, committed as JSON), plus malformed-LLM-output fixtures.

1. Candidate generator unit tests: valid start/end rules, length bounds, N cap, NMS.
2. Boundary refinement tests: never cuts mid-word, respects speakers, pre/post-roll limits, standalone extension limit.
3. Dedupe tests: overlap, text similarity, alternates (max 2), diversity penalty.
4. Scoring tests: weights sum to 100 after every content-type adjustment; blending formula; confidence rules; Auto selection (≥ 65, max 20, min 3).
5. LLM JSON handling: valid, fenced, trailing comma, missing items, wrong types, empty, huge — all produce valid moments (heuristic fallback where needed), never an exception.
6. **Quality benchmark (record the numbers in `docs/verification.md`):** with a local model on the reference machine, **≥ 60% of the human-labelled good moments appear in the top K** (K = 2× number of labels) on the three fixtures, in AI mode; in Basic mode record the number too (no minimum).
7. End-to-end: a real 60-minute video produces ranked moments with breakdowns and reasons offline (Ollama) and with one online provider; Basic mode works with no model and is labelled.
8. Moments screen: sort/filter/search, favourite/reject/undo, handle dragging with word snapping, live caption preview in the chosen style, multi-select, Find more (does not disturb existing), Regenerate, alternates toggle, stale banners.
9. Clip creation: single and batch; correct aspect ratio, range, framing, captions in the chosen style, markers, naming; re-create → v2; failure isolation; editor opens on the first clip with the clip bin populated.
10. Honesty/safety: caption and mode label always visible; online consent shown once and states that only text is sent; no "viral/guaranteed" wording anywhere (automated string scan of the UI strings).
