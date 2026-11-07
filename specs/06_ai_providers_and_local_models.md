# SPEC 06 — AI PROVIDERS, LOCAL MODELS AND PROCESSING MODES

**Binding.** Follows the structure of `specs/09`. Consumers: `05` (transcription), `07` (moments), `13` (AI editing tools). Secrets and storage: `03 §11`. UI shell and routes: `02` (`/models`, `/settings/ai-providers`, `/settings/local-models`).
Code: `/packages/ai-core/providers`, `/packages/ai-core/models`. UI: `/apps/desktop/src/renderer/features/providers`, `…/features/models`.

---

## 1. PURPOSE

Let the user bring their **own** AI services (any OpenAI-compatible endpoint, plus a few named ones) or run everything **locally**, with total clarity about what runs where, what is sent over the internet, and what is available offline. No subscription to an app-owned service is ever required.

---

## 2. ARCHITECTURE (mandatory structure)

1. **Provider interface per capability, not one giant interface.** A provider may implement one or more capabilities:
```ts
type Capability = 'transcription' | 'text';           // 'vision' reserved, not used in v1
interface ProviderAdapter {
  kind: 'openai-compatible' | 'ollama' | 'anthropic' | 'gemini';
  capabilities(config): Capability[];
  testConnection(config, signal): Promise<TestResult>;
  listModels(config, signal): Promise<ModelInfo[]>;
  transcription?: { transcribe(chunk, opts, signal): Promise<ChunkResult>; supportsWordTimestamps; maxUploadBytes };   // 05 §5
  text?: { complete(req: TextRequest, signal): Promise<TextResult>; contextWindow(model): number|undefined; supportsJsonMode: boolean };
}
interface TextRequest { system: string; user: string; temperature: number; maxTokens: number; json: boolean; seed?: number; timeoutMs: number }
```
2. **Adapters are the only code that knows an API's wire format.** Add a provider = add one adapter file + register it. No UI or pipeline change.
3. **Task router** (`resolveProvider(task, settings)`) is a pure function returning a provider+model or a structured reason it cannot (§6). Pipelines call the router; they never read provider configs directly.
4. **All network calls to providers run in the main-process `AiService`** (not the renderer), so keys never reach the renderer and the CSP stays strict. The renderer sees `ProviderStatus` objects only.
5. **Cancellation everywhere:** every call takes an `AbortSignal`; cancelling kills the HTTP request / child process.
6. **No SDK lock-in:** adapters use `fetch` with our own retry/timeout wrapper (`§9`) so behaviour is identical and testable with a local mock HTTP server (this is a *test harness*, never shipped as app behaviour).

---

## 3. PROVIDER KINDS AND PRESETS

| Kind | Used for | Wire format | Notes |
|---|---|---|---|
| `openai-compatible` | transcription, text | `POST {base}/audio/transcriptions`, `POST {base}/chat/completions`, `GET {base}/models` | **Custom base URL + key + model.** Covers OpenAI and the many compatible gateways |
| `ollama` | text (local) | `GET /api/version`, `GET /api/tags`, `POST /api/chat` (`format:'json'`, `options:{num_ctx,temperature,seed}`), `POST /api/pull` (streamed), `DELETE /api/delete` | Default `http://localhost:11434`; **no key**; no transcription |
| `anthropic` | text | Anthropic Messages API (`/v1/messages`) with the `x-api-key` and `anthropic-version` headers | Adapter handles system prompt and JSON-only instruction (no native JSON mode assumed) |
| `gemini` | text | Google Generative Language API (`generateContent`) with `responseMimeType: application/json` | Adapter normalises to `TextResult` |

**Presets** (the "Add provider" picker) pre-fill name, kind and base URL, and the user supplies the key: *OpenAI*, *Groq*, *OpenRouter*, *Together*, *Anthropic*, *Google Gemini*, *Ollama (this computer)*, *Ollama (another computer on my network)*, and **Custom (OpenAI-compatible)**. Presets are data in `/assets/provider-presets.json` (not code) so they can be corrected without changing logic. **Do not hard-code or claim model names, prices or limits**: models are always discovered with `listModels`, or typed by the user when the endpoint has no list API. Where a service's transcription endpoint does not exist, the preset's `capabilities` list simply omits `transcription` (the UI then does not offer it for that provider).

