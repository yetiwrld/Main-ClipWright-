# AI providers and network access

Clipwright Studio works fully offline. AI providers are **optional**: they
re-rank the moments found locally, and can suggest titles. Nothing about a
project is sent anywhere unless you configure a provider and use a feature that
needs one.

This page lists every outbound connection the app can make. If a connection is
not on this page, the app does not make it.

## The complete network list

| What | Where | When | Can I turn it off? |
|---|---|---|---|
| Update check | `github.com`, `api.github.com` | On startup (20 s after launch) and on your interval | Yes — Settings → Updates → Never |
| Update download | `github.com`, `*.githubusercontent.com` | Only when you click Download | Yes — just don't click |
| `yt-dlp` update | `github.com/yt-dlp/yt-dlp` | Every 7 days | Yes — Settings → Updates |
| Speech model download | `huggingface.co` | First transcription (once per model) | No, but it never happens again |
| URL ingestion | the site you paste | When you paste a URL | N/A — that is the feature |
| AI provider | the endpoint you configured | When you use an AI feature | Yes — don't configure one |
| AI provider key check | same endpoint | When you save a provider | Yes — same |

**There is no telemetry.** No analytics, no crash upload, no usage ping, no
install ID. The update request carries only the app version and OS in its
User-Agent, which is why Settings → Privacy can say "Nothing about you or your
projects is sent" and mean it literally.

## Supported providers

### Local, no key

| Provider | Endpoint | Notes |
|---|---|---|
| **Ollama (this computer)** | `http://localhost:11434` | Detected automatically if it is running |
| **Ollama (another computer)** | e.g. `http://192.168.1.10:11434` | On your own network |

Local models mean nothing leaves your machine at all. The app suggests models by
RAM, never by benchmark claims it cannot verify — see
[local-models.md](local-models.md).

### Online, bring your own key

| Provider | Kind | Endpoint |
|---|---|---|
| **OpenAI** | OpenAI-compatible | `https://api.openai.com/v1` |
| **Groq** | OpenAI-compatible | `https://api.groq.com/openai/v1` |
| **OpenRouter** | OpenAI-compatible | `https://openrouter.ai/api/v1` |
| **Together** | OpenAI-compatible | `https://api.together.xyz/v1` |
| **Anthropic** | Anthropic | `https://api.anthropic.com` |
| **Google Gemini** | Gemini | `https://generativelanguage.googleapis.com` |
| **Custom** | OpenAI-compatible | any base URL you type |

Because most providers speak the OpenAI shape, a self-hosted `llama.cpp`,
`vLLM`, `LM Studio` or `LocalAI` server works through **Custom** — point it at
your server and leave the key blank if it does not need one.

## Keys

- Stored encrypted with Windows' per-user `safeStorage`, in
  `%APPDATA%\Clipwright Studio\secrets.bin`.
- **Never** written to a log, a project file, a `.cwpack`, or an export.
- Never sent anywhere except the provider they belong to.
- Portable mode: moving the exe to another Windows user means re-entering them,
  because the encryption key is bound to the user account.

If you switch the app to **Offline mode** (Settings → Privacy), no provider is
contacted at all, including localhost ones.

## What the app sends

For a moment-suggestion request:

- the transcript text of the segments it is asking about;
- the durations and timestamps;
- your request settings (content type, target length, count).

It does **not** send video, audio, thumbnails, filenames, workspace paths,
project names or any identifying information. Every request is shown in
Settings → Privacy with the host it will reach and how many bytes it will send,
before it is sent.

## Model discovery

Model names are never assumed. The app lists what your provider or Ollama
instance actually offers, and you pick from that list. A hard-coded model name
would be wrong within weeks; a discovered one cannot be.

## Transcription is local

Speech-to-text does not use a provider. It runs `whisper.cpp` on your CPU. The
only network activity is downloading the model the first time, from
Hugging Face. See [local-models.md](local-models.md).

## If a provider is unreachable

The app says which provider failed and why, and the local features keep working.
Moment detection has a local scoring path that needs no provider at all, so you
can use the app with no AI configured and no connection.
