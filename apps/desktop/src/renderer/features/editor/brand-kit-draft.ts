/**
 * The editable state of a brand kit, and how it becomes a validated one.
 *
 * A form cannot hold a `BrandKit`: the schema requires a logo to have an asset id and a
 * placement to have six numbers, and a user is allowed to be halfway through choosing them.
 * So the form holds a *draft* — every field a string or a number, with the parts that are
 * switched off simply absent — and `draftToKit` turns it into a kit or refuses with the reasons.
 *
 * Keeping this in its own module rather than inside the dialog is what makes the interesting
 * cases testable without a DOM: a kit with no name, a size outside the schema's bounds, a logo
 * whose corner was chosen but whose asset was not, a colour that is not a colour.
 */
import {
  BRAND_KIT_MAX_CUSTOM_COLOURS,
  CwbrandFormat,
  CwbrandFormatVersion,
  DEFAULT_KIT_COLOURS,
  brandKitSchema,
  type BrandKit,
} from '@clipwright/brand-kits';

/** A logo or watermark's fields, as the form holds them. */
export interface PlacementDraft {
  /** Off means the kit has no logo at all — not a logo with an empty asset. */
  enabled: boolean;
  assetId: string;
  position: 'tl' | 'tr' | 'bl' | 'br';
  sizePct: number;
  margin: number;
  opacity: number;
}

export interface KitDraft {
  id: string;
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    custom: Array<{ name: string; value: string }>;
  };
  captionStyleId: string;
  logo: PlacementDraft;
  watermark: PlacementDraft;
  intro: { enabled: boolean; assetId: string; durationSec: number };
  outro: { enabled: boolean; assetId: string; durationSec: number };
  audio: { musicAssetId: string; musicVolumeDb: number; duckUnderSpeech: boolean };
  safeAreaPreset: 'tiktok' | 'reels' | 'shorts' | 'none';
}

/*
  The palette a new kit starts with, taken from the package that also uses it for a capture with
  no style to read — so the two cannot disagree about what "no colours yet" means. These are
  *data*, not design tokens: the renderer's token lint forbids hex in a UI file precisely because
  a brand kit's colours are the user's and come from a file.
*/
const DEFAULT_COLOURS: KitDraft['colors'] = { ...DEFAULT_KIT_COLOURS, custom: [] };

/** A brand-new kit's draft: nothing enabled, because nothing has been chosen yet. */
export function emptyDraft(id: string): KitDraft {
  return {
    id,
    name: '',
    colors: { ...DEFAULT_COLOURS, custom: [] },
    captionStyleId: '',
    logo: { enabled: false, assetId: '', position: 'br', sizePct: 12, margin: 4, opacity: 1 },
    watermark: { enabled: false, assetId: '', position: 'tl', sizePct: 30, margin: 4, opacity: 0.3 },
    intro: { enabled: false, assetId: '', durationSec: 2 },
    outro: { enabled: false, assetId: '', durationSec: 2 },
    audio: { musicAssetId: '', musicVolumeDb: -18, duckUnderSpeech: true },
    safeAreaPreset: 'none',
  };
}

/**
 * A draft seeded from a kit — for *editing*, and for the "capture from this clip" path.
 *
 * The inverse of `draftToKit`, and deliberately total: a kit with no logo becomes a draft whose
 * logo is switched off with its fields at their defaults, so switching it on later starts from
 * something sensible rather than from zeros.
 */
export function draftFromKit(kit: BrandKit): KitDraft {
  const base = emptyDraft(kit.id);
  return {
    ...base,
    name: kit.name,
    colors: {
      primary: kit.colors.primary,
      secondary: kit.colors.secondary,
      accent: kit.colors.accent,
      background: kit.colors.background,
      text: kit.colors.text,
      custom: kit.colors.custom.map((entry) => ({ ...entry })),
    },
    captionStyleId: kit.captionStyleId ?? '',
    logo: kit.logo
      ? {
          enabled: true,
          assetId: kit.logo.assetId,
          position: kit.logo.position === 'custom' ? 'br' : kit.logo.position,
          sizePct: kit.logo.sizePct,
          margin: kit.logo.margin,
          opacity: kit.logo.opacity,
        }
      : base.logo,
    watermark: kit.watermark
      ? {
          enabled: true,
          assetId: kit.watermark.assetId,
          position: kit.watermark.position === 'custom' ? 'tl' : kit.watermark.position,
          sizePct: kit.watermark.sizePct,
          margin: kit.watermark.margin,
          opacity: kit.watermark.opacity,
        }
      : base.watermark,
    intro: kit.intro
      ? { enabled: true, assetId: kit.intro.assetId ?? '', durationSec: kit.intro.durationSec }
      : base.intro,
    outro: kit.outro
      ? { enabled: true, assetId: kit.outro.assetId ?? '', durationSec: kit.outro.durationSec }
      : base.outro,
    audio: kit.audio
      ? {
          musicAssetId: kit.audio.musicAssetId ?? '',
          musicVolumeDb: kit.audio.musicVolumeDb,
          duckUnderSpeech: kit.audio.duckUnderSpeech,
        }
      : base.audio,
    safeAreaPreset: kit.safeAreaPreset,
  };
}

/** What went wrong, in the form's own words, keyed by the field to mark. */
export interface DraftProblem {
  field: string;
  message: string;
}

