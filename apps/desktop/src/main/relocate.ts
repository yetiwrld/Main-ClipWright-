/**
 * SPEC 04 §4.1, §8 — finding a referenced file after its drive moved.
 *
 * A **referenced** import records an absolute path and, per `04 §4.1`, "volume serial /
 * drive label" alongside it. That is the whole point of `volumeId`, and until now it was a
 * schema field no code wrote or read: a project whose footage lived on an external drive
 * opened with every clip missing whenever that drive came back at a different letter, a
 * different mount point, or on a different machine. Nothing was lost — the file just could
 * not be named.
 *
 * The rule this file implements is narrow on purpose:
 *
 * - a path is offered only when it sits on the **volume the media was imported from**, at
 *   the same relative path;
 * - the candidate must match the recorded **size**, and the fingerprint when one is
 *   available, because a file of the right name at the right relative path on the *wrong*
 *   drive is exactly the mistake a wrong-letter guess produces;
 * - and nothing here touches the disk. This is pure algebra over paths and records so the
 *   decision can be tested against the cases that actually break: a drive that came back as
 *   `E:` instead of `D:`, a POSIX mount that moved from `/Volumes/A` to `/Volumes/A 1`, a
 *   managed copy that needs no finding at all, and a *reference* whose volume is absent.
 */

export interface RelocationRequest {
  /** The path the record holds, as imported. */
  recordedPath: string;
  /** The mount point the media was imported from, e.g. `D:\` or `/Volumes/Footage`. */
  recordedRoot: string;
  /** Where that same volume is mounted now, e.g. `E:\` or `/Volumes/Footage 1`. */
  currentRoot: string;
}

/**
 * The same relative path, on the volume as it is mounted today.
 *
 * Returns `null` when the recorded path is not inside the recorded root — which happens for
 * a record written before root-separated imports existed, or one whose root was guessed.
 * Returning the path unchanged would be worse: the caller would probe a location known to
 * be unrelated and report "missing" as though it had checked.
 *
 * Windows drive letters are compared case-insensitively, because `d:\` and `D:\` are the
 * same volume and a user typing a root by hand will not match the shell's casing. POSIX
 * roots are compared as-is, where case is meaningful.
 */
export function relocatePath(request: RelocationRequest): string | null {
  const { recordedPath, recordedRoot, currentRoot } = request;
  if (!recordedPath || !recordedRoot || !currentRoot) return null;
  const relative = relativeWithin(recordedPath, recordedRoot);
  if (relative === null) return null;

  /*
    The separator comes from the **destination root**, because that is the path being built,
    and the relative part — which `relativeWithin` always returns in POSIX form — is split
    and re-joined with it. Both halves of the result then agree, which is the only property
    that matters: a `D:\\a\\b` segment pasted onto `/mnt/x` gives `/mnt/x\\a\\b`, and nothing
    can open that.

    For every input this pass actually sees the choice is moot — a record and the volume it
    is being re-rooted onto are the same platform, so both separators are the same — which is
    why the alternative (taking it from the recorded path) is not a bug worth guarding. This
    one is written down because "the destination decides" is the rule that generalises: a
    record synced from another machine should follow the machine it is being opened on.
  */
  const separator = currentRoot.includes('\\') ? '\\' : '/';
  const base = currentRoot.replace(/[\\/]+$/, '');
  const joined = relative.split('/').filter(Boolean).join(separator);
  return joined ? `${base}${separator}${joined}` : base;
}

/**
 * The path of `target` relative to `root`, or `null` when it is not underneath it.
 *
 * Written out rather than using `path.relative`, because the two cases that matter here are
 * the ones `path.relative` on the *host* platform gets wrong: a Windows path examined on
 * POSIX (both separators must be understood) and a POSIX root that is a prefix of the
 * target but not a path prefix — `/media` must not match `/media2/clip.mp4`. `path.relative`
 * would also happily return `..` chains, which is the opposite of what a containment test
 * wants.
 */
export function relativeWithin(target: string, root: string): string | null {
  const normalise = (value: string) => value.replace(/\\/g, '/');
  const targetPath = normalise(target);
  const rootPath = normalise(root).replace(/\/+$/, '');
  if (rootPath === '') return null;
  const caseInsensitive = /^[a-zA-Z]:/.test(rootPath) || /^[a-zA-Z]:/.test(targetPath);
  const compare = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  if (compare(targetPath) === compare(rootPath)) return '';
  /* The trailing separator is what makes `/media` not match `/media2`: without it the
     containment test is a string prefix, and half of a directory name passes it. */
  if (!compare(targetPath).startsWith(`${compare(rootPath)}/`)) return null;
  return targetPath.slice(rootPath.length + 1);
}

/** What the caller knows about the file it found, and what the record says it should be. */
export interface CandidateCheck {
  /** The recorded size in bytes. */
  expectedSize: number;
  /** The recorded fingerprint, when one was computed. */
  expectedFingerprint?: string;
  /** The candidate's size, or `undefined` when it could not be read. */
  actualSize?: number;
  /** The candidate's fingerprint, when the caller computed one. */
  actualFingerprint?: string;
}

