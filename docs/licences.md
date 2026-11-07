# Clipwright Studio — Third-Party Licences & Notices

Clipwright Studio incorporates and bundles the following open-source components and fonts. Every bundled component's licence has been reviewed and verified (`specs/15` §6.2).

---

## 1. Bundled Media & AI Binaries

| Component | Licence | Distribution Mode | Notes & Source Offer |
|---|---|---|---|
| **FFmpeg & ffprobe** | GPL v2+ / LGPL v2.1+ | Separate standalone executables (`resources/bin/ffmpeg`, `resources/bin/ffprobe`) | Invoked as external child processes, never linked into application code. Includes `libx264`, `libvpx-vp9`, `libopus`, and native `aac`. Full source code is available at https://ffmpeg.org/download.html and https://git.videolan.org/?p=ffmpeg.git. |
| **whisper.cpp** | MIT Licence | Separate standalone CLI executable (`resources/bin/whisper-cli`) | Copyright (c) Georgi Gerganov. Source: https://github.com/ggml-org/whisper.cpp |
| **yt-dlp** | The Unlicense (Public Domain) | Separate standalone executable (`resources/bin/yt-dlp`) | Source: https://github.com/yt-dlp/yt-dlp |

---

## 2. Bundled Fonts (`/assets/fonts/`)

All bundled fonts are licensed under the **SIL Open Font License 1.1 (OFL-1.1)**:
- **Manrope** (400, 500, 600, 700) — Copyright (c) 2018 Mikhail Sharanda
- **Inter** (400, 500, 600, 700) — Copyright (c) Rasmus Andersson
- **Montserrat** (600, 700, 800) — Copyright (c) Julieta Ulanovsky
- **Poppins** (500, 600, 700) — Copyright (c) Indian Type Foundry
- **Anton** (400) — Copyright (c) Vernon Adams
- **Playfair Display** (600, 700) — Copyright (c) Claus Eggers Sørensen
- **Bangers** (400) — Copyright (c) Vernon Adams
- **JetBrains Mono** (400, 600) — Copyright (c) JetBrains s.r.o.

---

## 3. Core Runtime & Library Dependencies

| Package | Licence | Purpose |
|---|---|---|
| **Electron** | MIT | Desktop application shell |
| **React & React DOM** | MIT | User interface rendering |
| **Zustand & Immer** | MIT | Immutable state management & undo/redo patch generation |
| **Zod** | MIT | Runtime schema validation for SQLite & IPC |
| **Lucide (`lucide-react`)** | ISC | 1.5 px stroke vector icon library |
| **SQLite** | Public Domain | Embedded relational database (`workspace.db`, `project.cwdb`) |
| **electron-updater** | MIT | Checksum-verified GitHub release updater |
