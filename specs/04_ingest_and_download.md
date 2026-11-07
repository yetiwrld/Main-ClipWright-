# SPEC 04 — INGEST, DOWNLOAD, PROBING AND PROXIES

**Binding.** Follows the structure of `specs/09`. UI shell: `02`. Storage layout: `03`. Consumers: `05`, `08`, `14`.
Code lives in `/packages/media-core` (wrappers, no UI) and the Electron **media worker** (utility process).

---

## 1. PURPOSE

Turn "a file or a link" into **a safely stored, fully understood media asset** with the derived files the rest of the app needs (audio for transcription, proxy for smooth editing, waveform, thumbnails), without ever blocking the UI and without ever circumventing access controls.

---

## 2. SUPPORTED INPUTS

| Kind | Extensions (checked by ffprobe, not only by extension) |
|---|---|
| Video | mp4, m4v, mov, mkv, webm, avi, flv, wmv, mpg, mpeg, mts, m2ts, ts, 3gp, ogv |
| Audio | mp3, wav, aac, flac, m4a, ogg, opus, wma |
| Images | png, jpg, jpeg, webp, gif (first frame, static), svg, bmp, tiff |
**Rule:** a file is accepted if `ffprobe` can read at least one decodable video, audio or image stream. Extension mismatches are tolerated (probe decides). Unreadable/corrupt files produce a clear error naming the problem (no video stream, corrupt header, unsupported codec) and, where the codec is the issue, the codec name.
Sources on the **start page** must be video. Audio and images are accepted in the **editor's media library** (`08`) and follow the same copy/probe pipeline.

---

## 3. URL INGESTION

### 3.1 Architecture
- Interface `IngestSource { canHandle(url); probe(url): MediaPreview; download(url, opts, onProgress, signal): DownloadedFile }`.
- Implementations: **`YtDlpSource`** (public video pages; wraps the bundled `yt-dlp` + FFmpeg) and **`DirectFileSource`** (a URL that returns a video file: Content-Type `video/*` or a recognised extension; own downloader using HTTP Range for resume).
- Adding a source = adding a class; no UI changes.
- The bundled `yt-dlp` can be **updated from Settings → Updates** (separate from app updates) because site support changes often. Show its version in About.

### 3.2 Probe (before any download)
Run on paste/typing-pause (600 ms debounce) and again when the user clicks Find clips if the link changed.
- `yt-dlp --dump-single-json --no-playlist --skip-download` (timeout 20 s). **Playlists:** only the single video is used; if the link is a playlist, use the first video and show a note.
- Returns `MediaPreview {title, uploader, durationSec, thumbnailUrl, formats[], isLive, webpageUrl, estimatedSizeBytes}`.
- Rules: **live streams** are refused ("Live streams can't be downloaded until they finish"); durations over **4 hours** require a confirm; thumbnails are fetched through the main process, shown, and cached.

### 3.3 Download
- Quality setting (720p / 1080p / Best): pick the best video ≤ height + best audio, merged to **MP4 (H.264/AAC where available, else MKV)** via FFmpeg. Never re-encode if a compatible stream exists (`--merge-output-format mp4`, `-c copy`).
- Progress: parse yt-dlp's machine-readable progress (`--progress-template` JSON or `--newline` with a strict parser) into `{percent, downloadedBytes, totalBytes, speedBps, etaSec, phase}`. Phases: *video*, *audio*, *merging*. Overall percent = weighted by stream sizes; merging = last 3%.
- Throttle UI events to **≤ 10 per second**.
- **Resume:** partial downloads kept (`--continue`) in `Cache/downloads/<jobId>`; Resume after cancel, crash or network loss continues, not restarts.
- **Retries:** network errors retry 3× with backoff (2 s, 5 s, 15 s) before failing; the UI shows "Connection lost — retrying (2/3)".
- **Cancel:** kills the entire process tree (yt-dlp and ffmpeg children), keeps partial files for Resume; "Start over" deletes them.
- Output is moved into `Media/<mediaId>/original.<ext>` only when complete and verified with ffprobe.
- Disk space: before starting, require **3× expected size** free on the workspace drive and on the temp drive; otherwise the failure panel offers Choose another drive.

### 3.4 Error mapping (human wording; never raw output)
| Detected condition | Message | Actions |
|---|---|---|
| Private / members-only / requires login | "This video is private or needs a login. Clipwright can't download it." | (optional) cookies option below |
| Age-restricted needing sign-in | "This video needs you to be signed in to confirm your age." | cookies option |
| Geo-blocked | "This video isn't available in your region." | — |
| DRM / protected stream | "This video is protected (DRM). Clipwright can't download protected videos." | Import a file you own instead |
| Removed / not found | "This video is no longer available." | — |
| Rate limited / HTTP 429 | "The site is limiting requests. Try again in a few minutes." | Retry |
| Unsupported site | "This site isn't supported. If you have the file, import it instead." | Browse file |
| No network | "No internet connection." | Retry |
| Disk full | see 3.3 | Choose drive |
| Unknown | "Something went wrong while downloading." | Details, Copy details |
**Never** attempt to defeat DRM, paywalls, account restrictions, or platform protections. No circumvention features.

