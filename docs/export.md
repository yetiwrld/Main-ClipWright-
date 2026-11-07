# Clipwright Studio — Export

How an export turns a composition into a file, what the settings actually do, and
what the validation report means. Written against `specs/14`.

---

## 1. What an export is

An export renders every frame of the chosen range through the same compositor the
preview uses, encodes them with the bundled ffmpeg, then **opens the produced file
and measures it** before reporting success.

```
composition snapshot ─► ExportPlan ─► frames (yuv420p) ─► ffmpeg ─► temp file
                                                                      │
                                                          validate ───┘
                                                                      │
                                                       rename to final name
```

Two consequences worth knowing:

- **The preview window is never captured.** Closing or resizing the editor, or
  changing the preview quality, cannot change an export's pixels.
- **Editing during an export does not change it.** The planner takes an immutable
  snapshot when the export starts, and the queue row says which version it used.

---

## 2. Settings

### 2.1 Range and content

| Choice | Meaning |
|---|---|
| **Whole clip** | From time zero to the end of the composition. |
| **Work area** | The in/out points set on the timeline (`I`/`O`). Unavailable when no work area is set. |

Audio is included when the composition has any, unless *Include audio* is turned
off. Captions are burned in by default and can also be written as a sidecar file.

### 2.2 Resolution presets (the short-side rule)

Presets are defined by the **short side**, so one preset works for every aspect
ratio and the project's aspect is always preserved — a portrait project exports a
portrait file. Both sides are rounded to even numbers, because H.264 and AAC
require it.

| Preset | Short side | 16:9 | 9:16 | 1:1 | 4:5 | 4:3 | 21:9 |
|---|---|---|---|---|---|---|---|
| 720p | 720 | 1280×720 | 720×1280 | 720×720 | 720×900 | 960×720 | 1680×720 |
| 1080p | 1080 | 1920×1080 | 1080×1920 | 1080×1080 | 1080×1350 | 1440×1080 | 2520×1080 |
| DCI 2K | 1152 | 2048×1152 | 1152×2048 | 1152×1152 | 1152×1440 | 1536×1152 | 2688×1152 |
| QHD 1440p | 1440 | 2560×1440 | 1440×2560 | 1440×1440 | 1440×1800 | 1920×1440 | 3360×1440 |
| 4K UHD | 2160 | 3840×2160 | 2160×3840 | 2160×2160 | 2160×2700 | 2880×2160 | 5040×2160 |

The rule is `long = round_even(short × longAspect / shortAspect)`. Every cell in
this table is asserted by a unit test.

### 2.3 Frame rate

30 and 60 fps are supported. If the export frame rate differs from the
composition's, the timeline is re-sampled at the export rate: keyframes are
evaluated at the new frame times and clip boundaries stay time-accurate.

Output is always **constant frame rate**. Sources that are variable frame rate
are placed on a fixed grid with `fps=<fps>:round=near` — nearest-time frame
selection, **no motion interpolation and no frame blending**. A 29.97 fps source
exported at 30 fps therefore duplicates a frame roughly every 33 frames. This is
predictable; it is not smooth-motion conversion.

### 2.4 Formats, codecs and quality

| Format | Video | Audio | Notes |
|---|---|---|---|
| **MP4** (default) | H.264 High profile, `yuv420p` | AAC-LC, 48 kHz stereo | `+faststart` so it plays while downloading |
| **WebM** | VP9, `-b:v 0` | Opus, 48 kHz stereo | Row-multithreaded (`-row-mt 1`) |

MP4 with HEVC, MOV, GIF, image sequences and ProRes are **not** offered.

Quality presets map to the following, exactly:

| Preset | libx264 CRF | x264 preset | libvpx-vp9 CRF |
|---|---|---|---|
| Draft | 26 | veryfast | 38 |
| **Standard** (default) | 22 | fast | 33 |
| High | 19 | medium | 30 |
| Maximum | 16 | slow | 27 |

**Custom bitrate** overrides the quality preset. VBR adds a maxrate at 1.5× and a
buffer at 2×; CBR pins minrate and maxrate to the target. Audio bitrate options
are 96, 128, 160, 192 (default), 256 and 320 kbps.

### 2.5 Hardware acceleration

At startup Clipwright checks whether the build contains NVENC, Quick Sync, AMF or
VideoToolbox, then **proves each one works by encoding a second of frames**. Only
an encoder that actually produced frames is offered; an encoder that is listed but
fails its test is treated as unavailable, with the reason recorded.

`Auto` (default) uses validated hardware when there is any and `libx264`
otherwise. *Force CPU* always uses `libx264`.

Hardware encoders get constant-quality settings (`-rc constqp -qp` for NVENC,
`-global_quality` for QSV, `-rc cqp` for AMF, `-q:v` for VideoToolbox) rather than
CRF. **Hardware quality is not identical to x264 at the same number** — the
mapping is a documented approximation that tracks the CRF ladder, not a claim of
equivalence.

If a hardware encoder dies mid-export, the job falls back to `libx264` and says
so, rather than failing silently or reporting a partial file as done.

### 2.6 Colour

SDR BT.709, limited range, tagged on the output
(`-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`).
HDR sources are tone-mapped to SDR at decode. Colour tags are verified from the
produced file, not assumed from the flags we passed.

### 2.7 File naming and clashes

