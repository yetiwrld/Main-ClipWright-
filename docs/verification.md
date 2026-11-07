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
Test Files  44 passed (44)
     Tests  993 passed (993)
```

| Area | Tests | What they actually check |
|---|---:|---|
| `packages/export-core` | 231 | Encoder arguments, plan determinism, validation rules, audio mix DSP, presets |
| `apps/desktop/src/main` | 222 | Export service, queue, ffmpeg orchestration, audio mixing, updates, journal, binary integrity, releases, packaging |
| `apps/desktop/src/renderer` | 170 | Export dialog, queue panel, update dialog, update notice and chip, recovery dialog, command palette (jsdom) |
| `packages/ai-core` | 120 | Provider clients, scoring, connectivity |
| `packages/update-core` | 135 | Version rules, manifest verification, signatures, update state machine, journal and recovery text |
| `packages/timeline-engine` | 92 | Commands, invariants, undo/redo |
| `packages/media-core` | 11 | Probing, peaks, path resolution |
| `packages/project-schema` | 8 | Schema validation and migration |
| `packages/design-system` | 4 | Component contracts |
| **Total** | **993** | 44 files |

### Tests that run real processes

These are not mocks, and that distinction matters — a test that fakes ffmpeg
cannot tell you whether the ffmpeg arguments are right.

| Test file | Runs |
|---|---|
| `__tests__/ffmpeg-runner.test.ts` | Bundled `ffmpeg`/`ffprobe`: probing, decoding, loudness, black/freeze detection |
| `__tests__/export-runner.test.ts` | A complete encode end to end, then validates the produced file |
| `__tests__/export-service.test.ts` | Real footage through the service: published file, audio stream, temp cleanup |
| `__tests__/audio-mixer.test.ts` | Real PCM decoding, mixing, EBU R128 measurement, normalisation |
| `__tests__/decode-frame-source.test.ts` | Per-item decoders over real clips |
| `__tests__/release-roundtrip.test.ts` | The real signing script, verified with the app's own verification code |
| `__tests__/smoke-test.test.ts` | The real bundled binaries, reporting their real versions |

Bundled tooling in this environment is **ffmpeg 4.1** (a 2018 build). That is a
deliberate constraint: if the code works on the oldest build we might ship, it
works on newer ones. Capability detection (`-vsync cfr` vs `-fps_mode`) exists
because of it.

---

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
| **The compositor is not in the export path.** Text, effects, transitions, keyframed transforms and blend modes are not rendered | Each item is decoded and the topmost visible one is shown. `renderFrame` exists and is tested separately; wiring it into the frame producer is the next phase. Disclosed in the export dialog itself, in `docs/limitations.md`, and locked by a renderer test. |
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

### NOT verified

| Gap | Why |
|---|---|
| A real GitHub release, end to end | No published release exists yet; the tests use a fake network with real cryptography |
| `electron-updater` driving an actual download | `electron-updater` is injected and faked in tests; the real library is exercised only in a packaged build |
| Installing an update and relaunching | Needs Windows and a published release |
| The embedded key is a placeholder | Updates are **refused** by design until a real key is embedded |
| `resources/bin/checksums.json` does not exist | The runtime verifier is tested with fixtures; the real file cannot be produced here because the binaries cannot be downloaded (see §5) |
| The Recovery window has not been seen in a running app | Rendered under jsdom with every state; the main-process wiring around it is unit-tested but has never run inside Electron |
| The 60-second boot confirmation has not timed out in a real launch | The state machine and the timer are tested with a fake clock; nothing here has waited 60 seconds for real |

---

## 5. Packaging and release (SPEC 15)

| Check | Result |
|---|---|
| `electron-builder.yml` parses, 12 top-level keys, no duplicates | Checked |
| `assets/icon.ico` has 16/24/32/48/64/128/256 px frames | Verified by parsing the ICO header |
| Every script a workflow runs is tracked by git | `scripts/check-repo.mjs`, in `pnpm lint` — written after nine release scripts turned out to be outside the repository |
| Ignore rules cannot swallow source | Same check: an unanchored `release/` pattern is rejected by name |
| Every relative documentation link resolves | Same check, 17 documents |
| The renderer imports no main-process code | Same check, added after two modules had drifted across the boundary |
| The signed manifest verifies with only the embedded key | Rehearsed end to end outside CI with a fresh key pair over real files: signature, per-file digests, `SHA256SUMS.txt`, `latest.yml` cross-check, and a single flipped byte rejected |
| Main process builds to `dist/main/index.cjs` | Yes; 561 KB across 12 files, loads under stubbed Electron |
| Renderer uses relative URLs (`file://` safe) | `index.html` references `./assets/...` |
| `assert-package.mjs` catches a package with no installer | Yes — exits 1 on this checkout, naming the missing artefacts |
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
