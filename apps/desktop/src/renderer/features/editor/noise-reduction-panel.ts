/**
 * What the inspector's noise-reduction row says and does (SPEC 12 §6.8).
 *
 * The spec asks for four things of this surface: **Reduce noise** as a background job, an **A/B
 * toggle** between the original and the cleaned copy, a **plain warning** that the result can
 * affect voice quality, and a **Revert** that goes back to the original. Revert is not a restore:
 * the original was never written to, so clearing the item's field *is* the revert.
 *
 * The decisions live here, apart from the JSX, for the reason this project keeps rediscovering —
 * a control can be present, look right, and do nothing, and the only way to know is to assert what
 * it sends.
 */

/** The three strengths, in the order the control offers them. */
export const STRENGTH_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export type Strength = (typeof STRENGTH_OPTIONS)[number]['value'];

/** The item fields this row reads. Kept structural so a test needs no whole `TimelineItem`. */
export interface NoiseReductionFields {
  noiseReduction?: {
    strength: string;
    path: string;
    method?: string;
    createdAt?: string;
  };
  /** Whether the item has any audio at all — a silent clip has nothing to clean. */
  hasAudio?: boolean;
}

export interface NoiseReductionRow {
  /** Whether the row is shown at all. */
  visible: boolean;
  /** Whether a cleaned copy exists for this item. */
  applied: boolean;
  /** The strength to show as selected. */
  strength: Strength;
  /** The line under the controls: what state the item is in, in plain words. */
  status: string;
  /**
   * Whether an A/B toggle can be offered.
   *
   * Only when there is something to compare *with*. A toggle with no cleaned copy would be a
   * control that does nothing — the pattern SPEC 13 tells this project to omit rather than disable.
   */
  canCompare: boolean;
  /** The warning the spec requires, always shown while a copy is applied. */
  warning: string | null;
}

/** The spec's own sentence, kept verbatim so a reword is deliberate (SPEC 12 §6.8). */
export const NOISE_WARNING =
  'Noise reduction can affect voice quality; compare before using.';

export function describeNoiseReductionRow(item: NoiseReductionFields): NoiseReductionRow {
  const applied = Boolean(item.noiseReduction?.path);
  const strength: Strength =
    item.noiseReduction?.strength === 'low' || item.noiseReduction?.strength === 'high'
      ? item.noiseReduction.strength
      : 'medium';

  /*
    A clip with no audio stream gets no row at all, rather than a row whose every control refuses.
    The spec's §28 already says mute controls are disabled with a tooltip on a clip with no audio;
    for noise reduction the honest equivalent is that there is nothing here to reduce, so the
    section does not appear.
  */
  if (item.hasAudio === false) {
    return {
      visible: false,
      applied: false,
      strength,
      status: '',
      canCompare: false,
      warning: null,
    };
  }

  if (!applied) {
    return {
      visible: true,
      applied: false,
      strength,
      status: 'The original audio is used. Reducing noise makes a separate copy; the original stays as it is.',
      canCompare: false,
      warning: null,
    };
  }

  const method = item.noiseReduction?.method === 'arnndn' ? 'RNNoise' : 'spectral denoising';
  return {
    visible: true,
    applied: true,
    strength,
    status: `The cleaned copy is used (${method}, ${strength} strength). Revert goes back to the original, which is unchanged.`,
    canCompare: true,
    warning: NOISE_WARNING,
  };
}

/**
 * Which file the preview plays while the user is comparing.
 *
 * The toggle is **view state, never document state**: it decides which file is auditioned and
 * writes nothing to the project. The alternative — flipping the item's own field so the preview
 * follows — would make an audition an edit: it would appear in the undo stack and mark the project
 * dirty every time the user compared two files.
 *
 * The module answers *which of the two is selected*, not where either lives: resolving a media id
 * to a path is the main process's job, and a helper here that pretended otherwise would have to
 * return a made-up path or a null the caller cannot use.
 */
export type ComparisonSide = 'original' | 'cleaned';

/** The side the toggle shows as active, defaulting to the cleaned copy when one is applied. */
export function comparisonSide(item: NoiseReductionFields, chosen: ComparisonSide | null): ComparisonSide {
  /*
    Once a copy is applied the cleaned one is what the project plays, so that is what the toggle
    starts on — an A/B switch that opens on "A" while the export uses "B" is a switch that misleads
    about which one the user is judging.
  */
  if (chosen) return chosen;
  return item.noiseReduction?.path ? 'cleaned' : 'original';
}

/**
 * What pressing *Reduce noise* should send.
 *
 * `undefined` means the press should do nothing, and says why through `reason` — the two cases are
 * a job already running (pressing again would queue a second encode of the same thing) and a
 * strength the control does not recognise (which cannot happen from the UI, but can from a stored
 * project, and silently choosing another strength is how a setting becomes a lie).
 */
export function planReduceNoise(input: {
  strength: string;
  running: boolean;
}): { strength: Strength } | { reason: string } {
  if (input.running) {
    return { reason: 'Noise reduction is already running for this clip.' };
  }
  const match = STRENGTH_OPTIONS.find((option) => option.value === input.strength);
  if (!match) {
    return { reason: 'Choose a strength first.' };
  }
  return { strength: match.value };
}

/**
 * Whether the panel should offer *Revert*.
 *
 * Present only when there is something to revert to the original *from* — the same rule the
 * eyedropper follows: a control that cannot do anything is not drawn.
 */
export function canRevert(item: NoiseReductionFields): boolean {
  return Boolean(item.noiseReduction?.path);
}
