# Clipwright Studio — Architecture & Engineering Decisions

This document records binding engineering decisions, colour sampling results, and technical trade-offs made during the construction of Clipwright Studio (`specs/00` §0.3–0.4, §10.1, §10.6).

---

## 1. Logo Colour Sampling & Brand Palette (Spec 01 §2 & §3.1)

On first run of Phase 1, `ClipWright Icon.png` (1254×1254 RGBA PNG) was sampled directly across key regions:
- **Outer background (0.05, 0.10):** `#000000`
- **Inner dark surface (0.20, 0.25):** `#2B2C2F`
- **Graphite crescent (0.24, 0.50):** `#3B3C3F`
- **Play button orange centre (0.47, 0.50):** `#FC7D01`
- **Play button amber highlight (0.43, 0.50):** `#FB9A02`
- **Play button deep orange right (0.52, 0.50):** `#FC6001`
- **Top orange arc (0.52, 0.33):** `#FC8601`

**Decision:** The sampled orange values (`#FC7D01`, `#FC6001`, `#FB9A02`) match the Spec 01 §3.1 tokens (`--brand: #FF7A00`, `--brand-strong: #FF5A00`, `--brand-amber: #FFB000`) within 1–2% perceptual delta. We retain the exact Spec 01 semantic tokens (`#FF7A00`, `#FF5A00`, `#FFB000`, `--on-brand: #121212`) and the stepped neutral surface scale (`#0E0E0F` → `#161617` → `#1F1F21` → `#28282B` → `#303034`). All 13 foreground/background pairs were verified by automated WCAG 2.1 contrast tests (`verifyAllTokenContrasts()`).

---

## 2. Typography & Timecode Monospace (Spec 01 §4)

- **UI Font:** **Manrope** (weights 400, 500, 600, 700) is bundled locally in `/assets/fonts/` as `.woff2` (OFL-1.1) and loaded via `@font-face` with zero network requests.
- **Timecode Font:** `"Cascadia Mono", "JetBrains Mono", Consolas, monospace` with `JetBrains Mono` bundled locally in `/assets/fonts/` so timecodes never jitter during 30/60 fps playback even on machines without Cascadia Mono installed.
- **Caption Preset Fonts:** Bundled locally in `/assets/fonts/` (Inter, Montserrat, Poppins, Anton, Playfair Display, Bangers, JetBrains Mono — all OFL-1.1).

---

## 3. SQLite Engine & Durability Layer (Spec 03 §2 & §5)

- Both `workspace.db` and per-project `project.cwdb` run in SQLite **WAL mode** (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`) with `synchronous = NORMAL` during normal operation and `synchronous = FULL` on atomic checkpoint commits.
- Our `SqliteDatabase` adapter (`packages/project-schema/src/sqlite-adapter.ts`) wraps Node's built-in synchronous SQLite engine (`node:sqlite` `DatabaseSync` in Node 22+ / Electron 34+) and supports `VACUUM INTO` for consistent online backups before migrations and `.cwpack` exports.
- Every JSON payload column is validated with `zod` (`.passthrough()` at top level to preserve unknown fields across minor versions). Rows failing validation are moved untouched into `_quarantine` rather than crashing project load.

---

## 4. Bundled FFmpeg / ffprobe Licensing (Spec 15 §6.2)

- Clipwright Studio distributes `ffmpeg` and `ffprobe` as **separate standalone executables** invoked via `child_process.spawn` / `execFile` (never linked into the application binary).
- The GPL build including `libx264`, `libvpx-vp9`, `libopus`, and native `aac` is documented in `docs/licences.md` along with the written source offer and build configuration.

---

## 5. Application Licence (Spec 15 §6.2)

- Per Spec 15 §6.2, `LICENSE` defaults to `"All rights reserved — see README"` until the repository owner selects a distribution licence. Third-party open-source component notices are listed separately in `docs/licences.md` and `THIRD-PARTY-NOTICES.txt`.

---

## 6. Update authenticity without code signing (Spec 15 §5)

**Decision:** ship an unsigned installer, and make updates safe with a **signed release manifest** rather than Authenticode.

**Reasoning:** Authenticode needs a paid certificate that is renewed annually, and without it Windows only tells the user "unknown publisher" — it says nothing about whether a specific *update* came from us. An Ed25519 signature over a manifest we control proves authorship of every release regardless of whether the installer is signed, and it costs nothing to keep.

**Consequences:**
- The private key exists only as a GitHub Actions secret. Losing it means the current user base cannot be updated by the updater and must install manually (recorded in `docs/release.md` §5).
- A build whose embedded public key is missing or a placeholder refuses **every** update. This is deliberate: refusing is recoverable, installing something unverified is not.
- The signature is checked before the manifest's hashes are used, so a forged manifest cannot steer a download.
- Two keys are supported (`current` and `next`) so a key can be rotated without stranding users who have not updated yet.

---

## 7. Two Vite builds for the desktop app (Spec 15 §6)

**Decision:** build the renderer with `vite.config.ts` and the main process plus preload with a separate `vite.main.config.ts`, producing CommonJS under `dist/main`.

**Reasoning:** the two run in different worlds. The renderer targets a browser (React, relative asset URLs so `file://` works); the main process targets Node, imports `electron`, and must leave native modules (`better-sqlite3`, `onnxruntime-node`) external so their `.node` binaries load from outside the asar. One config cannot honestly serve both.

**Consequences:**
- `package.json` `main` points at `dist/main/index.cjs`, and a renderer-only build leaves the app unable to start. `scripts/release/assert-package.mjs` and a CI step both check for that file specifically.
- Chunk names are deterministic, so the launch path does not change between builds.

---

## 8. Audio mixed in TypeScript, not in an ffmpeg filter graph (Spec 14 §5)

**Decision:** compute the mix in `packages/export-core/src/audio-mix.ts` and write a float32 WAV, rather than building an `amix`/`afade`/`sidechaingate` filter graph.

**Reasoning:** a filter graph of that size cannot be unit-tested — the numbers only exist inside ffmpeg. Doing the arithmetic ourselves means gain, fades, panning, ducking and the limiter are all covered by tests that assert exact samples, and the loudness normalisation is measured with ebur128 on the file we actually produce rather than trusting a filter's nominal behaviour.

**Consequences:**
- The limiter must stay O(n). The first implementation scanned a lookahead window per sample and was quadratic; a 10-minute clip made that obvious, and it is now a monotonic deque with a test that times it.
- Large mixes are held in memory at 48 kHz stereo float (about 23 MB per minute). Acceptable for the target clip lengths, and stated in `docs/export.md`.
- Audio-rack effects are not applied yet; when they are, they belong in this same pure module so they can be tested the same way.

---

## 9. The preview reads the scrub cache but never fills it (Spec 10 §5)

**Decision:** the preview draws a cached scrub frame over a layer's `<video>` while that
element reports a seek in flight, reading it through `clipwright-media://scrub/<id>/<µs>`
— a protocol URL that answers 404 for a frame that has not been extracted yet. It never
calls `media:getThumbnail`, which extracts on demand.

**Reasoning:** the two paths look interchangeable and are not. `media:getThumbnail`
guarantees an answer by running ffmpeg when the file is missing, which is exactly right
for the filmstrip — one request per tile, once — and exactly wrong for a scrub, where the
pointer crosses tens of cells a second. Calling it per move would replace a seek (a codec
operation) with a subprocess spawn plus a decode, so the "optimisation" would make
scrubbing slower than before it existed. A 404 is the honest answer to "is this frame
available": it costs nothing, and it lets the layer fall through to the element, which is
what the preview did before.

**Consequences:**
- The preview's stills only appear where the timeline has already been, since the
  filmstrip is what fills the cache. The remaining gap — extracting on arrival, after the
  playhead settles — is recorded in `docs/limitations.md` rather than half-built here.
- A cell boundary can be up to one grid step *before* a trim's in-point, because the file
  name is derived from the floored absolute source time. That direction is deliberate: a
  frame early can only reveal what lies inside the clip, whereas a frame late would show
  past a cut.
- Mounting and visibility are separate. An `<img>` must be in the tree to load at all, and
  must be hidden until the load naming *its own* URL arrives, so a stale picture cannot be
  mistaken for the frame the user is waiting on.

---

## 10. Space plays *and* pans, without either losing (Spec 10 §3.2 vs §4)

**Decision:** the preview's pan listener observes Space but never claims it. Space **down**
still toggles playback; a pointer press that happens **while Space is held** pans the view
instead of moving the clip under it. The listener is passive, clears on `blur`, and the
gesture is bound in the capture phase on the viewport.

**Reasoning:** the spec puts Play/Pause and view-panning on the same key, in two sections,
and the naive readings both lose something. Claiming Space for the pan with
`preventDefault` takes the transport shortcut away. Ignoring Space and panning whenever the
view is zoomed takes the canvas away instead — a press on a clip would move the view. The
pairing above is unambiguous per event: playback is a keydown, panning is a pointer-down
that occurs while the key is down. Neither promise is weakened, and a user who wants a pure
pan uses the Pan tool, where no key is involved at all.

**Consequences:**
- Starting a Space+drag also toggles playback once. That is visible and honest, and it is
  what the spec's own pairing implies; suppressing it would mean the key had two meanings
  chosen by timing, which is worse than one meaning chosen by event type.
- The gesture must run in the **capture** phase. The clip's drag starts on the layer's
  `pointerdown`, which is inside the viewport, so a bubble-phase listener runs *after* the
  clip has begun moving — the pan would happen and the clip would move with it.
- `spaceHeld` clears on window `blur`, because a key-up delivered to another window never
  arrives. A stuck flag turns every later press into a pan, and the symptom is reported as
  "the canvas stopped responding", which points nowhere near the cause.

---

## 11. The pan is bounded by the frame's overhang, not its size

**Decision:** `clampPan(pan, scaled, viewport)` limits the pan to `max(0, (scaled − viewport) / 2)`
per axis, rather than to `scaled / 2`.

**Reasoning:** bounding by half the frame's own size was invisible while panning was only a
side-effect of zooming about the cursor, because the correction that gesture needs is small.
The hand tool asks for whatever the pointer travels, and the size-derived limit lets a drag
push the frame half off the panel at **Fit** — where the frame already fills the panel and
there is nothing to pan to. The overhang is the extent that actually means something: zero
when the frame fits, growing as it is zoomed past the panel, and exactly enough to bring any
part of the frame into view without losing it.

**Consequences:**
- A frame *smaller* than the panel computes a negative overhang, so the `max(0, …)` is
  load-bearing rather than defensive: without it `min(−100, max(100, v))` returns `−100` for
  every `v`, forcing the frame a hundred pixels off-centre with nothing the user did.
- A missing or degenerate viewport bounds to zero rather than to `NaN`. Every comparison
  against `NaN` is false, so a `NaN` limit would not clamp at all — the frame could be
  dragged away entirely, and jsdom's zero-measurement would hide it in every test.
- `-0` is folded to `0`. The two are equal on screen and in JSON but not under `Object.is`,
  so a symmetric pan out of a zero limit otherwise fails a deep-equality assertion and reads
  as an asymmetry in the clamp.
- `canPan` was deleted rather than kept: the zero-overhang rule already says "there is
  nothing to pan to", and the function had no caller outside its own test.

---

## 12. The edge handles scale, and cropping moves to its own tool

**Decision:** under every tool but Crop, dragging one of a clip's four edge handles
scales that edge's axis (SPEC 10 §8.2). Cropping is the **Crop** tool's gesture (`C`,
§8.6). `Shift` on an edge gives it the uniform corner behaviour.

**Reasoning:** the two sections describe two different meanings for the same four handles,
and the app had chosen one of them by accident. Cropping was the edge gesture because it
was the only edge gesture the surface had ever had, which left §8.2's per-axis scale with
no pointer affordance at all — expressible in the maths, unreachable by hand. The
specification's own split is by tool, so adopting that split is what lets both exist
without either being a modifier away.

**Consequences:**
- Cropping is now one keystroke further away than it was. That is a real cost, accepted
  because the alternative is that per-axis scale has no gesture; `C` toggles, so a user
  who crops repeatedly is not stuck re-pressing it.
- Corners are unaffected by the tool. §8.2 gives them the uniform gesture unconditionally,
  and a corner is a two-axis handle whichever tool is active.
- The compensation had to become per-axis, which exposed a bug in the *existing* corner
  code: `scaleAboutCorner` averaged the two axes into one delta, right only while the scale
  stays uniform, so the `Shift` free-scale that already shipped slid the fixed corner by
  100 px on a 400×200 picture. Every test of it used a uniform factor. The correction is
  `(S₀ − S₁) · (p_f − anchor)` per axis.
- The fixed point of an edge is the **opposite** edge, which is what makes the picture grow
  away from the side the user is not touching. It is computed from the drawn box captured
  at pointer-down, for the same reason the corner path captures it: a mid-drag layout shift
  would otherwise move the side that is meant to be still.

## 13. The crop session is a draft, and the frame sits over the uncropped source

**Decision:** the Crop tool's frame (SPEC 10 §8.6) edits a **draft** held in view state.
Nothing is written to the document until `Enter`; `Esc` discards the session. The frame is
drawn over the **uncropped** source, so the picture is rendered whole while the tool is on
— the stored crop is dropped for that layer and nothing else is.

**Reasoning:** §8.6 asks for apply-and-cancel over a rectangle drawn on the uncropped
source, and neither half survives a per-gesture write. Writing each drag straight to the
document makes `Esc` a thing that can only undo what it is meant to discard, one undo entry
at a time; and drawing the frame over the *cropped* picture makes widening a crop
impossible, because the area the user would widen into is already invisible, so the grips
sit on the edge of a picture that has been cut away. Both are the same underlying choice:
the session is a statement about the picture, and the picture has to be whole for the
statement to be expressible.

**Consequences:**
- A session that changed nothing pushes no undo step, compared with a 1e-6 tolerance
  (`cropChanged`). `Enter` on an untouched frame is a way to leave the tool, not an edit, and
  an empty undo entry teaches the user not to trust `Ctrl+Z`. The tolerance is the other
  direction of the same rule: a drag that returned to its start lands a few ulps away and
  must not be recorded as a change either.
- Cropping now happens **only** through the frame. The clip's own edge handles always scale
  their one axis (§8.2), under every tool. Keeping the old per-clip edge-crop alive
  alongside the frame would have left two overlapping hit tests that disagree about *when*
  they write — one on pointer-up, one held until `Enter` — so a drag near an edge could be
  committed by one and reverted by the other's `Esc`.
- Exiting the tool by any route is the same as `Esc`. The draft is adopted when a session
  opens and dropped when it closes, so pressing `V` half-way through cannot leave a crop the
  user never applied.
- Applying goes through `commitKeyed`, like every other canvas edit. Writing
  `setItemProperties` directly was a real bug the existing §2.4 test caught: an animated
  clip's crop appeared to work and then vanished on the next redraw, because the evaluator
  reads the keys and ignores the static field.
- The locked aspect grows the *other* axis from its **own centre**, and refuses rather than
  clamping when that centring would push the window off the source. Clamping one side while
  refusing the mirror case made the same situation behave two ways — a window near the top
  slid down to stay legal, and the mirror image near the bottom was refused — and sliding
  breaks the framing the user chose as much as refusing does.
- The corner radius needed a field that existed but was read by nothing. `crop.radius` is
  now resolved in `itemGeometry`, capped at half the **cropped** window's short side (past
  that it is an ellipse, and renderers disagree about which), and drawn as a `borderRadius`
  clip on the element whose `overflow: hidden` already does the cropping — so the preview
  and the export cut one shape rather than two. A broken value falls back to square, because
  a `NaN` radius blanks the layer without throwing.
- §8.6's **"Set framing…"** button and the reframe gesture behind it (the manual precursor
  of auto-reframe, `13`) are *not* built. The limitation records it.

