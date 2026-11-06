# SPEC 16 — TESTING, ACCEPTANCE AND THE VERIFICATION REPORT

**Binding.** Follows the structure of `specs/09`. This spec **does not repeat** each area's acceptance checks; it defines how all of them are run, recorded and gated, plus the cross-cutting tests no single spec owns. The master rules (`00 §2.8–2.9`, `§8`) apply: **a test counts only if it was actually run and the real output was inspected; failures are fixed, never hidden, disabled or weakened.**
Code/tests: `/tests`, per-package `*.test.ts`, `/apps/desktop/e2e`, `/test-fixtures`, `/scripts/verify`. Output: `docs/verification.md` (+ `docs/verification/` artefacts).

---

## 1. PURPOSE

Make "done" **provable**. Every claim in the final report is backed by a recorded run on real media, with numbers, dates, machine description and artefact paths. Nothing is "assumed to work".

---

## 2. TEST LAYERS (all mandatory)

| Layer | Tool | Scope | When it runs |
|---|---|---|---|
| **Unit / property** | Vitest (+ `fast-check` for property tests) | Pure logic: `timeline-engine` (every command + inverse round trip + invariants), snapping, ripple/overlap, ruler ticks, time/timecode conversion, keyframe evaluation, caption segmentation, caption layout, moment candidate/scoring/dedupe, schema migrations, redaction, router, size/resolution functions, export planner, validation parsers, update-manifest verification | every commit (CI) |
| **Component** | Vitest + Testing Library (or Playwright CT) | design-system components in every state, forms, inspector controls | CI |
| **Integration** | Vitest with real processes | ffmpeg/ffprobe wrappers, yt-dlp wrapper (mock server + one real URL manually), whisper.cpp pipeline on fixtures, mock OpenAI/Ollama/Anthropic/Gemini servers, SQLite storage + recovery with kill, job queue resume | CI (media-light) and nightly (full) |
| **End-to-end** | **Playwright for Electron** on the **real Windows runner** | Main flows and timeline/preview interactions through the real UI (no mocks of our own code) | CI smoke + nightly full |
| **Real-media export validation** | `scripts/verify/export-matrix.ts` using ffprobe/ffmpeg | Exports of real compositions analysed per `14 §7` | nightly + before release |
| **Parity / golden** | SSIM comparison scripts | preview vs export frames, caption presets, text, transitions | nightly + before release |
| **Performance** | scripted benchmarks | targets in `09 §27`, `10 §12`, `14 §10`, `04` checks | on the reference machine before release |
| **Clean-install** | Windows VM/runner smoke | installer, portable, uninstall, update, rollback (`15 §12`) | before release |
| **Manual exploratory** | Human checklist (§9) | things automation can't judge: feel, visual quality, playback in a real player | before release; results recorded |

Rules: tests that need a GPU/real mic/real provider keys are **marked** and recorded as "**not run: <reason>**" when the resource is missing — **never skipped silently and never faked**. A skipped test blocks the *final* claim for that feature (the feature is listed under limitations / "unverified").

---

## 3. THE REFERENCE MACHINE AND ENVIRONMENT
Record in `docs/verification.md`: CPU model/cores, RAM, GPU (or none), Windows version/build, display scaling, drive type, app version/commit, ffmpeg/whisper/yt-dlp versions, Ollama version + model used, which online provider (name only) was used. Performance targets apply to the **reference machine** in `00 §3` (6-core laptop CPU, 16 GB RAM, integrated graphics); numbers from a stronger machine are recorded but **do not satisfy** the targets.

---

## 4. FIXTURES (`/test-fixtures`, small, licence-clean, listed in `docs/licences.md`)

Generate programmatically where possible (ffmpeg `lavfi`, synthetic tones, pixel-encoded counters) so no third-party media licence is needed; for speech, record or generate **text-to-speech fixtures with a licence that permits redistribution**, or use the owner's own recordings (ask once; mark "owner-provided").

