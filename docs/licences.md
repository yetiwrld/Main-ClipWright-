# Third-party licences

**Status: draft, dated 2026-11-12.** No release has ever been produced, so this file
documents the licensing *plan* and the licences of what is actually built/verified.
Where a binary is not bundled yet, that is stated plainly.

## FFmpeg (bundled in release builds)

- **Decision (v1): GPL build including libx264 and libvpx, with libopus and the native
  AAC encoder (`aac`), plus libmp3lame.** Chosen because libx264 (H.264) is required to
  meet the export-engine spec; an LGPL build cannot ship libx264.
- Distribution model: **separate executable** (`ffmpeg.exe` / `ffprobe.exe`), never linked
  into the Electron binary.
- Source: **BtbN/FFmpeg-Builds** Windows x64 GPL release
  (`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip`).
  The `latest` pin is deliberate until a maintainer reviews and pins a specific autobuild
  tag + sha256 in `apps/desktop/resources/bin/checksums.json`. The release workflow records
  the sha256 at build time; the app is expected to verify it at first run (not yet enforced — see `docs/limitations.md`).
- **Corresponding source offer:** the GPL requires that the complete corresponding source of
  the FFmpeg build be offered. The release notes and About → Third-party notices must link to
  `https://ffmpeg.org/download.html` and the exact BtbN autobuild tag used, and must include:
  "This product uses FFmpeg, licensed under the GNU General Public License v2 or later.
  Source code: https://github.com/FFmpeg/FFmpeg and the exact BtbN build configuration."
  A written offer (valid 3 years) will accompany the release notes of the first published build.
- **H.265/HEVC:** the chosen BtbN GPL build may include libx265. If shipped, the UI must label
  it "may require patent licences in some regions" (informational, not legal advice). v1 targets
  H.264 only; HEVC export is disabled in the UI until reviewed.
- The exact `ffmpeg -buildconf` output will be captured and pasted here by the release
  workflow on first successful run. (Not available now — no release binary has been produced.)

## FFmpeg — what this repository actually used

For development verification only, this workspace used **ffmpeg 9.0.2** from the
`imageio-ffmpeg` PyPI wheel (Linux x86_64). That binary is **not** shipped in the app.

## whisper.cpp

- MIT licence. Planned: CI-built `whisper-cli` from a pinned tag, CPU baseline + AVX2
  variants, placed in `resources/bin/`. **Not bundled yet**; the app shows
  "whisper binary not found" and guides the user rather than inventing output.
- Whisper model files (`ggml-*.bin`) are downloaded on demand from the whisper.cpp model
  store by the app; each model is MIT/Apache-2.0-family per the whisper.cpp project; sizes
  are listed in Settings → Local models. Models are never bundled in the installer
  (bundle-size budget; models are user-downloaded).

## yt-dlp

- **Unlicense** (public-domain-equivalent dedication). Planned: bundled standalone `yt-dlp.exe`
  from yt-dlp GitHub Releases, updated via the app's checksum-verified updater (not implemented yet).
  **Not bundled yet.**

## Electron / Chromium

- Electron is MIT-licensed. Chromium under it carries its own notices; the installer must
  include `LICENSES.chromium.html` from the Electron distribution. `electron-builder` includes
  the Electron licence automatically when packaging; the Chromium notices file gets copied into
  the app resources on the first release build (release workflow step, not yet executed).

## Fonts

- `@fontsource/manrope` (Manrope, OFL-1.1) — bundled via npm; OFL-1.1 permits bundling with
  the font files unmodified and notices included. Manrope's licence text ships with the package.

## Node / npm dependencies

- See `THIRD-PARTY-NOTICES.txt` (generated 2026-11-12 via `pnpm licenses list --json`):
  351 entries. All detected licences: MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD,
  BlueOak-1.0.0, CC-BY-4.0, OFL-1.1, Python-2.0, WTFPL, (MIT OR CC0-1.0), (WTFPL OR MIT),
  WTFPL OR ISC — no proprietary, no GPL-family npm dependency found.
- `pnpm licenses list` should be re-run on every release; unknown/incompatible licences
  should fail CI (not yet wired as a gate — documented in `docs/limitations.md`).

## Clipwright Studio itself

- The app licence is **not chosen yet**. Default per project decision: **All rights reserved —
  see README** (`LICENSE` at the repository root). The owner must choose a licence before
  public distribution. See `docs/decisions.md`.
