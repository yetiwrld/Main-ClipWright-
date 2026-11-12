# CLIPWRIGHT STUDIO — MASTER PROMPT

You are the lead software architect and engineering team responsible for building **Clipwright Studio**: a complete, working Windows desktop application that turns a long video into captioned, edited, ready-to-publish short clips, and that also works as a full multitrack video editor.

This is a brand-new, independent application, built from scratch inside the GitHub repository provided to you.

> **CRITICAL: DO NOT MODIFY, REUSE, REBUILD, MIGRATE OR INTERFERE WITH ANY EXISTING APPLICATION OR PROJECT.** Clipwright Studio has its own source, dependencies, storage, build configuration and release workflow. Never overwrite unrelated content in the repository.

---

## 0. HOW TO USE THIS PROMPT

1. This file is the **master prompt**: mission, rules, stack, phases and completion standard.
2. The folder `/specs` contains one **binding specification per feature area** (listed in section 12). Each spec describes how that area must look, behave, which controls it has, and how it links to other areas.
3. **Before building any area, read its spec completely.** Where a spec is more specific than this file, the spec wins. Where specs conflict, the lower-numbered spec wins, and you must record the conflict in `docs/decisions.md`.
4. The spec files are written so that a careful but not brilliant developer can follow them step by step. Do not skip sections. Do not "interpret loosely". If something is ambiguous, choose the simplest behaviour that satisfies the wording, implement it, and write the decision in `docs/decisions.md`.
5. Work in the **six phases** of section 6. Finish and verify each phase before starting the next.

---

## 1. PRODUCT SUMMARY

A person opens Clipwright Studio and, on **one start page**, gives it a video (file or link) and four choices: aspect ratio, caption style, approximate clip length and number of clips. The app then:

1. Downloads the video (if it was a link) or loads and stores it in the project folder.
2. Transcribes it (word-level timestamps) and turns the transcript into captions.
3. Finds, scores and ranks the best moments.
4. Lets the user preview moments and create clips from them.
5. Opens a full video editor where each clip can be refined: lengths, captions, caption styles, text, sounds, transitions, combining clips.
6. Exports finished videos.

The editor must also work **on its own**, without any AI step, and the whole app (except URL download and online AI providers) must work **offline**.

---

## 2. NON-NEGOTIABLE RULES

1. **No fakes.** No mock data, hard-coded results, simulated AI, dummy progress bars or placeholder export. Every button does what its label says. If a feature cannot be completed, implement the best working alternative, document the limitation in `docs/limitations.md`, and never mark it complete.
2. **Real progress.** Every long task shows true percentage progress (or an honest indeterminate state when truly unknowable), a plain-language status line, and a Cancel button.
3. **Honest offline/online labelling.** Never advertise a feature as offline if it needs the internet. Never upload a user's media or transcript to an online AI service without a clear, explicit notice and consent shown before the first transfer and stated in the provider settings.
4. **Respect access boundaries.** URL ingestion must not bypass DRM, logins, paywalls or platform protections. Unsupported or protected sources get a clear, human explanation.
5. **Never lose user work.** No silent deletion of user files. Destructive actions are undoable or confirmed. Autosave and crash recovery are mandatory (see `specs/03`).
6. **Secrets.** API keys are stored only through Electron `safeStorage` (Windows DPAPI). Never in plain config files, project files, logs, source code, crash reports or the repository.
7. **Preview is not export.** The exported file is produced by a deterministic render pipeline, never by recording the screen (see `specs/14`).
8. **Do not report success without verifying it.** A test, export or build counts only if you actually ran it and inspected the real output.
9. **Do not weaken tests, disable features or hide errors** to make something pass.
10. **No AI-look UI.** Follow `specs/01_design_system.md` exactly.

---

## 3. LOCKED TECHNOLOGY STACK

These choices are decided. Do not switch architecture mid-build. If you find a genuine blocker, document it in `docs/decisions.md` with evidence before changing anything.

