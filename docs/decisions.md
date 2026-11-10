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