| Fixture | Purpose |
|---|---|
| `landscape-1080p30.mp4` (H.264/AAC, 2 min, speech) | baseline import/transcribe/moments/export |
| `portrait-phone.mov` (rotation metadata, 1080×1920) | rotation, portrait pipeline |
| `uhd-hevc-4k.mkv` (10–20 s) | proxy, 4K export |
| `vfr-phone.mp4` (variable frame rate) | VFR detection, CFR output |
| `no-audio.mp4` | no-audio paths |
| `audio-only.wav/.mp3/.m4a/.flac` | media-library audio |
| `image.png/.jpg/.webp/.svg` (+ malicious SVG) | images, sanitiser |
| `long-30min.mp4` (concatenated) | soak, chunked transcription, memory |
| `corrupt.mp4`, `zero-byte.mp4`, `unsupported.xyz` | error paths |
| `speech-ref.wav` + `speech-ref.words.json` | word-timing accuracy (`05`) |
| `non-english.mp4`, `two-speakers.mp4`, `music-silence.mp4`, `no-speech.wav`, `fillers-pauses.mp4` | language, diarization-free speaker labels from provider mocks, silence/filler tools |
| `talking-head-16x9.mp4` + `faces.gt.json` | auto-reframe ground truth |
| `transcripts/{podcast60,tutorial20,vlog10}.json` + `labels.json` | moments benchmark (`07 §13`) |
| `export/*` (`14 §11`) | sync clapper, frame counter, colour bars, composition suite |
| `packages/*.cwpack`, `schemas/v1…vN/*.cwdb` | package import, migration |
| `providers/mock-*` | mock servers with scripted responses (including malformed JSON) |

Fixture rule: **never** use fixtures to *fake* app behaviour; they are inputs for tests only.

---

## 5. THE FEATURE TEST MATRIX (maps every requirement to where it is tested)

Each row lists the **owning spec checks** that must pass, and the layer(s). All rows must be ✓ with a recorded result (or listed under Known limitations with evidence).

### 5.1 Import
Supported local videos (MP4/MOV/MKV/WebM/AVI), audio (MP3/WAV/AAC/FLAC/M4A), images (PNG/JPG/WebP/SVG) · unsupported/corrupt/zero-byte · large (2-hour) · **supported remote URL**, direct file URL, unsupported/private/removed/DRM-refused URLs, resume · dedupe · reference vs copy · missing-file relink · rotation/VFR/HDR info → **`04` checks 1–10**, `02` checks 2–3, `08` check 3. Layers: integration + E2E; one real public URL run **manually** and recorded (URL + date).

### 5.2 Transcription
Local transcription on fixtures; word-timing accuracy ≥ 90% within ±150 ms; 30-minute run with progress/ETA/cancel/resume/kill; language detect/override; online provider path (mock + one real, if a key exists); consent dialog; transcript editing (4 semantics), re-transcribe selection, undo; caption sync; export TXT/SRT/VTT/JSON → **`05` checks 1–10**, `06` checks 4–5, `11` checks 6, 10.

### 5.3 AI clipping
Candidate generation, boundaries, dedupe, scoring/weights/confidence/Auto; LLM JSON robustness; **benchmark ≥ 60% in top-K in AI mode** (record the Basic number too); end-to-end 60-minute offline (Ollama) and online (one provider); Basic mode labelled; clip creation single/batch with aspect/range/framing/captions/markers/naming/v2; honesty scan → **`07` checks 1–10**.

### 5.4 Timeline, preview, editor
Playhead, tracks, clips, editing ops, overlap policy, snapping, drag and drop (library/Explorer/panels), transitions, keyframe lanes, markers, zoom/scroll, persistence, performance, quality → **`09` checks 1–30**; direct manipulation, crop, text edit, guides, parity, frame accuracy, playback sync → **`10` checks 1–13**; layout/library/clip bin/inspector/batch → **`08` checks 1–13**.

### 5.5 Captions, text, graphics
10 presets × 4 aspect ratios, legibility, style editor, import/export of `.cwstyle`, operations, sync, animations deterministic, fonts offline, SVG sanitiser, SRT/VTT → **`11` checks 1–11**.

### 5.6 Keyframes, effects, transitions, audio
→ **`12` checks 1–15** (including preview/export audio parity, normalisation, ducking, voiceover, noise reduction).

### 5.7 AI editing tools
→ **`13` checks 1–10** (CORE all; STRETCH only if shipped; LATER absent).

### 5.8 Providers and offline/online
Providers add/test/default/remove, key secrecy, router table, **offline run with zero egress**, model manager (resume, hash), Ollama states, consent, error mapping → **`06` checks 1–12**.

### 5.9 Storage and recovery
→ **`03` checks 1–14** (kill tests, disk full, restore points, migration, package round trip, workspace move, secrets scan, uninstall/reinstall).

### 5.10 Export
→ **`14` checks 1–17** (full aspect × preset × fps matrix, sync, integrity, parity, determinism, codecs, hardware fallback, captions, queue, validation fault injection, failures, loudness, soak).