## 14. Reframing moves the picture, and a framing is written as one point

**Decision:** §8.6's **"Set framing…"** is a mode of its own, not a control inside the crop
frame. The window is the canvas — fixed — and the drag moves the **picture** under it, with
the wheel zooming. `Enter` writes position and scale as four keyframes through one new
`setKeyframesAt` command; `Esc` writes nothing.

**Reasoning:** cropping and reframing are opposite gestures over the same visual grammar. A
crop drag moves a window over a still picture; a reframe drag moves the picture under a still
window. Offering both at once would make one drag mean two contradictory things depending on
where it started, which is the sort of ambiguity that produces a bug report saying "cropping
moves my video". Keeping them separate also matches what auto-reframe will write (`13`): that
feature produces position and scale, not crop edges, so a manual gesture producing anything
else could not be compared with it, replaced by it, or keyframed beside it.

`setKeyframesAt` exists because a framing is a *point*. `addKeyframe` commits per property, so
four calls would leave four entries in the undo stack for one drag — `Ctrl+Z` after framing a
shot would undo a quarter of the framing and leave a picture nobody chose. The command also
replaces an existing key at the instant rather than refusing (re-framing a moment already
framed is a correction, not an error) and keeps that key's interpolation, so a curve the user
shaped is not flattened by re-framing its own moment.

**Consequences:**
- The clamp is half the **overhang**, not half the size: a picture of size `s` still reaches
  the canvas's edge while `|centre| ≤ (s − 1) / 2`. Half the size would expose canvas at every
  scale a user can reach, which §13's acceptance criteria forbid.
- An axis the picture cannot cover is held **centred**, not clamped to a range that does not
  exist. A 16:9 shot in a 9:16 canvas covers the width exactly at scale 1 and only 0.3164 of
  the height, so there is no vertical position that covers — and the `max(0, …)` on the limit
  is what makes the degenerate case centre instead of producing a nonsense offset.
- The gesture needs a zoom because of that. The scale at which a 16:9 picture covers a 9:16
  canvas is `sourceAspect / canvasAspect` = 3.16; below it the vertical axis can only be
  centred, which is a real constraint rather than a missing feature.
- Scaling re-clamps the offset at the new size. A framing legal at 2× can hang off the window
  at 0.5×.
- Neither mode writes during the drag. Both are drafts, and both refuse to commit a gesture
  that ended where it started — an empty undo entry makes the next `Ctrl+Z` look broken.

## 15. "Never silent" without a render scale: report, do not fake a ladder

**Decision:** of SPEC 10 §5.1's three parts, the preview implements the one §5.1 states as a
rule — *"a small chip … appears in the toolbar (never silent)"* — and does not implement the
Auto render scale. The chip describes which file is playing; the ladder that would step a
render resolution between 1, 0.5 and 0.25 is recorded as a limitation.

**Reasoning:** the ladder is a control over an *internal render scale*, and this preview has
none. It draws the DOM layer stack with each element at its own resolution, so there is no
number to halve and no frame to upload; a "Preview ½" chip would report a resolution nothing is
rendered at, and the 30-frame moving average behind it would measure DOM compositing rather
than the GPU work the thresholds were chosen for. §5.1's other rule — the paused frame redraws
at Full after 150 ms — is vacuous here for the same reason: there is no reduced scale to
restore from.

The chip, by contrast, is exactly as applicable as it was when the spec was written, because it
describes something the DOM path has too: **which file is being decoded**. Proxies exist
(`04 §6.3`), the media pipeline creates them, and main's protocol handler picks between the
proxy and the original — so the preview genuinely can be playing something other than the real
image, and the spec's rule that it say so is fully satisfiable.

**Consequences:**
- Silence is the default and has to be *earned*: a proxied clip, a source `needsProxy`
  declined, and a still image all report nothing. A chip that is on screen for every ordinary
  project is a chip nobody reads.
- Two chips remain, and they read differently by design: "Preparing smoother preview…" is a
  promise about shortly, and the proxies-off notice is a statement about now. That is why the
  chip carries a `tone` rather than only a string.
- The chip names the *selected* clip's file, not every visible layer's. A stack of one chip per
  layer would be unreadable and would report on files the user is not looking at.
- Wiring it found a contract gap rather than a bug: main has always returned the whole media
  record, but the renderer's declared `listMedia` shape omitted `proxyPath`, so the preview
  could not have known what it was playing. The fix was to declare the field, and the comment
  there records why the renderer's type had been narrowing a record it already received.
- The setting reaches the preview as a **prop** defaulting to on, matching main's own default.
  Reading it in the component would make the preview reach for global state and default to
  *off* before the settings arrive — a lie in the direction that matters, telling the user they
  asked for something they did not.
- "A proxy is being made" is read from a live **`proxy` job record** — `type: 'proxy'`, a matching
  `mediaId`, and a status of `queued`, `running` or `paused` — not from a flag on the media
  record. The media record has no such flag. The first version of this shipped one anyway
  (`proxyPending`), which read correctly in the policy, passed fourteen tests, and was
  unreachable in the running app: nothing produced it. A unit test can only prove a rule is
  self-consistent, so the question "who sets this?" has to be answered outside the test file.
  The signal that does exist is the job record the pipeline already writes, and `media-pipeline`
  already reports "Preparing preview" at 86% of an import.
- `failed` and `cancelled` proxy jobs are **not** live. This is the case an obvious
  "is there a proxy job?" test gets wrong: a failed transcode leaves `proxyPath` null
  indefinitely, so "Preparing smoother preview…" would promise a file that is never coming, and
  the user would watch it forever. Silence is the honest answer there, the same as for a file
  that needs no proxy.
- The job list is **polled, while something is waiting**. `mediaAwaitingProxy` is true only while
  some media has `needsProxy` and no `proxyPath`, so the interval exists for a few seconds on a
  cold import and stops for good once the transcode lands. A push channel would be better and
  would need main to emit one; a poll for the life of the editor would be a timer answering a
  question nobody asked. The predicate's `proxyPath` clause is its termination condition — drop
  it and every project polls forever.
- The preview degrades to **silence** when it has no job list (`jobs` is optional, default
  empty). A chip that cannot be computed is not drawn, rather than being drawn from a guess:
  "Preparing…" invented for a file that is not transcoding would send a user looking for a
  progress bar that does not exist.

## 16. A caption's anchor decides which edge `xPct` measures from

SPEC 11 §5 says `xPct`/`yPct` place the block's *anchor*: a `bottom-left` caption puts its
bottom-left corner on those percentages, a `center` one puts its middle there. The vertical half
of that was implemented. The horizontal half was not — all three branches of the expression
computing the block's left edge returned `xPct − width / 2`, so changing the anchor's horizontal
part changed nothing and every caption was centred.

- **Why nothing caught it.** The ten built-in presets are all centre-anchored at `xPct: 50`, the
  one place where the three branches agree with each other and with the bug. The layout tests
  only exercised centre anchors; the screenshots only showed presets. Meanwhile the ASS export
  writes `\an<code>\pos(x, y)`, which is correct by construction — so the preview and the burn-in
  disagreed about every left- and right-anchored style, and neither one had a test that could
  see the other.
- **The fix** is three branches that differ: a left anchor puts the block's left edge on `xPct`,
  a right anchor puts its right edge there, and only a centre anchor centres it.
- **The check is against the exporter, not against numbers.** `export-core`'s
  `caption-anchor.test.ts` walks all nine anchors at an off-centre `xPct` and asserts the block
  edge the layout produced is the edge `assAlignment` says the export pins, using the export's own
  `assPosition`. Hard-coding nine expected pixel values would have tested the layout against a
  second opinion; this tests it against the thing that has to agree with it. The test lives in
  `export-core` because that package already depends on `compositor` and the reverse is not true —
  the preview must not import the exporter to be verifiable.
- **The bug was also unreachable.** The style editor exposed a vertical slider and no horizontal
  one, so `xPct` could not be changed and the anchor could not be changed at all: no user could
  have hit the divergence, which is part of why it survived. The editor now has the spec's
  nine-cell anchor grid and a horizontal slider. Adding the control and fixing the arithmetic are
  the same job — either alone leaves a feature that is either wrong on screen or impossible to
  reach.

## 17. A text item is a caption without words

SPEC 11 §7 describes text items as a separate feature from captions: titles, lower thirds,
callouts, with their own property list. This build implements them as the *same* thing minus the
transcript, and that is the decision worth recording.

- **One renderer.** A text item resolves its style through `resolveStyle` and lays out through
  `layoutText`, exactly as a caption does. It therefore inherits wrapping, the nine anchors,
  outline, shadow, background, and the preview/export agreement all of those already have tests
  for. A second styling system for titles would be a second implementation to keep in step, in a
  project whose central invariant is that the preview and the file are one renderer. The
  `caption-anchor` bug (§16) is a worked example of what two implementations cost.
- **One burn-in.** `assCuesFromPlan` emits a cue for a `text` item as it does for a `caption`,
  branching only to read `textContent` instead of the segment. A title burns in through the same
  ASS path, so it cannot look different in the file than on the canvas.
- **What they differ in.** No word timings, so no karaoke: a title is fully visible for its whole
  span, and `captionFrameAt` treats the absent timings correctly because "no timing" already means
  "already spoken". The item's own range becomes the animation segment, so a style's entrance
  fade plays over the title's duration rather than over a span it does not have.
- **Negative cases decide the behaviour.** An empty text item draws *nothing* — "add text" then
  "type" is a real intermediate state, and a background box would flash before there is any text
  in it. An unknown `shapeKind` draws nothing rather than a rectangle: a rectangle is a claim
  about what the file contains, and the file says something else. Both are tested.
- **Draw order: text under captions.** Both share the preview canvas, and a caption is the thing
  the viewer is reading. A title that covered one would be the wrong layering.
- **Shapes are paths, in a fixed 100×100 box.** One SVG string per kind feeds the preview's `<svg>`
  and, when the rasteriser exists, the export. Coordinates in a fixed box scaled by the caller mean
  a stroke is crisp at any size; a shape drawn at preview scale and stretched would be the one thing
  that looked different in the file. A test walks every path and asserts every coordinate lands
  inside the box, which is what catches an arc or a star vertex that spills out of its own element.
- **They are created from the timeline's context menu, not a media browser.** Neither has a file to
  drag in. The alternative — a Text/Graphics panel tab — is a larger surface for the same command,
  and the panel tab is still listed as missing rather than pretended.

## 18. One shape geometry, two serialisers

A shape has to be drawn twice — on a canvas in the preview, and inside an ASS script in the
file — and those are different languages. The first attempt at this gave the exporter its own
translator, which was both a large amount of code (an SVG path parser, arc-to-cubic conversion,
a command-type union) and wrong on the first draft. It was deleted.

- **The geometry lives in `compositor`, not the renderer.** It has two consumers on opposite
  sides of the dependency graph: the preview is in `apps/desktop`, and the exporter is in
  `export-core`, which depends on `compositor` and not the other way round. A geometry defined in
  the renderer could not be reached from the exporter at all — which is precisely how a shape came
  to be drawn by *neither* renderer while the docs claimed it was previewed.
- **`shapeGeometry` returns subpaths of lines and cubics in a 100×100 box.** Not an SVG string:
  a string is one serialiser's output, and the second consumer would have to parse it back. The
  renderer writes SVG or draws canvas paths from the subpaths; the exporter writes ASS `m`/`l`/`b`.
- **Curves are cubics everywhere, which removes the hard part.** Shape arcs are all quarter or
  half circles, and kappa makes one cubic match a quarter circle to within a rounding error. There
  is no arc flattening, no approximation to document, and no ASS arc command to emulate.
- **A shape borrows its caption style's fill.** The schema has no shape colour, and adding one
  would be a field the style editor does not know about and the user cannot set. Borrowing means
  one answer to "what colour is this", shared with the captions beside it. The ASS override
  suppresses that style's outline and shadow, because a preset's outline on a filled rectangle is
  a border the preview never draws.
- **An unknown `shapeKind` draws nothing on both sides.** A rectangle substitute would be a claim
  about content the file does not have. Asserted separately in each renderer, because "both
  renderers refuse" is only true if both are actually tested for it.
- **The process lesson.** The previous commit's message and docs said shapes were previewed. They
  were not: `shapePath` returned a string, the tests checked the string, and no element ever
  called the function. A function with tests and no caller is indistinguishable from a working
  feature in every artifact except a running app. The check that finds it is asking "who calls
  this?" — which is the same question that caught `proxyPending` (decisions §15).

## 19. Linked selection expands the selection; it does not make the commands aware

SPEC 09 §9.6 says a detached audio item and its video share a `linkId`, and that with **Linked
selection** on, "moving, trimming, splitting, deleting and speed changes apply to both together".
None of those five commands did anything with `linkId` — `linkedTrackIds` existed and was read
only by the ripple paths. Detaching audio and dragging the picture left the sound behind.

- **One expansion, called by every command.** `withLinkedSelection(state, itemIds)` returns the
  ids plus their link partners and group members, honouring the document's own toggle. Each
  command expands its input once and then works with the result, rather than teaching five
  separate mutation loops about links — which is how five places to get it wrong.
- **Partners move by the delta, never to the same time.** A detached item deliberately placed
  200 ms after its picture must still be 200 ms after it. Snapping a partner to the picture's
  absolute position closes the gap on the first drag and the sound drifts against the lip.
- **A trimmed partner trims its own edge by the delta.** Using the picture's new end directly
  collapses an offset partner onto it and `trimGeometry` then clamps the sound to one frame — a
  silent picture with a sliver of audio, which looked like the trim itself failing.
- **The gap-closing pass must skip every move in the batch.** `closeMainGaps` skipped "items the
  caller named", and a linked partner is not one of those: a group member on the main track moved
  correctly to 7 s and was then pulled back to 6 s. The set that skips is now the whole batch.
- **A duplicate is a pair under a new shared link.** One fresh id per copy would leave the copies
  unlinked from each other, so dragging the copy of the picture would leave the copy of the sound
  behind — the original bug, reintroduced on the copy.
- **Groups and links are separate relations, expanded in one pass each.** Making expansion
  transitive through both would move a link partner of a group member the user did not group.
- **The toggle is document state and needed a command.** `linkedSelection` and `coverLock` were
  schema fields with no writer and no control: every project was permanently in whatever state
  the schema default named, and could not say otherwise. `setToggles` writes it through the undo
  stack, and the toolbar reads the document's value rather than a component default.

## 20. The fill lock is arithmetic on fractions, applied last

SPEC 10 §8.5 gives the main video a cover lock: a drag may not expose empty canvas, and a scale
may not shrink below cover. `coverLock` had sat in the schema with no reader since it was
written, so every project was permanently in whatever state the default named.

- **Expressed in canvas fractions, not pixels.** `offsetX/Y` and `scale` are what the document
  stores; a rule in pixels would behave differently at preview zoom and could not be applied by
  the export, which has no screen. The clamp is closed-form — `|offset| <= (size − 1)/2` — because
  half a canvas of slop is *visible*, so there is no tolerance to tune and nothing to iterate.
- **Applied last, after snapping and spacing.** A snap that lands the picture on a guide while
  exposing canvas is exactly what the setting refuses, so the lock gets the final say over both.
  Clamping before them would have let a snap undo the clamp.
- **A negative limit means "no opinion", not "zero".** A picture narrower than the canvas cannot
  cover at any position; returning a limit anyway gives a lower bound above the upper one, the two
  clamps fight, and the clip lands somewhere arbitrary. The lock leaves it alone.
- **A scale is floored, not refused.** A handle that stops dead reads as broken; one that keeps
  tracking the pointer while the picture stops shrinking reads as a wall, which is what the
  setting is. The floor takes the *maximum* of the per-axis factors, because the axis needing the
  most magnification decides.
