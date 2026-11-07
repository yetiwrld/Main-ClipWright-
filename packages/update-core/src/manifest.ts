/**
 * SPEC 15 §5 — the signed release manifest.
 *
 * The manifest is what CI publishes alongside the installer. `latest.yml` (which
 * `electron-updater` reads and whose sha512 it enforces) is *not* signed by
 * us, so the manifest is the layer that proves the release came from this
 * project. Two independent facts must agree before anything is offered:
 *
 *   1. the manifest's Ed25519 signature verifies against an embedded public key;
 *   2. every hash in the manifest equals the hash in `latest.yml`.
 *
 * If either fails we refuse — §5: "This update couldn't be verified, so it was
 * not installed."
 *
 * Pure: the caller passes the crypto in (see `verifyManifestSignature`), and
 * nothing here reads the clock implicitly.
 */
import { z } from 'zod';

export const ReleaseFileSchema = z.object({
  /** File name exactly as it appears in the GitHub release. */
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Lowercase hex, 64 characters (§5 layer 2). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  /** Lowercase hex, 128 characters (what electron-updater checks). */
  sha512: z.string().regex(/^[0-9a-f]{128}$/, 'sha512 must be 128 lowercase hex characters'),
});
export type ReleaseFile = z.infer<typeof ReleaseFileSchema>;

export const ReleaseManifestSchema = z.object({
  version: z.string().min(1),
  channel: z.enum(['stable', 'beta']).default('stable'),
  /** First paragraph of the release notes, shown in the dialog before download. */
  summary: z.string().default(''),
  files: z.array(ReleaseFileSchema).min(1),
  /** ISO-8601 UTC. Exposed as a string so the manifest is byte-stable. */
  generatedAt: z.string().min(1),
  /** §5 downgrade protection: versions below this are refused outright. */
  minimumSupportedVersion: z.string().optional(),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** The parts of `latest.yml` we cross-check. */
export interface LatestYmlFile {
  /** e.g. `Clipwright-Studio-Setup-1.3.0-x64.exe` */
  path: string;
  sha512: string;
  size?: number;
}

export interface LatestYml {
  version: string;
  files: LatestYmlFile[];
  /** asset name for the blockmap, if present */
  path?: string;
}

/** The shape electron-updater's provider gives us, narrowed to what we check. */
export const LatestYmlSchema = z.object({
  version: z.string().min(1),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        sha512: z.string().min(1),
        size: z.number().optional(),
      }),
    )
    .min(1),
  path: z.string().optional(),
});

export type ManifestProblem =
  | 'not-json'
  | 'bad-shape'
  | 'version-mismatch'
  | 'hash-mismatch'
  | 'missing-file'
  | 'stale'
  | 'signature-missing'
  | 'signature-invalid'
  | 'unknown-key';

export interface ManifestCheck {
  ok: boolean;
  problems: ManifestProblem[];
  /** Plain-language explanation, safe to show a user (§4.1 "never a stack trace"). */
  message: string;
}

/** §5: manifests older than a year are stale; warn rather than refuse. */
export const MANIFEST_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parse the manifest bytes. Kept separate from verification so the caller can
 * report "the update information couldn't be verified" without leaking a zod
 * error path to the user.
 */
export function parseReleaseManifest(
  text: string,
): { ok: true; manifest: ReleaseManifest } | { ok: false; problem: ManifestProblem } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not-json' };
  }
  const parsed = ReleaseManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problem: 'bad-shape' };
  return { ok: true, manifest: parsed.data };
}

/**
 * §5: the file hashes in the signed manifest must equal those in `latest.yml`;
 * any disagreement aborts.
 */
export function crossCheckLatestYml(manifest: ReleaseManifest, latest: LatestYml): ManifestCheck {
  const problems: ManifestProblem[] = [];

  if (manifest.version !== latest.version) problems.push('version-mismatch');

  // The dangerous direction is: `latest.yml` points at a file the signed
  // manifest does not cover. electron-updater would happily download it, so
  // every file it names must appear in the signed manifest with matching hashes.
  for (const published of latest.files) {
    const expected = manifest.files.find((file) => file.name === published.path);
    if (!expected) {
      problems.push('missing-file');
      continue;
    }
    // electron-updater reports sha512 base64 in latest.yml; compare on the raw
    // digest so a base64/hex difference is not mistaken for tampering.
    if (normaliseSha512(published.sha512) !== expected.sha512) problems.push('hash-mismatch');
    if (published.size !== undefined && published.size !== expected.size) problems.push('hash-mismatch');
  }

  // And the installer the app itself offers must be one of them: a manifest that
  // lists only the portable exe would leave the setup path unverifiable.
  const installer = manifest.files.find((file) => /-Setup-.*-x64\.exe$/i.test(file.name));
  if (installer && !latest.files.some((file) => file.path === installer.name)) {
    problems.push('missing-file');
  }

  if (problems.length === 0) {
    return { ok: true, problems: [], message: 'The release details are consistent.' };
  }
  return {
    ok: false,
    problems: [...new Set(problems)],
    message: "The update information couldn't be verified.",
  };
}

