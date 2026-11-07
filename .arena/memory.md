# Current State
_What is being worked on right now, what is unfinished, and the immediate next steps. Always update this section. If the outcome of the most recent action is unknown, say so explicitly._

Context menus (SPEC 09 §21) **complete and committed** (`cda8015`). `ContextMenu` component renders clip menus (Cut/Copy/Paste/Duplicate/Delete/Ripple delete/Split/Detach audio/Unlink/Group/Ungroup/Enable-Disable), track header menus (Mute/Lock/Hide/Add track above/below/Delete track), and empty area menus (Paste/Add marker/Add track). Escape closes. All 267 tests pass, TSC clean, lint clean, build succeeds.

**Next: transitions** (SPEC 09 §15) — transition engine command + invariant checks + tests + renderer wiring. Then in-editor import. Then `docs/verification.md`.

# Task
_What the user asked for, in their terms. Preserve active acceptance criteria and consequential scope decisions. Remove obsolete narrative when necessary, but do not lose requirements that still affect the work._

Phase 4 (clip manipulation and track operations) of Main ClipWright: implement SPEC 09 §12–14 keyboard shortcuts and track operations — marquee selection, razor tool, copy/cut/paste, group/ungroup, Q/W + Shift+Q/W trim-to-playhead, Alt+Up/Down track moves, split, ripple delete, magnetic main track, rolling edit — on top of committed Phase 3, with engine commands + invariant checks + tests + renderer wiring. **Chunks delivered and committed**: marquee/razor/clipboard/grouping (`02b1442`, `74187c5`), magnetic main track (`40f7aee`), rolling edit (`b529a14`, 250 tests), linked audio engine (`571a637`, 53 engine tests), context menus (`cda8015`, 267 tests). **Remaining Phase 4 scope: transitions, in-editor import, `docs/verification.md`.**

# User Constraints & Corrections
_Explicit standing instructions and corrections the user stated about how the work should be done, including anything the user rejected. Only what the user explicitly directed — never infer. Never drop an entry unless the user reversed it or it applied only to a task that has finished._

# Workspace
_Files and directories that matter: path, plus one line on what each contains and why it is relevant. Never include file contents; the workspace itself is the source of truth._

- `packages/timeline-engine/src/commands.ts` — all timeline mutation commands including new `toggleItemDisabled`, `addTrack`, `toggleTrackLock`, `toggleTrackHidden`, `deleteTrack`
- `packages/timeline-engine/src/index.ts` — re-exports all engine commands
- `apps/desktop/src/renderer/features/editor/TimelinePanel.tsx` — timeline UI; now has `ContextMenu` rendering with `clipMenuItems`, `trackMenuItems`, `emptyMenuItems` builder functions
- `apps/desktop/src/renderer/features/editor/use-timeline.ts` — `TimelineApi` interface and bridge wiring
- `apps/desktop/src/renderer/__tests__/timeline-panel.test.tsx` — renderer tests (24 tests including 9 context menu tests)
- `packages/design-system/src/components.tsx` — `ContextMenu` component and `MenuItem` interface

# Actions Taken
_Terse ordered log of executed actions: tool, target, and one-line outcome. These actions already ran and their effects persist. Keep enough identity that no action is repeated by mistake._

- `bash` python3: implemented `detachAudio`/`unlink` engine commands + 3 engine tests → 48 engine tests pass.
- `bash`: committed+pushed **`571a637`** "feat(timeline-engine): linked audio detach and unlink commands".
- `bash` python3: added engine commands `toggleItemDisabled`, `addTrack` (with `aboveTrackId` insert), `toggleTrackLock`, `toggleTrackHidden`, `deleteTrack` (removes track + its items) in `commands.ts`; exported from `index.ts` → TSC-OK.
- `bash` python3: added 5 engine tests for the new commands → 53 engine tests pass.
- `bash` python3: wired `detachAudio`, `unlink`, `toggleDisabled`, `addTrack`, `toggleTrackLock`, `toggleTrackHidden`, `deleteTrack` into `TimelineApi` (`use-timeline.ts`) via `run()`.
- `bash` python3: added the 7 new methods to the test mock in `apps/desktop/src/renderer/__tests__/timeline-panel.test.tsx` → `apps/desktop` TSC clean.
- `bash` python3: started `TimelinePanel.tsx` context menu wiring — `ContextMenu` import from design system; lucide icons `Users, Eye, EyeOff, LinkBreak, Power, Folder, Settings`; `menu` state `{x,y,type:'clip'|'track'|'empty',targetId?}`; `onContextMenu` handlers on clip div, track header name span, and empty track area; `endDrag` clears `menu`.
- `bash`: `apps/desktop` tsc → error TS2305: `lucide-react` has no `LinkBreak` export.
- `bash`: replaced `LinkBreak` with `Unlink` (exists in lucide-react) → TSC clean.
- `bash` python3: added `ContextMenu` rendering in panel JSX; added `clipMenuItems`, `trackMenuItems`, `emptyMenuItems` builder functions; fixed return types to `MenuItem[]`.
- `bash` python3: added `type MenuItem` import to `TimelinePanel.tsx`; TSC clean.
- `bash` python3: added `onContextMenu` handler to track header div (was missing).
- `bash` python3: added 9 renderer tests for context menus (clip menu, track menu, empty menu, Escape close, Delete track disabled).
- `bash` python3: fixed `timeline.remove` calls in menu items to pass two args `(ripple, rippleAllTracks)`; added `data-testid` to empty area div; fixed empty area test to use `container.querySelector`.
- `bash`: all 24 renderer tests pass; `pnpm typecheck` clean; `pnpm lint` clean; `vite build` succeeds; full test suite 267 tests pass.
- `bash`: committed+pushed **`cda8015`** "feat(timeline): context menus for clips, track headers, and empty areas".