- **The extent is not `source × scale`.** The preview lays the picture out across the whole canvas
  width and magnifies the cropped region to fill it, so width is `scaleX` alone and height is
  `scaleY · canvasAspect / sourceAspect`. Getting this wrong in either direction is a rule that
  clamps the wrong clips: multiplying the crop in makes a punch-in look like it stopped covering,
  and ignoring the aspect makes a 16:9 clip in a 9:16 project — which letterboxes and can never
  cover — get clamped as though it did.
- **It governs the main video, by the document's own word.** A video on an overlay track is a
  picture-in-picture, and a full-frame graphic on the main track is still a graphic. The rule
  tests the item's type and its track's `role`, not the size of the frame it happens to fill.
- **Breaking 22 existing tests was the honest result.** Every one was a full-frame video dragged
  at scale 1, which the lock correctly pins. Those suites ask about snapping, stacking and
  Space+drag, so their fixtures opt out explicitly rather than the rule being weakened.

The same lesson as §19, one field later: a schema field with a default and no reader is not a
feature, it is a placeholder describing a feature. `coverLock` had a `Ctrl+L` in the spec, a chip
in the toolbar specified, and no code at all.

## 21. A command with tests and no caller is not a feature

`regenerateCaptions` and `syncCaptionsWithTranscript` were both implemented, both covered by
command tests, both imported into the editor hook — and neither was called by anything. The
`linkedToTranscript` toggle that should gate them had a schema default and no reader. The result
was a caption track that could only ever contain what the transcription job wrote: editing the
transcript changed nothing, and the spec's "Regenerate" had no button.

- **The missing piece was the grouping, not the wiring.** Both commands take pre-grouped
  segments or words; neither knows which words belong on one card. `caption-segments.ts` is that
  decision, out in a file with tests rather than inside an `onClick`, because it is editorial:
  sentence boundaries win where the transcript supplies them, a duration cap and a word cap
  carry the rest, and the packing is contiguous by construction so the output is legal on a
  caption track (§11 §3 forbids overlap) without a repair pass.
- **The gate lives in the hook, not in the button.** `linkedToTranscript` is a rule about the
  document: with it off, a caption track is independent text and nothing may overwrite it,
  whatever opened the command. A panel that forgot the check would be a second place to get the
  rule wrong — so the button is the affordance (disabled, and visibly why) and the hook is the
  rule.
- **No transcript means no command.** `regenerateCaptions` faithfully writes the segments it is
  given, so an empty list is not a no-op — it deletes every caption on the track. Refusing
  before the command is what keeps a project with no transcript from looking like a way to clear
  its captions.
- **Bad input is repaired where it crosses the boundary.** A word whose `endUs` predates its
  group, or a zero-width word, becomes a negative or empty duration, and the timeline refuses
  those: one such word would fail an otherwise correct regeneration. Both helpers clamp as they
  cross into command input, and both are tested for it rather than trusted.

The general lesson, now three slices running: **count the callers, not the tests.** These two
functions had tests that proved they worked and no code that proved anything used them. A grep
for the import found nothing; a grep for the *call* found the gap.

## 22. Half of auto-reframe is geometry, and that half is worth building

SPEC 13 §6.3's auto-reframe has two halves. Detection — sample the proxy at 5 fps, run a face or
saliency model — needs `onnxruntime-node` and a permissively licensed model in the installer.
The camera path that turns detections into keyframes needs neither, and §6.4 explicitly allows a
build without detection ("fall back to §6.4 and state it"). So detection stays unimplemented and
*stated in `limitations.md`*, and the camera is real.

- **The camera takes sample points, not frames.** Given "the subject was here at this instant",
  it produces keyframes. A future ONNX pass supplies the same sample points and gets the same
  camera, and §6.4's fallback — a static centre with the user's framing — is the same code with
  one sample. Building the detection side first would have made the camera a function of
  whatever that pass happened to emit.
- **The camera starts on the subject, and every later move is filtered.** The first tracked
  sample of a shot *places* the camera with no easing, because a cut is a new location and
  easing in from the canvas centre is a transition nobody asked for and the user cannot remove.
  Everything after it has a previous position to travel from and gets the dead-zone, the filter
  and the pan limit.
- **Smoothing is expressed against elapsed time, not per sample.** A per-sample constant makes
  the same slider position feel different at 5 fps and at 10 fps — a class of bug that never
  reproduces on the machine it was written on.
- **A gap in detection holds the aim, and says so.** Jumping to the centre and back is the most
  obvious way auto-reframe looks broken. The `tracked` flag survives into the output because the
  panel has to distinguish a held frame from a genuinely still subject, and equal numbers cannot
  make that distinction.
- **Both axes are simplified together.** Running RDP per axis doubles the keyframe count and
  puts the two out of step, so the path leans during a pan.
- **A surviving mutation is either a test gap or a dead branch — say which.** The dedupe guard
  in `capKeyframes` looked like a test gap; a proof over the index arithmetic showed the
  collision cannot occur while `allowed <= keys.length`. The guard was deleted and the argument
  written into the code. Confusing the two cases wastes the test you would have written.

The honest limit, recorded in `limitations.md`: with no detector, this is the camera the tools
will use rather than a working auto-reframe button. What it replaces is nothing — the module had
no counterpart at all — and what it makes possible is the review panel and the manual framing
fallback, both of which need only keyframes.

## 23. A reference is found by volume identity, not by path

SPEC 04 §4.1 records a "volume serial / drive label" next to a referenced import's absolute path,
and SPEC 03 §8's `media` table calls it `volumeId`. Nothing wrote it and nothing read it, so the
ordinary external-drive failure — the drive comes back as `E:` instead of `D:`, or mounts at
`/Volumes/Footage 1` because a stale copy is still mounted — left every clip missing with
nothing actually lost.

- **Identity and root are separate fields.** The identifier is what survives the move; the root
  is where it was mounted, and it is what a new path is rebuilt from. An identifier alone says
  "the right disk" without saying where on it the file sits, which is why recording one is what
  made the other usable.
- **`serial:` and `label:` are prefixed, deliberately.** A serial survives a remount at a new
  mount point; a label survives a re-lettered drive or a new machine. They are not
  interchangeable, and comparing one against the other must never match — a record stamped with
  a guessed identifier would tell the user their file was found and hand them someone else's clip.
- **Verify in cost order.** Size first, because a mismatch is proof; then the fingerprint, lazily,
  so a card full of same-named files is not hashed before it can be rejected. Same length is not
  the same file — that is the whole reason the fingerprint exists.
- **A distinct reason per outcome.** "Not mounted", "not found", "found and rejected" and "never
  told me the volume" lead to different user actions. Collapsing them into one "missing" sends
  the user looking through folders for a file whose drive is unplugged.
- **Managed media is never relocated.** Its bytes are in the library; a managed record that
  cannot be read is a damaged workspace, and pointing it at an external file would silently turn
  a managed asset into a reference.
- **The destination decides the separator.** Neither `relativeWithin` returning POSIX form nor a
  mismatched root may produce `/mnt/x\a\b.mp4`. This looks like a guard against a case that
  cannot occur — and for this pass it mostly is, because a record and the volume it returns on
  are the same platform — but "the destination decides" is the rule that stays true when a
  workspace is synced between machines, so it is the rule written down.

Two bugs the tests caught, both of which the type system would not have: the same string is a
valid path on two platforms and a broken one on the third, and a mount helper that stops one
directory too early matches a *different* drive. Path arithmetic is one of the few places where
the failure is silent and the output still looks like a path.

## 24. An icon is a shape whose geometry comes from a library

SPEC 11 §12 asks for the full Lucide set, offline, tintable, with adjustable stroke, size,
rotation and flip, and identical in preview and export. The obvious implementation — render
SVG markup — is the one that cannot work here: the preview paints a canvas and the export
writes ASS drawing commands, and neither takes markup. So the set is bundled as **data**, and
`iconGeometry` turns it into the `ShapeSubpath[]` in the 100×100 box that `shapes.ts` already
defines. That single decision is what makes the rest of the spec cheap: an icon is drawn by
`paintShape` and `assShapeDrawing` with no changes to either, because it is the same kind of
value a rectangle is.

- **Arcs are converted exactly, not flattened.** My first design refused any path containing
  an arc. Measured against the installed set, that dropped 28 of the 51 icons a picker would
  offer first — `star`, `triangle`, `user`, `heart`, `bell`, `mail` — and 994 of 1556 icons
  overall. Of the 1468 arc commands in the set, **1448 are circular** (`rx === ry`), and a
  quarter of a circle is exactly a KAPPA cubic: the same closed form `shapes.ts` already uses
  and calls its definition of a circle. So the conversion is not an approximation that lets
  the preview and the export disagree; it is the same arithmetic, computed once, in one
  place. The remaining **14 icons** use a genuinely elliptical arc and are refused by name.
- **`x-axis-rotation` is ignored when `rx === ry`, deliberately.** Rotating a circle leaves
  the same circle, and Lucide relies on that: `umbrella` writes `a10.06 10.06 1 0 0-20 0` and
  rounded rectangles write `a2 2 135 0 1 2-2`. Rejecting non-zero rotation refused a pile of
  perfectly circular arcs, and the gate and the parser now test the *same* condition —
  `rx !== ry` and nothing else — so they cannot disagree about which icons exist.
- **Both arc flags are honoured, and they interact.** `sweep` picks which of the two candidate
  centres, `largeArc` which of the two arcs between the endpoints. Honouring one and not the
  other still draws a smooth curve between the right endpoints — a plausible icon with one
  corner bent the wrong way, which is far harder to spot than a missing shape.
- **A large arc is several cubics; a quarter is one.** Both renderers get the same segment
  count from the same call. Measured: a semicircle is exact to 0.003 units on a radius of 10,
  and the last step lands on the destination *exactly* rather than on trigonometry's idea of
  it, because `Z` closes a subpath by joining the last point to the first.
- **The unit is the 100-box, and getting it wrong was the bug I nearly shipped.** Every
  element type originally emitted a 0–1 fraction. `shapeGeometry` draws a rectangle as
  `0…100`, `paintShape` divides by 100 to reach pixels and `assShapeDrawing` divides by 100 to
  reach script pixels, so an icon in fractions would have been a dot in the corner of its box
  — and the earlier version was worse still: `M`/`L`/`C` emitted raw 24-box units while arcs
  and primitives emitted converted ones, so a line-only icon drew 24× too large. The fix is
  structural: the parser works in Lucide's 24-box throughout, and one function converts the
  finished subpath on the way out.
- **The library is a committed asset, not a dependency.** `lucide-react` is 1556 ES modules of
  React components; importing it into a compositor used by the Electron main process would
  pull React into a build with no renderer. `/assets/icons/lucide.json` is 240 KB of data,
  generated by `scripts/generate-icons.mjs`, one icon per line so a diff names what changed —
  the same arrangement as `whisper-models.json`.
- **Only drawable icons are offered, but the full set is stored.** The picker lists the 1541
  names whose geometry converts; the 14 refusals remain in the data so a file that already
  uses them reports *"refused: elliptical arc"* rather than *"unknown icon"*. A tile that
  draws nothing when clicked is indistinguishable from a broken application.
- **`iconName` names, `iconShapes` is the escape hatch.** The normal case stores only the
  name, because the library ships with the build. Stored shapes win when both are present: a
  file that carries its geometry is stating what the icon *was*, and a newer build may have
  redrawn that name.
- **The exporter had to stop keying off `shapeKind`.** Its shape branch began
  `if (!item.shapeKind) continue`, so an icon item — which has no kind — would have burnt in
  as nothing, silently, in every render. The cue now carries resolved **geometry** instead of
  a kind, which is also what let the two renderers ask one question about whether an icon
  draws.
- **Refusing is a result, not an exception.** `iconGeometry` returns a reason (`arc`,
  `unknown-shape`, `empty`) and `resolveIconItem` adds `unknown` for a name this build does
  not have. A panel must not go down over a decorative asset, and a silent skip is the
  failure mode this project keeps having to remove.

**Reachability.** `iconName` had been in the schema since the beginning with nothing writing
it. This slice adds `addIcon` to the timeline API, an "Add icon" context-menu entry, and
`createIconItem`/`addShapeItem` in the engine — because a field in a schema, read by two
renderers, that no control can set is not a feature; it is the same decorative-field mistake
as `textContent` and `shapeKind` before it.

**Mutation-tested.** 14 mutations of the arc maths, the parser and the tokeniser, plus 5 of
the wiring (drawability check, `addIcon`, `paintShape`, `hasGraphicContent`, the planner's
field copy), all bite. Two did not on the first pass and neither was left as an untested
survivor: one required evaluating a branch the sign rule had already made unreachable, and it
was removed as dead rather than guarded; the other needed a test tightened from 12 decimal
places to exact equality, because trigonometry drifts by 1e-14 and the guard substitutes the
destination verbatim.

## 25. A drawing's coordinates are absolute, so `\pos` must be zero

The exporter emitted `\an7\pos(box.x, box.y)` and then wrote the drawing's coordinates in
absolute script pixels. Those two statements are not additive: libass *adds* `\pos` to a
drawing's coordinates, so the box origin was counted twice. A rectangle declared as the
centred middle half of a 1920×1080 frame (x 480…1440, y 270…810) burned in at x 960…1919,
y 540…1079 — offset by exactly its own origin, and half of it off the frame.

This went unnoticed because the unit test asserted the string `\pos(100,50)`: the bug was
written down as the expectation. It was found by rendering the script through ffmpeg and
locating the drawn pixels, which is the only way to see it — the ASS was well-formed and every
test passed while the picture was in the wrong corner. The fix is `\pos(0,0)`; measured
before and after, the same rectangle now lands at 480…1439 × 270…809.

The same investigation found a second, independent bug of the same family: `buildAssScript`
filtered its cues on `text` or `words`, and a shape cue has neither. Every rectangle and every
icon was dropped between `assCuesFromPlan`, which builds the geometry, and the script the
renderer consumes. All the existing shape tests asserted the *cue list* and none asserted the
script, so the drawing pass was dead code with green tests. Both are now pinned at the level
of observable output — a rendered script containing `\p1`, and a `\pos(0,0)` — and both
mutations bite.

**Lesson worth keeping:** a test that restates the implementation's string does not verify the
behaviour, it freezes it. Where an external renderer interprets the output, the check has to
run that renderer.

## 26. An icon is an outline, and its box is square

Two properties of a Lucide icon are easy to get wrong in a way that produces a picture rather
than an error, and both were wrong in the first version of this feature.

**It is a stroke, not a fill.** A Lucide path is the *outline* of a shape: filled, a star
outline becomes a solid pentagram and a gear becomes a disc — recognisable, wrong, and nothing
in the pipeline reports it. Shapes stay filled, because for a rectangle the fill *is* the
shape. The two renderers read one flag for this (`drawsAsOutline`) and one width conversion
(`iconStrokeInBox`, 24-box → 100-box → pixels), so they cannot disagree.

The ASS side needed measuring rather than reasoning. `\bord` strokes a drawing, and the
obvious way to hollow the fill — `\1c&HFF000000&` — does not work: ASS reads `\1c` as a colour
with no alpha, so the fill stayed opaque and a closed path rendered as one solid run **680 px**
wide. The correct override is `\1a&HFF&`, the alpha channel, which rendered the same path as
two crossings of **40 px** — a ring. Stroke widths then tracked the setting: 0.5 → 17 px,
2 → 63 px, 4 → 126 px on a 540 px icon.

**Its box is square.** `shapeBoxAt` returns a percentage of each axis, which is right for a
rectangle: 50%×50% of a 16:9 frame is 960×540 px. A Lucide icon is square by definition, so
drawing one into that box stretched it 16:9 — measured at aspect **1.668** on the rendered
star, against its own ~1.0. An icon now takes the shorter side of its box and is centred in
it, in both renderers. Shorter rather than longer so it never overflows the area the user
sized, and centred so a dragged icon stays where it was dragged.

