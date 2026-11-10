# Clipwright Studio — Known Limitations & Scope Notes

This document tracks architectural scope boundaries and honest limitations per `specs/00` §2.1, `specs/03` §9, `specs/10` §10, `specs/11` §11, `specs/12` §3–6, `specs/13` §2, `specs/14` §9, `specs/15` §6, and `specs/06`/`specs/07` (Phase 3).

---

## 1. Documented v1 Scope Boundaries

1. **No schema downgrade migration (`specs/03` §9):** Projects saved by a newer major schema version (`schemaVersion > CURRENT_SCHEMA_VERSION`) open in **read-only mode** with a clear banner advising the user to update Clipwright Studio. Unknown JSON fields within the same schema version are preserved via `.passthrough()`.
2. **Mixed-language transcripts (`specs/05` §6):** v1 uses one primary language per transcript (auto-detected or user-selected).
3. **Reverse playback & clip reversal (`specs/10` §10, `specs/12` §5):** `J` in the transport steps backward by 1 second (or frames on intra-frame proxies) rather than continuous reverse audio playback; clip timeline reversal is out of scope for v1.
4. **Text and shape items: built, with v1 limits (`specs/11` §7, §12).** A text item is
   a caption without words — same style resolution, same `layoutText`, so it wraps and
   breaks exactly as a caption in the same style does, and the burn-in draws it from
   the same ASS path. What a text item does **not** have: per-range rich text (bold or
   italic across part of a string), auto-size-versus-fixed-box, the ten template
   presets (lower third, callout, bullet list), and per-item animation beyond the
   style's own in/out. Shapes are SVG paths for all nine kinds (rectangle, rounded
   rectangle, ellipse, triangle, polygon, star, line, arrow, speech bubble) and are
   drawn in both the preview and the export — one geometry in `compositor`, an SVG
   serialiser for the canvas and an ASS drawing (`\p1`) serialiser for the burn-in —
   from the style's fill colour. A shape has no colour of its own and no shape-specific
   inspector controls yet; its size and position come from the item transform, so it is
   moved and scaled with the ordinary canvas gestures. **Icons and stickers are not
   built**, and the shape kinds are the nine the schema declares. Text on a path, 3D extrusion, gradient fills and
   `rotationJitterDeg` on a title remain out of scope for v1.
5. **Animated GIF imports (`specs/04` §2, `specs/11` §12):** Imported `.gif` files render their first frame statically; use `.mp4` or `.webm` for animated overlays.
6. **Audio-only composition export (`specs/12` §6.9):** v1 exports video containers (`.mp4`, `.webm`); an audio-only timeline exports as a video with the composition's canvas background colour.
7. **Guides, safe areas and the pixel grid.** `Ctrl+;` cycles title safe (90%),
   action safe (93%) and the 9:16 / 4:5 platform UI zones, and `Ctrl+'` toggles the
   composition grid, the thirds by default or any N×M from 2 to 12 chosen in the Guides
   menu; the safe-area values come from `assets/safe-areas.json`, so they can be tuned
   without a code change. The **pixel grid** arrives with the view zoom: `Ctrl`+wheel
   zooms about the cursor up to 1600%, `F` returns to Fit, and from 800% one line per
   canvas pixel is drawn. The safe areas are not yet *crossing* guides: object snapping
   (above) pulls a clip onto the canvas and onto other items, but not onto the title-
   and action-safe edges.

