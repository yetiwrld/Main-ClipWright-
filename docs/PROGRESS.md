# Where the project is

Written in plain language, for anyone picking this up. It is a summary, not a
replacement for `docs/verification.md` (what has been proven) and
`docs/limitations.md` (what is knowingly missing).

Last updated after commit `f8efdb2`. 3647 automated tests, all passing.

**The last seven commits repaired the app's connections to itself rather than adding features.** Every
one was a value, a name or a channel that two files disagreed about: the start screen sent settings
keys the schema does not have (so it could not create a project at all), four project actions existed
in the store and in no window, a refactor deleted 36 IPC channels including the whole AI and moments
surface, and the ducking settings on every track were read by nothing. The features were written;
what was missing was the join. `docs/decisions.md` §51–55 records each one, and the recurring shape —
a name in two files that no test reads from both sides — is why `ipc-surface.test.ts` now compares
the bridge's channel list against main's in both directions.

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
| **5 — Editor advanced** | Captions UI, text/graphics, keyframes, effects, transitions, audio tools, AI editing tools, brand kits | ⚠️ Mostly done: captions, keyframes, effects, transitions, audio envelope, text/shape items, the full preview graph, per-track metering and noise reduction built; **voiceover recording and the audio rack are deferred to a later version by decision** (see below) |
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

## The bug that had been there all along

The start screen — the first thing anyone sees — **could not create a project.** Pressing "Find
clips" sent `storageMode: 'copy'` where the schema says `managed`, the schema threw, and nothing was
written. Alongside it, three settings the page offered (`aspectRatio`, `captionStyle`, `clipLength`)
were keys nothing read, so every project was created at 9:16 with Bold creator and a 30–60 s target
whatever the user picked. And the create callback's dependency array was missing every one of them,
so the values were the initial ones regardless.

All three are now fixed by one shared module, and the reason they lasted is the part worth keeping:
**no test crossed the boundary between the page and the store.** The page had no test at all; the
schema's tests built payloads in the schema's own words. Fifteen mutations were run against the
fix, and four survived — every one of them a test that wrote down the answer instead of checking it.
That is the recurring lesson of this build, and this is the clearest example of it.

The project list had the same anatomy one rung lower: **rename, duplicate, archive and delete were
all implemented in the store and in the bridge, and no window could reach any of them** — the page
was a grid of cards that navigated into a project and nothing else. It has a ⋯ menu now, and
building it found a second bug: the delete option was declared `deleteMedia` and the store reads
`deleteExclusiveManagedMedia`, so ticking "also delete the copied media" would have deleted the
project and kept every file, with no error.

And then the largest one: **36 of the 122 channels the preload bridge offers had no handler in
main** — the entire AI surface (providers, models, Ollama, consent, privacy) and every moments
channel. Commit `8418bfe`, a refactor of three model handlers, deleted 160 lines from the IPC
registration and took the rest of the block with them. The services were still built and the file
still compiled, so nothing failed until a user opened a page. A test now compares the bridge's
channel list against main's in both directions, which is the check that had never existed.

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

**All clips** in the kit panel is now a real batch: every composition in the project is read,
planned and written, all-or-nothing, as one undo step for the clip that is open and an **Undo
batch** for the others — the split exists because their history lives in whichever editor opens
them next, not in this window.

The **momentary LUFS readout** (§6.3) is in, in the *Audio meters* popover the transport's meter
opens: BS.1770 K-weighting over a 400 ms gate, averaged in energy rather than decibels, compared
against a target it names, and honest about a gate that has not filled. Per-track meters still
need a node per track, which is the same missing graph as pan.

The **colour eyedropper** (SPEC 01, §11 §8.2) is in the shared `ColourPicker`, together with
recent colours: it is absent rather than disabled where Chromium's API is missing, Esc is silent,
and the caption style editor — which had its own private copy of the colour row, and was
therefore the screen apologising for the missing eyedropper — now uses the shared control.

