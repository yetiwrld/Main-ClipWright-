# SPEC 05 — TRANSCRIPTION AND CAPTION DATA

**Binding.** Follows the structure of `specs/09`. Inputs from `04` (`audio16k.wav`). Providers/models management: `06`. Caption looks and editing: `11`. Consumers: `07`, `08`, `09`, `13`.
Code: `/packages/ai-core/transcription`.

---

## 1. PURPOSE

Produce an accurate transcript with **word-level timestamps**, stream it to the user while it is being produced, make it editable, and convert it into **caption data** that stays linked to the words. It must work fully offline (whisper.cpp) and optionally through online providers.

---

## 2. PIPELINE OVERVIEW

```
audio16k.wav ──► chunk planner ──► [chunk 1..N] ──► engine (local or online) ──► words+segments
        │                                                     │ (each chunk saved immediately)
        └──────────────► progress, live stream ◄──────────────┘
words ──► sentence/paragraph builder ──► caption builder (per aspect ratio) ──► DB
```

---

## 3. CHUNKED, RESUMABLE TRANSCRIPTION (mandatory design)

Long videos must not be one monolithic run: it prevents progress, resume, live streaming and recovery.

1. **Plan chunks:** target **5 minutes** per chunk (configurable 2–10). To avoid cutting words, find the **longest silence** (ffmpeg `silencedetect`, −35 dB, ≥ 0.3 s) within ±15 s of each target boundary and cut there; if none, cut at the target. Chunks are time ranges of `audio16k.wav` (no re-encode; pass offsets to the engine or cut temporary WAV slices).
2. **Context carry-over:** pass the last ~200 characters of the previous chunk's text as the engine's initial prompt, so names/terms stay consistent.
3. **Run chunks sequentially** (local engines are CPU-bound; one at a time). After **each** chunk completes, write its words to the DB in one transaction with `chunkIndex` and mark the chunk `done`.
4. **Resume:** on cancel/crash/restart, skip `done` chunks and continue. "Start over" clears them.
5. **Time offsets:** engine times are relative to the chunk; convert to absolute `Us = chunkStartUs + t`.
6. **Progress** = (audio seconds in completed chunks + in-chunk progress fraction × chunk length) / total seconds. In-chunk progress comes from the engine's progress output when available, otherwise 0 until the chunk finishes (progress remains truthful, just steppier).
7. **ETA** = remaining audio seconds ÷ measured throughput (audio seconds per wall second, exponentially smoothed over completed chunks); shown after the first chunk.
8. **Live streaming:** after each chunk, push its words to the UI (`transcript:append`). With local engines that stream segments, push segments as they arrive (flagged `provisional` until the chunk completes).

---

## 4. LOCAL ENGINE: whisper.cpp

- Bundled CLI (CPU build with AVX2/FMA where available; ship a baseline build and select at runtime by CPU feature detection). Launch as a child process (no shell), arguments passed as an array.
- **Read the bundled binary's `--help` before choosing flags**; flags differ between versions. Required capabilities: JSON output with timestamps, per-word (token-level) timestamps, language selection/auto-detect, thread count, initial prompt, progress output to stderr, model path.
- Word timestamps: use the engine's token/word-level timestamp feature (e.g. full-JSON output with token offsets merged into words by leading-space rules; or its "one word per segment" mode if more reliable in the bundled version). **Validate on the reference clip (§14)**.
- **Fallback if word timings are unavailable or implausible** (zero-length words, non-monotonic times): distribute words across the segment's time span **weighted by character count**, set `approximate: true` on those words, and show a subtle "Timing approximate" indicator in the transcript panel. Never fail the stage because of this.
- Threads default = physical cores − 1 (min 2), adjustable in Settings → Performance.
- Suppress non-speech tokens and hallucination loops: reject chunk output with > 30% repeated n-grams or text during silence (> 3 s of silence containing text) → re-run that chunk once with different parameters (temperature fallback, no carry-over prompt); if still bad, keep but flag `lowConfidence`.
- Always run with `-nostdin`-equivalent behaviour and a watchdog: if a chunk shows no progress for **5 minutes**, kill and retry once, then fail the chunk with a clear message.

