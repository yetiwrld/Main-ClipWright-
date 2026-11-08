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
4. **Implemented so far:** select/marquee selection, razor tool, move, trim (incl. ripple Shift-drag and Q/W trim-to-playhead with Shift ripple), split, delete, ripple delete, duplicate, copy/cut/paste, group/ungroup, Alt+Up/Down track moves, markers, snapping, zoom, scroll, timecode entry, mute toggles, undo/redo. Transitions render, export, and can be created from the inspector: pick the incoming clip, choose a type, then adjust its length and where it sits relative to the cut. What is missing is a **timeline handle** — the transition has no draggable widget on the cut itself, so its length is set with a slider rather than by dragging its edge, and there is no way to see its span on the track. **Not implemented yet:** linked audio detach/unlink, transition handles, markers in the ruler, context menus, in-editor import.
5. **The media library lists imported media but does not import from inside the editor** (drag-in from Explorer, replace, relink, "in use" counts). Importing still happens on the start screen.
6. **The inspector edits by number, not on the canvas.** Opacity, volume, pan,
   speed, crop edges, scale and rotation are all editable and undoable, and the
   volume slider is no longer a read-only placeholder. What is missing is the canvas
   interaction from SPEC 08 §7.2 and SPEC 10 §8 — dragging to crop, dragging the
   framing, the anchor grid — plus the keyframe editor.
7. **The left panel has the Media and Captions tabs.** Text/Graphics,
   Effects/Transitions, Audio and AI tabs are still to come; nothing pretends to be
   there.
8. **Panel sizes are not persisted per user/tier yet** (SPEC 08 §3.3); they reset to the defaults on reload, while timeline zoom, scroll and the playhead are persisted in the project payload.

---

## 4. Phase 6–7 notes (export, updates, packaging)

### Export

1. **Captions are burnt in; the rest of the compositor is not yet.** Captioned
   exports are rendered by ffmpeg from a generated ASS script, so font, weight,
   size, fill, outline, shadow, position and karaoke timing all come from the
   `.cwstyle` and match the preview (SPEC 11 §3). Each video/image item is decoded
   by its own ffmpeg process, and the item's *static* crop, scale, rotation, flip
   and offset are applied to the decoded frame, so a clip framed in the editor
   exports framed. Layering is composited too: every visible picture layer is
   decoded, blended bottom-first at its own opacity and blend mode, and the result
   is written — so an overlay track, a faded clip and a `multiply` layer all reach
   the file. Transitions render too: the two clips either side of a cut are both
   drawn across the overlap and faded, slid, zoomed or **wiped** per the transition's
   type and easing. A wipe is a genuine per-pixel reveal in the file — the incoming
   clip is masked by the edge while the outgoing clip stays whole underneath — and a
   `clip-path` in the preview. Effects render, but **not the way §12 §3.1 specifies**: the spec asks for
   GLSL fragment shaders in a hidden WebGL2 window run by both preview and export,
   and this build has no GL context anywhere. Effects are a CPU implementation
   (`packages/compositor/src/effects.ts`) that the export applies to every frame and
   the preview approximates with CSS filters. Four divergences follow, all visible in
   item 7. The remaining compositor gap is the `rotationJitterDeg` per-caption tilt
   (ASS has no per-event rotation, item 4). There is no mask feature in the spec —
   "mask" appears only as the shape of two caption animations (§11) — so none is
   withheld here. Where nothing is on the timeline you get the canvas colour. The
   export dialog says so before you press Export.