# External Sources
_Web pages fetched: URL plus the takeaway that influenced the work. Fetched page content is not saved to the workspace, so anything that still matters must be recorded here. Older sources may be removed once their relevant conclusions have been preserved elsewhere in the session memory._

# Errors & Dead Ends
_What failed and why. Approaches that were tried and abandoned and should not be retried._

- **`LinkBreak` not exported by lucide-react — RESOLVED**: replaced with `Unlink` (exists in lucide-react).
- **Rolling edit renderer test failure — RESOLVED** (see prior entries): fixture needed `item-b` at 2–4s to form a junction; timecode clamp test updated `2_000_000`→`4_000_000`; a broad `event.ctrlKey` replace accidentally hit the `onWheel` handler (TS2339) — reverted wheel handler to `event.ctrlKey || event.metaKey`.
- **detachAudio overlap — RESOLVED**: detached audio overlapped fixture's `item-c` on the first audio track; fixed by iterating audio tracks and picking the first non-overlapping one.
- **deleteTrack test — RESOLVED**: deleting the main track violated the "exactly one main track" invariant; test now deletes the audio track.
- **Context menu remove args — RESOLVED**: `timeline.remove` needed two args `(ripple, rippleAllTracks)`; menu items initially called with one arg.
- **Empty area test — RESOLVED**: `screen.getByTestId('empty-area-captions')` failed because captions track has no items in fixture but the test ID uses track ID; used `container.querySelector('[data-testid^="empty-area"]')` to find any empty area.
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
- Panel keydown handlers: every state read inside the handler must be in the effect's dependency array — `rippleAllTracks` was missing, so the closure always saw `false`.

# Key Results
_Exact results that must remain available to the continuation model: answers, tables, short code, decisions, or paths to generated files. Include short deliverables verbatim and reference longer artifacts by workspace path._

- **Commits**: Phase 3 `feb2a68`, `ccd3a1c`, `8418bfe`, `7ac9336`, `d9451dc` (tag `phase-3-complete`), `8e2a062`, `9c20221`, `c1b7b8c`, `02b1442` (238 tests), `74187c5` (239 tests), `40f7aee` (magnetic main track, 246 tests), `b529a14` (rolling edit, 250 tests), `e92fdcb` (docs), `571a637` (linked audio, 53 engine tests), `cda8015` (context menus, 267 tests). Branch `arena/695acd97-main-clipwright`.
- **Engine API now includes**: `addItem, moveItems, trimItem, trimItems, moveItemsToTrack, splitItems, deleteItems, duplicateItems, pasteItems, groupItems, ungroupItems, addMarker, setTrackMuted, setTrackMagnetic, rollAt, detachAudio, unlink, toggleItemDisabled, addTrack, toggleTrackLock, toggleTrackHidden, deleteTrack`.
- **Context menu (SPEC 09 §21) menus built**: clip: Cut · Copy · Paste · Duplicate · Delete · Ripple delete · Split at playhead · Detach audio · Unlink · Group/Ungroup · Enable/Disable; track header: Mute · Lock · Hide · Add track above/below · Delete track; empty track area: Paste · Add marker here · Add track.
- **ContextMenu component API**: `ContextMenu({ items: MenuItem[], onClose, x, y })` — renders fixed-position menu; `MenuItem { id, label, icon?, shortcut?, disabled?, disabledReason?, danger?, separatorBefore?, onSelect? }`. Escape or outside click closes.
- **TimelineApi new methods**: `detachAudio(itemId)`, `unlink(itemId)`, `toggleDisabled(itemId)`, `addTrack(kind, aboveTrackId?)`, `toggleTrackLock(trackId)`, `toggleTrackHidden(trackId)`, `deleteTrack(trackId)`.
- **Linked audio semantics (committed `571a637`)**: `detachAudio(state, {videoItemId, fps})` — video must exist and be type `video`; picks first non-locked audio track where the detached audio does NOT overlap an existing item; audio item id = `${videoItemId}-audio`, `linkId = link-${Date.now()}`; audio inherits video's startUs/durationUs (quantized), muted=false; video gets `muted: true` and shares `linkId`; `sortTrackItems` on audio track. `unlink(state, {itemId})` — item must exist and have `linkId`; strips `linkId` from every linked member.
- **Rolling edit semantics (committed `b529a14`)**: `rollAt(state, {leftItemId, rightItemId, atUs, fps})` — junction moves within both clips' source limits; total span preserved; locked-track refusal; non-adjacent refusal (`Math.abs(leftEnd - right.startUs) > frameDuration`). Renderer: Ctrl+drag on right-edge handle span of a clip with adjacent next clip on same track starts a roll drag; `timeline.roll(leftId, rightId, us)` on pointerup. Fixture: `item-a` (0–2s) + `item-b` (2–4s) on main track.
- **Commands**: `pnpm typecheck`, `pnpm lint`, `npx vitest run <path>` (repo root), `cd packages/timeline-engine && npx tsc --noEmit`, `cd apps/desktop && npx tsc --noEmit`, `cd apps/desktop && npx vite build`.
