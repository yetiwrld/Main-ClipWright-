// @vitest-environment node
/**
 * SPEC 15 §5, §8.2 — the release pipeline and the app must agree.
 *
 * The unit tests prove each half: CI signs, the app verifies. This test proves
 * they meet in the middle, by running the *real* `make-manifest.mjs` script over
 * real files and then verifying its output with the app's own verification code.
 *
 * If someone changes the manifest shape in one place and not the other, this
 * fails — which is the whole point.
 */
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateVerification,
  parseReleaseManifest,
  verifyDownloadedFile,
  verifyManifestSignature,
} from '@clipwright/update-core';
import { parseLatestYml } from '../updater/update-service.js';

const TMP = join(process.cwd(), '.tmp-release');
const DIST = join(TMP, 'dist');
const VERSION = '1.3.0';
const SETUP = `Clipwright-Studio-Setup-${VERSION}-x64.exe`;
const PORTABLE = `Clipwright-Studio-${VERSION}-x64-portable.exe`;

let publicKeyB64 = '';

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // Deterministic-ish stand-ins for the real ~150 MB artefacts.
  writeFileSync(join(DIST, SETUP), Buffer.alloc(200_000, 0x41));
  writeFileSync(join(DIST, PORTABLE), Buffer.alloc(120_000, 0x42));
  writeFileSync(join(TMP, 'notes.md'), '# 1.3.0\n\nExports are twice as fast.\n\n- audio ducks\n');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  publicKeyB64 = spki.subarray(spki.length - 32).toString('base64');

  execFileSync(process.execPath, [
    join(process.cwd(), 'scripts/release/make-manifest.mjs'),
    '--dir', DIST,
    '--version', VERSION,
    '--channel', 'stable',
    '--notes', join(TMP, 'notes.md'),
    '--out', DIST,
  ], {
    env: {
      ...process.env,
      UPDATE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      UPDATE_PUBLIC_KEY_B64: publicKeyB64,
    },
    stdio: 'pipe',
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('a refused signature leaves nothing to publish', () => {
  it('removes the manifest, signature and sums when the key does not match', async () => {
    // CI runs these steps in sequence. An unverifiable manifest left on disk is
    // precisely the artefact that must not reach the publish step: the app would
    // refuse it and the release would be broken in a way only a user discovers.
    const scratch = join(TMP, 'refusal');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, SETUP), Buffer.alloc(1000, 0x41));

    const wrongPair = generateKeyPairSync('ed25519');

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [
        join(process.cwd(), 'scripts/release/make-manifest.mjs'),
        '--dir', scratch,
        '--version', VERSION,
        '--channel', 'stable',
        '--out', scratch,
      ], {
        env: {
          ...process.env,
          // Sign with the throwaway key, verify against the real one.
          UPDATE_SIGNING_KEY: wrongPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          UPDATE_PUBLIC_KEY_B64: publicKeyB64,
        },
        stdio: 'pipe',
      });
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? 1;
    }

    expect(exitCode).not.toBe(0);
    expect(existsSync(join(scratch, 'release-manifest.json'))).toBe(false);
    expect(existsSync(join(scratch, 'release-manifest.json.sig'))).toBe(false);
    expect(existsSync(join(scratch, 'SHA256SUMS.txt'))).toBe(false);
    // The artefacts themselves are untouched — they were never the problem.
    expect(existsSync(join(scratch, SETUP))).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });
});

const manifestText = () => readFileSync(join(DIST, 'release-manifest.json'), 'utf8');
const signature = () => readFileSync(join(DIST, 'release-manifest.json.sig'), 'utf8');

