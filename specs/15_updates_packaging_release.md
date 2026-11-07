# SPEC 15 — UPDATES, PACKAGING, CI AND RELEASE

**Binding.** Follows the structure of `specs/09`. Related: `00 §9` (packaging summary), `03` (data preserved, migrations, backups), `04 §3.1` (yt-dlp updates), `06 §8` (network/privacy list), `14` (bundled ffmpeg), `16` (verification).
Code: `/apps/desktop/src/main/updater`, `/apps/desktop/electron-builder.yml`, `/.github/workflows`, `/scripts/release`.

---

## 1. PURPOSE

Ship a **Windows x64 installer and a portable executable** that work on a clean machine; let users **check for and install updates from GitHub Releases** with clear control; verify every update's integrity and authenticity; never lose user data; and be honest about what is unsigned.

---

## 2. ARCHITECTURE (mandatory)

1. **Updater module** wraps `electron-updater` (GitHub provider) behind our own `UpdateService` interface so the UI never touches the library directly:
```ts
interface UpdateService {
  check(opts: {manual: boolean}): Promise<UpdateCheckResult>;       // no-update | available | error
  download(signal): Promise<DownloadResult>;                        // progress events
  verify(): Promise<VerifyResult>;                                  // §5
  prepareInstall(): Promise<PrepareResult>;                         // backups, §7
  installAndRestart(): void;                                        // only after explicit user action
  state$: Observable<UpdateState>;
}
```
2. **`autoDownload = false`, `autoInstallOnAppQuit = false`**. The app **never** downloads in the background without the user-visible setting, and **never installs without a click**.
3. The updater runs in the **main process**; the renderer sees only `UpdateState` (version, notes, progress, status).
4. **Single source of truth for the repository:** `package.json → build.publish = {provider: 'github', owner, repo}` set from one config constant (`UPDATE_REPO`), documented in `docs/release.md`. The app contacts **only that repo** for updates.
5. **Channel:** `stable` (default; GitHub releases not marked prerelease) and optional `beta` (prereleases) selectable in Settings → Updates (off by default, with a warning).

---

## 3. UPDATE SETTINGS (Settings → Updates)
- **Current version** (semver + build number + channel), **Last checked** timestamp.
- **Check for updates now** button (always visible; also in the top-bar ⋯ menu, Help, and the command palette).
- **Automatic checks:** *On startup* (default on), *Every [6 h / 1 day / 1 week]* (default 1 day), or *Never*. A check on startup runs **≥ 20 s after launch** (never delays startup), at most once per 6 h.
- **When an update is found:** *Ask me* (default; shows the update dialog/toast) · *Download in the background, ask before installing* · (never "install silently").
- **Channel** selector (stable/beta). **yt-dlp** section: version, *Check for yt-dlp updates*, auto-check toggle (`04 §3.1`, §9 here).
- **Privacy note** under the section: "Checking for updates contacts github.com. Nothing about you or your projects is sent." (also listed in Settings → Privacy, `06 §8`). The request includes the app version and OS in the User-Agent only.
- Metered/offline: no check is attempted without connectivity; failures are silent for automatic checks (logged) and explained for manual checks.

---

## 4. THE UPDATE FLOW (UI)

### 4.1 Manual check
Click **Check for updates** → button shows a spinner and "Checking…" (timeout 15 s) → one of:
- **Up to date:** "You're on the latest version (1.2.0)." + last checked time.
- **Available:** the **Update dialog** (§4.2).
- **Error:** plain reason ("Couldn't reach GitHub. Check your internet connection." / "GitHub is limiting requests. Try again later." / "The update information couldn't be verified." (§5)) with **Retry**; never a stack trace.

### 4.2 Update dialog (`Dialog`, 16 px radius)
Shows: **new version** (e.g. 1.3.0), **current version**, release date, **download size**, **short summary** (the first paragraph of the release notes), the **full release notes** (Markdown rendered **sanitised**: no raw HTML/scripts/remote images; links open in the default browser after a confirm), whether it's a **prerelease**, and "**Unsigned installer**" notice if applicable (§6.4). Buttons: **Download** (primary), **Remind me later** (snoozes 24 h), **Skip this version**, **View on GitHub**. After **Download**: a **progress bar** with true percentage, speed, ETA, **Cancel**; then **Verifying…** (§5) → **Ready to install** with **Install and restart** (primary) / **Later**. If unsaved work exists, the app **saves** (`03 §5.2`), closes open projects cleanly and then restarts into the installer; long-running jobs (exports/transcription) trigger the confirm from `02 §6.5`.
- A subtle **"Update available"** chip appears in the top bar when an update was found and not yet handled; it never interrupts editing (no modal during an active editor session; the dialog only opens on user click or on the Home page after a startup check).

