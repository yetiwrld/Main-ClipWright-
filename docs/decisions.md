# Decisions

Architecture and product decisions taken while building Clipwright Studio, with reasons.

## Product & licensing

- **App licence is undecided; default is “All rights reserved — see README”.**
  The build guide is explicit that the agent must not invent a licence for the owner.
  `LICENSE` therefore carries a proprietary notice until the owner chooses one.
- **The supplied logo is reused verbatim, never redrawn.**
  `assets/ClipWright_Icon.png` (1254×1254) is the single source of the mark. It is reused
  for the window icon (`assets/ClipWright_Icon.ico`, generated multi-size 16–256), the
  boot splash and the top bar. No SVG redraw is used anywhere.
- **Design tokens were sampled from the real logo.** Dominant orange mass centres on
  `#FC6E01`–`#FC7A00` (the swirl and play triangle), on near-black `#131212` canvas, with
  silver/grey swirl mass around `#5D5F62`. `--brand: #FF7A00` sits in the same family but
  a touch brighter for UI legibility; `--surface-app: #0E0E0F` matches the logo canvas.
  Sampled, not guessed (spec §6.3).

## Architecture

- **Monorepo: packages + one Electron app.** `project-schema` holds zod schemas that
  main and renderer both consume; media/ai/audio/timeline/caption/export cores are pure
  and unit-tested; `apps/desktop` wires them to Electron.
- **Two SQLite databases, one writer.** `workspace.db` (projects index, media, jobs,
  export history, providers, settings) and per-project `.cwdb` (compositions, words,
  captions, moments). All access goes through `StorageService` in the main process;
  the renderer never sees SQL. Migrations run forward-only; a `.bak` is taken before
  any pre-migration upgrade; `integrity_check` runs on open. Invalid rows are quarantined
  (`_quarantine`), never crash the app (tested).
- **Crash recovery is a full-snapshot JSONL journal, not a patch journal.**
  Simplification of spec §03 for v1: every journal line contains the whole composition
  (small, a few KB). Replay keeps the newest per composition; corrupt lines are counted,
  never fatal. fsync at most once per second plus on explicit `flush()`; `journal.clear()`
  happens only after the checkpoint is durably saved. `lock.json` uses PID + hostname +
  15 s heartbeat; same-host stale locks detected, foreign-host locks never stolen.
- **`clipwright-media://` serves files by absolute path inside the workspace root only.**
  Requests outside the workspace root return 403. This is the only media path into the
  renderer, alongside typed IPC.
- **Jobs run with a queue in the main process** (1 user-blocking + 2 background), not in a
  worker pool. Long native work (ffmpeg, whisper) is spawned as a child process and its
  progress streamed back. CPU-bound JS stays tiny by design.
- **Export renders with ffmpeg, never captures the preview.** Preview is a live DOM/video
  element; export is a fresh ffmpeg run from validated inputs.
- **Settings are zod-validated on every read and write** (merge-then-parse): unknown keys
  drop, invalid values fall back to defaults, corrupt settings JSON falls back to defaults
  instead of crashing (tested).
- **API keys use Electron `safeStorage`** when the OS keychain is available; otherwise keys
  live in memory only and the UI says so (banner + Settings). Keys are never written to
  logs — the logger redacts common secret patterns.

## Media & export

- **ffprobe is preferred, but probing degrades gracefully.**
  `probeInput()` uses ffprobe when present; otherwise it parses `ffmpeg -i` stderr into the
  same shape (`ffmpeg-fallback.ts`, round-trip tested). Probing must never be a hard blocker.
- **Bundled FFmpeg for releases is GPL** (libx264/libvpx), a separate executable with the
  licence text and a source offer (see `docs/licences.md`). H.265/HEVC is not shipped in v1.
- **Export presets are defined by the SHORT SIDE**, both sides even, yuv420p, H.264 High,
  AAC-LC 48 kHz, `+faststart`; WebM VP9+Opus as second target. CRF 26/22/19/16 for
  draft/standard/high/maximum. Outputs land in `<name>.partial.<ext>` and are atomically
  renamed only after §19.6 validation passes; a failed validation deletes the partial file.
- **Export graph emits an `OUTFILE` placeholder** that callers rewrite; `-progress pipe:1`
  is spliced before it. Keeps the graph builder pure and unit-testable.
