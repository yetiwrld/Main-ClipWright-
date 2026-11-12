# Bundled binaries (`resources/bin/`)

This directory is the staging area for the Windows executables that ship inside the
installer/portable build via `extraResources` → `resources/bin`. **No binaries are
committed to Git** (they are large and carry their own licences). The release
workflow (`.github/workflows/release.yml`) is designed to fetch pinned binaries and
record their hashes before packaging.

Expected contents for a release build:

| File | Source (pinned in release.yml) | Notes |
|---|---|---|
| `ffmpeg.exe` | BtbN FFmpeg-Builds GPL build (win64) | GPL build chosen for libx264/libvpx — see `docs/licences.md` |
| `ffprobe.exe` | BtbN FFmpeg-Builds GPL build (win64) | same archive as ffmpeg |
| `yt-dlp.exe` | yt-dlp GitHub Releases (pinned tag) | Unlicense (public domain dedication) |
| `whisper-cli.exe` (+ `-avx2`) | whisper.cpp GitHub Releases or CI-built from a pinned tag | MIT; CPU baseline + AVX2 variants |

`checksums.json` in this directory records `{ fileName: sha256 }` and the app is
expected to verify them at first run (see specs/15 §6.1). It is intentionally empty
(`{}`) until the release workflow populates it, so the app cannot silently trust an
unverified binary — a missing entry is treated as "not bundled / not verified".

**Status as of 2026-11-12:** no binaries are bundled yet; the installer has never been
built or tested. See `docs/verification.md` and `docs/limitations.md`.