**A test that reads the context after `restore()` reads the old value.** One of the icon tests
asserted `ctx.fillStyle` after `paintShape` returned, and passed only because the painter had
also been filling; after the switch to stroking it failed for the right reason and the wrong
one at once. The recorded-call assertions are the correct form.

**The lesson, again:** where an external renderer interprets output, the check has to run that
renderer. Three of the four bugs found in this slice — the dropped cues, the doubled `\pos`,
and the opaque "transparent" fill — are invisible to a unit test that only inspects the string
the code produced.

## 27. The icon picker paginates, and never shows an icon it cannot draw

**Pagination, chosen from a measurement.** The whole Lucide set converts from path data to
SVG strings in 57 ms and costs 504 KB — one page of 48 tiles is 16 KB of markup. That makes a
page cheap enough to render eagerly and makes virtualisation, with its scroll listeners and
its own bugs, the more expensive choice for a grid this small. The numbers decided it; they
are in `docs/verification.md` so the decision can be revisited if the set grows by an order of
magnitude.

**The grid contains only icons that draw.** The alternative — list all 1555 and mark the 14
arc-based ones unavailable — was rejected because a tile that cannot be clicked is a worse
answer than an absence: the picker exists to produce an item, and an item it cannot produce
has no business in the list. The filter is the same `resolveIconItem` the two renderers call,
so "can this be drawn" keeps one answer rather than three.

**The stroke width is part of the admission.** SPEC 11 §12 makes the width adjustable, and
the first version of this dialog computed it, passed it to the caller, and had it discarded
one layer later — the control looked live and changed nothing. The value now travels the
whole way: field → `onPick` → `addIcon` → `addShapeItem` → `createIconItem` → the item → the
ASS `\bord`. The general lesson is in §26 and holds here: a control is not built until
something downstream stores what it says, and the test that proves it has to sit on the far
side of the boundary the value has to cross.

## 28. A property is not built until something on the far side of the boundary reads it

Six audio properties — `gainDb`, `pan`, `fadeInUs`, `fadeOutUs`, `fadeCurve`, and before them
the volume keyframe line and `volumeId` — went through the same life: declared in the schema,
given a control in the inspector, saved in the project, and **never read by the thing that
consumes it**. Each looked finished. Each was one `.filter()`ed field short of a feature.

The pattern is worth naming because it recurred three times in this project and the fix was
the same each time:

1. **The type is not the contract.** `AudioItemRequest` declared `pan`, `gain`, `fadeInUs`
   and `muted` from the beginning. A declared, documented, typed field that no caller ever
   sets is a comment with a compile step — and TypeScript cannot object, because every field
   was optional, which is exactly what an optional field means.
2. **The fallback hides the absence.** `applyItemProcessing` wrote `params.pan ?? 0` to mean
   "no pan requested". It also meant "no pan was ever passed", and the two are
   indistinguishable from inside the mixer. A silent default is the right ergonomics for a
   caller that genuinely omits a value and the wrong one for a pipeline that forgot to supply
   it; nothing in the code can tell them apart, which is why the test has to sit downstream.
3. **Assert on the output, not the payload.** All three tests here render through the real
   mixer and read the WAV. A test asserting `request.pan === -0.8` would have passed against
   the broken build the moment the field was added and been wrong for the rest of the year.

**Sample the inputs where the bug and the fix disagree.** The pan test used −100, 0 and +100,
which all give the same answer whether or not the percent-to-unit division exists, so the
mutation survived. The interpolation test for the icon picker had the same defect in a
different costume: it searched for a term with one page, where a missing page reset is
unobservable. Both now sample where the two implementations differ, and both were found by
running the mutation rather than by reading the test.

**Do not forward what cannot arrive.** A `muted` branch in `planAudioItems` was written,
found unreachable (the plan already drops muted items from `hasAudio`), and deleted. An
untestable branch is not additional safety; it is a claim that something is handled.

## 29. The meter's arithmetic is a pure module, and the graph is a tap

Raised by SPEC 12 §6.3 (a stereo peak meter with peak hold and a latching clip light) and
`10 §3.2` (its place at the right of the transport).

**Split three ways because jsdom has no `AudioContext`.** Had the meter been one component
that created the graph and drew the bars, none of its real decisions could be tested — and
almost everything that goes wrong in a meter is a decision, not a pixel: whether the hold
decays to the floor or to the current level, whether the clip light clears itself, whether
the bar and its labels use the same scale. Those live in `audio-meter.ts` as pure functions
over a number, and eleven tests plus ten mutations pin them. The component only draws.

**The graph taps the element rather than modelling it.** One `MediaElementSource` on the
preview's `<video>`, split into two analysers, and the source connected straight to the
destination so the sound is unchanged. Measuring what the user hears is the only reading
that cannot drift from the file: a meter fed from the envelope would keep reporting a level
the speakers were not producing.

**The tap is created once, forever.** `createMediaElementSource` may be called only once per
element and *disconnects it from the default output* when it is created — so a graph that
forgot `source.connect(context.destination)` would make the preview silent, which is a
splendid way to break sound while adding an instrument that watches it. It is also why the
hook creates the graph lazily from a gesture rather than on mount: an `AudioContext` starts
suspended and `resume()` needs one.

**Not the whole spec, and said so.** Per-item gain automation, previewed pan and an
audio-mastered clock all want per-item nodes; this is one tap on one layer. Building the
meter first is not a compromise, it is the order that makes the rest checkable — once the
graph grows, the meter shows whether it works, instead of the change being judged by ear.

## 30. A shape row is one row, because an item has one geometry

Shapes and icons had no inspector control at all: a shape's kind and an icon's stroke width
could be set once, in the menu or the picker, and never changed. The fields were in the schema,
the renderers drew them, the exporter wrote them — and `setItemProperties` could not write
either, so the gap was in the command before it was in the UI.

**The row asks what the item is rather than offering everything.** A shape has a `shapeKind`,
an icon has an `iconName`, and the schema treats those as alternatives. Rendering both controls
with the irrelevant one disabled would be worse than the gap it replaced: a control the user
can see and cannot use reads as a bug, and a control that appears to work while writing a field
the renderers ignore is the exact class of bug this project has spent several slices removing
(`docs/decisions.md` §28).

**The command enforces the same exclusivity the type does.** `addShapeItem` already refuses an
item given both a kind and a name; `setItemProperties` now refuses to add a kind to an icon.
Both refusals exist because two sources of geometry leave the preview and the exporter free to
choose differently, and a file that renders one way in the editor and another in the export is
the failure this whole project is arranged against.

**Labels are derived from the kind.** `shapeKindLabel` turns `round-rect` into `Round rect`
rather than consulting a table, so the list of kinds and the list of labels cannot drift. The
alternative — a hand-written `SHAPE_LABELS` map — is one more place to forget when a shape is
added, and it fails silently: the menu shows `hexagon-hollow` and nobody notices until a user
does.

**What is still not editable, and why it is a smaller gap.** Re-picking the *icon* on an
existing item still means deleting it, because the picker is an "add" flow. Making it an edit
flow needs the picker to take an existing item id, which is a change to the picker's contract
rather than another field on this command — so it is recorded as the one remaining gap rather
than half-built here.

## 31. The picker becomes an edit dialog by getting the caller it never had

`IconPicker` declared `value?: string` and `strokeWidth?: number` from the moment it was
written, and neither was ever passed. That is worth pausing on: the props were not speculative
— the component highlighted `name === value` in its grid and seeded its width field from
`strokeWidth` — so the code was correct and unreachable. A prop with no caller is a feature
that exists only in the type, the same shape as the schema fields in §28, and it fails the
same way: nothing errors, nothing looks wrong, and the capability is simply absent.

**Why it had no caller.** The picker was built for the timeline menu, which *adds an item*: it
has no current icon to highlight and no current width to show. The selection UI was written for
the caller that was going to come later. When it did not come, the "add" flow became the only
flow, and changing an icon meant deleting the item — losing its timing, its track position and
its undo history — and adding a new one in its place.

**Binding it to an item is three lines of wiring.** The inspector holds the id of the item
being re-picked, passes that item's `iconName` and `iconStrokeWidth` to the dialog, and writes
both back through `setItemProperties` on a pick. The id is held rather than a boolean because
the selection can change under an open dialog, and a pick would then land on whatever happened
to be selected instead of the item the user opened.

**The name change clears the stored geometry.** `iconShapes` exists so a project opened by a
build with a different Lucide set still draws what it drew. It belongs to the icon it was
stored for: keeping a star's paths on an item now named `heart` draws the star while the picker
marks the heart selected. The command clears them, and a test asserts it — because the failure
would be a picture that disagrees with its own control, which is the recurring failure in this
feature and the reason every step of it is measured rather than inspected.

## 32. A brand kit is a recipe for ordinary commands

SPEC 13 §8 lists brand kits as CORE for v1. What existed was `brandKits: z.array(z.string())`
in the project schema and an empty `BrandKits/` directory — a declared capability with nothing
behind it, which is the failure mode this project has now documented three times (§28, §31).

**The kit produces no new kind of object.** Applying one yields an image item on a graphics
track, a clip inserted at the start, a `captionStyleId` — all things the app already draws,
exports and edits. Nothing downstream learns the word "brand kit". That is not tidiness: it is
what makes the spec's own rules fall out for free. *Deleting a kit leaves applied items
untouched* is true because they are ordinary items; *reapplying replaces* works because the
provenance tag on the item is enough to find them; *a kit applied to a project carries no new
load paths* because there are none.

**The module returns a plan rather than doing anything.** `planKitApplication` takes a kit, a
canvas size, a duration and what the project has, and returns what *would* be created plus a
list of what it could not do. The caller runs the commands. This is what makes the interesting
decisions testable without a store, a canvas or an ffmpeg binary — and the decisions are the
whole feature: where the logo lands, when it appears, and what the user is told when an asset
is missing.

**Percentages, with the short side for corners.** A kit is designed for one aspect ratio and
applied to another; the spec asks for exactly that and says "positions are percentages, so
adapt". Corners therefore use the short side for both the margin and the size, so a logo is
the same apparent size and the same distance from the edge on 16:9 and 9:16. `custom`
placements use the stored percentages against each axis instead, because a point the user
dragged to means a fraction of the frame, not a distance from an edge — two different
intentions that a single formula would conflate.

**Nothing is applied silently, and an unchecked part is not a failure.** A missing asset or
style produces a sentence; a part the user turned off produces nothing, because reporting a
problem with something they did not ask for is noise. Both rules have a test, and both exist
because the alternative — a kit that applies four of its six parts in silence — leaves a user
hunting for a logo that was never placed.

**The UI is deliberately absent.** No screen mentions brand kits yet. An unfinished CORE tool
that appears as a card, a disabled menu entry or a "coming soon" chip is forbidden by
`specs/13` §2, and the format being ready is not the same as the feature being usable.

## 33. A brand kit is applied by composing existing commands, and provenance lives on the item

**The command layer is a separate module that calls `commands.ts`'s pieces, not a new branch
inside it.** `applyBrandKit` builds its items with `createMediaItem` and writes
`captionStyleId` the way the inspector does; `removeKitItems` is an ordinary delete. Keeping
the composition in `kit-commands.ts` means the timeline's rules — track ordering, the item
factory's full transform, the locked-track rule — are reused rather than restated, and the
file that does restate them is a page long instead of a branch buried in four thousand lines.

**Provenance is a field on the item, keyed by kit and by the moment of application.**
`aiProvenance: {tool: 'brand-kit', kitId, appliedAt, version}`. On the item because the item is
what survives a save, a duplicate and a copy between projects — a side table would have to be
migrated, reconciled and would lose entries the moment a project was edited by a version that
did not know the table existed. The schema already had `aiProvenance` for AI edits, so a kit
application is the same kind of fact: something a tool made, that the user can detach. `kitId`
alone is not enough, because reapplying the *same* kit must be able to tell the new items from
the old ones, and `appliedAt` is how the command reports what the current application created
without a second pass over a diff.

**Locked tracks are skipped, not refused.** Applying a kit to a project with a locked caption
track writes the other captions and the logo. Refusing the whole application because one track
was locked would be a straight-faced version of "the button did nothing", and the user's lock
is a statement about that track, not a veto over the kit.

**Detach is one-way on purpose.** It clears the tag and keeps the items, so a later reapply
leaves them alone and adds its own. The alternative — a detached item staying in a hidden
registry so reapply could still find it — would make "this is mine now" untrue, which is the
entire content of the command. The UI that arrives with this will confirm it, because it is
the only kit operation that applying the kit again cannot undo.

**An empty plan fails.** If every part is off, or every asset is missing, the command returns
`invalid` rather than succeeding with no patches. A success with nothing to show is
indistinguishable from a broken button, and the plan's `report` already carries the reason.

## 34. An intro/outro is inserted with a full-track ripple, not dropped on a gap

**Insert mode's rule, borrowed rather than restated.** SPEC 09 §13.2 already defines what
happens when a clip is inserted into an occupied span: items at or after the point shift right
by its duration. An intro is exactly that case at time 0, and an outro is its mirror at the
composition's end — so the kit command follows the rule the editor's own Insert mode follows,
instead of inventing a "kit placement" with its own semantics for the same gesture.

**Every unlocked track ripples, and that is the decision worth defending.** The obvious
implementation moves the track the clip lands on. But an intro plays alone at the start: if
only the main track moves, every caption, title, logo and music bed now sits two seconds
earlier against the picture. Rippling the tracks the clip does not occupy is the only reading
that leaves the *edit* intact, and "insert an intro" is a statement about the edit, not about a
track. A locked track is skipped rather than refusing the operation, consistent with every
other kit command — the user's lock is about that track, and a kit that cannot apply anywhere
because one track is locked is a kit that appears broken.

**An outro never ripples.** It is appended after `compositionEndUs`; moving things right of a
point at the very end would move nothing, and writing a ripple there would be code that only
looks symmetrical. The command takes `compositionEndUs` from the caller rather than deriving
it, because "where the project ends" is a query over tracks with their own rules about hidden
and disabled items (SPEC 09 §3) and belongs in `selectors.ts`, not here.

**A missing main track is created, magnetic.** Applying a kit to an empty composition is a
legitimate first action, and a main track's purpose is to stay closed up when clips are
inserted — which is precisely what the intro just did.

**A template intro is planned and then refused.** The plan carries a `compositionTemplateId`
so a caller that can build a composition from a template has what it needs. The command cannot,
and returns `invalid` with a sentence rather than placing a media-less clip that would draw
nothing and be selectable — the failure mode the rest of this feature exists to avoid.

## 35. Safe areas move corner graphics additively, and never `custom` placements

**The inset is added to the margin rather than replacing it.** `margin` is the user's own
distance from the edge; the platform band is where its chrome begins. Honouring one alone
gives the wrong answer at both extremes — flush against the safe area, or under the buttons —
and the sum is the only position that satisfies both. The box's size is still subtracted
afterwards, so it is the box that ends up inside the band, not its top-left corner.

**Only corners move.** `custom` is a point the user dragged to; the two axes are fractions of
the frame, not distances from an edge, and the whole reason `custom` is resolved differently
from a corner is that it means a different intention. Moving it because a preset was set
would be overriding the one placement in the schema that is unambiguously deliberate.

**Landscape gets no bands at all.** The numbers describe vertical chrome. A 16:9 frame has no
top header and no right-hand action column, so applying them would move a correct logo for no
reason. `safeAreaBandsFor` returns `undefined` rather than zeroes, so a caller cannot
accidentally treat "none" as a set of real numbers.

