# SPEC 01 — DESIGN SYSTEM

**Binding. Implement this before building any screen.** All screens use these tokens and components. No screen may hard-code a colour, radius, spacing value, font size or duration.

---

## 1. PURPOSE AND CHARACTER

Clipwright Studio must look like a serious, calm video-production tool: **dark, soft, compact, premium.** The style sits **between CapCut's desktop style** (flat tonal panels, dense, little shadow, thin or no borders) **and a rounder, softer UI.** The logo's orange is an accent, never a theme.

Words to design by: *calm, soft, dense where it must be, roomy where it can be, consistent.*

---

## 2. HOW TO IMPLEMENT

- Package: `/packages/design-system`.
- Tokens live in **one** file as CSS custom properties (`tokens.css`) and are mirrored in `tokens.ts` for use in canvas code (timeline ruler, waveforms, preview overlays).
- Use **semantic** token names (`--surface-panel`, `--text-secondary`), not raw colours (`--gray-800`), in components. This makes a future light theme a token swap: structure tokens as `:root[data-theme="dark"] { ... }` and leave `:root[data-theme="light"]` as an empty, documented block.
- Build all components in the package. Each has: variants, sizes, every state (default, hover, pressed, focus-visible, disabled, loading, error where relevant), keyboard behaviour, ARIA labelling.
- Build a **design showcase page** at route `/__design` (dev builds only) that renders every component in every state, the palette, the type scale, the spacing scale, and the radius scale. Use it to verify the design at all three layout tiers.
- **Colour source of truth:** the supplied logo (search the repo for `ClipWright_Icon.png`). On first run of Phase 1, sample the logo's real colours (orange, deep orange, amber, near-black, graphite greys). If your sampled values differ visibly from the fallback values below, use the sampled values for the brand colours and keep the neutral surface scale. Record the final values in `docs/decisions.md`.

---

## 3. COLOUR TOKENS (dark theme)

### 3.1 Brand
| Token | Value | Use |
|---|---|---|
| `--brand` | `#FF7A00` | Primary buttons, active states, playhead, selection, focus ring |
| `--brand-strong` | `#FF5A00` | Hover/pressed of primary, deep accents |
| `--brand-amber` | `#FFB000` | Progress glow end-stop, highlight defaults, score peaks |
| `--brand-tint` | `rgba(255,122,0,0.14)` | Selected/active fill for rows, tabs, icon buttons |
| `--brand-tint-strong` | `rgba(255,122,0,0.24)` | Hover over selected |
| `--on-brand` | `#121212` | Text/icons on brand fills (**never white**) |

### 3.2 Surfaces (each step is a small lightness change)
| Token | Value | Use |
|---|---|---|
| `--surface-app` | `#0E0E0F` | Window background, gutters between panels |
| `--surface-panel` | `#161617` | Panels, sidebars, timeline, inspector |
| `--surface-card` | `#1F1F21` | Cards, inputs, menus, dialogs |
| `--surface-hover` | `#28282B` | Hover rows and ghost buttons |
| `--surface-pressed` | `#303034` | Pressed state |
| `--surface-overlay` | `rgba(0,0,0,0.6)` | Dialog backdrop |

### 3.3 Lines
| Token | Value | Use |
|---|---|---|
| `--line-faint` | `rgba(255,255,255,0.06)` | Dividers inside panels |
| `--line-default` | `#2E2E32` | Input borders, separators that must be visible |
| `--highlight-top` | `inset 0 1px 0 rgba(255,255,255,0.04)` | Optional faint top highlight on cards only |

### 3.4 Text
| Token | Value | Min contrast |
|---|---|---|
| `--text-primary` | `#F2F2F3` | on all surfaces ≥ 13:1 |
| `--text-secondary` | `#A8A8AE` | ≥ 7:1 on `--surface-panel` |
| `--text-muted` | `#80808A` | ≥ 4.5:1 on `--surface-panel` — the dimmest allowed for readable text |
| `--text-disabled` | `#5C5C64` | disabled controls only, never for essential information |
| `--text-brand` | `#FF8A1F` | links, active labels (≥ 6:1) |

### 3.5 Status
| Token | Value |
|---|---|
| `--success` | `#3DD68C` |
| `--warning` | `#F5C542` |
| `--error` | `#F0524F` |
| `--info` | `#4DA3FF` |
Each has a `-tint` variant at 14% opacity for banners and badges. Status colours are **never** the brand orange.