### 4.1 Models (catalogue; sizes approximate, verify at download)
| Model | Size | Notes |
|---|---|---|
| tiny / tiny.en | ~75 MB | Fastest, lowest accuracy; drafts |
| base / base.en | ~140 MB | Fast; fine for clear speech |
| **small / small.en** | ~470 MB | **Default**: best speed/accuracy on CPU-only machines |
| medium / medium.en | ~1.5 GB | Better accuracy, slow on CPU |
| large-v3-turbo | ~1.6 GB | High accuracy, slower; multilingual |
| large-v3 | ~3 GB | Best accuracy; very slow on CPU; warn |
- `.en` variants are offered and **preferred automatically** when the language is English.
- Download from the official whisper.cpp model hosting; **resumable**, size-checked and **hash-verified** against a pinned checksum table shipped with the app (`/assets/model-checksums.json`). A failed hash deletes the file and shows a clear error.
- Stored in `Models/whisper/`. The **Model manager** (`06`) lists installed models, sizes, a speed hint relative to this machine, and Delete.
- **Auto-selection rule:** if the user chose a model, use it. Else: RAM < 8 GB → base(.en); otherwise small(.en). If the language is non-English and `.en` models are the only ones installed, prompt to install the multilingual equivalent.
- **Speed hint** (shown on cards): after the first completed transcription on this machine, store the measured throughput per model and display "≈ N× real time" (e.g. "about 25 min for this video").

---

## 5. ONLINE ENGINES

- Interface `TranscriptionProvider { id; supportsWordTimestamps; maxUploadBytes; transcribe(audioChunk, {language, prompt}, signal): ChunkResult }`.
- Built-in: **OpenAI-compatible** `/audio/transcriptions` (custom base URL, key, model; word timestamps via `timestamp_granularities[]=word` and `response_format=verbose_json` where supported) and any further providers behind the same interface (`06`).
- Chunks are **re-encoded for upload** (mono, 16 kHz, Opus/MP3) and kept under the provider's size limit (default 20 MB; planner shortens chunks as needed).
- **Consent:** before the first upload per provider, show a dialog: "This sends the audio of your video to <provider>." with *Allow once / Always allow for this provider / Cancel*. The Transcribe screen always shows a chip "Using <provider> (online)". No silent fallback from offline to online: if offline fails the user is asked.
- Provider rate limits/timeouts: retry with backoff (3×), then fail the chunk with the provider's message translated into plain language.

---

## 6. LANGUAGE
- **Auto-detect** (default): the engine detects on the first chunk; the detected language and confidence appear as a chip; if confidence < 0.6, show "Not sure — set language" with a dropdown that re-runs the first chunk.
- User override in Advanced (`02 §4.7`) or the Transcribe screen.
- Language is stored on the transcript; mixed-language videos: v1 uses one language per transcript (documented limitation).

---

## 7. SPEAKERS
- **v1 core:** no diarization is required. The data model has `speaker?: string`; if an online provider returns speakers, store and show them as labels and colour-dots.
- **Later (see `13`):** offline diarization. Do not claim speaker identification offline until it exists.

---

## 8. THE TRANSCRIBE SCREEN

Uses `StageProgressScreen` (`02 §6`) with a **two-column layout** (≥ standard tier; stacked in compact):
- **Left (40%):** stage title ("Transcribing"), hero percentage, ring, reason line, details (model chip, language chip, speed ×, elapsed, ETA, chunk "3 of 12"), Cancel / Continue in background / Details.
- **Right (60%):** **live transcript panel**: scrolling text that appends as chunks complete (auto-scroll to the bottom; stops auto-scrolling if the user scrolls up; "Jump to latest" button). Words appear with a 120 ms fade (not word-by-word typing). Provisional text is muted until confirmed.
- On completion: a **summary card** (duration, word count, language, model, "Timing approximate" if any) and two buttons: **Review transcript** (opens the editor view, §9) and **Continue to Moments** (primary). With auto-continue on, it advances after 1.5 s unless the user hovers/interacts.

---

## 9. TRANSCRIPT VIEWER / EDITOR

Available (a) on the Transcribe screen after completion, (b) as the **Transcript tab** in the editor's left panel (`08`), and (c) in the Moments screen as a side drawer.