**The bands are copied into the package and pinned by a test.** Importing
`assets/safe-areas.json` would make a pure geometry package depend on the app's bundle, and it
would couple a *guide* — tuned for legibility, changed without a release — to the placement of
every logo a user has ever applied. A copy is the honest structure; the test that reads the JSON
and compares each number is what stops the copy rotting.

**Mutations are not a pass/fail score.** Seven were run here; six bite and one is an
*equivalent mutant* (the `none` guard is unreachable because the record has no `none` key).
Both outcomes were recorded. A suite that reported "7/7 killed" would have needed a contrived
test for the equivalent one, and a suite that reported "6/7" without saying why would look
weaker than it is.

## 36. `.cwbrand` is a hand-written zip, tested against a real `unzip`

**The container is written by hand rather than pulled in as a dependency.** This repository
vendors deliberately; a zip container is three local headers, a central directory and an end
record, and the subset a kit needs is the simplest part of the format. The alternative was
shelling out to `zip`, which does not exist on a Windows machine — and this app ships for
Windows. A dependency for forty lines, in a package that is otherwise `zod` and pure functions,
was the worse trade.

**The reader is written against the format, and the tests use `unzip`.** The trap in a
first-party archive format is a writer and reader that agree with each other and with nothing
else: they round-trip perfectly and produce a file no other tool can open. So the tests list the
archive with `unzip -Z1`, extract it with `unzip -qq` and compare the payload bytes, and verify
a flipped byte makes `unzip -t` fail — the last of which is the only thing that proves the CRC is
computed rather than zeroed. A deflated archive produced by `zip` must also read back, because a
kit can arrive from elsewhere.

**Entries are stored; reads accept deflate.** PNGs are already compressed and the payload is
small, so compression buys little and costs a deflate round trip that can fail. Reads go through
`DecompressionStream`, which every runtime this app targets provides, rather than a bundled
inflater that would be the largest and least testable code in the package.

**Assets are named by id, and their extension comes from their bytes.** The kit's JSON names
`logo-1`; the archive holds `logo-1.png`, because a user who opens the zip expects a file they
can look at. The extension is sniffed from the signature rather than the id, so an id containing
dots cannot produce a misleading name, and an unknown type becomes `.bin` instead of being
refused — a font is still worth carrying.

**A missing asset does not stop the export or the import.** Both sides report `missingAssets`
and carry on. A `.cwbrand` that refuses to be created because one logo vanished is worse than
one that says which file is absent, and a kit whose logo is missing can still be opened, edited
and applied.

## 37. A test that needs a tool says so, and skips with a reason

**`unzip` is not assumed; it is checked.** The archive's central tests open the file with a
real implementation, because a writer and reader that agree only with each other ship an
unreadable file that round-trips perfectly. But CI runs on Windows, where `unzip` ships with
Git and `zip` does not exist — and the first version of this suite failed a green branch with
`spawnSync zip ENOENT`. That is an environment difference, not a defect, and a test that fails
for one gets deleted by the next person who hits it, taking the coverage with it.

**So each binary-dependent test names its tool and skips without it** (`it.skipIf(!HAS_UNZIP)`),
and the deflated-read path — the one thing only a foreign archive can prove — is built in code
from Node's `zlib` plus raw zip headers instead of by running `zip`. That keeps the compressed
path covered on every platform, leaves the third-implementation check running where it can, and
makes the skip honest: 6 tests skip on a machine with neither tool, and the reason is written
next to them rather than inferred from a build log.

**A fixture should not share code with the thing under test.** `buildDeflatedArchive` duplicates
the header writing on purpose. The overlap is a dozen lines; the alternative is a reader tested
only against the writer's own bugs, which is the failure this whole file exists to avoid.

## 38. Capture reads facts and reports judgements; it never invents a look

**The split is between what is in the project and what only the user knows.** A caption's
style id, a fill colour, a font family and an image's media id are *facts* — they are written
down. Which of six corners a top-left item "means", what fraction of the short side it occupies,
and whether it should show for the whole clip are *judgements*. `captureKitFromClip` reads the
first and reports the second, and every place it cannot decide produces a sentence rather than a
default. A kit captured with an invented palette looks finished and is not; one with black and
white and a note reading "the captions on this clip use no style" is a kit the user knows they
are about to edit.

**Geometry is measured back into percentages, not pixels.** This is the difference between a kit
captured from a 16:9 clip and a kit that only works on that clip. An image 4% in from the right
of a 1920-wide frame becomes `margin: 4`, which `resolvePlacement` re-applies against whatever
canvas the kit lands on. The same reasoning already governs the placement maths; the capture
side is the inverse and had to be written as one, because a round trip through pixel values would
lose the percentages the whole feature is built on.

**A corner is the outer third of both axes, and the middle of the frame is never one.** Without
that rule a portrait sitting in the centre of the frame becomes the kit's logo, and every clip
the kit is applied to gets a face in the corner. The rule is deliberately stated as a band rather
than "nearest corner", because *every* point is nearest some corner — the band is what makes the
answer "none" possible.

**Colours and fonts come from the resolved style, because they can, and only then.** The caller
passes the style in — this package does not depend on the caption-style library to read four
colours — and the mapping is by meaning: fill is the text, highlight is the accent, background is
the background. The two slots a style has no counterpart for (`primary`, `secondary`) take the
text colour rather than a colour derived from an outline, and the font crosses over **without its
size**, because size belongs to the style and a captured size would fight it.

**A capture never validates silently: it round-trips.** The test feeds `captureKitFromClip`'s
output through `tryParseBrandKit` and `exportBrandKit`, because a captured kit goes into an
editor and then into a `.cwbrand` file — and a capture that produced kits which fail to validate
or lose fields on export would be a feature that only looks finished.

## 39. The kit panel applies through `timeline.run`, and composes four commands into one undo

**Nothing in the panel touches timeline state.** Every action returns a `CommandResult` and
goes through `timeline.run`, which is the one writer — so an application is undoable, the
autosave sees it, and the notes surface the way they do for a trim or a delete. A panel that
called `applyBrandKit` and set state itself would work perfectly until the first Ctrl+Z.

**Four commands become one history entry.** An application with an intro and an outro is
graphics, captions, a start insert and an end append: four commands, each with its own patches.
`run` takes one, so the panel composes them into a closure that rebuilds a patch set from the
before-and-after states. The patches are deliberately coarse — whole `items` and `tracks`
arrays rather than a minimal diff — because the history needs enough to undo and redo, not a
diff algorithm, and a minimal diff is a second thing that can be wrong.

**Both directions are tested, because only testing undo hides half of it.** The first patch set
this produced undid correctly and redid to the state the project was already in, since a
patch containing *before* values is indistinguishable from one containing *after* values until
replay runs the wrong way. The test now applies the inverse and then the patches and asserts the
logo is back.

**The Apply button asks the plan, not the kit.** `canApply` plans the application and asks
whether any part survived. A button enabled on "the kit has a logo" lights up for a kit whose
logo is not in this project, and then either does nothing or, worse, does something partial
without having warned.

**`settings` rather than a new table.** Kits live in the project record's settings under one
key, exactly as the caption-style copies do: `settings` is `passthrough`, so the project format
did not change, and a kit is data that belongs to the project it was made for. A malformed entry
is dropped rather than throwing, and the map's key wins over the object's `id` — because the key
is what every caller looks a kit up with, and an object whose id drifted would otherwise be
found under one name and report another.

## 40. The kit form holds a draft, and a switched-on part with nothing chosen is an error

**A `BrandKit` cannot be a form's state.** The schema requires a logo to have an asset id and a
placement to have six numbers; a user is entitled to be halfway through choosing them, and a form
that could only hold valid values would have to invent defaults the user never picked. So the form
holds a `KitDraft` — strings and switches — and `draftToKit` is the one boundary. Everything
interesting about the form is then a pure function, testable without a DOM.

**Every problem is reported at once.** A form that fails one field per press of Save makes the
user play a guessing game; the checks append rather than return, and the test asserts three
problems arriving together.

**A part switched on with nothing chosen is a problem, not an omission.** The user said they
wanted a logo. A kit that quietly left it out would apply everything *except* the thing they
turned on, and the plan would say nothing because the kit genuinely has no logo. The message
names both halves so the fix is obvious. A part switched *off* is different: no key, no
complaint — the checkpoint is a statement of intent, and the absence of an intent is not an error.

**The schema is the last word.** The form's checks exist to produce messages about controls; the
schema catches what they miss. When the two overlap the form's message wins, because "Number must
be greater than or equal to 0.1" at path `intro.durationSec` is not a sentence about a field the
user can see. The custom-colour cap says 8 in both places, and deleting the form's copy changed
nothing — an equivalent mutant, recorded as such.

**The form has four corners, and a `custom` placement is a real limit.** Opening a kit whose logo
used a dragged point shows the nearest corner; saving keeps the size and margin but not the point.
The alternative is a form that silently rewrites a field it never displayed — worse, because the
user would have no way to know. It is in `limitations.md` with the other unfinished parts of §8.

**The dialogs are one element rendered by both branches of the panel.** The first draft returned
early when a project had no kits, which made "New kit" — on the only screen such a project has —
open nothing. A test that pressed the button found it; a screenshot would not have.

**Kit colours are data, not design tokens.** The renderer's token lint refuses hex values in UI
files, and it is right: a kit's colours come from a file and are the user's. They live in
`packages/brand-kits` as `DEFAULT_KIT_COLOURS`, shared by the form's starting palette and by a
capture that had no style to read — so the two cannot disagree about what "no colours yet" means.

## 41. A missing font is substituted by character, and the sentence names both families

**Both halves of "substitute and flag" are load-bearing.** Refusing a kit because one family is
absent makes a shared `.cwbrand` unusable on most machines; substituting silently puts a caption
in the wrong typeface with nothing to explain it, and the user reasonably concludes the kit was
ignored. So `substituteFont` returns a usable `FontRef` *and* a warning naming what was asked for
and what was used — the second name is what lets a user decide whether the result is acceptable
or ask for a different replacement.

**The substitute is chosen by character, not by name.** A kit asking for Playfair Display that
falls back to Inter is a serif poster turned into a modern sans: a different design rather than a
substitute. The bundled families carry a coarse attribute — sans, serif, condensed, display,
script, mono — and the preference list picks within it. The taxonomy is deliberately coarse: a
finer one (grotesque against humanist, didone against transitional) would claim a precision
nobody measured, and the substitute only has to keep the *character* of the type.

**An unknown family is treated as a sans, and the warning is unchanged.** Nothing describes it, so
the commonest caption character is used; the sentence still names the family the user asked for,
because that name is the only thing that lets them act.

**A present family's weight is rounded without a warning.** SPEC 11 §10.1 says the nearest weight
is used; it is a normal condition, not a fault, and a warning on every apply would train users to
ignore the warning that matters. But it must be a weight the family *has*: a canvas font string
asking for 900 on a family that ships 700 is silently replaced by the browser, and the result is
not what the kit said. Ties go to the heavier weight, because a caption set at 700 is meant to
look bold and rounding it down looks like a mistake.

**The warnings are deduplicated.** A kit naming one missing family in all three slots produces one
banner. Three identical sentences is the kind of noise users learn to scroll past, which costs the
warning its whole purpose.

**Two guards against false alarms.** A caller with no font catalogue gets no check rather than one
invented from an empty list, and fonts belong to the `textDefaults` part, so an apply that
switches text defaults off says nothing about fonts.

## 42. Main owns both the dialog and the asset read; the renderer names ids and nothing else

**The archive cannot be built in the renderer, and the first draft proved it.** Export needs the
bytes of every logo and intro a kit references. A media id is not a path, and no call on the bridge
returns bytes for one — deliberately, since the media layer is the main process's. The draft that
passed `{assetId, data}` down from the panel was abandoned rather than given a new renderer-facing
"read any file" call, because that call is the one thing the whole bridge design refuses to have.

**So `brandKit:export` takes the kit, `brandKit:import` returns one, and no path crosses.** Main
shows the dialog, reads each asset through `storage.getMedia(id).path`, writes the archive, and on
import does the reverse and encodes the assets as base64. The renderer never learns where a file
lives, which keeps the trust boundary where the rest of the app already puts it: a compromised
renderer can name a kit, not a directory.

**The dialog comes before the work.** Building the archive first would read every asset off disk
for a user who then cancels — and a malformed kit would raise an error before they had chosen a
destination at all. Ask, then do.

**A missing asset is reported, not thrown.** `fetchAsset` yields `undefined` for a record that is
gone or a file that will not open, the archive lists the id in `missingAssets`, and the panel names
the assets it left out. Throwing would make one unplugged drive stop an export that is otherwise
complete; saying nothing would hand the recipient a kit that references a picture it does not
contain.

**The extension is normalised in main, not trusted from the dialog.** Electron returns the typed
name unchanged, so a user typing `Studio` would get a file that no machine offers to open. Main
appends `.cwbrand` unless it is already there — a small thing that is the difference between a file
that works on the colleague's machine and one that has to be renamed by hand.

**Importing is an add, so a colliding id is re-minted.** Overwriting would silently move every item
the existing kit had applied to the new one's provenance, and the provenance is what delete,
reapply and the "comes from" label all key on. The imported kit becomes `<name>-imported` through
the same `mintKitId` the form uses, so there is one naming rule rather than two.

**Import lives in the empty state too.** A project with no kits is the one that most needs an
import, and the panel's first draft put the button only above the cards — the same shape of bug as
the shared editor dialog, and recorded for the same reason.

## 43. A batch is planned whole before it writes, and the open clip keeps its own undo

**The other clips are documents this window never loaded, and that decides everything.** Their
lengths cannot be measured with `projectDurationUs`, because that function needs the whole
document and the document is not here. So a duration is **projected** from the media each item
names, and projected *long*: an intro's footer shifts everything after it, so an outro that lands
slightly after the content is a small bug, while one on top of the first frame is a broken clip.
The next editor re-plans with the real duration; this figure only has to place the item.

**Only the ids this window can see are offered to the plan.** A foreign clip's payload names
media that may not be in this window's library. Claiming an id is present because another project
once had it would place a graphic the next editor cannot find — which is exactly what the plan's
`report` exists to prevent, so the honest answer is to offer nothing and let it say so.

**Nothing is written until every clip has been planned.** `applyKitToClips` does no I/O, so
all-or-nothing is a property of its shape rather than a promise in a comment. A half-applied
batch across five clips is the one outcome a user cannot unpick by hand. This is why the
template-intro refusal has to abort: it is a real "I cannot do this" from the engine, and
treating it as "nothing to do" would leave one clip without its intro while the batch reported
success.

**One application, two undo routes — and the split is the feature.** The open clip goes through
`timeline.run`, so `Ctrl+Z` undoes it like any other edit. The other clips have no history here;
theirs belongs to whichever editor opens them next. So the batch records every other clip's
previous payload and offers "Undo batch". Putting the open clip in that record too would make one
press undo half of one application, and the half that remained would look like a ghost edit.

**A successful command that changed nothing is not an application.** `applyBrandKit` returns a
new state object whether or not it edited anything; counting that as applied told every
captionless clip it had been branded. The check is identity against the input state, not the
command's `ok`.

**"All clips" was a sentence, not a behaviour, for three slices.** The scope control existed and
the button ignored it. That is worth recording as a pattern: a control that renders correctly and
changes nothing is invisible to every test that checks rendering, and the fix was to make the
control's *effect* the subject of a test — the id of the clip that got written.

## 44. Loudness is measured before the log, and a partial gate says so

**A peak meter and a loudness meter answer different questions and the transport needs both.** A
peak says "will this clip?"; a loudness says "how loud does this sit?". A quiet mix with one door
slam clips, and a mix with no peaks at all can be ten LU too quiet for a platform. The popover
shows them together for exactly that reason — the pair teaches the distinction that either alone
would hide.

