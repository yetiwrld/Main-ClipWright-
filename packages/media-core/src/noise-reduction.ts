/**
 * Noise reduction (SPEC 12 §6.8).
 *
 * > **Reduce noise** runs as a background job that renders a **derived, denoised copy** of the
 * > item's source range (`Media/<id>/enhanced/<hash>.wav`) using the best available bundled
 * > method: **RNNoise via ffmpeg `arnndn`** (with a licence-checked bundled model) when available,
 * > otherwise ffmpeg `afftdn` with a conservative profile; strength Low/Medium/High; A/B toggle in
 * > the inspector; **never destructive** (the item points to the derived file; *Revert* restores
 * > the original).
 *
 * ## What this build can actually do
 *
 * The bundled ffmpeg is 4.1 (2018) and has **no `arnndn` filter** — it was added in 2020 — so the
 * RNNoise path is not available and the spec's "otherwise" branch is the only one that runs here.
 * That is not a silent downgrade: `planNoiseReduction` takes what the build supports as an argument
 * and reports which method it chose, and the UI says which one was used. A future ffmpeg with
 * `arnndn` needs no change here beyond the capability probe returning it.
 *
 * A noise-reduction model file also carries a licence, and shipping one without checking it is the
 * kind of problem that cannot be fixed by a patch. The `arnndn` path therefore also requires a
 * model path to be supplied; without one it declines rather than guessing at a default.
 *
 * ## Never destructive
 *
 * The output is a **new file**, content-addressed on everything that affects it. Nothing here
 * writes to the source, and nothing here decides that the item should use the result — that is the
 * item's `noiseReduction` field, which the user sets and can clear. Reverting is therefore not a
 * restore: the original has never been touched.
 *
 * ## Why the plan is a separate function from the run
 *
 * The interesting parts — which method, which strength, which arguments, when to refuse — are
 * decisions, and decisions can be tested in Node without spawning a process or shipping a fixture
 * with real noise in it. The process call next door is then small enough to see in one screen.
 */

/** How hard to work on the noise. The spec's three strengths (SPEC 12 §6.8). */
export const NOISE_REDUCTION_STRENGTHS = ['low', 'medium', 'high'] as const;
export type NoiseReductionStrength = (typeof NOISE_REDUCTION_STRENGTHS)[number];

/** Which denoiser a plan will use. `none` means the plan was refused; see `refusal`. */
export type NoiseReductionMethod = 'arnndn' | 'afftdn';

/**
 * What the running build's ffmpeg can do.
 *
 * Probed once from `-filters` rather than assumed, because the answer differs between the bundled
 * binary, a system ffmpeg and a future upgrade — and a build that assumed `arnndn` would fail at
 * run time with "No such filter", which reads to a user as the feature being broken.
 */
export interface NoiseReductionCapabilities {
  /** `afftdn`, present in every ffmpeg this project could plausibly bundle. */
  afftdn: boolean;
  /** `arnndn`, present from ffmpeg 4.3. */
  arnndn: boolean;
}

/**
 * The fft denoiser's settings, per strength.
 *
 * `nr` is the amount of noise reduction in dB; `nf` is the noise floor it assumes. Both matter, and
 * they trade off differently: raising `nr` thins the noise but starts eating breath and room tone,
 * and raising `nf` tells the filter the noise *is louder than it is*, which is what makes it
 * aggressive on quiet material.
 *
 * The spec's word for the default profile is **conservative**, so Medium sits well below the
 * filter's own default of 12 dB rather than at it. A denoiser that is too strong is the failure
 * mode you cannot undo by taste — it removes the thing you were trying to keep — while one that is
 * too gentle is simply run again at a higher strength.
 */
export const AFFTDN_PROFILES: ReadonlyArray<{
  strength: NoiseReductionStrength;
  nr: number;
  nf: number;
  /** What to expect, for the UI to say plainly. */
  description: string;
}> = [
  {
    strength: 'low',
    nr: 6,
    nf: -55,
    description: 'Removes steady hiss and fan noise, leaving room tone.',
  },
  {
    strength: 'medium',
    nr: 12,
    nf: -50,
    description: 'The usual choice for speech recorded in a quiet room.',
  },
  {
    strength: 'high',
    nr: 24,
    nf: -42,
    description: 'For heavy noise. Can thin breath and room tone — compare before using.',
  },
];