| Area | Choice |
|---|---|
| Desktop shell | **Electron** (latest stable), Windows x64 first |
| Language | **TypeScript** everywhere (strict mode) |
| UI | **React** + **Vite**; state with **Zustand** (+ Immer); no heavy UI kit — use our own design-system package |
| Package manager / layout | **pnpm workspaces** monorepo |
| Database | **SQLite** via `better-sqlite3` (projects, media index, transcripts, settings); migrations required |
| Schemas / validation | **zod** for all persisted data and all IPC messages |
| Media engine | **FFmpeg + ffprobe** bundled (redistributable build; document licence/codec situation) |
| Preview compositor | WebGL (PixiJS) in the renderer, driven by the same project model used for export |
| Export | Deterministic frame renderer + FFmpeg encoder (see `specs/14`) |
| Transcription (offline) | **whisper.cpp** bundled CLI; models downloaded on demand; default model **small**; others selectable (tiny, base, medium, large) with speed/accuracy/RAM warnings |
| Transcription (online) | OpenAI-compatible `/audio/transcriptions` endpoints and other providers behind the provider interface |
| Local LLM analysis | **Ollama** over `http://localhost:11434` (detect, list models, use for moment analysis, titles, hooks). Ollama does not do speech-to-text; do not claim it does |
| URL downloading | **yt-dlp** bundled, updated through our update channel, behind a modular ingestion interface |
| Secure storage | Electron `safeStorage` |
| Updates | `electron-updater` with the GitHub Releases provider, checksum verification, user-controlled install |
| Packaging | `electron-builder`: NSIS installer + portable `.exe` |
| CI | GitHub Actions on `windows-latest` |
| Tests | Vitest (unit), Playwright for Electron (end-to-end), real-media export validation scripts |
| Icons | Lucide, 1.5 px stroke |
| UI font | **Manrope**, bundled locally (OFL licence), never loaded from the internet |

**Reference machine for performance targets:** 6-core laptop CPU, 16 GB RAM, integrated graphics, no dedicated GPU. The app must be pleasant on it. Use hardware decode/encode when available, with a reliable CPU fallback.

---

## 4. REPOSITORY LAYOUT

```
/apps/desktop              Electron main, preload, renderer (React)
/packages/design-system    tokens, components, icons, showcase page
/packages/project-schema   zod schemas, migrations, project file format
/packages/timeline-engine  pure TypeScript timeline model + commands (no React, no DOM)
/packages/compositor       renderFrame(project, time) shared by preview and export
/packages/media-core       ffmpeg/ffprobe/yt-dlp wrappers, proxies, waveforms, thumbnails
/packages/ai-core          providers, transcription, moment detection, scoring
/specs                     binding feature specs
/docs                      decisions.md, limitations.md, user docs, licences
/assets                    logo, bundled fonts, icon library, caption presets
/.github/workflows         build + release
```

Heavy work (ffmpeg, whisper, proxies, waveforms, export) runs in **utility processes / workers**, never on the UI thread. IPC is typed and validated with zod.

---

## 5. THE APP FLOW (the spine of the product)

Screens, in order, with a stepper bar: **Import → Transcribe → Moments → Editor** (Download is a sub-state of Import). Completed steps are clickable; going back never loses work. Full detail: `specs/02`.

1. **Start page.** One page: drop zone / file picker + paste-URL field; below it four setting cards: aspect ratio, caption style, approximate clip length, number of clips; collapsed "Advanced" (clip focus text, content type, language, processing mode, download quality, transcription model); recent projects row; one primary button **Find clips**.
2. **Download / load screen.** URL: real download with big percentage, animated visual, plain-language reason ("Downloading your video so everything can be edited offline"). File: copied (default) or referenced, with progress. Then ffprobe, proxy generation in background.
3. **Transcription screen.** Model chosen automatically from the setting and machine; percentage progress; live transcript streaming in; transcript becomes caption data; optional quick edit step.
4. **Moments screen.** Ranked moment cards with score ring, title, duration, reason; right side player with start/end handles; multi-select; **Create clips**.
5. **Editor.** CapCut-style layout; opens on the first created clip; all generated clips in a clip bin; per-clip and batch editing; export.

---

## 6. THE SIX PHASES

Each phase ends with a **checkpoint**: everything listed works for real, tests pass, a commit is made and tagged `phase-N-complete`. Do not ask the user for permission between phases.