### 9.1 Layout
Header: search box (Ctrl+F), language chip, **Export** menu (TXT, SRT, VTT, JSON), **Re-transcribe…** menu. Body: paragraphs of sentences with timestamps in the left gutter (`MM:SS`, monospace, click to seek). A small **mini player** (proxy video, play/pause, current time) sits above or beside it.

### 9.2 Interactions
| Action | Behaviour |
|---|---|
| **Click a word/sentence** | Seeks to its start; the mini player (or the editor playhead) jumps there. |
| **Playback** | Current word is highlighted (`--brand-tint` fill); view auto-scrolls to keep it visible (follows the playhead, `09 §6`). |
| **Search** (Ctrl+F) | Highlights all matches, shows "3 of 17", Enter/Shift+Enter navigate, Esc closes. Case-insensitive, diacritics-insensitive option. |
| **Select text** | Click-drag or Shift-click selects a word range; selection toolbar appears: **Play**, **Create clip from selection**, **Highlight**, **Re-transcribe selection**, **Copy**. |
| **Highlight** | Colour-marks ranges (6 colours) for the user's reference; stored with the transcript; does not affect captions. |
| **Edit a word** | Double-click or Enter on a focused word → inline edit. |
| **Edit semantics** (all undoable, text edits never change timing unless stated) | **Replace text** keeps the word's timing. **Insert word** between A and B: the new word takes **half of the larger neighbouring word's duration**, never overlapping (or fills the gap if one exists). **Delete word** leaves its time as a gap (the timeline caption sync handles it; see §11). **Merge words** joins two adjacent words (start of first, end of last). **Split word** divides its time proportionally by character count. |
| **Re-transcribe selection** | Re-runs the engine **only on the selected time span** (padded 0.5 s each side, trimmed back to exact boundaries after), with a choice of model (e.g. try medium), replacing the words in that range. Confirms before replacing edited words. |
| **Create clip from selection** | Creates a **manual moment** (`07 §9.4`) with start = first selected word start and end = last selected word end, then opens it on the Moments screen. |
Keyboard: arrows move word focus, Space plays/pauses from the focused word, Ctrl+Z/Ctrl+Shift+Z undo/redo (transcript-level undo stack of ≥ 100 steps).

---

## 10. DATA MODEL

```ts
interface Transcript { id; mediaId; language; languageConfidence?; engine: 'whisper-local'|string /*provider id*/;
  model: string; createdAt; version: number /*incremented on edit*/; durationUs;
  words: Word[]; sentences: Sentence[]; paragraphs: Paragraph[]; highlights: Highlight[]; }
interface Word { id; text; startUs; endUs; confidence?: number; speaker?: string;
  edited: boolean; approximate: boolean; lowConfidence: boolean; filler: boolean; chunkIndex: number; }
interface Sentence  { id; wordIds: string[]; startUs; endUs; }
interface Paragraph { id; sentenceIds: string[]; startUs; endUs; speaker?: string; }
```
- **Sentence builder:** break after `. ? !` (including `…`) when followed by a capitalised word or a pause ≥ 0.4 s; force a break after a pause ≥ 1.0 s or 40 words. Handle abbreviations ("Mr.", "e.g.", decimals) with a small exception list.
- **Paragraph builder:** break on pause ≥ 2.0 s, speaker change, or after 8 sentences.
- **Filler flag:** `filler: true` for um, uh, er, ah, hmm, "you know" (multi-word match), language-aware list in `/assets/fillers/<lang>.json`. Fillers are **kept** in the transcript and captions by default (setting "Hide filler words in captions", default off); `13` uses the flag to remove them from video.
- Times are integer microseconds (`09 §3`). Words never overlap and are ordered.

---

## 11. CAPTION DATA (derived from words)

### 11.1 Caption model
```ts
interface CaptionSegment { id; wordRefs: Array<{wordId; startUs; endUs; textOverride?: string}>;
  startUs; endUs; text: string; lines: string[]; speaker?; manualTiming: boolean; manualText: boolean; }
```
Stored per **composition** (`07 §10`) as caption **items** (`09 §20`). `wordRefs` keep a **copy** of word timings (so edits to caption timing never rewrite the master transcript) plus the source `wordId` for syncing.

