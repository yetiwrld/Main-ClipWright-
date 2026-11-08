#!/usr/bin/env node
/**
 * SPEC 15 §8.2 step 5 — produce `release-manifest.json`, `SHA256SUMS.txt` and the
 * detached Ed25519 signature, then verify the signature with the embedded public
 * key before the workflow is allowed to publish.
 *
 * Usage (in release.yml, with the signing key in the environment):
 *
 *   node scripts/release/make-manifest.mjs \
 *     --dir dist --version 1.3.0 --channel stable \
 *     --notes CHANGELOG-section.md \
 *     --out dist
 *
 * The self-check at the end is deliberate: CI verifying its own signature with
 * the *public* key catches a misconfigured secret before users see it.
 */
import { createHash, sign, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const dir = resolve(args.dir ?? 'dist');
const outDir = resolve(args.out ?? dir);
const version = args.version;
const channel = args.channel ?? 'stable';
const minimumSupportedVersion = args['minimum-supported-version'];

if (!version) fail('--version is required');
if (!['stable', 'beta'].includes(channel)) fail(`--channel must be stable or beta, got ${channel}`);

const privateKey = process.env.UPDATE_SIGNING_KEY;
if (!privateKey) {
  fail(
    'UPDATE_SIGNING_KEY is not set. Generate one with scripts/release/gen-update-key.mjs and store it as a repository secret.',
  );
}
const publicKey = process.env.UPDATE_PUBLIC_KEY_B64;
if (!publicKey) {
  fail(
    'UPDATE_PUBLIC_KEY_B64 is not set. This must be the key embedded in the app, so the self-check proves the released build can actually verify this manifest.',
  );
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`--version must be semver, got ${version}`);
}

/** Artefacts we ship; blockmaps and yml files are not installers. */
const ARTEFACT_PATTERN = /\.(exe|msi|zip|dmg|AppImage)$/i;

const entries = await readdir(dir);
const artefacts = entries.filter((name) => ARTEFACT_PATTERN.test(name)).sort();
if (artefacts.length === 0) fail(`No installable artefacts found in ${dir}`);

const files = [];
for (const name of artefacts) {
  const path = join(dir, name);
  const info = await stat(path);
  // §5: refuse to sign artefacts whose name does not carry this version. A
  // manifest that points at another version's installer is either a build
  // mistake or tampering, and it must never reach a user.
  if (!name.includes(version)) {
    fail(`${name} does not contain the version ${version}; refusing to sign it.`);
  }
  const { sha256, sha512 } = await hashFile(path);
  files.push({ name, size: info.size, sha256, sha512 });
  console.log(`  ${name}  ${info.size} bytes  sha256 ${sha256.slice(0, 16)}…`);
}

const summary = args.notes ? summarise(await readFile(resolve(args.notes), 'utf8')) : '';

const manifest = {
  version,
  channel,
  summary,
  files,
  generatedAt: new Date().toISOString(),
  ...(minimumSupportedVersion ? { minimumSupportedVersion } : {}),
};

// §5: the signature covers the exact published bytes, so CI must sign what it
// writes — hence one serialisation, written once, then read back for hashing.
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestPath = join(outDir, 'release-manifest.json');
await writeFile(manifestPath, manifestText);

const signature = sign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64');
const sigPath = join(outDir, 'release-manifest.json.sig');
await writeFile(sigPath, `${signature}\n`);

const sums = files.map((file) => `${file.sha256}  ${file.name}`).join('\n');
await writeFile(join(outDir, 'SHA256SUMS.txt'), `${sums}\n`);

// ---- Self-check: can the app (which has only the public key) verify this?
const verifier = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]),
  format: 'der',
  type: 'spki',
});
const ok = verify(null, Buffer.from(manifestText, 'utf8'), verifier, Buffer.from(signature, 'base64'));
if (!ok) {
  // Remove what was just written before failing. The script's whole contract is
  // "refuse to publish", and leaving the exact files it just refused to vouch
  // for sitting in the output directory contradicts that.
  //
  // Today the release workflow aborts when this step fails, so the files would
  // not be uploaded. That is one `if: always()` or one local re-run away from
  // being false, and the files are indistinguishable from good ones: same names,
  // valid JSON, a signature that only the app's key would reject.
  await rm(manifestPath, { force: true });
  await rm(sigPath, { force: true });
  await rm(join(outDir, 'SHA256SUMS.txt'), { force: true });
  fail(
    'The manifest signature does not verify with UPDATE_PUBLIC_KEY_B64. The secret and the embedded key are out of sync — refusing to publish.',
  );
}

console.log('');
console.log(`Signed ${basename(manifestPath)} for ${version} (${channel})`);
console.log(`  ${files.length} artefact(s), self-check passed with the embedded public key`);
console.log(`  ${manifestPath}`);
console.log(`  ${sigPath}`);

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

async function hashFile(path) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => {
        sha256.update(chunk);
        sha512.update(chunk);
      })
      .on('end', resolvePromise)
      .on('error', reject);
  });
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
}

/** First real paragraph of the changelog section, as the dialog shows it. */
function summarise(text) {
  const paragraph = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith('#') && !block.startsWith('-'));
  return (paragraph ?? '').replace(/\s+/g, ' ').slice(0, 400);
}

function fail(message) {
  console.error(`\nrelease-manifest: ${message}\n`);
  process.exit(1);
}
