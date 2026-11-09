import { describe, expect, it } from 'vitest';
import {
  checkCandidate,
  type RelocationProbe,
  type RelocationRecord,
  recoverRoot,
  relocationCandidates,
  relocatePath,
  relocateRecord,
  relativeWithin,
  sameVolume,
  volumeIdentity,
} from '../relocate.js';

/**
 * SPEC 04 §4.1, §8 — the relocation half of `volumeId`.
 *
 * The failure this exists for is ordinary: a project references footage on an external
 * drive; the drive comes back as `E:` instead of `D:`, or mounts at `/Volumes/Footage 1`
 * because a stale copy is still mounted at `/Volumes/Footage`. Every clip is missing, and
 * nothing is actually lost. The tests below are those cases, plus the ones where the right
 * answer is *not* to guess.
 */

describe('re-rooting a path onto a moved volume (SPEC 04 §4.1)', () => {
  it('follows a Windows drive letter that changed', () => {
    // Recorded at import on D:, back today as E:. The relative path is unchanged.
    expect(
      relocatePath({
        recordedPath: 'D:\\Footage\\Shoot 2\\clip 01.mp4',
        recordedRoot: 'D:\\',
        currentRoot: 'E:\\',
      }),
    ).toBe('E:\\Footage\\Shoot 2\\clip 01.mp4');
  });

  it('follows a POSIX mount that came back with a numeric suffix', () => {
    /*
      macOS appends ` 1` to a mount point whose name is already taken — the common case
      when the old volume did not unmount cleanly. This is a *real* different root, not a
      different name, and the file underneath it is the same file.
    */
    expect(
      relocatePath({
        recordedPath: '/Volumes/Footage/Shoot/clip.mp4',
        recordedRoot: '/Volumes/Footage',
        currentRoot: '/Volumes/Footage 1',
      }),
    ).toBe('/Volumes/Footage 1/Shoot/clip.mp4');
  });

  it('keeps the relative path exactly, including spaces and nested folders', () => {
    // A path that lost a segment, or one where spaces were collapsed, points at nothing.
    expect(
      relocatePath({
        recordedPath: 'D:\\My Shoot\\Day 1\\A B C\\take 2.MOV',
        recordedRoot: 'D:\\',
        currentRoot: 'F:\\',
      }),
    ).toBe('F:\\My Shoot\\Day 1\\A B C\\take 2.MOV');
  });

  it('does not invent a path when the file was not inside the recorded root', () => {
    /*
      A record with no usable root — hand-edited, or written before roots were stored —
      must yield nothing. Returning the path unchanged would let the caller probe a place
      it knows is unrelated and then report "missing" as though it had checked.
    */
    expect(
      relocatePath({
        recordedPath: 'C:\\elsewhere\\clip.mp4',
        recordedRoot: 'D:\\',
        currentRoot: 'E:\\',
      }),
    ).toBeNull();
  });

  it('treats a drive letter as case-insensitive', () => {
    // `d:\` and `D:\` are one volume, and nobody types it the way the shell reports it.
    expect(
      relocatePath({
        recordedPath: 'd:\\Footage\\clip.mp4',
        recordedRoot: 'D:\\',
        currentRoot: 'E:\\',
      }),
    ).toBe('E:\\Footage\\clip.mp4');
  });

  it('does not treat a sibling directory as the root', () => {
    /*
      The containment bug that a string `startsWith` produces: `/media` is a prefix of
      `/media2`, and `/media2/render.mp4` is not inside `/media`.
    */
    expect(relativeWithin('/media2/render.mp4', '/media')).toBeNull();
    expect(relativeWithin('/media/render.mp4', '/media')).toBe('render.mp4');
  });

  it('answers the root itself with an empty relative path rather than failing', () => {
    // Not a file anyone imports, but the containment test should be total.
    expect(relativeWithin('/Volumes/A', '/Volumes/A')).toBe('');
  });

  it('refuses empty input rather than composing a path out of nothing', () => {
    expect(relocatePath({ recordedPath: '', recordedRoot: 'D:\\', currentRoot: 'E:\\' })).toBeNull();
    expect(relocatePath({ recordedPath: 'D:\\a.mp4', recordedRoot: '', currentRoot: 'E:\\' })).toBeNull();
    expect(relocatePath({ recordedPath: 'D:\\a.mp4', recordedRoot: 'D:\\', currentRoot: '' })).toBeNull();
  });

  it('does not double the separator when the current root ends with one', () => {
    // Both `E:` and `E:\` are typed by humans; `E:\\Footage` would be a different path.
    expect(
      relocatePath({ recordedPath: 'D:\\a.mp4', recordedRoot: 'D:\\', currentRoot: 'E:\\' }),
    ).toBe('E:\\a.mp4');
    expect(
      relocatePath({ recordedPath: '/v/a.mp4', recordedRoot: '/v', currentRoot: '/w/' }),
    ).toBe('/w/a.mp4');
  });
});