### 3.5 User-authorised sources (optional, off by default)
Advanced → "Use a cookies file for sites where I'm signed in": the user selects a cookies file exported from their own browser. A one-time notice states they must only download content they are entitled to download and that the file stays on their computer. The file path is stored (not the contents), never logged. This is the **only** authentication mechanism.

---

## 4. LOCAL FILE IMPORT

### 4.1 Storage modes
- **Copy into library (default, recommended):** stream-copy to `Media/<mediaId>/original.<ext>` with progress (bytes), preserving the original name in the DB. Verify size after copy; compute **SHA-256** in the background (for dedupe/relink).
- **Reference original:** store the absolute path, volume serial/ drive label, size, modified time, and SHA-256 of the first and last 1 MB (fast fingerprint). Missing/changed files are detected at project open and on use → Relink flow (4.6).
- **Dedupe:** if the fingerprint matches an existing managed asset, offer "Use existing copy" (default) or "Import again".

### 4.2 Safety
- Never modify, move or delete the user's original file. Never write next to it.
- Files larger than free space → blocked with the exact numbers.
- Very long paths (> 260 chars), Unicode, spaces, and network (UNC) paths must work (use extended-length paths where needed; pass args to FFmpeg without shell interpolation).

---

## 5. INSPECTION (ffprobe)

Run `ffprobe -v error -show_format -show_streams -of json` (timeout 30 s; for huge files do not scan packets). Store a **MediaInfo** record:

```ts
interface MediaInfo {
  mediaId; kind: 'video'|'audio'|'image'; container; durationUs; sizeBytes; bitrate;
  video?: { codec; profile; width; height; displayWidth; displayHeight; rotation: 0|90|180|270;
            sar; dar; fps: number; fpsMode: 'constant'|'variable'|'unknown'; pixFmt; colorSpace; hdr: boolean; bitDepth; hasAlpha };
  audio: Array<{ index; codec; channels; sampleRate; language?; title?; default: boolean }>;
  metadata: Record<string,string>; creationTime?;
}
```
- **Rotation:** read the display-matrix/rotate tag; `displayWidth/Height` are the post-rotation values used everywhere in the UI and in framing.
- **Frame rate:** use `avg_frame_rate`; compare with `r_frame_rate`. If they differ by > 1%, or a sampling of the first 300 packet timestamps shows non-uniform deltas (> 5% jitter), mark `fpsMode: 'variable'` and show a note in the inspector ("Variable frame rate: proxies are converted to constant frame rate").
- **HDR / wide gamut** (PQ/HLG, BT.2020): `hdr: true`; proxies and preview are tone-mapped to SDR (BT.709); export warns when exporting HDR sources to SDR output.
- **Multiple audio streams:** the project picks the default one (the first marked default, else first); the user can change it in the inspector and the transcription audio extraction uses the chosen stream.
- **Zero-duration/zero-size, no streams:** reject with explanation.
- Present key facts on the import screen: resolution, aspect ratio, fps (and VFR note), duration, audio tracks, size, codec.

---

## 6. DERIVED FILES (all generated in the background, all cached)

All outputs live in `Media/<mediaId>/` and are tracked in a `derived_files` table (kind, path, params, status, createdAt) so they can be validated, rebuilt or deleted safely.

### 6.1 Order and priority
1. **Probe** (blocking, fast).
2. **Transcription audio** — `audio16k.wav` (**high priority**; needed first).
3. **Thumbnails** (poster frame + filmstrip seed) — high.
4. **Proxy video** — normal (background, low CPU priority).
5. **Waveform peaks** — normal.
The editor and moments screens must work **before the proxy exists** (fallback: decode from the original with seek tolerance and a visible "Preparing smoother preview…" chip); once the proxy finishes, playback switches seamlessly at the next seek or play.

### 6.2 Transcription audio
`ffmpeg -i <src> -map 0:a:<chosen> -vn -ac 1 -ar 16000 -c:a pcm_s16le audio16k.wav` (with `-hide_banner -nostdin`). Progress from `-progress pipe:1`. Source with **no audio** → mark `hasSpeechAudio:false`; the transcribe stage shows "This video has no audio to transcribe" and offers to skip to the editor.

### 6.3 Proxy video
Create a proxy when **any** is true: source height > 1080; codec is not reliably decodable in Chromium (HEVC, ProRes, DNxHD, MPEG-2, VC-1, 10-bit H.264); fpsMode is variable; HDR; or the setting "Always create proxies" is on. Skip for ordinary ≤ 1080p H.264 CFR (use the original; no wasted disk/CPU).
- Settings: **Low 360p / Medium 540p / High 720p** (default Medium; Settings → Performance & proxies).
- Command (adapt flags to the bundled FFmpeg): H.264, `-vf "scale=-2:<H>,fps=<projectFpsOrSourceCfr>,format=yuv420p"` (add tone-mapping filters for HDR), `-c:v libx264 -preset veryfast -crf 23 -g 15 -keyint_min 15 -sc_threshold 0`, `-c:a aac -b:a 128k -ar 48000`, `-movflags +faststart`. **Short GOP (15) makes scrubbing responsive.** Use hardware H.264 encoders (NVENC/QSV/AMF) only if detected and validated by a 1-second test encode; otherwise `libx264`.
- Proxy is **constant frame rate**; timestamps map 1:1 to the source timeline (verify: durations equal within 1 frame).
- Never used for export unless the user chooses "Draft export".
- Rebuildable; deleting proxies never harms projects.