### 5.11 Updates, packaging, release
→ **`15` checks 1–15** (clean VM, portable, uninstall, update, tamper, rollback, CI, security config, licences, yt-dlp updater, no telemetry).

### 5.12 Design system and UX
→ **`01` checks 1–10**; `02` checks 1, 4–10 (first run, cards, stepper, progress screens, quit-mid-task).

---

## 6. CROSS-CUTTING TESTS (owned here)

### 6.1 Offline / online matrix
Run the **end-to-end golden path** (import → transcribe → moments → create clip → edit → export → validate) in each configuration and record the result:
| # | Configuration | Expected |
|---|---|---|
| A | **Fully offline**, Whisper installed, Ollama running with a model | completes; AI scoring; **zero outbound connections** (network capture) |
| B | Fully offline, Whisper installed, **no Ollama** | completes with **Basic scoring** clearly labelled |
| C | Offline, **no Whisper model** | blocking dialog offers download/switch; nothing runs; no crash |
| D | Online, valid provider (transcription + text) | completes; consent shown once; chips show Online; data-sent log metadata only |
| E | Online, **missing key** | "Set up a provider" dialog; no network call |
| F | Online, **invalid key** | plain error mapped; retry/switch offered; key never logged |
| G | Network drops mid-transcription (online) | clear message, asked before any fallback, resume works |
| H | Network unavailable, URL input | clear offline message; local file path still works |
| I | Automatic mode with consent not granted | stops to ask; never sends silently |
Every row passes with real runs (D/F/G use a real provider **or** the mock + a recorded note "real provider not run").

### 6.2 Network egress audit
With a capture (Windows `pktmon`/Wireshark or a proxy in the test harness), run (a) a full offline session, (b) a session with all optional features off: the only hosts contacted must be those in `06 §8` / `15 §10`, only when the user triggered them. The audit is recorded with the host list.

### 6.3 Security and privacy
Electron flags asserted (`15` check 12); CSP blocks inline script and remote origins (test attempts); IPC validation rejects malformed messages (fuzz test of every channel with zod-violating payloads: no crash, no side effects); path traversal attempts through IPC/project files rejected; secret scan of DBs/logs/packages/crash dumps for planted test keys; `shell.openExternal` only https; SVG/Markdown sanitisers tested; archive import (zip-slip) test for `.cwpack`/`.cwbrand`; dependency audit (`pnpm audit`) with high/critical issues triaged and recorded.

### 6.4 Accessibility
Automated axe-style scans on: Home, Import progress, Transcribe, Moments, Editor, Export panel, Settings, dialogs (no critical/serious violations); contrast check on every token pair (`01` check 3); keyboard-only walkthrough of the golden path (record it); visible focus rings; `aria-live` for progress/status; screen-reader labels on icon buttons (a lint rule + test enumerating icon buttons without names).

### 6.5 Responsiveness and Windows scaling
Screenshot grid: **{Home, Moments, Editor, Export}** × **{1100×680, 1280×720, 1366×768, 1920×1080, 2560×1080}** × **{100%, 125%, 150%, 200%}** — no overlap, clipping or horizontal page scroll; controls reachable; icons crisp. Recorded as an image index in `docs/verification/screens/`.

### 6.6 Performance benchmarks (record numbers)
Timeline interaction fps with 500 items/10 tracks, open time of a 2,000-item project, command latency, preview playback fps, seek latency, export speed (1080×1920@30 and 2160×3840@30/60), transcription throughput per model, moments pipeline time on 60 minutes, auto-reframe speed, memory over a 30-minute export, UI fps during export, startup time (cold, warm). Each compared with its target in the owning spec; misses are **fixed or documented** in `docs/limitations.md` with the measured number.

### 6.7 Reliability / chaos
- Kill the app at random moments (20 runs) while editing → recovery ≤ 2 s loss (`03`).
- Kill during download, transcription, proxy, export → relaunch resumes or cleans correctly.
- Fill the disk during import/export/checkpoint (VHD) → clear handling.
- Pull the workspace drive (USB) mid-edit → in-memory preservation and recovery.
- Corrupt a project database byte → quarantine/recover path, app opens.
- Run a 4-hour soak: open, edit, undo/redo, play, export repeatedly: no memory growth beyond 10%, no crash.