export type CandidateVerdict =
  | { ok: true; confidence: 'exact' }
  | { ok: false; reason: 'size' | 'fingerprint' | 'unreadable' };

/**
 * Whether a candidate file is the one the record describes.
 *
 * Size first, because it is free: a mismatch on size is proof and needs no hashing. The
 * fingerprint then distinguishes a genuinely relocated file from a different file of the
 * same length — a coincidence that is rare across a whole library and certain across a
 * folder of camera cards, which is where this runs.
 *
 * An unreadable candidate fails rather than passing on the benefit of the doubt. The caller's
 * next step for a failure is to report "missing" and offer the relink dialog, which is the
 * safe direction; accepting a file it could not read would hand the encoder a path that
 * fails later, at export, where the message is much further from the cause.
 */
export function checkCandidate(check: CandidateCheck): CandidateVerdict {
  if (check.actualSize === undefined || !Number.isFinite(check.actualSize)) {
    return { ok: false, reason: 'unreadable' };
  }
  if (check.actualSize !== check.expectedSize) return { ok: false, reason: 'size' };
  if (check.expectedFingerprint !== undefined && check.expectedFingerprint !== '') {
    if (check.actualFingerprint === undefined) return { ok: false, reason: 'unreadable' };
    if (check.actualFingerprint !== check.expectedFingerprint) {
      return { ok: false, reason: 'fingerprint' };
    }
  }
  return { ok: true, confidence: 'exact' };
}

/** The media a relocation pass should even consider. */
export interface RelocationCandidate {
  id: string;
  storageMode: 'managed' | 'reference';
  status: 'ok' | 'missing' | 'changed';
  path: string;
  volumeId?: string;
  volumeRoot?: string;
}

/**
 * Which records are worth trying to relocate.
 *
 * Managed media is excluded: its bytes are in the library, and a managed record that cannot
 * be read is a different failure — a damaged workspace — whose fix is not "the drive came
 * back". Offering to relocate it would invite the user to point a managed item at an
 * external file, which silently changes its storage mode.
 *
 * `ok` records are excluded too. Probing every media file in a library on every launch is
 * exactly the cost the `status` field exists to avoid, and a file that was readable a moment
 * ago is not what this pass is for.
 */
export function relocationCandidates<T extends RelocationCandidate>(media: readonly T[]): T[] {
  return media.filter(
    (entry) => entry.storageMode === 'reference' && entry.status !== 'ok',
  );
}

/**
 * The record's root, from the explicit field or recovered from the path.
 *
 * Records written before `volumeRoot` was stored still carry an absolute path, and for a
 * Windows path the root is unambiguous. A POSIX path is not: `/Volumes/Footage/…` and
 * `/home/me/…` are both plausible and only the volume id can say which. So this recovers a
 * Windows drive or a `/Volumes/<name>` mount and returns `null` otherwise, which leaves the
 * caller to say "this one needs the relink dialog" rather than guessing a root and probing
 * inside it.
 */
export function recoverRoot(path: string): string | null {
  const drive = /^([a-zA-Z]:[\\/])/.exec(path);
  // Normalised to a Windows separator so the root joins cleanly with `relocatePath`.
  if (drive) return drive[1]!.replace(/\/$/, '\\');
  const volume = /^(\/Volumes\/[^/]+)/.exec(path);
  if (volume) return volume[1]!;
  /*
    `/media/<user>/<label>` on Linux, where the *label* is the volume and the user is not:
    stopping at `/media/<user>` would produce a root that is a directory every removable
    drive is mounted inside, so `relocatePath` would happily match a path on a different
    drive and hand the encoder the wrong file.
  */
  const media = /^(\/media\/[^/]+\/[^/]+)/.exec(path);
  if (media) return media[1]!;
  return null;
}

/**
 * The volume a path lives on, as a stable identifier.
 *
 * The *root* and the *identifier* are deliberately different things. The root is where the
 * volume is mounted, and it is what a relocated path is rebuilt from; the identifier is what
 * stays the same when the root changes, and it is what lets the caller ask "is this the same
 * disk?" without relying on the letter.
 *
 * The two ways to get an identifier are not equivalent, and the difference is worth stating
 * because it decides which failures this recovers:
 *
 * - a **serial** (`fs.statSync(path).dev` on POSIX, a volume serial on Windows) survives a
 *   remount at a new mount point, which is the ordinary external-drive case;
 * - a **label** survives a new machine or a re-lettered drive but not a reformat, and it is
 *   all a Windows drive offers without a native call.
 *
 * So the identifier is a composite: `serial:<n>` when a serial is available, `label:<text>`
 * otherwise. Comparing a serial against a label must never match, which is why the prefix is
 * part of the stored value rather than something the caller strips.
 */
export interface VolumeIdentity {
  /** `serial:<digits>` or `label:<text>`. */
  id: string;
  /** Where the volume is mounted now, in the platform's own form. */
  root: string;
}

