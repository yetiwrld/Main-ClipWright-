# Troubleshooting

Each entry says what you will see, what causes it, and what actually fixes it.
If a fix here does not work, `docs/verification.md` records what has been tested
and what has not — check whether your problem is in the second list before
assuming the app is broken.

## Installing

### "Windows protected your PC" / unknown publisher

**You will see:** a blue SmartScreen window naming an unknown publisher.

**Cause:** the build is unsigned. See [install.md](install.md).

**Fix:** More info → Run anyway. Check the SHA-256 against `SHA256SUMS.txt`
first if you want certainty.

### Antivirus deletes the installer or the app

**You will see:** the file vanishes after downloading, or the app fails to start
with "Windows cannot access the specified device, path or file".

**Cause:** Electron apps and bundled `ffmpeg` are both common false positives,
more so unsigned.

**Fix:** add an exclusion for the install folder. The app also checks the
checksum of its bundled binaries at startup; if one was quarantined it reports
which tool is missing and suggests reinstalling rather than failing silently.

### The installer fails with no message

**You will see:** the installer exits and nothing is installed.

**Cause:** usually insufficient permissions on the chosen folder.

**Fix:** choose a folder you own (your user profile). Per-user installs need no
admin rights, and installing per-machine is only offered when you run the
installer elevated.

## Core tools

### "ffmpeg not found" / a tool is disabled

**You will see:** a message that a bundled tool could not be verified or found.

**Cause:** the binary was removed, quarantined, or its checksum does not match
`resources/bin/checksums.json`.

**Fix:** reinstall the app. The app deliberately disables a tool whose checksum
does not match rather than running it.

### Transcribe does nothing / no microphone-style models

**You will see:** transcription stalls, or says a model is required.

**Cause:** speech models are downloaded on first use and are not bundled.

**Fix:** check your connection and the model download page in Settings.
`docs/local-models.md` lists the models and their sizes.

## Export

### Export is very slow

**You will see:** an ETA far longer than the clip's length.

**Cause:** CPU encoding at 4K or 60 fps is slower than real time. This is
expected and is stated in the app.

**Fix:** try 1080p, or a lower frame rate. The export dialog shows the encoder
actually in use; if it says software, hardware encoding either is not present or
did not pass validation on your machine.

### GPU encoding is not being used

**You will see:** the encoder line says software.

**Cause:** the app tries NVENC, QSV, AMF and VideoToolbox in order and falls
back to software when a candidate fails a real test encode.

**Fix:** update your GPU driver. The app deliberately does not trust a driver
just because it lists an encoder — it runs one and checks the output, because a
silently-corrupt hardware encode is worse than a slower correct one.

### "A file used in this clip can't be found"

**You will see:** the export stops with that message, or the queue shows it.

**Fix:** the source media moved or was deleted. Use the relink action in the
project, or reimport the file.

### An export finishes but shows "Done with warnings"

**You will see:** the file exists and plays, with a warning chip.

**Cause:** one of the 14 non-required validation checks could not be measured or
did not pass — a mostly-static clip legitimately fails the black-frame detector,
for example.

**Fix:** usually nothing; open the validation report to see which check. A
failed *required* check is a different thing — that export is marked Failed.

## Updates

### "This update couldn't be verified"

**You will see:** the update dialog refuses to download.

**Cause:** the release manifest's signature did not verify, there was no
signature, or it disagreed with `latest.yml`. The app refuses rather than
installing something it cannot vouch for.

**Fix:** retry later. If it persists, download the installer manually from the
release page and check the SHA-256 — and please report it, because this is
exactly the case the signature exists to catch.

### "Couldn't reach GitHub"

**You will see:** the manual check fails with that message.

**Cause:** no connection, a proxy blocking GitHub, or a rate limit.

**Fix:** the message distinguishes a rate limit ("GitHub is limiting requests")
from a network failure. A corporate proxy that intercepts TLS will also land
here; the app never offers to bypass certificate checks, by design.

### Automatic checks never seem to run

**You will see:** "Last checked" is very old.

**Cause:** automatic checks are off, or the interval is set long.

**Fix:** Settings → Updates. Note that a startup check waits 20 seconds and will
not run more than once every 6 hours, so restarting repeatedly will not force
one — use **Check for updates now**.

### The portable build downloaded an update but did not install it

**You will see:** a message telling you to replace the file.

**Cause:** that is the design. A portable exe cannot replace itself safely.

**Fix:** close the app, replace the exe with the downloaded one, start it again.

## Data

### I closed the app and lost unsaved work

**You will see:** the project reopens at an earlier state.

**Cause:** projects save on explicit save and on close; a crash loses anything
since the last save.

**Fix:** `docs/decisions.md` records the recovery behaviour. Check
`<workspace>/Backups` for the automatic pre-migration copies.

### Uninstalling removed my projects

It should not — the uninstaller never touches the workspace. If your workspace
was inside the install folder (unusual), restoring it needs a file-recovery
tool. The uninstaller tells you where the workspace is before removing anything.

## Reporting a problem

Include: the app version (Settings → About), your Windows version, what you did,
what happened, and the log. Logs are under
`%APPDATA%\Clipwright Studio\logs` — attach the relevant file. The app sends no
telemetry, so a bug report is the only way the team hears about it.
