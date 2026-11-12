# Release process

**Status (2026-11-12): no release has ever been produced. This document describes the
intended process; nothing in it is proven yet.**

## One-time setup (maintainer)

1. Choose the app licence → replace `LICENSE` (also NSIS licence page and README).
2. Review the BtbN FFmpeg-Builds autobuild tag to pin; put the URL in
   `.github/workflows/release.yml` and its reviewed sha256 in
   `apps/desktop/resources/bin/README.md` once known. The default `latest` pin is NOT
   acceptable for a public release.
3. (Optional) Signing: add `CSC_LINK` and `CSC_KEY_PASSWORD` secrets; the release workflow
   signs automatically when they exist. Without them the build is unsigned and the docs say so.
4. Create the GitHub release workflow run by pushing a tag `v*` (e.g. `v0.1.0`) or by
   `workflow_dispatch`.

## What the release workflow does (.github/workflows/release.yml)

1. `windows-latest` runner: setup Node 22 + pnpm 9.15.9, `pnpm install --frozen-lockfile`.
2. `pnpm -r typecheck && pnpm -r test` — gate.
3. Fetch bundled binaries:
   - FFmpeg GPL archive (BtbN) → `ffmpeg.exe`, `ffprobe.exe`
   - yt-dlp.exe → from yt-dlp GitHub Releases (latest)
   - whisper.cpp: clone at a pinned tag, `cmake -B build && cmake --build --config Release`,
     copy `whisper-cli.exe` (x64). AVX2 variant: separate build with `-march=haswell` if
     the tag supports it; otherwise ship the baseline only and say so.
4. `scripts/release/gen-checksums.mjs` writes `resources/bin/checksums.json` (sha256 per file).
5. `electron-vite build` → `electron-builder --config electron-builder.yml --win --x64`.
6. Artefacts: `Clipwright-Studio-Setup-<version>-x64.exe`,
   `Clipwright-Studio-<version>-x64-portable.exe`.
7. SHA256 of both artefacts is printed and embedded in the release notes.
8. GitHub Release is created from the tag with `gh release create` and the unsigned notice.

## Integrity story (per specs/15 §5)

- sha512 in `latest.yml` is produced by electron-builder; electron-updater would verify it
  — but the updater is NOT implemented in v0.1.0. Manual downloads must verify the
  SHA-256 published in the release notes.
- Signed `release-manifest.json` + Ed25519 signature (`UPDATE_SIGNING_KEY`) is planned but
  not implemented; there is no in-app update path to attack yet.

## After the first release

- Publish SHA-256s in the release notes and in `docs/releases/<version>.md`.
- Attach the FFmpeg corresponding-source offer text (see `docs/licences.md`).
- Record the `ffmpeg -buildconf` output into `docs/licences.md`.
- Tag `phase-6-complete` only after the installer is verified on a clean Windows machine/VM
  and the verification report is updated honestly.