/**
 * Decode a sha512 that may be base64 (latest.yml) or hex, to lowercase hex.
 * Returns the input unchanged when it is neither, so the comparison fails
 * loudly rather than accidentally matching.
 */
export function normaliseSha512(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{128}$/i.test(trimmed)) return trimmed.toLowerCase();
  const base64 = /^[A-Za-z0-9+/]{86}==$/.test(trimmed);
  if (base64) {
    try {
      return Buffer.from(trimmed, 'base64').toString('hex');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** §5: staleness is a warning, not a refusal. */
export function isManifestStale(manifest: ReleaseManifest, now: number): boolean {
  const generated = Date.parse(manifest.generatedAt);
  if (Number.isNaN(generated)) return true;
  return now - generated > MANIFEST_MAX_AGE_MS;
}

/**
 * §5: refuse a manifest whose version disagrees with the file names it lists.
 * A `1.3.0` manifest advertising `...-1.2.0-...exe` is either a build mistake or
 * an attack; neither should reach a download.
 */
export function filesMatchVersion(manifest: ReleaseManifest): boolean {
  const version = manifest.version.replace(/^v/, '');
  return manifest.files.every((file) => file.name.includes(version));
}

/**
 * Full verification result, as shown in the update dialog (§4.2 "Verifying…").
 */
export interface VerifyUpdateResult {
  ok: boolean;
  /** The layer that failed, for the log — never shown verbatim to the user. */
  stage: 'manifest' | 'signature' | 'cross-check' | 'download' | 'ok';
  message: string;
  /** Stale manifests still verify; the UI shows an advisory. */
  stale: boolean;
}

/**
 * Turn the individual checks into one verdict.
 *
 * Order matters: the signature is checked before any hash comparison, so a
 * forged manifest cannot steer the download (§5).
 */
export function evaluateVerification(options: {
  manifest: ReleaseManifest | null;
  signatureValid: boolean;
  signaturePresent: boolean;
  latest: LatestYml | null;
  now: number;
}): VerifyUpdateResult {
  const { manifest, signatureValid, signaturePresent, latest, now } = options;

  if (!manifest) {
    return {
      ok: false,
      stage: 'manifest',
      message: "The update information couldn't be verified.",
      stale: false,
    };
  }

  if (!signaturePresent) {
    return {
      ok: false,
      stage: 'signature',
      message: "This update couldn't be verified, so it was not installed.",
      stale: false,
    };
  }

  if (!signatureValid) {
    return {
      ok: false,
      stage: 'signature',
      message: "This update couldn't be verified, so it was not installed.",
      stale: false,
    };
  }

  if (!latest) {
    return {
      ok: false,
      stage: 'cross-check',
      message: "The update information couldn't be verified.",
      stale: false,
    };
  }

  const crossCheck = crossCheckLatestYml(manifest, latest);
  if (!crossCheck.ok) {
    return { ok: false, stage: 'cross-check', message: crossCheck.message, stale: false };
  }

  if (!filesMatchVersion(manifest)) {
    return {
      ok: false,
      stage: 'cross-check',
      message: "The update information couldn't be verified.",
      stale: false,
    };
  }

  return {
    ok: true,
    stage: 'ok',
    message: 'Verified.',
    stale: isManifestStale(manifest, now),
  };
}

/**
 * §5 layer 1: compare a downloaded file's digest with the signed manifest.
 * A mismatch means the file is deleted and the user is told plainly.
 */
export function verifyDownloadedFile(options: {
  manifest: ReleaseManifest;
  fileName: string;
  sha256: string;
  sizeBytes?: number;
}): ManifestCheck {
  const expected = options.manifest.files.find((file) => file.name === options.fileName);
  if (!expected) {
    return {
      ok: false,
      problems: ['missing-file'],
      message: "The update information couldn't be verified.",
    };
  }
  if (normaliseSha256(options.sha256) !== expected.sha256) {
    return {
      ok: false,
      problems: ['hash-mismatch'],
      message: 'The download was damaged and has been removed.',
    };
  }
  if (options.sizeBytes !== undefined && options.sizeBytes !== expected.size) {
    return {
      ok: false,
      problems: ['hash-mismatch'],
      message: 'The download was damaged and has been removed.',
    };
  }
  return { ok: true, problems: [], message: 'Verified.' };
}

export function normaliseSha256(value: string): string {
  return value.trim().toLowerCase();
}

/** §4.2: "Download size" in the dialog, e.g. `142 MB`. */
export function formatDownloadSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * §4.2 "short summary": the first paragraph of the release notes, so the dialog
 * can lead with something readable and still expand to the full notes.
 */
export function summariseReleaseNotes(notes: string): string {
  const paragraph = notes
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith('#'));
  if (!paragraph) return '';
  return paragraph.replace(/\s+/g, ' ').slice(0, 400);
}
