# ClipWright Verification Report

**Last updated:** 2026-11-07
**Branch:** `arena/695acd97-main-clipwright`

Every number below comes from a command that was run, in this repository, on this
date. Where something could not be verified in this environment, it says so
rather than leaving a gap a reader might mistake for a pass.

---

## 1. Automated tests

```bash
pnpm test:unit
```

```
Test Files  77 passed (77)
     Tests  1824 passed (1824)
```

| Area | Tests | What they actually check |
|---|---:|---|
| `packages/export-core` | 315 | Encoder arguments, plan determinism, validation rules, audio mix DSP, presets, the ASS caption script (field order, colour byte order, anchor mapping, karaoke timing, range shifting), and the decode filter chain: crop, scale, rotation, offset and flip, with every stage kept even-sized and landing on the exact output size, and the keyframe segmenter: boundaries, merging equal neighbours, the segment cap |
| `packages/compositor` | 294 | Text layout (wrapping, alignment, word rectangles, background boxes, karaoke timing, every preset at four aspect ratios), the frame builder: karaoke sweeps, word-by-word hiding, keyword emphasis, palette cycling, in/out animation, per-word pop, and item geometry (crop rectangles, per-axis and legacy scale, flips, offsets) and the keyframe evaluator: holding outside the key range, hold segments, cubic-bezier and preset easing, duplicate timestamps; layer resolution and blend modes (which layers are visible, ordering, opacity clamping); software compositing: every blend formula against its closed form, opacity mixing toward the backdrop rather than black, layer ordering, and YUV↔RGB conversion checked against the bundled ffmpeg in both directions and in both colour matrices; and transition timing: window placement for all three alignments, the 0→1 ramp, easing, each type's shape (crossfade opacities summing to one, fade-to-black genuinely reaching black, slide endpoints, zoom scaling); and the wipe's geometry: the edge position at each progress, that nothing is revealed at 0 and everything at 1, a ramp whose width matches the softness and stays symmetric about the edge, unit normals for all six directions, and that a wipe reports a shape rather than a fade; and the dissolve: that its noise is deterministic, seed-dependent, bounded, smooth between neighbours and the same at any resolution, that pixels switch rather than blend, that the switched fraction tracks the progress (the raw field is bell-shaped, so a quantile mapping is needed or the transition stalls at both ends), and that the other transitions carry no dissolve shape; and the slide: that both pictures move, that the vertical directions move vertically rather than falling back to horizontal, that the two clips stay exactly one frame apart at every progress, and which way the strip travels; and the effect catalogue: parameter ranges and clamping, chain order, the spec's two numeric criteria (`+1` stop doubles linear values, saturation 0 is Rec.709 luma), contrast pivoting on 0.18 linear, and a Gaussian blur checked tap by tap against the textbook kernel; and adjustment-layer resolution (SPEC 12 §3.1): which are live at an instant, the half-open time window, disabled and hidden ones skipped, an empty chain skipped, ordered bottom-first, and the "only the tracks below" rule including the ambiguous same-track case |
| `packages/caption-styles` | 37 | The `.cwstyle` schema, migrations, unknown-field preservation, style resolution, contrast and the documented examples |
| `apps/desktop/src/main` | 292 | Export service, queue, ffmpeg orchestration, audio mixing, keyframed segmentation over real footage, and layer compositing measured in the produced file, a slide measured in two bands of the produced file (the leading band is the outgoing clip and the trailing band the incoming one at mid-transition — before this the file showed a hard cut and the left band read the incoming clip), a dissolve measured *per pixel* in the produced file (most pixels belong cleanly to one clip while both are present — a fade puts nearly every pixel in the blended band, which the test reproduces by reverting the transition to a fade), a wipe measured *per region* in the produced file (at half progress the revealed quarter is the incoming clip and the far quarter is still the outgoing one — a mean would not catch this, since an un-clipped stack averages the same), adjustment layers graded in the produced file (a clip below them comes out graded, a clip above them does not, and the grade lands on the composite rather than on each layer before blending — the three cases were each checked to fail against a deliberately broken renderer), karaoke word resolution, updates, journal, binary integrity, releases, packaging |
| `apps/desktop/src/renderer` | 353 | Export dialog (including the caption styles it forwards), queue panel, update dialog, update notice and chip, recovery dialog, command palette, caption painter draw order, caption overlay resolution, caption list and word editor, caption style editor and its save-a-copy rule, project-local style store, clip inspector, preview geometry (jsdom), the preview's layer stack: overlay clips kept rather than dropped, paint order, opacity, blend modes including the `add`→`plus-lighter` mapping and keyframed opacity; transitions on screen: both clips drawn during a crossfade, neither during a fade-to-black's first half, and slide offsets; the inspector's transition control: disabled on a first clip, creating a transition against the right neighbour, switching type without adding a second, removing it, and writing length changes; and effects on screen: the CSS filter mapping, disabled effects skipped, adjustment layers folded into the layers they grade, and the §14 "can't be previewed" banner appearing for exactly the effects CSS cannot draw; and the effect chain's editing surface: reordering (including refusing a move off either end), copy/paste between clips with the paste disabled until something is copied, and the timeline menu's "Add adjustment layer"; the wipe's `clip-path` for every direction, checked against the export's mask so the two cannot drift apart about which side is revealed, the dissolve's pattern mask including that a non-finite progress cannot produce a `NaN` stop (which silently drops the mask), and the transition direction control: that it appears for a wipe and a slide, that each uses its own wording because the same word means opposite things in the two, that choosing one sends it as a merged param, and that a type with no direction does not get the control; and the command that stores those params: merged rather than replaced, removable by `undefined`, and left alone when the patch is about duration |
| `packages/ai-core` | 120 | Provider clients, scoring, connectivity |
| `packages/update-core` | 177 | Version rules, manifest verification, signatures, update state machine, journal and recovery text, yt-dlp updater rules |
| `packages/timeline-engine` | 165 | Commands, invariants, undo/redo, caption editing (§11 §2.5), item properties and their validation (§09 §17) |
| `packages/audio-core` | 48 | The gain envelope: dB conversion, fade curves, keyframe interpolation and easing, and the preview/export agreement that SPEC 10 §7.1 requires |
| `packages/media-core` | 11 | Probing, peaks, path resolution |
| `packages/project-schema` | 8 | Schema validation and migration |
| `packages/design-system` | 4 | Component contracts |
| **Total** | **1824** | 77 files |

