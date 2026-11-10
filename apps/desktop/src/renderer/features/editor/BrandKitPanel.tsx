/**
 * SPEC 13 §8.2 — the brand-kit list and the apply controls.
 *
 * The screen this feature has been missing. Everything it shows comes from packages that are
 * already tested: `planKitApplication` decides what a kit would do, the `applyBrandKit` family
 * performs it, and this file is the part that lets a person choose.
 *
 * Two rules shape it, both from the spec and both worth stating because they are what the
 * screen *refuses* to do:
 *
 * - **Nothing here is a teaser.** Every control works or is absent. The parts checkboxes are
 *   the kit's own `KitApplyParts`, the apply button reports the plan's `report` sentences when
 *   a part could not be applied, and the absence of an export button is because the file picker
 *   lives in the main process — which is recorded as a limitation rather than drawn disabled.
 * - **Deleting a kit does not touch the timeline.** The confirm text says so, because the
 *   alternative is a user who never deletes a kit they have outgrown for fear of losing the
 *   work it placed.
 *
 * All the decision-making is in pure exported functions so the JSX stays thin and the tests do
 * not need a DOM to check the parts that matter.
 */
import React, { useMemo, useState } from 'react';
import { Layers, Pencil, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { Button, Card, Chip, Dialog, EmptyState, SegmentedControl, Toggle } from '@clipwright/design-system';
import {
  ALL_KIT_PARTS,
  findKitAppliedItems,
  planKitApplication,
  type BrandKit,
  type CapturableItem,
  type CapturableStyle,
  type KitApplyParts,
  type KitApplicationPlan,
} from '@clipwright/brand-kits';
import {
  applyBrandKit,
  detachKitItems,
  insertKitClip,
  projectDurationUs,
  reapplyBrandKit,
  removeKitItems,
  type TimelineState,
} from '@clipwright/timeline-engine';
import type { TimelineApi } from './use-timeline.js';
import type { BrandKitsApi } from './use-brand-kits.js';
import { BrandKitEditor, type EditorMediaOption } from './BrandKitEditor.js';

/** What the apply button covers: the spec's "This clip · Selected clips · All clips". */
export type ApplyScope = 'this-clip' | 'selected-clips' | 'all-clips';

export const APPLY_SCOPES: Array<{ id: ApplyScope; label: string }> = [
  { id: 'this-clip', label: 'This clip' },
  { id: 'selected-clips', label: 'Selected' },
  { id: 'all-clips', label: 'All clips' },
];

/*
  The composition's length is `projectDurationUs`, the same function the ruler and fit-to-project
  use. A second definition here would drift from the one the user sees, and the first symptom
  would be a `showFor: 'whole'` logo stopping early on a project whose last track is hidden.
*/

/** Whether a kit has anything to apply to the tracks the user selected, for the button state. */
export function canApply(
  kit: BrandKit,
  state: TimelineState,
  parts: KitApplyParts,
  canvas: { widthPx: number; heightPx: number },
  captionStyleIds: ReadonlySet<string>,
  assetIds: ReadonlySet<string>,
): boolean {
  /*
    Asked by *planning*, not by inspecting the kit: the plan is the function that knows a
    missing asset turns a part into a sentence, so a button enabled on "the kit has a logo"
    would light up for a kit whose logo is not in this project.
  */
  const plan = planKitApplication(kit, canvas, projectDurationUs(state), { assetIds, captionStyleIds }, parts);
  return (
    plan.logo !== undefined ||
    plan.watermark !== undefined ||
    plan.lowerThird !== undefined ||
    plan.captionStyleId !== undefined ||
    plan.intro !== undefined ||
    plan.outro !== undefined ||
    plan.music !== undefined
  );
}

/** A sentence or two about what applying would do, for the "before" half of the preview. */
export function planSummary(plan: KitApplicationPlan): string[] {
  const lines: string[] = [];
  if (plan.captionStyleId) lines.push('Caption style applied to the captions in range.');
  if (plan.logo) lines.push('Logo placed from the kit’s percentages.');
  if (plan.watermark) lines.push('Watermark placed.');
  if (plan.lowerThird) lines.push('Lower third inserted.');
  if (plan.intro) lines.push(`Intro inserted at the start (${Math.round(plan.intro.durationUs / 100_000) / 10}s).`);
  if (plan.outro) lines.push(`Outro appended at the end (${Math.round(plan.outro.durationUs / 100_000) / 10}s).`);
  if (plan.music) lines.push('Music bed added with the kit’s ducking.');
  return lines;
}

/** The ids of the items this kit made, so a kit's row can say what it has done here. */
export function kitFootprint(state: TimelineState, kitId: string): { count: number; itemIds: string[] } {
  const items = findKitAppliedItems(Object.values(state.items), kitId);
  return { count: items.length, itemIds: items.map((item) => item.id) };
}

/**
 * Apply a kit as one undo step, including the intro/outro inserts.
 *
 * `timeline.run` takes one command, and a kit application is several — graphics, captions,
 * an intro, an outro — so they are composed here into a single closure. That matters: the
 * engine gives each *command* an undo step, and an application that took four of them would
 * need four presses of Ctrl+Z to undo one decision.
 */
export function applyKitCommand(
  kit: BrandKit,
  parts: KitApplyParts,
  options: {
    canvas: { widthPx: number; heightPx: number };
    fps: 30 | 60;
    captionStyleIds: ReadonlySet<string>;
    assetIds: ReadonlySet<string>;
    captionItemIds?: string[];
    reapplying?: boolean;
    now?: () => string;
  },
) {
  return (state: TimelineState) => {
    const appliedAt = (options.now ?? (() => new Date().toISOString()))();
    const plan = planKitApplication(
      kit,
      options.canvas,
      projectDurationUs(state),
      { assetIds: options.assetIds, captionStyleIds: options.captionStyleIds },
      parts,
    );
    const base = {
      kit,
      plan,
      canvas: options.canvas,
      fps: options.fps,
      appliedAt,
      ...(options.captionItemIds && options.captionItemIds.length > 0
        ? { captionItemIds: options.captionItemIds }
        : {}),
    };

    let current = state;
    /*
      Reapply runs first because it both removes the previous application and applies the new
      one; running an ordinary apply before it would create the items that reapply then throws
      away. An apply with nothing to do is not an error here — the caller decided to press the
      button, and the plan's report explains an empty result.
    */
    const graphics = parts.logo || parts.captions || parts.lowerThird;
    if (graphics || options.reapplying) {
      const result = options.reapplying
        ? reapplyBrandKit(current, base)
        : applyBrandKit(current, base);
      if (result.ok) current = result.state;
      else if (result.code !== 'invalid') return result;
    }

    if (parts.introOutro) {
      for (const kind of ['intro', 'outro'] as const) {
        const clip = plan[kind];
        if (!clip) continue;
        const inserted = insertKitClip(current, {
          kind,
          clip,
          fps: options.fps,
          appliedAt,
          kit,
          compositionEndUs: projectDurationUs(current),
        });
        if (inserted.ok) current = inserted.state;
      }
    }

    if (current === state) return null;
    /*
      The closure hands back the *last* command's patches, which no longer describe the whole
      change — so the undo step is rebuilt from the two states, the way a composed command has
      to be. `produceWithPatches` is what `run` expects: patches forward, inverse back.
    */
    return asCommandResult(state, current);
  };
}

/**
 * Turn "before and after" into the `CommandResult` `timeline.run` needs.
 *
 * A composed command has no single patch set of its own, so this produces a coarse one: the
 * items that appeared or changed. It is deliberately *not* a diff library — the history only
 * needs enough to undo and redo, and a whole-payload patch is correct even when it is larger
 * than a minimal one.
 */
function asCommandResult(before: TimelineState, after: TimelineState) {
  const changed = Object.keys(after.items).filter((id) => before.items[id] !== after.items[id]);
  const removed = Object.keys(before.items).filter((id) => after.items[id] === undefined);
  return {
    ok: true as const,
    state: after,
    patches: [
      { op: 'replace' as const, path: ['items'], value: after.items },
      { op: 'replace' as const, path: ['tracks'], value: after.tracks },
    ],
    inverse: [
      { op: 'replace' as const, path: ['items'], value: before.items },
      { op: 'replace' as const, path: ['tracks'], value: before.tracks },
    ],
    affectedItemIds: [...changed, ...removed],
    notes: [] as string[],
  };
}

/** How many kit cards the panel shows before offering "Show more". */
const PAGE_SIZE = 6;

/** One kit card: swatches, what it does, and the actions. */
function KitCard({
  kit,
  state,
  onApply,
  onRemove,
  onDetach,
  onDelete,
  onEdit,
}: {
  kit: BrandKit;
  state: TimelineState;
  onApply: () => void;
  onRemove: () => void;
  onDetach: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const footprint = useMemo(() => kitFootprint(state, kit.id), [state, kit.id]);
  const swatches = [kit.colors.primary, kit.colors.secondary, kit.colors.accent, kit.colors.background];
  return (
    <Card style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <div aria-hidden style={{ display: 'flex', gap: 2 }}>
          {swatches.map((colour, index) => (
            <span
              key={`${colour}-${index}`}
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: colour,
                border: '1px solid var(--line-subtle)',
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, flex: 1 }}>{kit.name}</span>
        {footprint.count > 0 && (
          <Chip variant="neutral">{footprint.count === 1 ? '1 item' : `${footprint.count} items`}</Chip>
        )}
      </div>
      {footprint.count > 0 ? (
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          <Button size={28} variant="secondary" onClick={onApply}>
            Reapply
          </Button>
          <Button size={28} variant="ghost" onClick={onDetach}>
            Detach
          </Button>
          <Button size={28} variant="ghost" onClick={onRemove}>
            Remove items
          </Button>
        </div>
      ) : (
        <Button size={28} variant="secondary" onClick={onApply}>
          Apply…
        </Button>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
        <Button size={28} variant="ghost" onClick={onEdit} aria-label={`Edit ${kit.name}`}>
          <Pencil size={12} /> Edit
        </Button>
        <Button size={28} variant="ghost" onClick={onDelete} aria-label={`Delete ${kit.name}`}>
          <Trash2 size={12} /> Delete
        </Button>
      </div>
    </Card>
  );
}

export function BrandKitPanel({
  state,
  timeline,
  brandKits,
  canvas,
  captionStyleIds,
  assetIds,
  media,
  captionStyle,
  captureItems,
}: {
  state: TimelineState;
  timeline: TimelineApi;
  brandKits: BrandKitsApi;
  canvas: { widthPx: number; heightPx: number };
  captionStyleIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
  /** The media library, for the logo and intro pickers. */
  media: readonly EditorMediaOption[];
  /** The caption style in play, so a capture can take real colours and a font. */
  captionStyle?: CapturableStyle;
  /** The items a capture reads. Defaults to the whole composition. */
  captureItems?: readonly CapturableItem[];
}) {
  const [scope, setScope] = useState<ApplyScope>('this-clip');
  const [parts, setParts] = useState<KitApplyParts>(ALL_KIT_PARTS);
  const [applying, setApplying] = useState<BrandKit | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<BrandKit | null>(null);
  /*
    `null` is closed, `{ kit }` is editing that kit, `{}` is creating one. One state rather than
    a boolean plus an optional kit, because "open with no kit" and "closed with no kit" would
    otherwise be the same value.
  */
  const [editing, setEditing] = useState<{ kit?: BrandKit } | null>(null);
  /*
    Kits are shown a page at a time because a project can accumulate dozens, and a left panel
    with forty cards in it is worse than one with a button. The count grows; nothing is hidden
    permanently.
  */
  const [shown, setShown] = useState(PAGE_SIZE);

  const plan = useMemo(
    () =>
      applying
        ? planKitApplication(
            applying,
            canvas,
            projectDurationUs(state),
            { assetIds, captionStyleIds },
            parts,
          )
        : null,
    [applying, canvas, state, assetIds, captionStyleIds, parts],
  );

  const runApply = (kit: BrandKit) => {
    const reapplying = kitFootprint(state, kit.id).count > 0;
    const command = applyKitCommand(kit, parts, {
      canvas,
      fps: timeline.fps,
      captionStyleIds,
      assetIds,
      reapplying,
    });
    const label = reapplying ? 'Reapply brand kit' : 'Apply brand kit';
    timeline.run(label, command);
    setApplying(null);
  };

  if (brandKits.loading) {
    return <div style={{ padding: 'var(--space-2)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>Loading kits…</div>;
  }

  /*
    The editor and the delete confirm are one element shared by **both** branches below. A first
    draft put them only in the list branch, so the "New kit" button in the empty state opened
    nothing at all — the one screen a project with no kits has, and the one place creating a kit
    must work.
  */
  const dialogs = (
    <>
      {editing && (
        <BrandKitEditor
          open
          {...(editing.kit ? { initial: editing.kit } : {})}
          media={media}
          takenIds={new Set(brandKits.kits.map((entry) => entry.id))}
          {...(captureItems ? { captureFrom: { items: captureItems, canvas } } : {})}
          {...(captionStyle ? { captionStyle } : {})}
          onCancel={() => setEditing(null)}
          onSave={(kit) => {
            void brandKits.save(kit);
            setEditing(null);
          }}
        />
      )}
      {confirmingDelete && (
        <Dialog
          open
          title={`Delete “${confirmingDelete.name}”?`}
          onClose={() => setConfirmingDelete(null)}
          footer={
            <>
              <Button size={28} variant="ghost" onClick={() => setConfirmingDelete(null)}>
                Cancel
              </Button>
              <Button
                size={28}
                variant="primary"
                onClick={() => {
                  void brandKits.remove(confirmingDelete.id);
                  setConfirmingDelete(null);
                }}
              >
                Delete kit
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--fs-sm)' }}>
            The items this kit placed on the timeline stay where they are. Only the kit itself is
            deleted, so you can no longer apply it again.
          </p>
        </Dialog>
      )}
    </>
  );

  /* A project with no kits says what a kit is for, and offers a way to make one. */
  if (brandKits.kits.length === 0) {
    return (
      <div style={{ padding: 'var(--space-2)' }}>
        <EmptyState
          icon={<Layers size={20} />}
          title="No brand kits yet"
          explanation="A kit holds a caption look, colours, a logo and an intro. Make one from the clip you are editing, and applying it puts the same branding on every clip."
        />
        <Button size={28} variant="secondary" onClick={() => setEditing({})}>
          <Plus size={12} /> New kit
        </Button>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          Kits are stored with this project, so they travel with it and are not shared between
          projects yet.
        </p>
        {brandKits.error && (
          <p role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--danger)' }}>
            {brandKits.error}
          </p>
        )}
        {dialogs}
      </div>
    );
  }

  const visible = brandKits.kits.slice(0, shown);
  const hidden = brandKits.kits.length - visible.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-2)', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <Sparkles size={14} aria-hidden />
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, flex: 1 }}>Brand kits</span>
        <Button size={28} variant="ghost" onClick={() => setEditing({})} aria-label="New brand kit">
          <Plus size={12} /> New
        </Button>
      </div>

      {applying ? (
        <Card style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>Apply “{applying.name}”</span>
          <SegmentedControl
            options={APPLY_SCOPES.map((entry) => ({ value: entry.id, label: entry.label }))}
            value={scope}
            onChange={setScope}
            ariaLabel="What to apply the kit to"
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(
              [
                ['captions', 'Caption style'],
                ['logo', 'Logo / watermark'],
                ['introOutro', 'Intro / outro'],
                ['lowerThird', 'Lower third'],
                ['music', 'Music + ducking'],
                ['textDefaults', 'Text fonts / colours'],
              ] as Array<[keyof KitApplyParts, string]>
            ).map(([key, label]) => (
              <Toggle
                key={key}
                checked={parts[key]}
                onChange={(checked) => setParts((current) => ({ ...current, [key]: checked }))}
                label={label}
              />
            ))}
          </div>
          {plan && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {planSummary(plan).map((line) => (
                <span key={line}>{line}</span>
              ))}
              {plan.report.map((line) => (
                <span key={line} role="status" style={{ color: 'var(--warning)' }}>
                  {line}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <Button
              size={28}
              variant="secondary"
              onClick={() => runApply(applying)}
              disabled={!canApply(applying, state, parts, canvas, captionStyleIds, assetIds)}
            >
              <Wand2 size={12} /> Apply
            </Button>
            <Button size={28} variant="ghost" onClick={() => setApplying(null)}>
              Cancel
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            {scope === 'all-clips'
              ? 'All clips means this composition: a kit is applied to the clip you are editing, and the timeline is where the other clips live.'
              : 'Applied items are ordinary timeline items — they stay if you delete the kit.'}
          </p>
        </Card>
      ) : null}

      {visible.map((entry) => (
        <KitCard
          key={entry.id}
          kit={entry}
          state={state}
          onApply={() => setApplying(entry)}
          onRemove={() => timeline.run('Remove kit items', (current) => removeKitItems(current, entry.id))}
          onDetach={() => timeline.run('Detach kit items', (current) => detachKitItems(current, entry.id))}
          onDelete={() => setConfirmingDelete(entry)}
          onEdit={() => setEditing({ kit: entry })}
        />
      ))}

      {hidden > 0 && (
        <Button size={28} variant="ghost" onClick={() => setShown((count) => count + PAGE_SIZE)}>
          Show {hidden} more
        </Button>
      )}

      {dialogs}
    </div>
  );
}
