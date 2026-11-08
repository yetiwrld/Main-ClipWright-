# Where the project is

Written in plain language, for anyone picking this up. It is a summary, not a
replacement for `docs/verification.md` (what has been proven) and
`docs/limitations.md` (what is knowingly missing).

Last updated after commit `e29287c`. 1090 automated tests, all passing.

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
| **5 — Editor advanced** | Captions UI, text/graphics, keyframes, effects, transitions, audio tools, AI editing tools, brand kits | ❌ Not built |
| **6 — Export, updates, packaging** | Export engine, queue, updates, installer, GitHub release, docs | ⚠️ Built, one big gap (see below) |

So: **three phases fully done, two partial, one not started.**

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

**Phase 5 is built, minus the style editor.** The last sessions finished the
caption engine, the frame builder, the preview overlay, the caption list and the
per-word editor, and put styled captions into the export path:

- `packages/caption-styles` — the `.cwstyle` v1 schema, ten presets, resolution.
- `packages/compositor` — `layoutText` (where words go) and `captionFrameAt` (what
  they look like at an instant): karaoke sweeps, word-by-word, keyword emphasis,
  palette cycling, in/out and per-word animation.
- The editor — a Captions tab listing every caption in order with an `edited` chip,
  click-to-emphasise per word, and a canvas overlay in the preview painted by the
  same code the export uses.
- The export — ffmpeg burns the captions in from a generated ASS script, so the
  file matches the preview.

Still open in Phase 5: the full style editor (colour pickers, anchor grid, drag on
canvas), text and shape items, brand kits, and the audio tools in `audio-core`.

**Phase 4 is unfinished in specific ways**, all listed in `docs/limitations.md`:
no transform/opacity/crop editing in the inspector, playback clock is not
audio-mastered, and the preview does not switch to proxies (so scrubbing 4K is
slow).

**Phase 6's export is incomplete in one important way.** Captions are rendered;
the rest of the video compositor is not. Each video/image item is decoded
separately and the topmost visible item is written out, so effects, transitions,
keyframed transforms and blend modes are **not rendered into the exported file**.
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

**1. Finish Phase 4 ⚠️** — small, well-defined gaps: inspector controls,
proxy playback.

**2. Finish Phase 5 ⚠️** — the style editor dialog, text and shape items, brand
kits, and the audio tools (`audio-core` is still a placeholder). Captions
themselves are done: engine, frame builder, preview, list, word editor, burn-in.

**3. Make the export render the rest of the timeline** — the video compositor:
effects, transitions, keyframed transforms and blend modes. Captions already
render; this is the remaining half, and it is what stops the editor offering
things the export cannot show.

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

That runs lint, typecheck, all 1090 tests, builds the app, and runs the repository
checks. It should end with `check-repo: OK`. CI runs exactly the same command on
Windows, so a local pass and a CI pass mean the same thing — which was not true
before this session.
