# Where the project is

Written in plain language, for anyone picking this up. It is a summary, not a
replacement for `docs/verification.md` (what has been proven) and
`docs/limitations.md` (what is knowingly missing).

Last updated after commit `26bcbe2`. 2642 automated tests, all passing.

---

## The plan, in six stages

The build follows `specs/00_MASTER_PROMPT.md` §6, which splits the work into six
phases. Each phase ends with a checkpoint: the features work, the tests pass, and
the work is committed and tagged.

| Phase | What it covers | Status |
|---|---|---|
| **1 — Foundation** | Electron shell, design system, database, storage, settings, logging, secure key storage, CI skeleton | ✅ Done, tagged `phase-1-complete` |
| **2 — Start flow & transcription** | Start screen, file import, URL download (yt-dlp), ffprobe inspection, proxies, Whisper transcription, transcript editor | ✅ Done, tagged `phase-2-complete` |
| **3 — AI & moments** | AI provider settings, Ollama, moment detection and scoring, moments screen, clip creation | ✅ Done, tagged `phase-3-complete` |
| **4 — Editor core** | Editor layout, media library, timeline, playhead, preview, undo/redo, autosave, recovery | ⚠️ Mostly done, not tagged |
| **5 — Editor advanced** | Captions UI, text/graphics, keyframes, effects, transitions, audio tools, AI editing tools, brand kits | ⚠️ Mostly done: captions, keyframes, effects, transitions and audio envelope built; text/shape items, brand kits, equaliser, metering and voiceover not built |
| **6 — Export, updates, packaging** | Export engine, queue, updates, installer, GitHub release, docs | ⚠️ Built, one big gap (see below) |

So: **three phases fully done (1, 2, 3) and three partial (4, 5, 6)** — every phase
except the last is substantially built, and none of 4, 5 or 6 is "not started".

---

## What actually works today

The app is real and runs. A user can:

- import a video file or download one from a URL
- get a real transcript with word-level timings, offline
- have an AI (local via Ollama, or an online provider) find and rank the good moments
- open a project in an editor with a working timeline: select, move, trim, razor,
  split, ripple-delete, duplicate, copy/paste, undo/redo, snapping, markers, zoom
- export a video file with ffmpeg, validated afterwards

That is Phase 1, 2 and 3 complete plus most of Phase 4.

---

## What is missing

**Phase 5 is built, minus the style editor's remaining polish.** The last sessions
finished the caption engine, the frame builder, the preview overlay, the caption
list, the per-word editor and a style editor, and put styled captions into the
export path:

- `packages/caption-styles` — the `.cwstyle` v1 schema, ten presets, resolution.
- `packages/audio-core` — the gain envelope the preview and the export both use.
- `packages/compositor` — `layoutText` (where words go) and `captionFrameAt` (what
  they look like at an instant): karaoke sweeps, word-by-word, keyword emphasis,
  palette cycling, in/out and per-word animation.
- The editor — a Captions tab listing every caption in order with an `edited` chip,
  click-to-emphasise per word, and a canvas overlay in the preview painted by the
  same code the export uses.
- The style editor — a dialog over font, case, alignment, line height, fill,
  outline, shadow, highlight and position, where editing a preset saves a
  project-local copy instead of overwriting it. The copies live in the project's
  settings and reach the overlay, the caption list and the burn-in.
- The export — ffmpeg burns the captions in from a generated ASS script, so the
  file matches the preview.

Still open in Phase 5: the style editor's colour pickers and anchor grid (colours
are entered as hex today, and position is a slider rather than drag-on-canvas),
text and shape items (the schema allows the item types; nothing draws them), brand
kits (the schema has the field; no UI writes it), and the audio tools beyond the
envelope (equaliser, metering UI, voiceover recorder). The inspector's keyframes,
effects and transitions are **done** — the §2.4 diamond and auto-keyframing on
every animatable row, the §2.6 curve editor, the nine required effects with
reorder/copy/paste and adjustment layers, and the transition controls with every
type's direction and mode.

**Phase 4 is unfinished in specific ways**, all listed in `docs/limitations.md`:
the playback clock is not audio-mastered, and the preview still *seeks* rather than
compositing decoded frames. Its scrubs are coalesced, served from a proxy, and — new in
this slice — covered by a cached still while a seek is in flight, read from the same
`derived/scrub/<mediaId>/` cache the filmstrip fills. So a scrub over ground already
covered is a file read; a scrub into fresh ground still waits on the element, because
the preview reads the cache without ever asking for an extract. Canvas drag editing *is*
built — move, crop, scale, rotate and the anchor crosshair, modifiers included — dragging a selected clip moves it, dragging an edge crops it — and so are
the keyframe inspector and the curve editor. Numeric editing of opacity, level,
pan, speed, crop, scale, rotation and flip works, is undoable, and — since the
preview and the export both apply the same geometry — is visible where it matters:
on screen and in the file.

