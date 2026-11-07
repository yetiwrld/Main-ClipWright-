# Local models

Everything that can run locally does. This page lists what gets downloaded, how
big it is, and what each model is actually good for.

Two kinds of model are involved:

- **Speech models** — whisper.cpp, for transcription. Downloaded on first use.
- **Local language models** — via Ollama, for moment re-ranking. Never downloaded
  by this app; you install Ollama and pull models yourself.

## Speech models (whisper.cpp)

Downloaded from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/` the first time a
model is used, then kept in your workspace. Nothing is uploaded.

| Model | File | Download | RAM needed | Speed | Multilingual |
|---|---|---:|---:|---|---|
| **Tiny** | `ggml-tiny.bin` | 74 MB | 1 GB | fastest | No |
| **Tiny (English)** | `ggml-tiny.en.bin` | 74 MB | 1 GB | fastest | No |
| **Base** | `ggml-base.bin` | 141 MB | 1 GB | fast | Yes |
| **Small** | `ggml-small.bin` | 465 MB | 2 GB | balanced | Yes |
| **Medium** | `ggml-medium.bin` | 1463 MB | 5 GB | accurate | Yes |
| **Large v3 Turbo** | `ggml-large-v3-turbo.bin` | 1549 MB | 6 GB | accurate | Yes |
| **Large v3** | `ggml-large-v3.bin` | 2952 MB | 10 GB | most accurate | Yes |

### Which one should I pick?

- **Drafting and rough timing** — Tiny. It is fast and the timestamps are usable,
  but the words are not good enough to publish. The app says so in the model
  picker; take it seriously.
- **Publishing captions** — Small is the usual compromise. Medium is noticeably
  better on names and technical words if you have the RAM.
- **Already have a transcript** — skip it. You can import SRT/VTT and go straight
  to editing.
- **Non-English audio** — pick a multilingual model; the `.en` variants only
  contain English.

`Auto` picks from your available RAM and the audio language, and the choice is
shown afterwards so you can see what it decided.

### Sizes are real

The download sizes above are the exact file sizes the app requests, used for the
progress bar and the free-space check. A mid-download failure resumes rather than
starting over, and a file that does not match its expected size is discarded.

### If a model will not download

| Symptom | Cause |
|---|---|
| Stalls at 0% | No connection, or Hugging Face blocked by a proxy |
| Fails at the end | Disk full — the app checks free space first and tells you the shortfall |
| Corrupt model | Re-download from Settings → Models; the old file is discarded |

You can copy model files in by hand. Put them in
`<workspace>/Models/whisper/` with the exact file names in the table above.

## Local language models (Ollama)

Used only to re-rank moments that were already found locally. Without it,
moment detection still works — it just uses local scoring alone.

The app detects a running Ollama at `http://localhost:11434`, lists the models
you have pulled, and you pick one. **It never pulls a model for you**, because a
multi-gigabyte download is not something to start on someone's behalf.

Suggestions by RAM are in Settings; they are sized, not scored. The app does not
claim one model is "better" than another, because that depends on your material
and cannot be measured honestly by an app.

## ONNX models

Small ONNX detectors ship **inside** the app rather than being downloaded — they
are a few megabytes and the app needs them immediately. They are covered by
`docs/licences.md` and `THIRD-PARTY-NOTICES.txt`.

## Disk space

| Item | Typical |
|---|---|
| One Small speech model | 465 MB |
| One Large v3 model | 3 GB |
| Peaks and thumbnails per media item | a few MB |
| Proxies (optional, for smooth preview) | roughly the size of the source clips |

Everything except the models can be deleted and regenerated. Models can be
re-downloaded; there is nothing irreplaceable in the cache.