**BS.1770 anchors a full-scale 1 kHz sine at −3.01 LUFS, not 0.** A sine's mean square is half its
peak square and the K-weighting shelf adds back about 0.7 dB. Anyone whose intuition says 0 will
"fix" the arithmetic until it reads 0, and then every reading is 3 LU loud — which is how a clip
normalised to −16 arrives at −13. The anchor is therefore asserted at the standard's value,
hundredth included.

**The average is taken before the log.** Two frames at equal duration average to half the energy —
3 LU down — and to about 30 LU down if you average their decibels. Speech is syllables and gaps,
so averaging decibels makes every voice-over read too quiet, and no test that measures a steady
tone can see it.

**An analyser window is a ninth of the gate, so the gate is assembled.** 2048 samples is ~43 ms
against the standard's 400 ms. The window is rolled forward each frame and the reading reports how
much of it is real — and the popover says "filling the 400 ms average" only while that is true. A
permanent caveat reads as a broken meter; no caveat lets someone normalise against a number that
is still climbing.

**Two quantities that look comparable and are not.** `complete` compared a frame's *sample* count
against the gate's *millisecond* length, so every reading claimed finality after 400 samples. The
lesson is the same one the timeline's half-open ranges teach: a count and a duration have to be
brought into the same unit by the sample rate, explicitly, not by a constant that happens to be
near both.

**Silence and "nothing measured yet" are the same number and different facts.** Both are the
floor, so the reading carries `samples` and `complete` rather than leaving a caller to infer it,
and the popover prints "No audio yet" or "Silence". The floor exists at all because a fade
approaching silence measures −80, −120, −200 LUFS — real numbers, meaningless ones, and a readout
that prints −200 is reporting arithmetic rather than sound.

**The clip light stops its own click.** The meter is the popover's toggle, and the clip light is a
button inside it; without `stopPropagation` one click would clear the light *and* open a panel.
That is the second time in this project a nested control has needed saying out loud, which is
worth recording as a pattern rather than an isolated fix.

## 45. "Where supported" means the control is absent, and Esc is never an error

**The eyedropper is a Chromium API and the picker is shared.** `EyeDropper` exists in Electron —
the app's shipping renderer — and nowhere else. So the picker asks the environment and omits the
button where the answer is no, rather than drawing it disabled: a disabled control is a promise
the feature works somewhere, and per SPEC 13's rule about teasers the same reasoning applies to a
control that can *never* work on that surface.

**Four outcomes, three of them silent.** `picked` sets the colour. `unsupported` says nothing,
because no button was drawn. `cancelled` — Esc — says **nothing at all**, because a red message on
every Esc trains a user to distrust a control that is working exactly as asked. Only `failed` gets
a sentence, and it is the API's own: a blocked screen capture is something the user can act on.

**Both abort shapes are checked.** Chromium has reported the Esc cancellation as `AbortError` and,
in some builds, only through a message. A cancellation that surfaced as a failure would be a bug
nobody could reproduce on demand — it depends on remembering exactly what the cursor was over.

**A non-colour result is a failure, not a cancellation.** The user did pick something; telling
them nothing happened sends them back to the same spot.

**The hex box owns a draft, because its caller validates.** A caption style's schema refuses a
partial hex, so every keystroke on the way to `#FF7A00` is rejected upstream. A box that rendered
from `value` would erase each character as it was typed. The draft is the control's, and it
re-syncs when `value` changes from elsewhere so a swatch or a pick still appears in the text.

**Recency is ordering, not membership.** Re-picking a colour moves it to the front rather than
adding a duplicate — a duplicate would push genuinely older colours out first and leave the strip
shorter than its own limit for no visible reason. And nothing half-typed enters, because the field
commits per keystroke and six slots would otherwise be mostly `#F`, `#FF`, `#FF7`.

**The style editor had its own copy of the colour row.** That duplication is *why* it was the one
screen apologising for having no eyedropper: the shared picker existed and this screen did not
use it. Two implementations of one control is the same failure shape as two implementations of a
volume envelope, and the fix is the same one — delete the second.

**A test file that ran nowhere.** The root vitest config collected `packages/**/*.test.ts` but
`apps/**/*.test.tsx`, so a React test in a *package* was never run and the suite still reported
green. The design system owns components, so this was a hole rather than an accident. Adding the
missing pattern immediately failed two existing style-editor tests, which is the argument for the
pattern: the hole had been hiding a label rename the shared control introduced.

## 46. The preview builds a node per item, because the unit that has a gain curve is an item

**One absence, three symptoms.** The preview had no Web Audio graph, so its sound was whatever one
`<video>` element played. That single fact explained three unrelated-looking problems: an audio
item was silent in the editor and present in the export; pan was stored, drawn, mixed and never
heard; and the master meter — built on a tap of that element — measured the bottom picture layer
and reported it as the mix. Three fixes would have been three chances to disagree with the export.
One graph fixes all three, which is the whole argument for doing them together.

**Per item, not per track.** A track is the unit a user mutes; an item is the unit that owns a
volume envelope and a pan. A per-track chain would be cheaper and would lose every keyframe, and a
per-track *plus* per-item chain is what the export's `planAudioItems` already is. The preview
follows the export here rather than inventing a cheaper shape that would sound subtly different.

**Item-local keyframe times, deliberately the opposite of the export.** `planAudioItems` shifts a
clip's keyframes into mix time because it decodes a bounded range and evaluates one clock. The
preview evaluates each item against its own start. The asymmetry is not an oversight — the export
is answering "where is this in the file", the preview "where is this in the clip" — and it is
commented at the point of divergence so a later reader does not "fix" one into the other.

**The graph asks the plan, and the plan is pure.** `previewAudioRequests` answers what should play,
with what gain and where in the stereo field, in `audio-core` with no Web Audio in sight. That is
what lets the interesting rules be tested in a plain Node test: a muted item is **not requested**
rather than requested at zero gain (a zeroed node still decodes); a **hidden** track is still
requested (hiding is a view concern and the export ignores it); solo is answered once for the
document; an absent `gainDb` stays absent rather than becoming 0 dB, because "no opinion" and
"unity" are different facts when a fallback is what consumes them.

**A one-point curve is a constant, and that was a real bug.** `gainCurveFor(request, 1)` evaluates
the envelope at the clip's start. Applying that per frame would have played every fade and every
keyframe at its opening value — a preview that looks exactly like the feature was never built, with
nothing in a log to say otherwise. The per-frame path needed `gainAtInstant`, and it survives
because one test asserts two different instants of one fade give two different values.

**Clamp the end, never the start.** `gainAt` already returns 0 outside an item's span. Clamping the
instant into the span turns "this clip has not started" into "this clip is at its opening gain" —
a bed leaking into the seconds before it begins, which sounds like a mix error rather than a
boundary bug. Sampling also stays strictly inside the span, because `gainAt` is 0 at
`start + duration` and a curve that samples the boundary ends every clip with a one-sample click.

**`setTargetAtTime`, never `gain.value`, never `setValueCurveAtTime`.** Assigning `gain.value` every
frame is a discontinuity every frame: a rasp on every fade, and a click on every static clip. A
scheduled curve is worse — it throws when it overlaps an already-scheduled range, and this graph
re-plans on every timeline edit, so the throw would arrive from a user's keystroke. Short time
constants keep the value following the envelope without either failure.

**Elements are pooled, because the binding is forever.** `createMediaElementSource` may be called
once per element, ever — a second call throws. So elements live in a ref keyed by item and are
*reused* across renders, seeks and source changes; the chain is re-planned, never rebuilt. The
`catch` around node creation exists for the environments that refuse, and it is exactly why the
tests use a fake that **throws on the second call**: an implementation that rebuilt would swallow
its own exception and go quiet, and "how many sources did it create" cannot see that because the
throw comes first.

**Muting is a pause, not a teardown.** The binding cannot be undone, so a teardown would leave the
element permanently unplayable through the graph. Zeroing the bus is not enough either: the
elements would keep decoding and drift away from the playhead, so unmuting would resume from the
wrong place. Muting pauses every element and keeps the graph, and a test asserts the graph survives
a mute–unmute round trip without a second `createMediaElementSource`.

**The `<video>` is silenced once the graph is ready, and the meter moved to the bus.** Leaving the
element audible plays every clip twice a frame apart. The meter, meanwhile, had built its own
context and its own source on that element; it now accepts the graph's context and node when one
exists, because an `AnalyserNode` can only connect within its own context, and keeps the element
tap as the fallback for an environment with no Web Audio. That fallback is the old limitation, and
the hook says so where it falls back rather than pretending the two taps measure the same thing.

**Two test fixtures that had to be fixed before they could fail.** An end-boundary test used an
unfaded item, where the opening and closing gains are both 1 — clamping and not clamping give the
same number, so it asserted nothing. A caption fixture had no `mediaId`, so a mutant that made
captions audible was skipped a step earlier, by the missing source rather than by the type check.
Both are the same lesson the rest of this project keeps relearning: a fixture must contain the
thing the rule is about, or the rule is tested by accident.

## 47. The clock is whatever the sound is doing, and the rate lives on the anchor

**The spec states two cases and the code had implemented one as if it were both.** SPEC 09 §23
says the audio output position is the clock *when any audio plays*, and a monotonic timer
otherwise. The preview accumulated `performance.now()` deltas, which is the second case and reads
as the general one. The difference is invisible at 60 fps and permanent at 30 with a slow machine:
an animation frame is a deadline, not a tick, so every late frame adds its lateness to the
picture's error while the sound runs on regardless. The spec's own remedy — "drop frames, never
slow audio" — only makes sense if the clock *is* the audio; with a timer there is no frame to drop,
only a number that is wrong.

**The anchor is the whole design.** `context.currentTime` counts from the context's creation and
keeps counting while the playhead is paused, seeking or looping. So the playhead is an *offset*
from an anchor — "the playhead was here at this clock reading" — and every move from outside the
clock re-anchors. That framing is what makes the seek case fall out for free rather than needing
its own code path: a playhead that disagrees with the anchor by more than the tolerance is a seek,
which is the same test the preview's element seeking already used.

**The anchor is taken on the first tick, not when the effect runs.** This was a real bug, found by
the first test written against the wiring. The effect fires on a React commit, before the
transport's own effects have resumed the context; a suspended `AudioContext` reports the same
`currentTime` for several frames, so an anchor taken there pairs a device position that is about to
change with a playhead that has not moved. The playhead then sat at zero while the transport
insisted it was playing. Taking the anchor on the first frame makes the two readings come from the
same clock state. The general lesson is the one this project has now learned three times: "the
effect ran" and "the thing it measures started" are different moments, and code that assumes
otherwise fails silently.

**The rate is on the anchor, and it multiplies ignored-once.** A rate multiplies elapsed wall time
to get elapsed project time; writing it the other way round plays 2× at half speed, and applying it
at both the anchor and per frame plays 2× at 4×. Both bugs agree with the correct version at the
first frame, where elapsed is zero, so the test for this is a walk through several frames rather
than a point check. Keeping the rate on the anchor also means the number is validated once, at the
boundary, and every later use is arithmetic on a value already known to be legal.

**A reading before the anchor holds; a reading after it is followed.** These look like the same
case and are not. A `currentTime` smaller than the anchor's is unambiguous — the device was reset —
and rewinding would be a visible jump plus a burst of sound from the wrong place. A `currentTime`
that is forward but smaller than the playhead is *not* distinguishable from a valid fresh anchor,
and following it is the correct answer for a design whose premise is that the device is the truth.
The limitation document says so in those words rather than claiming a correction this does not
perform.

**Two branches were deleted rather than tested.** A `writing` flag guarding the playhead
subscription, and a `Number.isFinite` guard in the rate clamp. Neither could be made to fail, and
in both cases the reason was structural rather than a weak fixture: `PlayheadStore.set` returns
early when the value is unchanged, so the subscription can never see a no-op write from the tick,
and every comparison against a non-finite distance is false, so the clamp's loop already leaves the
safe default. An unreachable branch is worse than a comment — it reads like a guarantee, and a
future reader who trusts it will not re-derive the reason it is unnecessary.

**The rate control is absent without a graph.** SPEC 13's rule about controls that cannot work
applies exactly here: a 2× button that moved the playhead twice as fast while the sound stayed at
1× would produce the one thing a preview must never do — a picture that disagrees with the file.
`preservesPitch` is set unconditionally in both spellings, after a bug where guarding it with `in`
made the assignment vanish in precisely the environment the test ran in.

## 48. A meter is a tap, and the arithmetic is the part worth sharing

**The graph had the nodes; the meters were a UI job, so they became a store.** The preview graph
lives in `PreviewPane` and the track headers live in `TimelinePanel`, which are siblings. Threading
a map of `AudioNode`s down through the components between them would carry a Web Audio type through
half a dozen files that have no use for it. `trackTapsStore` publishes instead — the same shape
`playheadStore` already uses for the same kind of reason — and a header that is not rendered costs
nothing because nothing subscribes. The store holds what the graph published, never a copy: the
graph decides when the set of audible tracks changed.

**The store's identity check includes the context, because the map alone is not enough.** Publishing
the same map with a new `AudioContext` looks like a no-op and is not: the headers would keep building
analysers in a closed context, and every meter would read silence for the rest of the session with
nothing logged. Both fields are compared, and a test pins the case.

**A meter must be a tap.** The header's analysers connect to a track's summing node and to nothing
else — no gain, no routing, no side effect on the sound. This is a rule rather than an observation:
the one bug class that makes a *measuring* feature change what it measures is putting a node in the
signal path, and it is how the master meter would have silenced the preview when it was first built
(an `AnalyserNode` must be connected *through* to the destination, not substituted for it).

**One timer for every track.** Twelve headers each running a 30 Hz interval and reading two analysers
is 720 reads a second, and it scales with the number of tracks — the cost of the feature growing with
the thing the feature is for. So the hook takes the whole map and runs one interval. A test counts
the intervals requested, which is a claim about the code's shape rather than about its output.

**Two 3 px bars is not a shrunken master meter.** The master meter earns its size: 96 px, labelled
channels, a scale, a peak hold and a latching clip light, because it is what you consult when judging
a mix. A header has 184 px shared with a name, a lock, a magnet, a mute and a solo button. Carrying
all of it in would either not fit or push the controls off the row, and a control that is present but
off the row is not reachable — the failure this project has now hit often enough to treat as a
principle. So the track meter keeps the things that make it comparable to the master — the same
−60…0 scale and the same three colour thresholds, from the same module — and drops the hold (a hold
marker would cover the bar it marks at that height) and the clip light (no room). Clipping is still
reported, by the master, where there is room for a light that latches until it is clicked.

**The held state had to be a ref, and that is not a style choice.** `updateMeter` computes a peak
hold from the *previous* reading. Inside a `setInterval` callback, reading that from React state
captures the value from the render the effect ran in, so the peak would never advance past the first
frame's — a hold that is permanently stuck at whatever the first tick saw. The previous map lives in
a ref beside a mirror used for the change test, and both are declared above the effect because a
`const` is only initialised at its own line.

**Three mutations were written and only two of them were real.** The peak hold and the "do not
re-render when nothing moved" bound both bit, but only after the fixtures were tightened: the first
version of the render bound allowed three updates, which is exactly what an unconditional `setMeters`
produces over three ticks. The third — removing the `has(trackId)` guard in the analyser build loop —
cannot be distinguished by any fixture, because that loop runs once per effect run rather than per
tick. The guard stays, because the effect *is* re-entered when the tap map changes and a re-entry
without it would add a second analyser pair to the same node; but the test says "this does not prove
the guard" rather than pretending otherwise. A test that claims more than it checks is worse than no
test, because it retires the question.

