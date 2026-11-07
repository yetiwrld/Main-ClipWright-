# Current State
_What is being worked on right now, what is unfinished, and the immediate next steps. Always update this section. If the outcome of the most recent action is unknown, say so explicitly._

**Phase 4 COMPLETE.** All chunks delivered and pushed:
- `cda8015` context menus (SPEC 09 §21)
- `4acd05f` transition engine commands (SPEC 09 §16)
- `f26fe8c` in-editor drag-drop import (SPEC 09 §15)
- `fc84348` docs/verification.md

277 tests pass across 14 files. Typecheck, lint, build all clean.

**Next: Phase 5** — keyframes on the timeline (SPEC 09 §17), markers and work area (§18), waveforms and thumbnails (§19), captions on the timeline (§20), effects panel. The user will likely request starting Phase 5 or specific features within it.

# Task
_What the user asked for, in their terms. Preserve active acceptance criteria and consequential scope decisions. Remove obsolete narrative when necessary, but do not lose requirements that still affect the work._

Phase 4 (clip manipulation and track operations) of Main ClipWright: implement SPEC 09 §12–14 keyboard shortcuts and track operations — marquee selection, razor tool, copy/cut/paste, group/ungroup, Q/W + Shift+Q/W trim-to-playhead, Alt+Up/Down track moves, split, ripple delete, magnetic main track, rolling edit — on top of committed Phase 3, with engine commands + invariant checks + tests + renderer wiring. **ALL PHASE 4 CHUNKS COMPLETE**: marquee/razor/clipboard/grouping (`02b1442`, `74187c5`), magnetic main track (`40f7aee`), rolling edit (`b529a14`), linked audio engine (`571a637`), context menus (`cda8015`), transitions (`4acd05f`), in-editor import (`f26fe8c`), `docs/verification.md` (`fc84348`).

# User Constraints & Corrections
_Explicit standing instructions and corrections the user stated about how the work should be done, including anything the user rejected. Only what the user explicitly directed — never infer. Never drop an entry unless the user reversed it or it applied only to a task that has finished._

# Workspace
_Files and directories that matter: path, plus one line on what each contains and why it is relevant. Never include file contents; the workspace itself is the source of truth._

- `packages/timeline-engine/src/commands.ts` — all timeline mutation commands including transitions (`addTransition`, `updateTransition`, `removeTransition`)
- `packages/timeline-engine/src/index.ts` — re-exports all engine commands
- `apps/desktop/src/renderer/features/editor/TimelinePanel.tsx` — timeline UI with context menus, drag-drop, marquee, razor, rolling edit
- `apps/desktop/src/renderer/features/editor/use-timeline.ts` — `TimelineApi` interface and bridge wiring
- `apps/desktop/src/renderer/features/editor/Inspector.tsx` — MediaLibrary with draggable cards
- `apps/desktop/src/renderer/__tests__/timeline-panel.test.tsx` — renderer tests (27 tests)
- `packages/design-system/src/components.tsx` — `ContextMenu` component and `MenuItem` interface
- `docs/verification.md` — Phase 4 verification report

# Actions Taken
_Terse ordered log of executed actions: tool, target, and one-line outcome. These actions already ran and their effects persist. Keep enough identity that no action is repeated by mistake._

- **Phase 4 chunks completed and pushed:**
  - `cda8015` context menus (clip/track/empty menus, 9 renderer tests)
  - `4acd05f` transition engine commands (add/update/remove, 7 engine tests, 53 total)
  - `f26fe8c` in-editor drag-drop import (MediaLibrary draggable, canvas drop handler, 2 renderer tests)
  - `fc84348` docs/verification.md (170 lines covering all 30 acceptance checks)
- Context menu: fixed `LinkBreak`→`Unlink`, added `type MenuItem` import, added `onContextMenu` to track header, fixed `timeline.remove` args to `(ripple, rippleAllTracks)`, added `data-testid` to empty area
- Transitions: fixed `type` field to match `Transition` union, fixed `sourceInUs` in test fixture to provide right handle
- Drag-drop: HTML5 `onDragStart` on MediaLibrary cards, `onDragOver`/`onDrop` on timeline canvas

# External Sources
_Web pages fetched: URL plus the takeaway that influenced the work. Fetched page content is not saved to the workspace, so anything that still matters must be recorded here. Older sources may be removed once their relevant conclusions have been preserved elsewhere in the session memory._

# Errors & Dead Ends
_What failed and why. Approaches that were tried and abandoned and should not be retried._