8. **4K 60 fps CPU export speed (`specs/14` §10):** On machines without a hardware encoder (NVENC/QSV/AMF), 4K 60 fps software encoding (`libx264`) runs slower than real-time while maintaining full frame accuracy and deterministic output.
9. **Unsigned Windows installer (`specs/15` §6.4):** When built without a commercial Authenticode certificate (`CSC_LINK`), the Windows installer and portable executable are **unsigned**. Release notes, the README, the installer, and the in-app updater clearly label builds as **Unsigned** and verify authenticity via Ed25519-signed `release-manifest.json.sig` plus SHA-256/SHA-512 checksums.
10. **Architecture support (`specs/15` §6.1):** Windows x64 is the primary target for v1; Windows ARM64 runs via x64 emulation.
11. **Voiceover recording and the audio rack are deferred to a later version (`specs/12` §6.5, §6.8).** Neither is built and neither is reachable: there is no *Record* button, no mic permission prompt, and no equaliser, reverb or de-ess in the mix. This is a scope decision rather than an unfinished slice — the rest of §6 (the gain envelope, pan, fades, the preview graph, master and per-track meters, momentary loudness and noise reduction) is built — and it is listed here so no screen implies otherwise.
12. **Noise reduction uses spectral denoising, not RNNoise, in this build (`specs/12` §6.8).** The
    bundled ffmpeg is 4.1 (2018) and predates the `arnndn` filter, so the spec's "otherwise
    `afftdn`" branch is what runs. The capability is probed from `-filters` at start-up rather than
    assumed from a version string, so a newer binary that has `arnndn` uses it without a code
    change — but the RNNoise path additionally requires a model file to be supplied, because the
    model's own licence has to be checked before one can ship. Until then every job runs `afftdn`
    and the panel says so. This is a build fact rather than a scope decision, and it is listed here
    so a user comparing voice quality against another tool knows why it differs.
13. **Roadmap ("LATER") features not in v1 (`specs/13` §2):** Offline speaker diarization, multi-language caption translation tracks, AI voice dubbing, key-less background removal, B-roll suggestion, and multi-speaker split-screen auto-layout are reserved for future versions and are absent from the UI.

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

1. **The audio device is the master clock** (SPEC 09 §23), and the animation-frame timer is the
   fallback when no audio is playing. The playhead is derived from `AudioContext.currentTime`
   through an anchor taken on the first frame of playback, so a slow frame renders an older
   picture instead of letting the sound run ahead — the spec's "drop frames, never slow audio".
   Two honest limits remain in that area:
   * **The clock follows the device, but the device is not asked to correct a slider.** A seek
     during playback re-anchors; residual drift inside the 80 ms tolerance is left alone rather
     than being corrected every frame, because a correction per frame *is* jitter.
   * **A reading before the anchor holds rather than rewinds.** If a context is recreated and
     reports a smaller `currentTime`, the playhead stays where it was until the device catches up.
     A reading that is merely *slow* — forward of the anchor but behind the playhead — is not
     distinguishable from a fresh anchor and is followed, which is the correct trade: the device
     is the clock, so when it says less time has passed, less time has passed.
   **Playback rate** (§23: 0.5×/1×/1.5×/2×, preview-only) is in the transport, applied to the
   elements with pitch preserved; the control is absent when no graph exists, because a rate that
   moved the playhead while the sound stayed at 1× would be worse than no control.
   The Web Audio graph itself is **built** (SPEC 12 §6.2/§6.3): every audible item gets a
   `<audio>` element of its own, a `GainNode` carrying the full envelope and a `StereoPannerNode`,
   summed into a bus. That changed three things this document used to list as limitations:
   * **Audio items are audible.** A music bed, a voiceover take or anything from *Extract audio*
     now plays on its own track; previously only the bottom picture layer made sound, because
     that was the one `<video>` element the preview drove.
   * **Pan is previewed.** `pan` reaches a `StereoPannerNode`, so the preview is left/right the
     way the export's constant-power pan is.
   * **The master meter reads the mix.** Both the stereo peak meter and the momentary LUFS
     readout tap the graph's **bus** — the node every item is summed into — so they measure what
     a listener hears rather than the bottom layer. The `<video>`-element tap is still the
     fallback when no graph can be built (no Web Audio in the environment), and it still means
     the bottom layer; the hook says so where it falls back.
   **Per-track meters are in.** Each track that has something audible on it gets a summing node in
   the graph, and its header draws two 3 px bars on the same −60…0 dB scale and the same three
   colours as the master meter, read from an `AnalyserNode` at 30 Hz — the same arithmetic module,
   so the two cannot disagree about what "hot" looks like. Two things the header meter deliberately
   does *not* have: the **peak hold** (at that height a hold marker would cover the bar it marks)
   and the **clip light** (a header has 184 px shared with a name, a lock, a magnet, a mute and a
   solo button). Clipping is still reported — by the master meter, which is where there is room
   for a light that latches until clicked.
   Two honest gaps in the graph itself: it builds one chain per *item*, not per track, so an
   edit that re-plans the whole graph on every timeline change is cheap at this scale and would
   not be at a thousand clips; and the graph is rebuilt from a plan on each edit rather than
   patched, which is the same trade at a different level.