### 3.6 Timeline track colours (muted, never orange)
| Role | Token | Value |
|---|---|---|
| Main video | `--track-main` | `#3F7F93` |
| Overlay video | `--track-overlay` | `#5C6FB5` |
| Image / graphics | `--track-graphic` | `#8A6FB0` |
| Voiceover | `--track-voice` | `#3E8F8A` |
| Original / general audio | `--track-audio` | `#4E9A6F` |
| Music | `--track-music` | `#6FA05A` |
| Sound effects | `--track-sfx` | `#A0679A` |
| Captions | `--track-caption` | `#C28AA0` |
| Text | `--track-text` | `#7E8FA6` |
| Adjustment / effect | `--track-fx` | `#8C8F5C` |
Selection = `--brand` outline. Playhead = `--brand`. These must remain clearly distinguishable from every track colour.

### 3.7 Orange discipline (hard rules)
- Orange occupies **≈5% or less** of any screen's pixels.
- Allowed orange uses: primary button, active tab/step indicator, playhead, selected-clip outline, focus ring, progress fills, tiny emphasis (score ring peak).
- **Forbidden:** orange page backgrounds, large orange cards, orange body text, orange borders on every card, multiple glowing elements at once.

---

## 4. TYPOGRAPHY

- **Font family:** **Manrope**, bundled in `/assets/fonts` (woff2), declared with `@font-face`, `font-display: swap`. Fallback stack: `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`. Never load fonts from the internet.
- Weights used: **400** body, **500** labels/buttons, **600** titles, **700** only for the hero number on progress screens. No thin or light weights.
- **Monospace for timecodes only:** `"Cascadia Mono", Consolas, monospace`, so digits never jitter during playback. (If the bundled Manrope has tabular figures and you verify they do not shift width, you may use Manrope with `font-variant-numeric: tabular-nums` instead; record the decision.)
- No all-caps headings, no gradient text, no letter-spacing tricks, no text shadows (except caption/text overlays inside the video).

| Token | Size / line height | Use |
|---|---|---|
| `--fs-xs` | 12 / 16 | Timeline labels, metadata, badges (**no smaller than 12 anywhere**) |
| `--fs-sm` | 13 / 20 | Dense panels, inspector rows, editor body |
| `--fs-md` | 14 / 21 | Default body, buttons |
| `--fs-lg` | 16 / 22 | Section titles |
| `--fs-xl` | 20 / 26 | Page titles |
| `--fs-2xl` | 28 / 34 | Start-page hero line only |
| `--fs-hero` | 56 / 60 | Progress-screen percentage only |
Nothing larger than `--fs-2xl` except `--fs-hero`.
Sizes scale with `rem` so Windows display scaling and the user's text-size setting scale text and controls together.

---

## 5. SPACING, SIZE AND SHAPE

### 5.1 Spacing (4 px base)
`--space-1: 4px, --space-2: 8px, --space-3: 12px, --space-4: 16px, --space-6: 24px, --space-8: 32px, --space-12: 48px`.
| Use | Value |
|---|---|
| Editor panel gutter | 6 px (`--surface-app` shows through) |
| Panel inner padding (editor) | 8–12 px |
| Card padding | 16 px |
| Form row gap | 12 px |
| Toolbar button gap | 4 px |
| Page margin (start/moments/progress screens) | 32 px |
| Content max width on non-editor screens | 1200 px, centred |

### 5.2 Hit areas
Minimum clickable area **32×32 px** everywhere (editor toolbars may use 32 px icon buttons; primary actions 36–44 px). Visual size may be smaller than hit area (pad invisibly).

### 5.3 Radius scale
| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4 px | tags, ruler markers, tooltips |
| `--radius-clip` | 5 px | timeline clips |
| `--radius-sm` | 8 px | buttons, inputs, selects, menu items |
| `--radius-md` | 12 px | panels, cards |
| `--radius-lg` | 16 px | dialogs, start-page drop zone, moment cards |
| `--radius-pill` | 999 px | primary action buttons, chips, toggles, score badges |
**Nested rule:** inner radius = outer radius − padding (never smaller than 4). Never mix arbitrary radii. The playhead line, ruler, and timeline gridlines are **sharp** (no rounding).

