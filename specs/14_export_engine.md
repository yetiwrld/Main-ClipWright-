# SPEC 14 — EXPORT ENGINE: RENDER PIPELINE, PRESETS, QUEUE AND VALIDATION

**Binding.** Follows the structure of `specs/09`. Related: `01` (UI), `03` (Exports folder, history), `04` (decoding, job queue), `08` (Export button), `09` (timeline data), `10` (compositor shared with preview), `11` (text rendering, subtitles), `12` (effects, transitions, audio mix), `15` (bundled ffmpeg build/licences), `16` (test matrix).
Code: `/packages/export-core` (planner, queue logic, validation; no UI), `/packages/compositor` (`renderFrame`), `/packages/audio-core` (mix), `/apps/desktop/src/main/export` (orchestration, hidden render window, ffmpeg processes), UI in `/apps/desktop/src/renderer/features/export`.

---

## 1. PURPOSE

Produce a final video that is **exactly what the timeline describes**: the right pixels, the right sound, the right size, frame rate and duration. **Never** record the screen or the preview. **Never** report success until the produced file has been opened, decoded and checked against what was promised.

---

## 2. ARCHITECTURE (mandatory)

```
Composition ──► ExportPlanner ──► ExportPlan (frames, items, decoders, audio graph, subtitles)
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        ▼ VIDEO                                                 ▼ AUDIO
  hidden BrowserWindow (offscreen)                       AudioMixer (audio-core, utility process)
  renderFrame(t) for t = 0…N-1  (same compositor as preview)     decode items → float32 PCM → envelopes → mix → limiter
  ExportFrameProvider ← ffmpeg raw decoders per video item        │ (PCM stream)
        │ YUV420 (GPU pass) frames via MessagePort                │
        ▼                                                         ▼
  ffmpeg ENCODER process: -f rawvideo (stdin) + audio pipe/file ──► mux ──► temp file ──► validate ──► final path
```
1. **Single rendering truth:** video frames come from `renderFrame(composition, timeUs, ctx)` (`10 §2.1`) running in a **hidden, offscreen Electron window** with WebGL2 (ANGLE/hardware GL; **software GL fallback** if the GPU fails, slower but correct). The same text/effects/transitions/keyframe code and the same `TextRenderer` fonts as the preview (`11 §2`) → parity (golden-frame SSIM ≥ 0.995, `10 §15`).
2. **Never the preview window.** The editor window is not used and is not captured; closing or resizing it does not affect an export.
3. **Deterministic timeline sampling:** output frame `i` is rendered at timeline time `t_i = frameToUs(i)` (`09 §3`) for `i = 0 … N−1`, `N = round(durationSeconds × fps)` (with `durationUs` quantised to the frame grid). No wall-clock dependence.
4. **Source decoding is separated from rendering:** each active video item has an `ExportFrameProvider` backed by an **ffmpeg decode process** producing raw RGBA/YUV frames **at the project fps on the item's own timeline mapping** (§4.2). The renderer never uses `<video>` elements in export.
5. **Audio is mixed independently** by the `AudioMixer` (`12 §6.1`), sample-exact, then handed to the encoder; no reliance on ffmpeg's `amix` for gain/envelope logic.
6. **Encode = ffmpeg** (bundled, `15`) reading rawvideo from stdin and audio from a pipe or a temp WAV; output to a **temp file in the destination folder** (`<name>.partial.<ext>`) renamed atomically after validation.
7. Everything long-running is a **job** (`04 §9`, type `export`) in the **utility/worker processes** so the editor stays usable; jobs persist across restarts (resume is **restart-from-scratch** for a failed render unless §9 checkpointing is implemented — stated clearly in the UI).

---

## 3. EXPORT SETTINGS (dialog/panel, opened by **Export**, `Ctrl+E`)

Layout: a right-side **export panel** over the inspector region in standard/large tiers, a full dialog in compact (`01 §9`). Sections:

### 3.1 Range and content
- **What to export:** *Whole clip* (default) · *Work area* (`09 §18`) · *Selected clips…* (from the clip bin) · *Multiple clips (batch)* (checkbox list of compositions).
- **Video:** *Include video* (always); **Audio:** *Include audio* (on), *Normalise loudness to [−16 LUFS ▾ / Off]* (`12 §6.6`), *Include solo state* (off).
- **Captions:** *Burn captions into video* (default on) · *Also save subtitle file(s)* (SRT / WebVTT, one per caption track) · *Subtitle file(s) only* (`11 §13`).
- **Draft export** toggle: *Use preview proxies and quick settings for a fast check* (renders from proxies at 720p-ish, fast preset, watermark-free, file named `…-DRAFT`). Never the default; clearly labelled "Not final quality".