2. **The preview plays proxies, but seeking a `<video>` element is still the scrub
   mechanism.** Import generates a proxy for 4K, Chromium-unsafe-codec, variable
   frame-rate and HDR sources (SPEC 04 §7), the media record stores its path, and the
   preview protocol now serves it when present — falling back to the original when the
   derived cache has been cleared, and never reaching an export, which reads the
   original path from storage directly. Proxies can be switched off in Settings for a
   transcode that got a clip wrong.

   Seeks are coalesced rather than issued per playhead move: at most one seek is in
   flight per layer, the newest target replaces the one waiting, and the element's own
   `seeked` event releases it. A hundred-event scrub that used to assign `currentTime`
   a hundred times — aborting each decode before it finished — now costs a handful,
   ending on the frame under the playhead.

   What remains is the transport itself. The preview still *seeks* to show a frame
   rather than compositing decoded frames, so scrub responsiveness is bounded by how
   fast the element can seek, not by how fast frames can be decoded — except where a
   cached frame stands in, which the next paragraphs cover.

   Part of that cache now exists, for the timeline rather than the preview. Frames are
   extracted on demand to `derived/scrub/<mediaId>/`, content-addressed on a 1/10 s
   grid, scaled to 480 px and pruned to the 240 nearest the playhead — so the filmstrip's
   tiles each show their own moment instead of one poster repeated (**it drew the same
   frame on every tile before this**, which made it decorative), and a scrub that passes
   back over the same frames costs reads rather than ffmpeg runs.

   The preview now reads them too. While a layer's `<video>` reports a seek in flight,
   the cached frame for the playhead's grid cell is drawn over it, and it is removed the
   moment the element's `seeked` event arrives — so the picture the user sees during a
   drag is a file read rather than a keyframe hunt, and the swap back to the element is
   invisible apart from the sharpness (the still is 480 px, the element is the source's
   own resolution, which is exactly why it must not linger once the seek settles).

   Two properties are deliberate. The still is *mounted but hidden* until its own
   picture has decoded, and both halves of that matter: an `<img>` has to be in the tree
   to load at all, so gating the mount on the load means it never loads, and one that is
   already loaded keeps painting its previous frame after `src` changes, so without the
   hiding a seek into the next cell would leave the old cell's picture over the video.
   Each element is keyed to its URL, so a load can only ever be credited to the frame it
   belongs to. And nothing is drawn while playing, because a still cannot show motion.

   What this does **not** change is the transport. The preview still *seeks* rather than
   compositing decoded frames, so the stand-in only helps where a frame has already been
   extracted: the cache is filled by the timeline's filmstrip and by whatever scrubs the
   timeline has needed, and the preview **reads it without ever asking for an extract**.
   That restraint is the design, not an omission — `media:getThumbnail` extracts on
   demand, so calling it per pointer move would start an ffmpeg run every cell the
   pointer crossed and make a scrub slower than the seeks it was meant to replace. A
   protocol URL that answers 404 for an uncached cell gives the cheap read-only path the
   preview needs. The honest summary is that a scrub over ground already covered is now a
   read, and a scrub into fresh ground still waits on the element — which is the
   remaining gap, and it is narrower than it was.

   Extraction on arrival is the next step and deliberately not in this slice: it needs
   the renderer to ask for a frame *after* the playhead has settled, which is an IPC
   round trip this change does not add.