### Tests that run real processes

These are not mocks, and that distinction matters — a test that fakes ffmpeg
cannot tell you whether the ffmpeg arguments are right.

| Test file | Runs |
|---|---|
| `__tests__/ffmpeg-runner.test.ts` | Bundled `ffmpeg`/`ffprobe`: probing, decoding, loudness, black/freeze detection |
| `__tests__/export-runner.test.ts` | A complete encode end to end, then validates the produced file |
| `__tests__/export-service.test.ts` | Real footage through the service: published file, audio stream, temp cleanup |
| `__tests__/audio-mixer.test.ts` | Real PCM decoding, mixing, EBU R128 measurement, normalisation |
| `__tests__/decode-frame-source.test.ts` | Per-item decoders over real clips, plus layered exports decoded back and measured channel by channel |
| `__tests__/release-roundtrip.test.ts` | The real signing script, verified with the app's own verification code |
| `__tests__/smoke-test.test.ts` | The real bundled binaries, reporting their real versions |

Bundled tooling in this environment is **ffmpeg 4.1** (a 2018 build). That is a
deliberate constraint: if the code works on the oldest build we might ship, it
works on newer ones. Capability detection (`-vsync cfr` vs `-fps_mode`) exists
because of it.

### The geometry filter chain, checked against real ffmpeg

Crop, scale, rotation, offset and flip are built as an ffmpeg filter chain
(`sourceFilterChain`), and a chain that *looks* right can still be rejected by
ffmpeg or silently misplace the picture. Three bugs were found by running the
generated chains against the bundled binary rather than by reading them:

| Chain | What went wrong | Fix |
|---|---|---|
| scaled | `pad` refuses to shrink a picture larger than its canvas — it failed with `Input area … not within the padded area` | cap each axis with `crop=w='min(iw,W)':h='min(ih,H)'` before the pad |
| rotated | `rotate` emits a bounding-box canvas larger than the output for any angle between 0 and 90°, so the following pad failed the same way | fit to the canvas after the rotate, then pad |
| plain (no geometry at all) | `force_original_aspect_ratio=decrease` rounds **up**, so a 9:16 crop of a 16:9 source came out 1082 px wide; the pad then tore one column off the left and two off the right | the same cap, applied to every `fit` chain |

