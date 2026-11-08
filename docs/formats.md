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

The ten built-in presets in `assets/caption-presets/` are these same files, not a
separate format — so a preset can be exported, edited and re-imported, and no part
of the renderer knows a preset by name.

### The schema

Validated by `packages/caption-styles/src/schema.ts` (zod). Every field:

| Field | Meaning |
|---|---|
| `format` / `formatVersion` | Always `"cwstyle"` / `1`. A file from a newer build is refused with a message rather than guessed at |
| `id`, `name` | `id` is stable; `name` is what the gallery shows |
| `author`, `license`, `createdAt` | Free text shown on import so a licence travels with a shared style |
| `font` | `family`, `weight` (100–900), `italic`, `source` (`bundled`/`user`/`system`), `sizePctOfShortSide` |
| `text` | `case`, `align`, `letterSpacingEm`, `wordSpacingEm`, `lineHeight`, plus `maxLinesHint` / `maxCharsPerLineHint` for caption segmentation |
| `fill`, `outline`, `shadow` | Colour and geometry. Outline width and shadow offsets are **percentages of the font size**, never pixels |
| `background` | A chip behind the text: colour, opacity, radius, padding, and `perLine` for one box per line or one around the block |
| `position` | `anchor` (nine-way), `xPct`, `yPct`, `maxWidthPct` |
| `highlight` | `mode` (`none`/`current-word`/`keywords`/`karaoke-fill`/`word-by-word`/`sequence`), colour, scale, optional chip, `keepLit` |
| `wordColors` | Cycling colours per word; empty means fill and highlight only |
| `animation` | `in`, `out` and `perWord` steps: preset, duration, easing, plus preset-specific `params` and a `staggerMs` |
| `timing` | `leadMs`, `lagMs`, `minDisplayMs`, `holdAfterLastWordMs` |
| `rotationJitterDeg`, `seed` | Deterministic per-caption tilt, as Social Pop uses |
| `extras` | Fields a newer build wrote. Preserved and re-exported, never dropped |

### Why sizes are percentages

`sizePctOfShortSide` is a percentage of the canvas *short side*; outline and
shadow are percentages of the font size. A style therefore looks identical at
1080p, 4K, 9:16 and 1:1, in the preview and in the export, without a per-resolution
variant. The only absolute values are the background radius and padding, which are
scaled by `canvasShort / 1080`.

### Worked example 1 — the default preset, Bold Creator

Montserrat 800, uppercase, white on a 9%-of-font black outline with a hard drop
shadow. This is the preset the start page pre-selects.

```json
{
  "format": "cwstyle", "formatVersion": 1,
  "id": "bold-creator", "name": "Bold Creator",
  "author": "Clipwright Studio", "createdAt": "2026-01-01T00:00:00.000Z",
  "font": { "family": "Montserrat", "weight": 800, "italic": false, "source": "bundled", "sizePctOfShortSide": 7.2 },
  "text": { "case": "upper", "align": "center", "letterSpacingEm": 0, "wordSpacingEm": 0, "lineHeight": 1.1, "maxLinesHint": 2, "maxCharsPerLineHint": 18 },
  "fill": { "color": "#FFFFFF", "opacity": 1 },
  "outline": { "enabled": true, "color": "#000000", "widthPctOfFont": 9, "join": "round" },
  "shadow": { "enabled": true, "color": "#000000", "opacity": 1, "dx": 0, "dyPctOfFont": 8, "blurPctOfFont": 0 },
  "background": { "enabled": false, "color": "#000000", "opacity": 0.6, "radiusPx": 10, "paddingX": 12, "paddingY": 6, "perLine": true },
  "position": { "anchor": "center", "xPct": 50, "yPct": 62, "maxWidthPct": 88 },
  "highlight": { "mode": "none", "color": "#FFD400", "scale": 1, "background": null, "keepLit": true },
  "wordColors": [],
  "animation": {
    "in": { "preset": "pop", "durationMs": 140, "easing": "easeOut", "params": { "from": 0.85, "peak": 1.05 } },
    "out": { "preset": "fade", "durationMs": 100, "easing": "linear", "params": {} },
    "perWord": { "preset": "none", "durationMs": 0, "easing": "linear", "staggerMs": 0, "params": {} }
  },
  "timing": { "leadMs": 0, "lagMs": 0, "minDisplayMs": 600, "holdAfterLastWordMs": 150 },
  "rotationJitterDeg": 0, "seed": 1
}
```

### Worked example 2 — a boxed subtitle, Multi-line Subtitle

The opposite approach: no outline, and a semi-opaque chip behind the block so the
text is legible over any footage without depending on what is behind it.

```json
{
  "format": "cwstyle", "formatVersion": 1,
  "id": "multi-line-subtitle", "name": "Multi-line Subtitle",
  "author": "Clipwright Studio", "createdAt": "2026-01-01T00:00:00.000Z",
  "font": { "family": "Inter", "weight": 500, "italic": false, "source": "bundled", "sizePctOfShortSide": 5.2 },
  "text": { "case": "none", "align": "left", "letterSpacingEm": 0, "wordSpacingEm": 0, "lineHeight": 1.3, "maxLinesHint": 2, "maxCharsPerLineHint": 38 },
  "fill": { "color": "#FFFFFF", "opacity": 1 },
  "outline": { "enabled": false, "color": "#000000", "widthPctOfFont": 9, "join": "round" },
  "shadow": { "enabled": false, "color": "#000000", "opacity": 0.6, "dx": 0, "dyPctOfFont": 8, "blurPctOfFont": 0 },
  "background": { "enabled": true, "color": "#000000", "opacity": 0.62, "radiusPx": 10, "paddingX": 12, "paddingY": 6, "perLine": false },
  "position": { "anchor": "bottom-center", "xPct": 50, "yPct": 86, "maxWidthPct": 80 },
  "highlight": { "mode": "none", "color": "#FFD400", "scale": 1, "background": null, "keepLit": true },
  "wordColors": [],
  "animation": {
    "in": { "preset": "fade", "durationMs": 100, "easing": "easeOut", "params": {} },
    "out": { "preset": "fade", "durationMs": 100, "easing": "linear", "params": {} },
    "perWord": { "preset": "none", "durationMs": 0, "easing": "linear", "staggerMs": 0, "params": {} }
  },
  "timing": { "leadMs": 0, "lagMs": 0, "minDisplayMs": 600, "holdAfterLastWordMs": 150 },
  "rotationJitterDeg": 0, "seed": 1
}
```

### Legibility rule

Every preset must read at **3:1 contrast against both a pure white and a pure
black frame** (SPEC 11 §5). White text on a white frame is 1:1, so a preset in
that position must supply an outline, a shadow or a chip. `contrast.test.ts`
enforces this — it caught Animated Slide shipping without one.

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
