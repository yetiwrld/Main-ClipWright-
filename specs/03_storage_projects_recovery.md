# SPEC 03 — STORAGE, PROJECTS, AUTOSAVE, RECOVERY AND PORTABILITY

**Binding.** Follows the structure of `specs/09`. Consumers: every other spec. Related: `02` (first run, projects page), `04` (media, job queue, relink), `06` (secrets), `09` (timeline persistence), `14` (exports folder), `15` (migrations on update).
Code: `/packages/project-schema` (schemas, migrations), `/apps/desktop/src/main/storage` (file/DB access, runs in the main process or a storage utility process; the renderer never touches the disk directly).

---

## 1. PURPOSE

Make it impossible to lose work and impossible to "lose" media. Everything the user imports, creates or configures survives closing the app, crashes, power loss, updates and moving to another computer. Storage is organised, inspectable, relocatable and never silently destructive.

---

## 2. ARCHITECTURE (mandatory structure)

1. **Two kinds of database, both SQLite via `better-sqlite3`, both in WAL mode with `synchronous=NORMAL`** (`FULL` for the checkpoint commit, see §9):
   - **`workspace.db`** (in the workspace root): project index, media registry (`media`, `derived_files`), job queue (`04 §9`), settings, model registry, provider records (no secrets), caption style / brand kit index, export history.
   - **`project.cwdb`** (one per project, in `Projects/<projectId>/`): the project's compositions, items, tracks, markers, keyframes, effects, transcript, moments, captions, per-project settings snapshot, undo-independent history of checkpoints metadata.
2. **All writes go through a single `StorageService`** (main process). The renderer sends typed, zod-validated IPC messages; it never gets a database handle or a raw path to write.
3. **Schema validation:** every row's JSON column is validated with zod on read and on write. A row that fails validation is **quarantined** (kept untouched in a `_quarantine` table with the error) and the app opens the rest of the project in a clearly labelled "Recovered with problems" state, never a blank crash.
4. **No business logic in SQL.** Tables hold normalised ids and JSON blobs for item payloads; the engines (`09`, `11`, `12`) own the meaning.
5. **Migrations** are forward-only, numbered, each with a unit test (§12).
6. **Secrets never touch either database** (§11).

---

## 3. THE WORKSPACE FOLDER

Default: `Documents\Clipwright Studio` (chosen at first run, `02 §2.7`, relocatable, §13). Created with exactly this structure:

```
<workspace>/
  workspace.db            index, settings, jobs, media registry
  Projects/<projectId>/   project.cwdb, thumbnail.jpg, lock.json
  Media/<mediaId>/        original.<ext>, audio16k.wav, proxy.mp4, peaks.bin, thumbs/   (04)
  Proxies/                (reserved; per-media proxies live in Media/<id>/ — see 3.1)
  Clips/                  user-visible renders of rough clips (optional, 14)
  Exports/                finished exports (14)
  Cache/                  downloads/, features/, frames/, waveforms/   (safe to delete)
  Models/                 whisper/, onnx/, (Ollama keeps its own models)
  Recovery/<projectId>/   journal.jsonl, checkpoints/
  Logs/                   app-YYYY-MM-DD.log (rotated, redacted)
  CaptionStyles/          *.cwstyle (11)
  Templates/              project/clip templates
  BrandKits/              <kitId>/kit.json + assets (13)
  Fonts/                  user-imported fonts (11)
  Backups/                project backups (§10)
  Updates/                previous installer and update staging (15)
```

### 3.1 Rules
- `Proxies/` is kept only for forward compatibility; proxies live next to their media so deleting a media folder never leaves orphans. Do not write into `Proxies/` in v1 (leave it empty with a README).
- Folder names use ids (UUIDv7, time-sortable), **never** user text. Display names live in the DB. This avoids path-length, character and rename problems.
- **Cache is disposable:** Settings → Storage shows each folder's size with **Clear cache** (Cache/ only; derived files in `Media/` are rebuilt on demand, never deleted by Clear cache).
- A `workspace.json` in the root records `{schemaVersion, createdAt, appVersion, workspaceId}` and a plain-text `README.txt` explaining what the folders are (so a user who browses it is not confused).
- **Never** put anything the user authored (projects, edits) only in `%APPDATA%`. App data (`%APPDATA%\Clipwright Studio`) holds only: window state, the pointer to the workspace folder, encrypted secrets (§11), crash dumps, the updater cache. Losing it must never lose a project.

---