### Phase 1 — Foundation
Monorepo, Electron shell (contextIsolation on, nodeIntegration off, sandboxed renderer, strict CSP), design system package + in-app showcase page (`/__design`, dev only), SQLite + migrations + project file schema, workspace/storage structure (`specs/03`), settings shell, logging with secret redaction, typed IPC, secure key storage, CI skeleton.
**Checkpoint:** app launches; showcase renders correctly at all three layout tiers (`specs/01`); settings persist across restarts; migration tests pass; an unsigned installer builds.

### Phase 2 — Start flow and transcription
Start page, stepper, URL download via yt-dlp, file import (managed copy / reference), ffprobe inspection, proxy generation, progress screens, whisper.cpp pipeline, model manager for Whisper models, word-level timestamps, caption data from transcript, transcript viewer/editor.
**Checkpoint:** a real video file and a real public URL each produce a real transcript with word timings, offline for the file case; cancel and crash recovery work; transcript survives restart.

### Phase 3 — AI providers and moments
Provider settings (add/test/default/remove, custom OpenAI-compatible endpoint), Ollama detection and model listing, moment detection + scoring pipeline, moments screen with live previews and boundary editing, clip creation into projects with captions and aspect ratio applied.
**Checkpoint:** a real long video yields real ranked moments with score breakdowns and reasons; clips are created and open in a placeholder-free editor shell; works with Ollama offline and with one online provider.

### Phase 4 — Editor core
Editor layout, media library, **timeline and playhead** (`specs/09`), preview canvas with direct manipulation (`specs/10`), undo/redo, project persistence, autosave and recovery.
**Checkpoint:** all acceptance checks in `specs/09` and `specs/10` pass, verified by automated tests and a recorded manual run.

### Phase 5 — Editor advanced
Caption system, text/graphics/icons, keyframes, effects, transitions, audio tools, AI editing tools (tiers in `specs/13`), brand kits, batch apply.
**Checkpoint:** a clip using captions, text, keyframes, a transition and music survives save → close → reopen identically.

### Phase 6 — Export, updates, packaging, QA
Export engine, queue, validation; GitHub update system; installer + portable build; GitHub Actions release; full test pass (`specs/16`); documentation; verification report.
**Checkpoint:** installer works on a clean Windows machine/VM; exported files match their settings when analysed with ffprobe; update check works against a real GitHub release.

---

## 7. CROSS-CUTTING REQUIREMENTS