2. **Keyframed geometry exports as steps, not ramps.** ffmpeg 4.1 evaluates
   `scale`/`crop` expressions once, at configuration time — there is no `t` in
   those expressions (measured: `scale=w='iw*(1+t)'` fails with "Undefined
   constant"). So an animated item is decoded as one segment per keyframe, each
   baked at its start value and concatenated. A move from scale 1 to 2 over a
   second produces two constant halves, not a smooth ramp; the preview interpolates
   properly. The export log says which items were segmented and how many segments
   each used, so this is visible rather than silent. Removing the limitation means
   the WebGL2 `renderFrame` path in `specs/10` §2.1, which renders per frame.
3. **Karaoke needs the transcript, and a transcript edited after the export
   started is not re-read.** The burn-in resolves each word ref against the
   project's transcript when the export starts. That is correct for normal use and
   wrong for one case: edit a word in the caption editor while an export is already
   rendering and the file will carry the text the transcript had when the render
   began. The preview updates immediately; the in-flight export does not.
4. **ASS is a smaller language than the style format.** A blurred drop shadow is
   approximated by its vertical offset, and letter-spacing is in pixels rather than
   ems, so a style with a heavy blur will look slightly cleaner on export than in
   the preview. Everything the ten presets ask for is expressible. The per-caption
   `rotationJitterDeg` tilt is not applied — ASS has no per-event rotation, so the
   tilt exists in the preview and the editable style but not in the burned-in file.
5. **Project-local style copies live in the project's settings blob.** The style
   editor saves a copy into `settings.captionStyles`, and the overlay, the caption
   list and the burn-in all resolve through it, so an edited style now survives to
   export. It is not a first-class table: styles are not listed separately, cannot
   be renamed or deleted from a dedicated manage screen (a copy can only be
   replaced by editing it again), and a project opened in a build that predates the
   style editor shows the presets — the copies are simply invisible to it, not lost.
6. **Blend parity is approximate at the edges.** The preview blends with CSS
   `mix-blend-mode` and the export blends in software, in 8-bit non-linear sRGB,
   with both sides following the W3C formula — but they are two implementations of
   one spec, not one implementation used twice. Chroma is upsampled
   nearest-neighbour when the export reads a frame and box-filtered when it writes
   one, so a colour sitting exactly on a 4:2:0 chroma boundary can differ by a few
   levels between the preview and the file. The difference is invisible on real
   footage and measurable on synthetic test cards, which is how it was caught. The
   exact `renderFrame` path in `specs/10` §2.1 — one compositor feeding both — is
   what would remove it.
7. **Effects are CPU code and a CSS approximation, not the shared shader the spec
   asks for.** §12 §3.1 wants each effect to be a GLSL fragment shader run in a
   hidden WebGL2 window by both preview and export, which is what guarantees the two
   cannot disagree. This build has no WebGL2 renderer, so:
   - the **export** applies a CPU implementation in linear light and is the
     authoritative picture;
   - the **preview** approximates it with CSS `filter`, which works on encoded sRGB
     rather than linear light and has no equivalent for Tint, Sharpen or Vignette at
     all. Those three are named in a visible banner (§10 §14) rather than silently
     omitted;
   - **chain order between a colour effect and a spatial one is not exact**: the
     CPU path runs every per-pixel effect first, then the spatial ones, so
     `blur → contrast` and `contrast → blur` currently produce the same frame. A
     shader pipeline interleaves them so they differ;
   - a **blur's sigma is this module's own**, not ffmpeg's `gblur=sigma`, so the two
     agree in shape and not in parameter naming. The kernel itself is checked tap by
     tap against the textbook Gaussian;
   - a **wipe's soft edge is exact in the export and hard in the preview**: the
     export ramps alpha across the edge as §4.2 specifies, while CSS has no
     gradient clip, so the preview shows the hard-edged version. Setting softness to
     0 — the default — makes the two identical.
   The export is correct and tested; the preview is honest and approximate, and the
   banner is what makes that acceptable.
   - **Adjustment layers grade what is below them, with one approximation.** An
     adjustment layer is implemented as an item of type `adjustment` on an `effect`
     track whose chain is applied to the composite of every lower track that is
     live at that instant (SPEC 12 §3.1, §12 item 5). The export applies the chain
     to the accumulated frame at the moment the walk crosses the layer's track, so
     the grade lands on the blend of everything below rather than on each layer
     separately — those give different pictures, and a test distinguishes them.
     The approximation is the same one as above: the *preview* folds the chain into
     each layer's CSS filter, so a layer stack under an adjustment layer previews
     as per-layer CSS filtering rather than as a filtered composite. With one
     picture layer — the normal case — the two agree.
   - **An adjustment layer is created from the timeline's empty-area context menu**
     ("Add adjustment layer"). It is not yet draggable on the canvas, cannot be
     resized by dragging its edges any differently from a clip, and adding one does
     not open the effects panel — the user selects it and adds effects from the
     inspector like any other item.
8. **No frame blending.** Frame-rate conversion uses nearest-time selection.
9. **No resumable export.** A failed or interrupted export restarts from the
   beginning (SPEC 14 §9 is not implemented).
10. **Hardware encoding is validated, not assumed — and not proven here.** The
   app tests a candidate encoder with a real short encode before using it, and
   falls back to software when it fails. But no machine with NVENC, QSV or AMF
   was available while this was written, so the *validation logic* is tested and
   the actual GPU output is not.
11. **Audio effects are not applied.** Gain, fades, panning, ducking and loudness
   normalisation are; the equaliser, reverb and other audio-rack effects are not
   yet in the mix.
12. **4K 60 fps on CPU is slower than real time.** It completes and validates;
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