Ten chains (plain, crop, zoom in, zoom out, legacy framing scale, 90° and 33°
rotation, offset, flip, all combined) were each run through ffmpeg 4.1 on a
1280×720 source and produced exactly 1080×1920 `yuv420p` raw frames — 3 110 400
bytes apiece, with no stderr. A solid red source was then sampled pixel by pixel
to confirm the picture is centred: the plain path fills the frame with no black,
and a letterboxed crop leaves one black column on the left and two on the right,
which is the odd-pixel remainder of an aspect fit rather than the torn edge the
uncapped chain produced.

---

### Blending and colour, checked against real ffmpeg

Layering is composited in software (`packages/compositor/src/composite.ts`) because
the export has raw `yuv420p` frames rather than a DOM. Every blend mode was checked
against the W3C compositing spec's closed form, and the two ends of the pipeline
were measured against the bundled binary. Three findings changed the design:

| Finding | Consequence |
|---|---|
| `blend`'s `all_expr` **silently overrides** `all_mode` — a `multiply` graph and a `normal` graph produced byte-identical output when both also carried an `all_expr` | a mode and an opacity need two separate `blend` stages, never one |
| ffmpeg 4.1's expression language has no blend functions (`multiply(A,B)` → `Unknown function`) | a mode cannot be expressed as an expression at all, so `all_mode` is the only way to get one |
| `-colorspace bt709` only **tags** the output; swscale still converts with **BT.601** by default. Converting RGB→YUV with no `scale` filter gave Y=100 for a colour whose BT.709 luma is 83 | every comparison forces `scale=in_color_matrix=bt709:out_color_matrix=bt709`, and the compositor takes the matrix as an argument instead of assuming one |

A fourth finding came from a test rather than from ffmpeg: fading a *bottom* layer
toward black is correct only when the canvas is black, so a project on a white
canvas exported a frame half as bright as the preview. Every layer is now
composited onto the canvas colour instead, which also means a bottom layer's own
blend mode behaves like any other layer's rather than being ignored.

The compositor's RGB→YUV conversion matches ffmpeg's to within ±3 levels of luma
and ±8 of chroma on a three-colour test card; decoding ffmpeg's own BT.709 and
BT.601 frames comes back within ±4 levels of the original colour.

## 2. Static checks

| Command | Result |
|---|---|
| `pnpm typecheck` | Passes across all 10 packages |
| `pnpm lint` | Design-token audit: 0 hard-coded hex colours, px radii or ms durations in renderer UI |
| `pnpm lint` | No-fakes & determinism audit: passes (no `Math.random()`/`Date.now()` in engine packages, no banned claims) |
| `pnpm --filter @clipwright/desktop build` | Renderer + main + preload build; the main bundle loads under a stubbed Electron |

---

## 3. Export engine (SPEC 14)

### Verified by automated tests

| Behaviour | Evidence |
|---|---|
| Plan is deterministic for the same input | `planId` is FNV-1a over the settings; tests assert stability |
| Encoder arguments match the spec for each combo | `encoder.test.ts`, 231 cases including codec × rate control × hardware |
| Hardware encoders are tested, not assumed | `validateHardwareEncoders` runs a real encode; a candidate that fails is skipped |
| Frame pipeline respects back-pressure | `export-runner.test.ts` writes to a pipe and handles EPIPE |
| Cancellation stops the encoder process | Test asserts the child is gone and the partial file removed |
| The published MP4 really contains the source footage | `export-service.test.ts` exports a moving-bar clip with no frame-source override |
| The published MP4 really contains audio | `export-service.test.ts` exports a tone and asserts the audio stream via ffprobe |
| Audio normalisation lands near −16 LUFS | `audio-mixer.test.ts` measures with ebur128 after gain |
| The limiter holds a −1 dBTP ceiling | `audio-mix.test.ts`, including a deliberately hot mix |
| The limiter is O(n) | A 10-minute clip limits in linear time (the naive version was quadratic) |
| Validation checks 13–14 measure the *produced file* | `export-runner.test.ts` asserts the measured values, not the target values |
| Name clashes never overwrite silently | `export-service.test.ts` asserts `clash 2.mp4` exists alongside `clash.mp4` |
| The temp mix WAV is deleted after publishing | `export-service.test.ts` asserts the cache directory is empty |

### NOT verified