## 4. PROJECT MODEL AND TERMS

Terms (use exactly these in code and UI strings):
- **Project** = one source video (or several sources) + its transcript + its moments + its compositions + settings. Created by "Find clips".
- **Composition** = one editable timeline (a "clip"). A project has 0..N compositions. The `Project` interface in `specs/09 §4` is the timeline data of **one composition**: `{id, name, fps, canvas, tracks, items, markers, workArea, links, groups}`. Everything in `09` operates on a composition.
- **Source media** = an entry in the workspace `media` table referenced by items (`mediaId`).

```ts
interface ProjectRecord {                 // in workspace.db (index) AND mirrored in project.cwdb meta
  id; name; createdAt; updatedAt; archived: boolean; stage: 'import'|'transcribe'|'moments'|'editor'|'exported';
  sourceMediaIds: string[]; thumbnailPath?; schemaVersion: number; appVersionLastSaved: string;
  settings: ProjectSettings;              // snapshot from the start page (02 §8): aspect, captionStyleId, length, count, focus, contentType, language, mode, downloadQuality, whisperModel, storage, initialFraming
}
interface CompositionRecord { id; projectId; name; createdFromMomentId?; version: number; payload: CompositionPayload /* 09 */; updatedAt; }
```
`project.cwdb` tables: `meta`, `compositions`, `transcript_words`, `transcript_structure`, `moments`, `caption_styles_used`, `history_checkpoints`, `_quarantine`. Words are stored one row per word (indexed by `startUs`) for fast range queries; compositions are stored as one JSON payload per composition (validated), plus a small `items_index` table `(compId, itemId, trackId, startUs, endUs, mediaId)` kept in sync by the save path so "where is this media used" and relink are fast without parsing payloads.

---

## 5. SAVING MODEL (what "saved" means)

Two layers, both mandatory:

### 5.1 Operation journal (durability, ≤ 2 s of loss)
- Every **committed transaction** from the timeline/caption/inspector engines (`09 §24`) produces a **journal entry** `{seq, compId, ts, commandName, forward patch, inverse patch}` (JSON Patch / Immer patches). Entries are appended to `Recovery/<projectId>/journal.jsonl` by a **writer in the storage utility process** and `fsync`ed in batches **at most every 1000 ms** (and immediately on window blur, minimise, Ctrl+S, and quit).
- Live gesture previews (a drag in progress) are **not** journalled; only the committed result.
- On crash, the journal replayed on top of the last checkpoint reconstructs the state with **≤ 2 s** of loss.

### 5.2 Checkpoint (full save)
- After **3 s of idle** following a change, or **every 60 s of continuous editing**, or **after every 100 journal entries**, whichever comes first, write a **checkpoint**: the compositions touched since the last checkpoint are serialised and committed in **one SQLite transaction** to `project.cwdb`; then the journal is truncated up to that `seq`.
- Serialisation runs in the **storage utility process** on a structured-clone snapshot (immutable Immer state), so the UI thread never blocks. A save that takes > 50 ms on the main thread is a bug.
- **Atomicity:** SQLite transaction. A partially written checkpoint cannot be seen.
- Header save status (`02 §2.2`): **Saved** (journal empty and no dirty state) · **Saving…** (checkpoint running) · **Unsaved changes** (journal non-empty, shown only if saving has failed or been delayed > 10 s) · **Recovered** (after a recovery, until the next manual save) · **Save failed** (error toast with Retry and Save a copy…).
- **Ctrl+S** forces a checkpoint immediately and shows a brief "Saved" confirmation.
- **Save a copy…** writes a standalone project package (§10.4).
- Autosave interval settings: Settings → General → "Autosave" (on by default; cannot be fully disabled, only the interval 10 s–5 min for checkpoints; the journal is always on).

### 5.3 Disk problems
- Low space (< 500 MB on the workspace drive during editing): non-blocking warning banner. Journal/checkpoint write failure (disk full, permission, drive removed): **keep editing in memory**, show "Save failed — changes are only in memory" with Retry, **Save elsewhere…** (choose another drive), and block closing without confirm. Retry automatically every 5 s.
- Workspace drive disappears (USB/network): blocking dialog with *Reconnect and retry* / *Choose another folder*; in-memory state is preserved.

---

## 6. CRASH RECOVERY

