# Installing Clipwright Studio

Windows 10 or 11, 64-bit only. No administrator rights required.

## Which file do I want?

Download from the [Releases](https://github.com/yetiwrld/Main-ClipWright-/releases) page.

| File | Use it when |
|---|---|
| `Clipwright-Studio-Setup-<version>-x64.exe` | **Most people.** Installs per-user, adds Start-menu and (optionally) desktop shortcuts, registers file associations, and can update itself. |
| `Clipwright-Studio-<version>-x64-portable.exe` | You want no installation — a USB stick, a shared machine, or a locked-down PC. |

Both are the same application. The portable one can check for and download
updates but does not replace itself; you swap the file when a new version comes
out.

## This build is unsigned

The installer carries no code-signing certificate, so Windows SmartScreen will
probably say **"Windows protected your PC"** and name an unknown publisher.

That is expected. To continue:

1. Click **More info**.
2. Check the publisher line says nothing, then click **Run anyway**.

You are trusting this build because you chose to, not because Windows vouched
for it. If you want to check before running it, compare the SHA-256 of the file
you downloaded with `SHA256SUMS.txt` on the release page:

```powershell
Get-FileHash .\Clipwright-Studio-Setup-1.3.0-x64.exe -Algorithm SHA256
```

The app itself does not accept unsigned updates: every release is verified
against a signed manifest, and anything that fails is refused.

## Installing

1. Run the installer.
2. Choose **Just me** (the default) — no admin rights needed.
3. Optionally change the install folder, and leave **Create a desktop shortcut**
   ticked if you want one.
4. Finish. The app opens.

On first launch it asks where to keep your workspace — projects, media, exports
and downloaded models. Pick a folder with room to grow; a long video project
with source media can be tens of gigabytes. The default is
`Documents\Clipwright Studio`.

## Portable use

The portable exe uses `%APPDATA%\Clipwright Studio` by default, exactly like an
installed copy, so moving the file does not lose your work.

If you want everything next to the exe — for a USB stick — create an **empty
file named `portable.flag`** in the same folder. Data then lives in
`ClipwrightData\` beside it.

> API keys are encrypted with Windows' per-user `safeStorage`. Moving the exe to
> another PC or another Windows user means re-entering them.

## Uninstalling

Windows Settings → Apps → Clipwright Studio → Uninstall.

This removes the program, shortcuts and file associations. It **never** deletes
your workspace, projects, media, exports or downloaded models.

There is an unchecked option to also remove app settings and saved API keys.
Ticking it deletes `%APPDATA%\Clipwright Studio` only — your workspace folder is
left alone, and the uninstaller tells you where it was.

## What the app bundles

`ffmpeg`, `ffprobe` and `whisper-cli` are included so the app works offline
immediately. No separate installs, no PATH editing. Speech models are downloaded
on first use. Full licence details are in `docs/licences.md` and in the app
under About → Third-party notices.

If a bundled binary fails its checksum at startup, that tool is disabled with a
message telling you to reinstall, rather than running something unexpected.

## Next steps

- [Troubleshooting](troubleshooting.md) — SmartScreen, antivirus, GPU problems,
  missing ffmpeg, slow exports, update failures.
- [Getting started](../README.md) — import a video, transcribe, find moments,
  export.