| Gap | Why, and what it needs |
|---|---|
| **Preview and export are not one renderer.** §10 §2.1 asks for a shared WebGL2 `renderFrame`; this build has a CPU compositor for the export and CSS for the preview | The *export* renders captions (generated ASS script), keyframed geometry (per-keyframe segments), layer opacity and blend modes (software blend in linear light), transitions (both clips across the overlap) and the nine required effects — each measured in the produced file by decoding it. The *preview* approximates the effects with CSS filters and names the three it cannot draw. Recorded as `docs/limitations.md` item 7. |
| Frame blending | Not implemented; nearest-time selection is used and documented |
| Hardware encoding on real GPUs | No GPU in this environment. The *validation* logic is tested with fakes; actual NVENC/QSV/AMF output is unverified |
| 4K 60 fps performance | Not benchmarked here; the code path is tested at 320×180 |
| Resumable export | Not implemented (SPEC 14 §9); a failed export restarts |

**Honesty note (fixed while writing this report):** the export dialog previously
said nothing about the compositing gap, so a user who added a title and exported
would only discover the omission by watching the finished file. It now says so
before the export runs, and `export-panel.test.tsx` fails if that note is
removed. `docs/export.md` lists the same limits.

---

## 4. Updates (SPEC 15)

Verified by `update-service.test.ts` (36 tests), `update-core` (135 tests),
`update-journal-store.test.ts` (21), `bin-integrity.test.ts` (11),
`recovery-dialog.test.tsx` (10) and `update-notice.test.tsx` (11):

| Behaviour | Evidence |
|---|---|
| A release with no signature is refused | Test |
| A release signed by an unknown key is refused | Test |
| A manifest edited after signing is refused | Test |
| `latest.yml` disagreeing with the signed manifest is refused | Test |
| A redirect off `github.com` is refused before download | Test |
| A download whose hash does not match is deleted | Test asserts the file is gone |
| Nothing downloads or installs without an explicit action | State-machine tests |
| A build with no embedded key refuses every update | Test — fails closed |
| The CI script's signature verifies with the app's code | `release-roundtrip.test.ts`, real keys |
| The CI script refuses when the secret and embedded key disagree | `release-roundtrip.test.ts` |
| A binary that changed on disk is **disabled**, not run | `bin-integrity.test.ts` asserts the expected and actual digests and that the tool is not enabled (§6.1) |
| A missing or corrupt `checksums.json` reads as unverified, never as fine | `bin-integrity.test.ts` |
| A cancelled install does not send the user to Recovery | `journal.test.ts` — §11, the user is still on the old version |
| One workspace failure does not trigger recovery; the second does | `journal.test.ts`, `update-journal-store.test.ts` (§7.3) |
| A crash state survives to the next launch | `update-journal-store.test.ts` reads it back with a fresh store |
| A corrupt journal is moved aside rather than blocking every launch | `update-journal-store.test.ts` |
| The journal is written atomically | Test asserts the temp-file write and rename |
| Backups copy only the small files, and a failed copy is reported not fatal | `update-journal-store.test.ts` (§7.1) |
| A truncated installer is not cached as a rollback path | `update-journal-store.test.ts` — under 1 MB is refused |
| Cleanup keeps the newest backup until the next success | `update-journal-store.test.ts` (§7.6) |
| The recovery text warns that a migration also rolls back databases | `journal.test.ts` on `recoveryMessage` (§7.5) |
| The update dialog cannot install before backups are taken | `update-service.test.ts` — a failing `prepareInstall` aborts the install |
| The chip and dialog are actually mounted | `update-notice.test.tsx`; the snapshot is reachable from `App` |
| Ctrl+K, Ctrl+N, Ctrl+, and Ctrl+/ do what the cheat sheet says | `command-palette.test.ts` drives the real dispatch handler; `shortcut-sheet.test.tsx` covers the sheet |
| Shortcuts that are listed but not implemented say so | `shortcut-sheet.test.tsx` — Ctrl+O and Ctrl+S are marked rather than implied |
| An export's history row is written before `whenIdle()` resolves | `export-service.test.ts` — a race that made history intermittently miss the export that had just finished |
| A portable build refuses to install its own update, and says to swap the file | `update-service.test.ts` (§6.3); the guard sits before preparation so no journal entry claims an install started |
| A download resumes from a `.part` file left by an interrupted run | `update-service.test.ts` asserts the `Range` header and a byte-identical result (§11) |
| A resumed download is discarded when the server ignores Range | `update-service.test.ts` — a 200 response drops the prefix rather than concatenating it |
| A `.part` file bigger than the installer is ignored | `update-service.test.ts` |
| An offline machine says "check your internet connection", not "couldn't be completed" | `state.test.ts` on the real `TypeError: fetch failed` shape, including the reason hidden in `cause` (§11) |
| A file held open by antivirus maps to the security-software wording | `state.test.ts` — EBUSY (§11) |
| yt-dlp updates are checked weekly, not on every launch | `ytdlp.test.ts`, clock injected (§9) |
| A manual yt-dlp check ignores the weekly schedule | `ytdlp-service.test.ts` asserts the network is called |
| A yt-dlp download whose digest is wrong cannot displace a working binary | `ytdlp-service.test.ts` reads the old file back byte-for-byte |
| An unverified or older user copy never shadows the bundled one | `ytdlp.test.ts` on `chooseYtDlpBinary` |
| A refused yt-dlp download never asks for a backup | `ytdlp.test.ts` — `keepBackup` is false on failure |
| yt-dlp is installed into user data, never the install directory | `ytdlp-service.test.ts` asserts the bundled file is unchanged (§9) |
| "Restore bundled version" refuses to remove the only working binary | `ytdlp-service.test.ts` |