### 5.4 Depth
- Separation comes from **tone and spacing**, not lines or shadows.
- Borders: none on panels/cards; 1 px `--line-default` on inputs; 1 px `--line-faint` for dividers.
- Shadows **only** on floating layers: menus/popovers `0 8px 24px rgba(0,0,0,0.45)`, dialogs `0 16px 48px rgba(0,0,0,0.55)`.
- Glow: only the playhead gets a very subtle glow (`0 0 8px rgba(255,122,0,0.35)`) and the primary button on hover (`0 0 0 4px var(--brand-tint)`). Never more than one glowing element at a time.

---

## 6. ICONS
- One family: **Lucide**, 1.5 px stroke, rounded caps/joins. Sizes: 16 px (dense), 20 px (default), 24 px (empty states). Icons inherit `currentColor`.
- Every icon-only button has an `aria-label` and a tooltip (500 ms delay) showing the name and shortcut, e.g. "Split (S)".
- Never mix in another icon family, emoji, or decorative illustrations (except the small progress-screen loop animations specified in `specs/02`).

---

## 7. COMPONENTS (all required)

For each: build in the package, show every state in the showcase.

| Component | Rules |
|---|---|
| **Button** | Variants: `primary` (pill, solid `--brand`, `--on-brand` text, hover `--brand-strong` + faint ring), `secondary` (8 px radius, `--surface-card` fill, hover `--surface-hover`), `ghost` (transparent, hover `--surface-hover`), `danger` (error tint). Sizes: 28 dense, 32 default, 36, 44. Loading state: spinner replaces icon, width does not change. Press: 1% scale-down. |
| **IconButton** | 32×32 (28 dense). Active/toggled state = `--brand-tint` fill + `--text-brand` icon. |
| **Input / TextArea** | `--surface-card` fill, 1 px `--line-default`, 8 px radius, 32 px high; focus: 2 px `--brand` ring fading in 120 ms; error: `--error` ring + message below. |
| **Select / Combobox** | Same look as Input; menu is a floating layer with search when > 8 options. |
| **Slider** | Thick (6 px) rounded track, round thumb 14 px, brand fill, value tooltip while dragging, keyboard arrows. |
| **Toggle** | Pill, 36×20. |
| **Checkbox / Radio** | 16 px, brand when checked. |
| **Segmented control** | Pill container, active segment `--brand-tint` + `--text-brand`. |
| **Tabs** | Underline-free: active tab has `--brand-tint` pill background. |
| **Tooltip** | `--surface-card`, `--radius-xs`, 12 px text, 500 ms delay, 0 ms when moving between neighbours. |
| **ContextMenu / Menu** | Floating, 8 px radius, items 32 px high, icons 16 px, shortcut hints right-aligned in `--text-muted`, submenu support, separators, disabled items shown dimmed with reason in tooltip. |
| **Dialog** | 16 px radius, backdrop, focus trap, Esc closes, primary action on the right, destructive actions use `danger`. |
| **Toast / Notification** | Bottom-right stack, 4 s auto-dismiss (errors persist until dismissed), optional action button ("Undo"), `aria-live`. |
| **Progress linear + ring** | Fill `--brand-strong → --brand-amber` sweep; true percentage text; indeterminate state only when truly unknown. |
| **Skeleton** | Shapes matching final content, slow shimmer (1.6 s); used for lists, thumbnails, waveforms. |
| **EmptyState** | Icon (24), one-line title, one-line explanation, one clear action button. |
| **Card** | `--surface-card`, 12 px (16 for moment cards), 16 px padding. |
| **Chip / Badge** | Pill, 12 px text; variants neutral/brand/status. |
| **ScoreRing** | Circular score 0–100, ring colour steps: <50 `--text-muted`, 50–74 `--info`, 75–89 `--brand`, ≥90 `--brand-amber`. |
| **Stepper** | Horizontal; active step `--brand-tint` pill; completed steps clickable with check icon; a sliding marker animates between steps. |
| **PanelHeader** | 36 px, title `--fs-sm` 600, right-aligned actions, collapse chevron. |
| **Splitter** | 6 px hit area on the gutter, cursor change, drag to resize, double-click resets, keyboard arrows. |
| **ColourPicker** | Swatches + hue/alpha + hex input + eyedropper where supported; recent colours. |
| **TimecodeField** | Monospace, click to edit (see `specs/09`). |
| **Kbd** | Small key-cap for shortcuts. |

---

## 8. MOTION

**Principle:** calm and fast. A tool, not a marketing site.