### 4.3 After the update
On first launch of the new version: a **"What's new in 1.3.0"** toast with *View release notes* (only if the notes are cached), database migrations run with backup (`03 §9`), and `lastUpdateResult` is recorded. If the previous installer is kept for rollback (§7), a note appears in Settings → Updates.

---

## 5. INTEGRITY AND AUTHENTICITY (mandatory)

Because the installer is **unsigned** unless a code-signing certificate becomes available, authenticity cannot rely on Windows Authenticode. Use **two layers**:

1. **Integrity:** `electron-updater` verifies the **sha512** from `latest.yml` against the downloaded file. Additionally the app **recomputes SHA-256** of the downloaded file and compares it with the `sha256` listed in our own release manifest (layer 2). A mismatch deletes the file and shows "The download was damaged and has been removed."
2. **Authenticity:** **signed release metadata.** CI produces `release-manifest.json` `{version, channel, notes(summary), files:[{name, size, sha256, sha512}], generatedAt, minimumSupportedVersion?}` and a detached **Ed25519 signature** `release-manifest.json.sig` made with a **private key stored only as a GitHub Actions secret** (never in the repo). The app embeds the **public key** (and a *next public key* for rotation) and **verifies the signature before it offers or downloads anything**. If the signature is missing/invalid, the app refuses: "This update couldn't be verified, so it was not installed." The check works with the standard `latest.yml` fetched in the same step: the file hashes in the signed manifest must equal those in `latest.yml`; any disagreement aborts.
- **Key management:** `docs/release.md` documents generating the key pair (`scripts/release/gen-update-key.mjs`), storing the private key as secret `UPDATE_SIGNING_KEY`, key rotation (ship a new public key in release N, sign N+1 with the new key; the app accepts either key during the transition), and what to do if the key is lost.
- **Downgrade protection:** the app refuses to "update" to a version **lower** than the current or lower than `minimumSupportedVersion` rules; it also refuses a manifest whose `version` doesn't match the file names.
- **Transport:** HTTPS only; certificate validation never disabled; redirects only to `github.com`/`githubusercontent.com` hosts.
- **Replay/freshness:** the manifest includes `generatedAt`; manifests older than 365 days are treated as stale (warn).
- If the user's machine has TLS interception (corporate proxy), a failed verification shows a hint but never offers to bypass.
- **Never** install an update from a local file the user points to inside the app (no "install from file" feature). The portable build's manual update (§6.3) follows the same verification.

---

## 6. PACKAGING (electron-builder)