---

## 4. PROVIDER SETTINGS UI (`/settings/ai-providers`)

### 4.1 List
A card per provider: name, kind chip, **status dot** (Connected / Not tested / Error / Key missing), capability chips (*Transcription*, *Text*), **Default for…** chips (§6), model in use per capability, a *Local* or *Online* badge, and ⋯ (Edit, Test, Duplicate, Remove). **Add provider** primary button opens the preset picker, then the form. Empty state explains the two options (use your own key / use local models) with buttons for both.

### 4.2 Form (a `Dialog`, 16 px radius)
Fields: **Name** · **Kind** (preset-driven) · **Base URL** (validated URL; `https` required for online kinds, `http` allowed only for `localhost`, `127.0.0.1`, `::1` and private LAN ranges with an inline note) · **API key** (password field, paste allowed, show/hide toggle for the field being typed only; after saving it is **never shown again**, only `••••` + last 4 chars, with **Replace key** and **Remove key**) · **Model** per capability (combobox fed by *Fetch models*, free text allowed) · **Advanced**: extra headers (name/value, values stored as secrets), request timeout (default 60 s), max concurrent requests (default 2), organisation/project id (optional), "This provider is on my own network" checkbox (changes the consent wording, §8).
Buttons: **Test connection**, **Save**, **Cancel**. Saving without a successful test is allowed (status "Not tested"); the user is told once.

### 4.3 Test connection (`testConnection`)
Runs, in order, and reports each step with a ✓/✕ and plain text:
1. **Reach** the base URL (DNS/TLS/connect), timeout 10 s.
2. **Authenticate** (list models or the smallest harmless request).
3. **Model check:** the chosen model exists (when listable).
4. **Capability probe:** *Text* = a 1-token JSON round trip (`{"ok":true}` request with `maxTokens: 20`); *Transcription* = upload a **bundled 1-second silent WAV** and expect a valid response shape (never the user's media).
5. Reports latency. Success → status **Connected** (timestamp stored); failure → status **Error** with the mapped message (§9).
Test requests send **only** the synthetic test payloads. The dialog says so.

### 4.4 Switching, defaults, removal
- **Set as default for:** *Transcription*, *Moment analysis*, *Titles and hooks*, *Editor AI tools* — four independent selectors (a task falls back to "Automatic" if unset).
- **Remove provider:** confirm; deletes the record and its secrets; tasks that used it revert to Automatic; existing projects keep their results (results never depend on the provider continuing to exist).
- **Update credentials:** *Replace key* validates by test before swapping, keeps the old key until the new test passes (optional "Save anyway").
- The UI shows, wherever an AI task runs (Transcribe screen chip, Moments mode label, editor tool dialogs), **which provider/model is being used** and whether it is *Local* or *Online* (`05 §5`, `07 §3`).

---

## 5. SECRETS (rules, repeated here because they are critical)
Keys and secret header values: `safeStorage` only, per `03 §11`. The renderer never receives a key after it was saved. Keys are removed from memory (`Buffer.fill(0)` where applicable) after use; they live in the `AiService` only for the duration of a request. They never appear in logs, errors (redact before building any error message), IPC payloads, URLs or the Test dialog. A unit test greps all log output of a full mock-provider run for the key.

---

## 6. PROCESSING MODES AND THE TASK ROUTER

Modes (`02 §4.7`): **Offline**, **Online AI**, **Automatic** (default). Tasks: `transcription`, `moment_analysis`, `titles`, `editor_ai`.

```ts
resolveProvider(task, mode, settings, env): { ok: true; provider; model; locality: 'local'|'online' } | { ok: false; reason: Reason; fix: Action[] }
```
### 6.1 Resolution table
| Mode | transcription | moment_analysis / titles / editor_ai |
|---|---|---|
| **Offline** | whisper.cpp (installed model) — else *no model* (`fix`: Download model) | Ollama (running, with a model) — else **Basic scoring** for moments (`07 §3`); titles fall back to the transcript's first-sentence heuristic; editor AI tools that need an LLM are disabled with a reason |
| **Online AI** | default transcription provider (online) — else *no provider* (`fix`: Set up a provider) | default text provider (online) — else *no provider* |
| **Automatic** | 1) user-chosen default provider for the task if connected and the data-sharing rule allows it, else 2) whisper.cpp if a model is installed, else 3) a connected online transcription provider **after consent**, else *none* | 1) user-chosen default; else 2) Ollama if running with a model; else 3) a connected online text provider **after consent**; else Basic scoring |
**Automatic never silently sends data online.** Choosing an online route in Automatic requires that the provider's consent state (§8) is **already granted**; otherwise the router returns `needsConsent` and the pipeline stops to ask. If the local route fails mid-task, the user is asked before any online fallback (`05 §13`).
**Connectivity:** do not trust `navigator.onLine`. The `ConnectivityService` probes (HEAD to the provider base URL for online providers only, 3 s timeout, cached 15 s). A local provider (Ollama on `localhost`) is never treated as "offline-unavailable" because of the internet.