3. **Not every SPEC 09/10 acceptance check is automated yet.** Covered by unit tests: time model and timecode, frame quantisation, all five commands plus `addItem`, invariant checks after every command, undo round-trips, snapping maths, and the project-duration selector. Not covered: gesture feel (marquee, razor, rolling edit, ripple-trim modifiers), the React re-render assertions from SPEC 09 §27, and every visual check in SPEC 09 §30 / SPEC 10 — those need a real window.
4. **Implemented so far:** select/marquee selection, razor tool, move, trim (incl. ripple Shift-drag and Q/W trim-to-playhead with Shift ripple), split, delete, ripple delete, duplicate, copy/cut/paste, group/ungroup, Alt+Up/Down track moves, markers, snapping, zoom, scroll, timecode entry, mute toggles, undo/redo. Transitions render, export, and can be created from the inspector: pick the incoming clip, choose a type, then adjust its length and where it sits relative to the cut. What is missing is a **timeline handle** — the transition has no draggable widget on the cut itself, so its length is set with a slider rather than by dragging its edge, and there is no way to see its span on the track. **Relocation is not yet wired to the relink dialog.** SPEC 04 §8's relink UI — pick a
replacement, *Locate folder*, fingerprint warning — is a separate surface, and the relocation
pass here is the automatic half: the cases it can resolve without asking. A volume that is not
mounted, or a file that was genuinely replaced, still reports `missing` and waits for the dialog.
Recording the identity at import is what makes the automatic half possible for future imports;
media imported before this exists has no `volumeId` and always needs the dialog.

**Auto-reframe has no detector.** SPEC 13 §6.3's face/saliency detection needs
`onnxruntime-node` and a permissively licensed model shipped in the installer, neither of which
this build carries. §6.4 permits exactly this fallback, so what exists is the camera path
(`packages/compositor/src/auto-reframe.ts`): given subject positions it produces the smoothed,
dead-zoned, pan-limited, reduced keyframes the spec describes, and §6.4's "static centre with the
user's framing" is the same code with one sample. What does **not** exist is the analysis pass
that produces those subject positions, and therefore the "Auto-reframe" button itself. The
geometry is tested; the detector is not built, and saying so is the spec's own instruction.

**Fill lock scope.** SPEC 10 §8.5's cover lock is implemented for the **preview's** move and
scale gestures, which is where the spec asks for it. The export does not re-apply it: it
draws whatever the document says, so a project made entirely by editing fractions by hand
could still be exported with an exposed edge. That is deliberate — the export should render
the document, not second-guess it — but it does mean the lock is an editing rule rather than
a guarantee about the file.