### 6.4 Thumbnails and waveform
- Poster frame at 10% of duration (or first non-black frame within the first 10 s). Filmstrip frames are generated on demand by the timeline (`09 §19`) from the proxy.
- Waveform peaks file `peaks.bin` with two resolutions (256 and 4096 samples/peak) generated from `audio16k.wav` (or the proxy audio for non-chosen streams); binary format documented in `docs/formats.md`.

### 6.5 Concurrency and resources
- ffmpeg jobs run in the media worker. Default concurrency = **max(1, physicalCores − 2)** jobs, with each ffmpeg `-threads` limited so the UI stays smooth; background derived-file jobs run at **below-normal OS priority**.
- Never hold whole files in memory; stream everything.

---

## 7. IMPORTING ADDITIONAL MEDIA (editor)
Same pipeline for any file dropped into the media library or timeline: probe → copy/reference (per setting) → derived files as relevant (audio gets peaks; images get thumbnails; SVG is sanitised (scripts/external refs stripped) and rasterised on demand). Many files at once are queued with a per-file progress row in the library.

---

## 8. MISSING FILES AND RELINKING
- At project open and before use, referenced originals are checked (existence, size, fingerprint). Managed copies are checked by existence.
- Missing → the asset shows a red "Missing" badge in the library and on timeline clips (`09 §10`). A **Relink** dialog lists all missing assets of the project, lets the user pick a replacement file (fingerprint compared; a mismatch shows a warning but is allowed), or **Locate folder** (searches the chosen folder recursively for matching filenames/fingerprints and relinks all it finds).
- Export refuses missing media with a list of what to relink.

---

## 9. JOB QUEUE (shared infrastructure)
- Persistent table `jobs {id, type, projectId, mediaId?, params, status, priority, progress, attempt, error, startedAt, finishedAt}`; statuses: `queued, running, paused, cancelling, cancelled, failed, done`.
- Types used by this spec: `probe, copy, download, extract_audio, thumbnails, proxy, peaks`; later specs add `transcribe, analyse, export`.
- Priorities: user-blocking (probe, copy, download, extract_audio, transcribe, export) > editing helpers (thumbnails, peaks) > background (proxy).
- **Survives restarts:** on launch, `running` jobs become `queued` and resume (download/transcription resume from their checkpoints).
- Cancel kills child processes cleanly and cleans or keeps partials as specified per job type.
- Progress events: throttled to 10 Hz, delivered over typed IPC; the background-tasks popover (`02 §2.2`) renders from this table.
- A failed job stores a **user-facing message** plus a technical log excerpt (redacted).

---

## 10. EDGE CASES
Filename with quotes/`&`/Unicode/emoji · path > 260 chars · UNC path · file locked by another program (retry then explain) · file grows during import (live recording) → warn · zero-byte · 8K video (proxy only, warn about speed) · audio-only source on start page → "Please choose a video" · multiple video streams (use the first, note) · video with embedded subtitles (ignored in v1, noted) · odd dimensions (pad/scale to even for proxies) · variable frame rate phone footage · no network during URL download → resume later · low disk mid-job → pause with a clear message and Resume after freeing space · antivirus lock on output → retry · timezone/`creation_time` missing.

---

## 11. ACCEPTANCE CHECKS
1. Import fixtures: 1080p landscape MP4, portrait phone MOV (rotation), 4K HEVC, VFR phone clip, MKV, WebM, no-audio video, audio-only, PNG/SVG. Each produces a correct MediaInfo (verified against `ffprobe` by an automated test).
2. A 2-hour 1080p file imports (copy) with true byte progress and a responsive UI; cancel at 50% leaves no corrupt file in `Media/`.
3. Proxy: a 4K HEVC source gets a Medium proxy with equal duration (±1 frame), CFR, GOP 15, and scrubbing is responsive; an ordinary 1080p H.264 CFR source gets **no** proxy.
4. URL: a public video downloads with real percentage, speed and ETA; cancel + resume continues from the partial; an unsupported/private/removed link shows the mapped message; a DRM-protected link is refused clearly.
5. Direct file URL downloads with resume after the network is disabled and re-enabled.
6. Reference mode: renaming the original → Missing badge → Relink restores it; export blocked while missing.
7. Dedupe: importing the same file twice offers reuse.
8. Quit during a download/proxy → relaunch resumes the job automatically.
9. Job queue limits ffmpeg concurrency; UI stays at 60 fps while 3 jobs run on the reference machine.
10. Unicode/long/UNC path files import correctly. Corrupt and zero-byte files fail with the right messages. No raw errors reach the UI.
