# Clipwright Studio

**Turn one long video into many short, captioned, ready-to-post clips.**
A local-first Windows desktop multitrack video editor (Electron + React + SQLite).

> **Project status (2026-11-12): alpha — v0.1.0 is published as a **prerelease** built by
> CI; the app has never been launched on any machine.** Several spec areas (updater, `.cwpack` export,
> brand kits, waveform cache) are explicitly not built. Read `docs/limitations.md` before
> relying on anything here. The export pipeline has been verified with a real FFmpeg on
> Linux — see `docs/verification.md`.

## What it does

- Import one long video (managed copy or referenced) or download a public URL via yt-dlp.
- Transcribe locally with whisper.cpp (word-level timestamps) — no upload, no account.
- Detect and rank clip-worthy moments (scoring engine with reasons + score breakdown).
- Open clips in a CapCut-style editor: timeline, playhead, tracks, captions, keyframes.
- Burn captions and export H.264/AAC (plus WebM VP9/Opus) at presets from 720×1280 to 4K,
  validated after render with a probe (resolution, fps, SAR, A/V streams) — the file is
  only moved into place if validation passes.
- AI providers: Ollama (offline) and OpenAI-compatible endpoints for moments analysis;
  API keys are stored via the OS keychain (`safeStorage`) when available.

## Requirements (development)

- Windows 10/11 x64 (target), or Linux for development of the pure packages
- Node.js ≥ 20, pnpm 9.15.9 (`npm i -g pnpm@9.15.9`)
- FFmpeg + ffprobe on PATH **or** set `CLIPWRIGHT_FFMPEG` / `CLIPWRIGHT_FFPROBE`
- For transcription: a whisper.cpp `whisper-cli` binary and a `ggml-*.bin` model
  (Settings → Local models downloads models from the whisper.cpp store)

## Repository layout

```
apps/desktop        Electron app (main process, preload, renderer UI)
packages/           Pure, unit-tested cores:
  project-schema    zod schemas, migrations, ids, time quantisation
  timeline-engine   operations, snapping, undo history, state
  media-core        ffmpeg/ffprobe resolution, probing (ffprobe or stderr fallback)
  audio-core        loudness/envelope analysis
  caption-styles    caption presets + .cwstyle files
  ai-core           whisper JSON parsing, moments candidates, scoring, LLM client
  export-core       export presets, ffmpeg graph builder, output validation
  design-system     tokens (sampled from the supplied logo), components
scripts/verify      verification scripts (export matrix)
docs/               decisions, verification, limitations, licences, release
```

## Develop

```bash
pnpm install                 # needs npm_config_nodedir=/usr/local on minimal Linux images
pnpm -r typecheck
pnpm -r test
pnpm dev                     # electron-vite dev (Windows first-class; Linux works for packages/tests)
pnpm verify:export-matrix    # real ffmpeg render matrix (set CLIPWRIGHT_FFMPEG to your binary)
```

## Build & package

```bash
pnpm --filter @clipwright/desktop dist        # Windows NSIS + portable (run on Windows)
pnpm --filter @clipwright/desktop dist:linux  # Linux dir build (packaging sanity check)
```

`electron-builder.yml` produces `Clipwright-Studio-Setup-<version>-x64.exe` (NSIS, per-user)
and `Clipwright-Studio-<version>-x64-portable.exe`. **Neither has ever been built or tested
in this workspace** because the Electron binary cannot be downloaded here and there is no
Windows host available. The CI workflows (`.github/workflows/ci.yml`,
`.github/workflows/release.yml`) are written to build and package on `windows-latest` on a
version tag — their first real run is pending and may need fixes. See
`docs/verification.md` and `docs/release.md`.

**Unsigned builds.** No code-signing certificate is configured. Any installer produced now
is **unsigned**: Windows SmartScreen will warn that the publisher is unknown. Verify the
SHA-256 shown on the release page before running ("More info → Run anyway" only if you
trust the hash). Never install an unsigned build from anywhere else.

## Providers & local models

- **Ollama (offline):** install Ollama, pull a model (e.g. `ollama pull qwen2.5:7b-instruct`),
  then Settings → AI providers → Add → Ollama. No data leaves the machine.
- **OpenAI-compatible endpoints:** Settings → AI providers → Add → Custom endpoint;
  base URL + API key (stored in the OS keychain via safeStorage; if the keychain is
  unavailable the key is kept in memory only and the app says so).
- **Whisper models:** Settings → Local models → Download. Models are `ggml-*.bin` files
  stored in `<workspace>/Models/whisper/`. Tiny/base/small/medium/large-v3; English-only
  variants exist. Download sizes 75 MB – 2.9 GB.

## Export notes

- Presets defined by **short side**, always even dimensions, yuv420p, H.264 High profile,
  AAC-LC 48 kHz stereo, `+faststart`; WebM (VP9+Opus) as second target.
- CRF 26 / 22 / 19 / 16 for draft / standard / high / maximum.
- Renders to `<name>.partial.<ext>`; only after §19.6-style validation passes (resolution,
  fps, aspect/SAR, duration, audio stream) is the file atomically renamed into place.
  Validation failure deletes the partial file.
- `scripts/verify/export-matrix.ts` builds the graph for all 20 preset×quality combos,
  renders 4 of them with real ffmpeg, probes the outputs and reports `verified`.

## Troubleshooting

- **"ffmpeg was not found"** — install FFmpeg or set `CLIPWRIGHT_FFMPEG` to its path.
  Release builds are designed to bundle it under `resources/bin/` (see `docs/licences.md`);
  that bundling has not shipped yet.
- **SmartScreen blocks the installer** — expected for unsigned builds; verify the published
  SHA-256, then "More info → Run anyway". See `docs/limitations.md`.
- **"Transcript failed: no whisper binary"** — install whisper.cpp and ensure `whisper-cli`
  is on PATH or set `CLIPWRIGHT_WHISPER`; or a bundled binary in `resources/bin/` (not yet shipped).
- **App won't open its workspace** — the app keeps a crash journal per project
  (`<project>/journal.jsonl`) and pre-migration backups (`<file>.cwdb.bak-<ts>`); see
  `docs/decisions.md` and specs/03.

## Version & release notes

- Version: **0.1.0** — published 2026-11-12 as a **prerelease** (unsigned alpha):
  <https://github.com/yetiwrld/Main-ClipWright-/releases/tag/v0.1.0>
  Built by CI (`.github/workflows/release.yml`) on windows-latest. Artefact SHA-256s are in
  the release notes. The app has never been launched by anyone yet.

## Licence

**All rights reserved** — the owner has not chosen a licence. See `LICENSE` and
`THIRD-PARTY-NOTICES.txt`; bundled-binary licence information is in `docs/licences.md`
(FFmpeg is GPL for chosen builds).
