# Development

## Setup

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` runs the renderer with hot reload on port 5173. The Electron shell
attaches to it; on a headless machine you get the renderer only, which is enough
for UI work, and every renderer feature degrades honestly when there is no
bridge (`window.clipwright` is undefined and the UI says the desktop app is
required).

## Folder map

```
apps/desktop/
  src/main/            Electron main process
    export/            export queue, ffmpeg orchestration, audio mixing
    updater/           update service, trusted keys
    ai/                provider, model and moments services
    storage/           SQLite, settings, secrets, logging
    security.ts        window config, CSP, URL allow-list
  src/preload/         the typed IPC bridge (index.cjs)
  src/renderer/        React UI
    features/export/   export dialog, panel, queue
    features/updates/  update dialog, settings section
  electron-builder.yml packaging
  vite.config.ts       renderer build
  vite.main.config.ts  main + preload build
packages/
  export-core/         encoder args, planner, validation, audio DSP  (pure)
  update-core/         version rules, manifest verification          (pure)
  timeline-engine/     commands, invariants, undo/redo               (pure)
  project-schema/      zod schemas, migrations
  media-core/          probing, peaks, path resolution
  ai-core/             provider adapters, scoring, models
  compositor/          renderFrame
  caption-styles/      caption presets
  audio-core/          audio helpers
  design-system/       components and tokens
resources/bin/         ffmpeg, ffprobe, whisper-cli, yt-dlp
scripts/               lint, release, verification
specs/                 the binding specifications
```

### The rule that shapes the layout

**Pure logic lives in `packages/`, I/O lives in `apps/desktop/src/main/`.** An
export encoder argument list can be tested without spawning ffmpeg; a manifest
can be verified without a network. This is why `export-core` and `update-core`
have no Electron imports at all, and why `pnpm lint` runs a determinism audit
that rejects `Math.random()` and `Date.now()` in them.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | renderer dev server |
| `pnpm build` | build every package and the app |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm lint` | design-token audit + no-fakes/determinism audit + repository checks |
| `pnpm test` / `pnpm test:unit` | vitest, all 1063 tests |
| `pnpm verify` | **the full gate** — lint, typecheck, test, build, repository checks |
| `pnpm test:e2e` | Playwright (needs browser binaries) |
| `pnpm verify:exports` | export matrix against real fixtures |
| `pnpm dist:win` | installer + portable exe |

`pnpm verify` is the one to run before pushing, and the one CI runs. It exists
because the shorter checklist (`typecheck`, `lint`, `test`) does not build the
app — and for a while the production build was broken while all three passed.
A check that cannot fail on the thing that is broken is not a check.


## Tests

Tests live beside what they test, in `__tests__/`. Two conventions:

1. **Anything that can touch a real process does.** Export tests run the bundled
   ffmpeg on generated clips; release tests run the real signing script. Faking
   ffmpeg would let the arguments drift without anyone noticing.
2. **Tests that need real media generate it.** `makeMovingSource()` writes a raw
   YUV clip with a moving bar, because a static black frame legitimately fails
   the black-frame validation check and would make a green test meaningless.

Renderer tests use `// @vitest-environment jsdom` at the top of the file; the
default environment is node.

## Adding a dependency

`pnpm lint` and CI will reject a dependency with an unknown licence. Then:

```bash
node scripts/release/make-notices.mjs
```

and commit the regenerated `THIRD-PARTY-NOTICES.txt`. CI fails if it is stale.

## Adding an IPC channel

Four places, all of which the compiler will find if you miss one:

1. `ipcMain.handle('area:action', …)` in `main.ts`
2. the method in `apps/desktop/src/preload/index.cjs`
3. the type in the `ClipwrightBridge` interface in `renderer/global.d.ts`
4. the wrapper in `renderer/api.ts`

Talking to Electron directly from a component is never done: the renderer has no
Node access (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`)
and the CSP forbids inline script.

## Style rules enforced by tooling

- **Design tokens only.** No hex colours, pixel radii or millisecond durations in
  renderer code. `pnpm lint` fails on all three.
- **No marketing claims.** The no-fakes audit rejects banned words in production
  code and comments.
- **No nondeterminism in packages.** `Math.random()` and `Date.now()` are
  rejected outside the main process.

## Debugging the export path

The export job writes a log (`ExportJobResult.log`). To see the exact ffmpeg
command line, run with `CLIPWRIGHT_EXPORT_DEBUG=1`. To run a single export test:

```bash
npx vitest run apps/desktop/src/main/__tests__/export-service.test.ts
```

If an export fails validation, the report names the check and the measured value
— start there rather than at the encoder arguments.

## Where the specifications are

`specs/` is the source of truth for behaviour, and the code cites section numbers
(`SPEC 14 §5.5`). When a spec and the code disagree, that is a bug in one of
them and belongs in the same pull request as the fix.