1. **Lock file:** opening a project writes `Projects/<id>/lock.json` `{pid, startedAt, hostname, appVersion}` and refreshes `heartbeatAt` every 5 s. Clean close deletes it.
2. On opening a project, if a lock exists: if the pid is **alive and heartbeat < 15 s old** → "This project is open in another Clipwright window" (open read-only / focus the other window). Otherwise it is **stale** → recovery flow.
3. **Recovery flow** (also triggered when `journal.jsonl` is non-empty on open): dialog "Clipwright closed unexpectedly. We recovered your work up to <time>." Buttons: **Open recovered version** (default), **Open last saved checkpoint**, **Compare** (shows the number of changes and the time range). Choosing recovered = checkpoint + journal replay; the result is immediately written as a new checkpoint and a named restore point "Before recovery" is kept (§7).
4. Replay failure (corrupt journal line): replay up to the last valid entry, report "N changes could not be recovered", keep the corrupt file in `Recovery/<id>/corrupt/` for support.
5. **Recovery of interrupted jobs** follows `04 §9` (jobs resume).
6. Crash reporting: a local crash dump + redacted log is saved to `Logs/crash/`; nothing is sent anywhere. "Open crash folder" is in Settings → Privacy.

---

## 7. VERSION HISTORY (RESTORE POINTS)

- **Automatic restore points** are stored in `Recovery/<id>/checkpoints/<ts>.cwcp` (a compressed copy of the composition payloads + transcript version + moments): one per **10 minutes of editing**, one on **project open**, one **before** any destructive project-level action (re-transcribe, replace source, restore, migration, recovery). Keep the last **20** plus **one per day for 14 days**; prune the rest. Pruning never deletes the most recent restore point.
- **Named versions:** the user can press **Save version…** (editor ⋯ menu) to name a restore point (never auto-pruned until the user deletes it).
- **History panel** (editor ⋯ → Version history): list with time, label, size, composition count; **Preview** (opens read-only in a second window is out of scope; instead shows summary + thumbnail), **Restore** (confirm; first creates a restore point of the current state; restores one composition or the whole project), **Delete**.
- Restoring never changes media files.

---

## 8. MEDIA AND REFERENCES

Managed copy and reference rules are in `04 §4`; this spec adds storage guarantees:
- `media` table: `{id, kind, storageMode: 'managed'|'reference', path, originalName, sizeBytes, sha256?, fingerprint, volumeId?, createdAt, info: MediaInfo, status: 'ok'|'missing'|'changed'}`.
- **Usage tracking:** `items_index` gives usage counts per media. Removing a media from the library when it is **in use** shows the compositions and counts and requires an explicit confirm; items become *Missing*-styled, never deleted.
- **Unused managed media clean-up** (Settings → Storage → "Review unused media"): lists managed media with zero references in every non-archived project, with sizes; the user selects and confirms; deleted files go to the **Windows Recycle Bin** (use `shell.trashItem`), not permanent deletion. Never automatic.
- **Project delete** (`02 §4.9`): deletes the project folder and its records; managed media used **only** by that project is listed in the confirm dialog with a checkbox "Also delete N media files (X GB)" (default **off**); referenced originals are never touched. Deleted project folders go to the Recycle Bin.
- **Relink** flow: `04 §8`. After relinking, `items_index` and `derived_files` are re-validated and proxies rebuilt if the fingerprint changed.
- **Integrity check** (Settings → Storage → "Verify library"): for every managed media, check existence and size, optionally SHA-256 (slow, progress + cancel); report mismatches; never auto-repair.

---

## 9. MIGRATIONS AND VERSION SAFETY

- `schemaVersion` integer in both databases and in `.cwpack` manifests. Migrations are functions `(db) → void`, numbered, run in a transaction, each idempotent-checked.
- **Backup before migrating:** copy `project.cwdb` to `Backups/<projectId>/pre-v<N>-<ts>.cwdb` (and `workspace.db` likewise) **before** any migration; keep the last 3 per project. Migration failure → restore from the backup automatically and open the app with a clear message; never leave a half-migrated database.
- **Newer than app:** if a project's `schemaVersion` > the app's, open **read-only** with the message "This project was made with a newer version of Clipwright Studio. Update the app to edit it." No migration down is supported (state this in `docs/limitations.md`).
- After migration, an integrity check (`PRAGMA integrity_check`, `foreign_key_check`) runs; failure → restore backup.
- Unit test for every migration using committed fixture databases of **every previous schema version**.
- Unknown fields in JSON payloads are **preserved** on load/save (zod `.passthrough()` at the top level of payloads) so downgrading minor versions does not drop data.