### 6.8 No-fakes audit (automated + human)
1. **String/UI scan:** no occurrences of banned claims ("viral", "guaranteed", "perfect", "studio quality") (`07` check 10, `13` check 9).
2. **Code scan:** CI fails on `TODO: mock`, `fake`, `dummy`, `placeholder` in production source paths (allowlist for test folders and UI placeholder *attributes*), on `Math.random` in the compositor/export/animation code, on hard-coded sample results in `ai-core`, and on any `setTimeout`-driven progress in production code.
3. **Progress honesty test:** instrument each progress screen with a test that compares displayed percent to the underlying counters (bytes, frames, chunks): they must agree within 1%, never move without work happening, and never reach 100% before completion.
4. **Button audit:** an E2E walker visits each screen and **activates every enabled button/menu item** in a scratch project; none may be a no-op (each must produce a state change, navigation, dialog, toast, or documented disabled state).
5. **Disabled-feature audit:** any feature disabled or removed to pass a test is listed in `docs/limitations.md` with the reason; the audit compares the feature list in the specs with the shipped UI and reports deltas.

---

## 7. E2E SCENARIOS (Playwright; each must pass on the real app)
1. **First run → golden path** with the 2-minute fixture, offline, Basic mode; verify exported file.
2. **URL path** with a local test HTTP server serving a direct video URL (plus the manual real-URL run).
3. **Moments:** sort/filter/search/favourite/reject/undo; edit boundaries; Find more; Create clips (3) → editor opens on the first.
4. **Editor core:** drag media to timeline, split/trim/ripple/insert/overwrite, undo/redo 50 steps, multi-select group move, magnetic main track, track create/rename/lock/hide, markers, zoom/scroll/fit, playhead keys, preview move/scale/rotate/crop/text edit, snapping with guides, drop from Explorer (via `fileChooser`/`setInputFiles` and synthetic drag events).
5. **Captions:** generate, change preset (all 10), edit words/timing, split/merge, per-word emphasis, import/export style, find & replace, transcript sync badge.
6. **Keyframes/effects/transitions/audio:** add keyframes via three paths, curve editor, effects chain, transitions at junctions, audio fades/volume line/ducking/normalise, voiceover (fake audio device via Chromium flags) — with the fake device clearly named in the report.
7. **AI tools:** edit by transcript, silence removal, auto-reframe, auto emphasis, brand kit apply (single and batch).
8. **Persistence:** save → close → reopen → identical state (hash of serialised composition); autosave/kill recovery; project package export/import on a clean workspace.
9. **Export:** queue, cancel, retry, batch, validation fault-injection, subtitle sidecars.
10. **Settings:** every settings section loads, changes persist after restart, reset-to-default works, shortcuts rebind, providers/models/updates/privacy pages function.
11. **Updates:** check (mock release server + real release), verify, tamper rejection, install flow in the VM.
12. **Quit-mid-task:** transcription/export running → quit → confirm → relaunch → resumes.

---

## 8. THE EXPORT VERIFICATION SCRIPT (`scripts/verify/export-matrix.ts`)
Input: a list of `(composition, settings)` pairs. For each: run the real export, then independently of the app run `ffprobe`/`ffmpeg` and assert the **§7 checks of `14`** (width/height, aspect, fps, duration, frame count, PTS regularity, audio stream, A/V start offset, full decode, black/freeze frames vs expected, loudness, codec/profile, metadata). Output a table with **measured vs expected** values per cell and a JSON log. **The final report must embed this table.** The script must also be able to be pointed at **any exported file** so the owner can re-verify.

---

## 9. MANUAL VERIFICATION CHECKLIST (recorded with date, tester, screenshots)
1. Play three exported files (portrait 1080×1920 with captions, landscape 1080p with transitions, 4K) in **VLC and Windows Media Player/Photos**: picture, sound, sync, captions look as in the editor.
2. Upload-free check: open an exported MP4 on a phone (transfer by cable/cloud by the owner) — recorded as "owner-confirmed" or "not run".
3. Visual review of every screen against `01` and its Avoid list; take the screenshot set; mark any deviation.
4. Subjective feel: scrubbing, drag, zoom, playback smoothness on the reference machine (note any stutter).
5. Documentation read-through: README install steps executed literally on a clean VM.
6. Review of error messages: trigger each error in the `04 §3.4`, `05 §13`, `06 §9`, `14 §8` tables and confirm the wording and actions.

---

## 10. THE VERIFICATION REPORT (`docs/verification.md`) — REQUIRED FORMAT