**A fixture leaked a context per render and killed the worker.** The first hook fixture built a new
fake `AudioContext` on every render, so the effect re-ran every render, and the effect sets state —
a render loop that allocated until `Ineffective mark-compacts near heap limit`. The fix is one
context per test, and the comment explains why it must be stable, because a *caller* can make the
same mistake with a real context and get the same hang.

## 49. Noise reduction is a new file and a plan that says what it can do

SPEC 12 §6.8 asks for noise reduction with three strengths, a background job, an A/B toggle and a
Revert, and it prefers RNNoise "when available, otherwise ffmpeg `afftdn`". Three things about this
build changed the shape of the slice, and all three are decisions rather than discoveries.

**The bundled ffmpeg has no `arnndn`.** It is 4.1, from 2018; `arnndn` arrived in 4.3. So the
spec's "otherwise" branch is the only one that can run here, and the capability is *probed* from
`-filters` at start-up rather than assumed from the version — a future binary with `arnndn` needs
no code change beyond the probe seeing it, and a build that assumed it would fail at run time with
"No such filter", which reads to a user as the feature being broken rather than as a version fact.
The probe is cached, because it costs ~50 ms and cannot change while the app runs.

**RNNoise's model is a licence decision, not an engineering one.** Even with `arnndn` present, the
plan falls back to spectral denoising when no model path is supplied. RNNoise's model files carry
their own terms, and shipping one without checking them is the kind of problem that cannot be fixed
by a patch. The fallback is reported in the plan's `description` — the panel says which method ran
— so the downgrade is visible rather than silent. This is the same rule `docs/limitations.md`
records for checksums.

**A denoiser is not obviously an improvement.** It can remove the noise floor and the presence from
a voice in the same pass, so the level of the result goes *down* whether or not the audio got
better. `describeNoiseReduction` is therefore descriptive and never celebratory: it reports the
measured change and says to compare, because a sentence that treated a bigger drop as a better
result would push users toward the setting that thins their voice. The spec's own warning — "can
affect voice quality; compare before using" — is quoted verbatim in the panel, where it is a
sentence the UI has to be able to earn rather than a tooltip.

**Never destructive, and Revert is a no-op on disk.** The output is a new, content-addressed file
under `<derived>/enhanced/`, keyed on the media, the range and the exact filter chain — so the same
strength twice is a cache hit and a *changed* strength is a different file, which is the difference
between a setting that works and one that appears to do nothing. Nothing writes to the source, so
Revert clears the item's `noiseReduction` field through `setItemProperties`: it is a command like
any other, it is undoable, and it needs no confirmation dialog because nothing is being destroyed.
A dialog there would imply a risk that does not exist and train the user to dismiss the ones that
do.

**Where the copy goes, and the bug that taught us to test it.** `derivedDirectoryFor` reads the
directory from the media's proxy (`derived/proxy/<mediaId>/proxy.mp4`, three levels up) or its
peaks, and only falls back to `dirname(media.path)` when neither exists. The fallback is right for a
*managed* import and wrong for a *reference* one, where that path is the user's camera card —
writing beside it would succeed, look fine in the app, and leave files on someone's disk. The first
version of the function was two levels up, which lands on `derived/proxy`: a directory that exists
and therefore *accepts* the write, so the bug produced a file in the wrong place rather than an
error. The test that caught it is a pure path assertion, which is the reason the arithmetic lives in
an exported helper rather than inline in an IPC handler.

**The job's result is a command, not panel state.** It goes through `setItemProperties` so the
cleaned copy is what the preview plays and what an export contains — the same document, the same
undo stack. It is applied to the item that *asked*, not to the current selection: a job takes
seconds, the user can select something else while it runs, and attaching the result to whatever
happened to be selected at the end is how a cleaned copy lands on the wrong clip. The A/B toggle is
the opposite — view state only, never written to the project — because a comparison that dirtied
the file and entered the undo stack every time would turn auditioning into an edit.

**One thing the checker had to learn.** `main.ts` reaches the module with `await import(...)` so
ffmpeg is not loaded at start-up for users who never open the panel, and `scripts/check-repo.mjs`
looked only for `from '…'` — so it reported a genuinely wired module as an orphan. The rule's own
words are "a module only a test can reach", and this one is reachable from the app. The regex now
matches both forms, and a planted orphan still fails, which is the check that the widening did not
simply make the rule slack.

Seventeen tests on the main-process job and the directory arithmetic — against the real bundled
binary, with a noisy fixture generated by it — twelve on the pure plan, and nineteen on the row and
its decisions. Sixteen mutations all bite: an unescaped Windows model path, a cache key without the
filters, `-ss` moved to the wrong side of `-i`, a non-monotonic profile, an inverted delta, a key
that ignores the range. The one that survived longest was `-ss` after `-i`, which produces an
identical file — slower, by decoding everything before the range — so a duration assertion could
never see it; it is now pinned by position.

## 50. Ducking was three layers of agreement about a value no project could hold

SPEC 12 §6.7 asks for a music bed that ducks under speech. The *arithmetic* was built with the
audio slice and is correct: `duckingCurve` reduces a bed while a trigger is present, attacks and
releases over configurable windows, and returns exactly unity outside one. It had tests. What this
slice found is that no project could ever reach it, and the reason is worth recording because it is
this project's most recurring bug shape in its purest form.

Three layers each had half the feature:

- The **mixer** read `duckUnderSpeech` on every item and had a `beds` array and a cue list for it.
- `planAudioItems` **never forwarded the flag**, so every request arrived with it `undefined`.
- The **item schema had no field**, so nothing above the mixer could set it either.

Each layer's own tests passed. The mixer's ducking test was the honest failure of ambition: it
asserted `expect(amplitudeToDb(peakLevel(duringSpeech))).toBeDefined()`, which is true of every
number including the wrong one. A test that cannot fail is not coverage, and this one sat in the
file for several slices looking like exactly what it was supposed not to be.

**A brand kit's music bed is what made it visible.** The kit schema has carried `musicAssetId`,
`musicVolumeDb` and `duckUnderSpeech` from the start; `planKitApplication` copies them onto
`plan.music`; and the panel prints *"Music bed added with the kit's ducking."* Meanwhile
`applyBrandKit` had **no music branch at all** — so pressing Apply placed the logo, applied the
captions, and said it had added a bed that did not exist. The brand-kits tests asserted
`plan.music.volumeDb` and passed, because the *plan* was right; nothing asserted that an item came
out of it. The rule this slice took away: **a test on a plan is a test of a description, not of a
result**, and the panel's sentence is now backed by one that looks for the clip.

Three things had to be built, in order:

1. **`duckUnderSpeech` on the item**, defaulting to `false`. Turning it on by default was the
   tempting mistake — a clip of dialogue would duck under itself — so it is a property of a *bed*,
   set by the kit that says "music, under the speech".
2. **Forwarding through the plan.** `PlannedItem` gained the field, `buildExportPlan` copies it,
   `planAudioItems` forwards it. The last of those is one line, and it was the line missing.
3. **The bed itself in `applyBrandKit`** — an ordinary audio item on a `music`-role track, spanning
   the composition and trimmed to the music's own length.

**The off-by-one-second that the new test found.** With the chain connected, the bed was still
wrong: it ducked for the item's *padded* length rather than the length it sounds for. `fitLength`
pads a short source with silence so the clip matches the item's claimed span — correct for mixing,
wrong for a trigger — and the cue was built from `clip.length`. A one-second voice on a two-second
item kept the bed down through a second of nothing. The fix carries `timelineDurationUs` on the
request and builds the cue from it; the test that catches it measures the bed's own 200 Hz tone with
a Goertzel filter at a point inside the padded span and past the release, which is why the two
earlier attempts at this test could not have found it.

**A test-only lesson, recorded because it cost an hour.** The first two attempts at the ducking test
compared whole-second windows of the summed mix. Both passed against a broken mixer, and both would
have kept passing. Measuring a *specific frequency* isolates the bed from the voice; measuring a
*summed level* does not, because the voice's presence moves the total in the opposite direction to
the ducking. The control case — the same fixture with `duckUnderSpeech: false` — is what makes the
difference attributable rather than merely observed.

Nineteen tests across the bed, the forwarding and the produced audio; thirteen mutations, all
biting after the two fixes — including the bug this slice started from (`plan.music` read and never
applied), the flag dropped on the way through, and the trigger built from the padded length.

### The guard was asking the wrong question, and CI said so

The first push of this slice went red on `windows-latest`: three tests, `spawnSync ffmpeg ENOENT`.
The ducking block was the only one in `audio-mixer.test.ts` without a `describe.skipIf`, which is
how it got noticed — but the more interesting finding is that **the guard every other block used was
wrong too**.

`HAS_FFMPEG` was `existsSync(ffmpegPath()) && existsSync(ffprobePath())`. The binaries under
`resources/bin` are untracked: `pnpm install` creates Linux symlinks into `node_modules`, and
`fetch-binaries.mjs` installs real executables on Windows. Those symlinks are absolute, so
`existsSync` answers "is there a path here" — and there is, pointing at a target that may not exist,
which is exactly what a copied worktree or a Windows runner has. The check passed, the block ran,
the spawn failed.

`usableBinary()` now runs `-version` and catches. It answers the question the guard was always
trying to ask — *can this machine run ffmpeg* — and it is the same answer on both platforms, which
is the property that was missing. Applied to the three files this slice touched; the eight older
files with the `existsSync` pattern are left alone rather than swept, because they pass today for a
reason none of them states and changing them all is a separate, testable change.

The process lesson is the one this project keeps relearning: **the local suite passing is evidence
about the local machine**. A test that gates on the presence of a binary has to gate on its
*runnability*, and only CI on the other platform can tell you that you did not.

## 51. Auto-ducking was six settings and no feature

SPEC 12 §6.7 describes auto-ducking as a **track** feature: *Duck this track when [Original audio /
Voiceover / selected tracks] has speech*, with a reduction adjustable −3…−24 dB, a −42 dBFS
threshold, 120 ms attack, 400 ms release, and the envelope "used identically by preview automation
and export mixer (no real-time side-chain)".

The project schema has held all six of those as a `ducking` object on every track since the file
format was written. **Nothing read them.** Not the preview, not the mixer, and no command could
write them either — so a user could not turn the feature on even if a renderer had honoured it. The
`duckUnderSpeech` boolean fixed in the previous slice is a *different* feature: it asks the item
whether it wants ducking, cannot name its triggers, and its depth is a hardcoded −12. The schema's
track object was a whole unreachable feature sitting next to it.

This is the same bug shape as `plan.music` and as `duckUnderSpeech` itself, at the largest scale
yet: not one dropped value but six, validated on load and rendered by nobody.

**One module, two renderers.** The arithmetic lives in `packages/audio-core/src/ducking.ts` and
returns **spans** — where the track is held down — rather than a sample array. A sample array would
be tied to one sample rate and one buffer length; spans convert to whatever a consumer needs, and
the mixer takes its per-sample curve from `duckingCurve` over the same spans. §6.7's binding
sentence is therefore a property of the code: the preview and the file cannot disagree, because
there is one envelope and two serialisations of it.

**The comparison is a test.** `export-core`'s `audio-mix.test.ts` imports both and samples the two
at ~2000 instants across four seconds, including every ramp. Neither package can import the other
without a cycle, so that test lives where both are reachable — and it is the one that would fail if
either ramp shape changed.

**Decisions the spec leaves open, decided here:**

- **An empty `triggerTrackIds` means "everything else"**, not "nothing". That is the only reading
  under which an unconfigured auto-duck does something, and it matches what the control says.
- **A region with no `trackId` never matches a named trigger.** Treating unknown as a match means
  the bed ducks under a track the user explicitly excluded.
- **Speech regions closer than the release time are merged.** Two sentences with a 100 ms pause
  would otherwise release and re-attack inside 400 ms, which is audible as a pulse. This is the
  spec's "smoothing identical for all uses" applied at the span level.
- **A reduction of zero or a positive gain is refused**, not stored. Every renderer reads a stored
  setting as "held down", so zero is a control that looks applied and does nothing.
- **A depth outside −3…−24 is clamped rather than refused.** A slider cannot leave the range, so a
  value beyond it is a hand-edited file; clamping keeps the project openable, and refusing would
  make one number cost a whole project.
- **The preview derives speech from the other items' spans**, not from decoded audio. The spec
  allows either. The preview has no decode and usually no transcript, but it does know where every
  other item sits — and an analysis-based version would be more accurate about *speech* while
  disagreeing with the export, which is the worse error.

Two mutations survived the first pass and both were redundant code, not missing tests: an
`enabled` check in the preview that `duckingSpans` already performs, and — after the first fix — a
`muted` filter whose test had removed the muted item from the timeline entirely rather than muting
it. The first was deleted; the second got a test that holds an item and mutes it, plus a second for
a hidden track. A surviving mutation is a question, and the answer is sometimes "delete the line".

Twenty-one tests on the module, nine on the preview plan, eight on the command, and eight on the
produced audio against the real ffmpeg — including one that asks for −3 dB and one for −24 dB and
requires the two files to differ, which is the assertion that the depth is the track's rather than
the mixer's hardcoded default.

## 52. The start screen never worked, and four settings hid it

Pressing **"Find clips"** on the first screen of the app created no project. The page sent
`storageMode: 'copy'`; the schema's enum is `managed | reference`; `ProjectRecordSchema.parse`
threw before the insert. The user saw raw JSON in a red box, and the app's front door was shut.

Three more keys were wrong without throwing. `aspectRatio`, `captionStyle` and `clipLength` are not
settings keys, but the schema is `.passthrough()` — so they were stored, read by nothing, and a user
who chose 4:3, Karaoke and Short got 9:16, "Bold creator" and 30–60 s. The schema's real keys
(`aspect`, `captionStyleId`, `clipLengthPreset` plus `clipLengthRangeSec`) were never sent.

Underneath both, `handleCreate`'s dependency array listed only the source and the navigation. The
callback was memoised on the first render, closing over the initial values, so even after renaming
the keys every setting would still have arrived as its default. This is the same class of bug as the
volume keyframes and the ducking flag: **a value with a writer that no reader consults, and a reader
whose input nothing writes.**

**Why it survived.** There was no test that crossed the boundary. `StartPage` had no test at all —
it is 700 lines of inline-styled JSX and an IPC call — and every schema test built its own payload
in the schema's own vocabulary. Each side was internally consistent and they disagreed with each
other. That is the precise failure mode the *"same code feeds preview and export"* decisions
elsewhere in this file are written to avoid, and it went unnoticed here because the two halves live
in different processes.

**The fix is a shared module, not a corrected literal.** `startSettings` lives in
`packages/project-schema` — the dependency both the renderer and main already have — and returns a
partial the page spreads over the intake details (`sourcePath` and friends). Putting the mapping on
one side or the other would have left the other side able to drift again; putting it in the shared
package means the test that checks it needs no window and no IPC, which is why this one can exist.

Decisions the mapping had to make:

- **A preset's seconds are written, not just its name.** `clipLengthPreset` is read by nothing;
  `moments-service` reads `clipLengthRangeSec`. Writing only the name would have made the new
  control exactly as decorative as the one it replaced. Both are written, so the name is available
  to a future reader and the analysis gets its number today.
- **Out-of-range values are clamped, not refused.** A reversed two-handle range is ordered; a 1-second
  or 9000-second range is clamped to 5–600; a ratio pair to 1–32. A project with a clamped setting
  is a better outcome than a button that does nothing, which is the failure being repaired.
- **`custom` stays `custom` in `aspect`.** Nothing builds a canvas from a pair yet, so the value
  resolves to 9:16 at composition time — the same fallback `moments-service` already performs. The
  pair is still stored, so the day something reads it the user's choice is there.
- **One change per test.** The first page test clicked Karaoke *and* Short; deleting the caption-style
  dependency still passed, because the clip-length dependency rebuilt the callback and carried the
  new caption style with it. A test that makes two changes cannot say which one mattered.