### 6.1 Targets and configuration
- **NSIS installer** `Clipwright-Studio-Setup-<version>-x64.exe`: `oneClick: false`, `perMachine: false` (**per-user install by default, no admin rights needed**), offers *per-machine* via the wizard when run elevated, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut: 'always'` shown as a **checkbox option** (default checked), `createStartMenuShortcut: true`, `runAfterFinish: true`, `deleteAppDataOnUninstall: false`, language: English (installer strings), shortcut name "Clipwright Studio", AppUserModelID set, installer/uninstaller icons from the supplied logo (`ClipWright_Icon.png` → multi-size `.ico`: 16, 24, 32, 48, 64, 128, 256), a **licence page** (the app licence + third-party notices link), file association for `.cwpack` and `.cwstyle`/`.cwbrand` (registered per-user, removed on uninstall).
- **Portable executable** `Clipwright-Studio-<version>-x64-portable.exe` (electron-builder `portable` target).
- Architecture: **x64 only** in v1 (ARM64 listed in `docs/limitations.md`).
- **Version info** embedded: ProductName, FileDescription, CompanyName, LegalCopyright, FileVersion/ProductVersion (= semver), InternalName, OriginalFilename (set via `win.legalTrademarks`/`extraMetadata` and a `rcedit` step); shown in the file's Windows properties and in About.
- **ASAR:** app code packed; native modules (`better-sqlite3`, `onnxruntime-node`) and **binaries** unpacked via `asarUnpack`; binaries in `resources/bin/` (`ffmpeg.exe`, `ffprobe.exe`, `whisper-cli.exe` (+ baseline/AVX2 variants), `yt-dlp.exe`) with file checksums recorded in `resources/bin/checksums.json` and **verified at first run and after updates** (a mismatch disables that tool with a clear message and "Reinstall" hint).
- **Electron security settings** enforced in the build (tested in `16`): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, `webSecurity` on, no remote content, `will-navigate`/`window.open` blocked except allow-listed external links opened via `shell.openExternal` after a URL scheme check (https only), devtools disabled in production (reachable only with a `--devtools` flag documented in `docs/development.md`).
- **Bundle size budget:** installer ≤ 450 MB excluding downloadable models (record the actual size; models are **never** bundled except small ONNX detectors and the 1-second test WAV).

### 6.2 Bundled components and licences (`docs/licences.md`, mandatory)
| Component | Notes the team must verify and record |
|---|---|
| **FFmpeg / ffprobe** | Choose the build deliberately: a **GPL build** (includes libx264/libx265) vs an **LGPL build** (no libx264; H.264 via hardware encoders or OpenH264 only). **Decision for v1: use a GPL build that includes libx264 and libvpx, libopus, libmp3lame/AAC (native `aac`)**, distributed as a **separate executable** (not linked), with the licence text, the exact build configuration (`ffmpeg -buildconf`), and a **written offer / link to the corresponding source** in `docs/licences.md` and About → Third-party notices. Record the source of the binary (e.g. a reputable Windows build), its version and checksum. **H.265/HEVC**: patent-encumbered; include only if the bundled build has it, label in the UI as "may require licences in some regions" (informational, not legal advice). |
| **whisper.cpp** | MIT; bundle the CLI built by CI from a pinned tag, CPU baseline + AVX2 variants. |
| **yt-dlp** | Unlicense; bundled standalone binary, updated through our own checksum-verified updater (§9). |
| **Electron / Chromium** | Include the standard `LICENSES.chromium.html` and Electron licence. |
| **Fonts, icons, models** | Per-file licences (OFL, ISC, MIT, Apache-2.0); ONNX model licences verified. |
| **Node dependencies** | Generated by `license-checker`/`pnpm licenses` into `docs/third-party-licenses.json` and a human-readable `THIRD-PARTY-NOTICES.txt` shipped in the app. **Fail CI** on a dependency with an incompatible/unknown licence. |
- The app licence for Clipwright Studio itself is chosen by the owner and placed in `LICENSE` (the agent must **not** invent a licence: default to "All rights reserved — see README" until the owner chooses, and record that in `docs/decisions.md`).
- **About dialog** lists app version, Electron/Chromium/Node versions, ffmpeg and yt-dlp versions, whisper.cpp version, and a *Third-party notices* viewer.

### 6.3 Portable build behaviour
- Stores app data **next to the executable** in `ClipwrightData/` only if `portable.flag` (an empty file) exists beside it; otherwise uses `%APPDATA%` like the installed app (default: **flag absent**, simpler and safer). The workspace location is still user-chosen (`03`).
- **Updates:** the portable build can **check** for updates and **download the new portable `.exe`** (verified as in §5) to a folder the user picks, then tells them to replace the file; it **does not** self-replace. The UI states this plainly.
- Secrets in portable mode still use `safeStorage` (bound to the Windows user); moving the exe to another PC/user means keys must be re-entered (documented).

### 6.4 Code signing (honesty rule)
- If no certificate is configured, the build is **unsigned**: the README, release notes, the installer licence page and the in-app update dialog state "**Unsigned**: Windows SmartScreen may warn that the publisher is unknown. Verify the SHA-256 listed on the release page." SmartScreen behaviour is explained in `docs/troubleshooting.md` with screenshots/text steps ("More info → Run anyway"). The app and the release **never imply** the installer is signed.
- If a certificate is supplied later (`CSC_LINK`/`CSC_KEY_PASSWORD` secrets), the CI signs the installer, the app executable and the uninstaller, and the Windows signature verification (electron-updater `publisherName`) is enabled in addition to §5.

### 6.5 Uninstall behaviour
- Removes the program files, shortcuts and file associations. **Never deletes** the workspace, projects, media, exports, models or `%APPDATA%` secrets. An **unchecked** option "Also remove app settings and saved API keys" removes only `%APPDATA%\Clipwright Studio` (and says where the workspace folder is and that it is kept). The uninstaller warns if the app is running (closes it after prompting).

---

## 7. SAFE UPDATE, BACKUP AND ROLLBACK

1. **Before installing** (`prepareInstall`): (a) save and close projects; (b) **backup** `workspace.db`, `%APPDATA%\…\app-state.json` and `secrets.bin` to `<workspace>/Updates/backup-<oldVersion>-<ts>/` (small files; media and project databases are protected by the migration backups in `03 §9`); (c) copy the **currently installed installer** if available (`Updates/previous/Setup-<oldVersion>.exe`, kept **only if we still have it**: for installed builds we cache the installer we last installed in `Updates/previous/` after each successful update; first-install installers are not available — stated in the UI) ; (d) write `update-journal.json` `{from, to, startedAt, status:'installing'}`.
2. **Install:** run the verified installer silently-in-UI (NSIS with the normal progress UI is fine; no hidden install) and relaunch.
3. **Boot marker:** on first launch of the new version the app writes `status:'launched'`; after **60 s of successful runtime (main window loaded, workspace opened, no crash)** it sets `status:'ok'`. If the app **crashes or fails to open the workspace twice** within 60 s of the first launch (counted via the journal), it opens a **Recovery window** (a minimal, separate HTML page that depends on nothing but the main process) with: *Restart*, **Restore previous version** (runs the cached previous installer after verifying its recorded hash; restores the small backups; explains that project databases were already safeguarded by `03 §9` backups and are restored automatically if a migration was involved), *Open logs*, *Report/Copy details*.
4. **Migration failure** is handled by `03 §9` (automatic restore of the pre-migration backup); the app then runs in a safe "Update problem" state with the Recovery window.
5. **Downgrade note:** because newer project databases can't be opened by older versions (`03 §9`), restoring a previous app version restores the pre-migration backups of any project that was migrated by the failed version; this is stated before the user chooses *Restore previous version*.
6. The update journal entry and backups older than **30 days** after a successful update (`status:'ok'`) are removed automatically; the most recent is always kept until the next update succeeds.
7. **Preserved by every update:** projects, workspace, media, exports, settings, provider records and keys (keys live in `%APPDATA%` and are untouched), downloaded models, custom caption styles/brand kits. A test updates v(N−1) → v(N) with a populated workspace and verifies byte-identical media and a project that reopens identically (`16`).

---

## 8. THE RELEASE PIPELINE (GitHub Actions)

### 8.1 Versioning and branches
- **Semantic versioning** (`MAJOR.MINOR.PATCH[-beta.N]`) in `package.json`, bumped by a script that also updates `CHANGELOG.md`. Releases are made from **annotated tags** `vX.Y.Z` on `main`. Phase tags `phase-N-complete` (`00 §6`) are separate and never trigger releases.
- `CHANGELOG.md` follows *Keep a Changelog* with sections Added/Changed/Fixed/Known issues; **release notes are generated from the matching CHANGELOG section**; the **Unsigned** notice is auto-appended when signing is absent.

### 8.2 Workflows
**`ci.yml`** (on PR and push to `main`, `windows-latest`): checkout → pnpm install (cached) → typecheck → lint (incl. the *no hard-coded colours/radii/durations* rule from `01`) → unit tests (Vitest) → build packages → **Playwright for Electron** smoke + core E2E (headless via `xvfb` is **not** available on Windows; use the real Windows runner session) → upload test reports/screenshots as artefacts → secret scan (gitleaks) → licence check.
**`release.yml`** (on tag `v*`, `windows-latest`):
1. Checkout (full history for notes), setup Node + pnpm, install with the lockfile (`--frozen-lockfile`).
2. **Fetch and verify binaries**: download pinned ffmpeg/ffprobe, yt-dlp, build/download whisper.cpp at pinned versions; **verify SHA-256** against `scripts/binaries.lock.json`; fail on mismatch.
3. Typecheck, lint, unit tests, E2E smoke (same as CI) — a failing test **blocks the release**.
4. `electron-builder --win nsis portable --x64 --publish never` → artefacts in `dist/`.
5. **Generate checksums** `SHA256SUMS.txt`, the `release-manifest.json`, and **sign** it with `UPDATE_SIGNING_KEY` (Ed25519) → `release-manifest.json.sig`; also verify the signature with the embedded public key in the workflow (self-check).
6. **Clean-install smoke test on the runner:** run the installer silently (`/S /D=...` for NSIS per-user), launch the installed app with `--smoke-test` (a documented flag that opens the main window, checks bundled binaries (`ffmpeg -version`, `ffprobe`, `whisper-cli --help`, `yt-dlp --version`), creates a workspace in a temp dir, runs a **tiny real pipeline** (import a 3-second fixture, probe, export 1 s, validate with §7 of `14`), then exits 0), then run the uninstaller and assert the workspace remained. Also launch the **portable** exe with `--smoke-test`. Failure blocks the release.
7. Create the **GitHub Release** (draft first, then published after step 8) attaching: installer `.exe`, portable `.exe`, `latest.yml`, blockmaps (if used), `SHA256SUMS.txt`, `release-manifest.json`, `release-manifest.json.sig`, `THIRD-PARTY-NOTICES.txt`; notes from CHANGELOG (+ Unsigned notice). Use `softprops/action-gh-release` or `gh release create`, pinned by commit SHA (supply-chain hygiene: **pin all third-party actions by SHA**).
8. **Post-release verification job:** download the published assets via the public URL, re-verify checksums and the manifest signature, confirm `latest.yml` lists the right file, confirm the installer starts (`--smoke-test`) — then mark the release **latest**.
- Secrets used: `UPDATE_SIGNING_KEY`, optionally `CSC_LINK`/`CSC_KEY_PASSWORD`, and `GITHUB_TOKEN`. **No secret is ever echoed**; logs masked; the workflow has least-privilege `permissions` (`contents: write` only in the release job).
- **Reproducibility notes** (versions of Node, pnpm, Electron, electron-builder, ffmpeg, whisper.cpp, yt-dlp) are written to the release body.
- Manual `workflow_dispatch` on `release.yml` creates a **prerelease** from a branch for testing (never marks latest).

### 8.3 Repository files (mandatory)
`README.md` (what it is, screenshots placeholder rule: **real** screenshots only, install, quick start, features, offline/online table, link to Releases), `docs/install.md`, `docs/development.md` (setup, scripts, folder map), `docs/build.md`, `docs/providers.md`, `docs/local-models.md`, `docs/export.md`, `docs/formats.md` (`.cwstyle`, `.cwbrand`, `.cwpack`, `peaks.bin`), `docs/troubleshooting.md` (SmartScreen, antivirus false positives, GPU issues, missing ffmpeg, slow export, model download failures, update failures), `docs/release.md`, `docs/decisions.md`, `docs/limitations.md`, `docs/licences.md`, `docs/verification.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md` (how to report vulnerabilities, supported versions), `.github/ISSUE_TEMPLATE/*`, `CONTRIBUTING.md` (short). **No** private API keys, user media, credentials, or local files committed (enforced by `.gitignore`, gitleaks, and a pre-commit hook).

---

## 9. YT-DLP UPDATER (separate from app updates)
- Source: yt-dlp's official GitHub releases (`yt-dlp/yt-dlp`), the standalone `yt-dlp.exe` asset and its `SHA2-256SUMS` file; the app verifies the SHA-256 before replacing; the previous binary is kept as `yt-dlp.previous.exe` for rollback; failure keeps the old one.
- Stored in `%APPDATA%\Clipwright Studio\bin\yt-dlp.exe` (user-writable, **never** inside the install directory), preferred over the bundled one when newer and verified.
- UI: Settings → Updates → *yt-dlp*: version, *Check now*, auto-check toggle (default on, every 7 days), **Restore bundled version**. A download failure shows plainly "Link downloads use the version that came with Clipwright".
- Optional: the app's yt-dlp update **may be pinned/blocked** by a setting for locked-down environments.

---

## 10. TELEMETRY
**None.** No analytics, no crash upload, no usage pings. The only outbound traffic: update check, update download, yt-dlp update, model downloads, URL ingestion and user-configured AI providers (`06 §8`). Settings → Privacy lists them and the toggles.

---

## 11. EDGE CASES
No internet at startup (silent skip) · GitHub rate limit (unauthenticated API: use the `releases/latest` redirect + `latest.yml` download from the release asset URL rather than API calls where possible; back off) · release without a signature (refused) · release marked prerelease while on stable (ignored) · user on beta channel and a newer stable exists (offer stable) · antivirus quarantines the downloaded installer (message: "The downloaded file was removed by your security software" with a hint) · disk full during download (pause/resume or fail with numbers) · app closed during download (resumable partial file `*.part` with size check) · multiple app instances during install (single-instance lock; installer asks to close) · per-machine vs per-user mismatch on update (installer detects the previous install type) · installer launched but user cancels UAC (app remains running, state resets) · clock wrong (signature timestamps don't depend on the local clock except staleness warning) · very old version jumping many releases (migrations run sequentially, tested for the last 3 minor versions plus every schema fixture) · update while an export/transcription job runs (confirm, jobs resume afterwards) · corporate environments that block GitHub (clear message, manual download link shown).

---

## 12. ACCEPTANCE CHECKS (record results with real artefact names, sizes, hashes in `docs/verification.md`)
1. **Clean machine:** on a clean Windows 10/11 x64 VM with **no developer tools**, the NSIS installer installs per-user without admin rights, creates the Start-menu shortcut and (when ticked) a desktop shortcut, launches, creates a workspace, imports a fixture, transcribes (small model downloaded or the test model), finds moments (Basic mode), edits, and exports a validated file. **No missing DLL/runtime errors.**
2. The **portable exe** runs on the same VM without installing and passes the same smoke path; its update behaviour is as §6.3.
3. Installer and exe properties show the right product name, version, publisher text and the supplied logo icon; about/version info match `package.json`.
4. **Uninstall** removes the program and shortcuts, **keeps** the workspace/projects/media/exports/models; the optional checkbox removes only app settings/keys; reinstall reopens the old projects identically.
5. **Update check:** *no-update* state, *available* state (against a **real GitHub test release** in the actual repo or a fork, recorded with the URL), error states (offline, rate-limited, bad signature, tampered asset, downgraded manifest), skip/remind-later behaviour, automatic check schedule (verified by a clock-injected test), beta channel.
6. **Download verification:** a tampered installer (one byte changed) is rejected by sha256/sha512; a manifest with a bad/missing signature is rejected before any download; a swapped public key in a test build proves the signature check is real; resume of an interrupted download works.
7. **Install + data preservation:** update from the previous release to the new one on a populated workspace: projects, media (byte-identical), exports, settings, providers and keys (still present), models survive; migrations run with backups; the project reopens identically.
8. **Rollback:** simulate a failing new version (crash on startup twice) → Recovery window appears → *Restore previous version* restores the earlier version and settings and the app starts; a migration failure restores the pre-migration backups automatically.
9. **Update never silent:** with *Ask me*, nothing downloads or installs without a click (network-level assertion); the app never restarts itself without the user's confirmation; unsaved work is saved first.
10. **Unsigned honesty:** README, release notes, installer licence page and update dialog all state "Unsigned" when no certificate is configured (automated string check); SmartScreen steps documented.
11. **CI:** a tag push on a fork/test repo runs `release.yml` end-to-end: tests gate, binaries verified, artefacts built, manifest signed, clean-install smoke test passes, release published with **all** assets, post-release verification passes; the **GitHub Releases page link** with the installer is recorded.
12. **Security config tests:** an automated test asserts `contextIsolation`, no `nodeIntegration`, sandbox, CSP header, blocked navigation, devtools disabled in production, and that no secret appears in the packaged app (`asar` content scan) or the release artefacts (gitleaks on the extracted package).
13. **Licences:** `docs/licences.md`, `THIRD-PARTY-NOTICES.txt` and About list every bundled component with its licence; CI licence check passes; the ffmpeg build configuration and source offer are present.
14. **yt-dlp updater:** update replaces the binary only after the checksum matches; a corrupted download is rejected; *Restore bundled version* works.
15. **No telemetry:** a network capture of a full session (excluding the listed user-triggered features) shows **no** unexpected hosts.
