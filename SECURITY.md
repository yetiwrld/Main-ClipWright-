# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/yetiwrld/Main-ClipWright-/security/advisories/new)

Include:

- what the issue is and what an attacker could do with it;
- the version and Windows build you tested;
- steps to reproduce, or a proof of concept;
- whether you are willing to be credited.

You will get an acknowledgement within **7 days**. If a fix is needed, a
coordinated disclosure date is agreed before anything is published.

## Supported versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything older | Only if the issue is also present in the latest release |

## Scope

In scope:

- The update mechanism — signature verification, manifest parsing, any way to
  make the app install something that was not signed by the project.
- The renderer sandbox — any way to reach Node or the filesystem from renderer
  content, or to break out of the CSP.
- The media scheme (`clipwright-media://`) — any way to read a file outside the
  workspace through it.
- The URL ingestion path — any way to make the bundled `yt-dlp` or `ffmpeg`
  execute something unintended through a crafted URL or filename.
- Bundled binaries — if a shipped binary does not match its recorded checksum.
- Path traversal anywhere a workspace path, project name or export filename is
  used.

Out of scope:

- SmartScreen warnings about an unsigned build. The build is unsigned on
  purpose and says so everywhere; see [docs/install.md](docs/install.md).
- Anything that requires an attacker who already has code execution or
  administrator rights on the machine.
- Denial of service through an absurdly large or malformed media file, unless it
  escapes the sandbox or corrupts data.
- Third-party components with their own reporting process (report those
  upstream; tell us if the app needs to update the pin).

## How the update mechanism is meant to be safe

Worth knowing before you look for bugs in it:

1. Every release carries `release-manifest.json` and a detached Ed25519
   signature, `release-manifest.json.sig`.
2. The app embeds only the **public** key. The private key exists solely as a
   GitHub Actions secret.
3. The signature is checked **before** any hash comparison, so a forged manifest
   cannot steer the download.
4. The manifest's hashes must agree with `latest.yml`, which is what
   `electron-updater` consumes.
5. A downloaded file whose SHA-256 does not match the signed manifest is deleted,
   not kept.
6. Redirects are followed only to `github.com` and GitHub's asset hosts.
7. A build with no embedded key **refuses every update** rather than trusting
   one it cannot verify.

If you find a way around any of those, that is exactly the report we want.

## What the app does with data

No telemetry, no analytics, no crash reporting. The only outbound traffic is:
update checks and downloads, `yt-dlp` updates, model downloads, URL ingestion,
and any AI provider you configure yourself. Settings → Privacy lists them and
lets you switch the optional ones off.