- **`setsar=1` is forced after crop.** Without it x264 emits non-square SAR (observed
  `4095:4096` on a 1080×1920 render) and the §19.6 SAR check fails. Found by the real
  render matrix, not by inspection.

## Transcription engines (2026-11-12)

- **Two offline engines are supported.** whisper.cpp (bundled in official builds) reads only
  ggml models; faster-whisper (this PC's cached Systran / mobiuslabsgmbh CT2 models) cannot
  be read by whisper.cpp at all — there is no supported converter, and pretending HF-cache
  scanning of ggml files would find something was false.
- **The faster-whisper backend is selected with `faster-whisper:<org/repo>` as the value of
  the existing `transcriptionModel` setting** (prefix handled in runners.ts). No schema change.
- **Python is probed, never assumed:** CLIPWRIGHT_PYTHON → py launcher -3.12/-3.13/-3.11/-3.10/…
  → well-known Windows install dirs → `python`/`python3`. Every candidate must actually import
  `faster_whisper`. The user's machine resolves Python 3.12 (their `py` default is 3.15, which
  lacks the package — hence the probe order).
- **Model discovery is a read-only scan** of the HF hub cache (`HF_HUB_CACHE`, `HF_HOME/hub`,
  or `~/.cache/huggingface/hub`): `models--*--*/snapshots/*/model.bin` ≥ 1 MB + `config.json`;
  newest complete snapshot wins. No files are copied, linked, or modified. `CLIPWRIGHT_PYTHON` +
  Refresh in Settings → Models re-probes on demand; results are cached per session otherwise.
- **Clipwright never downloads CT2 models** — the user's existing cache is the source of truth,
  used in place. (The whisper.cpp path can still download ggml models.)
- **Helpers run out-of-process** (embedded Python script written to a temp dir; args argv-only,
  source never interpolates paths) so there is no shell-injection surface.
- **Progress is honest when inexact:** the WAV-size estimate feeds only the progress bar
  (labelled approximate in code comments); transcript timing itself comes from faster-whisper.

## Phases & honesty

- **Phase checkpoints that cannot be executed here are documented, not claimed.** The
  Windows installer build, clean-VM install, real whisper transcription, and the Electron
  app launch are recorded as *pending* in `docs/verification.md`. `phase-N-complete` tags
  are to be applied after a real Windows run (CI or a dev machine). No fabricated
  screenshots or "tested on Windows" claims.
- **Export verification is real but partial.** `scripts/verify/export-matrix.ts` produced
  and probed real 1080×1920 MP4s on this machine (plan checks for all 20 preset×quality
  combos; runtime renders for 4 qualities; §19.6 validation = `verified`). That is not a
  substitute for the spec §16 full pass.

## Renderer

- **Design showcase lives at `/__design`, dev-only** (`import.meta.env.DEV` guard, removed from production bundles). It exists so the design system can be reviewed without running the full app; it renders tokens, type, and every component.
- **`components.css` must be imported by the app.** Found and fixed 2026-11-12: the design-system shipped `components.css` (94 `.cw-*` rules) but nothing imported it — components rendered unstyled. Exported as `@clipwright/design-system/components.css` and imported in `styles.css`. Build-verified (CSS bundle 20.9 kB → 34.4 kB).
- **Dev-only mock bridge for browser previews** (`devMock.ts`): installs a fake `window.clipwright` only when `import.meta.env.DEV && !window.clipwright`. Never active in production builds; never overrides a real preload bridge; logs a loud console banner. The `/__design` route is the only supported use.
- **`vite.preview.config.mts`** serves the renderer outside Electron for the showcase (`npx vite --config vite.preview.config.mts`, port 5173). Vite always sets `import.meta.env.DEV=false` for `vite build`, so the preview is a dev-server concern, not a bundle. Not used by packaging.

## Storage v1 scope cuts (recorded, none hidden)

- `.cwpack` export/import: **not implemented** (v1 stores are single-machine).
- `.cwbrand` brand kits: **not implemented**.
- `.cwstyle` exists for caption presets and is unit-tested; import/export of custom
  `.cwstyle` files is parse-only.
- `peaks.bin` waveform caches: **not implemented**.
- Auto-update system: **not implemented**; CI builds artefacts, release is manual.
- Referenced-media relink UX: `media.status` detection exists; the relink flow is v1.x.
