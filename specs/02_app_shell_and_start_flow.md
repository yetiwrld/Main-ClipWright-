# SPEC 02 — APP SHELL, NAVIGATION AND START FLOW

**Binding.** Follows the structure of `specs/09`. Visual rules come from `specs/01`. Downstream behaviour: `04` (import/download), `05` (transcription), `07` (moments), `08` (editor).

---

## 1. PURPOSE

Get a user from "I have a long video" to "my clips are ready to refine" with the fewest decisions and zero confusion. One start page, four choices, one button. Then a guided sequence of full-screen stages with honest progress.

---

## 2. APP SHELL

### 2.1 Window
- Electron window: min 1100×680, default 1360×820 (or 90% of the display work area if smaller), remembers size, position and maximised state.
- `titleBarStyle: 'hidden'` with `titleBarOverlay` coloured `--surface-app`; the app draws its own **40 px top bar** with a drag region. No native menu bar (hidden); all actions live in the UI and the command palette.
- Single instance lock: opening a second instance focuses the first (and passes a file path if launched with one, e.g. "Open with Clipwright").

### 2.2 Top bar (always visible)
Left → right: **logo mark** (24 px, click = Home) · breadcrumb/project name (editable inline inside a project; click to rename) · **stepper** (inside a project, centred) · **background-tasks button** (icon + badge count; popover lists running/queued/failed tasks with progress and Cancel) · **save status** ("Saved", "Saving…", "Recovered") inside a project · **Export** button (editor stage only, primary pill) · window controls (native overlay).

### 2.3 Navigation rail (outside a project)
A slim **56 px left rail** with icon buttons + tooltips: **Home** (start page), **Projects**, **Models**, **Settings**. Active = `--brand-tint`. **Inside a project the rail is hidden** and the stepper takes over; a "← Home" back button replaces the logo click target label.

### 2.4 Routes
```
/home                       Start page
/projects                   All projects
/models                     Model manager (spec 06)
/settings/:section          Settings (spec 06, 03, 15)
/project/:id/import         Download / load screen
/project/:id/transcribe     Transcription screen
/project/:id/moments        Moments screen
/project/:id/editor/:compId Editor (compId = the clip being edited)
```
Deep links restore state. Opening a project jumps to the **furthest stage it reached** (or the editor if clips exist).

### 2.5 Command palette (Ctrl+K)
Searchable list of every action (Open project, New project, Settings sections, Check for updates, editor actions). Fuzzy search, keyboard only, shows shortcut hints.

### 2.6 Global shortcuts
Ctrl+N new project (Home) · Ctrl+O open video file · Ctrl+, Settings · Ctrl+K palette · Ctrl+/ shortcuts cheat sheet · Ctrl+S manual save (editor) · F11 full screen · Esc closes dialogs/popovers.

### 2.7 First run
A single **setup dialog** (never a multi-page wizard):
1. **Workspace folder** (default `Documents\Clipwright Studio`, shows free space, Browse…).
2. **Processing mode** (Offline / Online AI / Automatic; default Automatic) with one-line explanations and a privacy sentence.
3. **Optional**: "Download the recommended transcription model now (Whisper small, ~470 MB)" checkbox, default on when online.
Confirm → app is usable immediately; downloads run as background tasks.

---

## 3. THE STEPPER

Steps: **Import → Transcribe → Moments → Editor** (Download is a sub-state of Import).

| State | Look | Click |
|---|---|---|
| Completed | check icon, normal text | navigates there (nothing lost) |
| Active | `--brand-tint` pill, `--text-brand` | — |
| Running | active + thin progress underline | — |
| Not reached | muted, disabled | tooltip "Finish the previous step first" |
| Error | `--error` icon | navigates to the failed step |
The sliding marker animates between steps (`--dur-slow`).

### 3.1 Going back: what is invalidated
| User changes… | Effect on later stages |
|---|---|
| Aspect ratio, caption style | Nothing re-runs; existing clips keep their own settings; new clips use the new values |
| Clip length, number of clips, clip focus, content type | Moments are marked **stale**; banner "Settings changed — Find moments again"; existing clips untouched |
| Language, transcription model, processing mode (transcription) | Confirm dialog: "Re-transcribing will replace the transcript. Your transcript edits will be lost. Existing clips stay." |
| Source video replaced | Confirm; creates a **new project** by default (never destroys the old one) |
Never delete clips or edits as a side effect of going back.