- **Assert a value the default is not.** The first schema test asserted `bold-creator` and `auto` —
  which are also the schema's defaults — so a mutation that stopped sending them passed eleven tests.

Fifteen mutations, four survivors, and **all four were weak tests rather than missing code**. That
is the useful outcome: the code was right, and the tests were writing down the answer instead of
checking it.

The two Custom tiles also gained their inputs. A "Custom" tile that stores the default is the same
bug in miniature: the aspect tile opened nothing to type a ratio into, and the clip-count tile
resolved `Number('custom')` to `NaN`, which the schema refuses — the identical failure as `copy`,
one click away.

## 53. Four actions in the store, none in the window

`StorageService` has `updateProject` (which renames), `duplicateProject` and `deleteProject`, all
with tests. `preload/index.cjs` exposes all three on the bridge. `ProjectsPage` was a grid of cards
that navigated into a project — **no ⋯ menu, so no rename, duplicate, archive or delete**. SPEC 03
§10 describes all four and SPEC 02 §6 draws the menu; an app carrying an implementation of each
could not perform one.

The mechanical cause is worth recording because it is a shape that recurs here: the page calls what
`api.ts` offers, and `api.ts` had a wrapper only for `updateProject`. The other two were reachable
from the bridge and from nowhere else, and the bridge is not something a page imports directly. So
the feature was "present" in every layer and absent from the only one a user touches — the same
anatomy as the ducking object and the start screen's settings, one rung lower.

Building it found a second bug that would otherwise have shipped: `deleteProject`'s option was
*declared* `{ deleteMedia?: boolean }` and the store reads `deleteExclusiveManagedMedia`. One is a
TypeScript interface in `global.d.ts`, the other a destructured parameter in main; nothing compares
them, and the types do not meet. A caller following the declaration would delete the project, keep
every managed file, have ticked the box, and get no error — the failure in the direction the user
least expects, since they asked for *more* to be deleted. The declaration now carries the store's
name, and `api.deleteProject` maps the friendly one onto it, so neither spelling can be dropped in
silence.

**Decisions the menu needed:**

- **The card stopped being one button.** A menu inside a `<button>` is invalid, unclickable in some
  browsers, and reads as one control to a screen reader. The card is now a container with a button
  for the title area; the menu trigger sits outside it.
- **The trigger is labelled per project** — "Actions for Interview clips" — because a grid of ten
  cards otherwise reads as ten identical "⋯" buttons.
- **Archive is a value, and the menu's slot flips.** §8's "read-only until unarchived" means the
  action has to write `false` for an already-archived project. The first test only asserted that the
  *label* changed, and a mutation that always wrote `true` survived it: the label comes from the
  record, not from the action, so the two could disagree forever.
- **Delete says both sentences before it happens.** Referenced originals are never touched, and
  copied media only with the box. The dialog names the project and the count, rather than asking
  "are you sure" about something unnamed.
- **A failure is reported, not swallowed.** A read-only workspace or a locked file leaves the dialog
  open with the reason; closing as though it worked would be a lie the user acts on.

Twelve mutations, eleven biting first pass and the twelfth after the archive test was rewritten.
Two initially reported `MISS` because the mutation's search string did not match the file's
whitespace — a reminder that a mutation report has three outcomes, not two, and `MISS` is a bug in
the harness rather than evidence the code is safe.

## 54. A refactor deleted the AI surface, and nothing was positioned to notice

Every window in the app talks to main over `ipcRenderer.invoke`. The preload bridge offered 122
channels; `registerIPC` answered 86. The 36 it did not answer were the whole AI section — providers,
the model manager, Ollama, consent, the privacy panel — and all six moments channels. A user adding
a provider, downloading a model, or opening the moments screen got
`Error: No handler registered for 'ai:providers:list'`, in whichever page they had opened.

It was a **collateral deletion**. `git log -S 'ai:providers:list'` points at `8418bfe`, "one model
catalogue for setup, settings and the manager", which meant to replace three `models:*` handlers
with delegating versions: 160 lines removed, 21 added. The replaced range extended well past the
three it was aimed at, and took the `ai:*` block, the `moments:*` block and both progress sinks.

**Why nothing caught it.** This is the same question as the start screen and the project menu, and
the answer is the same shape — no test crossed the boundary — but the boundary is different, so the
check has to be:

- The services were still constructed and the `require*()` helpers still existed, so `tsc` was
  happy. A handler that is never registered is not a type error.
- An unhandled channel is not a boot error either. Electron only complains when a renderer invokes
  it, and it complains into a rejected promise in a page.
- The 36 channel names appear in exactly one place — the preload file — so `grep` for a dead symbol
  finds nothing. A deleted registration leaves no reference behind.
- The AI tests are good and they all pass: every one constructs `MomentsService` and calls it
  directly. That is the right way to test the scoring, and it says nothing about whether a window
  can reach the scoring.

**The guard is a comparison, not a call.** `ipc-surface.test.ts` reads the preload file and `main.ts`
and asserts the sets line up — invoked ⊆ handled, listened ⊆ pushed, handled ⊆ invoked. Reading
source is weaker than invoking a channel, and it is the claim that would have failed on `8418bfe`,
which is what a guard is for. Both directions matter: the third check catches a handler registered
under a misspelled name, which answers nobody while looking like work.

**Three states of "dead channel", and they need different answers:**

- *Offered, never handled* — 36 channels, restored from the commit before the deletion. The services
  were intact, so the fix was the registration, not the code.
- *Called by a page, never handled* — `ai:models:deleteAll`. `ModelService.deleteAllDownloaded`
  existed and was never registered; the Models page's "Delete all" had always failed. Added.
- *Listened to, never sent* — `onModelProgress` on `models:progress`, which main has never sent.
  **Deleted rather than repointed:** nothing in the renderer called it, and `onModelDownloadProgress`
  already listens on `ai:modelProgress`, the channel the manager does push. Repointing would have
  left two listeners on one channel and a progress bar updated twice.

The general lesson is one this project keeps meeting from different angles: a name that appears in
two files is a promise neither file can keep on its own. Where that promise matters — channel lists,
settings keys, option names — it needs a test that reads both sides. Writing one after the fact is
how you find out how many you had already broken: thirty-six.

## 55. A test that wrote 1.2 GB per run, and failed on a loaded CI runner

`packages/ai-core/src/__tests__/models.test.ts` had two tests that allocated real model-sized
buffers:

- `Buffer.alloc(small.expectedBytes)` — 488 MB, to assert a card reads `installed`;
- `Buffer.alloc(round(medium.expectedBytes / 2))` — 767 MB, to assert a card reads `paused` at 50%.

Together, over 1.2 GB of temp-file writes per run — and one of them failed on CI with a bare
`STACK_TRACE_ERROR` while passing locally, which is what a disk-backed test looks like when the
runner is busy.

Both functions read `stat.size` **and nothing else**. The length is the whole claim; the bytes were
never looked at. So the files are now created empty and `fs.truncateSync`ed to the required size,
which sets the length in constant time and allocates nothing. Same three assertions, same three
statuses, 0.9 s instead of however long it takes to write a gigabyte.

This is a small thing with a large lesson attached, and it is the same one as the mutation runs
that report `MISS`: **a test's cost is part of its correctness**, because a test that fails for
reasons unrelated to the code teaches people to re-run it rather than read it. A flaky test is
worse than a missing one — the missing one is an honest gap.

`Buffer.alloc(1024)` in the neighbouring test is left alone: it is the corrupt-file case, and 1 KB
is both cheap and deliberate.

## 56. WebVTT was written, tested and unreachable

SPEC 14 §4 lists *"Also save subtitle file(s) (SRT / WebVTT)"*. The pipeline for both formats was
complete: `ExportPlan.subtitleFormats` is `('srt' | 'vtt')[]`, `export-service` renders either from
the same cue list, `validation` counts the sidecars it expects, and `generateVtt` has its own tests
including a timestamp-format check.

Two lines made that unreachable, one at each end:

- the settings panel had a *Save subtitle files* toggle and no way to choose a format;
- `use-export` did `subtitleFormats: input.panel.saveSubtitles ? ['srt'] : []`.

So "SRT / WebVTT" meant SRT, and the `.vtt` writer was dead code with tests. Same anatomy as the
ducking object and the AI channels: the capability was built, the join was missing, and each side's
tests passed.

**Two decisions the control needed:**

- **The formats appear only when the toggle is on.** A format checkbox next to an off switch invites
  a user to set something that will be ignored, which is the bug being repaired rather than a
  layout preference.
- **Naming formats with the toggle off still writes nothing**, and there is a test for exactly that
  combination. `subtitleFormats` is what the planner reads; `saveSubtitles` is what decides whether
  to read it. A patch that reordered the two would write files the user had turned off.

The panel cannot reach an empty selection by clicking — the state keeps whatever was checked, and
unticking both leaves `[]`, which the export honours. That is deliberate: the toggle is the off
switch, and having two ways to express "write nothing" only creates a way for them to disagree.

## 57. The subtitle file was wrapped for a frame nobody was looking at

The transcript editor's export button passed `'16:9'` — a literal — as the aspect, and that
argument is what decides how cues are line-wrapped in the SRT and WebVTT files it writes. So every
project exported subtitles laid out for a landscape frame. This app's default project is 9:16
portrait; a cue that takes two lines across a 1920-wide frame needs three at 1080 wide, and a file
wrapped for the wrong shape breaks in the wrong place everywhere it is opened.

It is the smallest bug of this run and it belongs to the same family: a value that exists in one
place (the project's `settings.aspect`), is needed in another (the wrapper), and is replaced by a
literal in between. The literal is not even visibly wrong — `'16:9'` is the function's own default,
so the call site and the callee agreed, and only the *project* disagreed.

**Why it survived.** The transcript editor had no test. It is a 400-line component with search,
selection, inline edit and four export buttons, and every one of those was reachable and untested —
which is also why the literal could be there from the first commit without ever looking wrong.

The fix is one prop threaded from the stage that already had the project. The test asserts the
aspect reaches the bridge, that all four of §9's formats do, that the fallback applies only when no
aspect is supplied, and that a WebVTT export is not named `.srt`. Four mutations bite, including
putting the literal back.

The general note, since this is the seventh instance: **a default at a call site is a claim that
the caller has nothing to say.** Sometimes that is true. Here the caller had the project in scope
and had already used it for everything else on the screen.

## 58. "Talking head" was spelled two ways, and a cast hid the difference

A project stores `contentType: 'talking'` — the *Talking head/vlog* tile on the start screen. The
scoring model is keyed by `'talking_head'`. One word apart, and `moments-service` crossed the
boundary with:

```ts
const contentType = (request.contentType ?? project.settings.contentType ?? 'auto') as ContentType;
```

A cast is the assertion that two types are the same thing. Here they were not: `'talking'` is not a
member of `ContentType`, so the cast was a lie that compiled. `CONTENT_TYPE_ADJUSTMENTS['talking']`
was `undefined`, `?? {}` swallowed it, and the analysis ran on `DEFAULT_WEIGHTS`. Choosing *Talking
head/vlog* did nothing.

**Why it survived.** The failure has no edge. The analysis still returns moments, still ranks them,
still scores in range; the weights are just the generic ones. A user cannot see the difference
without analysing the same video twice with two content types and comparing — which nobody does.
The tests did not, and the type system was told not to.

**The fix is a translation, not a widened union.** Widening `ContentType` to include both spellings
would put the ambiguity inside the scoring table, where every future lookup would have to remember
it. `contentTypeFromProject` sits at the boundary that actually has two vocabularies — a project
file and a scoring model — maps the one member that differs, and returns `auto` for anything from
neither, so a hand-edited project degrades instead of throwing mid-analysis.

The test asserts the consequence rather than the spelling: the ranked moments from the same
transcript must differ between `talking` and `other`. A test that checked
`contentTypeFromProject('talking') === 'talking_head'` would have been satisfied by the function
existing; this one is not satisfied unless the weights actually change.

**The general shape, now the eighth instance in this run:** two files that each hold a name the
other needs. Where the compiler can check it, a cast is how it stops being checked. The channel-list
test (§54), the settings-key module (§52) and this translation are three answers to one question —
which file owns the name — and the answer is always "the one that has the other file's vocabulary in
front of it", never a cast.

## 59. A toast that said "saved", and a merge that was shallower than its name

The Moments screen's content-type control had three faults stacked in six lines.

**It said "saved" and saved nothing.** The handler called `setContentType(value)` and pushed the
toast. The value went into React state and out again on the next mount, so the dropdown quietly
reverted — the screen looked like it worked because the control showed what you had picked until the
page reloaded.

**It offered a value the project schema rejects.** The options listed `talking_head`, which is
ai-core's spelling of the profile. Projects store `talking`. Nothing failed, because nothing was
written; the moment the save was wired up, the schema would have thrown on it. This is the same
split from §58 seen from the other side: the analyser translates `talking` → `talking_head` at its
boundary, so the UI must speak the *project's* vocabulary, not the analyser's.

**And the save it needed would have destroyed the project's other settings.**
`StorageService.updateProject` merged the record with `{...existing, ...patch}`. `AppSettingsSchema`
defaults every field. So `{ settings: { contentType } }` did not update one setting — it replaced the
object, and `aspect`, `captionStyleId`, `clipLengthRangeSec` and eight others came back as their
defaults on the way through the parse. The write would have succeeded, the toast would have been
right about the field it named, and the user's portrait project would have been landscape by the
time they exported.

That last one is the reason the fix is not in the page. The page could spread `project.settings`
before patching — that is what I first wrote — but a spread at a call site is a rule that the next
caller has to know. The merge moved into the store, and `ProjectPatch` now expresses it:
`settings?: Partial<AppSettings>` rather than `Partial<ProjectRecord>`. The type and the code say the
same thing, so a caller that sends one setting is not relying on a convention it cannot see.

**What the tests assert.** The store tests check the fields *around* the one being written — aspect,
caption style, clip length range — because a test that asserts `contentType === 'tutorial'` passes
against the broken merge. They also assert that falsy values still replace (`saveSubtitles: false`),
since a merge written with `??` or a truthiness check would make a setting impossible to turn off.
The page tests drive the design system's listbox rather than a native `<select>`: `fireEvent.change`
on a button does nothing, and a test written that way would have passed on a page that saved
nothing — which is exactly the bug's shape.

Seven mutations bite, including all three original faults.

## 60. Two settings the import replaced with constants

The start screen asks for a download quality and a storage mode, and saves both into the project.
`ImportStage` — the component that actually starts the import — called:

```ts
quality: '1080p',
storageMode: 'managed',
```

Both are defensible defaults. Both are what a user got no matter what they chose one screen
earlier.

The storage mode is the one that matters: `media-pipeline` branches on it at `:152`, and
`reference` means *do not copy the file*. A user who picked "keep files where they are" because
their source is 40 GB of screen recording had it copied into the workspace anyway. There is no
error and no warning — the app did what it was built to do, with the wrong instruction.

**What makes this one interesting is where the bug wasn't.** `startSettings` maps the page's
`copy`/`reference` onto the schema's `managed`/`reference` correctly. The store persists it. The
pipeline honours it. The types agree at every hop. The value travelled three layers and was
overwritten in the fourth by two constants that no one had reason to look at, because a constant in
a call to a well-tested function reads like a default rather than a decision.

That is the same shape as §57 (a literal `'16:9'` at a call site whose callee has the same
default), and the two were written in the same week. The pattern to watch for is a call site that
passes a *constant* for a value that also exists as a setting — the constant is never wrong
syntactically, and whether it is wrong semantically depends on a screen the author is not looking
at.

The fallbacks kept the old literals for projects created before these keys existed, so an old
project imports exactly as it always did. That is deliberate: this is a repair, not a migration.