- **`LinkBreak` not exported by lucide-react — RESOLVED**: replaced with `Unlink`.
- **Rolling edit renderer test failure — RESOLVED**: fixture needed `item-b` at 2–4s; timecode clamp updated.
- **detachAudio overlap — RESOLVED**: iterate audio tracks, pick first non-overlapping.
- **deleteTrack test — RESOLVED**: delete audio track, not main track.
- **Context menu remove args — RESOLVED**: `timeline.remove(ripple, rippleAllTracks)` two args.
- **Empty area test — RESOLVED**: use `container.querySelector('[data-testid^="empty-area"]')`.
- **Transition type field — RESOLVED**: `type` must be union `'crossfade' | 'dissolve' | ... | 'zoom'`, not `string`.
- **Transition fixture — RESOLVED**: right clip needs `sourceInUs` set to provide source handle for non-fade transitions.
- **TimelineApi interface — RESOLVED**: bridge implementation had methods but interface was missing `addTransition`/`updateTransition`/`removeTransition` signatures.
- **`npx vite build` failed on `createRequire` from `packages/project-schema/src/sqlite-adapter.ts`: renderer must import `@clipwright/project-schema/schemas`, never the package root.
- Vitest include patterns only matched `*.test.ts` until `vitest.config.ts` updated; renderer tests need `// @vitest-environment jsdom` docblock.
- jsdom has no `PointerEvent`: dispatch `new MouseEvent('pointerdown', {button, clientX, clientY, bubbles:true})`.
- Marquee pointerup closure staleness: wrap `pointerdown` + `pointermove`/`pointerup` in `await act(async () => {...})`.
- `api` helpers throw without bridge; `useTimeline` guards with `isDesktop()`.
- Do not `cd packages/timeline-engine && npx vitest run`; run vitest from repo root with a path filter.
- No browser binaries → Playwright smoke tests cannot run; UI verified via tsc/vitest+jsdom/vite build only.
- Design-system gotchas: `Button size` union `28|32|36|44`; `Chip` has no `'danger'`; `IconButton{label,shortcut,active,size}`; no `Array.prototype.findLast` in renderer lib.
- immer `produceWithPatches` needs `enablePatches()`; `current()`/JSON deep-copy only on drafts.
- `checkInvariantsMB` flags reads outside source media — `addItem`/`pasteItems` must satisfy `sourceInUs + durationUs * speed ≤ sourceDurationUs`.
- `CompositionPayload`/`TimelineItem` are zod output types — construct via schemas, not `as` casts (TS2352).
- Engine ripple validation must run against plain `state` before `produceWithPatches` (locked ripple refuses with zero mutation).
- Panel keydown handlers: every state read inside the handler must be in the effect's dependency array.

# Key Results
_Exact results that must remain available to the continuation model: answers, tables, short code, decisions, or paths to generated files. Include short deliverables verbatim and reference longer artifacts by workspace path._

- **Commits**: Phase 3 `feb2a68`, `ccd3a1c`, `8418bfe`, `7ac9336`, `d9451dc` (tag `phase-3-complete`), `8e2a062`, `9c20221`, `c1b7b8c`, `02b1442` (238 tests), `74187c5` (239 tests), `40f7aee` (magnetic main track, 246 tests), `b529a14` (rolling edit, 250 tests), `e92fdcb` (docs), `571a637` (linked audio, 53 engine tests), `cda8015` (context menus, 267 tests), `4acd05f` (transitions, 275 tests), `f26fe8c` (in-editor import, 277 tests), `fc84348` (docs/verification.md). Branch `arena/695acd97-main-clipwright`.
- **Engine API now includes**: `addItem, moveItems, trimItem, trimItems, moveItemsToTrack, splitItems, deleteItems, duplicateItems, pasteItems, groupItems, ungroupItems, addMarker, setTrackMuted, setTrackMagnetic, rollAt, detachAudio, unlink, toggleItemDisabled, addTrack, toggleTrackLock, toggleTrackHidden, deleteTrack, addTransition, updateTransition, removeTransition`.
- **TimelineApi new methods**: `detachAudio(itemId)`, `unlink(itemId)`, `toggleDisabled(itemId)`, `addTransition(trackId, leftItemId, rightItemId, type, durationUs?, alignment?)`, `updateTransition(itemId, patch)`, `removeTransition(itemId)`, `addTrack(kind, aboveTrackId?)`, `toggleTrackLock(trackId)`, `toggleTrackHidden(trackId)`, `deleteTrack(trackId)`.
- **Commands**: `pnpm typecheck`, `pnpm lint`, `npx vitest run <path>` (repo root), `cd packages/timeline-engine && npx tsc --noEmit`, `cd apps/desktop && npx tsc --noEmit`, `cd apps/desktop && npx vite build`.
- **Transition semantics**: `addTransition(state, {trackId, leftItemId, rightItemId, type, durationUs?, alignment?, fps})` — stored on later item as `transitionIn {id, type, durationUs, alignment, params, easing, crossfadeAudio}`. Duration clamped to `[2 frames, min(leftHandle, rightHandle)]`. If no handles, only fade/dip types allowed. `updateTransition` clamps duration to available handles. `removeTransition` clears `transitionIn`.
- **Drag-drop MIME**: `application/x-clipwright-media` carries JSON `{mediaId, label, type, durationUs, sourceDurationUs}`. TimelinePanel canvas `onDrop` parses and calls `placeMedia`.