---

## 10. PROJECT MANAGEMENT AND PORTABILITY

### 10.1 Actions (Projects page and Home recent cards, `02 §4.9`, `§5`)
- **Rename** (name only; no folder change). **Duplicate** (copies `project.cwdb` with a new id/name "… copy"; **managed media is shared by reference, not copied**; the dialog states this and offers "Also copy media" for a fully independent duplicate). **Archive** (hides from Home; read-only until unarchived; media kept; may optionally "Free proxies and cache for this project"). **Show in folder**. **Delete** (§8).
- Every action is covered by a confirm or an undo toast as appropriate; none deletes referenced originals.

### 10.2 Backups
- Settings → Storage → **Back up project…** and an optional **automatic daily backup** (off by default) of `project.cwdb` of projects edited that day to `Backups/` (keeps 7). Backups contain project data only, not media; the dialog says so. **Restore from backup** lists backups per project.

### 10.3 Project package (`.cwpack`)
A ZIP (store method for media, deflate for JSON) with this layout:
```
manifest.json        {format:'cwpack', formatVersion, schemaVersion, appVersion, createdAt, projectId, name, media:[{id, originalName, sizeBytes, sha256, included:boolean}], fonts:[...], brandKits:[...], checksums }
project.cwdb         the project database (a consistent copy via sqlite backup API)
media/<mediaId>/original.<ext>      (when included)
fonts/*, brandkits/*, captionstyles/*   (only those the project uses; fonts only if their licence is OFL/free or the user confirms, §10.5)
```
- **Export dialog:** choose what to include — *Project data only* · *Project + source media* (default) · *Project + source media + exported clips*. Shows the **total size** and warns above 4 GB; uses ZIP64. Progress, cancel, and a final SHA-256 shown for the package. Derived files (proxies, peaks, thumbnails) are **never** packaged (they are rebuilt).
- **Import:** `.cwpack` by Projects page button, drag onto Home, or double-click (register the file association in the installer). Steps: verify the manifest and checksums → check schema version (§9) → show a summary (name, media count/size, fonts) → choose workspace storage (managed copies) → **conflict handling**: same `projectId` exists → *Import as a new copy* (default, new ids) or *Replace* (confirm; restore point first). Media with a matching SHA-256 already in the library are **reused**, not duplicated. Missing (not included) media are imported as *Missing* with the Relink flow offered.
- A package from a **newer** schema opens as read-only with the same message as §9.

### 10.4 "Save a copy" = export a `.cwpack` of the current state.

### 10.5 Fonts in packages
Bundled fonts are never packaged (they ship with the app). User-imported fonts are included **only** if the user ticks "Include fonts I imported" and confirms they are allowed to redistribute them (the dialog states that font licences vary). Without them, the receiving machine shows a font-missing notice (`11`) and substitutes.

---

## 11. SETTINGS AND SECRETS

- **Settings** live in `workspace.db` (`settings` table `{key, valueJson, updatedAt}`), validated by a zod schema with defaults; unknown keys preserved. Reading a setting that fails validation returns its default and logs a warning. **Reset to defaults** per section (confirm). Window geometry and the workspace pointer live in `%APPDATA%\…\app-state.json` (needed before the workspace opens).
- **API keys and tokens:**
  - Encrypted with Electron `safeStorage.encryptString` and stored as base64 blobs in `%APPDATA%\Clipwright Studio\secrets.bin` (a small JSON map `{secretId: blob}`) — **not** in `workspace.db`, **not** in the workspace folder (so a copied/backed-up workspace never carries keys).
  - The provider record in `workspace.db` holds only a `secretId` reference.
  - If `safeStorage.isEncryptionAvailable()` is false, **do not fall back to plaintext**: the Providers UI shows "Secure storage isn't available on this system. Keys can't be saved; you can still enter one for this session." and keeps the key in memory only.
  - Keys are never written to logs, crash dumps, project files, `.cwpack`, IPC events to the renderer (the renderer sees only `hasKey: true` and a masked suffix like `••••a1b2`), or screenshots/test artefacts.
- **Cookies file path** (`04 §3.5`) is a normal setting (the path only).

---

