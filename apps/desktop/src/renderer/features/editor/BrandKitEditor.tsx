/**
 * SPEC 13 §8.2 — the kit form: New kit (from scratch or *from the current clip*), Edit.
 *
 * A dialog over the draft in `brand-kit-draft.ts`. The form holds strings and numbers because a
 * user is allowed to be halfway through a choice; `draftToKit` is what turns that into a
 * validated kit, and it collects *all* the problems so Save does not become a one-error-at-a-time
 * guessing game.
 *
 * Two entry points, and the difference between them is the whole reason capturing exists:
 *
 * - **From scratch** starts at `emptyDraft`, with every optional part switched off.
 * - **From this clip** starts at `draftFromKit(captureKitFromClip(...))` — the caption style,
 *   colours, font and a measured corner image, already filled in. The capture's `notes` are
 *   shown above the form rather than in a toast, because they explain fields the user is about
 *   to look at.
 */
import React, { useMemo, useState } from 'react';
import { Button, ColourPicker, Dialog, Input, Select, Toggle } from '@clipwright/design-system';
import {
  BRAND_KIT_MAX_CUSTOM_COLOURS,
  DEFAULT_KIT_COLOURS,
  captureKitFromClip,
  type BrandKit,
  type CapturableItem,
  type CapturableStyle,
} from '@clipwright/brand-kits';
import {
  draftFromKit,
  draftToKit,
  emptyDraft,
  mintKitId,
  type DraftProblem,
  type KitDraft,
} from './brand-kit-draft.js';

const POSITIONS = [
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' },
] as const;

const SAFE_AREAS = [
  { value: 'none', label: 'None' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'reels', label: 'Reels' },
  { value: 'shorts', label: 'Shorts' },
] as const;

/** An image or video in the media library, as the pickers need it. */
export interface EditorMediaOption {
  id: string;
  label: string;
  kind: 'video' | 'audio' | 'image';
}

/** The fields a problem is about, for marking them. Exported so a test can check the mapping. */
export function problemFor(problems: readonly DraftProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-sm)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {children}
      {error && (
        <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>
          {error}
        </span>
      )}
    </label>
  );
}