### NOT verified

| Gap | Why |
|---|---|
| CI has passed on Windows | **Yes, run 42442804025** on `windows-latest`: install from the lockfile, `pnpm verify` (lint, typecheck, 1090 tests, both bundles, `check-repo`), the third-party-notice check, the launchable-package check and the gitleaks scan — every step green. This was the first green run: before it, `ci.yml` had never executed at all, because two pinned action SHAs resolved to no commit |
| CI catches Windows-only breakage | That green run is the evidence, not the claim: the first executions found six defects that Linux could not (three path-handling bugs in the checks and tests, two ffmpeg-dependent suites with no platform guard, and a line-ending assumption), each now fixed |
| A packaged Windows installer has been produced | No installer exists here: `electron-builder` needs the Electron binary and the Windows toolchain, and neither can be downloaded in this environment (`Cannot compute electron version from installed node modules`). The app bundle itself is built and verified; the packaging step after it never ran |
| `electron-builder` has ever completed | **Never, in any environment.** It now gets as far as reading the config (`loaded configuration … electron-builder.yml`) and pinning `electronVersion=34.2.0`, then fails cross-compiling `better-sqlite3` from Linux — `node-gyp does not support cross-compiling native modules from source`. The release workflow runs on `windows-latest`, where that step is native, so the configuration is no longer what stands in the way; the Windows toolchain is |
| A real GitHub release, end to end | No published release exists yet; the tests use a fake network with real cryptography |
| `electron-updater` driving an actual download | `electron-updater` is injected and faked in tests; the real library is exercised only in a packaged build |
| Installing an update and relaunching | Needs Windows and a published release |
| The embedded key is a placeholder | Updates are **refused** by design until a real key is embedded |
| `resources/bin/checksums.json` does not exist | The runtime verifier is tested with fixtures; the real file cannot be produced here because the binaries cannot be downloaded (see §5) |
| The Recovery window has not been seen in a running app | Rendered under jsdom with every state; the main-process wiring around it is unit-tested but has never run inside Electron |
| The 60-second boot confirmation has not timed out in a real launch | The state machine and the timer are tested with a fake clock; nothing here has waited 60 seconds for real |
| yt-dlp has never been downloaded from GitHub here | The service is tested against a fake network holding real SHA-256 digests; no real release asset was fetched or executed |
| The yt-dlp version reported in Settings has not been read from a real binary | `readVersion` runs `yt-dlp --version`; in tests it is injected, because the bundled files here are Linux symlinks |

---

## 5. Packaging and release (SPEC 15)