Structure (fill with real data; **no section may be empty or "TBD" at completion**):
1. **Summary:** app version/commit, date, reference machine (§3), overall status (Complete / Complete with documented limitations / Incomplete — with reasons).
2. **Deliverables:** installer path + SHA-256, portable path + SHA-256, GitHub Releases URL, release notes URL, repo path.
3. **Completed features:** a table of every spec (01–16) → section list → status (✓ Verified / ⚠ Verified with limitation / ✕ Not delivered) → evidence link (test name, artefact).
4. **Tests executed:** counts per layer (unit N/N passed, integration, E2E, matrix cells, benchmarks), CI run URL(s), date/time, failures found and how they were fixed (a short **defect log**: id, symptom, root cause, fix, regression test).
5. **Export verification:** the §8 table — every aspect × preset × fps cell with measured width/height/fps/duration/frames/A-V offset/loudness/validation result; the actual formats verified (MP4 H.264/AAC, WebM VP9/Opus, HEVC if any) and the players used.
6. **Parity and determinism results:** SSIM numbers per fixture; hash comparisons.
7. **Offline/online matrix** (§6.1) results and the egress audit host list.
8. **AI quality numbers:** word-timing accuracy, moments benchmark (AI and Basic), silence/filler detection, auto-reframe containment, caption legibility, loudness accuracy.
9. **Performance numbers** vs targets (§6.6).
10. **Update system verification:** the real GitHub test-release URL, no-update/available/error/tamper/rollback results (`15 §12`).
11. **Packaging verification:** clean-VM runs (OS build), installer/portable/uninstall results, security-config test, licence check, bundle sizes.
12. **Accessibility, responsiveness, design review** results and the screenshot index.
13. **Known limitations** (copied/linked from `docs/limitations.md`): each with impact and workaround; includes anything **not run** with the reason.
14. **Open risks / follow-ups** (honest list).
15. **Sign-off checklist** (§11).

---

## 11. COMPLETION GATE (the app is "complete" only when ALL are true)
1. Every phase checkpoint in `00 §6` passed and is tagged.
2. All **CORE** features of every spec pass their acceptance checks; any check that cannot pass is documented as a limitation **with evidence** and the user-facing feature is hidden or clearly labelled (never left silently broken).
3. **0 open Critical/High defects** (crash, data loss, wrong export, security issue); Medium defects documented with workarounds.
4. The **export matrix** (§8) has no failed cell; A/V sync < 1 frame; validation fault-injection tests pass.
5. The **offline matrix** A, B, C pass with zero egress in A/B.
6. The **clean-VM install, uninstall, update and rollback** checks pass with the actual artefacts.
7. The **no-fakes audit** (§6.8) passes.
8. `docs/verification.md` is complete, accurate and matches the artefacts; every number in it came from a run recorded in `docs/verification/` (logs, JSON, screenshots).
9. The GitHub Release exists with the installer, portable exe, checksums, signed manifest, notes (with the Unsigned notice if applicable), and the link is in the report.
10. A final **fresh-clone build** (`git clone` → `pnpm install` → `pnpm build` → `pnpm dist`) succeeds from the documented instructions.
If any item is false, the status is **Incomplete** and the report says so — **do not** present partial work as complete.

---

## 12. FINAL DELIVERABLES MESSAGE (what the agent tells the owner, in this order)
1. One-paragraph status (Complete / with limitations / incomplete).
2. **Exact locations:** repository URL and local path; installer path; portable path; GitHub Releases link; verification report path.
3. App version, SHA-256 of each artefact, signed/unsigned statement.
4. The 10 most important verification results (numbers).
5. Known limitations and anything not run (with reasons).
6. How the owner can re-verify: install steps, `scripts/verify/export-matrix.ts` usage, how to run the smoke test.
Do not say it is built without providing the actual artefacts and the evidence.

---

## 13. DEFECT HANDLING RULES
- Every failing check produces a **defect entry** (id, severity, steps, expected/actual, evidence) before any fix; the fix **must** include a **regression test**; the check is re-run and its new result recorded.
- **Never** change a test's expected value to match a bug; if a spec is wrong, record it in `docs/decisions.md` with the reasoning and update the spec text and test together in one commit.
- Flaky tests are **fixed** (root cause) or **quarantined with a ticket and a limitation entry**; a test that is retried until it passes without understanding why is not acceptable.
- Re-run the **full** affected matrix after any change to the compositor, audio mixer, export planner, timeline engine or storage layer.