export function BrandKitEditor({
  open,
  initial,
  media,
  takenIds,
  captureFrom,
  captionStyle,
  onCancel,
  onSave,
}: {
  open: boolean;
  /** The kit being edited, or `undefined` for a new one. */
  initial?: BrandKit;
  media: readonly EditorMediaOption[];
  /** Ids already used by other kits, so a new one cannot collide. */
  takenIds: ReadonlySet<string>;
  /**
   * When present, the "From this clip" button is offered: the items and canvas the capture
   * reads. Absent means there is no clip to capture from and the button is not drawn — an
   * unfinished option shown disabled is the teaser `specs/13` §2 forbids.
   */
  captureFrom?: { items: readonly CapturableItem[]; canvas: { widthPx: number; heightPx: number } };
  /** The resolved style, so a capture can take real colours and a font. */
  captionStyle?: CapturableStyle;
  onCancel: () => void;
  onSave: (kit: BrandKit) => void;
}) {
  const [draft, setDraft] = useState<KitDraft>(() =>
    initial ? draftFromKit(initial) : emptyDraft(mintKitId('new-kit', takenIds)),
  );
  const [problems, setProblems] = useState<DraftProblem[]>([]);
  const [captureNotes, setCaptureNotes] = useState<string[]>([]);

  const images = useMemo(() => media.filter((entry) => entry.kind === 'image'), [media]);
  const videos = useMemo(() => media.filter((entry) => entry.kind === 'video'), [media]);
  const audio = useMemo(() => media.filter((entry) => entry.kind === 'audio'), [media]);

  const update = (patch: Partial<KitDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const capture = () => {
    if (!captureFrom) return;
    const id = initial?.id ?? mintKitId(draft.name || 'from-clip', takenIds);
    const result = captureKitFromClip({
      items: captureFrom.items,
      canvas: captureFrom.canvas,
      id,
      name: draft.name || 'From this clip',
      ...(captionStyle ? { style: captionStyle } : {}),
    });
    /*
      The capture replaces every field it knows about and leaves the rest of the draft alone:
      a user who has already typed a name keeps it, and one who has chosen a watermark does not
      lose it to a capture that has nothing to say about watermarks.
    */
    const captured = draftFromKit(result.kit);
    setDraft((current) => ({
      ...captured,
      name: current.name || captured.name,
      watermark: current.watermark,
      outro: current.outro,
      audio: current.audio,
    }));
    setCaptureNotes(result.notes);
    setProblems([]);
  };

  const save = () => {
    const result = draftToKit({ ...draft, id: initial?.id ?? mintKitId(draft.name || 'kit', takenIds) });
    if (!result.ok || !result.kit) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    onSave(result.kit);
  };

  const addCustom = () => {
    if (draft.colors.custom.length >= BRAND_KIT_MAX_CUSTOM_COLOURS) return;
    update({
      colors: {
        ...draft.colors,
        custom: [
          ...draft.colors.custom,
          { name: `Colour ${draft.colors.custom.length + 1}`, value: DEFAULT_KIT_COLOURS.primary },
        ],
      },
    });
  };

  return (
    <Dialog
      open={open}
      title={initial ? `Edit “${initial.name}”` : 'New brand kit'}
      onClose={onCancel}
      maxWidth={640}
      footer={
        <>
          <Button size={28} variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size={28} variant="primary" onClick={save}>
            Save kit
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxHeight: '60vh', overflow: 'auto' }}>
        {captureFrom && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Button size={28} variant="secondary" onClick={capture}>
              From this clip
            </Button>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
              Takes the caption look, colours and a corner logo from the clip you are editing.
            </span>
          </div>
        )}

        {captureNotes.length > 0 && (
          <div
            role="status"
            style={{
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-hover)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 'var(--fs-sm)',
            }}
          >
            {captureNotes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </div>
        )}

        <Field label="Name" error={problemFor(problems, 'name')}>
          <Input
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="Studio, Client A, Shorts…"
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--space-1)' }}>
          {(['primary', 'secondary', 'accent', 'background', 'text'] as const).map((key) => (
            <Field key={key} label={key} error={problemFor(problems, `colors.${key}`)}>
              <ColourPicker
                value={draft.colors[key]}
                onChange={(hex) => update({ colors: { ...draft.colors, [key]: hex } })}
                ariaLabel={`${key} colour`}
              />
            </Field>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Button
            size={28}
            variant="ghost"
            onClick={addCustom}
            disabled={draft.colors.custom.length >= BRAND_KIT_MAX_CUSTOM_COLOURS}
          >
            Add colour
          </Button>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            {draft.colors.custom.length} of {BRAND_KIT_MAX_CUSTOM_COLOURS}
          </span>
        </div>
        {draft.colors.custom.map((entry, index) => (
          <div key={index} style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
            <Input
              value={entry.name}
              aria-label={`Extra colour ${index + 1} name`}
              onChange={(event) => {
                const custom = draft.colors.custom.map((item, at) =>
                  at === index ? { ...item, name: event.target.value } : item,
                );
                update({ colors: { ...draft.colors, custom } });
              }}
            />
            <ColourPicker
              value={entry.value}
              ariaLabel={`Extra colour ${index + 1}`}
              onChange={(hex) => {
                const custom = draft.colors.custom.map((item, at) =>
                  at === index ? { ...item, value: hex } : item,
                );
                update({ colors: { ...draft.colors, custom } });
              }}
            />
            <Button
              size={28}
              variant="ghost"
              onClick={() =>
                update({
                  colors: { ...draft.colors, custom: draft.colors.custom.filter((_item, at) => at !== index) },
                })
              }
              aria-label={`Remove extra colour ${index + 1}`}
            >
              Remove
            </Button>
          </div>
        ))}
        {problemFor(problems, 'colors.custom') && (
          <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>
            {problemFor(problems, 'colors.custom')}
          </span>
        )}

        <Field label="Caption style id">
          <Input
            value={draft.captionStyleId}
            onChange={(event) => update({ captionStyleId: event.target.value })}
            placeholder="bold-creator"
          />
        </Field>

        {(
          [
            ['logo', 'Logo'],
            ['watermark', 'Watermark'],
          ] as const
        ).map(([key, label]) => {
          const placement = draft[key];
          return (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <Toggle
                checked={placement.enabled}
                onChange={(checked) => update({ [key]: { ...placement, enabled: checked } } as Partial<KitDraft>)}
                label={label}
              />
              {placement.enabled && (
                <>
                  <Field label={`${label} image`} error={problemFor(problems, key)}>
                    <Select
                      value={placement.assetId}
                      onChange={(value) => update({ [key]: { ...placement, assetId: value } } as Partial<KitDraft>)}
                      options={images.map((entry) => ({ value: entry.id, label: entry.label }))}
                      placeholder="Choose an image"
                      ariaLabel={`${label} image`}
                    />
                  </Field>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-1)' }}>
                    <Field label="Corner">
                      <Select
                        value={placement.position}
                        onChange={(value) =>
                          update({ [key]: { ...placement, position: value as typeof placement.position } } as Partial<KitDraft>)
                        }
                        options={POSITIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
                        ariaLabel={`${label} corner`}
                      />
                    </Field>
                    <Field label="Size %">
                      <Input
                        type="number"
                        value={String(placement.sizePct)}
                        aria-label={`${label} size`}
                        onChange={(event) =>
                          update({ [key]: { ...placement, sizePct: Number(event.target.value) } } as Partial<KitDraft>)
                        }
                      />
                    </Field>
                    <Field label="Margin %">
                      <Input
                        type="number"
                        value={String(placement.margin)}
                        aria-label={`${label} margin`}
                        onChange={(event) =>
                          update({ [key]: { ...placement, margin: Number(event.target.value) } } as Partial<KitDraft>)
                        }
                      />
                    </Field>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {(
          [
            ['intro', 'Intro'],
            ['outro', 'Outro'],
          ] as const
        ).map(([key, label]) => {
          const clip = draft[key];
          return (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <Toggle
                checked={clip.enabled}
                onChange={(checked) => update({ [key]: { ...clip, enabled: checked } } as Partial<KitDraft>)}
                label={label}
              />
              {clip.enabled && (
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-1)' }}>
                  <Field label={`${label} clip`} error={problemFor(problems, key)}>
                    <Select
                      value={clip.assetId}
                      onChange={(value) => update({ [key]: { ...clip, assetId: value } } as Partial<KitDraft>)}
                      options={videos.map((entry) => ({ value: entry.id, label: entry.label }))}
                      placeholder="Choose a clip"
                      ariaLabel={`${label} clip`}
                    />
                  </Field>
                  <Field label="Seconds">
                    <Input
                      type="number"
                      value={String(clip.durationSec)}
                      aria-label={`${label} seconds`}
                      onChange={(event) =>
                        update({ [key]: { ...clip, durationSec: Number(event.target.value) } } as Partial<KitDraft>)
                      }
                    />
                  </Field>
                </div>
              )}
            </div>
          );
        })}

        <Field label="Music">
          <Select
            value={draft.audio.musicAssetId}
            onChange={(value) => update({ audio: { ...draft.audio, musicAssetId: value } })}
            options={audio.map((entry) => ({ value: entry.id, label: entry.label }))}
            placeholder="No music"
            ariaLabel="Music"
          />
        </Field>

        <Field label="Safe areas">
          <Select
            value={draft.safeAreaPreset}
            onChange={(value) =>
              update({ safeAreaPreset: value as KitDraft['safeAreaPreset'] })
            }
            options={SAFE_AREAS.map((entry) => ({ value: entry.value, label: entry.label }))}
            ariaLabel="Safe area preset"
          />
        </Field>
      </div>
    </Dialog>
  );
}
