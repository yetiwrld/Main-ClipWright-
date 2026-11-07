# Releasing Clipwright Studio

Everything in this document is enforced by `.github/workflows/release.yml`. If
the workflow and this document disagree, the workflow is wrong — fix one of them
in the same pull request.

## 1. One-time setup

### 1.1 Generate the update signing key

Updates are verified with an Ed25519 signature over a release manifest. Generate
the pair **once**, on a machine you trust:

```bash
node scripts/release/gen-update-key.mjs
```

It prints two values:

| Value | Where it goes |
|---|---|
| Public key (base64) | `EMBEDDED_UPDATE_KEYS.current` in `apps/desktop/src/main/updater/update-config.ts`, **committed** |
| Private key (PKCS#8 PEM) | GitHub → Settings → Secrets → Actions → `UPDATE_SIGNING_KEY` |

Then delete the private key from your machine and clear your shell history.

Also set the **repository variable** `UPDATE_PUBLIC_KEY_B64` to the same public
key. The release job uses it to prove the published manifest verifies with the
key embedded in the app; without it, a mismatch between the secret and the
embedded key would publish a release that every installed copy silently refuses.

> Until a real public key is embedded, the app **refuses every update**. That is
> deliberate: an unverifiable update is never installed.

### 1.2 Binaries

`resources/bin` must contain verified Windows binaries. In a development
checkout it holds symlinks to a Linux build; the release job rejects those.

```bash
node scripts/release/fetch-binaries.mjs --update-hashes   # record digests
# review the diff to scripts/binaries.lock.json, then commit it
node scripts/release/fetch-binaries.mjs                   # verify against the lock
node scripts/release/verify-binaries.mjs                  # what packaging checks
```

Every digest change is a pull request a human reviews. An unreviewed hash change
is exactly how a supply-chain attack would arrive, so treat a diff to
`binaries.lock.json` with the same care as a diff to the signing code.

### 1.3 Code signing (optional)

Without `CSC_LINK` and `CSC_KEY_PASSWORD` the build is **unsigned**. The README,
the release notes, the installer licence page and the in-app update dialog all
say so; nothing in the product implies otherwise. If a certificate is supplied
later, CI signs the installer, the app exe and the uninstaller, and
`publisherName` verification is enabled on top of the signature check.

## 2. Making a release

1. **Bump the version** in `apps/desktop/package.json` (`MAJOR.MINOR.PATCH`, or
   `-beta.N` for a prerelease).
2. **Add the section to `CHANGELOG.md`.** The release job refuses to build
   without one — release notes are never typed into the release page by hand.
3. **Merge to `main`.** CI runs lint, typecheck and the full test suite.
4. **Tag it:** `git tag -a v1.3.0 -m "Clipwright Studio 1.3.0"` then
   `git push origin v1.3.0`.
5. **Watch the workflow.** It runs, in order:

   | Step | Refuses to continue when |
   |---|---|
   | Lint, typecheck, tests | anything fails |
   | `fetch-binaries.mjs` | a download does not match its pinned hash |
   | `verify-binaries.mjs` | a binary is missing, unpinned, zero-byte or a symlink |
   | `build-release-artefacts.mjs` | packaging fails, or no `.exe` was produced |
   | `assert-package.mjs` | the package has no launchable app or is implausibly small |
   | `make-manifest.mjs` | the signature does not verify with the embedded key |
   | `smoke-install.mjs` | the installer, the installed app or the portable exe fails to run |
   | draft release created | — |
   | `verify-published.mjs` | the published assets do not match the signed manifest |
   | **release published** | — |

6. **A failure after the draft is created leaves a draft**, never a "latest"
   release. Delete the draft, fix the problem, and re-tag.

### Prereleases

A version containing a hyphen (`1.3.0-beta.1`) is always published as a
prerelease on the beta channel, whatever the manual dispatch input says. Stable
users never see it.

`workflow_dispatch` builds a **prerelease** from any branch for testing and
never marks it latest.

## 3. What gets published

```
Clipwright-Studio-Setup-<version>-x64.exe      the installer
Clipwright-Studio-<version>-x64-portable.exe   the portable exe
latest.yml                                     what electron-updater reads
*.blockmap                                     (if produced)
SHA256SUMS.txt                                 what users are told to check
release-manifest.json                          version, sizes, hashes
release-manifest.json.sig                      Ed25519 signature over the above
RELEASE_NOTES.md                               the CHANGELOG section + unsigned notice
```

## 4. Key rotation

Rotation lets a new key take over without stranding anyone who has not updated.

1. Generate a second pair.
2. Put the new public key in `EMBEDDED_UPDATE_KEYS.next`, ship that release
   signed with the **old** key. The app now accepts either.
3. Change `UPDATE_SIGNING_KEY` to the new private key.
4. Once enough users are on a build that knows `next`, promote it: set
   `current` to the new key and clear `next`.

## 5. If the signing key is lost

There is no recovery: an update the app cannot verify is refused, so users on
the current version cannot be moved to a new one by the updater. The path
forward is a manual download from the release page, with the SHA-256 published
alongside it, and a fresh key for the release after that. Document it plainly in
the release notes — a user who does not understand why the app says "couldn't be
verified" will assume malware.

## 6. Rollback

Releases before the last good one stay on the releases page. Marking an older
release "latest" restores it for new downloads, but the app will refuse to
downgrade itself (SPEC 15 §5), so users on the bad version need the manual
installer. The previous installer is cached in `<workspace>/Updates/previous/`
for the recovery window described in SPEC 15 §7.
