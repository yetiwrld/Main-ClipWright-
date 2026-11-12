# Known limitations — as of 2026-11-12 (v0.1.0, unreleased)

Everything in this file is a real, current limitation. Nothing here is hidden by
wording elsewhere in the docs; `README.md` links back here.

## Cannot be verified in the current build environment

1. **Electron app launch.** The Electron 45 binary cannot be downloaded in this sandbox
   (TLS reset to `*.githubusercontent.com` CDN). The app has therefore **never been
   launched here**. `pnpm dev` is expected to work on a normal machine/Windows but is untested.
2. **Windows installer / portable build.** electron-builder is configured
   (`apps/desktop/electron-builder.yml`, validated for YAML sanity only) and CANNOT be run
   here: no Windows host, and the Electron binary is missing. The installer has never been
   produced or installed on a clean machine. **Do not claim otherwise.** The CI release
   workflow is written but has not executed yet — its first run may fail and is unproven.
3. **Clean-machine install.** Untested (no VM available).
4. **Real whisper transcription.** Untested end-to-end: no whisper-cli binary was available
   in this environment. The code path is honest (fails with a clear error when missing) but
   has not produced a transcript.
5. **URL downloads via yt-dlp.** yt-dlp is not bundled and not present; the run is untested.
6. **AI provider calls.** Ollama/OpenAI-compatible paths are unit-tested at the HTTP-client
   level (mocked); no live provider call was made here.
7. **Playwright / E2E GUI tests.** Not written; the app has not run. Spec §8 mandates them
   for completion; they are a prerequisite before any `phase-N-complete` tag is applied.

## Not implemented (explicitly, by decision)

- `.cwpack` project export/import; `.cwbrand` brand kits; `.cwstyle` file import/export
  (parse-only); `peaks.bin` waveform cache; auto-update system (check/download/install/rollback);
  referenced-media relink UX; ARM64 build; H.265/HEVC export; GPU-accelerated render.
- **Checksum enforcement at runtime** for bundled binaries (specs/15 §6.1): the staging dir
  and `checksums.json` exist, but the first-run verification step is not wired yet.
- **License gate in CI** (fail on unknown/incompatible licence): notices are generated
  manually via `pnpm licenses list --json`; not yet enforced by automation.
- **In-app Help/About third-party viewer** and ffmpeg buildconf capture: pending first release build.

## Verified (with evidence) — keep this list exact

- `pnpm -r test`: all packages green (design-system 2, audio-core 8, project-schema 7,
  timeline-engine 13, media-core 9, caption-styles 11, ai-core 19, export-core 40,
  apps/desktop 14) on Linux.
- `electron-vite build` (main, preload, renderer) completes without errors.
- Export matrix (`scripts/verify/export-matrix.ts`): plan checks 20/20 PASS; 4/4 runtime
  render checks (draft/standard/high/maximum; 1080×1920, caption-burned) produce real files
  that pass §19.6-style validation (`verified`) with a real ffmpeg (9.0.2, Linux). Output is
  NOT equivalent to spec §16's full pass (no 4K/VFR/no-audio/long-file cases run).
- `setsar=1` fix verified by re-render (SAR 1:1) and by the full test suite.

## Data safety notes

- Workspace and `.cwdb` files: migrations take a `.bak-<ts>` backup first; integrity_check on
  open; invalid rows are quarantined. These paths are unit-tested but have never run against
  a real user project on Windows.
- Uninstall never deletes the workspace by design (`deleteAppDataOnUninstall: false`, and the
  NSIS config never targets user data). Untested on real uninstall.

## Release-engineering notes

- FFmpeg bundling plan: BtbN GPL build (libx264) as separate executables in
  `resources/bin/`, pinned in `apps/desktop/resources/bin/README.md`; the `latest` pin must
  be replaced with a tagged autobuild + reviewed sha256 before the first public release.
- Source offer for FFmpeg GPL compliance is owed **with the first release notes** — see
  `docs/licences.md`. If no release ships, there is nothing to offer yet.
- ARM64 Windows and HEVC are out of scope for v1.