| Check | Result |
|---|---|
| `electron-builder.yml` parses, 12 top-level keys, no duplicates | Checked |
| `assets/icon.ico` has 16/24/32/48/64/128/256 px frames | Verified by parsing the ICO header |
| Every script a workflow runs is tracked by git | `scripts/check-repo.mjs`, in `pnpm lint` — written after nine release scripts turned out to be outside the repository |
| Ignore rules cannot swallow source | Same check: an unanchored `release/` pattern is rejected by name |
| In-window navigation is decided by URL origin, not by prefix | `security.test.ts` — `http://localhost:5173@evil.example/` is blocked; the dev origin is accepted only in a development build (§12.12) |
| A packaged build trusts only its embedded key, whatever the environment says | `update-config.test.ts` — the override is honoured for tests and local builds, ignored when `app.isPackaged` (§5) |
| A build with no embedded key refuses every update | `update-config.test.ts` — `hasUsableKeys` is false for the shipped placeholder |
| A redirect to a look-alike host is refused | `update-config.test.ts` — `github.com.evil.example` is rejected; the check compares hostnames, not substrings |
| The unsigned notice is on every surface §6.4 names | `check-repo` asserts it in README, the update dialog, the release-notes generator and the release docs (acceptance item 10's automated string check) |
| Generated release notes carry the unsigned notice | The generator appends it, and drops it only when `--signed` is passed after a certificate was used |
| Every relative documentation link resolves | Same check, 17 documents |
| No module is reachable only from its tests | `check-repo` — written after `main/ipc.ts` turned out to export six shortcuts with empty handlers that only a test could reach |
| The renderer imports no main-process code | Same check, added after two modules had drifted across the boundary |
| No renderer dependency reaches a `node:` builtin | Same check, following the import graph including workspace packages. Added after the production build failed on `node:crypto` while 1063 tests and `tsc` passed |
| **The application actually builds** | `pnpm build` produces `dist/main/index.cjs` and `dist/renderer/index.html`; `pnpm verify` runs lint, typecheck, tests, build and the repo check in that order |
| The signed manifest verifies with only the embedded key | Rehearsed end to end outside CI with a fresh key pair over real files: signature, per-file digests, `SHA256SUMS.txt`, `latest.yml` cross-check, and a single flipped byte rejected |
| Main process builds to `dist/main/index.cjs` | Yes; 561 KB across 12 files, loads under stubbed Electron |
| Renderer uses relative URLs (`file://` safe) | `index.html` references `./assets/...` |
| `assert-package.mjs` catches a package with no installer | Yes — exits 1 on this checkout, naming the missing artefacts |
| `assert-package.mjs` catches a package missing its native module | Yes — proven against a synthetic package tree: a stripped `better-sqlite3`, a missing `app.asar.unpacked`, and a corrupt asar each exit 1 with a specific message; the healthy tree passes |
| `verify-binaries.mjs` catches unpinned hashes | Yes — exits 1, naming all three binaries and the missing `checksums.json` |
| `extract-notes.mjs` produces notes from the CHANGELOG | Yes; refuses a version that has no section |
| `make-manifest.mjs` signs and self-verifies | Yes, with real keys over real files |
| Release scripts are actually in the repository | Yes — and this was **not** true before: an unanchored `.gitignore` pattern (`release/`) excluded all nine of them. `scripts/check-repo.mjs` now fails if a workflow references an untracked script. |
| `gen-update-key.mjs` generates a usable pair | Yes |
| **The whole chain end to end with a real key** | Rehearsed: generated a key pair, built fake artefacts, extracted the CHANGELOG notes, signed the manifest, then verified the output with the app's own code — signature, both digests per file, `SHA256SUMS.txt`, `latest.yml` cross-check, and rejection of a single flipped byte. |

### NOT verified

| Gap | Why |
|---|---|
| **A real Windows installer was never built here.** | This environment is Linux. electron-builder's NSIS target needs Windows (or Wine). The configuration, the build pipeline and the assertions are all in place and tested on Linux up to the point where Windows is required. |
| **`resources/bin` holds Linux symlinks and no pinned hashes.** | `verify-binaries.mjs` refuses to package them, correctly. Real Windows binaries must be fetched and their digests reviewed. |
| Install → launch → export → uninstall on a clean VM | Needs Windows; `smoke-install.mjs` implements the steps but skips off Windows |
| Code signing | No certificate; everything says "unsigned" |

---

## 6. User interface

Renderer tests run in jsdom with Testing Library (137 tests). What that covers
and what it does not:

| Covered | Not covered |
|---|---|
| The update dialog shows the unsigned notice | Pixel-level layout |
| "Install and restart" is absent before verification | Real Electron window behaviour |
| The export dialog assembles the right plan | Drag interactions in the editor |
| The queue panel distinguishes active from queued jobs | Screen readers (no automated a11y suite) |
| Progress reflects reported values, not animation | — |

No Playwright browser binaries are available in this environment, so there is no
end-to-end UI test here. `pnpm test:e2e` is wired up for an environment that
has them.

---

## 7. How to reproduce

```bash
corepack enable && pnpm install
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm --filter @clipwright/desktop build
node scripts/release/assert-package.mjs    # expected to fail without Windows packaging
node scripts/release/verify-binaries.mjs   # expected to fail until binaries are pinned
```

The last two failing is the current, correct state: they fail for real reasons
that are listed above, not because they are stubs.