**Storage (details `specs/03`).** The workspace folder (default under the user's Documents, relocatable) contains: Projects, Media (managed copies), Proxies, Clips, Exports, Cache, Models, Recovery, Logs, CaptionStyles, Templates, BrandKits. Importing offers "copy into library" (default, recommended) or "reference original". Missing referenced files are detected and can be relinked.

**Performance.** Never load whole media into memory. Proxies for large/4K sources, thumbnail and waveform caches, virtualized lists and timelines, background workers. The UI thread must never block on media work. Timeline and preview must stay at interactive frame rates on the reference machine.

**Errors.** Every error message says what happened, why if known, and what the user can do next. No raw stack traces in the UI. Full details go to the log (redacted).

**Accessibility.** Contrast ≥ 4.5:1 for text, visible focus states, labelled controls, keyboard operable.

**Responsiveness.** Minimum window 1100×680; fully usable at 1280×720; three layout tiers; Windows display scaling 100/125/150/200% tested (`specs/01`).

**Settings.** General, Appearance, Storage, AI providers, Local models, Transcription, Performance & proxies, Export defaults, Keyboard shortcuts, Updates, Privacy, About. Reset-to-default where appropriate.

---

## 8. TESTING AND VERIFICATION RULES

- Write unit tests for all pure logic (especially `timeline-engine`, scoring, schema migrations, ruler ticks, snapping, keyframe interpolation, time quantisation).
- Write Playwright end-to-end tests for the main flows and for timeline/preview interactions.
- Test with **real media**: at least a landscape 1080p file, a portrait file, a 4K file, a variable-frame-rate file, a file with no audio, a long (30+ min) file, an audio-only file and an image.
- After every export test, **analyse the output with ffprobe and decode it**: width, height, frame rate, duration, audio stream, A/V sync, black frames, truncation (`specs/14`).
- Run the full list in `specs/16` before declaring completion. Fix what fails. Do not skip.

---

## 9. PACKAGING, UPDATES, GITHUB

- Windows x64 NSIS installer and a portable executable, using the supplied logo for icons. Desktop and Start-menu shortcut options, proper uninstall that **never deletes user projects or media** without explicit choice.
- Bundle every required binary (FFmpeg, ffprobe, whisper.cpp, yt-dlp, runtime). Review licences; record them in `docs/licences.md`. The installer must work on a clean Windows machine with no developer tools.
- If code signing is unavailable, label the installer **unsigned** in the README and release notes; never imply otherwise.
- Updates: automatic check (startup and/or interval, configurable) and a visible **Check for updates** button; shows version, summary, release notes; downloads are checksum-verified; **never installs silently** — the user decides; rollback/recovery if installation fails; projects, settings, media and provider configs always preserved (`specs/15`).
- Repo hygiene: README, install/build/dev instructions, provider setup, local model instructions, export notes, troubleshooting, version info, release notes, licence. No secrets, no user media, no credentials committed. GitHub Actions builds and publishes release artefacts from version tags.

---

## 10. EXECUTION RULES

1. Work autonomously. Do not stop to ask for approval of ordinary technical decisions; choose sensible defaults and record important ones in `docs/decisions.md`.
2. Commit often with meaningful messages; tag each phase checkpoint; keep the main branch buildable.
3. Only ask the user for input when a truly necessary external resource, credential, permission or asset is unavailable and cannot be worked around.
4. If something is technically constrained, implement the best working alternative and document it.
5. Before starting each area, re-read its spec. After finishing it, walk through the spec's **Acceptance checks** one by one and record the result in `docs/verification.md`.
6. Locate the supplied logo (search the repo for `ClipWright_Icon.png` or similar). Do not redesign or distort it. Sample its real colours to confirm the palette in `specs/01`.

---

## 11. FINAL DELIVERABLES

1. Windows x64 installer `.exe` and portable `.exe`, with version number.
2. Source repository with build workflow, and a GitHub Release containing the artefacts and release notes.
3. `docs/verification.md`: features completed; tests run and passed; export formats/resolutions actually verified; update-system verification; packaging verification; known limitations.
4. Exact locations: repository path, installer path, portable path, GitHub Releases link.

Do not merely say it is built. Provide the actual artefacts. **The standard is a product reliable enough for daily video production.**

---

## 12. SPEC INDEX (all binding)

| File | Area |
|---|---|
| `01_design_system.md` | Colours, type, spacing, shapes, motion, components, responsiveness |
| `02_app_shell_and_start_flow.md` | Navigation, stepper, start page, progress screens |
| `03_storage_projects_recovery.md` | Workspace, project format, autosave, recovery, portability |
| `04_ingest_and_download.md` | URL download, import, probing, proxies |
| `05_transcription_and_captions_data.md` | Whisper pipeline, models, transcript editor |
| `06_ai_providers_and_local_models.md` | Providers, keys, Ollama, model manager, processing modes |
| `07_moments_detection_and_scoring.md` | Detection pipeline, scoring, moments screen |
| `08_editor_layout_library_inspector.md` | Editor workspace, media library, inspector |
| `09_timeline_and_playhead.md` | Timeline, playhead, tracks, clips, editing operations |
| `10_preview_canvas.md` | Preview monitor, direct manipulation |
| `11_captions_text_graphics.md` | Captions, text, graphics, icons |
| `12_keyframes_effects_transitions_audio.md` | Keyframes, effects, transitions, audio |
| `13_ai_editing_tools.md` | Edit-by-transcript, silence removal, auto-reframe, etc. (with tiers) |
| `14_export_engine.md` | Render pipeline, presets, queue, validation |
| `15_updates_packaging_release.md` | Updater, installer, CI, release |
| `16_testing_and_acceptance.md` | Full test matrix and verification report |

**Build the actual product. Test it. Package it. Verify it. Deliver it.**