---

## 4. START PAGE (`/home`)

### 4.1 Layout (top → bottom, centred, max width 1200)
1. **Hero line** (`--fs-2xl`): "Turn a long video into clips." Short sub-line (`--fs-md`, secondary): "Drop a video or paste a link."
2. **Source area** (one card, `--radius-lg`, `--surface-card`): left ~60% **drop zone** (dashed 1 px `--line-default`, icon + "Drop a video here or **Browse**"), right ~40% **link field** ("Paste a video link") with a **Paste** icon button. The two are visually one control row on large screens; stacked in compact tier.
3. **Source summary** (replaces the source area after a source is chosen, same card): thumbnail, title/filename, duration, resolution, size, ✕ to clear. For URLs this fills in after the metadata probe (04 §3).
4. **Four setting cards** (grid; 4 columns standard/large, 2 compact): Aspect ratio · Caption style · Clip length · Number of clips.
5. **Advanced** (collapsed disclosure, chevron).
6. **Primary button "Find clips"** (pill, 44 px, right-aligned under the cards) and a one-line status hint on its left that explains why it's disabled ("Add a video to continue").
7. **Recent projects** row: horizontally scrolling thumbnails.

### 4.2 Source area behaviour
- Accepts: drag-and-drop of one video file (extension and MIME checked), **Browse** (native dialog filtered to supported types), **paste** (Ctrl+V anywhere on the page pastes a URL or a copied file), "Open with…" launch argument.
- Multiple files dropped: the first video becomes the source; a toast says the others can be added later in the editor's media library.
- Unsupported file → inline error under the drop zone (what it is, what is supported) — no modal.
- **URL field validation:** trims whitespace; must be `http(s)`; on paste or after 600 ms of typing, run the **link probe** (04 §3). States: *checking* (spinner), *ready* (green check + summary), *failed* (error text from 04 §3.4), *needs internet* (clear message; offline mode does not block checking attempts but explains).
- A file and a URL cannot both be active; choosing one replaces the other.

### 4.3 Setting card 1 — Aspect ratio
- Visual **shape tiles** (not text-only): 9:16, 16:9, 1:1, 4:5, 4:3, 21:9, **Original**, **Custom** (opens a small popover: width/height ratio inputs, 1–32 each).
- Default **9:16** before a source is chosen. After a source is chosen the app computes a **Recommended** badge: landscape source → 9:16 if content type is talking/podcast/gaming, else 16:9; portrait → 9:16; square → 1:1. The user's choice always wins; the badge never auto-selects after the user has picked.
- When a source exists, show a **crop preview**: first-frame thumbnail with the crop rectangle for the chosen ratio, **draggable** horizontally/vertically to set initial framing; "Reset" button. The framing is stored as `initialFraming {x,y,scale}` and used when clips are created (and can be changed later in the editor).