**Deferred out of Phase 5 by decision, not by omission.** The **voiceover recorder** (SPEC 12
§6.5) and the **audio rack** — equaliser, reverb, de-ess (§6.8's optional stretch) — are moved to a
later version. They are recorded in `docs/limitations.md` §1 as v1 scope boundaries rather than
left in the phase as unfinished work, so nothing in the build claims them. Everything else §6 asks
for is built: the envelope, pan, the fades, the preview graph, the master and per-track meters,
momentary loudness, and noise reduction.

The brand kit's data layer is finished but no screen reads it: the `.cwbrand`
format, the placement maths and the application plan live in `packages/brand-kits` (36
tests), and the commands that apply, reapply, remove, detach and insert an intro or
outro live in `packages/timeline-engine` (26 tests). An intro is an *insert*, not a
placement: the project grows by its length and every unlocked track ripples, so the user's
cuts stay where they were against the picture. Safe-area presets move a kit's corner
graphics out of the platform's chrome, with the numbers pinned to `assets/safe-areas.json` by a
test. A kit can also be captured from the clip in front of you: `captureKitFromClip` reads the
caption style, its colours and font, and measures a corner image back into percentages so the
kit works on a different aspect ratio. A **Kits tab** in the library lists a project's kits and
applies them — one undo step per application, a report when a part could not be applied, and a
confirm that says the items survive a delete — and an **editor** that creates a kit from scratch
or from the current clip, with every problem reported at once. A missing font substitutes by
character — a serif falls back to a serif — and the sentence naming both reaches the apply
report.
A `.cwbrand` file is a real zip — `kit.json` plus the assets it names — written
without a dependency and verified in the tests with `unzip`, including a checksum check
that a flipped byte fails. The file **travels**: the panel exports a kit to a `.cwbrand`
archive and imports one back. Both the save dialog and the asset reads happen in the main
process — a media id is not a path, and no bridge call returns bytes, by design — so the
renderer names a kit and never a file. A missing asset is named in the notice and the archive
is still written; a kit whose id is already in the project is re-minted on import rather than
overwriting the one in use; and the dialog is shown *before* the archive is built, so
cancelling costs no disk reads and raises no error. Applying a kit produces ordinary items tagged
`aiProvenance: {tool: 'brand-kit'}`, which is what makes "delete the kit, keep its work" a
property of the design rather than a promise.  Three entries left this list
rather than being rephrased. The **shape row** is in — a shape offers its kind, an icon
offers its stroke width, and neither appears for the other. **Re-picking** an icon on an
existing item is in too: the picker gained the caller it never had, so its `value` and
`strokeWidth` props finally select and show the current icon, and changing a star to a
heart no longer means deleting the item and losing its timing. **Metering** is in as the
transport's stereo peak meter (above); what remains of §6.3 is the momentary LUFS
readout, which needs the mix, not the preview. This
paragraph used to list the text and shape items as open — they have been built and
drawn in both renderers for several slices, and icons joined them, so that claim
was a stale line rather than a gap. The inspector's keyframes,
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

**2. Finish Phase 5 ⚠️** — brand kits, the audio tools beyond the envelope, and the
curve editor's viewport. The audio controls themselves now reach the file: **Gain, Pan,
both fades and the fade curve were inert in the export** until this slice — the inspector
wrote them, the project stored them, and `planAudioItems` carried none of them, so the
mixer's fallbacks supplied 0 dB, centre and no fade for every clip. The tests read the
rendered WAV rather than the request, which is how the volume keyframe line had been fixed
earlier; this was the same bug shape a third time. The **master peak meter is in** (§6.3): stereo, −60…0 dB, a 1.5 s hold and a clip light
that latches until clicked, reading two analysers on the preview's own `<video>`. Its
arithmetic is a pure module with eleven tests and ten mutations, because jsdom has no
`AudioContext` and the decisions are all in the arithmetic. The **full Web Audio graph is in** (SPEC 12 §6.2): one element, one gain node carrying
the whole envelope and one panner per audible item, summed into a bus. It closed the two
symptoms that absence explained — only the bottom picture layer was audible, so an audio
item played in the file and was silent in the editor, and pan was stored, exported and
never previewed. The meter now taps the bus, so both it and the LUFS readout measure the
mix instead of one layer. The preview now runs on **the audio device's clock** (SPEC 09 §23): the
playhead is derived from `AudioContext.currentTime` through an anchor taken on the first frame
of playback, so a dropped frame costs picture rather than sound, and playback rate
(0.5×–2×, pitch preserved) is in the transport. **Per-track meters are in** (§6.3): a summing node per audible track in the graph, and two 3 px
bars in the header on the master meter's own scale and colours, from the same arithmetic module.
**Track-level auto-ducking is in** (SPEC 12 §6.7), which closes the largest instance of the
recurring bug in this build: the schema has carried six ducking fields on every track — trigger
tracks, a −3…−24 dB reduction, a −42 dBFS threshold, a 120 ms attack and a 400 ms release — since
the format was written, and **nothing read them**, and no command could write them. It is now one
shared module that returns spans ("the track is held down from here to here"), which the preview
multiplies into its gain automation and the export turns into a per-sample curve through the same
`duckingCurve` the per-item flag already used — so the editor and the file cannot disagree, and a
test compares the two envelopes at two thousand instants to keep it that way. A track menu item
turns it on; an empty trigger list means "everything else", and a near-silent word gap is merged
rather than releasing and re-attacking inside the release time. What it does **not** do is detect
speech: it ducks under *placements*, so a bed under a mostly-silent clip is ducked throughout (see
`docs/limitations.md` §5).

**Ducking and normalisation are now both reachable.** Normalisation measures the real mix and
lifts it toward −16 LUFS; ducking lowers a music bed under speech. Both worked in principle and
neither could run for a real project: normalisation had a checkbox and a mixer branch, and ducking
had an arithmetic and a mixer branch but **no field on the item and no line in `planAudioItems`
forwarding the flag** — three layers agreeing about a value no project could hold. A brand kit's
music bed is what exposed it: the panel said "Music bed added with the kit's ducking" while
`applyBrandKit` had no music branch at all. All three are built now, and the bed's cue ends where the
item *sounds* rather than where its padded clip ends — a one-second voice on a two-second item used
to keep the bed down through a second of silence. **Text and shape items are in**, which closes the biggest
hole in the phase: the schema had declared the two item types and their fields from
the start while nothing read them, so a project could hold a title that no renderer
would draw and no user could create. A text item is deliberately a caption without
words — same style resolution, same layout — so the preview and the burn-in agree by
construction rather than by a second implementation that has to be kept in step.
**Shapes now draw too**, in both the preview and the file: one geometry in the
compositor with an SVG serialiser for the canvas and an ASS drawing serialiser for the
burn-in. Before that they were invisible in both, which is worth knowing because the
docs had claimed otherwise for one commit. **Icons are in** (SPEC 11 §12): the whole
Lucide set ships offline as data, converted to the same geometry a rectangle is drawn
from, so an icon needs no renderer of its own. 1541 of Lucide's 1555 icons convert; the
14 that use a genuinely elliptical arc are refused by name rather than drawn
approximately, and the picker does not offer them. Adding one is a context-menu entry
that opens the **picker** — a searchable, paginated grid of the drawable set with a
stroke-width field. It is the same reachability problem the shapes had, since a library
with no control is indistinguishable from one that was never imported; and it is where
the stroke width is chosen, so the value has to travel from the field through the
command onto the item and out to `\bord` — an earlier version computed it and dropped
it at the panel, which is exactly the sort of gap that looks like a working control.
They draw as **outlines**, not silhouettes, at a stroke width the project stores
(0.5–4 in Lucide's own units), inside a **square** box — an icon drawn into the
shape box was stretched 16:9, measured at aspect 1.668 before the fix. Rendering a
star through the real ffmpeg is what found both, and the same pass found two older
export bugs that no test had seen: every shape and icon was being dropped from the
burned-in script, and `\pos` was doubling the box origin so a centred rectangle
landed in the bottom-right corner. The style editor's **colour pickers and anchor grid are in**:
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

That runs lint, typecheck, all 3647 tests, builds the app, and runs the repository
checks. It should end with `check-repo: OK`. CI runs exactly the same command on
Windows, so a local pass and a CI pass mean the same thing — which was not true
before this session.
