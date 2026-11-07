# Clipwright Studio

Turn a long video into captioned, edited short clips — or edit multitrack video
— on your own machine, offline.

Windows 10/11 x64. Free of accounts, subscriptions and telemetry.

> **Status: pre-release.** The export engine, updater and packaging pipeline are
> built and tested; a signed Windows installer has not been published yet. See
> [docs/verification.md](docs/verification.md) for exactly what is and is not
> verified, and [docs/limitations.md](docs/limitations.md) for what does not work
> yet.

---

## Install

Download from [Releases](https://github.com/yetiwrld/Main-ClipWright-/releases):

| File | Use it when |
|---|---|
| `Clipwright-Studio-Setup-<version>-x64.exe` | **Most people.** Per-user install, no admin rights. |
| `Clipwright-Studio-<version>-x64-portable.exe` | No installation; USB stick, shared PC. |

**The build is unsigned**, so Windows SmartScreen will warn about an unknown
publisher. More info → Run anyway. Verify the SHA-256 against `SHA256SUMS.txt`
on the release page if you want certainty. Full details, including portable mode
and uninstall behaviour, in [docs/install.md](docs/install.md).

---

## What it does

**Long video → shorts.** Import a video or paste a URL, transcribe it locally
with whisper.cpp, and let the app find the moments worth clipping. Each moment
becomes a clip with burned-in captions in a style you control.

**Multitrack editing.** A real timeline: multiple video and audio tracks,
splitting, ripple edits, keyframes, effects, transitions, markers and a work
area. Undo and redo everywhere.

**Export you can trust.** MP4 and WebM, hardware encoding where it works with a
verified software fallback, and 18 validation checks run against the *produced
file* — not against the settings you asked for. The verdict you see ("Verified",
"Done with warnings", "Failed") reflects measurements, and the app says so when
a check could not be measured rather than pretending it passed.

---

## Offline and online

| Works with no connection | Needs a connection |
|---|---|
| Editing, preview, export | Importing from a URL (YouTube and similar) |
| Transcription (models downloaded once) | Downloading speech models the first time |
| Moment detection (local scoring) | Optional AI scoring via a provider you configure |
| Export validation | Checking for updates |

Nothing else reaches the network. There is no analytics, no crash upload and no
usage reporting. Settings → Privacy lists every outbound call and lets you turn
the optional ones off. [docs/providers.md](docs/providers.md) has the full list.

---

## Features

- **Import** — files, drag-and-drop, or a URL via the bundled `yt-dlp`
- **Transcribe** — whisper.cpp locally; word-level timestamps
- **Captions** — styled, animated, burned in or exported as SRT/VTT
- **Find moments** — local scoring across audio energy, speech density and
  silence; optional AI re-ranking
- **Edit** — multitrack timeline, keyframes, effects, transitions, audio mixing
  with ducking and loudness normalisation
- **Export** — presets from draft 720p to 4K, hardware encoding, name-clash
  handling, free-space checks, queue with pause and retry
- **Updates** — checked against a signed release manifest; anything that cannot
  be verified is refused

---

## Screenshots

Screenshots in this repository are real captures of the running application, not
mockups. There are none yet: the app cannot produce a trustworthy screenshot
until the editor UI work in phase 8 is finished, and a mocked-up screenshot would
be worse than none. This section will be filled in with real ones.

---

## Building from source

```bash
corepack enable
pnpm install
pnpm dev          # renderer with hot reload
pnpm test         # 910 tests across 10 packages
```

[docs/build.md](docs/build.md) covers packaging, the bundled binaries and the
size budget. [docs/development.md](docs/development.md) has the folder map and
the scripts.

---

## Documentation

| | |
|---|---|
| [Install](docs/install.md) | Which file, SmartScreen, portable mode, uninstall |
| [Troubleshooting](docs/troubleshooting.md) | Every symptom with its cause and fix |
| [Export](docs/export.md) | Presets, quality, validation checks, known limits |
| [Formats](docs/formats.md) | `.cwpack`, `.cwstyle`, `.cwbrand`, `peaks.bin` |
| [Providers](docs/providers.md) | AI providers and the full network list |
| [Local models](docs/local-models.md) | Whisper and ONNX models, sizes, licences |
| [Build](docs/build.md) · [Release](docs/release.md) | Packaging and publishing |
| [Limitations](docs/limitations.md) | What does not work yet |
| [Verification](docs/verification.md) | What has been tested, and what has not |
| [Decisions](docs/decisions.md) · [Licences](docs/licences.md) | Why things are the way they are |

---

## Licence

All rights reserved — see [LICENSE](LICENSE). The owner has not yet selected a
distribution licence ([docs/decisions.md](docs/decisions.md) §5).

Bundled third-party software keeps its own licence: FFmpeg is a GPL build
invoked as a separate executable, `whisper.cpp` is MIT, `yt-dlp` is Unlicense.
Full notices in [docs/licences.md](docs/licences.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability. Please do not
open a public issue for one.