**Not implemented yet:** transition handles, markers in the ruler — the
rest of that list has since landed (linked audio detach/unlink and linked selection,
context menus, in-editor import, the fill lock).
5. **The media library lists imported media but does not import from inside the editor** (drag-in from Explorer, replace, relink, "in use" counts). Importing still happens on the start screen.
6. **The canvas supports moving, cropping, rotating, scaling and the anchor crosshair,
   with the `Shift`/`Alt` modifiers, plus object snapping and the *Show anchor* toggle;
   the edge handles' per-axis scale is the gesture still missing.** Dragging a selected
   clip's picture moves it
   (`Shift` locks to the dominant axis), dragging one of its edges crops it, dragging a
   corner scales it uniformly about the opposite corner (`Shift` toggles to free scale,
   `Alt` scales about the centre), the handle above it rotates about the anchor
   (`Shift` snaps to 15°), and dragging the crosshair moves the pivot without moving the
   picture. Each gesture is one undo step on release, the preview follows the pointer
   before anything is written, and `Esc` abandons a drag without touching the undo
   stack. Aiming the crosshair and placing a scaled corner both carry the pointer
   through the picture's own rotation, because a 90° turn swaps the bounding box's axes
   and box arithmetic silently puts things in the wrong place.

   Snapping (SPEC 10 §8.8) pulls a dragged clip onto the canvas centre lines, the canvas
   edges and every other visible item's edges and centres, at 8 screen pixels, with `Alt`
   to bypass. It is measured on screen so it feels the same at any preview size, and it is
   applied to a *move* only — a scale or a rotate has its own arithmetic that a snap would
   fight.

   A snapped drag draws a `--brand` hairline on each axis it caught, and the line goes
   when the drag ends or is abandoned, so a line never outlives the gesture that explains
   it, labelled with how far the snap pulled the clip in preview pixels. When the gaps
   either side of a dragged clip come within the threshold of equal, the two gaps are
   equalised and drawn as two equal bars — horizontal only, since nothing has confirmed
   the vertical form reads well stacked. User guides are in: `Ctrl`-drag in from a viewport
   edge places one where you release, it is saved with the project, and it is a snap
   target; `Shift`+`Ctrl`-drag takes one away. The **Guides menu** (§8.8) is in the
   transport strip and carries *Add horizontal*, *Add vertical*, *Lock* and *Clear*. A new
   guide lands in the middle of the composition, because the edges are already occupied by
   the handles, and every item is a command, so `Ctrl+Z` puts back one *Clear* removed.
   *Lock* protects guides from both gestures: a locked guide cannot be removed and cannot
   be overwritten by a duplicate landing on top of it, and *Clear* spares it and says so
   (*Clear unlocked guides*). A locked guide is not marked on the canvas — a hairline has
   no room for a badge, so the state is read off the button's icon. Still missing
   is any way to see **the list of guides** rather than the lines themselves, and
   **per-guide locking**: *Lock* acts on every guide at once, which is what the menu item
   is. The **custom N×M grid** is in, reached from the same menu: the grid *is* the thirds
   overlay with other divisors, so one key, one drawing path and one set of snap targets
   serve both. Snapping does follow the safe-area edges, but
   **only while that overlay is showing**: a line a user cannot see must not pull their
   clip, so `Ctrl+;` switches the snap targets on along with the rectangle. The grid
   works the same way under `Ctrl+'`, at whatever N×M is set. The **pixel grid** now
   exists (above) and is deliberately not a snap target: at 800% a target every eight
   screen pixels would catch every drag and nothing else would ever snap, so the pixels
   are a ruler for the eye rather than something to align to. The **cap of four lines**
   is met by construction rather than by a limit: one target is chosen per axis, so a
   dragged clip can draw two at most. The pivot crosshair sits behind §8.2's *Show
   anchor* toggle (`A`), and the **zoom dropdown is in** — Fit, Fill, 25–400%, plus
   `Ctrl`+wheel about the cursor up to 1600% — with §4's remaining view controls: the
   **Handles** toggle (`H`) hides the transform grips without deselecting, and the
   **Pan view** tool and **Space+drag** pan the view (Space still plays, because the
   pan listener never claims the key — see `docs/decisions.md` §10). Of §5.1's
   **preview quality**, what is in is the part the spec insists on most — *never
   silent*: the preview reports what it is playing. A clip whose proxy is still being
   made — a live `proxy` job for that media, which is what the pipeline actually
   publishes — carries the "Preparing smoother preview…" chip, and the job list is
   watched only while some import is still waiting on one, so the report costs no
   timer once a project has settled; a project with **proxy
   preview** switched off says so, because a slow scrub over a 4K original then looks
   like a bug rather than a setting; and a proxied clip or one that needs no proxy says
   nothing, because a chip that is always on is a chip nobody reads. Proxy selection
   itself is main's (`preview-source.ts`), so an export can never be built from a
   transcode. What is **not** in is the **Auto** render scale: no Auto/Full/Half/Quarter
   chooser and no "Preview ½" chip. The preview draws the DOM layer stack at each
   element's own resolution, so it has no internal render scale to step down — those
   levels, and the 30-frame moving average that picks between them, describe the WebGL
   renderer, and a control that scaled a resolution nothing is rendered at would be a
   switch that does nothing. The paused-frame-at-Full rule is vacuous for the same
   reason: there is no reduced scale to restore from. The four **edge handles** now
   scale the one axis each governs, as §8.2 asks, with `Shift` giving them the uniform
   corner behaviour; cropping moved onto the **Crop tool** (`C`), which is where §8.6 puts
   it, and the tool now owns a *frame*: a rectangle over the **uncropped** source with eight
   handles, the four dimmed regions outside it, the aspect-lock select (Free/Original/1:1/
   9:16/16:9/4:5/Canvas), a rounded-corners slider, and `Enter`/`Esc` as apply-and-cancel.
   The session is a draft in view state, not a document edit, so several drags cost one undo
   step and `Esc` costs none. **"Set framing…"** is there too: a fixed canvas window with the
   picture dragged under it and a wheel to zoom, written as four keyframes in one undo step —
   the manual precursor of auto-reframe, `13`. What it is not is *automatic*: nothing detects a
   face or a subject, so the framing is wherever the user put it, and the smoothing, headroom and
   subject-picker controls §13 describes do not exist. The radius is capped at 50% of the
   window's short side — a larger value is an ellipse rather than a rounder corner, and the
   export's mask draws it that way too. Cropping works through the frame only: the clip's own
   edge handles always scale (§8.2), whatever tool is active, because two live crop paths
   disagreed about *when* they wrote.
