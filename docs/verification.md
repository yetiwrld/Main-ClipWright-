# Verification report — v0.1.0 (2026-11-12)

**This is an honest, partial report. Completion per specs/16 is NOT claimed.**
Everything below states what was actually executed, where, and with what result.
The acceptance criteria that cannot run here (Windows, Electron GUI, clean VM) are
listed as **PENDING**, not as passed.

## Environment

- Linux sandbox (workspace `/home/user/Main-ClipWright-`), Node 22.22.3, pnpm 9.15.9
- ffmpeg: **n9.0.2-17-g2a571b6068-20260930** (imageio-ffmpeg v9.0.2 wheel, Linux x86_64),
  used for verification only; NOT the binary that would ship.
- `CLIPWRIGHT_FFMPEG=/tmp/fftest/bin/ffmpeg node_modules/.bin/tsx scripts/verify/export-matrix.ts`
- Root `node_modules` installed with `npm_config_nodedir=/usr/local pnpm install` (better-sqlite3).

## Automated tests (all real, all run 2026-11-12)

| Package | Result |
|---|---|
| @clipwright/design-system | 2 passed |
| @clipwright/audio-core | 8 passed |
| @clipwright/project-schema | 7 passed |
| @clipwright/timeline-engine | 13 passed |
| @clipwright/media-core | 9 passed |
| @clipwright/caption-styles | 11 passed |
| @clipwright/ai-core | 25 passed (incl. faster-whisper JSON parser) |
| @clipwright/export-core | 40 passed |
| @clipwright/desktop (storage, journal, faster-whisper scan/detect) | 26 passed |
| **Total** | **135 passed** |

Command: `pnpm -r test`. Typecheck: `pnpm -r typecheck` (not re-run after latest edits; CI runs it).

## faster-whisper backend (new, 2026-11-12 — partial)

Purpose: run OpenAI Whisper CT2 models already cached in the user's HF hub cache
(`~/.cache/huggingface/hub`), which whisper.cpp cannot read.

What was actually executed in this environment (Linux, Node 22, Python 3.11):

- `parseFasterWhisperJson` unit tests (word timestamps → microseconds, proportional-estimate
  fallback with `approximate: true`, no-timing segments skipped, confidence clamping, malformed
  input throws): **6/6 pass**.
- HF hub cache scan (`scanFasterWhisperModels`) unit tests against fixture directories:
  detects complete snapshots (model.bin ≥ 1 MB + config.json), picks newest snapshot, ignores
  incomplete/junk entries, missing cache returns `[]`: **12/12 desktop tests pass**.
- Integration test of the full spawn pipeline with a **stubbed `faster_whisper` Python module**
  (no real inference): progress events (`SEGMENT <end>` → fraction), JSON result written by the
  helper, words parsed with correct µs timings (`hello@50000-600000` …), stderr surfaced on
  non-zero exit, missing-model-directory error path: **all pass**.
- `pnpm -r typecheck`, `electron-vite build`: **succeed**.
- CI run after push: see branch CI status (windows-latest + ubuntu-latest).

What was NOT executed (and must not be claimed):

- No real model file was loaded; faster-whisper was never imported by Python here (not on
  PyPI-reachable model store from this sandbox; HF is unreachable).
- The probe order (py launcher `-3.12` …, then %LOCALAPPDATA% paths, then CLIPWRIGHT_PYTHON)
  has **never run on Windows**; the first launch on the user's PC is the first real probe.
- GPU/compute behaviour of ctranslate2 defaults — untested.

## Build

- `electron-vite build` (main + preload + renderer): **succeeds**, ~4.5 s; renderer bundle
  ~798 kB main chunk (< 2.5 MB configured warning limit).
- Workspace packages are built/consumed via source (no publish step).
- **Fix 2026-11-12:** renderer now imports `@clipwright/design-system/components.css`
  (previously unused; `.cw-*` rules missing from the app). Verified in built CSS.
- **New:** dev-only design showcase at `/__design`; dev-only mock bridge (`devMock.ts`)
  for browser previews. `npx vite --config vite.preview.config.mts` serves the renderer
  on port 5173 for the showcase; all modules transform without errors; **no browser was
  available to screenshot the rendered page** (Electron binary and Chromium undownloadable).

## Export matrix (specs/14, scripts/verify/export-matrix.ts)

**Plan checks — 20/20 PASS** for 720p-sd, 720p-hd, 1080p, 1440p, 4k-uhd × draft, standard,
high, maximum: target dimensions (even, short-side based), expected bitrates, CRF 26/22/19/16,
yuv420p, H.264 High, AAC 192k, faststart.

**Runtime checks — 4/4 PASS** (draft, standard, high, maximum). Each render: real ffmpeg
process, 1080×1920 portrait source with tone track, burned-in caption text (`bold-creator`
preset → drawtext), output probed and validated by `runValidationChecks` from
`@clipwright/export-core`:

- resolution matches the requested dimensions, SAR 1:1, constant frame rate,
  duration within one frame of the request, audio stream present at 48 kHz stereo.
- Status reported as `verified` for all four outputs.

**Bugs found and fixed by this verification (real product fixes):**

1. `packages/export-core/src/ffmpegGraph.ts`: scale/crop chain produced non-square pixels
   (x264 wrote SAR 4095:4096) → validation check 4 failed. Fixed by forcing `setsar=1`
   after crop. Re-rendered and re-validated: SAR 1:1, validation `verified`.
