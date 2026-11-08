# Clipwright Studio — Known Limitations & Scope Notes

This document tracks architectural scope boundaries and honest limitations per `specs/00` §2.1, `specs/03` §9, `specs/10` §10, `specs/11` §11, `specs/12` §3–6, `specs/13` §2, `specs/14` §9, `specs/15` §6, and `specs/06`/`specs/07` (Phase 3).

---

## 1. Documented v1 Scope Boundaries

1. **No schema downgrade migration (`specs/03` §9):** Projects saved by a newer major schema version (`schemaVersion > CURRENT_SCHEMA_VERSION`) open in **read-only mode** with a clear banner advising the user to update Clipwright Studio. Unknown JSON fields within the same schema version are preserved via `.passthrough()`.
2. **Mixed-language transcripts (`specs/05` §6):** v1 uses one primary language per transcript (auto-detected or user-selected).
3. **Reverse playback & clip reversal (`specs/10` §10, `specs/12` §5):** `J` in the transport steps backward by 1 second (or frames on intra-frame proxies) rather than continuous reverse audio playback; clip timeline reversal is out of scope for v1.
4. **Text on a path / 3D text / gradient text fills (`specs/11` §11):** Text items support solid fills, strokes, shadows, backgrounds, and 12 keyframe-based animations; 3D extrusion, curved path text, and gradient text fills are out of scope in v1.
5. **Animated GIF imports (`specs/04` §2, `specs/11` §12):** Imported `.gif` files render their first frame statically; use `.mp4` or `.webm` for animated overlays.
6. **Audio-only composition export (`specs/12` §6.9):** v1 exports video containers (`.mp4`, `.webm`); an audio-only timeline exports as a video with the composition's canvas background colour.
7. **4K 60 fps CPU export speed (`specs/14` §10):** On machines without a hardware encoder (NVENC/QSV/AMF), 4K 60 fps software encoding (`libx264`) runs slower than real-time while maintaining full frame accuracy and deterministic output.
8. **Unsigned Windows installer (`specs/15` §6.4):** When built without a commercial Authenticode certificate (`CSC_LINK`), the Windows installer and portable executable are **unsigned**. Release notes, the README, the installer, and the in-app updater clearly label builds as **Unsigned** and verify authenticity via Ed25519-signed `release-manifest.json.sig` plus SHA-256/SHA-512 checksums.
9. **Architecture support (`specs/15` §6.1):** Windows x64 is the primary target for v1; Windows ARM64 runs via x64 emulation.
10. **Roadmap ("LATER") features not in v1 (`specs/13` §2):** Offline speaker diarization, multi-language caption translation tracks, AI voice dubbing, key-less background removal, B-roll suggestion, and multi-speaker split-screen auto-layout are reserved for future versions and are absent from the UI.

---

## 2. Phase 3 notes (AI providers & moments)

1. **Model checksums ship empty:** `/assets/model-checksums.json` has no Whisper or ONNX digests yet. Downloads still work, but a file is reported as **unverified** rather than "verified", and the Verify button says so plainly. Digests are added as each build is verified against a real file — Clipwright never ships a hash it has not checked.
2. **No benchmark numbers yet:** `docs/verification.md` has no entry for SPEC 07 §13.6 (share of human-labelled moments in the top K) because that requires a reference machine with a local model. The labelled fixtures and the benchmark test exist and assert only what Basic mode can promise.
3. **Provider calls are tested against mock servers only:** the provider contract tests drive a local HTTP server. No real OpenAI/Anthropic/Gemini/Ollama calls are recorded here, because that needs the user's own keys and network. Nothing is reported as "verified against a real service" until it has been.
4. **Ollama cannot be probed in this environment:** detection, listing, pull progress and `num_ctx` plumbing are covered by adapter tests against a mock; the model manager shows "Not found" when no server answers, which is the honest state.
5. **"Speed ≈ N× real time"** appears only after a local transcription has actually been timed on this machine; until then the card says "speed unknown".
6. **Online transcription uploads audio only:** the 16 kHz mono WAV is what leaves the computer, never the source video, and only after the consent dialog for that provider and category. The data-sent log records the byte count, never the audio.
7. **Playwright smoke tests** still cannot run in this sandbox (no browser binaries), so UI flows are covered by typechecking, the design-system token audit and the unit/integration tests in `apps/desktop/src/main/__tests__`.

---

## 3. Phase 4 notes (editor core, in progress)