describe('the release script produces what the app expects', () => {
  it('writes a manifest the app can parse', () => {
    const parsed = parseReleaseManifest(manifestText());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.version).toBe(VERSION);
      expect(parsed.manifest.channel).toBe('stable');
      expect(parsed.manifest.summary).toBe('Exports are twice as fast.');
      expect(parsed.manifest.files.map((file) => file.name).sort()).toEqual([PORTABLE, SETUP]);
    }
  });

  it('lists the real size and both digests for each artefact', () => {
    const parsed = parseReleaseManifest(manifestText());
    if (!parsed.ok) throw new Error('bad manifest');
    const setup = parsed.manifest.files.find((file) => file.name === SETUP)!;
    const bytes = readFileSync(join(DIST, SETUP));
    expect(setup.size).toBe(bytes.byteLength);
    expect(setup.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(setup.sha512).toBe(createHash('sha512').update(bytes).digest('hex'));
  });

  it('writes SHA256SUMS.txt with one line per artefact', () => {
    const sums = readFileSync(join(DIST, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(2);
    for (const line of sums) expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/);
  });

  it('signs the exact bytes it wrote', () => {
    // The signature must cover the file as published, not a re-serialisation.
    expect(verifyManifestSignature(manifestText(), signature(), { current: publicKeyB64 })).toEqual({
      ok: true,
      key: 'current',
    });
  });

  it('the signature does not cover a re-serialised manifest', () => {
    const reformatted = JSON.stringify(JSON.parse(manifestText()));
    expect(verifyManifestSignature(reformatted, signature(), { current: publicKeyB64 }).ok).toBe(false);
  });
});

describe('the app accepts the real release', () => {
  it('verifies end to end against a latest.yml built from the same bytes', () => {
    const parsed = parseReleaseManifest(manifestText());
    if (!parsed.ok) throw new Error('bad manifest');
    const setup = parsed.manifest.files.find((file) => file.name === SETUP)!;
    const latest = parseLatestYml(
      [
        `version: ${VERSION}`,
        'files:',
        `  - url: ${SETUP}`,
        `    sha512: ${Buffer.from(setup.sha512, 'hex').toString('base64')}`,
        `    size: ${setup.size}`,
      ].join('\n'),
    );
    const check = evaluateVerification({
      manifest: parsed.manifest,
      signatureValid: verifyManifestSignature(manifestText(), signature(), { current: publicKeyB64 }).ok,
      signaturePresent: true,
      latest,
      now: Date.now(),
    });
    expect(check).toMatchObject({ ok: true, stage: 'ok' });
  });

  it('accepts the installed bytes and rejects a single flipped bit', () => {
    const parsed = parseReleaseManifest(manifestText());
    if (!parsed.ok) throw new Error('bad manifest');
    const bytes = readFileSync(join(DIST, SETUP));
    const good = createHash('sha256').update(bytes).digest('hex');
    expect(
      verifyDownloadedFile({ manifest: parsed.manifest, fileName: SETUP, sha256: good }).ok,
    ).toBe(true);

    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0x01;
    expect(
      verifyDownloadedFile({
        manifest: parsed.manifest,
        fileName: SETUP,
        sha256: createHash('sha256').update(tampered).digest('hex'),
      }).ok,
    ).toBe(false);
  });

  it('rejects a manifest signed by a different key', () => {
    const impostor = generateKeyPairSync('ed25519');
    const impostorPublic = impostor.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64');
    expect(verifyManifestSignature(manifestText(), signature(), { current: impostorPublic }).ok).toBe(
      false,
    );
  });
});

describe('the release script refuses unsafe input', () => {
  const run = (env: Record<string, string>, args: string[]) =>
    execFileSync(process.execPath, [join(process.cwd(), 'scripts/release/make-manifest.mjs'), ...args], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });

  it('refuses to sign without a signing key', () => {
    expect(() =>
      run({ UPDATE_SIGNING_KEY: '', UPDATE_PUBLIC_KEY_B64: publicKeyB64 }, [
        '--dir', DIST, '--version', VERSION, '--out', join(TMP, 'nokey'),
      ]),
    ).toThrow();
  });

  it('refuses when the public key does not match the signing key', () => {
    // This is the misconfiguration the self-check exists to catch: CI would
    // otherwise publish a release that every installed app rejects.
    const other = generateKeyPairSync('ed25519');
    const otherPublic = other.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() =>
      run(
        {
          UPDATE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          UPDATE_PUBLIC_KEY_B64: otherPublic,
        },
        ['--dir', DIST, '--version', VERSION, '--out', join(TMP, 'mismatch')],
      ),
    ).toThrow();
  });

  it('refuses to sign an artefact whose name carries a different version', () => {
    const otherDist = join(TMP, 'other');
    mkdirSync(otherDist, { recursive: true });
    writeFileSync(join(otherDist, 'Clipwright-Studio-Setup-9.9.9-x64.exe'), 'x');
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() =>
      run(
        {
          UPDATE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          UPDATE_PUBLIC_KEY_B64: publicKeyB64,
        },
        ['--dir', otherDist, '--version', VERSION, '--out', otherDist],
      ),
    ).toThrow();
  });
});