### 6.2 What the user sees (mode panel in Advanced and in Settings)
Under the mode selector, a **live summary** of exactly what each task will use, e.g. "Transcription → Whisper small (on this computer) · Moments → llama via Ollama (on this computer) · Titles → Basic". Each line has *Local* or *Online* and, if unavailable, the reason and a fix button. This summary is generated from `resolveProvider`, never hand-written.

### 6.3 Capability honesty table (`/models` top card "What works offline")
Rows: **Import and edit**, **Save projects**, **Export**, **Transcription**, **Moment analysis**, **AI editing tools**, **URL download**. Columns: *Offline now?* (✓ / ✕ / Needs setup), *Needs* (e.g. "Whisper model (~470 MB)"), *Action*. **URL download** is always labelled "Needs internet". A row is ✓ only if the dependency is actually present **right now** (model file hash-verified, Ollama reachable with a model). Computed live; never static text.

---

## 7. LOCAL MODEL MANAGER (`/models`, `/settings/local-models`)

### 7.1 Layout
Tabs: **Speech (Whisper)** · **Language (Ollama)** · **Vision/detection (ONNX)** · **Storage**. Each tab = list of model cards. A header strip shows *Models folder*, *Used / free disk*, and a **Open folder** button.

### 7.2 Whisper models
Catalogue and rules from `05 §4.1`. A card shows: name, language scope (English-only / multilingual), size on disk, **RAM needed** (approx., e.g. 1 GB / 2 GB / 5 GB / 10 GB for small / medium / large-turbo / large), **speed hint** ("≈ N× real time" after the first run on this machine; before that, "Speed unknown" — never invented), accuracy tier (text: Fastest / Fast / Balanced / Accurate / Most accurate), **Compatibility** badge computed from this machine's RAM (*Good fit*, *Slow on this computer*, *May run out of memory*), status (*Not installed* / *Downloading 43%* / *Installed ✓ verified* / *Update available* / *Corrupt — re-download*), and actions (**Download**, **Pause/Resume**, **Cancel**, **Delete**, **Set as default**). Required storage is shown **before** the download starts, with the free-space check (needs 1.2× size free).
- **Download engine:** HTTP with Range resume to `Models/whisper/<name>.part`, size check, SHA-256 against `/assets/model-checksums.json`, then atomic rename. A mismatch deletes the file and shows "The download was damaged and has been removed. Try again." Concurrent downloads: 1 at a time (queued).
- Downloads are **background tasks** (`02 §2.2`), survive restarts (`04 §9`), and show true percentage and ETA.