**Phase 6's export is incomplete in one important way.** Captions are rendered,
each clip's static crop, scale, rotation, flip and offset are applied to its
decoded frames, and layers are composited: every visible picture layer is decoded,
blended bottom-first at its own opacity and blend mode, and written out. The
preview and the export resolve the layer stack through the same function, so they
agree about which clip is on top, and transitions draw both clips across the
overlap in the preview and, in the file, crossfade, dip, push, zoom, wipe or
dissolve them — a wipe is a real per-pixel reveal, masked in the export and clipped in the
preview, and a dissolve switches whole pixels through a deterministic noise field
rather than fading them. A slide has all three of §4.2's modes — `push` travelling both pictures, `cover` sliding the incoming one over a still outgoing one, and `reveal` sliding the outgoing one away — chosen from a picker in the inspector; a reveal is drawn as the moving hole the outgoing clip leaves, which is the only way it can work with the incoming clip painted on top. A zoom scales and crossfades in both, resampled nearest-neighbour so the per-frame cost stays at one multiply per pixel. Linked audio crosses over with the picture through an equal-power envelope (`cos`/`sin` on a quarter turn), so the level stays flat instead of dipping in the middle the way a linear fade would; the transition's "Crossfade audio" flag chooses between that and a hard cut. Hard edges that no transition shapes carry a 2 ms raised-cosine taper, so a cut is not a step and does not click; mute silences a track in the file as well as the preview, and solo silences the others while their picture still renders. What is still
the nine required effects from §12 §3.2 are implemented in CPU code and applied to
every exported frame (the preview approximates them with CSS filters and says so
where it cannot). A clip's chain can be reordered, copied and pasted, and an
adjustment layer — an item with no picture whose chain grades the tracks below it —
is created from the timeline menu and graded onto the composite in the export. What remains is architectural rather than a missing feature: the
shared WebGL2 `renderFrame` that §10 §2.1 asks for, which would replace the current
CPU-plus-CSS pair with one implementation.
Keyframed geometry *is* rendered, but as steps: ffmpeg 4.1 evaluates `scale`
and `crop` once, so an animated item is split into one segment per keyframe and
each segment is baked at its start value.
This is stated in the export dialog before the user presses Export.

---

## Why Phase 6 took so long this session

Phase 6 includes packaging and releasing, and **none of that had ever run**.
The release workflow had never executed a single step, so it was unknown whether
it worked at all. It did not.

The biggest finding: the CI pipeline had been failing on every commit since it was
written, failing six seconds in, before running any of the project's code. Two of
the four pinned GitHub action versions pointed at commits that do not exist.
Nobody had noticed because local runs all passed — the local checks and CI are
different things.

Getting CI to actually run then surfaced six more bugs that only appear on
Windows: path handling that assumed `/` instead of `\`, a test asserting an
absolute path has no colon (impossible on `D:\`), two test suites needing ffmpeg
without checking for it, and a line-ending comparison that failed on every line.
All fixed. **CI now passes on Windows**, twice in a row.

Also found and fixed two real security holes along the way:

- A shipped build's update key could be overridden by an environment variable — so
  a released app could have been made to trust updates signed by someone else.
- The window navigation guard compared URL *prefixes* rather than hosts, so
  `http://localhost:5173@evil.example/` would load a remote page inside the app
  window, which has a bridge into the main process.

---

## What is left, in order

