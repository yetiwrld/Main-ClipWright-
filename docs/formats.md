# File formats

Four formats are specific to Clipwright Studio. Everything else it reads and
writes is standard, and opens in other software.

## `.cwpack` — project pack

A single file containing a project and, optionally, its media. For handing work
to someone else, backing up a project, or moving it between machines.

It is a **zip archive** with this layout:

```
project.cwpack/
├── manifest.json          facts about the pack (see below)
├── project.cwdb           the SQLite project database
├── media/                 source files, when included
│   └── <mediaId>.<ext>
└── assets/
    ├── fonts/             any non-bundled fonts the project uses
    └── brand/             brand kits the project references
```

### `manifest.json`

| Field | Meaning |
|---|---|
| `format` | Always `"cwpack"` |
| `formatVersion` | Layout version, currently `1` |
| `schemaVersion` | Project schema version, for migration on import |
| `appVersion` | Which build wrote the pack |
| `createdAt` | ISO-8601 UTC |
| `projectId`, `name` | Identity and display name |
| `media[]` | `{ id, originalName, sizeBytes, sha256, included, ext }` |
| `fonts[]` | Font family names bundled in `assets/fonts` |
| `brandKits[]` | Brand kit names bundled in `assets/brand` |
| `checksums` | Every file in the archive, as `relativePath → sha256` |

### Two kinds of pack

- **With media** — large, self-contained, opens identically anywhere.
- **Without media** — small, for transferring an edit when both sides have the
  footage. `media[].included` is `false`; on import the app asks you to point at
  the originals and relinks them by name and checksum.

Import verifies every checksum before opening anything. A pack whose files do
not match its manifest is refused with the names of the files that failed —
a corrupted or tampered archive is never partially imported.

## `.cwstyle` — caption style

A caption preset: font, size, weight, colour, outline, shadow, background,
position, casing, animation and timing. Exported from the caption editor and
importable into any project.

It is JSON, versioned, and validated on import. Styles that reference a font
recreate the same look on another machine, because the fonts themselves are
bundled with the app ([licences](licences.md)).

## `.cwbrand` — brand kit

A set of reusable colours, fonts, logo files and default caption styles, so every
clip from a channel looks consistent.

JSON plus the logo assets it references, packaged together. Applied from
Settings → Brand.

## `peaks.bin` — audio waveform peaks

Not user-facing. When media is imported, the audio is decoded once and reduced to
two peak files per media item:

| File | Resolution | Used by |
|---|---|---|
| `peaks256.bin` | 256 samples per peak | zoomed-in waveform |
| `peaks4096.bin` | 4096 samples per peak | whole-clip overview |

Each file is a small header followed by the interleaved min/max peak values. They
are a cache: delete them and the app regenerates them on next import or scroll.
They live beside the media in the workspace, never inside a project database, so
they can be discarded safely to reclaim space.

---

## Standard formats

| Purpose | Format |
|---|---|
| Video export | MP4 (H.264/H.265), WebM (VP9) |
| Audio export | Audio follows the video container (AAC for MP4, Opus for WebM) |
| Caption sidecars | `.srt`, `.vtt` |
| Projects | `.cwdb` — SQLite, one file per project |
| Workspace | `workspace.db` — SQLite index of projects, media and settings |
| Import | Anything the bundled ffmpeg can decode, plus URLs via `yt-dlp` |

### What the app will not do with a file

- Run a file association it did not register.
- Open a `.cwpack` that fails its checksums.
- Import a project with a `schemaVersion` newer than it understands — it says so
  rather than opening it partially and losing data an older build cannot see.