### 7.3 Ollama models
- **Detection:** `GET /api/version` on the configured base URL (default `http://localhost:11434`). States: *Not found* (explain: "Ollama is a separate free app that runs language models on your computer." Buttons: **How to install** (opens the official site in the default browser — the only external link), **Retry**, **Use another address**), *Running* (version shown), *Running, no models* (offer pull), *Error*.
- **Installed list** from `/api/tags`: name, size, parameter size and quantisation (from the response), modified date, **Test** (small JSON completion), **Set as default**, **Delete** (`/api/delete`, confirm).
- **Get a model:** a text field "Model name (e.g. as listed by Ollama)" plus a **suggestions list loaded from `/assets/ollama-suggestions.json`** (editable data: name, approximate size, RAM guidance, notes such as "good for JSON output"). **Pull** calls `/api/pull` with streaming progress (true bytes/percent, cancel by aborting the stream); verifying is done by Ollama; we then list and Test it. Suggestions are labelled "suggested", never "best". Do not claim a model's quality without our own benchmark (`07 §13`); if the benchmark in `docs/verification.md` exists, the card may show "Tested for moment finding: N% on our test set" with the date.
- **RAM guidance:** if the model's size exceeds ~70% of free RAM, show a warning "This model may be slow or fail on this computer".
- **Context size:** setting `num_ctx` (default 8192; options 4096/8192/16384/32768) with a note that larger needs more RAM. The moments pipeline computes batch sizes from it (`07 §4.4`).
- Ollama may be on **another computer** on the network (user-supplied address): treated as `locality: 'network'`, displayed as "On your network", and covered by consent (§8) because data leaves this machine.

### 7.4 ONNX models (vision/detection)
Used by `13` (face/subject detection for auto-reframe). Bundled small models ship in the installer (licence-checked, listed in `docs/licences.md`); optional larger ones download like Whisper models with checksums. Same card UI.

### 7.5 Storage tab
Per-model-folder sizes, **Delete all downloaded models** (confirm, lists them), disk usage bar.

---

## 8. CONSENT AND PRIVACY (data leaving the computer)

- **What each task may send** (shown in the consent dialog and in Settings → Privacy → *Data sent to providers*):
| Task | Sent | Never sent |
|---|---|---|
| Transcription (online) | audio chunks (mono, 16 kHz, compressed) | video, the project, file names |
| Moment analysis / titles / editor AI | transcript **text** with timestamps and numeric audio features | audio, video, thumbnails, file paths, other projects |
| Connection test | synthetic test payload | anything of the user's |
- **Consent dialog** (first use per provider and per *data category*): "This will send <what> to **<provider name>** (<host>). <Provider> has its own privacy terms." Buttons: **Allow once**, **Always allow for this provider**, **Cancel**. For network-local providers the text says "to another computer on your network".
- Consent state is stored per provider+category in `workspace.db` (not secret) and can be **revoked** in Settings → Privacy (the list shows each provider, what it may receive, date granted, **Revoke**).
- **Data-sent log** (Settings → Privacy): an append-only local list of `{time, provider host, task, data category, approximate size}` — **never the content**. Export-able as CSV. Clear button.
- **Offline-first default:** until the user adds a provider and consents, nothing is ever sent. A network egress test (§12) proves this.
- The app makes **no other outbound calls** except: URL ingestion the user triggers (`04`), model downloads the user starts (`06 §7`), the update check (`15`, configurable and clearly listed in Privacy), and the yt-dlp update (`04 §3.1`). Settings → Privacy lists these four with on/off toggles where applicable.

---

## 9. ROBUSTNESS (shared HTTP wrapper)