### 4.4 Setting card 2 — Caption style
- Horizontal scroller of **live animated preview tiles** (the 10 built-in presets from `11`, plus **None** and the user's saved styles). Each tile renders sample text ("This is how it looks") with the style's real animation, looped slowly; hover plays at full speed. Selected = 2 px `--brand` outline.
- No editing here; a "Customise in editor" hint. Default = the user's last used style, else "Bold creator".

### 4.5 Setting card 3 — Approximate clip length
- **Segmented presets:** *Short 15–30 s · Medium 30–60 s · Long 60–90 s · Extended 90–180 s · Custom*.
- **Custom:** a two-handle range slider (min 10 s, max 10 min) with numeric fields.
- Meaning: a **target range**. Detection prefers clips inside the range and may exceed it by up to 20% when needed to finish a complete idea (`07 §5`). The hint under the control says so.

### 4.6 Setting card 4 — Number of clips
- Segmented: **Auto · 3 · 5 · 10 · 15 · 20 · Custom** (1–50).
- **Auto** = every moment scoring ≥ 65, up to 20.
- Hint: "You'll still see more moments to choose from."

### 4.7 Advanced (all optional, sensible defaults)
| Field | Control | Default |
|---|---|---|
| Project name | text | source title/filename |
| **Clip focus** | textarea ≤ 300 chars, placeholder "e.g. funny moments, business advice, controversial opinions" | empty |
| Content type | select: Auto-detect, Podcast/interview, Talking head/vlog, Tutorial/educational, Gaming/stream, Lecture/talk, Other | Auto |
| Language | select: Auto-detect + list | Auto |
| Processing mode | segmented: Offline / Online AI / Automatic, with which provider each stage will use shown beneath | Automatic |
| Download quality (URL only) | 720p / 1080p / Best available | 1080p |
| Transcription model | Auto + all installed/available Whisper models with size and speed hint | Auto |
| Storage | Copy into library (recommended) / Reference original | Copy |
The page remembers the **last used values** (except source and project name) as the defaults for next time. A "Reset to defaults" link is provided.

### 4.8 Find clips (primary button)
- Enabled when: a valid source exists (file validated or URL probe succeeded) **and** workspace storage has enough free space (check: source size × 3 for files, expected size × 3 for URLs; show the requirement if blocked).
- On click: create the project record immediately (so nothing is lost), store the settings snapshot, navigate to `/project/:id/import`. The button shows a short spinner only while the project is being created (< 500 ms).
- **Enter** on the page triggers it when enabled.
- If processing mode is Offline and no Whisper model is installed: a dialog offers to download one (size, estimated time) or switch mode. If Online and no provider is configured: dialog with "Set up a provider" or "Switch to offline".

### 4.9 Recent projects row
- Cards (thumbnail, name, stage chip: *Downloading / Transcribing / Moments ready / N clips / Exported*, last edited time). Click opens at the furthest stage. A "⋯" menu: Open, Rename, Duplicate, Archive, Show in folder, Delete (confirm; deleting a project never deletes referenced originals; managed media deletion is stated in the dialog).
- Empty state: a calm one-liner and an arrow to the source area.
- Row shows up to 8; "See all" → `/projects`.

---

## 5. PROJECTS PAGE (`/projects`)
Grid/list toggle, search by name, sort (recent, name, created), filter by stage and archived, thumbnail + metadata, same ⋯ menu, multi-select with bulk Archive/Delete (confirm), "Import project package…" button (`03`). Empty state with "Start your first project".

---

## 6. PROGRESS SCREENS (shared component: `StageProgressScreen`)

Used by Download/Load, Transcribe, and Moments analysis. Never reinvent per screen.

### 6.1 Layout (centred, max 720 px, vertically centred)
1. **Stage title** (`--fs-xl`): e.g. "Downloading your video".
2. **Hero percentage** (`--fs-hero`, 700, counts smoothly) with a **ring or wide bar** (brand-strong → amber sweep).
3. **Reason line** (`--fs-md`, secondary): *why* this is happening in plain language (table 6.3).
4. **Stage illustration**: small looping animation (download arrow into a tray; waveform morphing into lines of text; scanning bars over a timeline), 96–128 px, monochrome with one `--brand` accent. Replaced by a static icon under reduced motion.
5. **Detail row** (`--fs-sm`, muted): speed, size/time done of total, elapsed, **ETA** (shown only after enough data to be stable; otherwise "Estimating…").
6. **Sub-steps list** (when applicable): check icon / spinner / pending dot per sub-step.
7. **Actions:** **Cancel** (secondary) · **"Continue in background"** (ghost; returns to Home while the task keeps running; the top-bar tasks button shows it) · **Details** (ghost; toggles a read-only log panel with redacted technical lines).
8. For transcription: the **live transcript** panel beside the ring (see `05 §8`).

### 6.2 States
| State | Behaviour |
|---|---|
| Running | as above |
| Paused/waiting (queued behind another job) | "Waiting for the previous task…" with queue position |
| Cancelling | spinner, "Stopping…", buttons disabled |
| Cancelled | summary "Cancelled — partial work saved" with **Resume** / **Start over** |
| Failed | error panel (6.4) |
| Complete | brief ✓ state (400 ms) then auto-advance (setting "Auto-continue", default on for Import/Transcribe; Moments always waits for the user) |

### 6.3 Reason lines (use these; adapt wording only for language)
| Stage | Reason line |
|---|---|
| Checking link | "Checking that the link can be downloaded." |
| Downloading video/audio | "Downloading your video so it can be edited offline." |
| Merging | "Combining the video and audio into one file." |
| Copying file | "Saving a copy in your project so it stays safe if the original moves." |
| Inspecting | "Reading the video's size, frame rate and audio." |
| Preparing preview | "Making a lightweight copy so editing stays smooth." |
| Extracting audio | "Preparing the audio for transcription." |
| Transcribing | "Turning speech into text so we can make captions and find the best moments." |
| Building captions | "Grouping words into easy-to-read captions." |
| Preparing candidates | "Finding complete ideas that could stand alone as clips." |
| Analysing audio | "Looking for energy, emphasis and pauses." |
| Scoring | "Rating each moment for hook, emotion and clarity." |
| Ranking | "Removing near-duplicates and picking the strongest moments." |

### 6.4 Failure panel
Shows: what failed (one sentence), the likely reason, and **specific next actions** as buttons (Retry, Change setting, Switch to offline, Open log, Copy details). Never a raw stack trace. Examples: "This video is private and needs a login. Clipwright can't download it." / "Not enough disk space: 4.2 GB needed, 1.1 GB free [Choose another drive]".

### 6.5 Closing the app mid-task
If tasks are running: confirm dialog ("Transcription is 43% done. Quit and resume next time?"). Tasks are persisted (`04 §9`) and **resume** on next launch with a notification.

---

## 7. NOTIFICATIONS
Toasts per `01`. Task completion while the user is elsewhere → toast with "Open". When the window is not focused, also a Windows notification for: transcription complete, moments ready, export complete/failed (setting on by default, can be turned off).

---

## 8. LINKS TO OTHER PARTS
Start page writes the **settings snapshot** (`project.settings`) used by 04, 05, 07, 08. Stepper state is derived from persisted task states (never from in-memory flags). Background-tasks popover reads the job queue from `04 §9`. Caption tiles read presets from `11`. Provider checks read `06`.

---

## 9. EDGE CASES
Source file deleted between selection and click → error with Browse again · URL probe slow (> 10 s) → "Still checking…" with Cancel · no internet with URL → clear offline message, button disabled · very long filename → ellipsis + tooltip · unicode/emoji paths work · drag a folder → "Drop a video file, not a folder" · drag an image/audio → explains video required (audio-only transcription is later; editor media library accepts them) · launch with a file argument → pre-fills the source · window narrowed to 1100 px → 2-column cards, stacked source area · two quick clicks on Find clips create one project · closing the window while the project is being created → no orphan records (transactional) · workspace unavailable (drive removed) → blocking dialog with Choose folder / Retry.

---

## 10. ACCEPTANCE CHECKS
1. First run shows the setup dialog once; workspace is created; the app is immediately usable.
2. Drop a 1080p landscape MP4: summary appears < 1 s; Recommended badge shows; crop preview drags and resets.
3. Paste a valid public video URL: probe summary (title, thumbnail, duration) appears; an invalid URL shows a specific error; offline shows the offline message.
4. All four cards work by mouse and keyboard; last-used values persist after restart.
5. Find clips is disabled with a visible reason until valid; Enter triggers it; low-disk case blocks with a message.
6. Missing Whisper model in Offline mode and missing provider in Online mode both produce the correct dialogs.
7. Stepper: completed steps navigate, future steps are disabled with tooltips; changing language prompts the destructive-confirm dialog; changing aspect ratio re-runs nothing.
8. Progress screens show true percentage, reason line, ETA after stabilising, working Cancel, working Continue-in-background, and the correct failure panel with actions.
9. Quit mid-transcription → confirm → relaunch resumes (verified with a real file).
10. Layout verified at 1100×680, 1280×720, 1920×1080, 2560×1080 and 200% scaling with no overlap or horizontal page scroll; no item from the `01` avoid list.