## 12. LOGGING AND REDACTION
- `Logs/app-YYYY-MM-DD.log`, JSON lines, rotated daily, **keep 14 days / 50 MB**. Levels error/warn/info/debug (debug off by default).
- A central `redact()` runs on every log write: strips `Authorization` headers, `api_key=`/`key=` query params, strings matching known key patterns (`sk-…`, `Bearer …`, long base64 tokens), cookie file contents (never logged), full home-directory paths shortened to `~`. Unit-tested with a corpus of 30 secret-looking strings.
- Transcript text and media content are **never** logged. File **names** are logged only at debug level.
- Settings → Privacy → **Open logs folder**, **Copy diagnostic summary** (versions, OS, GPU, redacted settings, last 200 log lines).

---

## 13. MOVING THE WORKSPACE
Settings → Storage → **Change workspace location**:
1. Choose the target folder; check free space ≥ current workspace size × 1.1 (excluding `Cache/`, which is not copied) and that the target is not inside the current workspace.
2. Close open projects (prompt to save), pause the job queue.
3. **Copy** (not move) with true byte progress and Cancel (cancel deletes only the partial copy). Verify file counts and sizes (and SHA-256 for `workspace.db` and every `project.cwdb`).
4. Update the pointer in `app-state.json`, reopen the workspace, rebuild nothing.
5. Ask: "Your old workspace is still at <path>. Move it to the Recycle Bin?" (default **No**). Never deletes without that answer.
Opening an existing workspace folder (e.g. after reinstalling Windows): Settings → Storage → **Use existing workspace…** validates `workspace.json` and migrates if needed.
Referenced (non-managed) media paths are left as they are; missing ones go through Relink.

---

## 14. UNINSTALL AND UPDATES
- Uninstaller and updater **never delete** the workspace, `%APPDATA%` secrets, projects or media. The uninstaller offers an unchecked option "Also delete app settings and saved keys" (does not offer deleting the workspace; it tells the user where it is).
- Updates preserve everything (`15`); migrations follow §9.

---

## 15. EDGE CASES
Project name with emoji/quotes/very long (stored as text; folder uses id) · two instances editing the same project (lock → read-only) · system clock changes backward (use monotonic `seq`, not timestamps, for ordering) · antivirus locks a file during checkpoint (retry with backoff, journal continues) · OneDrive/network workspace (warn: "Cloud-synced folders can corrupt databases; choose a local folder"; allow with confirm) · case-only rename on Windows (name is DB-only, fine) · 50,000-word transcript (indexed range queries; no full load into the editor store) · workspace on a read-only drive (open read-only with a banner) · very large `.cwpack` (> 20 GB) streams without loading into memory · power loss during migration (backup restores) · restoring a restore point after media was deleted (items show Missing).

---

## 16. ACCEPTANCE CHECKS
1. First run creates the exact folder structure of §3 with `workspace.json`; the app works immediately.
2. Edit a composition, hard-kill the process (`taskkill /F`) within 2 s of the last edit → relaunch → recovery dialog → recovered state is missing **≤ 2 s** of work (automated: scripted edits + kill at random times, 20 runs).
3. Idle 3 s → checkpoint written; journal truncated; status shows Saved; the UI never drops below 55 fps during checkpoints on a 2,000-item composition (profiled).
4. Disk-full simulation (tiny VHD) → "Save failed — changes only in memory" with working Retry/Save elsewhere; no data loss once space is freed.
5. Stale-lock and live-lock cases behave as §6; a corrupt journal line recovers everything before it.
6. Restore points: created per §7, pruned per policy, Restore creates a pre-restore point, restore of one composition leaves others intact.
7. Migration tests pass for every historical schema fixture; failed migration (injected error) restores the backup; newer-schema project opens read-only.
8. `.cwpack` round trip: export (with media) → delete project → import on a **clean workspace** → project opens identically (item-by-item equality test), media hashes match, packaged without derived files; conflict *copy* and *replace* both work; a tampered package (changed byte) is rejected by checksum.
9. Duplicate/rename/archive/delete behave per §10; deleting a project never deletes referenced originals and sends managed files to the Recycle Bin only when the box is ticked.
10. Moving the workspace to another drive copies, verifies, repoints and asks before deleting; cancel mid-copy leaves the original intact.
11. Secrets: with a test key saved, a scan of `workspace.db`, every `project.cwdb`, `Logs/`, a `.cwpack`, crash dumps and IPC traces finds **no** occurrence of the key; with `safeStorage` unavailable the key is session-only.
12. Redaction unit tests pass on the 30-string corpus; transcript text never appears in logs.
13. Unknown JSON fields survive load → save → load.
14. Uninstall + reinstall leaves workspace and projects intact and reopenable (verified on a clean VM, `16`).