- Timeouts: connect 10 s; per request from provider settings (default 60 s; local LLM batch 120 s per `07`).
- **Retry** 3× with backoff (1 s, 3 s, 8 s) on network errors, HTTP 408/429/5xx; honour `Retry-After` (cap 60 s). **Never retry** 400/401/403/404 except a single retry for 404 on `/models` variants.
- **Concurrency limit** per provider (default 2) via a queue; fair across tasks.
- **Error mapping** (plain language, never raw bodies; raw body goes to the redacted debug log only):
| Condition | Message | Actions |
|---|---|---|
| 401/403 | "The key was rejected by <provider>. Check that it's correct and has access to this model." | Edit provider |
| 404 model | "<provider> doesn't have a model called <name>." | Pick model |
| 429 | "<Provider> is limiting requests. Waiting and retrying…" then "Try again later or switch provider." | Switch to local |
| 413 / size | "The audio chunk is too large for this provider." (planner shortens, `05 §5`) | — |
| Timeout | "<Provider> didn't respond in time." | Retry, Switch |
| TLS / DNS | "Couldn't connect to <host>. Check the address and your internet connection." | Edit, Retry |
| Invalid response shape | "<Provider> replied in an unexpected format." | Details |
| Ollama not running | "Ollama isn't running. Start it and try again." | Retry |
| Out of memory (Ollama) | "The model needs more memory than is available. Try a smaller model." | Open models |
- **Structured JSON requests:** adapters use native JSON mode where available (`format:'json'`, `response_format`, `responseMimeType`); otherwise a strict instruction plus the repair/validate/retry pipeline of `07 §4.4`. Adapters never swallow malformed output; they return it to the pipeline unmodified with a `jsonMode` flag.
- **Token budgeting:** `estimateTokens(text)` (chars/3.6 for English, chars/2.0 for CJK as a documented heuristic) is used for batching; real usage counts from responses (when provided) are displayed in the Data-sent log only as numbers.

---

## 10. EDGE CASES
Provider base URL with trailing slash or `/v1` duplication (normalise) · key with whitespace/newline (trim) · endpoint returns HTML (proxy/captive portal → "unexpected format" + hint) · corporate proxy (honour system proxy settings via Electron `session`) · self-signed certificate on a LAN provider (blocked by default; an explicit per-provider "Trust this certificate" with fingerprint display) · two providers with the same name (allowed; shown with host) · Ollama restarted mid-batch (retry, then ask) · model removed from provider after setup (Test shows 404, task fails with message) · user sets a default provider that lacks the capability (UI only offers capable providers) · very long Base URL (ellipsis + tooltip) · clock skew making TLS fail (message mentions checking the date) · provider returns non-UTF-8 (decoded defensively) · no providers and no Ollama in Online mode (dialog from `02 §4.8`) · switching mode mid-pipeline (applies to the next task; running tasks keep their provider, stated in the tasks popover).

---

## 11. LINKS
Settings snapshot (`02`), transcription pipeline (`05`), moments (`07`), AI editing tools (`13`), secrets (`03`), job queue (`04 §9`), updates/Privacy lists (`15`).

---

## 12. ACCEPTANCE CHECKS
1. Add, test, edit, set default, duplicate and remove a **custom OpenAI-compatible** provider against a local mock server (tests) **and** against one real service (manual, recorded). Key masked after save; Replace/Remove work.
2. Test connection shows each step; each failure type (bad key, bad URL, no model, timeout, HTML response) produces the mapped message.
3. Key never appears in logs, IPC traces, DB, `.cwpack` or the UI after saving (automated grep; `03` check 11).
4. Router unit tests: every cell of the §6.1 table, including Automatic with/without consent, with Ollama up/down, with no providers; the pipeline stops to ask instead of sending online without consent.
5. Offline mode with Wi-Fi disabled: import, transcribe (installed Whisper model), analyse (Ollama or Basic), edit and export all work; the **egress test** (a network monitor or blocked firewall profile in CI-like VM run) shows **zero outbound connections** during that run.
6. Whisper model manager: download with progress, pause/resume across an app restart, hash verification (corrupt a byte → rejected), delete, compatibility badges correct for 8/16/32 GB RAM machines (unit-tested function with injected RAM).
7. Ollama manager: detection states (not found / running / no models), list, pull with progress and cancel, test, delete, `num_ctx` setting reaches the request (verified with the mock).
8. "What works offline" table reflects reality when a model file is removed or Ollama is stopped (updates within 5 s).
9. Consent dialog appears once per provider and data category; Allow once vs Always; revoke in Privacy; the Data-sent log records metadata only (no content).
10. Retry/backoff and error mapping verified with a mock server returning each status; `Retry-After` honoured; no retry on 401.
11. Anthropic and Gemini adapters pass the shared adapter contract tests (JSON output, timeout, cancellation) against mock servers; one real call each recorded manually if the user supplies keys (otherwise recorded as "not run: no key", never faked).
12. Visual review against `01`: forms, cards and statuses use design-system components only; no AI-look items.