### 11.2 Segmentation algorithm (`buildCaptions(words, aspect, styleHints)`)
Parameters depend on aspect ratio:
| Aspect | Max chars/line | Max lines | Max duration | Target words |
|---|---|---|---|---|
| 9:16, 4:5 | 20 | 2 | 3.0 s | 3–6 |
| 1:1 | 28 | 2 | 3.5 s | 4–8 |
| 16:9, 21:9, 4:3 | 40 | 2 | 4.5 s | 6–12 |
Rules, in order:
1. A segment never crosses a **pause ≥ 0.5 s** or a **speaker change**.
2. Prefer breaks **after sentence-ending punctuation**, then **after commas/clause words** (and, but, so, because, which), then at the max-length limit.
3. Never break inside a number or between a determiner and its noun when avoidable ("the | house").
4. Minimum duration **0.6 s** (merge a tiny segment into its neighbour when no pause separates them), maximum per the table.
5. Lines are balanced (split near the middle, longer line on the bottom).
6. **Word-by-word** and **karaoke** presets set target words = 1 or use per-word highlight over the segment (style decides display; the segmentation stays the same).
7. Output is deterministic (same words + parameters = same captions) and unit-tested.

### 11.3 Sync between transcript edits and captions
- Each caption stores `manualTiming` / `manualText` flags (set when the user edits it in the editor).
- When transcript words change (text edit, insert, delete, re-transcribe):
  - Captions with **both flags false** are **regenerated automatically** for the affected range.
  - Captions with a flag true show a small **"Transcript changed"** badge; a **Sync** button offers *Update text only*, *Update text and timing*, or *Keep mine*. Never overwrite manual work without that choice.
- When captions are edited in the editor, the master transcript is **not** changed (captions are the clip's own copy), but the user can "Send corrections back to transcript" (text only).

---

## 12. EXPORT OF TRANSCRIPTS
TXT (with optional timestamps), **SRT** and **WebVTT** (line-wrapped per §11.2 for the chosen aspect), **JSON** (full model). Files named `<project>.<lang>.<ext>`.

---

## 13. FAILURE HANDLING
| Case | Behaviour |
|---|---|
| Model missing | Dialog: download now (size/ETA) or switch model/mode |
| Model download interrupted | Resume; hash failure → delete and retry |
| Out of memory (large model on 8 GB machine) | Detect, explain, offer a smaller model; resume at the failed chunk |
| Engine crash | Retry the chunk once; then fail with message; completed chunks kept |
| No speech detected | "We couldn't find speech in this video." Options: choose another audio track, try a different model, or skip to the editor with an empty caption track |
| Music-only/low confidence | Proceeds, flags `lowConfidence`; summary card warns |
| Online provider error/offline | Plain-language message; offer local engine (with consent step if it would change privacy: local is always safe) |
| Disk full | Pause with a clear message and Resume |

---

## 14. TESTING AND ACCEPTANCE

**Fixtures (committed in `/test-fixtures`, small, licence-clean):** 2-minute English clear-speech clip with a hand-made reference word-timing file; 2-minute non-English clip; clip with music and silence; clip with two speakers; 30-minute podcast-style file (generated by concatenation); audio with no speech.

1. Word-timing accuracy on the reference clip: **≥ 90% of words start within ±150 ms** of the reference (automated test; record the number).
2. A 30-minute file transcribes **offline** end-to-end on the reference machine with true progress, working live stream, ETA, cancel at chunk 3 and resume (no duplicated or missing words at the seam: automated check of continuity).
3. Kill the app mid-chunk → relaunch → resumes from the last completed chunk.
4. Model download: resume after a connection drop; bad hash is rejected.
5. Language: auto-detect picks the correct language on both fixtures; override works; `.en` model is auto-preferred for English.
6. Online provider: consent dialog shown once, chip visible; chunk sizes respect the limit; invalid key shows a clear message.
7. Transcript editor: search, seek, selection toolbar, inline edit (all four edit semantics), re-transcribe selection, undo/redo, highlight, export TXT/SRT/VTT/JSON (SRT/VTT validated by parsing).
8. Caption builder: unit tests for each aspect table row, pause rule, balance rule, determinism; golden-file tests for fixtures.
9. Sync: editing a word regenerates untouched captions and shows the badge on manually edited ones; "Keep mine" leaves them intact.
10. No-speech and no-audio files produce the specified messages and a working path forward.