/**
 * Build a volume identity from what the platform reports.
 *
 * `dev` is `undefined` on Windows and on a filesystem that does not expose one; `label` is
 * whatever the caller could read (a drive label, a mount name). Neither is required, and a
 * volume with neither yields `null` — the honest answer, because a record holding a guessed
 * identifier would match the wrong disk later, which is worse than not matching.
 */
export function volumeIdentity(input: { dev?: number; label?: string; root: string }): VolumeIdentity | null {
  if (!input.root) return null;
  if (typeof input.dev === 'number' && Number.isFinite(input.dev) && input.dev >= 0) {
    return { id: `serial:${Math.trunc(input.dev)}`, root: input.root };
  }
  const label = input.label?.trim();
  if (label) return { id: `label:${label.toLowerCase()}`, root: input.root };
  return null;
}

/**
 * Whether the volume an item needs is the one now mounted at `root`.
 *
 * A prefix mismatch is deliberate: `serial:1` must not match a label that happens to read
 * `1`, and a label is compared case-insensitively because a FAT/exFAT label's casing is
 * whatever wrote it last.
 */
export function sameVolume(recorded: string | undefined, found: VolumeIdentity | null): boolean {
  if (!recorded || !found) return false;
  if (recorded.startsWith('serial:')) return recorded === found.id;
  if (recorded.startsWith('label:')) return recorded.toLowerCase() === found.id.toLowerCase();
  return false;
}

/** What a relocation pass found for one record. */
export interface RelocationOutcome {
  mediaId: string;
  /** The path it was found at, when it was. */
  path?: string;
  /** Why it could not be relocated, when it could not. */
  reason?: 'no-volume' | 'no-root' | 'not-mounted' | 'not-found' | 'mismatch';
  /** The candidate that failed verification, when one was tried. */
  tried?: string;
}

/** What the caller can tell the pass about the machine it is running on. */
export interface RelocationProbe {
  /** Every volume currently mounted, with the identity and root the platform reports. */
  mounted: readonly VolumeIdentity[];
  /** The size of a file, or `undefined` when it cannot be read. */
  sizeOf(path: string): number | undefined;
  /** The fingerprint of a file, or `undefined` when it cannot be read. */
  fingerprintOf(path: string): string | undefined;
  /** Whether a path exists and is readable at all. */
  exists(path: string): boolean;
}

export interface RelocationRecord {
  id: string;
  path: string;
  sizeBytes: number;
  fingerprint?: string;
  volumeId?: string;
  volumeRoot?: string;
}

/**
 * Try to find a record's file on whichever mounted volume carries its identity.
 *
 * The order is chosen so the common case costs one `stat`: the recorded root is tried
 * first, because a volume that never moved is still where the record says, and then each
 * mounted volume with the matching identity. Only when a candidate has the right *size* is
 * its fingerprint computed, which is the expensive half of the check.
 *
 * Every early exit returns a distinct reason rather than a bare `undefined`, because the
 * caller has to tell "you never told me about this volume" (worth nothing to the user) from
 * "your drive is not plugged in" (the whole answer) from "I found a file and it is not the
 * one" (worth a warning).
 */
export function relocateRecord(
  record: RelocationRecord,
  probe: RelocationProbe,
): RelocationOutcome {
  if (!record.volumeId) return { mediaId: record.id, reason: 'no-volume' };
  const recordedRoot = record.volumeRoot ?? recoverRoot(record.path);
  if (!recordedRoot) return { mediaId: record.id, reason: 'no-root' };

  const sameDisk = probe.mounted.filter((volume) => sameVolume(record.volumeId, volume));
  if (sameDisk.length === 0) return { mediaId: record.id, reason: 'not-mounted' };

  /*
    The recorded root first, then the rest. A volume may be mounted at several places at
    once — a bind mount, a second mount of the same disk — and the recorded one is both the
    most likely to hold the file and the cheapest to check.
  */
  const ordered = [...sameDisk].sort((a, b) => (a.root === recordedRoot ? -1 : b.root === recordedRoot ? 1 : 0));

  let lastFailed: string | undefined;
  for (const volume of ordered) {
    const candidate = relocatePath({
      recordedPath: record.path,
      recordedRoot,
      currentRoot: volume.root,
    });
    if (!candidate || !probe.exists(candidate)) continue;
    const verdict = checkCandidate({
      expectedSize: record.sizeBytes,
      ...(record.fingerprint === undefined ? {} : { expectedFingerprint: record.fingerprint }),
      actualSize: probe.sizeOf(candidate),
      /*
        The fingerprint is computed only *after* the size matches, by asking the probe for
        it lazily. Hashing every candidate on a card full of clips is the difference between
        a relocation that takes a moment and one that takes a minute.
      */
      get actualFingerprint() {
        return record.fingerprint === undefined ? undefined : probe.fingerprintOf(candidate);
      },
    });
    if (verdict.ok) return { mediaId: record.id, path: candidate };
    lastFailed = candidate;
  }

  return lastFailed
    ? { mediaId: record.id, reason: 'mismatch', tried: lastFailed }
    : { mediaId: record.id, reason: 'not-found' };
}
