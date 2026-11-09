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