export interface DraftResult {
  ok: boolean;
  kit?: BrandKit;
  problems: DraftProblem[];
}

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/**
 * Validate a draft and turn it into a kit.
 *
 * Every problem is collected rather than returning at the first: a form that fails one field at
 * a time makes the user press Save, read, fix, press again. The messages are the sentences the
 * user reads, so they name the control they are about.
 */
export function draftToKit(draft: KitDraft): DraftResult {
  const problems: DraftProblem[] = [];

  if (draft.name.trim().length === 0) {
    problems.push({ field: 'name', message: 'A kit needs a name.' });
  }

  const colourFields = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
  for (const key of colourFields) {
    if (!HEX.test(draft.colors[key])) {
      problems.push({ field: `colors.${key}`, message: `The ${key} colour must be a hex value, six digits after a hash.` });
    }
  }
  if (draft.colors.custom.length > BRAND_KIT_MAX_CUSTOM_COLOURS) {
    problems.push({
      field: 'colors.custom',
      message: `A kit can hold at most ${BRAND_KIT_MAX_CUSTOM_COLOURS} extra colours.`,
    });
  }
  for (const entry of draft.colors.custom) {
    if (entry.name.trim().length === 0) {
      problems.push({ field: 'colors.custom', message: 'Every extra colour needs a name.' });
    }
    if (!HEX.test(entry.value)) {
      problems.push({ field: 'colors.custom', message: `“${entry.name}” is not a hex colour.` });
    }
  }

  /*
    A part that is switched on but has nothing chosen is a *problem*, not an omission: the user
    said they wanted a logo, and a kit that quietly omitted it would apply everything except the
    thing they turned on. The message names both halves so the fix is obvious.
  */
  const checkedPlacement = (
    label: string,
    placement: PlacementDraft,
    enabledFor: 'logo' | 'watermark',
  ) => {
    if (!placement.enabled) return undefined;
    if (placement.assetId.trim().length === 0) {
      problems.push({ field: enabledFor, message: `Choose a ${label} image, or switch it off.` });
      return undefined;
    }
    if (placement.sizePct < 1 || placement.sizePct > 100) {
      problems.push({ field: enabledFor, message: `The ${label} size must be between 1% and 100%.` });
    }
    if (placement.margin < 0 || placement.margin > 50) {
      problems.push({ field: enabledFor, message: `The ${label} margin must be between 0% and 50%.` });
    }
    if (placement.opacity < 0 || placement.opacity > 1) {
      problems.push({ field: enabledFor, message: `The ${label} opacity must be between 0 and 1.` });
    }
    return {
      assetId: placement.assetId.trim(),
      position: placement.position,
      xPct: 0,
      yPct: 0,
      sizePct: placement.sizePct,
      opacity: placement.opacity,
      margin: placement.margin,
      showFrom: 'always' as const,
      showFor: 'whole' as const,
    };
  };

  const logo = checkedPlacement('logo', draft.logo, 'logo');
  const watermark = checkedPlacement('watermark', draft.watermark, 'watermark');

  const clipRef = (label: string, value: { enabled: boolean; assetId: string; durationSec: number }, field: string) => {
    if (!value.enabled) return undefined;
    if (value.assetId.trim().length === 0) {
      problems.push({ field, message: `Choose an ${label} clip, or switch it off.` });
      return undefined;
    }
    if (!(value.durationSec >= 0.1 && value.durationSec <= 600)) {
      problems.push({ field, message: `The ${label} length must be between 0.1 and 600 seconds.` });
      return undefined;
    }
    return { assetId: value.assetId.trim(), durationSec: value.durationSec };
  };

  const intro = clipRef('intro', draft.intro, 'intro');
  const outro = clipRef('outro', draft.outro, 'outro');

  if (problems.length > 0) return { ok: false, problems };

  const candidate = {
    format: CwbrandFormat,
    formatVersion: CwbrandFormatVersion,
    id: draft.id,
    name: draft.name.trim(),
    colors: draft.colors,
    fonts: {},
    safeAreaPreset: draft.safeAreaPreset,
    ...(draft.captionStyleId ? { captionStyleId: draft.captionStyleId } : {}),
    ...(logo ? { logo } : {}),
    ...(watermark ? { watermark } : {}),
    ...(intro ? { intro } : {}),
    ...(outro ? { outro } : {}),
    ...(draft.audio.musicAssetId
      ? {
          audio: {
            musicAssetId: draft.audio.musicAssetId,
            musicVolumeDb: draft.audio.musicVolumeDb,
            duckUnderSpeech: draft.audio.duckUnderSpeech,
          },
        }
      : {}),
  };

  /*
    The schema is the last word, not the first: the checks above produce the messages a user can
    act on, and this catches anything they missed — a name over 120 characters, a volume outside
    the schema's range. Failing here means a bug in the checks rather than in the user's input,
    which is why the message is deliberately plain.
  */
  const parsed = brandKitSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  return { ok: true, kit: parsed.data as BrandKit, problems: [] };
}

/** A kit id that is not already taken, derived from the name so it is readable in a file. */
export function mintKitId(name: string, taken: ReadonlySet<string>, fallback = 'kit'): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || fallback;
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable in practice; the caller's `taken` set would need a thousand collisions.
  return `${slug}-${Date.now()}`;
}
