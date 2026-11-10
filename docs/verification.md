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
Test Files  130 passed (130)
     Tests  3231 passed (3231)
```

| Area | Tests | What they actually check |
|---|---:|---|
| `packages/export-core` | 396 | Encoder arguments, plan determinism, validation rules, the transition-link resolution the mixer needs (an outgoing clip picks up the transition it leaves through, clips separated by a gap are not linked, a middle clip in a run gets both, and the `crossfadeAudio` flag survives the plan), audio mix DSP including the equal-power crossfade (§4.2: the two half-cosine sides sum to one in *power* at every progress, the midpoint is 1/√2 rather than the 0.5 a linear fade gives, the window composes with an item's own fades rather than replacing them, and a window running off either end of the clip is shaped where it overlaps and ignored where it does not, and the 2 ms raised-cosine de-click (SPEC 12 §12 item 8): the envelope starts and ends at zero, is symmetric between the two ends, shortens rather than overflowing on a clip shorter than two ramps, shapes the head and the tail independently, leaves an unshaped side bit-identical, and — measured rather than restated — moves no sample by more than half of `π/2N` per step), presets, the ASS caption script (field order, colour byte order, anchor mapping, karaoke timing, range shifting), and the decode filter chain: crop, scale, rotation, offset and flip, with every stage kept even-sized and landing on the exact output size, and the keyframe segmenter: boundaries, merging equal neighbours, the segment cap; and the rotate stage, which no longer refits the rotated picture to the canvas — a refit there discarded the user's scale entirely, measured at 360×360 unrotated against 480×720 rotated for a half-scaled square, with the cap now doing the shrink a `pad` cannot and clipping being the honest result for a clip that turns past the frame edge |
| `packages/compositor` | 398 | Text layout (wrapping, alignment, word rectangles, background boxes, karaoke timing, every preset at four aspect ratios), the frame builder: karaoke sweeps, word-by-word hiding, keyword emphasis, palette cycling, in/out animation, per-word pop, and item geometry (crop rectangles, per-axis and legacy scale, flips, offsets) and the keyframe evaluator: holding outside the key range, hold segments, cubic-bezier and preset easing, duplicate timestamps, and bezier handles read back end to end with *asymmetric* control points — the existing symmetric pair reads 0.5 at the midpoint, exactly what linear gives, so a regression that dropped handles would have passed it; layer resolution and blend modes (which layers are visible, ordering, opacity clamping); software compositing: every blend formula against its closed form, opacity mixing toward the backdrop rather than black, layer ordering, and YUV↔RGB conversion checked against the bundled ffmpeg in both directions and in both colour matrices; and transition timing: window placement for all three alignments, the 0→1 ramp, easing, each type's shape (crossfade opacities summing to one, fade-to-black genuinely reaching black, slide endpoints, zoom scaling); and the wipe's geometry: the edge position at each progress, that nothing is revealed at 0 and everything at 1, a ramp whose width matches the softness and stays symmetric about the edge, unit normals for all six directions, and that a wipe reports a shape rather than a fade; and the dissolve: that its noise is deterministic, seed-dependent, bounded, smooth between neighbours and the same at any resolution, that pixels switch rather than blend, that the switched fraction tracks the progress (the raw field is bell-shaped, so a quantile mapping is needed or the transition stalls at both ends), and that the other transitions carry no dissolve shape; and the slide: that both pictures move, that the vertical directions move vertically rather than falling back to horizontal, that the two clips stay exactly one frame apart at every progress, which way the strip travels, and its three `mode`s — `push` moving both pictures, `cover` leaving the outgoing clip at a zero offset, `reveal` leaving the incoming clip still and reporting the moving edge that uncovers it, with the diagonal of the reported wipe normal checked against the region the outgoing clip has actually vacated so the reveal cannot travel the wrong way; the transition composites themselves: that a shifted layer keeps what is underneath where it no longer covers (which is what makes a push a push), moves vertically as well as horizontally, honours opacity and contributes nothing when entirely off frame, and that a scaled layer enlarges about the centre, shrinks leaving a border, passes a scale of 1 through untouched and treats a zero, negative or non-finite scale as no scaling; and the effect catalogue: parameter ranges and clamping, chain order, the spec's two numeric criteria (`+1` stop doubles linear values, saturation 0 is Rec.709 luma), contrast pivoting on 0.18 linear, and a Gaussian blur checked tap by tap against the textbook kernel; and the anchor point (SPEC 10 §4, §8.2): that it is a no-op at the picture's centre for every angle, so projects saved before it existed render unchanged; that an off-centre anchor swings the picture around itself, with the corner cases checked against closed forms; that scale applies *before* rotation as the spec's transform order requires, pinned at 37° where the two orders disagree — the first version of that expectation was garbled and the implementation was right; that the anchor is keyframeable; and that an off-centre anchor is not an identity, since it moves the picture; and adjustment-layer resolution (SPEC 12 §3.1): which are live at an instant, the half-open time window, disabled and hidden ones skipped, an empty chain skipped, ordered bottom-first, and the "only the tracks below" rule including the ambiguous same-track case |
| `packages/caption-styles` | 37 | The `.cwstyle` schema, migrations, unknown-field preservation, style resolution, contrast and the documented examples |
| `apps/desktop/src/main` | 401 | Export service, queue, ffmpeg orchestration, audio mixing, keyframed segmentation over real footage, and layer compositing measured in the produced file, linked audio measured by Goertzel energy in the produced mix (during a crossfade both clips' tones are present in a window that straddles the cut, and the incoming one is audible before its own start — a plain cut cannot produce either, and measuring loudness instead would fail to tell them apart because an *equal-power* crossfade deliberately keeps the summed level flat), a zoom measured by the width of a box on a scanline in the produced file (1.3× at half progress, with the box detected by its neutrality rather than its brightness — a fixed threshold is only valid at one progress, since the incoming clip dims everything as it fades in), a slide measured in two bands of the produced file (the leading band is the outgoing clip and the trailing band the incoming one at mid-transition — before this the file showed a hard cut and the left band read the incoming clip), the slide's `cover` and `reveal` modes told apart by *motion* rather than by a still (each clip carries a uniquely-coloured mark whose centroid is unchanged for the side that is meant to stay still — a single frame cannot separate the modes at all, since the area one clip vacates is exactly the area the other enters, which was verified by forcing the mode to `push` and watching an earlier version of the test still pass), a dissolve measured *per pixel* in the produced file (most pixels belong cleanly to one clip while both are present — a fade puts nearly every pixel in the blended band, which the test reproduces by reverting the transition to a fade), a wipe measured *per region* in the produced file (at half progress the revealed quarter is the incoming clip and the far quarter is still the outgoing one — a mean would not catch this, since an un-clipped stack averages the same), adjustment layers graded in the produced file (a clip below them comes out graded, a clip above them does not, and the grade lands on the composite rather than on each layer before blending — the three cases were each checked to fail against a deliberately broken renderer), volume keyframes reaching the produced mix at all (they were stored, graphed, and then dropped by the export: the plan carried them, the mixer's request type had no field for them and never read them, so a drawn volume line replayed the static level from end to end — the test compares a window early in a falling line against one late in it, and a fixture starting at zero cannot catch the more interesting half of the bug, which is that the times are item-local while the envelope is evaluated against timeline time, so a clip that does not start at zero would carry its whole volume line along with it), the anchor in the produced file (a half-scaled clip measures the same drawn size rotated and unrotated — the export bug above caught end to end — and an off-centre pivot displaces the bright centroid where a centred one does not, compared between two runs rather than predicted absolutely because the chain's capping makes an absolute position awkward to forecast), a hard audio cut measured by its largest sample-to-sample step in the produced mix (0.2645 without the taper against a 0.0198 bound — the clip's own slope plus the ramp's), export-time solo (every non-soloed track silenced while its video still renders), karaoke word resolution, updates, journal, binary integrity, releases, packaging; and the scrub-frame cache (SPEC 10 §5, SPEC 09 §6.4): that every request inside one 1/10 s grid cell resolves to the *same* file, which is the property the cache exists for — a pointer moves by pixels and a grid by tenths of a second, so without it a drag writes a file per event and reads none of them twice; that quantisation rounds *down* rather than to nearest, so the frame shown is the one at or before the instant asked for instead of one the playhead has not reached; that a request before the start or past the end clamps to a frame that exists, since asking ffmpeg for `start + duration` on a half-open range writes an empty file rather than failing; that the extraction time and the file name cannot disagree about the grid, because if they did every read would miss and the cache would be a slow way of writing files; that the in-point is subtracted, so scrubbing a clip ten seconds into the timeline reads its own frames rather than ten seconds into the file; that eviction keeps the frames nearest the *playhead* rather than the newest, because a scrub goes back and forth over one cut and evicting what is just behind it is the moment the cache is most needed; that a name that is not ours is left alone, so a stray file in the directory is not deleted; and that a directory that cannot be read, or a single deletion that fails, costs disk rather than an unhandled rejection in the main process |
| `apps/desktop/src/renderer` | 1247 | Export dialog (including the caption styles it forwards), queue panel, update dialog, update notice and chip, recovery dialog, command palette, caption painter draw order, caption overlay resolution, caption list and word editor, caption style editor and its save-a-copy rule, project-local style store, clip inspector, preview geometry (jsdom), the preview's layer stack: overlay clips kept rather than dropped, paint order, opacity, blend modes including the `add`→`plus-lighter` mapping and keyframed opacity; transitions on screen: both clips drawn during a crossfade, neither during a fade-to-black's first half, and slide offsets; the inspector's transition control: disabled on a first clip, creating a transition against the right neighbour, switching type without adding a second, removing it, and writing length changes; and effects on screen: the CSS filter mapping, disabled effects skipped, adjustment layers folded into the layers they grade, and the §14 "can't be previewed" banner appearing for exactly the effects CSS cannot draw; the curve editor (§2.6): that only numeric properties are graphed (a colour key's RGBA tuple has no single y position), that keys are ordered however they were stored, that a constant value gets a window rather than collapsing onto an axis, that no series is drawn in the brand colour ("muted, never orange"), that an empty or unselected editor says so instead of drawing a blank graph, that handles appear only on a key with a following segment (easing governs the segment leaving a key, so the last key has none to shape), and that a dragged handle is written as a proportion of its segment on release with the other end left alone; and the effect chain's editing surface: reordering (including refusing a move off either end), copy/paste between clips with the paste disabled until something is copied, and the timeline menu's "Add adjustment layer"; the wipe's `clip-path` for every direction, checked against the export's mask so the two cannot drift apart about which side is revealed, the dissolve's pattern mask including that a non-finite progress cannot produce a `NaN` stop (which silently drops the mask), and the transition direction control: that it appears for a wipe and a slide, that each uses its own wording because the same word means opposite things in the two, that choosing one sends it as a merged param, and that a type with no direction does not get the control; and the slide's mode control: that choosing one sends it as a param, that an unset mode displays as `push` rather than blank, and that only a slide gets the control; and the command that stores those params: merged rather than replaced, removable by `undefined`, and left alone when the patch is about duration; and the inspector's keyframe controls (§2.4): the diamond on the opacity and volume rows recording the property's *current* value when it creates a key (so adding one never changes the picture), the diamond removing rather than stacking a key when the playhead is already on one, the write blocked with a reason when the playhead is outside the clip (half-open, so a key exactly on the clip's end is refused — it would never be seen), the ◀ ▶ jumpers skipping over a key underfoot and refusing to wrap at either end, and the legacy `transform.scale` field, which the compositor honours while both axes sit at their defaults: the inspector now shows the scale the renderer will actually apply rather than `scaleX` alone, which used to report 100% for a clip drawn at 150% and would have made a diamond on that row record the wrong value; the field is retired when a uniform scale is written, because a project carrying `{ scale: 1.5, scaleX: 1, scaleY: 1 }` otherwise snaps *back* to 150% the moment the user types 100% — verified against the real `effectiveScale`; and the two-axis form that replaces it when the axes differ, so a 120%-by-80% clip is never shown as one number; and auto-keyframing: an edit updating the key already at the playhead, inserting one when the playhead sits between keys, and staying a static edit when the property has no keys at all, so dragging a slider on a never-animated clip cannot start an animation by accident; and that neither the preview nor the export shifts a volume line's item-local times by anything other than the item's own start, which is what keeps them agreeing; and the remaining animatable rows: a diamond on scale, both position axes, rotation and all four crop edges, with the animatable-property list walked as a contract — every listed property must have a diamond in the rendered inspector *and* turn an edit into a keyframe when animated, so listing a property without wiring its row fails by name; position written as a fraction of the canvas while shown as a percentage, because the stored fraction means the same thing at proxy and export size; the single Scale field keying *both* axes rather than one — from the slider and from the row's own diamond, and removing both again when a click clears the key, since keying one of a pair the user set together would stretch the clip as the animation played; and the anchor crosshair (SPEC 10 §8.2): that it sits at the picture's centre by default and only on the selected clip, that dragging it writes the two anchor fractions and nothing else, that it starts an anchor drag rather than a move, and that the picture does not slide while the crosshair is being placed — the commit payload is what that last one checks, after an earlier version asserted the in-flight state instead and let a mutant through; and the anchor arm on a non-square canvas, where the two arms are fractions of different sides and rotating them in mixed units put the picture 270 px from where the pivot said it would be — with the square-canvas and centred-anchor cases pinned as the shapes that hid it; and aiming the crosshair through a transform: a pointer has to be carried back through the picture's rotation and scale to reach item space, since a bounding box has swapped axes once the clip is turned 90° — with the scale case documented as a regression guard rather than a discriminator, because pure scaling happens to survive box arithmetic and only rotation breaks it; and object snapping (SPEC 10 §8.10 §8.8): that the canvas centre and both edges are always targets, that every other item contributes its edges and centre, that a drag's own lines are tested three ways so an edge snaps flush rather than the centre being yanked, that the closest target wins rather than the first in range, that the snap fires exactly at the threshold and not a pixel past it, that a degenerate threshold declines to snap instead of accepting everything — the case that found a real bug, since every comparison against `NaN` is false and a `NaN` threshold silently accepted every candidate — and that a bounds calculation uses the axis-aligned box of a rotated item, converting the other axis out of its own fractions; measured end to end, where a 4 px drag on a 400 px canvas lands exactly on the centre line, `Alt` keeps it at 0.01, and a snapped drag that ends where it began commits nothing at all; and the overlay set (SPEC 10 §9): that safe areas start off, that `Ctrl+;` cycles title safe, action safe and platform zones and wraps back to nothing, that the platform stop is skipped on a landscape canvas where the chrome does not exist, that the safe area is drawn as a centred inset rectangle at the percentage the *data file* names rather than one the component knows, that the platform guide is three bands over the edges the chrome covers rather than one rectangle over the safe middle, and that thirds and the centre cross compose with an area overlay instead of replacing it; that the shipped `safe-areas.json` parses and that a reversed title/action pair, overlapping vertical bands or a percentage written as 14 rather than 0.14 are all rejected at load; that tuning the data file changes what is drawn, so the numbers really do live in the data; that the key handler never takes `;` from a text field; and that the export directory cannot name any of it — the structural form of §15's "overlays never appear in an export" — extended to name `guides`, because a user guide is the one overlay that is *document state* and an export could therefore read it by accident, where the others could never reach one because they are never written down at all; and seek coalescing (SPEC 09 §23): that a target arriving mid-seek replaces the one waiting rather than queueing behind it, that the newest of several targets is the one followed, that settling releases the held target so the picture converges, that a settle with nothing pending issues no spurious seek, that a cancel drops a stale scrub target, and that a hundred-target drag costs one seek in flight — measured end to end against a real `<video>` element, where restoring the previous per-event assignment produces forty seeks where there is now one; plus the threshold's own asymmetry, four frames while playing so a correction is never a hitch and half a frame while paused where a still is visibly wrong, both scaling with the project's frame rate; and the proxy preview path (SPEC 04 §7): that the preview plays the proxy when one exists, the original when none does, the original when the user has turned proxies off, and the original again when the proxy file has been deleted — with "no proxy" and "proxy gone" kept distinguishable, since they look identical from the outside and mean different things when a user reports editing is still slow; that the schema *declares* `proxyPath` rather than merely tolerating it through `.passthrough()`, that the importer actually writes it, and that a record from before the field existed still loads; and that a proxy cannot reach an export, both through the exporter's narrowed storage port and through a source-level guard that fails if the export directory ever mentions the proxy; and the `Shift`/`Alt` modifiers (SPEC 10 §8.2): that `Shift` locks a body drag to the dominant axis and that the same drag unmodified keeps both, that `Shift` snaps a rotation to a 15° step and that the cardinals fall out of the same rule rather than needing a second one, that a snapped rotation wraps into the model's closed range at both ends, that `Shift` toggles the corner handle from uniform to free scale with each axis solved in the picture's frame, that a free scale clamps rather than mirroring the picture, that a degenerate grab leaves its axis alone, that `Alt` holds the picture's centre still and so leaves a centred anchor's position untouched, and that `Alt` still compensates an off-centre anchor's arm — eight mutations, one per behaviour, each of which fails a test; and the corner grips (SPEC 10 §8.2): that four are drawn on the selected clip and only on it, that a corner drag commits both scale axes with the compensating position in one edit, that a non-uniform clip scales evenly rather than snapping to square, that releasing a corner in place writes nothing, that a drag along an edge still crops, and that the compensation is measured from the clip's own anchor and turned by its own angle — each of those last two added after a mutant showed the centred, upright-only tests could not see them; and the rotate handle (SPEC 10 §8.2): that straight up about the pivot reads as zero, that the angle increases *clockwise* because that is the direction the model stores (a sign flip would turn the picture against the pointer), that a quarter turn measures as a quarter turn, that the drag takes the short way across the ±180 seam — a pointer going from 170° to −170° has moved 20°, and the raw subtraction is −340° — and that a drag past a whole turn wraps rather than clamping, since clamping pins the clip while the handle keeps moving; and `Esc` (SPEC 10 §8.3): that it commits nothing, that it drops the in-flight preview so the picture goes back rather than staying where the pointer left it, and that the pointer coming up afterwards still writes nothing; and that the handle starts a rotate rather than a move — it stops propagation, because pointer-down on it would otherwise bubble to the layer and translate the clip as well as turning it; and the anchor rows joining the animatable list, which the contract test enforced by name the moment the two paths were added; and a rotate writing only the rotation, never a position, so one gesture edits one property; and a crop edge auto-keying independently of its three neighbours, because cropping one edge over time says nothing about the others; and on-canvas dragging (SPEC 12 Phase 4): that a horizontal drag is converted against the canvas *width* and a vertical one against its *height*, which is the only way the same pixel movement can mean the same fraction at any preview size — a raw pixel delta would move a clip twice as far on a small panel, and the test pins both sizes; that a clip cannot be dragged more than one canvas side off, with the clamp applied to the *result* rather than the delta so a drag past the limit and back resumes immediately instead of spending a hidden offset; that a crop drag moves only the edge under the pointer, that the sign of a right-edge drag is the opposite of a left-edge one (invisible in a symmetric fixture), that an edge stops short of its opposite rather than inverting the picture and leaves a sliver rather than a zero-width crop that would divide by zero downstream, and that a missing stored offset or crop is read as zero rather than becoming `NaN` and blanking the layer; the gesture itself: that a drag beginning on an edge writes crop and a drag beginning in the middle writes position — the two mutations that route every gesture to one of them each fail a different test — that a drag commits exactly once on release so it is one undo step rather than forty, that a click that ends where it started commits nothing, and that the picture follows the pointer before anything is written to the document; and that a canvas drag follows the *same* auto-keyframing rule as the sidebar, through the same function: moving a clip whose position is already animated updates the keys on both axes when the playhead sits on one, inserts at the playhead's own local time when it sits between them, and writes the static value when the clip has no position keys at all — with the mutation that routes every drag to the static write failing both keyed cases; and the snap guides (SPEC 10 §8.8): that a canvas fraction becomes a percentage measured from the top-left rather than the centre the fraction is stored against, since a line drawn half a canvas out is worse than no line at all, and that when both axes are unsnapped nothing is drawn, so an idle selection never shows stale lines; that each axis draws its own line independently of the other; that the line sits on the target it names; and that a snapped drag *shows* one while a released drag no longer does, with `Esc` and a held `Alt` each leaving none behind — four mutations, one per behaviour, the `Alt` case proving a guide cannot claim a pull the modifier suppressed; and the *Show anchor* toggle (SPEC 10 §8.2, `A`): that the pivot crosshair is on when the preview opens rather than hidden behind a key nobody presses; that `A` hides it and `A` again brings it back, uppercased too since the toggle is the key and not the character; that hiding the crosshair leaves the selection outline and the corner grips where they were — the mutant that hid the whole selection with it is the one this catches, and it would have made the clip undraggable while looking like a no-op; that `A` typed into a field is a letter rather than a command; that `Ctrl+A` stays the timeline's select-all; and that a held key does not flicker the crosshair at the keyboard's repeat rate; and the guides' distance label (SPEC 10 §8.8): that the number is the snap's *own* displacement in preview pixels, which is the only distance the event itself defines and is what answers "how much did it just jump?" as the line appears; that it rounds to whole pixels because sub-pixel precision is not information anyone acts on mid-drag; that a zero is *dropped* rather than shown, since sliding along a line re-snaps to it at zero distance for most of a drag and a pinned `0 px` reads as a stuck overlay rather than as alignment; that the distance is unsigned, the line already saying which way the item came from; that a non-finite canvas size cannot print `NaN px` over the picture; that a corner drag shows both axes' numbers, since one would understate what happened; and that the label refreshes when the distance changes while the line does not — the state a drag is in for its whole approach once a snap is caught — a mutant that compared only the target position freezing the number at its first reading | and taking a guide away again with `Shift`+`Ctrl`-drag (SPEC 10 §8.8): that the gesture reads `shiftKey` at pointer-**down**, because a `pointerup` carries no modifier state and reading it there would always be false — a removal that silently never fires looks exactly like a removal that works; that the two gestures are told apart in both directions, since they differ by one modifier and one of them destroys work; that a guide is grabbable anywhere **along** it rather than only where the line is, which would be a one-pixel target; that a Shift-drag nowhere near a guide deletes nothing rather than taking whatever is nearest; that the nearer of two guides in reach wins; and that a degenerate reach matches nothing, the same `NaN` guard the snapping needs for the same reason. This is the mouse-only route to the same two things the Guides menu does | and guides surviving the project file (SPEC 10 §8.8, SPEC 03 §9): a round trip through a real `saveComposition` and `getComposition`, because "saved with the project" is a claim about the store rather than about the schema — and one that matters, since a guide is the only overlay that is document state; plus that a payload saved before the field existed opens with an empty list rather than failing validation and dropping the user into read-only recovery. Two mutations, and only the second test catches either: deleting the field from the schema leaves `.passthrough()` happily carrying it through a round trip, and removing the default breaks only the older file. That pair is this repository's recurring `.passthrough()` trap, where a fixture with the field already present cannot tell "declared" from "merely tolerated". The saved fixture now carries one locked and one unlocked guide, so the round trip covers the only field on a guide that cannot be reconstructed from geometry — a lock lost on reopening would remove itself at the worst moment | and user guides (SPEC 10 §8.8): that a stored guide draws at its fraction with **no** half-canvas shift, because a guide is already in the top-left space CSS positions in — the shift belongs only in the snap-target path, and doing it in both places would cancel out and look symmetrical while being wrong; that guides draw whether or not a compliance overlay is on, since they are the user's own marks rather than the app's advice, and tying them to `Ctrl+;` would make the alignment lines vanish exactly when someone is arranging a shot; that `Ctrl`-drag from an edge creates a guide *parallel to that edge*, so pulling in from the side gives a vertical line rather than a horizontal one; that the guide lands where the pointer is **released** rather than where it started, which is what makes the gesture worth having; that a `Ctrl`-drag away from an edge, and a drag without the modifier, both produce nothing; that a `Ctrl`-drag beginning *on a clip* makes no guide, because the layer sits inside the canvas and its pointer-down bubbles — without the origin check one gesture both moved the picture and left a line behind, which is the same two-things-at-once the rotate handle stops propagation to avoid, and the check is on the event's origin rather than in the layer so the layer's handler stays unaware of guides; that a guide placed practically on top of an existing one replaces it rather than stacking a second target a hair away, which would make the snap a coin toss; that the nearest edge wins from a corner so one drag makes one line; that a position outside the canvas clamps onto it, a non-finite one is refused outright, and a removal of something already gone fails rather than pushing an empty undo step; and that placing and removing a guide are undoable through the engine's patches, since a guide travels with the project and is document state, not view state — checked by replaying the inverse rather than by trusting the stack | and equal-spacing hints (SPEC 10 §8.8): that the item is moved by *half* the difference between its two gaps so it ends up centred in the space rather than flush against the larger one, with the expected delta and gap derived from the geometry rather than read off a run; that the hint's two spans are measured from the item's **moved** edges, since a span taken from the unmoved edge would draw two different lengths and defeat the one claim the hint makes; that a gap already existing between two neighbours can be matched from outside the pair, on both sides; that a difference too large to be a nudge is refused, so a clip is never yanked across the canvas; that a `NaN`, zero or negative threshold refuses everything, the guard that has now caught three separate bugs; that a neighbour with no width is ignored, a non-finite item declines, and the nearest candidate wins over the first found; that the spans draw with the same centre-to-top-left shift the guide lines use and a right-to-left span is normalised, since a hint half a canvas from the gap it describes is worse than none; and that the precedence rule is a testable predicate rather than an `if` in the gesture — a line that caught wins, `Alt` suppresses both, and a result carrying a position but no target still permits spacing, which is precisely the inversion that shipped first: the guard read `snapped.x.position`, which `snapAxis` never returns null for, so every spacing correction was computed and then silently discarded by the commit. Measured end to end on a three-clip fixture whose equal spacing sits clear of the canvas centre — the first attempt put it on the centre line, where a snap caught first by design and the test never reached the spacing path at all — where the hint appears within the threshold, the commit lands on the equal spacing rather than near it, a zero-delta spacing still draws (the bars *are* the confirmation, unlike the guide label's zero), nothing draws before the pointer moves, and both releasing and `Esc` take the hint away — the `Esc` case finding that `cancel()` had cleared the guides but not the spacing | and snapping to the rule of thirds (SPEC 10 §8.8, §9): that each composition line is shifted from the top-left to the centre, the same conversion the safe areas need and the reason it is a function rather than a subtraction at each call site; that a non-finite line is dropped instead of becoming a target at `NaN`, which accepts nothing and looks like a snap that never fires; and that the lines are labelled `grid-line` so a guide does not point at a neighbour that is not there; measured end to end, where a 130 px drag on a 400 px canvas commits the raw 0.325 with `Ctrl+'` off and the first third's exact 1/3 with the lines showing — the mutant that offered them regardless of visibility is what that pair catches | and snapping to a visible overlay's edges (SPEC 10 §8.8, §9): that an overlay rect measured from the top-left becomes centre-relative lines, with the half-canvas shift done once — the same trap from the other side, and the one that puts every safe-area snap half a canvas out; that the vertical axis reads the rect's *height* and the horizontal its width, so a platform band is not snapped to as if it were square; that a rect with any non-finite field offers nothing, since a line at `NaN` silently accepts nothing and looks like a snap that never fires — a `NaN` height slipped past a guard that only checked the two fields the chosen axis read; and that the lines follow `assets/safe-areas.json` rather than a hard-coded 0.45, so retuning the data moves the guide and the snap together; measured end to end, where an 18 px drag on a 400 px canvas commits the raw 0.045 with the overlay off and the safe-area line's 0.05 with title safe showing, and the guide it draws is labelled `safe-area-edge` rather than `item-edge` — a clip sticking to the title-safe box must not send the user looking for a neighbour that is not there | the timeline filmstrip (SPEC 09 §19): that each tile is asked for its *own* frame rather than one poster repeated across the clip — the whole reason a filmstrip exists is to show where a cut lands, and a strip of one frame cannot; that the tile count rounds up so the last partial tile is drawn rather than leaving a bare gap at the clip's end; that a tile still loading is skipped instead of drawing a neighbour's frame, since a repeated frame reads as a still clip and that is a worse lie than a gap; that each tile lands at its own x in order and the final one is clipped to the strip rather than overhanging the trim handle; and that a zero-width strip asks for no frames at all, which is the first paint of every clip being added | the Guides menu and *Lock* (SPEC 10 §8.8): that *Lock* means **never** rather than *only if you miss* — the gesture that removes a guide is a drag that has to travel to it, so a lock that yielded to good enough aim would protect nothing, and conversely a locked guide must not shadow an unlocked neighbour inside the same reach, since the removal is a radius and not a first match; that the near-duplicate rule and Lock are checked against each other, because a *Ctrl*-drag landing within 0.005 of a locked guide is where the two rules meet and the *creating* gesture must not become the way around the lock — replacing the incumbent there would lose a protected guide with the very gesture the lock exists for, while an unlocked neighbour is still replaced, so the test cannot pass by the filter having stopped working; that the schema's default is what makes a guide saved before Lock existed behave as it always did, checked through `CompositionPayloadSchema.parse` and compared with `toStrictEqual`, because `toEqual` treats `{locked: undefined}` as equal to `{locked: false}` and that difference is the entire test — and the two mutations are aimed at the *guide* schema by offset rather than by search, since `locked` also exists on a track and a string replace silently mutated the wrong one, leaving both mutants passing and looking like dead tests; that the menu's *Add* places the guide down the middle of the composition on the axis its label names (edges belong to the handles), that *Clear* is a command rather than a splice so `Ctrl+Z` puts a guide back, that both items disable with a reason when there are no guides, that *Lock* and *Clear* are offered as their inverse once guides are locked, and that the label follows the state while the *argument* is checked separately — reading only the label proved nothing about what the item does, and the mutant that always passed `locked: true` sailed through it; and the pairing that makes the menu safe to use, that *Clear* removes only unlocked guides and fails with `locked` rather than silently doing nothing when every guide is protected, plus undo for locking and clearing the same way placing was checked | the three answers `run` can get, since that is the one place an edit becomes an undo step: a command that succeeded commits and journals, one that failed posts its message and changes nothing, and one that answered **`null`** — the contract the guide-removal gesture needed, because it reports itself before it knows whether a guide is within reach — must commit nothing, journal nothing, and say nothing, or a drag across empty canvas would put a message on screen for a gesture that was meant to do nothing; and that a declined no-op leaves the session exactly as it was, so the next edit still lands. Two mutations, and removing the `null` guard breaks two of the four tests while removing the failure path's message breaks the one that exists to keep the two apart. And the button itself: that pressing it while its own menu is open closes it — `Menu` closes on any `mousedown` outside itself and the button is outside it, so the press ran that listener first and the click toggled an already-shut menu back open, which meant the button could never close what it opened; the fix keeps the press from reaching the window listener, and the test fails if that guard is removed | the custom N×M grid (SPEC 10 §8.8, §9): that the thirds are *not a special case* but `{3, 3}`, so one overlay, one `Ctrl+'` and one set of snap targets serve both — checked by drawing the default and asserting the two verticals land at 1/3 and 2/3, which is the regression that mattered most in this slice, since the state went from a boolean to a divisor pair and every existing composition would have moved if the arithmetic had drifted; that `n` divisions give `n − 1` lines and the **frame edges are excluded**, because the border is already visible and already a snap target and a line on top of it would be a second target in the same place for the tie-break to pick between — the mutant that includes them fails eight of the fifteen; that the columns are `x` targets and the rows `y`, the same convention the user guides use, since one piece of snapping code reads both and a flip would be invisible until a clip jumped sideways; and that a divisor typed by hand is coerced rather than trusted: a fraction rounds, a number outside 2–12 clamps, and a value that cannot be a grid returns `null` rather than the minimum — because `Number('')` and `Number('   ')` are `0`, not `NaN`, so the obvious guard let a cleared field through as zero and clamped it to 2×2 on the keystroke that emptied the box, which is precisely what the test caught; that any divisor surviving the clamp produces usable lines, the two functions checked as a pair because that is the invariant; and that `gridLines` itself falls back rather than drawing nothing for a stored value it cannot use, since it does not get to assume the dialog validated anything. On screen: that a custom choice reaches the **drawing** and the **snapping** as well as the dialog, with the snapping test built so the two grids disagree — 4 columns put their nearest line 17 px from where the drag lands while a third is 3 px away, so a grid that only changed the picture would commit the third and fail; that a choice is turned on by applying it, since someone who opens the grid dialog has asked to see a grid; that the choice **survives `Ctrl+'` off and on**, the failure mode of any setting that shares a key with a visibility — the first implementation closed over the initial state in the key handler's dependency list, so every re-open restored the thirds, and this test is what found it; that the button carries the grid's own name (`3×3`, `7×3`) because the lines say nothing about which grid they are; that 3×3 is stored as the *default* rather than as a custom grid, so the menu can still describe it as the thirds; that the dialog starts from the grid in force, refuses to apply a field it cannot read, leaves an emptied field alone, clamps 99 to the maximum, resets on *Use thirds*, and changes nothing on *Cancel* — the draft existing so a cancelled edit is never half-applied. Nine mutations across the geometry, the key handler, the overlay, the snapping and the dialog, all biting. Removing the thirds constant that this replaced left the old assertion in `safe-areas.test.ts` with nothing to read, so it moved into the grid suite — where the numbers are now *derived* from a divisor rather than written down twice | view zoom, pan and the **pixel grid** (SPEC 10 §3.1, §4, §9): that the applied scale is exactly **1 at Fit**, which is the number that had to not move — the preview's untransformed layout is already fitted to the panel, so an implementation returning the fit factor there would have divided every existing composition by five, and every measurement in the app with it; that Fit and Fill are the min and max ratios and fit is never the larger; that 100% works out to one canvas pixel per **device** pixel, checked as a derived ratio rather than read off a run (1080/1 over 1080 × 0.3125 = 3.2) and as the property that doubling `devicePixelRatio` halves the scale at every zoom, because treating 100% as one *CSS* pixel per canvas pixel draws the frame at twice its size on exactly the displays where someone is checking sharpness; that the scale is measured against the width layout actually produced rather than the ideal one, since the frame's padding and hairline make the real fitted width a little smaller and using the ideal puts 100% a pixel or two off the composition's true size; and that a zoom it cannot use falls back to Fit rather than to 0 or `NaN`, either of which makes the frame vanish. Zooming about the cursor is checked as the **invariant** `pan + k·p` rather than as a number, and that is what caught the first implementation: it divided the correction by the current scale *and* had the sign flipped, so zooming in on something to the right of centre pushed it further right and less the further in you already were — both mistakes look entirely plausible written down. The pan is bounded by how far the scaled frame *overhangs the panel* so it cannot be thrown off and lost — and so that a frame which fits is held at rest, since a limit derived from the frame's own size instead let a drag push it half off at Fit, and a limit that went negative for a frame smaller than the panel would have *forced* it off-centre rather than merely allowing it to move (`clampPan` also folds `-0` into `0`, because a symmetric pan out of a zero limit otherwise leaves a `-0` that fails a deep-equality assertion and looks like a real asymmetry in the clamp), a degenerate size pins the limit to zero rather than `NaN` (against which every comparison is false, so the clamp would not clamp), and panning is reported as meaningless at 1× because there is nowhere to go. The step is a constant *ratio* rather than a constant amount — 5%→6% and 400%→480% have to feel the same — and it settles at the limits instead of running away, with a ratio of 1 or less refused because that is not a zoom. **The transform is what makes all of this free**: every drag in `use-canvas-drag` divides a client-pixel delta by `getBoundingClientRect()`, and a transformed element reports its transformed box, so move, crop, scale, rotate and the guide arithmetic keep working at any zoom untouched — pinned by the tests that a 100 px drag moves the clip half as far at 200% and that the snap distance stays at exactly 8 screen pixels at 1×, 2×, 4× and 8×, which is the reason `SNAP_PX` is documented as a screen measurement. The pixel grid itself draws one line per canvas pixel in a single `<canvas>` rather than in elements — a 400% view of a wide composition reaches the thousands of lines, and the composition grid only gets away with elements because a divisor pair caps it at eleven — with each line one *screen* pixel wide regardless of zoom, because a line that inherited the scale would be an 8-pixel bar at 800%; aligned to the composition's own pixel boundaries with the frame's viewport offset deliberately excluded (an earlier version folded that offset into a modulo and put every line a few pixels off, with nothing to gain since the panel centres the frame on a fractional offset); rounded to whole pixels, since a line at 3.4 px is drawn as two half-lit columns; with the backing store sized for the device ratio, without which every line is a half-pixel blur on a 2× display; and drawing nothing at all for a spacing it cannot use, `Infinity` included — that one passes a `< 8` test and leaves a single stray line at the frame's origin. On the toolbar: Fit, Fill and the spec's 25/50/100/200/400 presets, plus an explicit **800%** entry, because the pixel grid's threshold is not a preset and landing a wheel on it exactly is not a control; the current off-preset value is listed after a wheel zoom, so a user at 173% can see the number and get back to it; `F` returns to Fit *and* the pan, since a fit frame left panned off-centre is not fit in any sense a user means; choosing a preset re-centres for the same reason, while a wheel keeps its pan because there the pan is what is being aimed. `F` is guarded from text fields the way `A` is, `Ctrl`+wheel is bound on the viewport with `passive: false` because React's own wheel listener is passive and `preventDefault` inside it is a no-op, and an unmodified wheel still scrolls the panel. The scrub-frame read path (SPEC 10 §5): that the renderer's copy of the cache grid is the *same number* as main's, asserted by importing both — the renderer is forbidden from importing main-process code, so the constant is a duplicate and a drift would not fail a typecheck or a lint, it would make every still silently unavailable; that the URL the renderer builds round-trips through main's own parser, including an id that needs escaping, so two modules that can each look correct in isolation cannot disagree; and that a still is drawn **only** while the element reports a seek in flight — taken from the element's own `seeking`/`seeked` events rather than the coalescer, because the question is what is on screen — only over the clip, half-open at the end so the last cell before a cut cannot borrow the next clip's frame, and never while playing. The interesting failure is *staleness*: an `<img>` keeps painting its previous picture after `src` changes, so a seek into the next cell would leave the old cell over the video — which is why an element that reports a load is keyed to its own URL and the handler records the URL it was created with, with a test that drives a decode of the *old* picture to completion after the playhead has moved on and asserts nothing becomes visible (removing the key makes it pass while showing the frame the user scrubbed past). Mounting and visibility are deliberately separate: the element has to be in the tree to load at all, so gating the mount on the load means it never loads — the obvious way to write it deadlocks, and five of the seven preview tests fail against that mutant. And the time half, which is where the real bug was: `scrubTimeFor` conflated the timeline with the source, subtracting the in-point from the playhead, which is right only when every one of those numbers is equal — a clip moved to 10 s with a 2 s in-point asked for the frame at 10 s instead of 4 s, and the old tests encoded the same mistake so they passed. The corrected form grids the **absolute** source time, because that is what the file name is derived from, and clamps in **item** space, because that is the span the item is allowed to show: gridding the item-local offset instead looks tidier and collides two trimmed clips onto one file whenever an in-point is not on the grid, which most real trims are not (91 frames at 30 fps is 3.0333 s), so the second extraction overwrites the first and one clip shows the other's frame. Five mutations — the original conflation, clamping in source space, gridding the local offset, ignoring speed, and dropping the last-step pull-back that keeps a request off the half-open end — all bite.  The remaining §3.1 view tiles — the **Handles** toggle, the **Pan view** tool and Space+drag (SPEC 10 §3.1, §4, §8.2): that `H` hides the transform handles *without* deselecting, because the selection is the document gesture's subject — the inspector and the timeline must keep editing the clip — so the toggle may change only what is drawn, which is why the pure rule takes both facts and owns the whole answer; that hiding the handles leaves the **anchor crosshair** alone, since `A`'s crosshair is a readout of the pivot as much as a grip, and the first wiring put it inside the same gate and made `H` hide it (the test that caught it asks for exactly that difference); that `H` is guarded from text fields the way `A` and `F` are, since `h` is a letter before it is a command. And the hand: that a plain press still belongs to the clip, so the canvas stays editable and only an armed press pans — the check is `Space` *or* the tool, never both, because requiring both would make each alone useless; that only the left button arms it, since claiming the right one would swallow the context menu's press and a middle-drag pan is not in this spec; and that the pan adds the delta in **screen** pixels undivided, because the transform is `translate(pan) scale(zoom)` with the translate outside the scale — dividing by the zoom would make the frame move a quarter of the pointer's travel at 400%. The wiring is where the two real defects were. The gesture is bound in the **capture** phase on the viewport: the clip's own drag starts on the layer's `pointerdown`, which is *inside* that element, so a bubble-phase listener runs after the clip has already begun moving and Space+drag would both pan and drag — putting it in capture also stops the crop, rotate and anchor handles, which all bubble to the same layer. And **Space is Play/Pause as well as pan** (§3.2 against §4, on the same key): the resolution is that the pan listener is passive and never calls `preventDefault`, so playback stays the keydown and the pan is a press that happens while the key is held — taking the key would have traded a working transport shortcut for the gesture, when neither has to lose. `spaceHeld` clears on `blur`, because a key-up delivered to another window never arrives and a stuck flag turns every later press into a pan, reported as "the canvas stopped responding". Nine mutations across the pure rules and the wiring all bite, including the capture phase, the propagation stop, the handles gate, the anchor's separate gate and the blur handler.  Per-axis scale on the **edge handles** and the **Crop tool** (SPEC 10 §8.2, §8.6): that an edge drag changes only the axis that edge governs, and carries the other axis through at the scale it started from rather than at 1 — returning 1 would silently undo a free scale the user had already set; that the factor is measured from the *opposite* edge, so pulling an edge away enlarges the picture (the sign a `start / now` gets backwards), and that it is read from the axis the edge governs under `Shift` too, since taking it from x for a vertical edge grows the picture by whatever the pointer did sideways; that the pointer is carried back through the clip's rotation, asserted in **both** directions because one value passes under either sign convention; that a grab starting exactly on the fixed edge is refused rather than dividing by zero into the maximum; and that `scaleAboutEdge` agrees with `scaleAboutCorner` when given the same fixed point — they must not place a picture differently for the same scale. Two of those tests were written wrongly first and both failures were instructive: one put the start point *on* the fixed edge, where the degenerate-grab guard correctly answers 1, and the vertical-`Shift` fixture measured the distance from the pointer's own start instead of from the fixed edge. The routing is what could still go wrong, so it is checked end to end: an edge commit carries `transform` under Select and `crop` under `C`, and a corner scales under either tool because a corner is two axes and §8.2 gives it the uniform gesture unconditionally. Writing that also uncovered a bug in the *existing* corner code: the compensation averaged the two axes into one delta, which is right only while the scale stays uniform — so `Shift` free-scale, which shipped earlier, slid the "fixed" corner by 100 px the moment the axes differed. Every existing test used a uniform factor and could not see it. Nine mutations across the edge maths, the compensation, the sign table, the uniform branch and the tool routing all bite.  The **Crop tool's own frame** (SPEC 10 §8.6): a rectangle over the **uncropped** source with eight handles, the four dimmed regions outside it, an aspect lock and a corner radius, with `Enter` applying the session and `Esc` discarding it. The frame is over the *uncropped* picture on purpose — with the stored crop applied, the area outside the window is invisible, so a user could never widen a crop back out, because the grips would sit on the edge of a picture already cut away; a test asserts the layer's `aspectRatio` is the whole source's rather than the cropped window's, and the mutation that keeps the crop bites. All the arithmetic is pure in `crop-tool.ts`, and the rules that were wrong on the first attempt are the ones worth recording. `lockedCrop` moves the *dragged* edge and grows the other axis **from its own centre**, so the frame stays where the user put it; there is no `max(0, …)` on that centred axis, because clamping one side to the source while the guard refused the mirror case made the same situation behave two ways — a window near the top slid down to stay legal, while the mirror image near the bottom was refused outright — and sliding breaks the framing just as much as refusing does. Four tests (top/bottom for a horizontal drag, left/right for a vertical one) now pin that, and deleting the guard or reintroducing any of the four clamps each fails one. `cornerCrop` derives the locked axis from whichever of the two the pointer moved further **in source pixels**, since in fractions a 0.1 change means different pixel counts on wide and tall sources; each of the four held-inset branches is pinned separately, because a full-frame fixture cannot discriminate — the held corner *is* the source corner, so `1 − width` and `1 − right − width` agree, the same trap the edge-scale slice hit twice. The grip hit test is per-axis (a 12-px grip is 3% of a wide frame and 5.3% of a tall one), picks the *nearer* edge when a window is thin, takes corners over edges and edges over the pan, and refuses the dimmed region — including the case where a point is level with an edge but far outside the frame's side, which needed its own bounds check. Sessions are a **draft in view state**, not a document edit: several drags cost one undo step on `Enter`, `Esc` costs none at all, and a session that changed nothing is refused by `cropChanged`'s 1e-6 tolerance so the next `Ctrl+Z` is not dead. Applying goes through `commitKeyed` like every other canvas edit, which was a real bug caught by the existing §2.4 test — writing `setItemProperties` directly made an animated clip's crop appear to work and then vanish on the next redraw. The radius needed the model to grow: `crop.radius` was in the schema but nothing read it, so it is now resolved in `itemGeometry` (capped at half the *cropped* window's short side, with a broken value falling back to square rather than to `NaN`, which would blank the layer without throwing), added to `PropertyPath` so it is keyframeable as §8.6 asks, given a diamond and a field in the inspector — which the animatable-property contract test demanded the moment it was listed — and drawn as a `borderRadius` clip on the same element whose `overflow: hidden` already does the cropping, so the preview and the export cut the same shape. That test caught a real arithmetic bug too: `radiusCss` multiplied a fraction of the short side by 100 again, making every corner a hundred times too tight, which on screen reads as a slider that does nothing. The frame's own release had to be tested separately from its commit — deleting the release left `end()` re-committing the same crop, and only a *stray* move after a gesture had finished told the two apart, which is the state a real browser delivers whenever the pointer is over the frame without being down. Fourteen mutations across the crop maths, the grip hit test and the frame's routing all bite.  The **reframe gesture** (SPEC 10 §8.6's "Set framing…"): a fixed canvas window with the picture dragged *under* it, which is the opposite gesture to the crop frame's and the manual precursor of auto-reframe (`13`). The two modes are exclusive, because a drag that meant "move the window" in one and "move the picture" in the other would be indistinguishable on screen. What the picture covers is derived rather than guessed: the preview draws it at the source's own `aspectRatio` and `width: 100%` of the canvas, so an unscaled 16:9 shot in a 9:16 canvas is a band 0.3164 of the height — a *fit*, not a *fill* — and the numbers here are what the user sees. That is why the gesture has a zoom: the scale at which a 16:9 picture finally covers a 9:16 canvas vertically is `sourceAspect / canvasAspect` = 3.16, and below it *no* vertical position covers, so the axis is held centred rather than clamped to a range that does not exist. The clamp itself is half the **overhang**, not half the size — a picture of size `s` still reaches the canvas's edge while `|centre| ≤ (s − 1) / 2` — which is what keeps §13's "no empty canvas exposed" true, and the mutant that uses `s / 2` exposes canvas at every scale a user can reach. The drag's sign is the picture's, not the window's, and the mutant that inverts it is caught by three tests. A zoom re-clamps the offset at the new size, because a framing that was legal at 2× can hang off the window at 0.5×. What gets written is four keyframes in **one** call, through a new `setKeyframesAt` command: a framing is a point, and four separate `addKeyframe` calls would leave the undo stack with four entries for one drag, so `Ctrl+Z` would undo a quarter of it. That command replaces an existing key at the instant (re-framing a moment already framed is a correction, not an error) while keeping its interpolation, quantises the instant once, and its own inverse restores every path at once — asserted through the patches rather than through the label, because "one undo step" is a claim about the patch set. Recomputing the quantisation inside the loop is *equivalent* here, since `quantizeUs` is pure, and the test says so rather than pretending to catch it. Nine mutations across the coverage maths, the clamp, the zoom, the rounding and the write path all bite.  The **preview-quality report** (SPEC 10 §5.1's "never silent"): which file the preview is playing, and what it owes the user for it. The policy is pure and the interesting cases are the ones where it says *nothing* — a proxied clip, a source that `needsProxy` correctly declined, a still image — because a chip that is permanently on screen reporting a non-event is a chip nobody reads. A proxy that is still being made gets the spec's own string ("Preparing smoother preview…", pinned by a test so a reword is deliberate), and "still being made" is read from a live `proxy` **job record** — `type`, a matching `mediaId`, and a status of queued, running or paused — rather than from a flag on the media, because the media has no such flag and the first draft invented one: a field only the tests could set, and therefore a chip that could never appear in the running app. Deriving it from `listJobs()` is what makes the state reachable; `failed` and `cancelled` are deliberately *not* live, since a proxy job that failed leaves `proxyPath` null forever and "preparing" would be a promise about a file that is never coming. The job list is polled rather than pushed, but only while `mediaAwaitingProxy` says some import still needs a proxy and has none — a few seconds on a cold import, and never a timer running for the life of the editor; the predicate stops at the moment the proxy arrives, which is the one line whose absence would leave the editor polling forever on every project, and a project with proxy preview switched off admits it: nothing is broken there, the setting was deliberate, but a slow scrub over a 4K original then reads as a bug rather than as a choice. The chip is read from the **selected** clip's media rather than from whatever is on top, since that is the file whose speed the user is judging. Wiring it exposed a gap rather than a bug: main had always returned the whole media record, but the renderer's declared `listMedia` shape omitted `proxyPath`, so the preview could not know it was playing a proxy and so could not say so. Four mutations — the setting, the selection, the pointer and the guard — all bite, as do six on the job signal: a failed job counted as live, the media id ignored (so a second import's progress is reported against the wrong clip), any job type accepted (a probe or an export would say a proxy is coming), a finished job treated as in flight, `done` counted as live, and the poll's two conditions dropped one at a time. The **caption anchor** (SPEC 11 §5, and the bug it turned out to be hiding): the horizontal half of a caption's position was dead code. `layoutText` computed the block's left edge as `xPct − width/2` in **all three** branches of a ternary that tested the anchor, so a left- or right-anchored caption was centred no matter what `xPct` said — while the ASS export wrote `\an<code>\pos(xPct, yPct)` and put it exactly where the style asked. Preview and burn-in disagreed by half a block on every style that was not centre-anchored, and *every one of the ten built-in presets is centre-anchored at `xPct: 50`*, which is the single point where all three branches return the same number. The existing layout tests therefore all passed, the presets all looked right, and the two renderers silently disagreed about every style a user might import or edit. Both halves of the fix are pinned: the layout is now checked against the export's **own** `assAlignment`/`assPosition` for all nine anchors at an off-centre `xPct`, so the two modules cannot drift about which corner is which without one of them failing — the test lives in `export-core` because that package depends on `compositor` and not the reverse, and the preview should not have to reach for the exporter to be checked. Nine of the sixteen fail against the old code, and four mutations of the new branches all bite (left, right and centre each wrong, and left/right swapped). The same bug made `xPct` and `anchor` **unreachable**: the style editor exposed only a vertical slider, so no user could have hit the divergence in the first place. It now has the spec's nine-cell anchor grid (`aria-pressed` per cell, and a test that the click writes a real style rather than only lighting a cell), a horizontal slider beside the vertical one, and both fields in the style draft — five mutations across the grid, the two apply paths and the slider all bite. That is worth recording as the shape of the bug rather than the bug: a feature can be wrong in a way nothing notices because it is also unreachable, and the missing control is what kept the wrong arithmetic alive. **Text and shape items** (SPEC 11 §7, §12): the schema had carried a `text` item type, a `textContent` field and a nine-value `shapeKind` enum since the beginning, and nothing read any of them. A project could declare a title, the file validated, the timeline drew a chip, and no renderer produced a pixel — the item types were decorative. They are now reachable end to end: `createTextItem`/`createShapeItem` in the engine, `addTextItem`/`addShapeItem` commands that create their own track when there is none, a context-menu entry for each, a `<canvas>` pass in the caption overlay, and ASS cues in the burn-in. The decision that kept the cost down was to make a text item **a caption without words**: it resolves its style through the same `resolveStyle` and lays out through the same `layoutText`, so it inherits wrapping, the nine anchors, outline, shadow, background and the preview/export agreement those already have tests for. A second styling system for titles would be a second thing to keep in step, and this project's whole shape is that the preview and the file are one renderer. The cases that needed deciding were the negative ones. An **empty** text item draws nothing rather than a background box, because "add text" then "type" is a real intermediate state and a box would flash on screen before the user has typed. An **unknown** shape kind draws nothing rather than falling back to a rectangle, because a rectangle is a claim about what the file contains. A title is drawn **before** captions on the shared canvas, since a caption is the thing being read. Its range is **half-open** like every other item's, so a title whose end meets the playhead is off screen — a one-frame difference nobody would ever diagnose. The shape paths are SVG strings in a fixed 100×100 box, so a shape is crisp at any size and one definition feeds the preview and (later) the exporter's rasteriser. Twenty-three tests on the pure module, nine on the burn-in, twelve on the commands, six on the overlay's selection and two on reachability in the menu; twenty-two mutations all bite — including a blank title drawing a box, an unknown kind drawing a rectangle, a text item claiming shapes on the overlay (which would draw a caption twice), a title using the caption's span, and a new track landing at the bottom of the stack where it would draw behind the footage. One process failure is worth recording: `pnpm test` runs vitest, which strips types, so a test file can reference a union member that does not exist and still pass. The `build` step was the only thing that noticed — it is part of the gate for exactly this reason, and the fix was the established `if (!result.ok) return;` narrowing idiom. **Shape rendering** (SPEC 11 §12): the previous slice made shapes creatable and claimed they were previewed, which was wrong — `shapePath` returned a string that no element ever called, and the exporter had no shape path at all, so a rectangle added from the menu was an **entirely invisible item** in both the editor and the file. The fix is one geometry and two serialisers: `shapeGeometry` in `compositor` returns subpaths of lines and cubics in a 100×100 box, the renderer walks them with `moveTo`/`lineTo`/`bezierCurveTo` onto the canvas, and the exporter walks the *same* subpaths into ASS drawing commands (`\p1`, `m`/`l`/`b`). Two serialisers over one geometry cannot disagree about where a vertex is, which is the failure mode that matters — a shape half a frame out of place reads as a design choice, not a bug. Curves are cubics in both because kappa (0.5522847498) makes a cubic match a quarter circle to within rounding, so there is no arc flattening to document. The conversions that produce a plausible wrong picture rather than an error are each pinned: the 100-box must scale onto the output resolution (a percent value drawn as pixels is a postage stamp), ASS y grows downwards like SVG (a flip mirrors the shape and still looks like a shape), and the box origin must be added (a dropped origin draws every shape in the top-left). A shape borrows its **caption style's fill** rather than adding a colour field the editor cannot set, and the ASS override suppresses that style's outline and shadow — a preset's outline on a filled rectangle draws a border the preview never shows. An unknown `shapeKind` draws **nothing in both renderers**, which is asserted separately on each side. Two mutations survived the first pass and both were real test gaps rather than equivalents: dropping the box origin survived because every fixture happened to start at the origin, and flattening kappa survived because the tests counted curve *commands* without ever looking at their coordinates — now pinned with a closed-form check that the cubic's midpoint lands on the circle. **Volume relocation** (SPEC 04 §4.1, §8): `volumeId` was recorded by nothing and read by
 nothing, so a referenced import on an external drive was gone the moment the drive came back
 as `E:` instead of `D:` — and nothing was actually lost. Import now records a volume identity
 (a serial where the platform reports one, a label otherwise) and the root it was mounted at;
 `relocate.ts` re-roots the recorded path onto the same volume wherever it is mounted today.
 The checks are ordered by cost: size first, because a mismatch is proof and needs no hashing,
 then the fingerprint — which is what stops a same-length file on a card full of clips being
 accepted as the right take. Managed media is never relocated (its bytes are in the library,
 and pointing it at an external file would silently change its storage mode), and the reason a
 record could not be found is reported distinctly — "not mounted" tells the user to plug the
 drive in, "mismatch" tells them the file was replaced, and a bare "not found" would send them
 looking through folders for something already in front of them. Sixteen mutations bite.

 Two real bugs came out of writing it. `relativeWithin` returned POSIX separators for Windows
 paths, so a `D:\…` record re-rooted onto `E:\` produced `E:\Footage/Shoot/clip.mp4` — most
 Windows APIs tolerate that and ffmpeg's argument handling is not one of them. And `recoverRoot`
 stopped at `/media/<user>`, which is the directory every removable drive is mounted *inside*,
 so a relocation would have matched a path on a different drive. A third finding was a false
 one: the separator test I wrote for the first bug used a Windows record on a POSIX root, which
 no real pass produces, and both implementations agreed on every coherent input. The rule now
 reads "the destination decides" with the reasoning in the code, rather than a guard for a case
 that cannot occur.

 **Auto-reframe camera** (SPEC 13 §6.3): the half of auto-reframe that does not need a
 model. §6.4 explicitly permits a build without the ONNX face detector — "fall back to §6.4
 and state it" — so detection stays unimplemented and *stated*, while the camera path that
 turns detections into keyframes is now real and tested: the dead-zone, the one-pole
 smoothing expressed against elapsed *time* rather than per sample, the 25%/s pan limit, the
 hold through frames with no subject, the cut reset, the headroom budget, and Ramer–Douglas–
 Peucker reduction with both axes considered together. Two of those existed as decisions in
 the spec and one as a failure mode worth naming: a gap in detection must hold the aim
 rather than jump to the centre and back, which is the most obvious way auto-reframe looks
 broken. Fourteen mutations bite.

 Two of the four bugs found here were found *by* the tests, not before them: the camera
 placed itself on the subject at every sample — the "has it been placed" flag was reading
 state a gap had left behind, which is false for every ordinary sample, so the smoothing
 never ran at all — and `capKeyframes` carried a dedupe guard against a collision that a
 proof over the index arithmetic shows cannot happen. The second is worth recording because
 the mutation that deleted the guard changed nothing: a surviving mutation is usually a test
 gap, and this time it was a dead branch. The guard is gone and the reasoning is in the code.

 **Linked to transcript** (SPEC 11 §9): `regenerateCaptions` and
 `syncCaptionsWithTranscript` were both implemented, both tested at the command level, both
 imported into the editor hook — and neither was ever called. `linkedToTranscript` was a third
 schema toggle with no reader. A project's captions could only ever be the ones a transcription
 job happened to leave behind; editing the transcript could not reach them, and "Regenerate"
 was described in the spec with no button behind it. `caption-segments.ts` supplies the
 grouping both commands were missing a caller for: sentence boundaries when the transcript
 supplies them, a duration cap and a word cap otherwise, contiguous by construction so the
 output is legal on a caption track without a repair pass. The panel grows the link toggle, a
 *Regenerate* and a *Realign* button, and the hook enforces the gate rather than the button —
 with linking off a caption track is independent text, so a disabled button is the affordance
 and the hook is the rule. Two refusals matter more than they look: no transcript means no
 command, because `regenerateCaptions` writes exactly the segments it is given and an empty
 list would delete every untouched caption; and a word whose `endUs` predates its group is
 repaired rather than passed on, since the timeline refuses a negative duration and one bad
 word would fail the whole regeneration. Thirteen mutations bite.

 **Fill lock** (SPEC 10 §8.5): `coverLock` was the second schema toggle with no reader and
 no writer. The rule is that a main video which fills the frame keeps filling it — a drag
 is clamped so it cannot expose empty canvas, and a scale cannot shrink it below cover.
 `cover-lock.ts` holds the arithmetic; `use-canvas-drag` applies it as the *last* step of a
 move, after snapping and spacing, because a snap onto a guide that exposes canvas is the
 one thing the setting exists to refuse. Two measurements had to be right before the rule
 could be: the picture's drawn width is `scaleX` alone (a cropped clip is *magnified* to
 span the canvas, so multiplying `source.width` in declares the opposite of what happened),
 and its height is `scaleY · canvasAspect / sourceAspect` — which is what keeps a 16:9 clip
 in a 9:16 project out of the lock entirely, since it letterboxes and cannot cover at any
 scale. `Ctrl+L` and a toolbar chip write the same flag through `setToggles`, and the
 renderer's chip reads `!== false` so a project saved before the field existed opens with
 the spec's default of on.

 Adding the rule broke 22 existing drag tests, and that was the correct outcome rather than
 a regression: every one of those fixtures was a full-frame video at scale 1, which is
 precisely the clip §8.5 pins to the centre. Their suites ask about snapping, layer order
 and Space+drag, so those fixtures now set `coverLock: false` explicitly with a comment
 saying why, and the locked path has its own suite in `preview-cover-lock.test.tsx`.
 Fourteen mutations bite: nine on the rule (sign, one-sided clamp, per-axis limit, the
 looser axis, an ignored floor, an ignored toggle, an ignored offset, a missing exemption,
 and clamping every item rather than the main video) and five on the extent.

 **Linked selection** (SPEC 09 §9.6): a video and its detached audio share a `linkId` so the two travel together — and *none* of the five commands that must honour it expanded the ids they were given. Moving the picture left the sound behind, deleting it left audio playing over black, and splitting it left one long sound under two short clips. The schema carried the coupling and the `linkedSelection` toggle from the start; `linkedTrackIds` existed but was read only by the ripple paths. `withLinkedSelection` is now the one expansion, applied by `moveItems`, `trimItem`, `splitItems`, `deleteItems` and `duplicateItems`, and a new `setToggles` command plus a toolbar button make the flag reachable — it was document state with no control and no writer, so every project was permanently linked and could not say so. The rules that needed deciding: a partner moves by the **delta**, never to the same absolute position, or a deliberate offset closes on the first drag and the sound drifts against the lip; a trimmed partner trims its **own** edge by the delta, not to the picture's new end, which only an offset fixture can distinguish; a duplicated pair is re-linked to each other under a fresh shared id, since one id per copy would leave the copies unlinked and move the same bug onto them; a partner on a locked track is left behind rather than refusing the whole operation; and groups expand as a second, separate relation. Two real bugs were found by the tests while writing them: trimming a partner to the picture's absolute end collapsed an offset sound to one frame, and `closeMainGaps` pulled a linked group member back after it had correctly moved — the gap-closing pass only skipped the ids the *caller* named, not the partners the command had added. Nine mutations all bite, but one only after a fixture was fixed: every trim test had the pair starting together, where the two formulas agree to the microsecond. The **Auto** render ladder §5.1 also asks for is *not* built and is recorded as a limitation: the preview draws DOM layers at each element's own resolution, so there is no internal render scale to step down, and a "Preview ½" chip would describe a resolution nothing is rendered at. |
| `packages/ai-core` | 120 | Provider clients, scoring, connectivity |
| `packages/update-core` | 177 | Version rules, manifest verification, signatures, update state machine, journal and recovery text, yt-dlp updater rules |
| `packages/timeline-engine` | 270 | Commands, invariants, undo/redo, caption editing (§11 §2.5), item properties and their validation, and the curve editor's write path: bezier handles stored on a keyframe, handle x clamped to 0–1 while y is free to overshoot so ease-back stays expressible, setting handles also switching the key to bezier interpolation (storing them on a linear key would leave them ignored and the edit would silently do nothing), and a refusal when there is no key at that time (§09 §17), plus the brand kit commands: applying a kit as ordinary tagged items on their own track, replacing rather than duplicating on reapply, detach as a one-way door, and inserting an intro or outro with the whole project rippling right (§13 §8.2, §09 §13.2) |
| `packages/audio-core` | 48 | The gain envelope: dB conversion, fade curves, keyframe interpolation and easing, and the preview/export agreement that SPEC 10 §7.1 requires |
| `packages/media-core` | 11 | Probing, peaks, path resolution |
| `packages/project-schema` | 11 | Schema validation and migration |
| `packages/design-system` | 4 | Component contracts |
| `packages/brand-kits` | 109 | The `.cwbrand` schema, import/export with unknown-field preservation, placement resolution across aspect ratios, what applying a kit reports, the intro/outro plan with its wrong-aspect warning, safe-area-aware placement pinned to `assets/safe-areas.json`, the `.cwbrand` archive written by hand and verified with a real `unzip`, capturing a kit from the current clip by measuring geometry back into percentages, and missing-font substitution that keeps a serif a serif |
| **Total** | **3231** | 130 files |

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

## The icon set (SPEC 11 §12)

Measured against the installed `lucide-react@0.475.0`, by `scripts/generate-icons.mjs` and the
audit that produced the numbers below:

| | Count |
|---|---:|
| Files in the package | 1761 |
| Aliases (re-export another name) | 205 |
| Icons with their own data | 1555 |
| **Convert to geometry** | **1541** |
| Refused: genuinely elliptical arc | 14 |
| Barrel file with no shapes | 1 |

Of the 1468 arc commands in the set, 1448 are circular (`rx === ry`) and convert exactly — a
quarter circle is a KAPPA cubic, the same closed form `shapes.ts` already uses. The 14 refusals
are `bell-electric`, `cylinder`, `database`, `database-backup`, `database-zap`, `drum`,
`drumstick`, `gift`, `graduation-cap`, `ham`, `ribbon`, `route-off`, `section` and
`train-front-tunnel`; every one was checked to contain an `A` whose `rx` differs from its `ry`.

The geometry is verified three ways rather than asserted: each converted cubic is sampled and
checked against the analytic circle (worst error **0.0027 units on a radius of 10**, which is
0.03% and far below a pixel at any size the editor renders); the last step is checked to land
on the destination **exactly**, because `Z` joins the last point to the first; and all four
`largeArc`/`sweep` combinations are pinned — a semicircle through (10,-10) for `sweep=1` and
(10,+10) for `sweep=0`.

The rendering contract is that an icon is a `ShapeSubpath[]` in the **100×100 box**, so both
existing serialisers draw it unchanged: `paintShape` for the canvas and `assShapeDrawing` for
the burn-in. Pinned by feeding one icon through both — SVG `M12.5 87.5 L50 12.5 L87.5 87.5 Z`
and ASS `m240 945l960 135l1680 945l240 945` for the same triangle at 1920×1080.

### Icons are outlines, and the numbers came from rendering one

Lucide draws its icons as **strokes**: the icon is the outline around a path, not the area
inside it. `paintShape` filled everything, so an icon was a silhouette — a filled star outline
is a solid pentagram and a filled gear is a disc. Both are now stroked, from one flag
(`drawsAsOutline`) and one width conversion (`iconStrokeInBox`), and every claim below was
measured by rendering the real ASS through the bundled ffmpeg and reading the pixels back:

| Claim | Measured |
|---|---|
| The fill can be hollowed with `\1a&HFF&` | two crossings of 40 px = a ring; `\1c&HFF000000&` gave **one solid run of 680 px** |
| Stroke width tracks the setting | 0.5 → 17 px, 2 → 63 px, 4 → 126 px across a 540 px icon |
| An icon is no longer stretched | aspect **1.668 → 1.036** (a Lucide star's own bounds, not a distortion) |
| An icon is centred | drawn centre x = **960**, frame centre 960 |

The `\1a` one is worth keeping: writing `\1c&HFF000000&` looks like transparent black and is
not — ASS reads `\1c` as a colour with no alpha — so the first attempt at a stroked icon was
still a silhouette, and only the pixel count showed it.

**The square box.** A shape's box is a percentage of each axis, which is correct for a
rectangle: 50%×50% of a 16:9 frame is 960×540 px. A Lucide icon is square, so mapping one onto
that box stretched it 16:9 (aspect 1.668). Both renderers now take the shorter side of the box
and centre the icon in it, from one function (`iconBoxPx` on the canvas, `square: true` in the
ASS mapping).

**Mutations.** 4 more on the stroke and box work — a longer side instead of the shorter in
either renderer, filling instead of stroking, and ignoring the square — all bite.

### The icon picker, and a width that was computed and thrown away

The library, the search and the geometry existed and **nothing could reach them**: the context
menu added a star and only a star. `IconPicker` is a dialog over the drawable set — a search
box, a paginated 8×6 grid of inline SVGs, and the stroke-width field. Pagination rather than
virtualisation was a measurement, not a preference: all 1541 icons convert to 504 KB of path
data in 57 ms, but 48 tiles are 16 KB of DOM, so a page is cheap and 33 of them are not paid
for.

Two properties are worth stating because they are the ones that go wrong:

- **Only drawable icons are offered.** The 14 arc icons are absent from the grid rather than
  present and failing, so the picker cannot produce an item that draws nothing. Enforced by
  filtering through the same `resolveIconItem` the renderers use, and pinned by a test that
  searches for a refused icon by name and finds no tile.
- **A new search starts at page one.** Without the reset, `heart` — a single page — is fine,
  but `arrow` matches 74 icons across two pages, and a user who had paged forward to `star`
  would land in the middle of the results or on an empty grid. The first version of this test
  searched `heart`, so `clampedPage` pulled the number back to zero and the mutation
  **survived**; it now searches `arrow`, which has more than one page, and the mutation bites.

The **stroke-width field** was the other failure. The picker computed the width and reported
it with the name; the panel's handler took the name and dropped the width, `addIcon` took only
a name, and the field was decorative — every icon came out at the default 2, in the editor and
in the file, whatever the user set. It is now carried through the command onto the item
(`iconStrokeWidth`) and written as `\bord`, measured on a 1920×1080 script: 0.5 → `\bord16`,
2 → 62, 3.5 → 109, 4 → 125, and **absent stays absent** so a project written before the field
existed still draws at the default and does not gain a field on the next save.

**Mutations.** 6 more, all bite: the picker offering a refused icon, no clamp on the width,
no pagination, a search that keeps the page number, the panel dropping the width again, and
the command dropping it. One of these — the survivor above — is why the search test searches
`arrow` and not `heart`.

### Five audio controls that reached the project file and nothing else

The inspector has offered **Gain**, **Pan**, **Fade in**, **Fade out** and a **Fade curve**
since the audio section was built; `ExportPlan` carried none of them, `planAudioItems` asked
the plan for none of them, and the mixer's `applyItemProcessing` then supplied its own
fallbacks — 0 dB, centre, no fade, equal-power. Measured directly, with an item carrying
`gainDb: -6, pan: -80, fadeInUs: 500000`:

```
                       before            after