The default name is `{project}-{clip}-{width}x{height}`. Templates support
`{project} {clip} {date} {time} {res} {fps} {aspect} {n}`. Characters Windows
rejects become `-`, reserved device names (`con`, `nul`, `lpt1`, …) get a suffix,
and trailing dots and spaces are removed.

On a name clash the default is **auto-number** (`clip 2.mp4`); *Replace* and
*Ask* are also available. Before starting, free space is checked against the
estimated size × 1.5 plus a temp-file allowance; if it does not fit, the export is
refused with the actual numbers rather than failing halfway.

### 2.8 Quick presets

*Short-form vertical* (1080×1920, 30 fps, Standard) · *Landscape 1080p* ·
*High quality 4K* · *Small file for sharing* (720p, Draft) · *Square 1080*.

These live in `assets/export-presets.json`. They are conveniences, not platform
rules. A malformed entry is rejected with the offending field named instead of
being quietly coerced into a different export.

---

## 3. The queue

One export runs at a time by default, because rendering and encoding compete for
the GPU and cores. A setting allows two at once for CPU-only work. Each row shows:

- a progress bar derived from **rendered frames ÷ planned frames**, weight-adjusted
  across stages (prepare 2%, audio 5%, render 85%, verify 8%);
- measured speed (`2.4× real time`) and an ETA, or `Estimating…` until throughput
  is stable;
- **Cancel** — kills the encoder, deletes the `.partial` file, leaves nothing
  under the final name;
- on success: *Show in folder*, *Copy path*, *Re-export*;
- on failure: *Retry* and *Details* (the plain-language reason plus the output path).

Progress reaching 100% means **rendering finished**, not that the export passed.
The row stays at *Verifying…* until the report exists.

---

## 4. What the validation report means

A file is only published under its real name after it has been measured. Each
check reports pass, fail, or **not measured** — and "not measured" is never shown
as a pass.

| # | Check | How it is measured |
|---|---|---|
| 1 | File exists and is readable | fs, size > 0 |
| 2 | Stream structure | ffprobe: one video stream, audio present iff expected |
| 3 | Resolution | ffprobe width/height vs the plan |
| 4 | Aspect ratio | within 0.1% of the plan |
| 5 | Frame rate | `r_frame_rate` equals the plan and `avg_frame_rate` agrees |
| 6 | Duration | within one frame of the plan |
| 7 | Frame count | `-count_frames` equals `round(duration × fps)` |
| 8 | Full decode | `ffmpeg -v error -f null -` produced no errors |
| 9 | File integrity | `moov` atom before `mdat` (faststart), read from the bytes |
| 10 | A/V sync | stream start times less than one frame apart |
| 11 | Black frames | `blackdetect` on the output |
| 12 | Frozen frames | `freezedetect` on the output |
| 13 | Audio sanity | 48 kHz stereo; loudness and true peak from `ebur128` |
| 14 | Codec and format | ffprobe `codec_name`, `pix_fmt` = `yuv420p` |
| 15 | Bitrate plausibility | stream bitrate vs the target (custom bitrate ±35%) |
| 16 | Colour tags | `color_primaries` and `color_transfer` are `bt709` |
| 17 | Caption burn-in | SSIM of sampled frames vs the renderer (≥ 0.97) |
| 18 | Subtitle sidecars | every requested format exists and cue counts match |

Verdicts:

- **Done ✓ Verified** — every check ran and passed.
- **Done with warnings** — something was not confirmed (a check that did not run,
  or an optional check that failed). The row explains which.
- **Failed** — a required check failed. The file is kept only as
  `<name>.FAILED-VALIDATION.<ext>` if you choose to keep it.

Checks 1–9 and 13–14 are required. A skipped full decode therefore produces
*Done with warnings*, never *Done ✓ Verified* — the difference is the whole point
of the report.

---

## 5. Errors you may see

| Message | What it means | What you can do |
|---|---|---|
| "A file used in this clip can't be found." | Media was moved or deleted | Relink, then export again |
| "Not enough disk space: X needed, Y free." | The estimate did not fit | Choose another folder |
| "Clipwright can't write to <folder>." | No permission, or the path is a file | Choose another folder |
| "The video card encoder failed. Switched to CPU." | Hardware encode died | Automatic; nothing lost |
| "The video encoder stopped unexpectedly." | ffmpeg exited non-zero | Retry, or Details for the log |
| "The exported file didn't pass checks: …" | Validation failed | Re-export, or keep the file anyway |

Raw ffmpeg output is never shown in the interface. It stays in the job log.

---

## 6. Known limits

- **Restart-from-scratch.** A failed or interrupted export restarts from the
  beginning; resumable rendering (`specs/14` §9) is not implemented.
- **No frame blending.** Frame-rate conversion uses nearest-time selection.
- **4K 60 fps on CPU is slower than real time.** It completes and validates, but
  a long clip can take a while.
- **Video is decoded and composited, but the full compositor is not yet in the
  export path.** Each video/image item is decoded by its own ffmpeg process
  (§4.2) at the export resolution and rate, and the canvas shows the topmost
  visible item; where nothing is on the timeline you get the canvas colour. Still
  to come: text and caption burn-in, effects, transitions, keyframed transforms
  and blend modes from `renderFrame` (§4.1, §4.3, §4.4). Everything around it —
  the plan, the encoder arguments, the queue, the measurements and the verdict —
  is real and covered by tests that run the bundled ffmpeg on actual footage. See
  `docs/verification.md` for exactly what is and is not verified.