### 3.2 Resolution presets (the **short-side** rule)
Presets are defined by the **short side** of the output, so they apply to every aspect ratio, and the **selected aspect ratio is always preserved** (no stretching, no forced landscape). Portrait projects get portrait outputs (9:16 at 1080p = 1080×1920). Both sides are rounded to **even** numbers (`round(x/2)·2`) as H.264/AAC require.

| Preset | Short side | 16:9 | 9:16 | 1:1 | 4:5 | 4:3 | 21:9 |
|---|---|---|---|---|---|---|---|
| **720p** | 720 | 1280×720 | 720×1280 | 720×720 | 720×900 | 960×720 | 1680×720 |
| **1080p** | 1080 | 1920×1080 | 1080×1920 | 1080×1080 | 1080×1350 | 1440×1080 | 2520×1080 |
| **DCI 2K** | 1152 | 2048×1152 | 1152×2048 | 1152×1152 | 1152×1440 | 1536×1152 | 2688×1152 |
| **QHD 1440p** | 1440 | 2560×1440 | 1440×2560 | 1440×1440 | 1440×1800 | 1920×1440 | 3360×1440 |
| **4K UHD** | 2160 | 3840×2160 | 2160×3840 | 2160×2160 | 2160×2700 | 2880×2160 | 5040×2160 |

*Contract:* `short = presetShortSide; long = round_even(short × longAspect / shortAspect)`; width/height are assigned by orientation. This function is the contract and is **unit-tested for every aspect × preset cell** (the table above is the expected result). **Original aspect** and **custom aspect** use the same function. "DCI 2K" here is the 2K tier (2048 on the long side at 16:9); the cinema container 2048×1080 can be entered as a custom size.
- **Custom resolution:** width×height fields with *Lock aspect* (default on), min 128, max 7680 per side (warn above 4K: "may be slow or fail on this computer"); odd values are rounded to even with a visible note.
- **Source-resolution note:** if the **main video source** is smaller than the output, show an info note "Your source is 720p; exporting at 4K won't add detail" (info only, never blocking).
- The canvas aspect is `project.canvas.aspect`; changing it is done in the editor (`08 §7.4`), not here. The dialog shows the resulting **exact pixel size** live.