plan carries gainDb    undefined         -6
plan carries pan       undefined         -80
reaches the mixer      undefined         gain 0.501, pan -0.8, fadeInUs 500000
```

So all five changed nothing in the file. It is the **third appearance of one bug shape** in this project — a property added to the schema, a control added to the UI, and
the path between them never finished. The two earlier ones were `volumeId` and the volume
keyframe line, and the keyframe fix is what this slice copied: measure the rendered mix,
because a request that carries the right number and a file that sounds right are two claims.

The four tests that pin it read the *output* of the real mixer:

| Control | Measured on the rendered mix |
|---|---|
| Gain | −6 dB renders at **0.501×** the level of 0 dB (ratio, not absolute) |
| Pan | hard left/right move the signal to one channel; **+50** gives right/left ≈ **2.4×**, which is constant-power at 0.5 and not a hard edge |
| Fade | a one-second linear fade is below 20% of full level in the first 50 ms and in the last 50 ms |
| Fade curve | linear ÷ equal-power at the fade midpoint = **0.7071** (0.5 ÷ 0.7071); ignoring the curve gives exactly 1 |

**The pan unit.** The project stores −100…+100; the mixer wants −1…+1. The first version of
the pan test used only −100, 0 and +100 — and a mutation that dropped the `/100` division
**survived**, because clamping ±100 lands on exactly the hard edges those three cases expect.
Adding a **+50** case is what kills it. This is the same lesson as the icon search test above,
and it is worth having twice: a test whose sampled inputs have the same answer under the bug
is not testing the code it claims to test.

**Two things were checked and found not to be bugs.** The mixer's constant-power pan
multiplies by `√2`, so a centred item renders at exactly unity and the preview's centred
`<video>` already matched it — the 3 dB discrepancy an earlier note worried about does not
exist. And mute needs no forwarding: the plan sets `hasAudio` false for a muted item and
`planAudioItems` skips those, so a branch forwarding `muted` would be unreachable. That branch
was written and then removed rather than left in as dead code.

**Mutations.** 7, all bite: the three properties dropped at `planAudioItems`, the same three
dropped at the plan, the pan division, and the fade curve dropped at either end.

### The transport's peak meter, and where the arithmetic was put

SPEC 12 §6.3 asks for a master stereo peak meter with a −60…0 dB scale, a 1.5 s peak hold
and a latching clip light (`10 §3.2` places it at the right end of the transport). It is
built in three parts on purpose:

| Part | File | What it owns |
|---|---|---|
| The arithmetic | `audio-meter.ts` | dB clamping, the bar's fraction of the scale, the hold's timer, the latch |
| The graph | `use-audio-meter.ts` | one `MediaElementSource` on the preview's `<video>`, split into two analysers at 30 Hz |
| The drawing | `LevelMeter.tsx` | bars, hold markers, the clip button |

Almost everything that can be wrong with a meter is in the first part — a hold that decays
like a level, a light that clears itself, a bar whose labels and heights are computed from
different scales — and none of it is visible in a screenshot. Putting it in a pure module is
what makes it testable without an `AudioContext`, which jsdom does not have.

**Six mutations on the arithmetic, all bite:** the hold decaying to the floor instead of to
the current level, the clip light clearing when quiet, the hold never expiring, the bar
computed linearly in amplitude instead of in dB, an average substituted for the peak, and
`NaN` allowed onto the scale. **Four on the drawing, all bite:** an amplitude bar, a hold
marker tracking the level, a clip light that cannot be clicked, and both bars reading the
left channel.

Two findings worth recording:

- **The test caught a bug in the code it was written for.** `amplitudeToDb` returned the
  conversion's floor (−120 dB, `audio-core`'s silence value) rather than the meter's (−60),
  so a quiet-but-nonzero reading would have drawn a bar off the bottom of its own scale. The
  two floors belong to different things and the conversion has to end at the meter's.
- **The token lint caught a hard-coded `33ms`.** The fix is not a `--dur-*` token: the
  fastest is 120 ms, four frames of the meter's 30 Hz cadence, so a transition would lag the
  level and hold peaks below where they happened. The right answer is no transition at all,
  because the 30 Hz redraw *is* the animation.

**What this is not.** The graph is one tap on the bottom picture layer, so the three
limitations in `docs/limitations.md` §3.1 still stand: only that layer is audible, pan is not
previewed, and there is no per-item automation. The meter was built first because it is what
makes the rest of the graph checkable — every later change can be seen as well as trusted.

### A shape row and an icon row, so a geometry choice is not final

`docs/limitations.md` recorded that an icon's stroke width and a shape's kind could be chosen
once, when the item was created, and never again. Both fields were in the schema, drawn by
both renderers and written to the file; the **command could not write them and the inspector
had no control**, so the only way to change a 2-unit outline to 3.5 was to delete the icon and
add it again with the field already set — losing its timing to change how it looked.

Three pieces were missing, and all three are the same shape of gap this project keeps
finding:

| Piece | Before | After |
|---|---|---|
| `setItemProperties` patch | no `shapeKind`, no `iconStrokeWidth` | both, range-checked like its neighbours |
| The inspector | no row for either | one row, showing whichever the item actually has |
| Shape labels | none existed; the menu always added `rect` | `shapeKindLabel` derives words from `SHAPE_KINDS` |

**One row, never two.** An item has one source of geometry — a shape a `shapeKind`, an icon an
`iconName` — and the schema keeps them exclusive. The inspector asks which it is holding rather
than rendering both with one inert, because a control that can be moved and changes nothing is
precisely the bug this slice exists to remove. `setItemProperties` refuses a `shapeKind` on an
icon for the same reason `addShapeItem` refuses an item with both: two renderers must not be
free to disagree about which geometry wins.

**The label is derived, not tabled.** `shapeKindLabel('round-rect')` is `Round rect`, computed
from the kind so that adding a shape to `SHAPE_KINDS` cannot leave a menu showing a raw
kebab-case identifier. A test walks the whole list and asserts no label contains a hyphen.

**Mutations.** 10, all bite: the slider ignoring the stored width, the shape control writing
the *old* kind, both sections rendering for an icon, the section rendering for every clip, the
command dropping either assignment, the range check, the exclusive-geometry check, and the
label's capitalisation and hyphen handling. Written twice: the first `shapeKindLabel` test
compared labels lowercased, which fails on the *correct* implementation for single-word kinds
(`rect` → `Rect` differs only in case) — the assertion was wrong, not the code.

### Re-picking the icon, and two mutations that survived a green test

The last piece of the same gap. `IconPicker` had taken a `value` and a `strokeWidth` since the
day it was written and **no caller ever passed either** — which is why the grid could not
highlight the current icon. Binding it to an existing item makes it an edit dialog instead of
an add dialog: the inspector's icon row gets a *Change…* button, the dialog opens on the
item's icon and width, and `setItemProperties` gains `iconName`.

**Stored geometry is cleared when the name changes.** `iconShapes` is the escape hatch for a
project opened by a build with a different Lucide set. Keeping a star's paths on an item now
named `heart` would draw the star while the picker marked the heart selected — the same
"control and picture disagree" failure that has recurred throughout this feature.

**Two mutations survived the first green run, and both were test gaps of the same kind** — a
fixture whose value could not distinguish the fix from its absence:

| Mutation | Why it survived | Fix |
|---|---|---|
| `value` not passed to the picker | the test only read the *stroke* field | assert the current tile is `aria-pressed`, after searching for it |
| `strokeWidth` not passed | the fixture's width was **2**, which is also the default | use 3.5 |

The second is the third instance of one mistake in this session (the pan test with ±100 only,
the icon search for a one-page term, and this). The general statement of it: **a test whose
fixture sits at the default value cannot observe whether the default was supplied or
computed.** All three were found by running the mutation, none by reading the test.

### Brand kits: the format and the plan (SPEC 13 §8, data layer only)

`brandKits` had been in the project schema since the beginning as `z.array(z.string())` — a
list of ids with nothing behind it — and `BrandKits/` was created on disk by the storage
service. Nothing read or wrote either. SPEC 13 lists brand kits as **CORE for v1 acceptance**,
so this is the first slice of the largest remaining gap.

What is built is the part that decides things, with no UI yet:

| Module | What it owns |
|---|---|
| `schema.ts` | the `.cwbrand` format, its bounds, and import/export preserving newer fields |
| `apply.ts` | placement and visibility resolution, the application plan, and diagnosis |

**A kit is a recipe, not a new kind of object.** Applying one produces ordinary items and
ordinary style assignments — an image item on a graphics track, a clip at the start, a
`captionStyleId` — so nothing downstream learns what a brand kit is. That is what makes
"delete the kit and the applied items stay" true by construction rather than by bookkeeping,
and it is why the module returns a *plan* rather than mutating anything: the tests assert the
decisions without a timeline, a canvas or an ffmpeg binary.

**Every position is a percentage, and the margin is of the short side.** A kit designed on
16:9 is applied to a 9:16 project without moving the logo off-screen. Measured: the same kit's
logo is **129.6 px on both** a 1920×1080 and a 1080×1920 canvas, and its bottom-right corner
stays inside both. `custom` placements are deliberately *not* margins — they use the stored
percentages against each axis, because a point the user dragged to is a fraction of the width
and height, not a distance from an edge.

**Nothing is applied silently.** A missing asset or caption style produces a sentence in the
plan's `report` and the rest of the kit still applies. A part the user unchecked is not
reported at all — a checkbox that is off is not a failure.

**Mutations.** 8, all bite: the size and the margin each switched to the canvas width, a
`custom` placement treated as a corner, a missing asset skipped silently, a visibility window
running past the composition's end, the provenance filter ignoring the kit id, and unknown
fields dropped on import or not restored on export.

### Brand kits: applying one

**Applying is composing commands, not a command of its own kind.** `applyBrandKit` creates
image items through the same `createMediaItem` the media importer uses and writes
`captionStyleId` the way the inspector does; `removeKitItems` is an ordinary delete. A separate
module rather than a branch inside `commands.ts`, because the kit *is* a composition of the
timeline's existing operations, and keeping it beside them made the composition legible. Its
plan comes from `packages/brand-kits`, so the geometry is tested without a timeline and the
timeline is tested without the geometry.

**The applied item is an ordinary image item.** Not a special "kit logo" type: an `image`
media item on a `Brand kit` graphics track, with a full `transform` — position as a fraction of
the frame and the factory's rotation, anchor and flips intact. Measured: the kit's
bottom-right logo lands at `x 0.44375, y 0.4` of the frame on 1920×1080, which is the centre
of the 129.6 px box the placement maths produced. `scaleX`/`scaleY` stay at 1 by default and
`assetScale` is the separate, explicit step for fitting an asset of a known size into the
box — it returns 1 rather than `NaN`/0 when the asset has not been probed, because a logo at
zero scale draws nothing and looks like a bug in the kit.

**What makes reapply and detach possible is the tag on the item.** `aiProvenance:
{tool: 'brand-kit', kitId, appliedAt, version}` is written onto the item, not into a side
table, so it survives a save, a duplicate and a copy between projects. `appliedAt` is not
decoration: two applications of *the same kit* are told apart by it, which is what lets a
report name the items the current application created without a second bookkeeping pass.

**Reapply replaces, and covers both halves in one undo.** It removes the kit's items and then
applies, returning `removed` so the UI can say what it replaced. An undo that restored the
items but not the caption style would leave the project in a state the user never made.

**Detach is a deliberate one-way door.** It clears the tag and keeps the items. A later
reapply then leaves them alone and adds its own alongside — two logos, which is correct rather
than a bug: detaching means "this one is mine". That is asserted rather than described,
because it is the only kit operation that applying the kit again cannot undo, and it is the
one the UI has to confirm.

**Nothing is written where the user locked.** A caption on a locked track keeps its old style
and the rest of the kit applies — the same rule `setItemProperties` follows, tested here so
the two cannot drift apart. A text item that is not a caption is never restyled, even when its
id is named explicitly: the selection the UI passes is a request, and a mixed selection must
not turn a title into a caption.

**Mutations.** 12, all bite — and two only after the tests were strengthened. Removing the
centre subtraction, letting a locked track be written, accepting a plan with nothing to do,
leaving the previous application in place, removing without cleaning the track's `itemIds`,
detaching by deleting rather than untagging, `assetScale` returning zero, and dropping the
provenance tag or the opacity all failed a test immediately. Two survived first: with the
automatic caption path already filtering to `type === 'caption'`, the inner guard was only
load-bearing on the `captionItemIds` path, so the named list needed a non-caption in it; and
reapply filtered by `tool` alone produced the right *items* and the wrong `removed` count, so
the count for a two-kit project is asserted.

### Brand kits: an intro is an insert, not a placement

**The intro grows the project; it does not sit on top of it.** Dropping a two-second clip at
time 0 covers two seconds of the user's first shot. Pushing it to the nearest gap puts it at
some unrelated moment. So `insertKitClip` follows SPEC 09 §13.2's **Insert** mode: every item
at or after the insertion point moves right by exactly the new clip's duration. Measured: a
project with clips at 0 and 4 s and a caption at 1 s, after a 2 s intro, has them at 2 s, 6 s
and 3 s — the gaps are unchanged to the microsecond.

**It ripples every unlocked track, not just the main one.** An intro plays alone; if only the
main track moved, every caption, title, logo and music bed would slide two seconds earlier
against the picture. That is the one decision here the spec does not state outright, and it is
the difference between inserting an intro and damaging an edit. A **locked** track is skipped
rather than refused — the same rule the rest of the kit commands follow — even though that
means its clips end up under the intro; refusing would make "apply a kit" fail on any project
with a locked track.

**The outro appends and ripples nothing,** because it goes after everything. **A missing main
track is created,** magnetic, so a kit can be applied to an empty composition instead of
failing until the first import.

**The wrong aspect is a warning, not a refusal.** SPEC 13 §8 asks for "fit with the canvas
fill option and a warning": the clip is planned *and* a sentence names both sizes. The
comparison needs probed media, so a caller with none gets no invented warning, and the test
asserts both directions — a mismatched clip warns and still gets planned, a matching one and
an unprobed one say nothing. A **template** intro has no media to check and is carried as a
`compositionTemplateId`; the insert command refuses it rather than placing an empty clip,
because building a composition from a template is a separate feature and a silent empty item
would be the worst possible answer.

**Mutations.** 10, all bite. One needed a better value rather than a better test: mutating the
intro's start by one *frame* was detected, while the microsecond value I tried first was not —
because a 30 fps quantize rounds 33 µs to zero, making it an equivalent mutant, not a survivor.
That is worth recording: a mutation surviving is a question about whether the mutant is
*observable*, not only about whether the test suite is good.

### Brand kits: the logo stays out from under the buttons

**The safe-area preset moves corner graphics, and only corner graphics.** A bottom-right logo
on a vertical video sits exactly where TikTok's scrub bar and caption live. With a preset set,
the bottom corners move up by the bottom band and in by the action column, the top corners move
down by the top band, and `custom` placements are untouched — a point the user dragged to is a
considered position, not a margin, and moving it would be overriding them.

**The insets are added to the user's margin, not swapped for it.** The margin is their
distance from the edge; the band is where the platform's chrome begins. A logo respecting only
the safe area touches its boundary, one respecting only the margin sits under the buttons, and
the sum is the only position that satisfies both — with the box's own size still subtracted, so
the *box* is inside rather than its top-left corner.

**Landscape is left alone.** The numbers describe vertical chrome, and applying them to 16:9
would move a correctly placed logo for no reason — there is no top header or right-hand action
column in a landscape frame. `none`, the schema default, behaves exactly as it did before the
feature existed, which is what keeps a kit placed last year from moving on its next apply.

**The bands are duplicated on purpose, and pinned.** `assets/safe-areas.json` is the source of
truth for the *guides* the preview draws; this package carries a copy so it stays usable without
a bundled JSON file, and a test reads the JSON and compares every number. A guide tuned without
moving the copy — or the reverse — fails there rather than producing a logo outside the
rectangle the user was shown.

**Mutations.** 7 on this logic, 6 bite. The first run found a real hole: swapping the bottom
inset for the top one in the bottom-left corner passed every test, because only bottom-right was
covered; testing both bottom corners kills it. The survivor is an **equivalent mutant** — the
`preset === 'none'` guard can be deleted because the band record has no `none` entry and lookup
already returns `undefined`. Recording it matters as much as the kills: a mutation that cannot
change behaviour says nothing about the tests, and leaving it in the list as a "survivor" would
misrepresent the suite.

### Brand kits: the archive is a zip, and a real unzip says so

**The zip is written by hand, and the tests check it with `unzip` rather than with its own
reader.** A `.cwbrand` is `kit.json` plus the assets the kit names, under `<assetId>.<ext>`.
Writing it needed a container format, and this repository does not add a runtime dependency for
one; shelling out to `zip` was the other candidate and `zip` does not exist on a user's Windows
machine. The subset is three local headers, a central directory and an end record — forty lines
each way — and the reason to prefer it over a library is the *reader*: implemented against the
format, not against one library's idea of it.

**The tests open the archive with `unzip`.** Round-tripping through our own writer and reader
would pass with a wrong signature, a wrong CRC or a wrong central offset, because both halves
would be wrong in the same way. So the archive is listed with `unzip -Z1`, extracted with
`unzip -qq` and the extracted bytes compared, and a **flipped byte makes `unzip -t` fail** —
which is what proves the CRC is real rather than zero. A deflated archive made by `zip` is read
back too, because a kit may have been exported by another tool.

**Entries are stored, not deflated.** The payload is a JSON kit and a logo: PNGs are already
compressed, so the gain is small, and a stored entry has no deflate round trip to fail. The
*reader* accepts deflate anyway, through `DecompressionStream` — in every runtime this app runs
on — so a compressed archive from elsewhere opens without a hand-written inflater in the
package.

**A missing asset is reported, not fatal.** The archive is still written without it and the
caller gets `missingAssets`; on import the same list is computed by matching the id prefix, so
a kit whose logo went missing can still be opened, edited and applied. A kit imported from a
clean workspace — nothing left on disk to be found by accident — compares equal to the original,
with assets attached.

**Those tests say which tool they need, and skip with a reason when it is absent.** CI runs on
Windows, where `unzip` exists (it ships with Git) and `zip` does not. The first version of this
file assumed both and failed a build with `spawnSync zip ENOENT` — an environment difference,
not a defect, and a test that fails for one is a test that will be deleted by whoever hits it
next. Each binary-dependent test now declares its tool and skips without it; the deflated-read
path moved to a fixture built from Node's `zlib` and raw headers, so **the compressed path is
covered on every platform** while the third-implementation check runs where `zip` exists.
Verified both ways: 21 tests run with the tools present, 6 skip without them.

**Mutations.** 11, all bite: the final CRC inversion, the table index, the central-directory
offset, a zeroed compressed size, the duplicate and unsafe-path guards, deflated reads, the
missing-asset report, a template counted as an asset, skipping `importBrandKit`, and the
extension sniff. The CRC ones are the pointed ones — a wrong checksum still yields a file that
this reader would happily read, and only `unzip -t` notices.

### Brand kits: capturing one from the clip in front of you

**The clip already is the kit; this reads it back out.** `captureKitFromClip` takes the items,
the tracks the user selected, the canvas and the resolved caption style, and returns a kit plus
a list of what it could not take. The distinction that shapes the whole module is between
*facts* (a caption's `captionStyleId`, a fill colour, a font family, an image's `mediaId`) and
*judgements* (which corner an item "means", what percentage of the short side it occupies).
Only facts are read; where a judgement would be invented, the module writes a sentence instead.

**Geometry is measured back into the kit's own units, which is the part that matters.** An image
at `x 0.44375` on 1920×1080 is a box 12% of the short side, 4% in from the right edge. The
captured kit stores those percentages, so re-applying it to a 1080×1920 canvas puts the box at
12% of *that* short side and 4% in from *its* right edge — asserted in the test, because a
capture that stored pixels would be a kit that only works on the clip it came from.

**The middle of the frame is not a corner.** A corner is the outer third of both axes; without
that rule the portrait in the centre of the frame becomes the kit's logo and is pasted into a
corner on every clip the kit is applied to. The nearest qualifying item wins when two are near.

**Colours and the font come from the resolved style, mapped, not guessed.** The fill is the
kit's `text`, the highlight is its `accent`, the background is its `background`; `primary` and
`secondary` have no counterpart in a caption style, so they take the text colour rather than a
brand colour derived from an outline. With **no style there is nothing to map** and the kit gets
black and white — a kit the user edits knowingly, rather than one that looks finished. The
caption font crosses over without its size, because size belongs to the style, and a captured
size would fight the style the kit is applied with.

**What it cannot take, it says.** No captions; a style id that could not be resolved (SPEC 13
§8.3's missing-font case one step earlier); text and shape items, which the kit's schema has no
field for yet; a logo that started part-way through, since a kit has no "appear at 4 s". Eleven
notes exist in all, and each one is a place the alternative was a silent guess.

**Mutations.** 11, all bite — after three were fixed by better fixtures. The margin was only
tested on a right-hand corner, so measuring a **left** one from the y centre passed everything;
a fixture where the two distances differ (43.2 px against 54 px) now catches it. A style
supplied *without* a caption to bind it to was taken anyway, colouring the kit from the wrong
look. And a media-less image nearer the corner than the real logo won the race and produced a
kit with no asset — the schema requires one — so the fixture now has both.

### Brand kits: the screen

**The panel is a tab in the library, and everything it does is already tested.** `BrandKitPanel`
lists a project's kits with their swatches, says how many items each has placed, and offers
apply, reapply, detach, remove and delete. The decisions are in pure exported functions —
`canApply`, `planSummary`, `kitFootprint`, `applyKitCommand` — so the tests check them without a
DOM, and the JSX is thin enough that the component tests only have to prove the wiring.

**Apply is one undo step for four commands.** `timeline.run` takes one command; a kit
application is graphics plus captions plus an intro plus an outro. They are composed into one
closure that rebuilds a patch set from before-and-after, because each command's own patches
describe only its share of the change. **Both directions are asserted** — the first version of
the test only exercised the inverse, so a patch set full of *before* values undid correctly and
then redid the project to the state it was already in. `run` applies `patches` on redo, and a
test now redoes.

**The Apply button is decided by planning, not by inspection.** A kit with a logo that is not in
this project would light up a button that then does nothing, so `canApply` builds the plan and
asks whether any part survived. Unchecking a part disables the button for a kit whose only part
that was — correct, and the plan's report says why.

**Deleting a kit says what happens to its items.** The confirm text is a sentence, not a
warning triangle: the items stay, only the kit goes. It is the one thing that stops a user
keeping a kit they have outgrown because they fear the timeline losing its logo.

**The composition's length is `projectDurationUs`, the ruler's own function.** Not a local
`max` over every item — that would disagree for a project whose last clips are on a hidden
track, and the symptom would be a `showFor: 'whole'` logo running past the visible end. A test
pins the difference (eight seconds against one) so the two cannot be swapped back.

**Mutations.** 10 on the panel, all bite after two were fixed. `kitFootprint` survived because
the fixture had no applied items at all — it returned zero either way — and the redo direction
above was untested. The rest were immediate: the parts ignored, the assets ignored, the inverse
reversed, `null` never returned, the affected ids emptied, and the settings reader accepting a
malformed kit or keying by the object's id rather than the map's.

### Brand kits: the editor

**A form cannot hold a `BrandKit`, so it holds a draft.** The schema requires a logo to have an
asset id and a placement to have six numbers; a user is entitled to be halfway through choosing
them. `brand-kit-draft.ts` holds strings and switches, and `draftToKit` is the boundary — which
is what makes the interesting cases testable without a DOM, and what lets the form collect
**every** problem at once rather than failing one field per press of Save.

**A part switched on with nothing chosen is a problem, not an omission.** The user said they
wanted a logo; a kit that quietly left it out would apply everything except the thing they turned
on. The message names both halves — "choose a logo image, or switch it off" — so the fix is
obvious. A part switched *off* leaves no key at all, so the plan has nothing to report.

**The schema is the last word, not the first.** The form's own checks produce messages about
controls; `brandKitSchema.safeParse` catches what they miss. The custom-colour cap is the one
place both say the same thing — 8 — which was confirmed by deleting the form's check and watching
every test still pass: an **equivalent mutant**, recorded rather than papered over with a
contrived test.

**Editing round-trips, with one honest exception.** `draftFromKit` → `draftToKit` returns a kit
equal to the original for every field the form shows. A `custom` placement is the exception: the
form has four corners and no way to express a dragged point, so it shows the nearest corner and
keeps the size and margin. That is a limit of the form, stated here rather than discovered as
silent data loss.

**"From this clip" fills the fields and shows what it could not take.** The capture's notes are
rendered above the form, not in a toast the dialog would cover: a user who pressed the button and
saw no colours needs to read *why* right where the colours are. The capture replaces the fields it
knows about and leaves the rest of the draft alone — a name already typed survives, and a chosen
watermark is not wiped by a capture that has nothing to say about watermarks.

**A bug the tests caught: the editor was unreachable from the empty state.** The first draft
returned early when a project had no kits, so the "New kit" button on the only screen such a
project has opened nothing — and it is the one place creating a kit has to work. The dialogs are
now one element rendered by both branches.

**Mutations.** 12 on the draft, 11 biting; 10 on the panel. The two that needed better tests were
an unvalidated intro length (the schema would have caught it, but with a message about a field the
form calls "Seconds") and a footprint fixture with no applied items.

### Brand kits: a missing font substitutes, and keeps its character

**"Substitute and flag" is the spec's rule, and both failures are tempting.** Refusing a kit
because one family is absent makes a shared `.cwbrand` unusable on most machines; substituting in
silence puts a caption in the wrong typeface with nothing to explain it. So `substituteFont`
returns a usable `FontRef` **and** a sentence naming both families, in the spec's own wording
("Font missing: <name>…"), because a user told only that something is wrong cannot judge whether
the result is acceptable or ask for something else.

**The substitute is chosen by character, not by name.** The bundled families carry a coarse
attribute — sans, serif, condensed, display, script, mono — and a kit asking for Playfair Display
falls back to Lora rather than Inter. The alternative is a serif poster turned into a modern sans,
which is a different design rather than a substitute. A catalogue with no family of the right
character says so rather than claiming a similarity it does not have.

**A present family's weight is rounded without a warning.** SPEC 11 §10.1 says the nearest weight
is used; it is a normal condition, not a fault. It still has to be a weight the font has, because
a canvas `font` string asking for 900 on a family that ships 700 is replaced by the browser and
the result is not what the kit said. Ties go to the **heavier** one — a caption set at 700 is meant
to look bold, and rounding down makes it look like a mistake.

**Through the plan, the warnings reach the user.** `planKitApplication` resolves the kit's fonts
when the caller supplies a catalogue and appends the sentences to `report`; the resolved fonts ride
on the plan so a caller applying text styles does not resolve them a second time and possibly
differently. Deduplicated: a kit that names one missing family for all three slots produces **one**
banner, because three identical sentences is the kind of warning users learn to scroll past.

**Two guards that exist to stop false alarms.** No catalogue means no check — a caller that has
not loaded the font list gets no warning rather than one invented from an empty one. And fonts
belong to the `textDefaults` part, so an apply with text defaults switched off reports nothing
about fonts at all.

**Mutations.** 11 on the module, 10 bite. The first run found a real gap: nothing asserted the
*weight* of a present family was rounded, so a version that returned the request unchanged passed
every test — exactly the mutation whose symptom would be a caption that looks subtly wrong for no
stated reason. One test also failed on first run and was right to: Oswald was listed as a fallback
but had no character, so it was unreachable. **A family nobody describes can never be chosen**,
which is the sort of dead entry a table like this grows quietly.

**Not built yet, and deliberately not claimed:** building a composition from a
`compositionTemplateId`. It is recorded in `docs/limitations.md` rather than half-wired into
the app.

### Batch apply: one kit, every clip, one way back

**"All clips" did nothing before this.** The scope control changed a sentence and the apply
button always applied to the composition being edited, so choosing "All clips" produced exactly
one branded clip. It was not a broken path — there was no path. The feature is now real: every
clip in the project is read, planned, applied, and written.

**The other clips are documents this window never loaded.** That single fact produces every
hard decision in `kit-batch.ts`. Their lengths are **projected**, not measured: an intro's footer
shifts everything after it, so the estimate is deliberately a conservative over-estimate built
from the media each item names — a still gets a second, an unknown asset four — because an outro
that lands slightly after the content is a small bug while an outro on top of the first frame is
a broken clip. The next editor re-plans with the real duration; this figure only has to be good
enough to *place* the item.

**Only ids this window can see are offered to the plan.** A foreign clip's payload names media
that may not be in this window's library, and claiming one is present because a different project
once had that id would place a graphic the next editor cannot find — precisely the failure the
plan's `report` exists to prevent. So the kit's own assets are offered and nothing else, and a
missing logo produces the plan's sentence instead of a phantom item.

**The batch is all-or-nothing, and that is structural.** `applyKitToClips` does no I/O: every
clip is planned and applied before the caller touches a file, so a clip that refuses stops the
whole batch. The refusal that tests this is real and is the spec's own "planned and then
refused" case — a `compositionTemplateId` intro, which the engine will not build as a clip yet.
Treating that refusal as "nothing to do" was a bug this slice found: it would have left one clip
without its intro while the batch reported success, which is the silent half-application the
function exists to prevent.

**One application, two undo routes.** The open clip goes through `timeline.run`, so `Ctrl+Z`
undoes it like any other edit; the other clips have no history in this window at all — theirs
belongs to whichever editor opens them next. So the batch keeps every other clip's *previous*
payload and offers **Undo batch**, naming how many clips it would restore. Keeping the open clip
out of that record is what stops one press from undoing half of one application, and the test
asserting the *ids* in `previous` rather than a count is what pins it — the first version of that
fixture had a document id that did not match the stored record, which silently classified the
open clip as a foreign one, and the count caught it.

**Skipped is not failed.** A clip the kit has nothing to say to — captions only, and the kit has
no caption style — is reported as skipped and named, because aborting a five-clip batch over the
clip the user just made is the wrong answer, and "3 clips skipped" leaves them to guess which
three. The same reasoning runs the other way for a *report*: the sentences are folded by text, so
a kit whose logo is missing says so once and lists the clips it concerns, rather than printing
five identical banners.

**"Nothing to apply" is not a sentence — it is the absence of one.** When a batch applies
nothing, the panel now shows the plan's explanation (the logo is missing, the caption style is
not installed) rather than the bare conclusion, because the explanation is the only part a user
can act on.

**"Selected clips" is absent, not disabled.** SPEC 13 §8.2 lists three scopes; choosing several
clips needs a bin to choose them in, and this build has none. A control that looks like it
widens the scope while applying to the same single clip is the quiet lie the rest of this panel
refuses to tell, so the option is gone until it can work, and the scope list is asserted as a
contract so it cannot come back half-wired.

**Mutations.** 12 on the batch module, all biting after two fixes. Ten died immediately — the
projection's still duration, the hidden-track filter, the all-or-nothing early return, the
current-clip exemption in `previous`, the fold by text, the template refusal, the progress index,
the dropped reports, the error branch and `revertBatch`'s direction. **Two survived, and both
were missing tests rather than equivalents.** Counting a successful-but-unchanged application as
applied is the defect this slice had already fixed by hand — a kit's caption style on a clip with
no captions plans fine, runs `applyBrandKit`, and immer returns the *same* state — and nothing
pinned it; the new test uses exactly that case. And the plural ("1 clip", not "1 clips") is
read above the kit list on every batch, so it is asserted on the rendered sentence rather than
on an internal.

### Brand kits travel as a file

**The export path had nowhere to get asset bytes, and that is the feature.** A `.cwbrand` archive
contains the kit's logos and intro, so exporting needs their bytes; a media id is not a path, and
no bridge call returns bytes for one — by design. The first implementation passed
`{assetId, data}` down from the panel and was deleted rather than accommodated: the whole bridge
exists so the renderer cannot reach the filesystem. Main now shows the save dialog, resolves each
id through `storage.getMedia(id).path`, reads it, and writes the archive. The renderer names a
kit; nothing else crosses.

**The dialog is shown before the archive is built.** Building first would read every logo off disk
for a user who then cancels — and a malformed kit would throw before they had chosen a destination
at all. The handler now asks, then does the work.

**Cancelling is not an outcome.** The bridge returns `null`, the panel sets no notice, and the
suite asserts no status line appears — not even "Export cancelled." A cancelled save is what the
user asked for; a message under the kit a second later reads as a failure they have to interpret.
A second test covers the browser case: with no bridge, the button does nothing at all.

**A missing asset is named, and the file is still written.** `fetchAsset` answers `undefined` for a
media record that is gone or a file that will not open; the archive records the id in
`missingAssets` and the panel says which. Both halves matter: throwing would let one unplugged
drive stop a complete export, and silence would hand the recipient a kit pointing at a picture it
does not contain. Tested on the export side (`missingAssets: ['logo.png']`) and the import side
(`missingAssets: ['intro.mp4']`).

**The extension is added when the user does not type it.** Electron returns the typed name
unchanged, so `Studio` would produce a file no machine offers to open. Main appends `.cwbrand`. The
panel's test asserts it *asks* for `Studio.cwbrand` as the default name, which is the half a renderer
test can observe.

**Import is an add.** A kit whose id is already in the project is re-minted through `mintKitId` to
`<name>-imported` rather than overwritten: overwriting would move every item the existing kit had
placed onto the new kit's provenance, and provenance is what delete, reapply and the origin label
all key on. Asserted on the *saved kit's id*, not on the notice — the notice says "Imported"
either way, so a check on the message would pass against a replace.

**A wrong file is explained, not crashed on.** `tryParseBrandKit` runs on what main returns, and its
own summary names the field at fault; the test feeds `{ name: 42 }` and asserts a message *and*
that `save` was never called. And because Electron prefixes IPC rejections with
`Error invoking remote method 'brandKit:import': Error:`, the panel routes through `describeError` —
the test asserts the notice is exactly the inner sentence, with the wrapper gone.

**Import is reachable from the empty state.** A project with no kits is the one that most needs to
import one, and the first draft put Import only above the cards — the same shape as the earlier
bug where a shared dialog rendered in one branch only. The button and the status line now sit above
the branch, and a test renders the empty state and finds the button there.

**Mutations.** 19 were run against the arc maths, the parser, the tokeniser and the wiring;
all bite. Two survived the first pass and were resolved rather than left: a `largeArc` delta
correction was proven unreachable (the centre sign rule already yields 60° for a small arc and
300° for a large one) and **removed as dead code**; the exact-endpoint substitution was a real
guard whose test was too loose at 12 decimal places, and is now pinned at exact equality.
A third apparent survivor — the empty-icon guard — was proven to produce a byte-identical
result to the single exit, so the duplicate path was removed.