**1. Finish Phase 4 ⚠️** — what is left is §5.1's **Auto render scale** and the
frame-accurate transport it would be measured against. The *reporting* half of preview quality
is in: the preview says what it is playing ("Preparing smoother preview…" while a proxy is
being made — read from a live `proxy` job, so the chip is reachable rather than an aspiration,
and the job list is polled only while an import is still waiting on one — an admission when
proxy preview is switched off, silence when the file in use is the right one), and proxy
selection itself has lived in main's `preview-source.ts` since the
media pipeline landed, so an export can never be built from a transcode. The Auto ladder —
1 / 0.5 / 0.25 with a 30-frame moving average and a "Preview ½" chip — is not buildable on a
DOM layer stack that has no internal render scale to step down; it belongs with the WebGL2
renderer. The Crop tool now has its own frame,
including **"Set framing…"** — a fixed canvas window with the picture dragged under it and a
wheel to zoom, written as four keyframes in one undo step (what `13`'s auto-reframe will
automate): a rectangle
over the **uncropped** source with eight handles, dimmed outside, the aspect lock
(Free/Original/1:1/9:16/16:9/4:5/Canvas) and a rounded-corners slider, with `Enter`
applying the session as one undo step and `Esc` discarding it — and the radius is real
rather than a slider that writes nowhere: `crop.radius` reaches `itemGeometry`, is
keyframeable, and clips the picture in both the preview and the export. The edge handles
scale one axis each as §8.2 asks, and cropping happens only through the frame — the clip's
own edges never crop, whatever tool is on, so there are not two paths that disagree about
when they write. The preview now *reads* the frame cache it writes, so a scrub over ground already
covered is a file read rather than a seek, and §4's view controls are in: the *Handles*
toggle (`H`) hides the grips without deselecting, and the Pan tool with Space+drag pans
without taking Space from the transport. Canvas drag editing is otherwise
complete, modifiers included, the preview plays proxies, coalesces its seeks, zooms
about the cursor with `Ctrl`+wheel and back to Fit on `F`, shows its
compliance overlays, snaps a dragged clip to the canvas, to its neighbours, to the
safe-area edges and grid lines when those are showing and to the user's own guides, draws a
labelled line on what it caught and equalises the gaps when a spacing nearly matches. The
guides come from §8.8's menu — *Add horizontal*, *Add vertical*, *Lock*, *Clear* — or from
`Ctrl`-dragging in from an edge, and `Shift`+`Ctrl`-drag takes one away; a locked guide is
immune to both. The composition grid is the thirds or any N×M from 2 to 12, chosen in the
same menu, and its lines are snap targets while it is showing. The view zooms — Fit, Fill,
25–400% from the dropdown and `Ctrl`+wheel up to 1600% about the cursor — and past 800%
the pixel grid draws one line per canvas pixel. A selected clip's
picture can be dragged to move it (`Shift` locks an axis), its edges dragged to scale one
axis each, or a crop frame with the Crop tool on (`C`), its corners dragged to scale it about
the opposite corner (`Shift` free-scales, `Alt` pivots on the centre), the handle above it dragged to
rotate it about the anchor (`Shift` snaps to 15°), and the crosshair dragged to move
the pivot without moving the picture. Every gesture converts
pixels into canvas fractions so it means the same at any preview size, commits once
on release so the whole drag is one undo step, and `Esc` abandons it without
touching the undo stack. The anchor point is real too — rotation pivots where the
user says instead of always at the centre — and it is keyframeable like every other
animatable property. Fixing it exposed an older bug: the export refitted a rotated
picture to the canvas, so any rotation discarded the user's scale (a half-scaled
square came out 360×360 unrotated and 480×720 rotated). The keyframe **curve editor** now exists as a bottom drawer
(`Ctrl+Shift+C`): it graphs each keyframed numeric property, lets a control handle
be dragged and writes it as a single undo step, and it is what made `bezier`
reachable at all — the schema and the evaluator carried the field while no command
could write it. What it still lacks is the viewport (§2.6's zoom, pan and fit) and
the numeric transform tools. The inspector's numeric controls, including
the volume slider that used to be a read-only placeholder, now work, and the values
they write are drawn by the preview and applied by the export — including
auto-keyframing, which writes a key at the playhead when a property already has
keys and leaves the static value alone when it does not, so a slider drag on an
un-animated clip cannot start an animation by accident. All eleven animatable
properties the renderer reads now have a row with a diamond — scale, both position
axes, rotation and the four crop edges included — and the visible scale is the one
the compositor applies rather than `scaleX` alone.

**2. Finish Phase 5 ⚠️** — text and shape items, brand kits, and the audio tools
beyond the envelope. The style editor's **colour pickers and anchor grid are in**:
colours are hex-only (no eyedropper, recorded as a limitation), and the nine-cell
anchor grid is a real control rather than a display — it had to be added alongside a
fix, because the horizontal half of a caption's anchor was dead code in the layout
(the preview centred every block while the export honoured the anchored edge) and no
control could reach the field that would have exposed it. Captions themselves are
done: engine, frame builder, preview, list, word editor, burn-in, and the preview and
burn-in now agree on all nine anchors by a test that compares them to each other.

**3. Unify preview and export on a WebGL2 `renderFrame`.** Every compositor feature
the spec requires now renders and exports — captions, keyframed geometry, layer
blending, transitions and the nine required effects — but as a CPU path plus a CSS
approximation rather than the single shared renderer §10 §2.1 specifies.

**4. Finish Phase 6** — build an installer on a real Windows machine and run the
acceptance checks in `specs/15` §12. These need a clean Windows VM and a published
GitHub release; they cannot be done in a Linux sandbox:

- install on a clean machine, portable exe, uninstall keeps user data
- update from one version to the next, and roll back
- a real GitHub release end to end

**5. Phase 16** — the full acceptance pass and verification report.

---

## Things you need to know that are not obvious

- **The update signing key is a placeholder.** The app refuses all updates by
  design until a real key is generated and embedded. Run
  `node scripts/release/gen-update-key.mjs`, keep the private key as a GitHub
  secret, embed the public one.
- **`resources/bin` contains Linux symlinks**, not real binaries. Installing and
  packaging requires `node scripts/release/fetch-binaries.mjs` on Windows first.
- **No installer has ever been built.** `electron-builder` now reads the config
  correctly and stops at cross-compiling a native database module —
  `better-sqlite3` — which cannot be done from Linux. The release job runs on
  Windows, where that step is native, so it should work there; it is untested.
- **The hardware encoder path and whisper.cpp binaries have never been built.**

---

## How to check the project is healthy

```
pnpm verify
```

That runs lint, typecheck, all 2642 tests, builds the app, and runs the repository
checks. It should end with `check-repo: OK`. CI runs exactly the same command on
Windows, so a local pass and a CI pass mean the same thing — which was not true
before this session.