export interface NoiseReductionPlan {
  method: NoiseReductionMethod;
  /** The ffmpeg audio filters to chain, in order. Empty when the plan was refused. */
  filters: string[];
  /** Why no plan was produced. Only set when the plan is a refusal. */
  refusal?: 'no-denoiser' | 'no-model' | 'unknown-strength' | 'no-audio';
  /** The strength the plan was built for, after validation. */
  strength: NoiseReductionStrength;
  /** What the chosen method is, in one sentence, for the panel to show. */
  description: string;
}

/** The strength's profile, or `undefined` for a value that is not one of the three. */
export function profileFor(strength: string): (typeof AFFTDN_PROFILES)[number] | undefined {
  return AFFTDN_PROFILES.find((profile) => profile.strength === strength);
}

/**
 * ffmpeg's `arnndn` filter arguments.
 *
 * The model is a parameter rather than a constant because it is a **licence decision** and not an
 * engineering one: RNNoise's models are shipped under their own terms, and this build refuses to
 * embed one it has not checked (the same rule `docs/limitations.md` records for the checksums).
 */
export function arnndnFilter(modelPath: string): string {
  /*
    The path is escaped for the filtergraph. A Windows path is `C:\Users\...`, and in a filter
    argument the colon separates a filter's name from its parameter — so an unescaped drive letter
    silently turns `m=C` into the model and `\Users` into another option. Escaping the colon and
    the backslash is what makes a path with both survive.
  */
  const escaped = modelPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return `arnndn=m='${escaped}'`;
}

/**
 * ffmpeg's `afftdn` filter arguments for a strength.
 *
 * `tn` (track noise) is on: without it the filter assumes the noise floor it is given is right for
 * the whole file, and a take that starts with a fan and settles into quiet gets the quiet part
 * over-filtered. Tracking adapts the estimate as it goes, which is the behaviour a user expects
 * from "reduce the noise" on a recording that is not uniform.
 */
export function afftdnFilter(strength: NoiseReductionStrength): string {
  const profile = profileFor(strength) ?? profileFor('medium')!;
  return `afftdn=nr=${profile.nr}:nf=${profile.nf}:tn=1`;
}

export interface NoiseReductionRequest {
  strength: string;
  /** What the build's ffmpeg can do, from a `-filters` probe. */
  capabilities: NoiseReductionCapabilities;
  /** The RNNoise model, when the build has one. Absent means the `arnndn` path is unavailable. */
  modelPath?: string | null;
  /** Whether the item has an audio stream at all. A silent clip has nothing to denoise. */
  hasAudio?: boolean;
}

/**
 * Decide *how* to denoise, or refuse with a reason.
 *
 * The order of the checks is the order of the user's questions: is there anything to denoise, is
 * the strength one of the three, is any denoiser available, and — only then — which one.
 */
export function planNoiseReduction(request: NoiseReductionRequest): NoiseReductionPlan {
  const fallbackStrength: NoiseReductionStrength =
    typeof request.strength === 'string' && profileFor(request.strength)
      ? (request.strength as NoiseReductionStrength)
      : 'medium';

  if (request.hasAudio === false) {
    return {
      method: 'afftdn',
      filters: [],
      refusal: 'no-audio',
      strength: fallbackStrength,
      description: 'This clip has no audio to clean up.',
    };
  }

  /*
    An unknown strength is refused rather than clamped. A stored value from a newer version or a
    hand-edited project says something this build does not understand, and quietly running at Medium
    would produce a file the user did not ask for. The three strengths are a closed set the UI
    offers, so an unlisted one is a bug rather than a preference.
  */
  if (!request.strength || !profileFor(request.strength)) {
    return {
      method: 'afftdn',
      filters: [],
      refusal: 'unknown-strength',
      strength: fallbackStrength,
      description: 'That noise-reduction strength is not one this version understands.',
    };
  }

  const strength = request.strength as NoiseReductionStrength;

  if (request.capabilities.arnndn) {
    if (!request.modelPath) {
      /*
        RNNoise without a model file is the spec's licensing trap: the filter builds, runs, and
        either fails at start-up or — worse, in some builds — passes audio through untouched, which
        reads as "the denoiser did nothing". Declining by name is the honest answer.
      */
      return {
        method: 'afftdn',
        filters: [afftdnFilter(strength)],
        strength,
        description: `Voice-focused noise reduction at ${strength} strength (no RNNoise model is installed).`,
      };
    }
    return {
      method: 'arnndn',
      filters: [arnndnFilter(request.modelPath)],
      strength,
      description: `RNNoise voice denoising at ${strength} strength.`,
    };
  }

  if (!request.capabilities.afftdn) {
    return {
      method: 'afftdn',
      filters: [],
      refusal: 'no-denoiser',
      strength,
      description: 'This build of ffmpeg has no denoising filter available.',
    };
  }

  return {
    method: 'afftdn',
    filters: [afftdnFilter(strength)],
    strength,
    description: `${profileFor(strength)!.description}`,
  };
}