1. **Playback clock is the animation-frame timer, not the audio output.** SPEC 09 §23 makes the audio device position the master clock whenever audio plays. This slice advances the playhead from `performance.now()` and lets the `<video>` element follow it, so a long playback can drift from the audio by a frame. Audio-mastered playback lands with the audio tools.
2. **Preview uses the original media and seeks the `<video>` element.** Proxies are generated during import but the preview does not yet switch to them, so scrubbing a 4K source is slower than the "use proxies by default" requirement.
3. **Not every SPEC 09/10 acceptance check is automated yet.** Covered by unit tests: time model and timecode, frame quantisation, all five commands plus `addItem`, invariant checks after every command, undo round-trips, snapping maths, and the project-duration selector. Not covered: gesture feel (marquee, razor, rolling edit, ripple-trim modifiers), the React re-render assertions from SPEC 09 §27, and every visual check in SPEC 09 §30 / SPEC 10 — those need a real window.
4. **Implemented so far:** select/marquee selection, razor tool, move, trim (incl. ripple Shift-drag and Q/W trim-to-playhead with Shift ripple), split, delete, ripple delete, duplicate, copy/cut/paste, group/ungroup, Alt+Up/Down track moves, markers, snapping, zoom, scroll, timecode entry, mute toggles, undo/redo. **Not implemented yet:** linked audio detach/unlink, transitions, markers in the ruler, context menus, in-editor import.
5. **The media library lists imported media but does not import from inside the editor** (drag-in from Explorer, replace, relink, "in use" counts). Importing still happens on the start screen.
6. **Inspector edits are limited to start, ±1 frame duration and a read-only volume readout.** Transform/opacity/crop editing, keyframes and the section set from SPEC 08 §7.2 arrive with Phase 5.
7. **Left panel has only the Media tab.** Captions, Text/Graphics, Effects/Transitions, Audio and AI tabs are Phase 5; nothing pretends to be there.
8. **Panel sizes are not persisted per user/tier yet** (SPEC 08 §3.3); they reset to the defaults on reload, while timeline zoom, scroll and the playhead are persisted in the project payload.

---

## 4. Phase 6–7 notes (export, updates, packaging)

### Export

1. **Captions are burnt in; the rest of the compositor is not yet.** Captioned
   exports are rendered by ffmpeg from a generated ASS script, so font, weight,
   size, fill, outline, shadow, position and karaoke timing all come from the
   `.cwstyle` and match the preview (SPEC 11 §3). What is still missing is the
   *video* compositor: each video/image item is decoded by its own ffmpeg process
   and the topmost visible item is written, so effects, transitions, keyframed
   transforms, blend modes, masks and the `rotationJitterDeg` per-caption tilt are
   **not rendered**. Where nothing is on the timeline you get the canvas colour.
   The export dialog says so before you press Export.
2. **ASS is a smaller language than the style format.** A blurred drop shadow is
   approximated by its vertical offset, and letter-spacing is in pixels rather than
   ems, so a style with a heavy blur will look slightly cleaner on export than in
   the preview. Everything the ten presets ask for is expressible. The per-caption
   `rotationJitterDeg` tilt is not applied — ASS has no per-event rotation, so the
   tilt exists in the preview and the editable style but not in the burned-in file.
3. **Project-local style copies are not stored yet.** The resolver supports
   preset → project copy → item overrides (SPEC 11 §6), and the export path accepts
   a style map, but nothing writes one to the project file, so `styleOverrides` on
   an item is the only per-caption customisation that currently survives to export.
4. **No frame blending.** Frame-rate conversion uses nearest-time selection.
5. **No resumable export.** A failed or interrupted export restarts from the
   beginning (SPEC 14 §9 is not implemented).
6. **Hardware encoding is validated, not assumed — and not proven here.** The
   app tests a candidate encoder with a real short encode before using it, and
   falls back to software when it fails. But no machine with NVENC, QSV or AMF
   was available while this was written, so the *validation logic* is tested and
   the actual GPU output is not.
7. **Audio effects are not applied.** Gain, fades, panning, ducking and loudness
   normalisation are; the equaliser, reverb and other audio-rack effects are not
   yet in the mix.
8. **4K 60 fps on CPU is slower than real time.** It completes and validates;
   it is just slow.

### Updates

7. **The embedded update public key is a placeholder.** Until
   `docs/release.md` §1.1 is done, the build **refuses every update**. That is
   the intended behaviour for an unverifiable release, not a bug — but it means
   update delivery is not functional until a key exists.
8. **No real GitHub release has been exercised end to end.** The verification
   paths are tested against a fake network with real cryptography.
9. **`electron-updater` itself is faked in tests.** The service is injected;
   only a packaged build exercises the real library.

### Packaging

10. **No Windows installer has been built in this environment.** This is a Linux
    sandbox; electron-builder's NSIS target needs Windows. The configuration,
    the scripts and the assertions are written and tested up to the point where
    Windows is required.
11. **`resources/bin` contains Linux symlinks with no pinned hashes.**
    `verify-binaries.mjs` refuses to package them. Real Windows binaries and
    reviewed digests are required before a shippable artefact exists.
12. **The build is unsigned** until `CSC_LINK` and `CSC_KEY_PASSWORD` exist.
    Everything that mentions the installer says so.
