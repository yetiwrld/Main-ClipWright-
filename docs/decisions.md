# Clipwright Studio — Architecture & Engineering Decisions

This document records binding engineering decisions, colour sampling results, and technical trade-offs made during the construction of Clipwright Studio (`specs/00` §0.3–0.4, §10.1, §10.6).

---

## 1. Logo Colour Sampling & Brand Palette (Spec 01 §2 & §3.1)

On first run of Phase 1, `ClipWright Icon.png` (1254×1254 RGBA PNG) was sampled directly across key regions:
- **Outer background (0.05, 0.10):** `#000000`
- **Inner dark surface (0.20, 0.25):** `#2B2C2F`
- **Graphite crescent (0.24, 0.50):** `#3B3C3F`
- **Play button orange centre (0.47, 0.50):** `#FC7D01`
- **Play button amber highlight (0.43, 0.50):** `#FB9A02`
- **Play button deep orange right (0.52, 0.50):** `#FC6001`
- **Top orange arc (0.52, 0.33):** `#FC8601`

**Decision:** The sampled orange values (`#FC7D01`, `#FC6001`, `#FB9A02`) match the Spec 01 §3.1 tokens (`--brand: #FF7A00`, `--brand-strong: #FF5A00`, `--brand-amber: #FFB000`) within 1–2% perceptual delta. We retain the exact Spec 01 semantic tokens (`#FF7A00`, `#FF5A00`, `#FFB000`, `--on-brand: #121212`) and the stepped neutral surface scale (`#0E0E0F` → `#161617` → `#1F1F21` → `#28282B` → `#303034`). All 13 foreground/background pairs were verified by automated WCAG 2.1 contrast tests (`verifyAllTokenContrasts()`).

---

## 2. Typography & Timecode Monospace (Spec 01 §4)

- **UI Font:** **Manrope** (weights 400, 500, 600, 700) is bundled locally in `/assets/fonts/` as `.woff2` (OFL-1.1) and loaded via `@font-face` with zero network requests.
- **Timecode Font:** `"Cascadia Mono", "JetBrains Mono", Consolas, monospace` with `JetBrains Mono` bundled locally in `/assets/fonts/` so timecodes never jitter during 30/60 fps playback even on machines without Cascadia Mono installed.
- **Caption Preset Fonts:** Bundled locally in `/assets/fonts/` (Inter, Montserrat, Poppins, Anton, Playfair Display, Bangers, JetBrains Mono — all OFL-1.1).

---

## 3. SQLite Engine & Durability Layer (Spec 03 §2 & §5)

- Both `workspace.db` and per-project `project.cwdb` run in SQLite **WAL mode** (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`) with `synchronous = NORMAL` during normal operation and `synchronous = FULL` on atomic checkpoint commits.
- Our `SqliteDatabase` adapter (`packages/project-schema/src/sqlite-adapter.ts`) wraps Node's built-in synchronous SQLite engine (`node:sqlite` `DatabaseSync` in Node 22+ / Electron 34+) and supports `VACUUM INTO` for consistent online backups before migrations and `.cwpack` exports.
- Every JSON payload column is validated with `zod` (`.passthrough()` at top level to preserve unknown fields across minor versions). Rows failing validation are moved untouched into `_quarantine` rather than crashing project load.

---

## 4. Bundled FFmpeg / ffprobe Licensing (Spec 15 §6.2)

- Clipwright Studio distributes `ffmpeg` and `ffprobe` as **separate standalone executables** invoked via `child_process.spawn` / `execFile` (never linked into the application binary).
- The GPL build including `libx264`, `libvpx-vp9`, `libopus`, and native `aac` is documented in `docs/licences.md` along with the written source offer and build configuration.

---

## 5. Application Licence (Spec 15 §6.2)

- Per Spec 15 §6.2, `LICENSE` defaults to `"All rights reserved — see README"` until the repository owner selects a distribution licence. Third-party open-source component notices are listed separately in `docs/licences.md` and `THIRD-PARTY-NOTICES.txt`.

---

## 6. Update authenticity without code signing (Spec 15 §5)

**Decision:** ship an unsigned installer, and make updates safe with a **signed release manifest** rather than Authenticode.

**Reasoning:** Authenticode needs a paid certificate that is renewed annually, and without it Windows only tells the user "unknown publisher" — it says nothing about whether a specific *update* came from us. An Ed25519 signature over a manifest we control proves authorship of every release regardless of whether the installer is signed, and it costs nothing to keep.

**Consequences:**
- The private key exists only as a GitHub Actions secret. Losing it means the current user base cannot be updated by the updater and must install manually (recorded in `docs/release.md` §5).
- A build whose embedded public key is missing or a placeholder refuses **every** update. This is deliberate: refusing is recoverable, installing something unverified is not.
- The signature is checked before the manifest's hashes are used, so a forged manifest cannot steer a download.
- Two keys are supported (`current` and `next`) so a key can be rotated without stranding users who have not updated yet.

---

## 7. Two Vite builds for the desktop app (Spec 15 §6)

**Decision:** build the renderer with `vite.config.ts` and the main process plus preload with a separate `vite.main.config.ts`, producing CommonJS under `dist/main`.

**Reasoning:** the two run in different worlds. The renderer targets a browser (React, relative asset URLs so `file://` works); the main process targets Node, imports `electron`, and must leave native modules (`better-sqlite3`, `onnxruntime-node`) external so their `.node` binaries load from outside the asar. One config cannot honestly serve both.

**Consequences:**
- `package.json` `main` points at `dist/main/index.cjs`, and a renderer-only build leaves the app unable to start. `scripts/release/assert-package.mjs` and a CI step both check for that file specifically.
- Chunk names are deterministic, so the launch path does not change between builds.

---

## 8. Audio mixed in TypeScript, not in an ffmpeg filter graph (Spec 14 §5)

**Decision:** compute the mix in `packages/export-core/src/audio-mix.ts` and write a float32 WAV, rather than building an `amix`/`afade`/`sidechaingate` filter graph.

**Reasoning:** a filter graph of that size cannot be unit-tested — the numbers only exist inside ffmpeg. Doing the arithmetic ourselves means gain, fades, panning, ducking and the limiter are all covered by tests that assert exact samples, and the loudness normalisation is measured with ebur128 on the file we actually produce rather than trusting a filter's nominal behaviour.

**Consequences:**
- The limiter must stay O(n). The first implementation scanned a lookahead window per sample and was quadratic; a 10-minute clip made that obvious, and it is now a monotonic deque with a test that times it.
- Large mixes are held in memory at 48 kHz stereo float (about 23 MB per minute). Acceptable for the target clip lengths, and stated in `docs/export.md`.
- Audio-rack effects are not applied yet; when they are, they belong in this same pure module so they can be tested the same way.
