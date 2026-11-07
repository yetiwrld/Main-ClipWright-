# Building Clipwright Studio

## Requirements

| Tool | Version | Why |
|---|---|---|
| Node.js | 22.x | matches CI and the release job |
| pnpm | via `corepack enable` | the workspace uses `workspace:*` protocol links |
| Windows | 10/11 x64 | installer and portable artefacts are Windows-only in v1 |

Building is possible on Linux and macOS for development; only the Windows
artefacts are shippable, and `smoke-install.mjs` skips itself off Windows rather
than pretending it verified something.

## Development

```bash
corepack enable
pnpm install
pnpm dev                 # renderer on http://localhost:5173, electron attached
```

`pnpm dev` starts the Vite dev server only. To run the full desktop app you need
a display; on a headless machine, use `pnpm dev` for the renderer and the test
suite for the main process.

## Checks

These are the exact commands CI runs, in order. Run them before opening a pull
request:

```bash
pnpm lint        # design-token audit + no-fakes/determinism audit
pnpm typecheck   # tsc --noEmit across every package
pnpm test        # vitest: unit, integration, renderer
```

`pnpm lint` is not cosmetic. It rejects hard-coded hex colours, pixel radii and
millisecond durations in the renderer (SPEC 01), and it rejects banned
marketing language and non-deterministic code in the packages (SPEC 16).

## Building the app

```bash
pnpm --filter @clipwright/desktop build
```

That runs two Vite passes:

| Pass | Config | Output | Notes |
|---|---|---|---|
| Renderer | `vite.config.ts` | `dist/renderer/` | browser target, relative URLs so `file://` works |
| Main + preload | `vite.main.config.ts` | `dist/main/` | Node target, CommonJS, `electron`/native modules external |

Both are required. A renderer-only build produces an installer whose app cannot
start, which is why `scripts/release/assert-package.mjs` checks for the main
bundle in the artefact tree rather than trusting the build to have run.

## Packaging

```bash
pnpm --filter @clipwright/desktop dist:win
```

or, to get the full release bundle plus checksums and a signed manifest:

```bash
node scripts/release/build-release-artefacts.mjs
```

`electron-builder.yml` produces two artefacts and nothing else:

- `Clipwright-Studio-Setup-<version>-x64.exe` — NSIS, per-user, no admin rights
- `Clipwright-Studio-<version>-x64-portable.exe`

### Bundled binaries

The packaged app spawns `ffmpeg.exe`, `ffprobe.exe` and (for transcription)
`whisper-cli.exe` from `resources/bin`, which is copied into the package as
`resources/bin`. It also spawns `yt-dlp.exe`, preferring a newer copy the app
updated itself in `%APPDATA%`.

In a git checkout `resources/bin` contains symlinks to a Linux build so the
tests can run. **Those are never shipped**: `verify-binaries.mjs` refuses to
package a symlink or an unpinned hash. Run `fetch-binaries.mjs` first.

## Native modules

`better-sqlite3` and `onnxruntime-node` are unpacked from the asar
(`asarUnpack` in `electron-builder.yml`) because a `.node` binary cannot be
loaded from inside an archive. If a future dependency ships native code, add it
there and to `rollupOptions.external` in `vite.main.config.ts`, or the main
process will fail to start with "cannot find module".

## Size budget

SPEC 15 §6.1 sets the installer at **≤ 450 MB** excluding downloadable models.
`build-release-artefacts.mjs` prints the real total. Models are never bundled
except the small ONNX detectors and the 1-second test WAV.

## Troubleshooting a build

| Symptom | Cause |
|---|---|
| `dist/main/index.cjs` missing | only the renderer pass ran; use `pnpm build`, not `vite build` |
| App window is blank in the package | `dist/renderer/index.html` missing, or absolute URLs (check `base: './'`) |
| `cannot find module 'better-sqlite3'` at launch | not in `asarUnpack`, or not external in the main rollup config |
| Installer is 30 MB and does nothing | the main build was skipped; `assert-package.mjs` should have caught this |
