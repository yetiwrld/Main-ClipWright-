# ClipWright Verification Report

**Last updated:** 2026-11-07
**Branch:** `arena/695acd97-main-clipwright`

Every number below comes from a command that was run, in this repository, on this
date. Where something could not be verified in this environment, it says so
rather than leaving a gap a reader might mistake for a pass.

---

## 1. Automated tests

```bash
pnpm test:unit
```

```
Test Files  93 passed (93)
     Tests  2244 passed (2244)
```

| Area | Tests | What they actually check |
|---|---:|---|
| `packages/export-core` | 335 | Encoder arguments, plan determinism, validation rules, the transition-link resolution the mixer needs (an outgoing clip picks up the transition it leaves through, clips separated by a gap are not linked, a middle clip in a run gets both, and the `crossfadeAudio` flag survives the plan), audio mix DSP including the equal-power crossfade (§4.2: the two half-cosine sides sum to one in *power* at every progress, the midpoint is 1/√2 rather than the 0.5 a linear fade gives, the window composes with an item's own fades rather than replacing them, and a window running off either end of the clip is shaped where it overlaps and ignored where it does not, and the 2 ms raised-cosine de-click (SPEC 12 §12 item 8): the envelope starts and ends at zero, is symmetric between the two ends, shortens rather than overflowing on a clip shorter than two ramps, shapes the head and the tail independently, leaves an unshaped side bit-identical, and — measured rather than restated — moves no sample by more than half of `π/2N` per step), presets, the ASS caption script (field order, colour byte order, anchor mapping, karaoke timing, range shifting), and the decode filter chain: crop, scale, rotation, offset and flip, with every stage kept even-sized and landing on the exact output size, and the keyframe segmenter: boundaries, merging equal neighbours, the segment cap; and the rotate stage, which no longer refits the rotated picture to the canvas — a refit there discarded the user's scale entirely, measured at 360×360 unrotated against 480×720 rotated for a half-scaled square, with the cap now doing the shrink a `pad` cannot and clipping being the honest result for a clip that turns past the frame edge |
| `packages/compositor` | 329 | Text layout (wrapping, alignment, word rectangles, background boxes, karaoke timing, every preset at four aspect ratios), the frame builder: karaoke sweeps, word-by-word hiding, keyword emphasis, palette cycling, in/out animation, per-word pop, and item geometry (crop rectangles, per-axis and legacy scale, flips, offsets) and the keyframe evaluator: holding outside the key range, hold segments, cubic-bezier and preset easing, duplicate timestamps, and bezier handles read back end to end with *asymmetric* control points — the existing symmetric pair reads 0.5 at the midpoint, exactly what linear gives, so a regression that dropped handles would have passed it; layer resolution and blend modes (which layers are visible, ordering, opacity clamping); software compositing: every blend formula against its closed form, opacity mixing toward the backdrop rather than black, layer ordering, and YUV↔RGB conversion checked against the bundled ffmpeg in both directions and in both colour matrices; and transition timing: window placement for all three alignments, the 0→1 ramp, easing, each type's shape (crossfade opacities summing to one, fade-to-black genuinely reaching black, slide endpoints, zoom scaling); and the wipe's geometry: the edge position at each progress, that nothing is revealed at 0 and everything at 1, a ramp whose width matches the softness and stays symmetric about the edge, unit normals for all six directions, and that a wipe reports a shape rather than a fade; and the dissolve: that its noise is deterministic, seed-dependent, bounded, smooth between neighbours and the same at any resolution, that pixels switch rather than blend, that the switched fraction tracks the progress (the raw field is bell-shaped, so a quantile mapping is needed or the transition stalls at both ends), and that the other transitions carry no dissolve shape; and the slide: that both pictures move, that the vertical directions move vertically rather than falling back to horizontal, that the two clips stay exactly one frame apart at every progress, which way the strip travels, and its three `mode`s — `push` moving both pictures, `cover` leaving the outgoing clip at a zero offset, `reveal` leaving the incoming clip still and reporting the moving edge that uncovers it, with the diagonal of the reported wipe normal checked against the region the outgoing clip has actually vacated so the reveal cannot travel the wrong way; the transition composites themselves: that a shifted layer keeps what is underneath where it no longer covers (which is what makes a push a push), moves vertically as well as horizontally, honours opacity and contributes nothing when entirely off frame, and that a scaled layer enlarges about the centre, shrinks leaving a border, passes a scale of 1 through untouched and treats a zero, negative or non-finite scale as no scaling; and the effect catalogue: parameter ranges and clamping, chain order, the spec's two numeric criteria (`+1` stop doubles linear values, saturation 0 is Rec.709 luma), contrast pivoting on 0.18 linear, and a Gaussian blur checked tap by tap against the textbook kernel; and the anchor point (SPEC 10 §4, §8.2): that it is a no-op at the picture's centre for every angle, so projects saved before it existed render unchanged; that an off-centre anchor swings the picture around itself, with the corner cases checked against closed forms; that scale applies *before* rotation as the spec's transform order requires, pinned at 37° where the two orders disagree — the first version of that expectation was garbled and the implementation was right; that the anchor is keyframeable; and that an off-centre anchor is not an identity, since it moves the picture; and adjustment-layer resolution (SPEC 12 §3.1): which are live at an instant, the half-open time window, disabled and hidden ones skipped, an empty chain skipped, ordered bottom-first, and the "only the tracks below" rule including the ambiguous same-track case |
| `packages/caption-styles` | 37 | The `.cwstyle` schema, migrations, unknown-field preservation, style resolution, contrast and the documented examples |
| `apps/desktop/src/main` | 344 | Export service, queue, ffmpeg orchestration, audio mixing, keyframed segmentation over real footage, and layer compositing measured in the produced file, linked audio measured by Goertzel energy in the produced mix (during a crossfade both clips' tones are present in a window that straddles the cut, and the incoming one is audible before its own start — a plain cut cannot produce either, and measuring loudness instead would fail to tell them apart because an *equal-power* crossfade deliberately keeps the summed level flat), a zoom measured by the width of a box on a scanline in the produced file (1.3× at half progress, with the box detected by its neutrality rather than its brightness — a fixed threshold is only valid at one progress, since the incoming clip dims everything as it fades in), a slide measured in two bands of the produced file (the leading band is the outgoing clip and the trailing band the incoming one at mid-transition — before this the file showed a hard cut and the left band read the incoming clip), the slide's `cover` and `reveal` modes told apart by *motion* rather than by a still (each clip carries a uniquely-coloured mark whose centroid is unchanged for the side that is meant to stay still — a single frame cannot separate the modes at all, since the area one clip vacates is exactly the area the other enters, which was verified by forcing the mode to `push` and watching an earlier version of the test still pass), a dissolve measured *per pixel* in the produced file (most pixels belong cleanly to one clip while both are present — a fade puts nearly every pixel in the blended band, which the test reproduces by reverting the transition to a fade), a wipe measured *per region* in the produced file (at half progress the revealed quarter is the incoming clip and the far quarter is still the outgoing one — a mean would not catch this, since an un-clipped stack averages the same), adjustment layers graded in the produced file (a clip below them comes out graded, a clip above them does not, and the grade lands on the composite rather than on each layer before blending — the three cases were each checked to fail against a deliberately broken renderer), volume keyframes reaching the produced mix at all (they were stored, graphed, and then dropped by the export: the plan carried them, the mixer's request type had no field for them and never read them, so a drawn volume line replayed the static level from end to end — the test compares a window early in a falling line against one late in it, and a fixture starting at zero cannot catch the more interesting half of the bug, which is that the times are item-local while the envelope is evaluated against timeline time, so a clip that does not start at zero would carry its whole volume line along with it), the anchor in the produced file (a half-scaled clip measures the same drawn size rotated and unrotated — the export bug above caught end to end — and an off-centre pivot displaces the bright centroid where a centred one does not, compared between two runs rather than predicted absolutely because the chain's capping makes an absolute position awkward to forecast), a hard audio cut measured by its largest sample-to-sample step in the produced mix (0.2645 without the taper against a 0.0198 bound — the clip's own slope plus the ramp's), export-time solo (every non-soloed track silenced while its video still renders), karaoke word resolution, updates, journal, binary integrity, releases, packaging; and the scrub-frame cache (SPEC 10 §5, SPEC 09 §6.4): that every request inside one 1/10 s grid cell resolves to the *same* file, which is the property the cache exists for — a pointer moves by pixels and a grid by tenths of a second, so without it a drag writes a file per event and reads none of them twice; that quantisation rounds *down* rather than to nearest, so the frame shown is the one at or before the instant asked for instead of one the playhead has not reached; that a request before the start or past the end clamps to a frame that exists, since asking ffmpeg for `start + duration` on a half-open range writes an empty file rather than failing; that the extraction time and the file name cannot disagree about the grid, because if they did every read would miss and the cache would be a slow way of writing files; that the in-point is subtracted, so scrubbing a clip ten seconds into the timeline reads its own frames rather than ten seconds into the file; that eviction keeps the frames nearest the *playhead* rather than the newest, because a scrub goes back and forth over one cut and evicting what is just behind it is the moment the cache is most needed; that a name that is not ours is left alone, so a stray file in the directory is not deleted; and that a directory that cannot be read, or a single deletion that fails, costs disk rather than an unhandled rejection in the main process |
| `apps/desktop/src/renderer` | 665 | Export dialog (including the caption styles it forwards), queue panel, update dialog, update notice and chip, recovery dialog, command palette, caption painter draw order, caption overlay resolution, caption list and word editor, caption style editor and its save-a-copy rule, project-local style store, clip inspector, preview geometry (jsdom), the preview's layer stack: overlay clips kept rather than dropped, paint order, opacity, blend modes including the `add`→`plus-lighter` mapping and keyframed opacity; transitions on screen: both clips drawn during a crossfade, neither during a fade-to-black's first half, and slide offsets; the inspector's transition control: disabled on a first clip, creating a transition against the right neighbour, switching type without adding a second, removing it, and writing length changes; and effects on screen: the CSS filter mapping, disabled effects skipped, adjustment layers folded into the layers they grade, and the §14 "can't be previewed" banner appearing for exactly the effects CSS cannot draw; the curve editor (§2.6): that only numeric properties are graphed (a colour key's RGBA tuple has no single y position), that keys are ordered however they were stored, that a constant value gets a window rather than collapsing onto an axis, that no series is drawn in the brand colour ("muted, never orange"), that an empty or unselected editor says so instead of drawing a blank graph, that handles appear only on a key with a following segment (easing governs the segment leaving a key, so the last key has none to shape), and that a dragged handle is written as a proportion of its segment on release with the other end left alone; and the effect chain's editing surface: reordering (including refusing a move off either end), copy/paste between clips with the paste disabled until something is copied, and the timeline menu's "Add adjustment layer"; the wipe's `clip-path` for every direction, checked against the export's mask so the two cannot drift apart about which side is revealed, the dissolve's pattern mask including that a non-finite progress cannot produce a `NaN` stop (which silently drops the mask), and the transition direction control: that it appears for a wipe and a slide, that each uses its own wording because the same word means opposite things in the two, that choosing one sends it as a merged param, and that a type with no direction does not get the control; and the slide's mode control: that choosing one sends it as a param, that an unset mode displays as `push` rather than blank, and that only a slide gets the control; and the command that stores those params: merged rather than replaced, removable by `undefined`, and left alone when the patch is about duration; and the inspector's keyframe controls (§2.4): the diamond on the opacity and volume rows recording the property's *current* value when it creates a key (so adding one never changes the picture), the diamond removing rather than stacking a key when the playhead is already on one, the write blocked with a reason when the playhead is outside the clip (half-open, so a key exactly on the clip's end is refused — it would never be seen), the ◀ ▶ jumpers skipping over a key underfoot and refusing to wrap at either end, and the legacy `transform.scale` field, which the compositor honours while both axes sit at their defaults: the inspector now shows the scale the renderer will actually apply rather than `scaleX` alone, which used to report 100% for a clip drawn at 150% and would have made a diamond on that row record the wrong value; the field is retired when a uniform scale is written, because a project carrying `{ scale: 1.5, scaleX: 1, scaleY: 1 }` otherwise snaps *back* to 150% the moment the user types 100% — verified against the real `effectiveScale`; and the two-axis form that replaces it when the axes differ, so a 120%-by-80% clip is never shown as one number; and auto-keyframing: an edit updating the key already at the playhead, inserting one when the playhead sits between keys, and staying a static edit when the property has no keys at all, so dragging a slider on a never-animated clip cannot start an animation by accident; and that neither the preview nor the export shifts a volume line's item-local times by anything other than the item's own start, which is what keeps them agreeing; and the remaining animatable rows: a diamond on scale, both position axes, rotation and all four crop edges, with the animatable-property list walked as a contract — every listed property must have a diamond in the rendered inspector *and* turn an edit into a keyframe when animated, so listing a property without wiring its row fails by name; position written as a fraction of the canvas while shown as a percentage, because the stored fraction means the same thing at proxy and export size; the single Scale field keying *both* axes rather than one — from the slider and from the row's own diamond, and removing both again when a click clears the key, since keying one of a pair the user set together would stretch the clip as the animation played; and the anchor crosshair (SPEC 10 §8.2): that it sits at the picture's centre by default and only on the selected clip, that dragging it writes the two anchor fractions and nothing else, that it starts an anchor drag rather than a move, and that the picture does not slide while the crosshair is being placed — the commit payload is what that last one checks, after an earlier version asserted the in-flight state instead and let a mutant through; and the anchor arm on a non-square canvas, where the two arms are fractions of different sides and rotating them in mixed units put the picture 270 px from where the pivot said it would be — with the square-canvas and centred-anchor cases pinned as the shapes that hid it; and aiming the crosshair through a transform: a pointer has to be carried back through the picture's rotation and scale to reach item space, since a bounding box has swapped axes once the clip is turned 90° — with the scale case documented as a regression guard rather than a discriminator, because pure scaling happens to survive box arithmetic and only rotation breaks it; and object snapping (SPEC 10 §8.10 §8.8): that the canvas centre and both edges are always targets, that every other item contributes its edges and centre, that a drag's own lines are tested three ways so an edge snaps flush rather than the centre being yanked, that the closest target wins rather than the first in range, that the snap fires exactly at the threshold and not a pixel past it, that a degenerate threshold declines to snap instead of accepting everything — the case that found a real bug, since every comparison against `NaN` is false and a `NaN` threshold silently accepted every candidate — and that a bounds calculation uses the axis-aligned box of a rotated item, converting the other axis out of its own fractions; measured end to end, where a 4 px drag on a 400 px canvas lands exactly on the centre line, `Alt` keeps it at 0.01, and a snapped drag that ends where it began commits nothing at all; and the overlay set (SPEC 10 §9): that safe areas start off, that `Ctrl+;` cycles title safe, action safe and platform zones and wraps back to nothing, that the platform stop is skipped on a landscape canvas where the chrome does not exist, that the safe area is drawn as a centred inset rectangle at the percentage the *data file* names rather than one the component knows, that the platform guide is three bands over the edges the chrome covers rather than one rectangle over the safe middle, and that thirds and the centre cross compose with an area overlay instead of replacing it; that the shipped `safe-areas.json` parses and that a reversed title/action pair, overlapping vertical bands or a percentage written as 14 rather than 0.14 are all rejected at load; that tuning the data file changes what is drawn, so the numbers really do live in the data; that the key handler never takes `;` from a text field; and that the export directory cannot name any of it — the structural form of §15's "overlays never appear in an export"; and seek coalescing (SPEC 09 §23): that a target arriving mid-seek replaces the one waiting rather than queueing behind it, that the newest of several targets is the one followed, that settling releases the held target so the picture converges, that a settle with nothing pending issues no spurious seek, that a cancel drops a stale scrub target, and that a hundred-target drag costs one seek in flight — measured end to end against a real `<video>` element, where restoring the previous per-event assignment produces forty seeks where there is now one; plus the threshold's own asymmetry, four frames while playing so a correction is never a hitch and half a frame while paused where a still is visibly wrong, both scaling with the project's frame rate; and the proxy preview path (SPEC 04 §7): that the preview plays the proxy when one exists, the original when none does, the original when the user has turned proxies off, and the original again when the proxy file has been deleted — with "no proxy" and "proxy gone" kept distinguishable, since they look identical from the outside and mean different things when a user reports editing is still slow; that the schema *declares* `proxyPath` rather than merely tolerating it through `.passthrough()`, that the importer actually writes it, and that a record from before the field existed still loads; and that a proxy cannot reach an export, both through the exporter's narrowed storage port and through a source-level guard that fails if the export directory ever mentions the proxy; and the `Shift`/`Alt` modifiers (SPEC 10 §8.2): that `Shift` locks a body drag to the dominant axis and that the same drag unmodified keeps both, that `Shift` snaps a rotation to a 15° step and that the cardinals fall out of the same rule rather than needing a second one, that a snapped rotation wraps into the model's closed range at both ends, that `Shift` toggles the corner handle from uniform to free scale with each axis solved in the picture's frame, that a free scale clamps rather than mirroring the picture, that a degenerate grab leaves its axis alone, that `Alt` holds the picture's centre still and so leaves a centred anchor's position untouched, and that `Alt` still compensates an off-centre anchor's arm — eight mutations, one per behaviour, each of which fails a test; and the corner grips (SPEC 10 §8.2): that four are drawn on the selected clip and only on it, that a corner drag commits both scale axes with the compensating position in one edit, that a non-uniform clip scales evenly rather than snapping to square, that releasing a corner in place writes nothing, that a drag along an edge still crops, and that the compensation is measured from the clip's own anchor and turned by its own angle — each of those last two added after a mutant showed the centred, upright-only tests could not see them; and the rotate handle (SPEC 10 §8.2): that straight up about the pivot reads as zero, that the angle increases *clockwise* because that is the direction the model stores (a sign flip would turn the picture against the pointer), that a quarter turn measures as a quarter turn, that the drag takes the short way across the ±180 seam — a pointer going from 170° to −170° has moved 20°, and the raw subtraction is −340° — and that a drag past a whole turn wraps rather than clamping, since clamping pins the clip while the handle keeps moving; and `Esc` (SPEC 10 §8.3): that it commits nothing, that it drops the in-flight preview so the picture goes back rather than staying where the pointer left it, and that the pointer coming up afterwards still writes nothing; and that the handle starts a rotate rather than a move — it stops propagation, because pointer-down on it would otherwise bubble to the layer and translate the clip as well as turning it; and the anchor rows joining the animatable list, which the contract test enforced by name the moment the two paths were added; and a rotate writing only the rotation, never a position, so one gesture edits one property; and a crop edge auto-keying independently of its three neighbours, because cropping one edge over time says nothing about the others; and on-canvas dragging (SPEC 12 Phase 4): that a horizontal drag is converted against the canvas *width* and a vertical one against its *height*, which is the only way the same pixel movement can mean the same fraction at any preview size — a raw pixel delta would move a clip twice as far on a small panel, and the test pins both sizes; that a clip cannot be dragged more than one canvas side off, with the clamp applied to the *result* rather than the delta so a drag past the limit and back resumes immediately instead of spending a hidden offset; that a crop drag moves only the edge under the pointer, that the sign of a right-edge drag is the opposite of a left-edge one (invisible in a symmetric fixture), that an edge stops short of its opposite rather than inverting the picture and leaves a sliver rather than a zero-width crop that would divide by zero downstream, and that a missing stored offset or crop is read as zero rather than becoming `NaN` and blanking the layer; the gesture itself: that a drag beginning on an edge writes crop and a drag beginning in the middle writes position — the two mutations that route every gesture to one of them each fail a different test — that a drag commits exactly once on release so it is one undo step rather than forty, that a click that ends where it started commits nothing, and that the picture follows the pointer before anything is written to the document; and that a canvas drag follows the *same* auto-keyframing rule as the sidebar, through the same function: moving a clip whose position is already animated updates the keys on both axes when the playhead sits on one, inserts at the playhead's own local time when it sits between them, and writes the static value when the clip has no position keys at all — with the mutation that routes every drag to the static write failing both keyed cases; and the snap guides (SPEC 10 §8.8): that a canvas fraction becomes a percentage measured from the top-left rather than the centre the fraction is stored against, since a line drawn half a canvas out is worse than no line at all, and that when both axes are unsnapped nothing is drawn, so an idle selection never shows stale lines; that each axis draws its own line independently of the other; that the line sits on the target it names; and that a snapped drag *shows* one while a released drag no longer does, with `Esc` and a held `Alt` each leaving none behind — four mutations, one per behaviour, the `Alt` case proving a guide cannot claim a pull the modifier suppressed; and the *Show anchor* toggle (SPEC 10 §8.2, `A`): that the pivot crosshair is on when the preview opens rather than hidden behind a key nobody presses; that `A` hides it and `A` again brings it back, uppercased too since the toggle is the key and not the character; that hiding the crosshair leaves the selection outline and the corner grips where they were — the mutant that hid the whole selection with it is the one this catches, and it would have made the clip undraggable while looking like a no-op; that `A` typed into a field is a letter rather than a command; that `Ctrl+A` stays the timeline's select-all; and that a held key does not flicker the crosshair at the keyboard's repeat rate; and the guides' distance label (SPEC 10 §8.8): that the number is the snap's *own* displacement in preview pixels, which is the only distance the event itself defines and is what answers "how much did it just jump?" as the line appears; that it rounds to whole pixels because sub-pixel precision is not information anyone acts on mid-drag; that a zero is *dropped* rather than shown, since sliding along a line re-snaps to it at zero distance for most of a drag and a pinned `0 px` reads as a stuck overlay rather than as alignment; that the distance is unsigned, the line already saying which way the item came from; that a non-finite canvas size cannot print `NaN px` over the picture; that a corner drag shows both axes' numbers, since one would understate what happened; and that the label refreshes when the distance changes while the line does not — the state a drag is in for its whole approach once a snap is caught — a mutant that compared only the target position freezing the number at its first reading | and equal-spacing hints (SPEC 10 §8.8): that the item is moved by *half* the difference between its two gaps so it ends up centred in the space rather than flush against the larger one, with the expected delta and gap derived from the geometry rather than read off a run; that the hint's two spans are measured from the item's **moved** edges, since a span taken from the unmoved edge would draw two different lengths and defeat the one claim the hint makes; that a gap already existing between two neighbours can be matched from outside the pair, on both sides; that a difference too large to be a nudge is refused, so a clip is never yanked across the canvas; that a `NaN`, zero or negative threshold refuses everything, the guard that has now caught three separate bugs; that a neighbour with no width is ignored, a non-finite item declines, and the nearest candidate wins over the first found; that the spans draw with the same centre-to-top-left shift the guide lines use and a right-to-left span is normalised, since a hint half a canvas from the gap it describes is worse than none; and that the precedence rule is a testable predicate rather than an `if` in the gesture — a line that caught wins, `Alt` suppresses both, and a result carrying a position but no target still permits spacing, which is precisely the inversion that shipped first: the guard read `snapped.x.position`, which `snapAxis` never returns null for, so every spacing correction was computed and then silently discarded by the commit. Measured end to end on a three-clip fixture whose equal spacing sits clear of the canvas centre — the first attempt put it on the centre line, where a snap caught first by design and the test never reached the spacing path at all — where the hint appears within the threshold, the commit lands on the equal spacing rather than near it, a zero-delta spacing still draws (the bars *are* the confirmation, unlike the guide label's zero), nothing draws before the pointer moves, and both releasing and `Esc` take the hint away — the `Esc` case finding that `cancel()` had cleared the guides but not the spacing | and snapping to the rule of thirds (SPEC 10 §8.8, §9): that each composition line is shifted from the top-left to the centre, the same conversion the safe areas need and the reason it is a function rather than a subtraction at each call site; that a non-finite line is dropped instead of becoming a target at `NaN`, which accepts nothing and looks like a snap that never fires; and that the lines are labelled `grid-line` so a guide does not point at a neighbour that is not there; measured end to end, where a 130 px drag on a 400 px canvas commits the raw 0.325 with `Ctrl+'` off and the first third's exact 1/3 with the lines showing — the mutant that offered them regardless of visibility is what that pair catches | and snapping to a visible overlay's edges (SPEC 10 §8.8, §9): that an overlay rect measured from the top-left becomes centre-relative lines, with the half-canvas shift done once — the same trap from the other side, and the one that puts every safe-area snap half a canvas out; that the vertical axis reads the rect's *height* and the horizontal its width, so a platform band is not snapped to as if it were square; that a rect with any non-finite field offers nothing, since a line at `NaN` silently accepts nothing and looks like a snap that never fires — a `NaN` height slipped past a guard that only checked the two fields the chosen axis read; and that the lines follow `assets/safe-areas.json` rather than a hard-coded 0.45, so retuning the data moves the guide and the snap together; measured end to end, where an 18 px drag on a 400 px canvas commits the raw 0.045 with the overlay off and the safe-area line's 0.05 with title safe showing, and the guide it draws is labelled `safe-area-edge` rather than `item-edge` — a clip sticking to the title-safe box must not send the user looking for a neighbour that is not there | the timeline filmstrip (SPEC 09 §19): that each tile is asked for its *own* frame rather than one poster repeated across the clip — the whole reason a filmstrip exists is to show where a cut lands, and a strip of one frame cannot; that the tile count rounds up so the last partial tile is drawn rather than leaving a bare gap at the clip's end; that a tile still loading is skipped instead of drawing a neighbour's frame, since a repeated frame reads as a still clip and that is a worse lie than a gap; that each tile lands at its own x in order and the final one is clipped to the strip rather than overhanging the trim handle; and that a zero-width strip asks for no frames at all, which is the first paint of every clip being added |
| `packages/ai-core` | 120 | Provider clients, scoring, connectivity |
| `packages/update-core` | 177 | Version rules, manifest verification, signatures, update state machine, journal and recovery text, yt-dlp updater rules |
| `packages/timeline-engine` | 168 | Commands, invariants, undo/redo, caption editing (§11 §2.5), item properties and their validation, and the curve editor's write path: bezier handles stored on a keyframe, handle x clamped to 0–1 while y is free to overshoot so ease-back stays expressible, setting handles also switching the key to bezier interpolation (storing them on a linear key would leave them ignored and the edit would silently do nothing), and a refusal when there is no key at that time (§09 §17) |
| `packages/audio-core` | 48 | The gain envelope: dB conversion, fade curves, keyframe interpolation and easing, and the preview/export agreement that SPEC 10 §7.1 requires |
| `packages/media-core` | 11 | Probing, peaks, path resolution |
| `packages/project-schema` | 8 | Schema validation and migration |
| `packages/design-system` | 4 | Component contracts |
| **Total** | **2244** | 93 files |

### Tests that run real processes

These are not mocks, and that distinction matters — a test that fakes ffmpeg
cannot tell you whether the ffmpeg arguments are right.

| Test file | Runs |
|---|---|
| `__tests__/ffmpeg-runner.test.ts` | Bundled `ffmpeg`/`ffprobe`: probing, decoding, loudness, black/freeze detection |
| `__tests__/export-runner.test.ts` | A complete encode end to end, then validates the produced file |
| `__tests__/export-service.test.ts` | Real footage through the service: published file, audio stream, temp cleanup |
| `__tests__/audio-mixer.test.ts` | Real PCM decoding, mixing, EBU R128 measurement, normalisation |
| `__tests__/decode-frame-source.test.ts` | Per-item decoders over real clips, plus layered exports decoded back and measured channel by channel |
| `__tests__/release-roundtrip.test.ts` | The real signing script, verified with the app's own verification code |
| `__tests__/smoke-test.test.ts` | The real bundled binaries, reporting their real versions |

Bundled tooling in this environment is **ffmpeg 4.1** (a 2018 build). That is a
deliberate constraint: if the code works on the oldest build we might ship, it
works on newer ones. Capability detection (`-vsync cfr` vs `-fps_mode`) exists
because of it.

### The geometry filter chain, checked against real ffmpeg

Crop, scale, rotation, offset and flip are built as an ffmpeg filter chain
(`sourceFilterChain`), and a chain that *looks* right can still be rejected by
ffmpeg or silently misplace the picture. Three bugs were found by running the
generated chains against the bundled binary rather than by reading them:

| Chain | What went wrong | Fix |
|---|---|---|
| scaled | `pad` refuses to shrink a picture larger than its canvas — it failed with `Input area … not within the padded area` | cap each axis with `crop=w='min(iw,W)':h='min(ih,H)'` before the pad |
| rotated | `rotate` emits a bounding-box canvas larger than the output for any angle between 0 and 90°, so the following pad failed the same way | fit to the canvas after the rotate, then pad |
| plain (no geometry at all) | `force_original_aspect_ratio=decrease` rounds **up**, so a 9:16 crop of a 16:9 source came out 1082 px wide; the pad then tore one column off the left and two off the right | the same cap, applied to every `fit` chain |

Ten chains (plain, crop, zoom in, zoom out, legacy framing scale, 90° and 33°
rotation, offset, flip, all combined) were each run through ffmpeg 4.1 on a
1280×720 source and produced exactly 1080×1920 `yuv420p` raw frames — 3 110 400
bytes apiece, with no stderr. A solid red source was then sampled pixel by pixel
to confirm the picture is centred: the plain path fills the frame with no black,
and a letterboxed crop leaves one black column on the left and two on the right,
which is the odd-pixel remainder of an aspect fit rather than the torn edge the
uncapped chain produced.

---

### Blending and colour, checked against real ffmpeg

Layering is composited in software (`packages/compositor/src/composite.ts`) because
the export has raw `yuv420p` frames rather than a DOM. Every blend mode was checked
against the W3C compositing spec's closed form, and the two ends of the pipeline
were measured against the bundled binary. Three findings changed the design:

| Finding | Consequence |
|---|---|
| `blend`'s `all_expr` **silently overrides** `all_mode` — a `multiply` graph and a `normal` graph produced byte-identical output when both also carried an `all_expr` | a mode and an opacity need two separate `blend` stages, never one |
| ffmpeg 4.1's expression language has no blend functions (`multiply(A,B)` → `Unknown function`) | a mode cannot be expressed as an expression at all, so `all_mode` is the only way to get one |
| `-colorspace bt709` only **tags** the output; swscale still converts with **BT.601** by default. Converting RGB→YUV with no `scale` filter gave Y=100 for a colour whose BT.709 luma is 83 | every comparison forces `scale=in_color_matrix=bt709:out_color_matrix=bt709`, and the compositor takes the matrix as an argument instead of assuming one |

A fourth finding came from a test rather than from ffmpeg: fading a *bottom* layer
toward black is correct only when the canvas is black, so a project on a white
canvas exported a frame half as bright as the preview. Every layer is now
composited onto the canvas colour instead, which also means a bottom layer's own
blend mode behaves like any other layer's rather than being ignored.

The compositor's RGB→YUV conversion matches ffmpeg's to within ±3 levels of luma
and ±8 of chroma on a three-colour test card; decoding ffmpeg's own BT.709 and
BT.601 frames comes back within ±4 levels of the original colour.

## 2. Static checks

| Command | Result |
|---|---|
| `pnpm typecheck` | Passes across all 10 packages |
| `pnpm lint` | Design-token audit: 0 hard-coded hex colours, px radii or ms durations in renderer UI |
| `pnpm lint` | No-fakes & determinism audit: passes (no `Math.random()`/`Date.now()` in engine packages, no banned claims) |
| `pnpm --filter @clipwright/desktop build` | Renderer + main + preload build; the main bundle loads under a stubbed Electron |

---

## 3. Export engine (SPEC 14)

### Verified by automated tests

| Behaviour | Evidence |
|---|---|
| Plan is deterministic for the same input | `planId` is FNV-1a over the settings; tests assert stability |
| Encoder arguments match the spec for each combo | `encoder.test.ts`, 231 cases including codec × rate control × hardware |
| Hardware encoders are tested, not assumed | `validateHardwareEncoders` runs a real encode; a candidate that fails is skipped |
| Frame pipeline respects back-pressure | `export-runner.test.ts` writes to a pipe and handles EPIPE |
| Cancellation stops the encoder process | Test asserts the child is gone and the partial file removed |
| The published MP4 really contains the source footage | `export-service.test.ts` exports a moving-bar clip with no frame-source override |
| The published MP4 really contains audio | `export-service.test.ts` exports a tone and asserts the audio stream via ffprobe |
| Audio normalisation lands near −16 LUFS | `audio-mixer.test.ts` measures with ebur128 after gain |
| The limiter holds a −1 dBTP ceiling | `audio-mix.test.ts`, including a deliberately hot mix |
| The limiter is O(n) | A 10-minute clip limits in linear time (the naive version was quadratic) |
| Validation checks 13–14 measure the *produced file* | `export-runner.test.ts` asserts the measured values, not the target values |
| Name clashes never overwrite silently | `export-service.test.ts` asserts `clash 2.mp4` exists alongside `clash.mp4` |
| The temp mix WAV is deleted after publishing | `export-service.test.ts` asserts the cache directory is empty |

### NOT verified

| Gap | Why, and what it needs |
|---|---|
| **Preview and export are not one renderer.** §10 §2.1 asks for a shared WebGL2 `renderFrame`; this build has a CPU compositor for the export and CSS for the preview | The *export* renders captions (generated ASS script), keyframed geometry (per-keyframe segments), layer opacity and blend modes (software blend in linear light), transitions (both clips across the overlap) and the nine required effects — each measured in the produced file by decoding it. The *preview* approximates the effects with CSS filters and names the three it cannot draw. Recorded as `docs/limitations.md` item 7. |
| Frame blending | Not implemented; nearest-time selection is used and documented |
| Hardware encoding on real GPUs | No GPU in this environment. The *validation* logic is tested with fakes; actual NVENC/QSV/AMF output is unverified |
| 4K 60 fps performance | Not benchmarked here; the code path is tested at 320×180 |
| Resumable export | Not implemented (SPEC 14 §9); a failed export restarts |

**Honesty note (fixed while writing this report):** the export dialog previously
said nothing about the compositing gap, so a user who added a title and exported
would only discover the omission by watching the finished file. It now says so
before the export runs, and `export-panel.test.tsx` fails if that note is
removed. `docs/export.md` lists the same limits.

---

## 4. Updates (SPEC 15)

Verified by `update-service.test.ts` (36 tests), `update-core` (135 tests),
`update-journal-store.test.ts` (21), `bin-integrity.test.ts` (11),
`recovery-dialog.test.tsx` (10) and `update-notice.test.tsx` (11):

| Behaviour | Evidence |
|---|---|
| A release with no signature is refused | Test |
| A release signed by an unknown key is refused | Test |
| A manifest edited after signing is refused | Test |
| `latest.yml` disagreeing with the signed manifest is refused | Test |
| A redirect off `github.com` is refused before download | Test |
| A download whose hash does not match is deleted | Test asserts the file is gone |
| Nothing downloads or installs without an explicit action | State-machine tests |
| A build with no embedded key refuses every update | Test — fails closed |
| The CI script's signature verifies with the app's code | `release-roundtrip.test.ts`, real keys |
| The CI script refuses when the secret and embedded key disagree | `release-roundtrip.test.ts` |
| A binary that changed on disk is **disabled**, not run | `bin-integrity.test.ts` asserts the expected and actual digests and that the tool is not enabled (§6.1) |
| A missing or corrupt `checksums.json` reads as unverified, never as fine | `bin-integrity.test.ts` |
| A cancelled install does not send the user to Recovery | `journal.test.ts` — §11, the user is still on the old version |
| One workspace failure does not trigger recovery; the second does | `journal.test.ts`, `update-journal-store.test.ts` (§7.3) |
| A crash state survives to the next launch | `update-journal-store.test.ts` reads it back with a fresh store |
| A corrupt journal is moved aside rather than blocking every launch | `update-journal-store.test.ts` |
| The journal is written atomically | Test asserts the temp-file write and rename |
| Backups copy only the small files, and a failed copy is reported not fatal | `update-journal-store.test.ts` (§7.1) |
| A truncated installer is not cached as a rollback path | `update-journal-store.test.ts` — under 1 MB is refused |
| Cleanup keeps the newest backup until the next success | `update-journal-store.test.ts` (§7.6) |
| The recovery text warns that a migration also rolls back databases | `journal.test.ts` on `recoveryMessage` (§7.5) |
| The update dialog cannot install before backups are taken | `update-service.test.ts` — a failing `prepareInstall` aborts the install |
| The chip and dialog are actually mounted | `update-notice.test.tsx`; the snapshot is reachable from `App` |
| Ctrl+K, Ctrl+N, Ctrl+, and Ctrl+/ do what the cheat sheet says | `command-palette.test.ts` drives the real dispatch handler; `shortcut-sheet.test.tsx` covers the sheet |
| Shortcuts that are listed but not implemented say so | `shortcut-sheet.test.tsx` — Ctrl+O and Ctrl+S are marked rather than implied |
| An export's history row is written before `whenIdle()` resolves | `export-service.test.ts` — a race that made history intermittently miss the export that had just finished |
| A portable build refuses to install its own update, and says to swap the file | `update-service.test.ts` (§6.3); the guard sits before preparation so no journal entry claims an install started |
| A download resumes from a `.part` file left by an interrupted run | `update-service.test.ts` asserts the `Range` header and a byte-identical result (§11) |
| A resumed download is discarded when the server ignores Range | `update-service.test.ts` — a 200 response drops the prefix rather than concatenating it |
| A `.part` file bigger than the installer is ignored | `update-service.test.ts` |
| An offline machine says "check your internet connection", not "couldn't be completed" | `state.test.ts` on the real `TypeError: fetch failed` shape, including the reason hidden in `cause` (§11) |
| A file held open by antivirus maps to the security-software wording | `state.test.ts` — EBUSY (§11) |
| yt-dlp updates are checked weekly, not on every launch | `ytdlp.test.ts`, clock injected (§9) |
| A manual yt-dlp check ignores the weekly schedule | `ytdlp-service.test.ts` asserts the network is called |
| A yt-dlp download whose digest is wrong cannot displace a working binary | `ytdlp-service.test.ts` reads the old file back byte-for-byte |
| An unverified or older user copy never shadows the bundled one | `ytdlp.test.ts` on `chooseYtDlpBinary` |
| A refused yt-dlp download never asks for a backup | `ytdlp.test.ts` — `keepBackup` is false on failure |
| yt-dlp is installed into user data, never the install directory | `ytdlp-service.test.ts` asserts the bundled file is unchanged (§9) |
| "Restore bundled version" refuses to remove the only working binary | `ytdlp-service.test.ts` |

### NOT verified

| Gap | Why |
|---|---|
| CI has passed on Windows | **Yes, run 42442804025** on `windows-latest`: install from the lockfile, `pnpm verify` (lint, typecheck, 1090 tests, both bundles, `check-repo`), the third-party-notice check, the launchable-package check and the gitleaks scan — every step green. This was the first green run: before it, `ci.yml` had never executed at all, because two pinned action SHAs resolved to no commit |
| CI catches Windows-only breakage | That green run is the evidence, not the claim: the first executions found six defects that Linux could not (three path-handling bugs in the checks and tests, two ffmpeg-dependent suites with no platform guard, and a line-ending assumption), each now fixed |
| A packaged Windows installer has been produced | No installer exists here: `electron-builder` needs the Electron binary and the Windows toolchain, and neither can be downloaded in this environment (`Cannot compute electron version from installed node modules`). The app bundle itself is built and verified; the packaging step after it never ran |
| `electron-builder` has ever completed | **Never, in any environment.** It now gets as far as reading the config (`loaded configuration … electron-builder.yml`) and pinning `electronVersion=34.2.0`, then fails cross-compiling `better-sqlite3` from Linux — `node-gyp does not support cross-compiling native modules from source`. The release workflow runs on `windows-latest`, where that step is native, so the configuration is no longer what stands in the way; the Windows toolchain is |
| A real GitHub release, end to end | No published release exists yet; the tests use a fake network with real cryptography |
| `electron-updater` driving an actual download | `electron-updater` is injected and faked in tests; the real library is exercised only in a packaged build |
| Installing an update and relaunching | Needs Windows and a published release |
| The embedded key is a placeholder | Updates are **refused** by design until a real key is embedded |
| `resources/bin/checksums.json` does not exist | The runtime verifier is tested with fixtures; the real file cannot be produced here because the binaries cannot be downloaded (see §5) |
| The Recovery window has not been seen in a running app | Rendered under jsdom with every state; the main-process wiring around it is unit-tested but has never run inside Electron |
| The 60-second boot confirmation has not timed out in a real launch | The state machine and the timer are tested with a fake clock; nothing here has waited 60 seconds for real |
| yt-dlp has never been downloaded from GitHub here | The service is tested against a fake network holding real SHA-256 digests; no real release asset was fetched or executed |
| The yt-dlp version reported in Settings has not been read from a real binary | `readVersion` runs `yt-dlp --version`; in tests it is injected, because the bundled files here are Linux symlinks |

---

## 5. Packaging and release (SPEC 15)

| Check | Result |
|---|---|
| `electron-builder.yml` parses, 12 top-level keys, no duplicates | Checked |
| `assets/icon.ico` has 16/24/32/48/64/128/256 px frames | Verified by parsing the ICO header |
| Every script a workflow runs is tracked by git | `scripts/check-repo.mjs`, in `pnpm lint` — written after nine release scripts turned out to be outside the repository |
| Ignore rules cannot swallow source | Same check: an unanchored `release/` pattern is rejected by name |
| In-window navigation is decided by URL origin, not by prefix | `security.test.ts` — `http://localhost:5173@evil.example/` is blocked; the dev origin is accepted only in a development build (§12.12) |
| A packaged build trusts only its embedded key, whatever the environment says | `update-config.test.ts` — the override is honoured for tests and local builds, ignored when `app.isPackaged` (§5) |
| A build with no embedded key refuses every update | `update-config.test.ts` — `hasUsableKeys` is false for the shipped placeholder |
| A redirect to a look-alike host is refused | `update-config.test.ts` — `github.com.evil.example` is rejected; the check compares hostnames, not substrings |
| The unsigned notice is on every surface §6.4 names | `check-repo` asserts it in README, the update dialog, the release-notes generator and the release docs (acceptance item 10's automated string check) |
| Generated release notes carry the unsigned notice | The generator appends it, and drops it only when `--signed` is passed after a certificate was used |
| Every relative documentation link resolves | Same check, 17 documents |
| No module is reachable only from its tests | `check-repo` — written after `main/ipc.ts` turned out to export six shortcuts with empty handlers that only a test could reach |
| The renderer imports no main-process code | Same check, added after two modules had drifted across the boundary |
| No renderer dependency reaches a `node:` builtin | Same check, following the import graph including workspace packages. Added after the production build failed on `node:crypto` while 1063 tests and `tsc` passed |
| **The application actually builds** | `pnpm build` produces `dist/main/index.cjs` and `dist/renderer/index.html`; `pnpm verify` runs lint, typecheck, tests, build and the repo check in that order |
| The signed manifest verifies with only the embedded key | Rehearsed end to end outside CI with a fresh key pair over real files: signature, per-file digests, `SHA256SUMS.txt`, `latest.yml` cross-check, and a single flipped byte rejected |
| Main process builds to `dist/main/index.cjs` | Yes; 561 KB across 12 files, loads under stubbed Electron |
| Renderer uses relative URLs (`file://` safe) | `index.html` references `./assets/...` |
| `assert-package.mjs` catches a package with no installer | Yes — exits 1 on this checkout, naming the missing artefacts |
| `assert-package.mjs` catches a package missing its native module | Yes — proven against a synthetic package tree: a stripped `better-sqlite3`, a missing `app.asar.unpacked`, and a corrupt asar each exit 1 with a specific message; the healthy tree passes |
| `verify-binaries.mjs` catches unpinned hashes | Yes — exits 1, naming all three binaries and the missing `checksums.json` |
| `extract-notes.mjs` produces notes from the CHANGELOG | Yes; refuses a version that has no section |
| `make-manifest.mjs` signs and self-verifies | Yes, with real keys over real files |
| Release scripts are actually in the repository | Yes — and this was **not** true before: an unanchored `.gitignore` pattern (`release/`) excluded all nine of them. `scripts/check-repo.mjs` now fails if a workflow references an untracked script. |
| `gen-update-key.mjs` generates a usable pair | Yes |
| **The whole chain end to end with a real key** | Rehearsed: generated a key pair, built fake artefacts, extracted the CHANGELOG notes, signed the manifest, then verified the output with the app's own code — signature, both digests per file, `SHA256SUMS.txt`, `latest.yml` cross-check, and rejection of a single flipped byte. |

### NOT verified

| Gap | Why |
|---|---|
| **A real Windows installer was never built here.** | This environment is Linux. electron-builder's NSIS target needs Windows (or Wine). The configuration, the build pipeline and the assertions are all in place and tested on Linux up to the point where Windows is required. |
| **`resources/bin` holds Linux symlinks and no pinned hashes.** | `verify-binaries.mjs` refuses to package them, correctly. Real Windows binaries must be fetched and their digests reviewed. |
| Install → launch → export → uninstall on a clean VM | Needs Windows; `smoke-install.mjs` implements the steps but skips off Windows |
| Code signing | No certificate; everything says "unsigned" |

---

## 6. User interface

Renderer tests run in jsdom with Testing Library (137 tests). What that covers
and what it does not:

| Covered | Not covered |
|---|---|
| The update dialog shows the unsigned notice | Pixel-level layout |
| "Install and restart" is absent before verification | Real Electron window behaviour |
| The export dialog assembles the right plan | Drag interactions in the editor |
| The queue panel distinguishes active from queued jobs | Screen readers (no automated a11y suite) |
| Progress reflects reported values, not animation | — |

No Playwright browser binaries are available in this environment, so there is no
end-to-end UI test here. `pnpm test:e2e` is wired up for an environment that
has them.

---

## 7. How to reproduce

```bash
corepack enable && pnpm install
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm --filter @clipwright/desktop build
node scripts/release/assert-package.mjs    # expected to fail without Windows packaging
node scripts/release/verify-binaries.mjs   # expected to fail until binaries are pinned
```

The last two failing is the current, correct state: they fail for real reasons
that are listed above, not because they are stubs.