describe('deciding a candidate is the right file (SPEC 04 §4.1, §8)', () => {
  it('accepts a file of the recorded size and fingerprint', () => {
    expect(
      checkCandidate({ expectedSize: 100, expectedFingerprint: 'abc', actualSize: 100, actualFingerprint: 'abc' }),
    ).toEqual({ ok: true, confidence: 'exact' });
  });

  it('rejects a file of the wrong size without needing a fingerprint', () => {
    /*
      Size is free and a mismatch is proof. Hashing every wrong candidate would make a
      folder scan of a camera card take minutes for an answer already known.
    */
    expect(checkCandidate({ expectedSize: 100, actualSize: 101 })).toEqual({
      ok: false,
      reason: 'size',
    });
  });

  it('rejects a same-size file whose fingerprint differs', () => {
    /*
      The case that matters on a card full of clips: several files are the same length and
      only the fingerprint tells them apart. Accepting on size alone would hand the encoder
      the wrong take, and the user would only notice at export.
    */
    expect(
      checkCandidate({ expectedSize: 100, expectedFingerprint: 'abc', actualSize: 100, actualFingerprint: 'def' }),
    ).toEqual({ ok: false, reason: 'fingerprint' });
  });

  it('accepts on size alone when no fingerprint was ever computed', () => {
    // Fingerprinting can fail on an unreadable sector; a record without one still relocates
    // rather than becoming permanently unrecoverable.
    expect(checkCandidate({ expectedSize: 100, actualSize: 100 })).toEqual({
      ok: true,
      confidence: 'exact',
    });
  });

  it('fails an unreadable candidate rather than accepting it optimistically', () => {
    /*
      Accepting a file whose size could not be read hands the failure to the exporter,
      where the message is much further from the cause.
    */
    expect(checkCandidate({ expectedSize: 100, actualSize: undefined })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('requires a fingerprint when the record has one', () => {
    // Expected fingerprint present but the candidate was not hashed: not proven.
    expect(
      checkCandidate({ expectedSize: 100, expectedFingerprint: 'abc', actualSize: 100 }),
    ).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('choosing what to relocate (SPEC 04 §8)', () => {
  const base = { id: 'm', path: '/x', storageMode: 'reference' as const, status: 'missing' as const };

  it('offers a missing reference', () => {
    expect(relocationCandidates([base])).toHaveLength(1);
  });

  it('never offers managed media', () => {
    /*
      A managed copy's bytes are in the library; if it cannot be read the workspace is
      damaged, and pointing it at an external file would silently turn a managed asset into
      a reference.
    */
    expect(relocationCandidates([{ ...base, storageMode: 'managed' }])).toHaveLength(0);
  });

  it('does not probe media that is already fine', () => {
    // The `status` field exists so a launch does not stat every clip in the library.
    expect(relocationCandidates([{ ...base, status: 'ok' }])).toHaveLength(0);
  });

  it('offers a changed reference too', () => {
    // A file edited in place still needs finding, and `changed` is the record saying so.
    expect(relocationCandidates([{ ...base, status: 'changed' }])).toHaveLength(1);
  });

  it('keeps the order it was given', () => {
    // The caller reports per record, and a shuffled list makes the log unreadable.
    const many = ['a', 'b', 'c'].map((id) => ({ ...base, id }));
    expect(relocationCandidates(many).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('recovering a root from a path (SPEC 04 §4.1)', () => {
  it('recovers a Windows drive', () => {
    expect(recoverRoot('D:\\Footage\\clip.mp4')).toBe('D:\\');
  });

  it('recovers a /Volumes mount', () => {
    expect(recoverRoot('/Volumes/Footage/Shoot/clip.mp4')).toBe('/Volumes/Footage');
  });

  it('recovers a /media mount', () => {
    // The Linux convention, and what an external drive usually looks like there.
    expect(recoverRoot('/media/me/Footage/clip.mp4')).toBe('/media/me/Footage');
  });

  it('returns null rather than guessing a root it cannot know', () => {
    /*
      A plain POSIX path has no unambiguous root: only the volume id can say whether
      `/home/me/x.mp4` is on the same disk. Guessing `/` and then probing inside it would be
      a directory scan disguised as a relocation.
    */
    expect(recoverRoot('/home/me/clip.mp4')).toBeNull();
    expect(recoverRoot('clip.mp4')).toBeNull();
  });

  it('round-trips through relocatePath', () => {
    // The two functions are used together; a root that relocatePath does not accept would
    // be a relocation that silently never matches.
    const root = recoverRoot('/Volumes/Footage/Shoot/clip.mp4')!;
    expect(relocatePath({ recordedPath: '/Volumes/Footage/Shoot/clip.mp4', recordedRoot: root, currentRoot: '/Volumes/Footage 1' })).toBe(
      '/Volumes/Footage 1/Shoot/clip.mp4',
    );
  });
});

describe('identifying a volume (SPEC 04 §4.1)', () => {
  it('prefers a serial, because it survives a remount at a new mount point', () => {
    // The ordinary external-drive case: same disk, new letter. A label would work here
    // too, but a serial also survives two drives with the same label.
    expect(volumeIdentity({ dev: 66305, root: '/Volumes/A' })).toEqual({
      id: 'serial:66305',
      root: '/Volumes/A',
    });
  });

  it('falls back to the label when there is no serial', () => {
    // Windows reports no dev through `stat`; the drive label is what it offers.
    expect(volumeIdentity({ label: 'Footage', root: 'D:\\' })).toEqual({
      id: 'label:footage',
      root: 'D:\\',
    });
  });

  it('gives no identity rather than guessing one', () => {
    /*
      A record holding a guessed identifier would match the *wrong* disk later, which is
      worse than not matching: the user would be told their file was found and be handed
      someone else's clip.
    */
    expect(volumeIdentity({ root: 'D:\\' })).toBeNull();
    expect(volumeIdentity({ dev: 1, label: 'x', root: '' })).toBeNull();
  });

  it('refuses a negative or non-finite dev as an identity', () => {
    /*
      A filesystem that reports a sentinel instead of a serial would otherwise stamp every
      record on it with the same identifier — and every one of those records would then be
      "found" on whichever volume happened to answer first.
    */
    expect(volumeIdentity({ dev: -1, root: '/x' })).toBeNull();
    expect(volumeIdentity({ dev: Number.NaN, root: '/x' })).toBeNull();
  });

  it('never matches a serial against a label that spells the same number', () => {
    // The prefixes exist for this: `serial:1` and `label:1` name different disks.
    expect(sameVolume('serial:1', { id: 'label:1', root: '/x' })).toBe(false);
    expect(sameVolume('serial:1', { id: 'serial:1', root: '/x' })).toBe(true);
  });

  it('compares labels case-insensitively, because a label is case-insensitive by nature', () => {
    expect(sameVolume('label:Footage', { id: 'label:footage', root: 'E:\\' })).toBe(true);
  });

  it('does not match an absent identity', () => {
    // The caller's default must be "not the same volume", so a missing record never causes
    // a relocation onto a drive that happens to be mounted.
    expect(sameVolume(undefined, { id: 'serial:1', root: '/x' })).toBe(false);
    expect(sameVolume('serial:1', null)).toBe(false);
  });
});

describe('running a relocation pass over records (SPEC 04 §8)', () => {
  const volume = (id: string, root: string) => ({ id, root });
  const record = (over: Partial<RelocationRecord> = {}): RelocationRecord => ({
    id: 'm1',
    path: 'D:\\Footage\\clip.mp4',
    sizeBytes: 100,
    fingerprint: 'abc',
    volumeId: 'serial:7',
    volumeRoot: 'D:\\',
    ...over,
  });

  /** A probe that answers from a table of path → {size, fingerprint}. */
  const probeFor = (
    files: Record<string, { size: number; fingerprint: string }>,
    mounted: Array<{ id: string; root: string }>,
  ): RelocationProbe => ({
    mounted,
    exists: (path) => path in files,
    sizeOf: (path) => files[path]?.size,
    fingerprintOf: (path) => files[path]?.fingerprint,
  });

  it('finds the file on the volume at its new root', () => {
    // The whole point: same disk, new letter, file still there.
    const outcome = relocateRecord(
      record(),
      probeFor({ 'E:\\Footage\\clip.mp4': { size: 100, fingerprint: 'abc' } }, [volume('serial:7', 'E:\\')]),
    );
    expect(outcome).toEqual({ mediaId: 'm1', path: 'E:\\Footage\\clip.mp4' });
  });

  it('says the drive is not plugged in rather than "not found"', () => {
    /*
      The distinction the user acts on. "Not found" sends them looking through folders;
      "not mounted" tells them to plug the drive in.
    */
    const outcome = relocateRecord(record(), probeFor({}, [volume('serial:9', 'E:\\')]));
    expect(outcome).toEqual({ mediaId: 'm1', reason: 'not-mounted' });
  });

  it('does not look on a volume with a different identity', () => {
    // The wrong disk mounted at the recorded letter is the mistake this guards against.
    const outcome = relocateRecord(
      record(),
      probeFor({ 'D:\\Footage\\clip.mp4': { size: 100, fingerprint: 'abc' } }, [volume('serial:99', 'D:\\')]),
    );
    expect(outcome.reason).toBe('not-mounted');
  });

  it('reports a file it found and rejected, with the path it tried', () => {
    /*
      A same-name, same-relative-path file of the wrong size is worth telling the user
      about: it means the right drive is mounted and the file has been replaced.
    */
    const outcome = relocateRecord(
      record(),
      probeFor({ 'E:\\Footage\\clip.mp4': { size: 999, fingerprint: 'zzz' } }, [volume('serial:7', 'E:\\')]),
    );
    expect(outcome.reason).toBe('mismatch');
    expect(outcome.tried).toBe('E:\\Footage\\clip.mp4');
  });

  it('reports not-found when the volume is mounted but the file is not on it', () => {
    const outcome = relocateRecord(record(), probeFor({}, [volume('serial:7', 'E:\\')]));
    expect(outcome.reason).toBe('not-found');
  });

  it('does nothing for a record with no volume identity', () => {
    // Written before this pass existed; the relink dialog is its answer.
    expect(relocateRecord(record({ volumeId: undefined }), probeFor({}, [volume('serial:7', 'E:\\')]))).toEqual({
      mediaId: 'm1',
      reason: 'no-volume',
    });
  });

  it('recovers a root from the path when the record has none', () => {
    // Records written before `volumeRoot` existed still carry a Windows path.
    const outcome = relocateRecord(
      record({ volumeRoot: undefined }),
      probeFor({ 'F:\\Footage\\clip.mp4': { size: 100, fingerprint: 'abc' } }, [volume('serial:7', 'F:\\')]),
    );
    expect(outcome.path).toBe('F:\\Footage\\clip.mp4');
  });

  it('tries the recorded root first when the volume is mounted twice', () => {
    /*
      A bind mount makes the same disk reachable at two paths. The recorded one is both the
      more likely and the cheaper, so a probe that finds it there must not go looking.
    */
    const files = { 'D:\\Footage\\clip.mp4': { size: 100, fingerprint: 'abc' } };
    const outcome = relocateRecord(record(), probeFor(files, [volume('serial:7', 'Z:\\'), volume('serial:7', 'D:\\')]));
    expect(outcome.path).toBe('D:\\Footage\\clip.mp4');
  });

  it('does not hash a candidate whose size is already wrong', () => {
    /*
      The cost this guards: a camera card holds hundreds of same-named files, and hashing
      each one before rejecting it turns a relink into a minute of disk noise.
    */
    let hashed = 0;
    const probe: RelocationProbe = {
      mounted: [volume('serial:7', 'E:\\')],
      exists: () => true,
      sizeOf: () => 999,
      fingerprintOf: () => {
        hashed += 1;
        return 'zzz';
      },
    };
    relocateRecord(record(), probe);
    expect(hashed).toBe(0);
  });
});