7. **The curve editor draws and shapes curves, but does not zoom or transform
   them.** SPEC 12 §2.6 asks for a lot: wheel zoom, middle-drag pan, fit selection,
   snapping, and numeric copy/paste/mirror/reverse/scale-time/scale-value tools for
   the selected keys. What is built is the part that made `bezier` reachable at all
   — a graphed curve per numeric property, draggable control handles written as one
   undo step on release, and per-property colours. The graph draws a fixed window
   over the item's duration rather than a pan-and-zoom viewport, so everything that
   depends on a viewport (zoom, pan, fit) is absent rather than half-working, and
   the transform tools are not written. There is also no box-select of keys in the
   drawer: keys are selected by clicking a diamond, one at a time.
8. **§2.4's diamond, ◀ ▶ jumpers and auto-keyframing cover the eleven properties the
   inspector draws.** Every path the compositor and the audio envelope read has a row
   with a diamond, and a test walks the list so the two cannot drift apart. What is
   canvas drags follow the same rule the sliders do — they route through the same
   function, so dragging a clip whose position is already animated keys both axes at
   the playhead rather than editing the static value. The anchor's two paths joined
   the list once the compositor started resolving them.
9. **The left panel has the Media and Captions tabs.** Text/Graphics,
   Effects/Transitions, Audio and AI tabs are still to come; nothing pretends to be
   there. Text and shape items are created from the timeline's context menu instead,
   which is where an item with no file behind it belongs — there is nothing to drag in
   from a browser.