/**
 * The key a denoised copy is cached under.
 *
 * Content-addressed on everything that changes the output: the source's identity, the range, and
 * the exact filter chain. Two consequences worth having — running the same strength twice is a read
 * rather than another encode, and changing the strength does not reuse a file that was made with
 * the other one (which would be a setting that appears to do nothing).
 */
export function noiseReductionKey(input: {
  mediaId: string;
  inUs: number;
  durationUs: number;
  filters: readonly string[];
  sampleRate: number;
}): string {
  /*
    A stable string, not JSON: the key is hashed, and object key order is the kind of thing that
    changes without anyone noticing, which would silently invalidate every cache entry on a refactor.
  */
  return [
    input.mediaId,
    Math.max(0, Math.round(input.inUs)),
    Math.max(0, Math.round(input.durationUs)),
    input.sampleRate,
    ...input.filters,
  ].join('|');
}

/**
 * The ffmpeg arguments that produce a denoised WAV.
 *
 * Written out rather than built inline at the call site so the parts that matter can be asserted:
 * the sample rate (48 kHz, matching the preview and the mixer), the output format (PCM WAV, so the
 * result is lossless and can be denoised again), and that the source is the *last* argument before
 * the output — an ordering that a naive string join gets wrong once and then forever after.
 */
export function noiseReductionArgs(input: {
  sourcePath: string;
  outputPath: string;
  inUs: number;
  durationUs: number;
  filters: readonly string[];
  sampleRate: number;
}): string[] {
  const args: string[] = [];
  /*
    Seeking before the input (`-ss` on the *left* of `-i`) is the fast path: ffmpeg seeks by
    demuxing rather than decoding everything before the range. It is also slightly less precise on
    some containers, which is why the duration is given on the right of `-i` as an output option —
    the two together cut the range without decoding the whole file.
  */
  if (input.inUs > 0) args.push('-ss', (input.inUs / 1_000_000).toFixed(6));
  args.push('-i', input.sourcePath);
  if (input.durationUs > 0) args.push('-t', (input.durationUs / 1_000_000).toFixed(6));
  args.push(
    '-vn',
    '-af',
    input.filters.join(','),
    '-ar',
    String(input.sampleRate),
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    '-hide_banner',
    '-nostdin',
    '-y',
    input.outputPath,
  );
  return args;
}

/**
 * What to say about a denoised result, given the levels before and after.
 *
 * Needed because a denoiser's output is not self-evidently better: it can remove the noise floor
 * and the presence from a voice in the same pass. Telling the user the measured change is the only
 * way they can tell "it worked" from "it thinned my audio", and the spec's own warning —
 * "can affect voice quality; compare before using" — is a sentence the UI has to be able to earn.
 */
export function describeNoiseReduction(change: {
  beforeDb: number;
  afterDb: number;
  method: NoiseReductionMethod;
}): string {
  const delta = Number.isFinite(change.beforeDb) && Number.isFinite(change.afterDb)
    ? change.afterDb - change.beforeDb
    : Number.NaN;
  const method = change.method === 'arnndn' ? 'RNNoise' : 'spectral denoising';
  /*
    The measured change is the level of the *result*, which a denoiser lowers by removing noise —
    so a large drop is not automatically a win, and the sentence must not imply it is. The wording
    stays descriptive: what happened, not whether to keep it.
  */
  if (!Number.isFinite(delta)) {
    return `Cleaned with ${method}. Compare it with the original before you rely on it.`;
  }
  const rounded = Math.round(delta);
  const sign = rounded === 0 ? 'no change' : rounded > 0 ? `+${rounded} dB` : `${rounded} dB`;
  return `Cleaned with ${method}; the result measures ${sign} against the original. Compare before you rely on it.`;
}
