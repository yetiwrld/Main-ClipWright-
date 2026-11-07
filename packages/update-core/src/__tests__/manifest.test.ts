// @vitest-environment node
/**
 * SPEC 15 §5 — integrity and authenticity.
 *
 * These tests are the ones that decide whether a tampered or unsigned release
 * can reach a user's machine, so they exercise real Ed25519 keys and real
 * digests rather than stubs.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_MAX_AGE_MS,
  crossCheckLatestYml,
  evaluateVerification,
  filesMatchVersion,
  formatDownloadSize,
  isManifestStale,
  normaliseSha256,
  normaliseSha512,
  parseReleaseManifest,
  summariseReleaseNotes,
  verifyDownloadedFile,
  type LatestYml,
  type ReleaseManifest,
} from '../manifest.js';
import { isValidPublicKey, serialiseManifest, signManifest, verifyManifestSignature } from '../signing.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sha512 = (value: string) => createHash('sha512').update(value).digest('hex');

function makeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: '1.3.0',
    channel: 'stable',
    summary: 'Faster exports.',
    files: [
      {
        name: 'Clipwright-Studio-Setup-1.3.0-x64.exe',
        size: 120_000_000,
        sha256: sha256('installer'),
        sha512: sha512('installer'),
      },
    ],
    generatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

function latestFor(manifest: ReleaseManifest, overrides: Partial<LatestYml> = {}): LatestYml {
  return {
    version: manifest.version,
    files: manifest.files.map((file) => ({
      path: file.name,
      sha512: file.sha512,
      size: file.size,
    })),
    ...overrides,
  };
}

describe('parseReleaseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const result = parseReleaseManifest(serialiseManifest(makeManifest()));
    expect(result.ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    expect(parseReleaseManifest('{not json')).toEqual({ ok: false, problem: 'not-json' });
  });

  it('rejects a manifest whose digest is not lowercase hex', () => {
    const manifest = makeManifest();
    manifest.files[0].sha256 = manifest.files[0].sha256.toUpperCase();
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual({ ok: false, problem: 'bad-shape' });
  });

  it('rejects a short digest, which would compare against a truncated hash', () => {
    const manifest = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    (manifest.files as Array<Record<string, unknown>>)[0].sha512 = 'abc';
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual({ ok: false, problem: 'bad-shape' });
  });

  it('rejects an empty file list: there would be nothing to install', () => {
    const manifest = { ...makeManifest(), files: [] };
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual({ ok: false, problem: 'bad-shape' });
  });
});

describe('crossCheckLatestYml', () => {
  it('passes when the hashes agree', () => {
    const manifest = makeManifest();
    expect(crossCheckLatestYml(manifest, latestFor(manifest)).ok).toBe(true);
  });

  it('fails when a hash disagrees, even by one byte', () => {
    const manifest = makeManifest();
    const latest = latestFor(manifest);
    latest.files[0].sha512 = sha512('tampered');
    const result = crossCheckLatestYml(manifest, latest);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('hash-mismatch');
  });

  it('fails when the version disagrees', () => {
    const manifest = makeManifest();
    const result = crossCheckLatestYml(manifest, latestFor(manifest, { version: '1.2.0' }));
    expect(result.problems).toContain('version-mismatch');
  });

  it('fails when the release does not carry the file the manifest lists', () => {
    const manifest = makeManifest();
    const result = crossCheckLatestYml(manifest, latestFor(manifest, { files: [] }));
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('missing-file');
  });

  it('fails when latest.yml points at a file the signed manifest does not cover', () => {
    // electron-updater would download this happily, so it is the dangerous
    // direction: an unsigned file named by the feed.
    const manifest = makeManifest();
    const latest = latestFor(manifest);
    latest.files.push({ path: 'Evil-Setup-1.3.0-x64.exe', sha512: sha512('evil') });
    expect(crossCheckLatestYml(manifest, latest).problems).toContain('missing-file');
  });

  it('allows the signed manifest to cover more than latest.yml lists', () => {
    // electron-builder's latest.yml names the setup exe; the manifest also covers
    // the portable exe. That is a normal release, not a mismatch.
    const manifest = makeManifest();
    manifest.files.push({
      name: 'Clipwright-Studio-1.3.0-x64-portable.exe',
      size: 80_000_000,
      sha256: sha256('portable'),
      sha512: sha512('portable'),
    });
    expect(crossCheckLatestYml(manifest, latestFor(manifest)).ok).toBe(true);
  });

  it('fails when the setup installer is missing from latest.yml', () => {
    // The app installs the setup exe; if the feed does not name it, the path the
    // app actually uses would be unverified.
    const manifest = makeManifest();
    const latest = latestFor(manifest, { files: [] });
    expect(crossCheckLatestYml(manifest, latest).problems).toContain('missing-file');
  });

  it('fails when the size disagrees', () => {
    const manifest = makeManifest();
    const latest = latestFor(manifest);
    latest.files[0].size = 1;
    expect(crossCheckLatestYml(manifest, latest).problems).toContain('hash-mismatch');
  });

  it('compares base64 latest.yml digests with hex manifest digests', () => {
    // latest.yml from electron-builder is base64; a raw string comparison would
    // report tampering on a perfectly good release.
    const manifest = makeManifest();
    const base64 = Buffer.from(manifest.files[0].sha512, 'hex').toString('base64');
    const latest = latestFor(manifest);
    latest.files[0].sha512 = base64;
    expect(crossCheckLatestYml(manifest, latest).ok).toBe(true);
  });
});

describe('normaliseSha512', () => {
  it('lowercases hex', () => {
    const hex = sha512('x');
    expect(normaliseSha512(hex.toUpperCase())).toBe(hex);
  });

  it('converts base64 to hex', () => {
    const hex = sha512('x');
    expect(normaliseSha512(Buffer.from(hex, 'hex').toString('base64'))).toBe(hex);
  });

  it('returns unrecognised input unchanged so the comparison fails loudly', () => {
    expect(normaliseSha512('nonsense')).toBe('nonsense');
  });
});

describe('staleness and file-name checks', () => {
  it('flags a manifest older than a year', () => {
    const manifest = makeManifest();
    const generated = Date.parse(manifest.generatedAt);
    expect(isManifestStale(manifest, generated + MANIFEST_MAX_AGE_MS - 1000)).toBe(false);
    expect(isManifestStale(manifest, generated + MANIFEST_MAX_AGE_MS + 1000)).toBe(true);
  });

  it('treats an unparseable date as stale rather than fresh', () => {
    expect(isManifestStale(makeManifest({ generatedAt: 'someday' }), Date.now())).toBe(true);
  });

  it('accepts file names that carry the manifest version', () => {
    expect(filesMatchVersion(makeManifest())).toBe(true);
  });

  it('rejects a manifest advertising files of a different version', () => {
    const manifest = makeManifest({
      files: [
        {
          name: 'Clipwright-Studio-Setup-1.2.0-x64.exe',
          size: 1,
          sha256: sha256('a'),
          sha512: sha512('a'),
        },
      ],
    });
    expect(filesMatchVersion(manifest)).toBe(false);
  });
});

describe('Ed25519 signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rawBase64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const text = serialiseManifest(makeManifest());
  const signature = signManifest(text, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

  it('accepts a genuine signature', () => {
    expect(verifyManifestSignature(text, signature, { current: keyPem })).toEqual({
      ok: true,
      key: 'current',
    });
  });

  it('accepts a signature verified with a raw base64 key', () => {
    // CI stores the public key as a bare base64 blob; the app must handle it.
    expect(verifyManifestSignature(text, signature, { current: rawBase64 }).ok).toBe(true);
  });

  it('rejects a tampered manifest, even by one character', () => {
    const tampered = text.replace('1.3.0', '1.3.1');
    expect(verifyManifestSignature(tampered, signature, { current: keyPem }).ok).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyManifestSignature(text, signature, { current: otherPem })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports a missing signature distinctly from a bad one', () => {
    expect(verifyManifestSignature(text, '', { current: keyPem })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('rejects a truncated signature', () => {
    expect(verifyManifestSignature(text, signature.slice(0, 20), { current: keyPem })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('accepts the next key during a rotation window', () => {
    const nextPair = generateKeyPairSync('ed25519');
    const nextPem = nextPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const nextSignature = signManifest(
      text,
      nextPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    // Released with the old key, signed with the new one (§5 rotation).
    expect(verifyManifestSignature(text, nextSignature, { current: keyPem, next: nextPem })).toEqual({
      ok: true,
      key: 'next',
    });
  });

  it('rejects a key that is not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(isValidPublicKey(rsaPem)).toBe(false);
    // And a non-Ed25519 key must not be silently treated as "cannot verify yet".
    expect(verifyManifestSignature(text, signature, { current: rsaPem })).toEqual({
      ok: false,
      reason: 'unknown-key',
    });
  });

  it('recognises a usable public key', () => {
    expect(isValidPublicKey(keyPem)).toBe(true);
    expect(isValidPublicKey(rawBase64)).toBe(true);
    expect(isValidPublicKey('')).toBe(false);
    expect(isValidPublicKey('not-a-key')).toBe(false);
  });
});

describe('evaluateVerification', () => {
  const now = Date.parse('2026-11-02T00:00:00.000Z');
  const manifest = makeManifest({ generatedAt: '2026-11-01T10:00:00.000Z' });
  const latest = latestFor(manifest);

  it('passes a signed, consistent, fresh release', () => {
    const result = evaluateVerification({
      manifest,
      signatureValid: true,
      signaturePresent: true,
      latest,
      now,
    });
    expect(result).toMatchObject({ ok: true, stage: 'ok', stale: false });
  });

  it('refuses when the signature is missing (§5)', () => {
    const result = evaluateVerification({
      manifest,
      signatureValid: false,
      signaturePresent: false,
      latest,
      now,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('signature');
    expect(result.message).toContain("couldn't be verified");
  });

  it('refuses a bad signature before it ever looks at the hashes', () => {
    // The signature must gate the hash comparison, so a forged manifest cannot
    // steer the download.
    const result = evaluateVerification({
      manifest,
      signatureValid: false,
      signaturePresent: true,
      latest,
      now,
    });
    expect(result.stage).toBe('signature');
  });

  it('refuses a signed manifest that disagrees with latest.yml', () => {
    const result = evaluateVerification({
      manifest,
      signatureValid: true,
      signaturePresent: true,
      latest: latestFor(manifest, { version: '9.9.9' }),
      now,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('cross-check');
  });

  it('refuses when there is no latest.yml to cross-check against', () => {
    const result = evaluateVerification({
      manifest,
      signatureValid: true,
      signaturePresent: true,
      latest: null,
      now,
    });
    expect(result.stage).toBe('cross-check');
  });

  it('warns but still verifies a stale manifest', () => {
    const result = evaluateVerification({
      manifest,
      signatureValid: true,
      signaturePresent: true,
      latest,
      now: now + MANIFEST_MAX_AGE_MS + 1,
    });
    expect(result.ok).toBe(true);
    expect(result.stale).toBe(true);
  });
});

describe('verifyDownloadedFile', () => {
  const manifest = makeManifest();
  const fileName = manifest.files[0].name;

  it('accepts a file that matches the signed manifest', () => {
    expect(
      verifyDownloadedFile({
        manifest,
        fileName,
        sha256: manifest.files[0].sha256,
        sizeBytes: manifest.files[0].size,
      }).ok,
    ).toBe(true);
  });

  it('accepts an uppercase digest', () => {
    expect(
      verifyDownloadedFile({ manifest, fileName, sha256: manifest.files[0].sha256.toUpperCase() }).ok,
    ).toBe(true);
  });

  it('rejects a damaged download and says it was removed', () => {
    const result = verifyDownloadedFile({ manifest, fileName, sha256: sha256('corrupt') });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The download was damaged and has been removed.');
  });

  it('rejects a size mismatch', () => {
    expect(
      verifyDownloadedFile({
        manifest,
        fileName,
        sha256: manifest.files[0].sha256,
        sizeBytes: manifest.files[0].size + 1,
      }).ok,
    ).toBe(false);
  });

  it('rejects a file the manifest never listed', () => {
    expect(verifyDownloadedFile({ manifest, fileName: 'other.exe', sha256: sha256('x') })).toMatchObject({
      ok: false,
      problems: ['missing-file'],
    });
  });
});

describe('display helpers', () => {
  it('normalises sha256 to lowercase', () => {
    expect(normaliseSha256('AB'.repeat(32))).toBe('ab'.repeat(32));
  });

  it('formats download sizes the way the dialog shows them', () => {
    expect(formatDownloadSize(512)).toBe('512 B');
    expect(formatDownloadSize(2048)).toBe('2 KB');
    expect(formatDownloadSize(120_000_000)).toBe('114 MB');
    expect(formatDownloadSize(2_147_483_648)).toBe('2.0 GB');
  });

  it('summarises the first real paragraph of the notes', () => {
    const notes = '# What\'s new\n\nExports are twice as fast, and audio now ducks under speech.\n\n- three\n- changes';
    expect(summariseReleaseNotes(notes)).toBe(
      'Exports are twice as fast, and audio now ducks under speech.',
    );
  });

  it('returns an empty summary for notes with no prose', () => {
    expect(summariseReleaseNotes('# Heading only')).toBe('');
    expect(summariseReleaseNotes('')).toBe('');
  });
});