10. **Panel sizes are not persisted per user/tier yet** (SPEC 08 §3.3); they reset to the defaults on reload, while timeline zoom, scroll and the playhead are persisted in the project payload.

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
   The **anchor** is now one thing the two agree on rather than one they did not:
   `xPct`/`yPct` place the block's anchored edge, and a `caption-anchor` test walks
   all nine cells against the export's own `\an`/`\pos` output. Until it existed,
   the horizontal half of the anchor was dead code in the preview and the export was
   right, so a left-anchored style was burned in where the style asked and previewed
   in the middle of the frame.
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
     0 — the default — makes the two identical;
   - a **dissolve's noise field is exact in the export and patterned in the
     preview**: the export thresholds a real value-noise field per pixel, with a
     quantile mapping so the switched fraction equals the progress. CSS can express
     a repeating gradient mask but not a procedural field, so the preview shows
     patches on a regular grid whose coverage follows the progress. The file is
     authoritative; the preview conveys the character of the transition, not its
     exact pixel pattern.
   - **A slide's `mode` is only visible on clips that do not fill the frame.**
     §4.2's three modes differ in *who stays still*: `push` moves both pictures as
     one strip, `cover` slides the incoming clip over a stationary outgoing one, and
     `reveal` slides the outgoing clip away from a stationary incoming one. Their
     reported state differs in which side carries a zero offset, and the motion
     differs on screen — but with two opaque clips that both fill the frame the
     rendered picture is pixel-identical in all three, because the area one vacates
     is exactly the area the other enters and the incoming clip is painted on top.
     The modes are only distinguishable where the canvas shows through, on a scaled
     clip, and the tests measure the motion rather than a still for that reason.
   - **A slide has four axis directions, not the wipe's six.** §4.2 lists
     L/R/U/D/diagonals for a *wipe* and plain "direction" for a slide, so the two
     diagonals are not a slide requirement and the inspector does not offer them.
     Earlier notes here claimed they were a gap; they were not.
   - **A transition's audio crossfade needs handles on the incoming clip.** §4.2
     asks for an equal-power audio crossfade over the transition's own range. The
     incoming clip's half of a centred window begins *before* the clip does, so the
     mixer decodes earlier material and starts the clip early — which is only
     possible if the source has footage before the in-point. With no handles the
     crossfade degenerates to a fade-in from the clip's first sample, which is
     audible as a slight step at the cut on material that started at a source's
     very beginning. Padding with silence was rejected: it would put a silent hole
     in the middle of the mix.
   - **A cut is tapered by 2 ms, not sample-aligned.** §12 item 8 asks for
     click-free edits. Every hard edge — the head and tail of a clip that no
     transition already shapes — gets a 2 ms raised-cosine ramp, which is short
     enough to be inaudible on speech and long enough to cut a full-scale step to
     a small fraction of it. It is not a zero-crossing search: the taper multiplies
     rather than moves samples, so a cut on material that is not near zero still
     loses that 2 ms of level. Where a crossfade already shapes an edge the taper is
     skipped, since the crossfade's own envelope is longer and precisely placed.
   - **`zoom` resamples with nearest-neighbour.** The scale changes every frame, so
     a bilinear sample would be re-filtered on each one; nearest keeps it to a
     multiply per pixel, and the error it adds is far below the 4:2:0 rounding the
     frames have already been through. On a hard edge — a test card, not real
     footage — a zoom can shimmer slightly where bilinear would not.
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
11. **Audio effects are mostly applied.** Gain, fades, panning, ducking, loudness
   normalisation, transition crossfades, per-track mute and solo, and the 2 ms de-click
   taper all reach the mix. Only the **audio rack** — equaliser, reverb, de-ess — is
   absent, which is the deferral recorded in item 11 of §1 above.
   Ducking and normalisation were listed here for several slices while *neither could
   run for a real project*: normalisation had a checkbox and a mixer branch, ducking
   had an arithmetic and a mixer branch but no field on the item and no line forwarding
   the flag, so three layers agreed about a value no project could hold. A music bed is
   what exposed it — see `docs/decisions.md` §50. This line is now a statement about the
   mix rather than about the code.
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
13. **Brand kits are built end to end except the file pickers and a few form controls.** SPEC 13 §8
    lists them as CORE for v1 acceptance, and the honest state is this: the `.cwbrand` format,
    import/export with unknown-field preservation, placement resolution across aspect ratios,
    safe-area-aware corners, the application plan and its report, the commands that apply,
    reapply, remove, detach and insert an intro or outro, the `.cwbrand` **archive** (a real zip,
    verified against `unzip`), and capture **from the current clip** are all built and tested
    (`packages/brand-kits`, 109 tests; the commands in `packages/timeline-engine`, 26). A
    **Kits tab** in the editor's library lists a project's kits, shows how many items each has
    placed, and offers apply (with the spec's six part checkboxes and a before-apply summary
    that reports a missing logo), reapply, detach, remove and delete — each as one undo step,
    and deleting a kit leaves its items standing.
    The **editor** is built too: a kit can be created from scratch or from the current clip,
    edited, and saved, with every problem reported at once and a part switched on but not yet
    chosen treated as a problem rather than a silent omission.
    A kit **travels as a file**: export writes a `.cwbrand` archive from the panel (the save
    dialog and the asset reads both happen in the main process, and the file name gains the
    extension even if the user types a bare name), and import reads one back, telling the user
    by name about any asset the file did not contain and re-identifying a kit whose id is
    already in the project rather than overwriting it.
    What is *not* built: building a composition from a `compositionTemplateId` — so a
    template-based intro is planned and then refused rather than inserted empty — plus the
    rest of the kit's form. Text and shape items cannot be captured, because the kit's schema
    has no field for them, and a `custom` logo placement becomes the nearest corner when edited,
    because the form has four corners and no way to express a dragged point. The colour picker
    is the shared `ColourPicker`, which now carries the **eyedropper** (SPEC 01, SPEC 11 §8.2)
    and **recent colours**; *pick from logo* (SPEC 13 §8.2's k-means sampling) is not built, and
    the eyedropper is absent rather than disabled where the Chromium API does not exist. **All clips** is real: every composition in the project is read, planned and
    written, all-or-nothing, with a progress line and an **Undo batch** for the clips that are
    not the one open; **Selected clips** is *absent* rather than disabled, because choosing
    clips needs a bin this build does not have. A kit's **fonts** are resolved against what the
    machine has — a missing family substitutes by *character*, so a serif falls back to a serif,
    and the sentence naming both goes into the plan's report (SPEC 11 §10.2) — but the kit
    editor has no font controls yet, so a kit's fonts arrive only from a capture or a
    `.cwbrand` file.
14. **Shapes and icons are editable in the inspector, and the picker re-opens on an
    existing item.** The row that was missing (SPEC 11 §12) is there: a shape lists its kind,
    an icon offers its 0.5–4 stroke width and a *Change…* button that reopens the picker on
    that item. Nothing in this feature still requires deleting an item to change how it
    looks. The picker's search does not match tag words yet — it matches names and the words
    in them — which is a want, not a gap, and is recorded here rather than fixed by accident.

---

## 5. Auto-ducking keys off item placement, not detected speech

The track-level ducking feature (SPEC 12 §6.7) holds a track down wherever another track has an
item, not wherever another track has *speech*. A music bed under a ten-second clip that is silent
for eight of those seconds is ducked for all ten. The spec allows either implementation; this one
was chosen because the preview has no decode and usually no transcript, and because deriving the
envelope from placement is what lets preview and export share a single function — an analysis-based
version would be more accurate about speech while disagreeing with the file.

The threshold setting (`thresholdDb`, default −42) is stored and round-tripped but does not yet
gate anything: placement is treated as unconditional speech. When a detector exists, it belongs at
the point where spans are computed, and both renderers inherit it.

---

## 6. The start screen is a form, not the full setting set

The start screen now writes every setting it shows, by the schema's names (§02 §4.3–4.7). What it
still does not do:

- **A custom aspect stores its pair but changes no canvas.** `aspect: 'custom'` resolves to 9:16
  when a composition is built, because `CANVAS_BY_ASPECT` has no entry for a pair and nothing reads
  `customAspect` to construct one. The user's 4:5 pair is saved and survives reload; the clips are
  built at 9:16. The tile is honest about the ratios it offers, and the two Custom tiles are the
  least-used controls on the screen — but this is a stored value with no reader, the same shape as
  the bugs above, and it is recorded here rather than described as working.
- **The Recommended badge (§02 §4.3) is not built.** The screen has no crop preview and no
  suggestion from the source's shape or content type; the user picks a ratio and it is used.
- **Caption style tiles are text buttons, not live animated previews** (§02 §4.4). They name the
  style; they do not show it.
- **A project's `sourcePath` is remembered from the start screen only.** Choosing a different source
  for an existing project means starting a new one — the import stage reads that one field.

---

## 7. The project menu has five of the six actions

SPEC 03 §10 lists Open, Rename, Duplicate, Archive, Show in folder and Delete. The menu carries all
but **Show in folder**, which needs an IPC channel that does not exist — `shell.showItemInFolder`
is wired for export output only (`export:openFolder`). The store's project directory is derivable,
so this is one command and one bridge entry rather than a design question; it is recorded here
because a menu that silently omits a listed item is the same class of gap as a setting nothing
reads.

Two related things the menu does not do, both noted rather than implied:

- **"Also copy media"** in Duplicate (§10) is not offered. The store shares managed media by
  reference on duplicate, which is the default the spec describes; the option for a fully
  independent copy is not built.
- **"Free proxies and cache for this project"** on Archive is not offered either. Archiving writes
  the flag; the disk-reclaiming half of §8 is not implemented.