### 3.3 Frame rate
- **30 fps** and **60 fps** (required) plus **Match project** (default = the composition's `fps`, 30 or 60). If the chosen export fps ≠ composition fps, the planner **re-samples the timeline** at the export fps (it evaluates keyframes at the new frame times; clip edit boundaries stay time-accurate; source frames are picked by nearest-time). The dialog shows: "Source footage is 29.97 fps (variable). Output will be exactly 30 fps constant." and for VFR "Variable-frame-rate source: frames are placed on a constant 30 fps grid."
- Frame-rate conversion is **predictable**: constant-frame-rate output, no motion interpolation (no frame blending) unless an item has *Smooth slow-motion: Blend*; duplicate/drop frames follow nearest-time selection (documented in `docs/export.md`).

### 3.4 Codecs, containers and quality
| Format | Video | Audio | Notes |
|---|---|---|---|
| **MP4 (default)** | **H.264 (libx264 or hardware)**, High profile, yuv420p, `-movflags +faststart` | **AAC-LC**, 48 kHz | Required, most compatible |
| MP4 | **H.265/HEVC** (hardware encoders only if present, or libx265 if the bundled build includes it) | AAC | Offered **only when the encoder is available and validated**; patent/licence note in the UI info tooltip |
| **WebM** | **VP9** (libvpx-vp9, CRF, row-mt) | **Opus** | Required as the second format |
| **MOV (optional)** | H.264/AAC | | Stretch |
| **GIF / image sequence / ProRes** | — | — | **Out of scope**, absent from UI |
- **Quality presets:** *Draft*, *Standard* (default), *High*, *Maximum*, and **Custom bitrate**. Mapping (documented table in code and `docs/export.md`, encoder-specific): libx264 CRF 26/22/19/16 with `-preset veryfast/fast/medium/slow`; VP9 CRF 38/33/30/27, `-b:v 0`; hardware encoders use constant-quality (`-cq`/`-global_quality`/`-qp`) where supported with documented equivalents, otherwise bitrate targets from a **resolution × fps lookup** (e.g. 1080p30 ≈ 8 Mbps Standard, ×1.5 for 60 fps, scaled by pixel count).
- **Custom bitrate:** video bitrate (Mbps), **rate control** *VBR (default) / CBR*, optional **max bitrate** and buffer; **two-pass** optional for libx264/VP9 (disabled for hardware). Audio bitrate: 96/128/160/192/256/320 kbps (default **192**). Estimated **file size** shown live (duration × bitrate).
- **Hardware acceleration:** detect at app start and on demand (*Settings → Performance*): NVENC (NVIDIA), QSV (Intel), AMF (AMD) by running a **1-second test encode** of a synthetic frame with each encoder in the bundled ffmpeg; show only validated options. **Auto** (default): hardware if validated else `libx264`; the dialog shows what will be used ("H.264 · NVIDIA NVENC"). A **hardware failure mid-export falls back to libx264 automatically** with a one-time message and a restart of the encode step (not the whole render if frames were buffered — otherwise restart) and records the reason in the job log. *Force CPU* toggle. Hardware encode quality is slightly different — mentioned in the tooltip.
- **Colour:** SDR **BT.709**, limited range, tagged (`-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`); HDR sources are tone-mapped at decode (`04 §5`); the dialog warns "HDR source will be exported as SDR".
- **Metadata:** title (default = clip name), author/comment (optional), creation time; strip location/device metadata of sources (never copied). Setting "Embed project name" on by default.
- **Output folder** (default `<workspace>/Exports/<project>/`, remembered; *Choose…*; *Ask each time*), **file name** with a **template** `{project}-{clip}-{preset}` (tokens: `{project} {clip} {date} {time} {res} {fps} {aspect} {n}`); invalid Windows characters are sanitised and shown; on a **name clash**: *Auto-number* (default) / *Replace* (confirm) / *Ask*. Free-space check: required = estimated size × 1.5 + the temp needs; blocked with numbers if insufficient.
- A **summary line** always visible: "1080×1920 · 30 fps · H.264 · AAC 192 kbps · ≈ 48 MB · ≈ 2 min on this computer" (time estimate from measured throughput after the first export; before that "Estimating…").

### 3.5 Presets
- Built-in **quick presets** (data in `/assets/export-presets.json`): *Short-form vertical (1080×1920, 30 fps, H.264 Standard)*, *Landscape 1080p*, *High quality 4K*, *Small file for sharing (720p, Draft quality)*, *Square 1080*. User **Save preset…** / manage in Settings → Export defaults. Presets never claim platform-specific rules; they are conveniences.
- **Defaults** (Settings → Export defaults) pre-fill the dialog.

---

## 4. RENDERING DETAILS

### 4.1 The hidden render window
- Created at export start (`show:false`, `offscreen`-style sizing to the **export resolution**, `webPreferences: {contextIsolation:true, sandbox:true, backgroundThrottling:false}`), loads the **compositor bundle only** (no editor UI); receives the `ExportPlan` JSON and assets over IPC (zod-validated).
- **Frame loop:** `for i in 0..N-1`: for each active video item request the frame from its provider (`await`), call `renderFrame`, run the **colour-convert pass** (RGBA16F → **YUV420 planar 8-bit** in a shader, limited range BT.709), `gl.readPixels` into a **ring of pre-allocated buffers**, and transfer the buffer (transferable `ArrayBuffer`) to the main process / encoder writer; **back-pressure:** the loop waits if the encoder's stdin buffer holds > 8 frames (never unbounded memory).
- Readback uses PBOs (`PIXEL_PACK_BUFFER`) double-buffered to avoid pipeline stalls. Memory cap: ≤ 1.5 GB for the export process (monitored; exceeding aborts with a clear message).
- **Text and fonts:** all fonts required by the plan are loaded and awaited **before frame 0** (`11 §10.2`); a missing font fails the export with the font name and a *Choose replacement* action (never silently substituting).
- **WebGL context loss** → recreate, resume from the last fully-written frame index if the encoder is still running; otherwise fail with a message and retry option.
- **Software GL fallback:** if WebGL2 can't be created with hardware, retry with `--use-gl=angle --use-angle=swiftshader`; estimated time grows; warn.
- **Determinism:** no `Math.random`, no time-dependent shader inputs; noise textures seeded; floating-point differences across GPUs are accepted but the **same machine/GPU produces bit-identical frames** (tested); cross-GPU variance within SSIM 0.999.

### 4.2 Source decoding (ExportFrameProvider)
For each video item the planner computes a **decode request**: source file (original, never the proxy, unless *Draft*), source range `[sourceInUs, sourceInUs + durationUs·speed]`, mapping to the output frame grid. A decode process is started **lazily when the item first becomes active** (`t_start − 1 s`) and ended when it finishes:
`ffmpeg -hide_banner -nostdin -ss <in> -i <src> -t <len> -vf "<filters>" -an -f rawvideo -pix_fmt rgba -`
with `<filters>` = `setpts` (speed), `fps=<outFps>:round=near` (CFR resampling; **this is how VFR sources are made constant**), optional tone-map for HDR, rotation applied (`04 §5`), `scale=<w>:<h>:flags=lanczos` to the **item's needed size** (never decode at a size larger than the output needs, with a ceiling of the source size), `format=rgba`. Accurate seeking uses input-side `-ss` (fast) followed by output-side `-ss` for sub-GOP precision when the in-point isn't on a keyframe.
- Decoders are limited to **min(6, cores)** concurrent processes; items beyond the limit wait (the planner orders by start time). Frames are read through a pipe with a bounded queue (≤ 6 frames per item).
- **Images** are decoded once to textures; **SVG** is rasterised at the **needed resolution** (vector kept crisp, `11 §12`); **animated GIF** = first frame (`11` limitation).
- **Frame count guarantee:** a provider must deliver **exactly** the expected number of frames for its range; a shortfall (truncated source/decoder error) → the last good frame is repeated for up to 2 frames and logged; > 2 → export fails with "The source video ended unexpectedly at <time>" (never silent black).
- **Missing media** → the export is **refused before starting**, listing the items and a *Relink* button (`04 §8`).
- **Disabled/hidden/muted** items and tracks are excluded per their flags (`09 §9`).

### 4.3 Transitions, effects, keyframes
All evaluated by `renderFrame` using `evaluate()` (`12 §2.1`) at `t_i`; transitions need **two** source frames per output frame during overlaps (the planner activates both decoders in the transition range).

### 4.4 Burn-in captions and text
Rendered by the same `TextRenderer` inside `renderFrame`; **no ASS/libass path** and no ffmpeg `subtitles` filter, so the look is identical to the preview. Sidecar SRT/VTT are generated from caption items independently (`11 §13`).

---

## 5. AUDIO PIPELINE
1. `AudioMixer` (utility process) builds the audio graph from the plan (`12 §6.1`): for each audio-bearing item: decode range to 48 kHz stereo float (`atempo` for speed, `-ss/-t`), apply `gain · volumeEnvelope · fades · pan`, apply track volume/mute (+ solo if included), apply ducking envelopes (`12 §6.7`), sum, apply optional **loudness normalisation gain** (computed from a first **analysis pass** over the full mix, `12 §6.6`, ≈ 5–10% of the export time, progress shown as "Measuring loudness"), then the **limiter** (−1 dBTP).
2. Output: a **PCM stream** consumed by the encoder in step with video (muxed with `-f f32le -ar 48000 -ac 2 -i pipe:` as a second input), or, for simplicity and robustness, **written to a temp WAV** first (`Cache/export/<jobId>/mix.wav`) and passed as the audio input (**default**; avoids pipe deadlocks; disk use = duration × 48000 × 8 bytes, checked in the space estimate).
3. **A/V sync:** both streams start at timestamp 0 and have equal duration `N / fps`; the encoder is passed `-t <duration>`; the audio is padded with silence or trimmed to the exact video duration (± 1 sample). Audio delay from encoder priming (AAC 1024 samples) is compensated via `-af adelay`-free method: use the muxer's `start_time`/edit lists correctly (verified in §7).
4. **No audio at all** (all muted/no sources): the file has **no audio stream** unless "Always include a silent audio track" (default **on**, since some platforms reject files with no audio) is enabled; stated in the dialog.
5. Peak/true-peak and integrated loudness measured from the mix are recorded for the validation report.

---

## 6. THE EXPORT QUEUE

- **Queue panel** (Export button's popover + the background-tasks popover, `02 §2.2`): one row per export: thumbnail, name, preset summary, status (*Queued · Rendering 37% · Measuring loudness · Encoding · Finalising · Verifying · Done ✓ Verified · Failed ✕ · Cancelled*), progress bar (true percentage = rendered frames ÷ N, with audio-measure and verify stages weighted 5%/3%), **elapsed**, **ETA** (after 3 s of stable throughput; "Estimating…" before), current speed ("2.4× real time"), **Cancel**, and on completion **Open file**, **Show in folder**, **Copy path**, **Re-export**; on failure **Retry**, **Details** (readable cause + redacted log), **Copy details**.
- **Multiple exports:** *Add to queue* (default: the queue runs **one export at a time** because rendering uses the GPU and cores; a setting allows 2 concurrent for CPU-only encodes, default off). **Batch export** (several clips × one preset, or one clip × several presets) creates one row per output.
- **The editor stays usable** during export: export runs in separate processes at **below-normal priority**; editing the composition during an export does **not** change the running export because the planner takes an **immutable snapshot** of the composition and its media paths at *start* (a banner: "Export uses the version from 14:32"). Media files in use by an export cannot be deleted by the app (guard in `03 §8`).
- **Cancel:** kills the encoder, decoders, mixer and hidden window, deletes `*.partial.*` and temp files, status *Cancelled*; "Cancelling…" within 1 s; never leaves a half file under the final name.
- **Quit with exports running:** confirm; exports **restart from scratch** on next launch only if "Resume queue on startup" is on (default on, restarted jobs are shown as *Queued (restarted)*); partial files are cleaned.
- **Power:** `powerSaveBlocker('prevent-app-suspension')` while exporting; a notification (`02 §7`) on completion/failure when the window is unfocused.
- **Timing:** elapsed and total time recorded in history; throughput stored to improve estimates per machine/preset.
- **Disk-space watchdog:** re-check free space each 10 s; < 500 MB → pause with a message and Resume (like `04 §10`).
- **History:** `workspace.db` `export_history` (job, composition version, settings, result, validation report, output path); visible in Settings/Project → *Exports*; files deleted outside the app show *File missing*.

---

## 7. EXPORT VALIDATION (mandatory; the only way to reach "Done ✓")

After the encoder finishes and the temp file is complete (but **before** renaming it to the final name), run `validateExport(plan, file)` and attach its **ValidationReport** to the job:

| # | Check | Method | Pass criteria |
|---|---|---|---|
| 1 | File exists, non-zero, readable | fs + ffprobe | exists; size > 0; probe succeeds |
| 2 | Container/stream structure | `ffprobe -show_format -show_streams` | 1 video stream; audio stream present iff expected |
| 3 | **Actual width/height** | probe | equal to the plan exactly (display size accounting for rotation = 0) |
| 4 | **Aspect ratio** | probe | `width/height` within 0.1% of the plan; SAR 1:1 |
| 5 | **Actual frame rate** | probe `r_frame_rate`/`avg_frame_rate` + counted frames | constant, equals plan fps (e.g. 30/1); `avg_frame_rate == r_frame_rate` |
| 6 | **Duration** | probe (format and stream) | within **1 frame** of the plan duration (video), audio within **1 frame** of video |
| 7 | **Frame sequence integrity** | `ffprobe -count_frames` (or `-show_entries frame=pts_time` for the full list) | frame count == N; PTS strictly increasing with constant delta (tolerance 1 µs-level rounding); no duplicates/gaps |
| 8 | **Full decode** | `ffmpeg -v error -i file -f null -` (also audio) | exits 0, stderr empty (no decode errors) |
| 9 | **Truncation** | compare last-packet PTS/duration to the plan; check `moov`/index presence (faststart) | file ends at the planned duration; MP4 `moov` at start |
| 10 | **Audio/video sync** | compare `start_time` of both streams; **plus** a content test: when the composition contains a known sync marker (see §11 test fixtures) or in all exports a cheap **onset test**: detect the first loud audio onset and the matching first-visible-change frame **only when** both exist in the plan (optional) | stream start times differ by < 1 frame; sync fixtures within 1 frame |
| 11 | **Black frames** | `blackdetect=d=0.5:pic_th=0.98` on the output; compare with **expected-black ranges from the plan** (fades, gaps, empty canvas) | no black segment ≥ 0.5 s **outside** the planned ranges (and the first/last frame is not unexpectedly black) |
| 12 | **Frozen frames** (unexpected) | `freezedetect=n=-60dB:d=2` vs the plan (still images, holds) | none outside planned ranges |
| 13 | **Audio sanity** | `ebur128`/`astats` | not silent when the plan has audible content; no digital clipping (true peak ≤ −0.5 dBTP); integrated loudness within ±1.0 LU of the target when normalisation was on |
| 14 | **Codec/profile/pixel format** | probe | matches the plan (e.g. h264 High, yuv420p, aac, 48 kHz, stereo) |
| 15 | **Bitrate plausibility** | size/duration | within ±35% of the target for bitrate modes; CRF modes within broad sanity bounds |
| 16 | **Metadata/colour tags** | probe | bt709 tags present |
| 17 | **Burn-in sanity (captions)** | sample **3 frames** (start of the first caption, middle, end of the last) from the output and compare to `renderFrame` at the same times → **SSIM ≥ 0.97** (compression tolerance) | pass |
| 18 | **Subtitle sidecar files** | parse SRT/VTT; compare cue count/times to caption items | pass |
- **Result UI:** a **Verification report** card on the completed row: ✓/✕ per check with measured vs expected values (e.g. "Size 1080×1920 ✓ · 30 fps ✓ · 62.100 s (expected 62.100 s) ✓ · Audio ✓ · Sync ✓"), downloadable JSON. **"Done ✓ Verified"** appears only if **all required checks (1–9, 13–14) pass**; warnings (10–12, 15–17) show "Done with warnings" with explanations; any required failure → **status Failed**, the file is kept as `<name>.FAILED-VALIDATION.<ext>` **only if** the user chooses *Keep file anyway*, otherwise removed.
- The progress bar reaching 100% only means *rendering ended*; the row stays at "Verifying…" until the report is complete.
- **Never** report success from encoder exit code alone.
- Validation runs fully **offline** with the bundled ffmpeg/ffprobe and takes ≲ 15% of the export time for typical clips (decode check is the longest; it can be made *Quick verify* (sample-based, default for > 30 min outputs) via a setting, clearly labelled — the default for clips < 30 min is the **full** decode).

---

## 8. ERRORS (plain language, never raw output)
| Case | Message | Actions |
|---|---|---|
| Missing media | "N files used in this clip can't be found." | Relink |
| Missing font | "The font <name> isn't installed." | Choose replacement / Import |
| Out of disk | "Not enough disk space: X needed, Y free." | Choose folder / Retry |
| Encoder failure (hardware) | "The video card encoder failed. Switched to CPU." (auto) | — |
| Encoder failure (CPU) | "The video encoder stopped unexpectedly." | Retry, Details |
| WebGL / GPU failure | "Your graphics driver stopped responding. Retrying in software mode (slower)." | — |
| Source decode error | "Part of <file> can't be read at <time>." | Replace media, Retry |
| Out of memory | "Export ran out of memory. Try a lower resolution." | Change settings |
| Output locked/in use | "The output file is open in another program." | Choose another name / Retry |
| Validation failed | "The exported file didn't pass checks: <failed items>." | Re-export, Keep anyway |
| Permission denied | "Clipwright can't write to <folder>." | Choose folder |
Every failure keeps the job log (redacted, `03 §12`) with ffmpeg stderr tails.

---

## 9. OPTIONAL: RESUMABLE RENDER (stretch)
Rendering checkpoints every 60 s of output (encoder `-f segment`/concat of independently encoded GOP-aligned segments) so a crash resumes. **Not required for v1.** If not built, the UI says "Restarts from the beginning".

---

## 10. PERFORMANCE TARGETS (reference machine, `00 §3`)
- 1080×1920 30 fps, simple composition (1 video + captions): **≥ 1.0× real time** with hardware encode, **≥ 0.5×** with `libx264` medium-fast.
- 4K 30 fps: completes without crashing at any speed; ≥ 0.15× real-time is acceptable; **4K 60 fps** may be slower than real-time and must still complete correctly (documented in `docs/limitations.md`).
- UI stays ≥ 55 fps in the editor during an export (the export processes run below-normal priority).
- Memory < 1.5 GB for the export process tree; no growth over a 30-minute export (leak test).
- Frame readback + pipe throughput benchmark recorded in `docs/verification.md` (frames/s at 1080×1920 and 2160×3840).

---

## 11. TEST FIXTURES (committed in `/test-fixtures/export`)
1. **Sync clapper:** 10-second video with a white-flash frame and a 1 kHz beep at known frame numbers (frame 30, 150, 270) → check offset < 1 frame after export at 30 and 60 fps.
2. **Frame counter:** each frame has a burned-in frame number (rendered by a test composition as text) → verify the exact frames present and in order after export (decode and OCR is **not** used: use pixel-encoded counters (a 16-bit binary strip) in the top rows).
3. **Colour bars + gradient** for colour/banding checks.
4. **Composition suite:** one composition each for: captions (10 presets), transitions (all types), keyframe animation, effects chain, text animations, speed change, split/trim with keyframes, 3-layer overlay, image + SVG, music + ducking + voiceover, VFR source, 4K HEVC source, portrait phone source, no-audio source, 30+ minute source (soak).

---

## 12. ACCEPTANCE CHECKS (record real numbers in `docs/verification.md`)
1. **Matrix export, all verified with the §7 checks by running ffprobe and a full decode:** for aspect ratios 9:16, 16:9, 1:1, 4:5 × presets 720p, 1080p, DCI 2K, QHD, 4K × fps 30 and 60 — the full cross product is run **at least once** (can be split across CI nights; record pass/fail per cell) using short (5 s) compositions; the **size function** unit test covers all aspect × preset cells.
2. Portrait outputs are portrait (e.g. 1080×1920), landscape are landscape; **no forced landscape**; aspect preserved to 0.1%; even dimensions always.
3. Resizing the editor window, changing preview zoom/quality and changing Windows scaling during/before export **do not change** the output (automated: export with the window at two different sizes → identical frame hashes).
4. **Sync:** clapper fixture offset < 1 frame at 30/60 fps, with captions, transitions and speed changes in the composition; a long (30-minute) soak shows drift < 1 frame at the end.
5. **Frame integrity:** frame-counter fixture shows N frames, strictly increasing, no duplicates/gaps, for 30 fps and 60 fps, and for a 29.97/VFR source exported at 30.
6. **Parity:** golden frames from export vs preview pipeline SSIM ≥ 0.995 on the composition suite (captions 10 presets, text animations, transitions, keyframes, effects).
7. **Determinism:** two exports of the same snapshot on the same machine are frame-hash identical (video) and sample-identical (audio mix before encode).
8. Codec matrix: H.264/AAC MP4 (CPU) and, if the machine has it, hardware H.264 (each validated); VP9/Opus WebM; HEVC only if the encoder is present — **each produced file is actually opened and decoded** and plays in a standard player (VLC or ffplay) — manual confirmation recorded.
9. Hardware detection and fallback: forcing a failing hardware encoder falls back to CPU automatically and completes; *Force CPU* works.
10. Captions: burned-in matches preview (check 17 SSIM), SRT/VTT files parse and match; *burn + sidecar*, *burn only*, *sidecar only* all work.
11. Queue: queue 3 exports, run sequentially, cancel one mid-render (no partial file left), retry a failed one, batch export 5 clips, open folder, history shows results; the editor remains usable (UI ≥ 55 fps) and editing during an export doesn't change it (snapshot banner).
12. Validation: inject faults (truncate file, wrong fps via a patched encoder arg, drop audio, insert black frames) → each is **detected** and the job is **Failed or Warned** as specified; a perfect export shows "Done ✓ Verified".
13. Failure paths: missing media (blocked before start), missing font, disk full (VHD), locked output file, killed encoder process, GPU context loss (simulated) — messages and recoveries as §8; no raw errors in the UI.
14. Loudness normalisation to −16 LUFS ±1 LU verified with ffmpeg `ebur128` on the exported file; limiter prevents clipping (true peak ≤ −0.5 dBTP).
15. Large and long: a 30-minute 1080p composition exports with bounded memory (<1.5 GB) and passes validation; a 4K 60 fps 20-second composition completes and validates (slow is acceptable; record the speed).
16. Export defaults, presets, name templates (`{project}-{clip}-{preset}`), clash handling, free-space check all behave per §3.
17. Visual review against `01`: export panel and queue use design-system components; progress is true, never fake; no AI-look items.