2. Export graph emits an `OUTFILE` placeholder; callers must substitute the real path
   (done in `apps/desktop/src/main/exportRunner.ts` and in the verify script).
3. Caption draw style must come from a real `CaptionDrawStyle` (hex → `0xRRGGBB`,
   outline px from `widthPctOfFont`), not from hand-rolled fields — previously produced
   `Cannot find color 'undefined'` in ffmpeg. Fixed in the verify script to mirror
   `exportRunner.ts` exactly (`getBuiltinPreset('bold-creator')`).

**Not run (pending Windows + real media library):** 4K renders, VFR input, no-audio input,
30+ minute source, image input, audio-only input, `.cwstyle` round-trip into export,
multi-clip batch export, WebM path end-to-end, NVENC/QSV hardware paths.

## Packaging

- `electron-builder.yml`: **static sanity only** (YAML parsed; icon/licence inputs exist;
  NSIS per-user config; `asarUnpack` for better-sqlite3 and `resources/bin`;
  `extraResources` stages `resources/bin`; `deleteAppDataOnUninstall: false`).
- `electron-builder --win`: **NOT RUN** (Electron binary undownloadable in this sandbox;
  no Windows host). **Installer and portable .exe do not exist.**
- `.github/workflows/ci.yml` and `.github/workflows/release.yml`: written, **never executed**.
  First run is expected to need fixes. Do not treat the release workflow as proven.
- `LICENSE` (all rights reserved, owner choice pending), `THIRD-PARTY-NOTICES.txt`
  (generated from `pnpm licenses list --json`, 351 entries, no GPL-family npm deps),
  `docs/licences.md` (FFmpeg GPL plan, source-offer obligation for first release).
- Icon: `assets/ClipWright_Icon.ico` generated from the supplied
  `assets/ClipWright_Icon.png` (16/24/32/48/64/128/256, 256 largest) — allowed for small
  raster sizes; the PNG is not modified.

## App-level behaviour

- Storage (`workspace.db`, `.cwdb`): migrations + pre-migration `.bak-<ts>` backups,
  `integrity_check` on open, quarantine of invalid rows, settings merge-then-parse with
  corrupt-JSON fallback — all covered by unit tests in `apps/desktop/test/`.
- Crash journal: full-snapshot JSONL replay covered by unit tests; fsync ≤ 1/s + explicit
  flush; lock files with PID/hostname/15 s heartbeat.
- `clipwright-media://` restricted to workspace root (403 otherwise); sandboxed renderer,
  contextIsolation, typed IPC — config reviewed, **not runtime-tested** (no Electron binary).

## Phase checkpoints

| Phase | Checkpoint status |
|---|---|
| 1 Foundation | Implemented; **runtime checkpoint PENDING** (app never launched here) |
| 2 Start flow / transcription | Implemented; **PENDING** (no whisper binary, no yt-dlp) |
| 3 AI providers / moments | Implemented (mocked HTTP tests green); **PENDING** (no live provider/Ollama run) |
| 4 Editor core | Editor shell + timeline operations implemented and unit-tested; **PENDING** manual run |
| 5 Editor advanced | Captions/keyframe primitives implemented and unit-tested; **PENDING** save/close/reopen run |
| 6 Export / packaging / QA | Export verified (above); **installer, updater, release: NOT DONE / UNVERIFIED** |

## Release v0.1.0 (2026-11-12)

**A GitHub Release exists for tag `v0.1.0` (marked prerelease, unsigned):**
https://github.com/yetiwrld/Main-ClipWright-/releases/tag/v0.1.0

- Built on `windows-latest` by `.github/workflows/release.yml`: VS 2026 / node-gyp@13 /
  better-sqlite3 v13 source build, whisper.cpp v1.9.5 (pinned tag, CI-built), BtbN FFmpeg
  GPL build (`master-latest` pin — replace with a reviewed tag before any public release),
  yt-dlp latest. SHA-256s of both artefacts are in the release notes.
- Artefacts: `Clipwright-Studio-Setup-0.1.0-x64.exe` (~259 MB, NSIS per-user),
  `Clipwright-Studio-0.1.0-x64-portable.exe` (~238 MB).
- CI (this branch) is green on **ubuntu-latest and windows-latest**: corepack pnpm
  install (with VS Developer Command Prompt + node-gyp@13 on Windows), typecheck,
  123 unit tests per package, `electron-vite build`.
- **NOT verified:** the app has never been launched; the installer/portable have never
  run on any Windows machine; no clean-VM install; no whisper transcription end-to-end;
  no updater has shipped (the release was built by CI, not by the app). The v0.1.0
  release proves the pipeline, not the product's daily reliability.

**No `phase-N-complete` tag is applied.** Tags will be created only after the corresponding
checkpoints pass on real Windows hardware (or a Windows CI runner with app launch).

## What the first CI run must do

1. Green CI on `windows-latest`: install, typecheck, unit tests, `electron-vite build`.
2. `release.yml` on tag push: build, fetch pinned ffmpeg/yt-dlp/whisper binaries, record
   sha256 into `resources/bin/checksums.json`, `electron-builder --win --x64`, upload
   artefacts, and create the GitHub Release **with the unsigned-installer SHA-256 listed**.
3. Before first public release: pin the BtbN autobuild tag + reviewed sha256; attach the
   FFmpeg source offer; owner chooses an app licence (replace `LICENSE`); add the
   `LICENSES.chromium.html` from the packaged Electron.