| Token | Value |
|---|---|
| `--dur-fast` | 120 ms (hover, press, focus) |
| `--dur-base` | 200 ms (panels, menus, tooltips) |
| `--dur-slow` | 320 ms (screen transitions) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` |
No animation longer than 400 ms except progress visuals.

Rules:
- **Screen transitions:** fade + 8 px slide, `--dur-slow`; the stepper marker slides.
- **Buttons:** background shift and 1% press scale only. No bouncing, no shine sweeps, no glowing hover borders.
- **Moment cards:** stagger in once (40 ms apart); score rings animate from 0 on first appearance only.
- **Progress screens:** the big percentage counts smoothly; the fill sweeps; a soft pulse shows "still working"; one small looping illustration per stage (download arrow, waveform becoming text lines, sparkle-free "scanning" bars for analysis).
- **Editor:** **no decorative animation while editing.** No easing on the playhead, none on clip drag, none that costs frames during playback. Panel collapse/expand may animate at `--dur-base`.
- **Reduced motion:** if `prefers-reduced-motion` is set (Windows "Show animations" off), remove all non-essential motion; progress still updates.
- Animate only `transform` and `opacity` (GPU-friendly), never layout properties.

---

## 9. RESPONSIVENESS

- **Minimum window 1100×680.** Fully usable at 1280×720.
- **Layout tiers** (by window width): **compact** < 1366, **standard** 1366–1919, **large** ≥ 1920. Implement as CSS container queries/variables plus a `useLayoutTier()` hook.

| Area | Compact | Standard | Large |
|---|---|---|---|
| Start-page setting cards | 2 columns | 4 columns | 4 columns, capped width |
| Moments screen | list 40% / player 60% | 35 / 65 | 30 / 70 |
| Editor: media panel, inspector | collapsible **drawers** (collapsed by default if width < 1200), timeline gets priority height | side-by-side panels | side-by-side, larger preview |
| Toolbars | groups collapse into an overflow "…" menu in this order: view options → track options → secondary edit actions | full | full |
| Non-editor content | full width | centred, max 1200 | centred, max 1200 |

- Panels have **minimum widths**; the layout engine auto-collapses a panel before anything can overlap. Important controls (Play, Split, Undo, Export, Stepper) never disappear or overlap at any supported size.
- **Windows display scaling** 100/125/150/200% must be tested at 1280×720 and 1920×1080. Use `rem`/relative units; test text clipping and icon blurriness (SVG icons only).
- Text truncates with ellipsis plus tooltip, never overlaps neighbours. Long names never push controls off-screen.
- Persist panel sizes, collapsed state and tier-specific overrides per user.

---

## 10. ACCESSIBILITY
- Text contrast ≥ 4.5:1 (large text ≥ 3:1). Verify with an automated contrast check on the showcase page.
- Visible `:focus-visible` ring (2 px `--brand`, 2 px offset) on every interactive element. Never remove outlines.
- Full keyboard operation: Tab order follows visual order; menus, dialogs, tabs, sliders follow standard keyboard patterns.
- Every control has an accessible name; status changes use `aria-live` regions.
- Never rely on colour alone (pair status colours with icons/text).

---

## 11. THE "AVOID" LIST (reject any of these in review)
Purple or blue-to-pink gradients · glassmorphism · neon glowing borders on many elements · oversized rounded cards · centred hero text with gradient headlines · emoji in the interface · drop shadows on every card · decorative blobs/orbs · large empty hero areas · random decorative elements · more than one icon family · more than one font family (besides the timecode monospace) · text smaller than 12 px · orange used as a large fill · animation that slows editing.

---

## 12. ACCEPTANCE CHECKS
1. `/__design` renders every component in every state with no console errors.
2. A search of the source for hex colours, `px` radii and `ms` durations outside the design-system package finds **none** (lint rule enforces this).
3. Automated contrast check passes for all text/surface pairs in the showcase.
4. Showcase and Start page screenshots at 1100×680, 1280×720, 1920×1080 and 2560×1080 show no overlap, clipping or horizontal page scroll.
5. At Windows scaling 100/125/150/200% the same screens remain usable; icons stay crisp.
6. Manrope loads from the bundled files with the network disabled.
7. Reduced-motion setting removes non-essential animation.
8. Tabbing through the showcase reaches every control in a sensible order with a visible focus ring.
9. Switching `data-theme` to an experimental light block changes surfaces without touching component code (proof the tokens are semantic).
10. A reviewer scanning the screenshots finds nothing from the Avoid list.
